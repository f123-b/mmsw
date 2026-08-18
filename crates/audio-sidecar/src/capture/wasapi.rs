use crate::mixer::{new_shared_buffer, SharedAudioBuffer};
use crate::protocol::CaptureStats;
use cpal::traits::DeviceTrait;
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use std::sync::{Arc, Mutex};

pub struct CaptureHandle {
    pub mic_stream: Stream,
    pub system_stream: Stream,
    pub mic_buffer: SharedAudioBuffer,
    pub system_buffer: SharedAudioBuffer,
    pub mic_stats: Arc<Mutex<CaptureStats>>,
    pub system_stats: Arc<Mutex<CaptureStats>>,
    pub mic_rate: u32,
    pub system_rate: u32,
    pub mic_channels: u16,
    pub system_channels: u16,
}

pub fn open(input: &Device, output: &Device) -> Result<CaptureHandle, String> {
    let input_config = input
        .default_input_config()
        .map_err(|error| format!("mic config failed: {error}"))?;
    // On WASAPI the output device is opened as an input stream to enable loopback capture.
    let output_config = output
        .default_output_config()
        .map_err(|error| format!("loopback config failed: {error}"))?;
    let mic_rate = input_config.sample_rate().0;
    let system_rate = output_config.sample_rate().0;
    let mic_channels = input_config.channels;
    let system_channels = output_config.channels;
    let mic_buffer = new_shared_buffer(mic_rate, mic_channels as usize);
    let system_buffer = new_shared_buffer(system_rate, system_channels as usize);
    let mic_stats = Arc::new(Mutex::new(CaptureStats::new(mic_rate, mic_channels)));
    let system_stats = Arc::new(Mutex::new(CaptureStats::new(system_rate, system_channels)));
    let mic_stream = build_stream_for_format(
        input,
        &input_config.config(),
        input_config.sample_format(),
        Arc::clone(&mic_buffer),
        Arc::clone(&mic_stats),
    )?;
    let system_stream = build_stream_for_format(
        output,
        &output_config.config(),
        output_config.sample_format(),
        Arc::clone(&system_buffer),
        Arc::clone(&system_stats),
    )?;
    Ok(CaptureHandle {
        mic_stream,
        system_stream,
        mic_buffer,
        system_buffer,
        mic_stats,
        system_stats,
        mic_rate,
        system_rate,
        mic_channels,
        system_channels,
    })
}

fn build_stream_typed<T>(
    device: &Device,
    config: &StreamConfig,
    queue: SharedAudioBuffer,
    stats: Arc<Mutex<CaptureStats>>,
) -> Result<Stream, String>
where
    T: cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let samples: Vec<f32> = data
                    .iter()
                    .map(|sample| f32::from_sample(*sample))
                    .collect();
                if let Ok(mut stats) = stats.lock() {
                    stats.record(&samples);
                }
                if let Ok(mut queue) = queue.lock() {
                    queue.push(samples);
                }
            },
            move |error| eprintln!("audio stream error: {error}"),
            None,
        )
        .map_err(|error| format!("failed to build audio stream: {error}"))
}

fn build_stream_for_format(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    queue: SharedAudioBuffer,
    stats: Arc<Mutex<CaptureStats>>,
) -> Result<Stream, String> {
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
