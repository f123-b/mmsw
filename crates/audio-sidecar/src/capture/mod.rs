pub mod wasapi;

use crate::device::{device_id, select_input, select_output};
use crate::drift::{calculate as calculate_drift, correction_frames};
use crate::health;
use crate::meter::peak;
use crate::mixer::{drain_shared, stats_shared};
use crate::packet::write_packet;
use crate::protocol::{emit, timestamp, CaptureStats, ChannelCapability, Event, FRAMES_PER_PACKET, TARGET_SAMPLE_RATE};
use crate::resample::{mono, LinearResampler};
use cpal::traits::StreamTrait;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// Some Realtek/WASAPI drivers need more than 2.5 seconds after stream.play(),
// especially immediately after resume or a device format change.
const CALLBACK_TIMEOUT: Duration = Duration::from_millis(4_500);
const SINGLE_CHANNEL_GRACE: Duration = Duration::from_millis(650);

pub fn run(input_id: Option<&str>, output_id: Option<&str>, meter_only: bool, probe_only: bool) -> Result<(), String> {
    let started = Instant::now();
    let host = cpal::default_host();
    emit_trace("device_enumerated", None, started, Some("WASAPI host initialized".to_string()));
    let input = match select_input(&host, input_id) {
        Ok(device) => Some(device),
        Err(error) => {
            emit_error("mic", "AUDIO_DEVICE_NOT_FOUND", error, true);
            None
        }
    };
    emit_trace("device_enumerated", Some("mic"), started, input.as_ref().map(|device| format!("selected {}", device_id(device))));
    let output = match select_output(&host, output_id) {
        Ok(device) => Some(device),
        Err(error) => {
            emit_error("loopback", "AUDIO_DEVICE_NOT_FOUND", error, true);
            None
        }
    };
    emit_trace("device_enumerated", Some("system"), started, output.as_ref().map(|device| format!("selected {}", device_id(device))));
    if let (Some(requested), Some(selected)) = (input_id, input.as_ref()) {
        if device_id(selected) != requested {
            emit_error("device", "AUDIO_DEVICE_FALLBACK", format!("selected microphone {requested} was unavailable; using {}", device_id(selected)), true);
        }
    }
    if let (Some(requested), Some(selected)) = (output_id, output.as_ref()) {
        if device_id(selected) != requested {
            emit_error("device", "AUDIO_DEVICE_FALLBACK", format!("selected loopback {requested} was unavailable; using {}", device_id(selected)), true);
        }
    }

    emit_trace("config_resolved", None, started, Some("opening independent channel streams".to_string()));
    let capture = wasapi::open(input.as_ref(), output.as_ref())?;
    set_device_info(&capture.mic_stats, input.as_ref());
    set_device_info(&capture.system_stats, output.as_ref());
    emit_trace("device_enumerated", None, started, Some("independent mic and WASAPI loopback selection".to_string()));
    emit_trace("config_resolved", None, started, Some(format!("mic={}Hz/{}ch system={}Hz/{}ch", capture.mic_rate, capture.mic_channels, capture.system_rate, capture.system_channels)));
    emit_trace("stream_built", Some("mic"), started, capture.mic_stream.as_ref().map(|_| "microphone stream built".to_string()));
    emit_trace("stream_built", Some("system"), started, capture.system_stream.as_ref().map(|_| "WASAPI loopback stream built".to_string()));

    if let Some(stream) = capture.mic_stream.as_ref() {
        if let Err(error) = stream.play() {
            wasapi::mark_failure(&capture.mic_stats, "OPEN_FAILED", "AUDIO_STREAM_OPEN_FAILED", format!("mic start failed: {error}"));
        } else {
            emit_trace("stream_started", Some("mic"), started, Some("microphone stream started".to_string()));
        }
    }
    if let Some(stream) = capture.system_stream.as_ref() {
        if let Err(error) = stream.play() {
            wasapi::mark_failure(&capture.system_stats, "OPEN_FAILED", "AUDIO_STREAM_OPEN_FAILED", format!("loopback start failed: {error}"));
        } else {
            emit_trace("stream_started", Some("system"), started, Some("WASAPI loopback stream started".to_string()));
        }
    }

    wait_for_callbacks(&capture, started);
    if probe_only {
        return run_probe(capture, started);
    }

    let mode = capture_mode(&capture)?;
    emit_capability(&capture, mode, "capture");
    emit_health(&capture, mode);
    emit_state(if mode == "dual" { "READY" } else { "DEGRADED" }, Some(mode));

    let mut mic_resampler = capture.mic_stream.as_ref().map(|_| LinearResampler::new(capture.mic_rate, capture.mic_channels as usize));
    let mut system_resampler = capture.system_stream.as_ref().map(|_| LinearResampler::new(capture.system_rate, capture.system_channels as usize));
    let mut mic_usable = stats(&capture.mic_stats).stream_ok();
    let mut system_usable = stats(&capture.system_stats).stream_ok();
    let mut mic = VecDeque::new();
    let mut system = VecDeque::new();
    let mut stdout = io::stdout().lock();
    let mut last_buffer_report = Instant::now();
    let mut last_drift_report = Instant::now();
    let mut persistent_drift_reports = 0_u8;

    loop {
        let mic_now = stats(&capture.mic_stats).stream_ok();
        let system_now = stats(&capture.system_stats).stream_ok();
        if mic_usable && !mic_now {
            let error = stats(&capture.mic_stats).error.unwrap_or_else(|| "microphone callback stopped".to_string());
            emit_error("mic", "AUDIO_DEVICE_GONE", error, true);
            return Err("AUDIO_DEVICE_GONE: microphone callback stopped".to_string());
        }
        if system_usable && !system_now {
            let error = stats(&capture.system_stats).error.unwrap_or_else(|| "system loopback callback stopped".to_string());
            emit_error("loopback", "AUDIO_DEVICE_GONE", error, true);
            return Err("AUDIO_DEVICE_GONE: system loopback callback stopped".to_string());
        }
        if (!mic_usable && mic_now) || (!system_usable && system_now) {
            if let Some(recovered_mode) = capture_mode_optional(&stats(&capture.mic_stats), &stats(&capture.system_stats)) {
                emit_capability(&capture, recovered_mode, "late_callback_recovery");
                emit_health(&capture, recovered_mode);
                emit_state(if recovered_mode == "dual" { "READY" } else { "DEGRADED" }, Some(recovered_mode));
            }
        }
        mic_usable = mic_now;
        system_usable = system_now;
        if let Some(resampler) = mic_resampler.as_mut() {
            mic.extend(mono(resampler.push(&drain_shared(&capture.mic_buffer)), capture.mic_channels as usize));
        }
        if let Some(resampler) = system_resampler.as_mut() {
            system.extend(mono(resampler.push(&drain_shared(&capture.system_buffer)), capture.system_channels as usize));
        }
        let mic_ready = mic_usable;
        let system_ready = system_usable;
        while (mic_ready && system_ready && mic.len() >= FRAMES_PER_PACKET && system.len() >= FRAMES_PER_PACKET)
            || (mic_ready && !system_ready && mic.len() >= FRAMES_PER_PACKET)
            || (!mic_ready && system_ready && system.len() >= FRAMES_PER_PACKET)
        {
            let mic_packet = if mic_ready { mic.drain(..FRAMES_PER_PACKET).collect::<Vec<_>>() } else { vec![0.0; FRAMES_PER_PACKET] };
            let system_packet = if system_ready { system.drain(..FRAMES_PER_PACKET).collect::<Vec<_>>() } else { vec![0.0; FRAMES_PER_PACKET] };
            if !meter_only { write_packet(&mut stdout, &mic_packet, &system_packet).map_err(|error| format!("PCM output failed: {error}"))?; }
            emit(&Event::Meter { mic: peak(&mic_packet), system: peak(&system_packet), timestamp: timestamp() });
        }
        if last_buffer_report.elapsed() >= Duration::from_secs(1) {
            let mic_stats = stats_shared(&capture.mic_buffer);
            let system_stats = stats_shared(&capture.system_buffer);
            emit(&Event::Buffer { queued_frames: mic_stats.queued_frames + system_stats.queued_frames, dropped_frames: mic_stats.dropped_frames + system_stats.dropped_frames, buffer_duration_ms: (mic_stats.buffer_duration_ms + system_stats.buffer_duration_ms) / 2, timestamp: timestamp() });
            last_buffer_report = Instant::now();
        }
        if last_drift_report.elapsed() >= Duration::from_secs(1) {
            let drift = calculate_drift(mic.len(), system.len());
            if drift.drift_ms.abs() > 80 { persistent_drift_reports = persistent_drift_reports.saturating_add(1); } else { persistent_drift_reports = 0; }
            if persistent_drift_reports >= 3 {
                let (mic_drop, system_drop) = correction_frames(drift.drift_frames, FRAMES_PER_PACKET);
                mic.drain(..mic_drop.min(mic.len()));
                system.drain(..system_drop.min(system.len()));
                persistent_drift_reports = 0;
            }
            emit(&Event::Drift { mic_available_frames: drift.mic_available_frames, system_available_frames: drift.system_available_frames, drift_frames: drift.drift_frames, drift_ms: drift.drift_ms, status: drift.status, timestamp: timestamp() });
            last_drift_report = Instant::now();
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_callbacks(capture: &wasapi::CaptureHandle, started: Instant) {
    let waiting_started = Instant::now();
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    while Instant::now() < deadline {
        let mic_ready = capture.mic_stream.is_some() && stats(&capture.mic_stats).stream_ok();
        let system_ready = capture.system_stream.is_some() && stats(&capture.system_stats).stream_ok();
        if (mic_ready && system_ready) || ((mic_ready || system_ready) && waiting_started.elapsed() >= SINGLE_CHANNEL_GRACE) { break; }
        thread::sleep(Duration::from_millis(10));
    }
    for (channel, stream, channel_stats) in [("mic", capture.mic_stream.is_some(), &capture.mic_stats), ("system", capture.system_stream.is_some(), &capture.system_stats)] {
        if stream {
            let mut snapshot = channel_stats.lock().expect("audio stats poisoned");
            if snapshot.stream_ok() {
                if snapshot.first_callback_ms.is_none() { snapshot.first_callback_ms = Some(started.elapsed().as_millis() as u64); }
                emit_trace("first_callback", Some(channel), started, snapshot.first_callback_ms.map(|ms| format!("{ms}ms")));
            } else {
                snapshot.state = Some("TIMEOUT");
                snapshot.code = Some("AUDIO_CAPTURE_TIMEOUT".to_string());
                snapshot.error = Some(format!("{channel} produced no callback during the {}ms startup window", waiting_started.elapsed().as_millis()));
                emit_trace("first_callback", Some(channel), started, Some("timeout".to_string()));
            }
        }
    }
}

fn run_probe(capture: wasapi::CaptureHandle, started: Instant) -> Result<(), String> {
    thread::sleep(Duration::from_millis(500));
    let mic = stats(&capture.mic_stats);
    let system = stats(&capture.system_stats);
    let mode = capture_mode_optional(&mic, &system);
    emit(&Event::Probe { mic, system, capture_mode: mode, duration_ms: started.elapsed().as_millis() as u64, timestamp: timestamp() });
    emit_trace("result_emitted", None, started, Some("structured per-channel probe result".to_string()));
    if let Some(mode) = mode {
        emit_capability(&capture, mode, "probe");
        emit_health(&capture, mode);
        emit_state(if mode == "dual" { "READY" } else { "DEGRADED" }, Some(mode));
    } else {
        health::failed("NO_AUDIO_CHANNEL_AVAILABLE: both audio channels unavailable".to_string());
    }
    emit_trace("process_exited", None, started, Some("probe process completed".to_string()));
    Ok(())
}

fn capture_mode(capture: &wasapi::CaptureHandle) -> Result<&'static str, String> {
    let mic = stats(&capture.mic_stats);
    let system = stats(&capture.system_stats);
    capture_mode_optional(&mic, &system).ok_or_else(|| {
        emit_error("process", "NO_AUDIO_CHANNEL_AVAILABLE", "microphone and system loopback are both unavailable".to_string(), false);
        emit_state("FAILED", None);
        "NO_AUDIO_CHANNEL_AVAILABLE: microphone and system loopback are both unavailable".to_string()
    })
}

fn capture_mode_optional(mic: &CaptureStats, system: &CaptureStats) -> Option<&'static str> {
    match (mic.stream_ok(), system.stream_ok()) {
        (true, true) => Some("dual"),
        (false, true) => Some("system_only"),
        (true, false) => Some("mic_only"),
        (false, false) => None,
    }
}

fn emit_capability(capture: &wasapi::CaptureHandle, mode: &'static str, source: &'static str) {
    emit(&Event::Capability { capture_mode: mode, mic: ChannelCapability::from_stats(&stats(&capture.mic_stats)), system: ChannelCapability::from_stats(&stats(&capture.system_stats)), timestamp: timestamp(), source });
}

fn emit_health(capture: &wasapi::CaptureHandle, _mode: &'static str) {
    let mic = stats(&capture.mic_stats);
    let system = stats(&capture.system_stats);
    emit(&Event::Health { mic: if mic.stream_ok() { "ok" } else { "failed" }, loopback: if system.stream_ok() { "ok" } else { "failed" }, timestamp: timestamp() });
}

fn emit_state(state: &'static str, mode: Option<&'static str>) { emit(&Event::State { state, capture_mode: mode, timestamp: timestamp() }); }

fn emit_error(component: &'static str, code: &'static str, reason: String, recoverable: bool) {
    emit(&Event::Error { component, code: Some(code.to_string()), reason, recoverable, timestamp: timestamp() });
}

fn emit_trace(stage: &'static str, channel: Option<&'static str>, started: Instant, details: Option<String>) {
    emit(&Event::Trace { stage, channel, elapsed_ms: started.elapsed().as_millis() as u64, details, timestamp: timestamp() });
}

fn stats(stats: &Arc<Mutex<CaptureStats>>) -> CaptureStats { stats.lock().expect("audio stats poisoned").clone() }

fn set_device_info(stats: &Arc<Mutex<CaptureStats>>, device: Option<&cpal::Device>) {
    if let Some(device) = device {
        let mut stats = stats.lock().expect("audio stats poisoned");
        stats.device_id = Some(device_id(device));
        stats.device_name = Some(device.to_string());
    }
}

#[allow(dead_code)]
fn _target_rate() -> u32 { TARGET_SAMPLE_RATE }
