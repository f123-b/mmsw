//! Independent Windows WASAPI capture channels.
//!
//! cpal's WASAPI backend opens a render endpoint as an input stream with
//! `AUDCLNT_STREAMFLAGS_LOOPBACK`; this is the real WASAPI loopback path. The
//! endpoint setup is isolated per worker so a Windows device API call that
//! stalls cannot block the other channel or the sidecar supervisor.

use crate::mixer::{new_shared_buffer, SharedAudioBuffer};
use crate::protocol::{emit, timestamp, CaptureStats, Event, TARGET_SAMPLE_RATE};
use cpal::traits::DeviceTrait;
use cpal::{Device, Sample, SampleFormat, Stream, StreamConfig};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(2);

pub struct CaptureHandle {
    pub mic_stream: Option<Stream>,
    pub system_stream: Option<Stream>,
    pub mic_buffer: SharedAudioBuffer,
    pub system_buffer: SharedAudioBuffer,
    pub mic_stats: Arc<Mutex<CaptureStats>>,
    pub system_stats: Arc<Mutex<CaptureStats>>,
    pub mic_rate: u32,
    pub system_rate: u32,
    pub mic_channels: u16,
    pub system_channels: u16,
}

struct OpenedStream {
    stream: Stream,
    sample_rate: u32,
    channels: u16,
}

pub fn open(input: Option<&Device>, output: Option<&Device>) -> Result<CaptureHandle, String> {
    let mic_buffer = new_shared_buffer(TARGET_SAMPLE_RATE, 1);
    let system_buffer = new_shared_buffer(TARGET_SAMPLE_RATE, 1);
    let mic_stats = Arc::new(Mutex::new(CaptureStats::new(TARGET_SAMPLE_RATE, 1)));
    let system_stats = Arc::new(Mutex::new(CaptureStats::new(TARGET_SAMPLE_RATE, 2)));

    let (sender, receiver) = mpsc::channel::<(&'static str, Result<OpenedStream, String>)>();
    let mut pending = 0_u8;
    if let Some(device) = input.cloned() {
        pending += 1;
        let sender = sender.clone();
        let queue = Arc::clone(&mic_buffer);
        let stats = Arc::clone(&mic_stats);
        thread::spawn(move || { let _ = sender.send(("mic", open_input_channel(device, queue, stats))); });
    }
    if let Some(device) = output.cloned() {
        pending += 1;
        let sender = sender.clone();
        let queue = Arc::clone(&system_buffer);
        let stats = Arc::clone(&system_stats);
        thread::spawn(move || { let _ = sender.send(("system", open_loopback_channel(device, queue, stats))); });
    }
    drop(sender);

    let deadline = std::time::Instant::now() + CHANNEL_OPEN_TIMEOUT;
    let mut mic_result = None;
    let mut system_result = None;
    while pending > 0 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() { break; }
        match receiver.recv_timeout(remaining) {
            Ok(("mic", result)) => { mic_result = Some(result); pending -= 1; }
            Ok(("system", result)) => { system_result = Some(result); pending -= 1; }
            Err(_) => break,
            Ok((_, _)) => break,
        }
    }
    if input.is_none() { mark_failure(&mic_stats, "UNAVAILABLE", "AUDIO_DEVICE_NOT_FOUND", "mic device unavailable".to_string()); }
    else if mic_result.is_none() { mark_failure(&mic_stats, "TIMEOUT", "AUDIO_CAPTURE_TIMEOUT", "mic configuration or stream build timed out".to_string()); }
    if output.is_none() { mark_failure(&system_stats, "UNAVAILABLE", "AUDIO_DEVICE_NOT_FOUND", "system loopback device unavailable".to_string()); }
    else if system_result.is_none() { mark_failure(&system_stats, "TIMEOUT", "AUDIO_CAPTURE_TIMEOUT", "system configuration or stream build timed out".to_string()); }
    let mic = finish_result(mic_result, &mic_stats);
    let system = finish_result(system_result, &system_stats);
    let (mic_stream, mic_rate, mic_channels) = mic.map(|opened| (Some(opened.stream), opened.sample_rate, opened.channels)).unwrap_or((None, TARGET_SAMPLE_RATE, 1));
    let (system_stream, system_rate, system_channels) = system.map(|opened| (Some(opened.stream), opened.sample_rate, opened.channels)).unwrap_or((None, TARGET_SAMPLE_RATE, 2));

    Ok(CaptureHandle { mic_stream, system_stream, mic_buffer, system_buffer, mic_stats, system_stats, mic_rate, system_rate, mic_channels, system_channels })
}

fn finish_result(result: Option<Result<OpenedStream, String>>, stats: &Arc<Mutex<CaptureStats>>) -> Option<OpenedStream> {
    match result {
        Some(Ok(opened)) => Some(opened),
        Some(Err(error)) => {
            let lower = error.to_ascii_lowercase();
            if lower.contains("denied") || lower.contains("permission") || lower.contains("access") {
                mark_failure(stats, "PERMISSION_DENIED", "AUDIO_PERMISSION_DENIED", error);
            } else {
                mark_failure(stats, "OPEN_FAILED", "AUDIO_STREAM_OPEN_FAILED", error);
            }
            None
        }
        None => None,
    }
}

fn open_input_channel(device: Device, queue: SharedAudioBuffer, stats: Arc<Mutex<CaptureStats>>) -> Result<OpenedStream, String> {
    trace("mic_config_begin");
    let config = device.default_input_config().map_err(|error| format!("mic config failed: {error}"))?;
    trace("mic_config_end");
    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let stream = build_stream_for_format(&device, config.config(), config.sample_format(), queue, stats)?;
    Ok(OpenedStream { stream, sample_rate, channels })
}

fn open_loopback_channel(device: Device, queue: SharedAudioBuffer, stats: Arc<Mutex<CaptureStats>>) -> Result<OpenedStream, String> {
    trace("system_config_begin");
    // cpal's Windows WASAPI backend transparently sets
    // AUDCLNT_STREAMFLAGS_LOOPBACK when this render endpoint is passed to
    // build_input_stream.
    let config = device.default_output_config().map_err(|error| format!("loopback config failed: {error}"))?;
    trace("system_config_end");
    let sample_rate = config.sample_rate();
    let channels = config.channels();
    let stream = build_stream_for_format(&device, config.config(), config.sample_format(), queue, stats)?;
    Ok(OpenedStream { stream, sample_rate, channels })
}

pub fn mark_failure(stats: &Arc<Mutex<CaptureStats>>, state: &'static str, code: &'static str, reason: String) {
    if let Ok(mut stats) = stats.lock() {
        stats.stream_ok = false;
        stats.ok = false;
        stats.state = Some(state);
        stats.code = Some(code.to_string());
        stats.error = Some(reason);
    }
}

fn build_stream_typed<T>(device: &Device, config: StreamConfig, queue: SharedAudioBuffer, stats: Arc<Mutex<CaptureStats>>) -> Result<Stream, String>
where
    T: cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let error_stats = Arc::clone(&stats);
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            let samples: Vec<f32> = data.iter().map(|sample| f32::from_sample(*sample)).collect();
            if let Ok(mut stats) = stats.lock() { stats.record(&samples); }
            if let Ok(mut queue) = queue.lock() { queue.push(samples); }
        },
        move |error| mark_failure(&error_stats, "DEVICE_GONE", "AUDIO_DEVICE_GONE", format!("audio callback failed: {error}")),
        Some(CHANNEL_OPEN_TIMEOUT),
    ).map_err(|error| format!("failed to build audio stream: {error}"))
}

fn build_stream_for_format(device: &Device, config: StreamConfig, format: SampleFormat, queue: SharedAudioBuffer, stats: Arc<Mutex<CaptureStats>>) -> Result<Stream, String> {
    match format {
        SampleFormat::F32 => build_stream_typed::<f32>(device, config, queue, stats),
        SampleFormat::I16 => build_stream_typed::<i16>(device, config, queue, stats),
        SampleFormat::I24 => build_stream_typed::<cpal::I24>(device, config, queue, stats),
        SampleFormat::I32 => build_stream_typed::<i32>(device, config, queue, stats),
        SampleFormat::U8 => build_stream_typed::<u8>(device, config, queue, stats),
        SampleFormat::U16 => build_stream_typed::<u16>(device, config, queue, stats),
        SampleFormat::U24 => build_stream_typed::<cpal::U24>(device, config, queue, stats),
        SampleFormat::U32 => build_stream_typed::<u32>(device, config, queue, stats),
        other => Err(format!("unsupported sample format: {other:?}")),
    }
}

fn trace(details: &str) {
    emit(&Event::Trace { stage: "config_resolved", channel: None, elapsed_ms: 0, details: Some(details.to_string()), timestamp: timestamp() });
}
