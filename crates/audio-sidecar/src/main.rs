use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const TARGET_CHANNELS: usize = 2;
const FRAMES_PER_PACKET: usize = 640;
const MAX_BUFFER_FRAMES: usize = TARGET_SAMPLE_RATE * 3;

#[derive(Serialize)]
struct DeviceInfo {
    id: String,
    name: String,
    kind: &'static str,
    default: bool,
}

#[derive(Serialize)]
struct DeviceList {
    inputs: Vec<DeviceInfo>,
    outputs: Vec<DeviceInfo>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Event {
    #[serde(rename = "audio_state")]
    State { state: &'static str, timestamp: u128 },
    #[serde(rename = "audio_health")]
    Health { mic: &'static str, loopback: &'static str, timestamp: u128 },
    #[serde(rename = "meter")]
    Meter { mic: f32, system: f32, timestamp: u128 },
    #[serde(rename = "audio_error")]
    Error { component: &'static str, reason: String, recoverable: bool, timestamp: u128 },
}

type AudioQueue = Arc<Mutex<VecDeque<Vec<f32>>>>;

fn timestamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn emit(event: &Event) {
    let mut stdout = io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, event);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

fn device_id(device: &Device) -> String {
    device.id().map(|id| id.to_string()).unwrap_or_else(|_| device.name().unwrap_or_else(|_| "unknown".to_string()))
}

fn enumerate_devices() -> Result<DeviceList, String> {
    let host = cpal::default_host();
    let default_input = host.default_input_device().map(|device| device_id(&device));
    let default_output = host.default_output_device().map(|device| device_id(&device));
    let inputs = host.input_devices().map_err(|error| error.to_string())?.filter_map(|device| {
        let device = device.ok()?;
        Some(DeviceInfo {
            id: device_id(&device),
            name: device.name().unwrap_or_else(|_| "Unknown microphone".to_string()),
            kind: "microphone",
            default: default_input.as_deref() == Some(device_id(&device).as_str()),
        })
    }).collect();
    let outputs = host.output_devices().map_err(|error| error.to_string())?.filter_map(|device| {
        let device = device.ok()?;
        Some(DeviceInfo {
            id: device_id(&device),
            name: device.name().unwrap_or_else(|_| "Unknown output".to_string()),
            kind: "loopback",
            default: default_output.as_deref() == Some(device_id(&device).as_str()),
        })
    }).collect();
    Ok(DeviceList { inputs, outputs })
}

fn push_frames(queue: &AudioQueue, frames: Vec<f32>) {
    if frames.is_empty() { return; }
    let mut queue = queue.lock().expect("audio queue poisoned");
    let queued_frames = queue.iter().map(|chunk| chunk.len()).sum::<usize>();
    let incoming_frames = frames.len();
    queue.push_back(frames);
    let mut remaining = queued_frames + incoming_frames;
    while remaining > MAX_BUFFER_FRAMES {
        if let Some(oldest) = queue.pop_front() { remaining -= oldest.len(); } else { break; }
    }
}

fn build_stream<T, F>(device: &Device, config: &StreamConfig, queue: AudioQueue, mut meter: F) -> Result<Stream, String>
where
    T: cpal::SizedSample + Send + 'static,
    F: FnMut(&[f32]) + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            let samples: Vec<f32> = data.iter().map(|sample| f32::from_sample(*sample)).collect();
            meter(&samples);
            push_frames(&queue, samples);
        },
        move |error| {
            eprintln!("audio stream error: {error}");
        },
        None,
    ).map_err(|error| format!("failed to build {channels}-channel stream: {error}"))
}

fn build_stream_for_format<F>(device: &Device, config: &StreamConfig, format: SampleFormat, queue: AudioQueue, meter: F) -> Result<Stream, String>
where
    F: FnMut(&[f32]) + Send + 'static,
{
    match format {
        SampleFormat::F32 => build_stream::<f32, _>(device, config, queue, meter),
        SampleFormat::I16 => build_stream::<i16, _>(device, config, queue, meter),
        SampleFormat::I24 => build_stream::<cpal::I24, _>(device, config, queue, meter),
        SampleFormat::I32 => build_stream::<i32, _>(device, config, queue, meter),
        SampleFormat::U8 => build_stream::<u8, _>(device, config, queue, meter),
        SampleFormat::U16 => build_stream::<u16, _>(device, config, queue, meter),
        SampleFormat::U24 => build_stream::<cpal::U24, _>(device, config, queue, meter),
        SampleFormat::U32 => build_stream::<u32, _>(device, config, queue, meter),
        format => Err(format!("unsupported sample format: {format:?}")),
    }
}

fn drain_queue(queue: &AudioQueue) -> Vec<f32> {
    let mut queue = queue.lock().expect("audio queue poisoned");
    let mut samples = Vec::new();
    while let Some(chunk) = queue.pop_front() { samples.extend(chunk); }
    samples
}

struct LinearResampler {
    source_rate: f64,
    channels: usize,
    input: Vec<f32>,
    position: f64,
}

impl LinearResampler {
    fn new(source_rate: u32, channels: usize) -> Self {
        Self { source_rate: source_rate as f64, channels, input: Vec::new(), position: 0.0 }
    }

    fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        self.input.extend_from_slice(samples);
        if (self.source_rate - TARGET_SAMPLE_RATE as f64).abs() < f64::EPSILON {
            let output = self.input.clone();
            self.input.clear();
            return output;
        }
        let source_frames = self.input.len() / self.channels;
        let ratio = self.source_rate / TARGET_SAMPLE_RATE as f64;
        let mut output = Vec::new();
        while self.position + 1.0 < source_frames as f64 {
            let frame = self.position.floor() as usize;
            let fraction = self.position - frame as f64;
            for channel in 0..self.channels {
                let a = self.input[frame * self.channels + channel];
                let b = self.input[(frame + 1) * self.channels + channel];
                output.push(a + (b - a) * fraction as f32);
            }
            self.position += ratio;
        }
        let consumed = self.position.floor() as usize;
        if consumed > 0 {
            self.input.drain(0..consumed * self.channels);
            self.position -= consumed as f64;
        }
        output
    }
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().map(|sample| sample.abs()).fold(0.0, f32::max).min(1.0)
}

fn emit_packet(mic: &mut VecDeque<f32>, system: &mut VecDeque<f32>, meter_only: bool) {
    if mic.len() < FRAMES_PER_PACKET || system.len() < FRAMES_PER_PACKET { return; }
    let mut packet = Vec::with_capacity(FRAMES_PER_PACKET * TARGET_CHANNELS * 2);
    let mut mic_peak = 0.0;
    let mut system_peak = 0.0;
    for _ in 0..FRAMES_PER_PACKET {
        let mic_sample = mic.pop_front().unwrap_or_default().clamp(-1.0, 1.0);
        let system_sample = system.pop_front().unwrap_or_default().clamp(-1.0, 1.0);
        mic_peak = mic_peak.max(mic_sample.abs());
        system_peak = system_peak.max(system_sample.abs());
        if !meter_only {
            packet.extend_from_slice(&((mic_sample * i16::MAX as f32) as i16).to_le_bytes());
            packet.extend_from_slice(&((system_sample * i16::MAX as f32) as i16).to_le_bytes());
        }
    }
    emit(&Event::Meter { mic: mic_peak, system: system_peak, timestamp: timestamp() });
    if !meter_only {
        // Phase 1 exposes meters. Phase 2 will move PCM to a dedicated binary transport
        // so JSON health events can remain independently parseable by Electron.
        let _ = packet;
    }
}

fn run_capture(input_id: Option<String>, output_id: Option<String>, meter_only: bool, probe_only: bool) -> Result<(), String> {
    let host = cpal::default_host();
    let input = select_input(&host, input_id.as_deref())?;
    let output = select_output(&host, output_id.as_deref())?;
    let input_config = input.default_input_config().map_err(|error| format!("mic config failed: {error}"))?;
    // WASAPI loopback is created by building an input stream against the render device.
    let output_config = output.default_output_config().map_err(|error| format!("loopback config failed: {error}"))?;
    let mic_queue = Arc::new(Mutex::new(VecDeque::new()));
    let system_queue = Arc::new(Mutex::new(VecDeque::new()));
    let mic_rate = input_config.sample_rate().0;
    let system_rate = output_config.sample_rate().0;
    let mic_channels = input_config.channels as usize;
    let system_channels = output_config.channels as usize;
    let mic_meter = Arc::new(Mutex::new(0.0_f32));
    let system_meter = Arc::new(Mutex::new(0.0_f32));
    let mic_meter_clone = Arc::clone(&mic_meter);
    let system_meter_clone = Arc::clone(&system_meter);
    let mic_stream = build_stream_for_format(&input, &input_config.config(), input_config.sample_format(), Arc::clone(&mic_queue), move |samples| {
        if let Ok(mut value) = mic_meter_clone.lock() { *value = peak(samples); }
    })?;
    let system_stream = build_stream_for_format(&output, &output_config.config(), output_config.sample_format(), Arc::clone(&system_queue), move |samples| {
        if let Ok(mut value) = system_meter_clone.lock() { *value = peak(samples); }
    })?;
    mic_stream.play().map_err(|error| format!("mic start failed: {error}"))?;
    system_stream.play().map_err(|error| format!("loopback start failed: {error}"))?;
    emit(&Event::Health { mic: "ok", loopback: "ok", timestamp: timestamp() });
    emit(&Event::State { state: "READY", timestamp: timestamp() });
    if probe_only { thread::sleep(Duration::from_millis(250)); return Ok(()); }

    let mut mic_resampler = LinearResampler::new(mic_rate, mic_channels);
    let mut system_resampler = LinearResampler::new(system_rate, system_channels);
    let mut mic = VecDeque::new();
    let mut system = VecDeque::new();
    loop {
        mic.extend(mono(mic_resampler.push(&drain_queue(&mic_queue)), mic_channels));
        system.extend(mono(system_resampler.push(&drain_queue(&system_queue)), system_channels));
        emit_packet(&mut mic, &mut system, meter_only);
        thread::sleep(Duration::from_millis(5));
    }
}

fn mono(samples: Vec<f32>, channels: usize) -> Vec<f32> {
    if channels <= 1 { return samples; }
    samples.chunks(channels).map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32).collect()
}

fn select_input(host: &cpal::Host, id: Option<&str>) -> Result<Device, String> {
    if let Some(id) = id {
        return host.input_devices().map_err(|error| error.to_string())?.flatten().find(|device| device_id(device) == id).ok_or_else(|| format!("microphone not found: {id}"));
    }
    host.default_input_device().ok_or_else(|| "default microphone not found".to_string())
}

fn select_output(host: &cpal::Host, id: Option<&str>) -> Result<Device, String> {
    if let Some(id) = id {
        return host.output_devices().map_err(|error| error.to_string())?.flatten().find(|device| device_id(device) == id).ok_or_else(|| format!("loopback output not found: {id}"));
    }
    host.default_output_device().ok_or_else(|| "default output device not found".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let has = |name: &str| args.iter().any(|arg| arg == name);
    let value = |name: &str| args.windows(2).find(|pair| pair[0] == name).map(|pair| pair[1].clone());

    if has("--list-devices") {
        match enumerate_devices() {
            Ok(devices) => println!("{}", serde_json::to_string(&devices).expect("device list serialization failed")),
            Err(error) => {
                emit(&Event::Error { component: "device", reason: error, recoverable: false, timestamp: timestamp() });
                std::process::exit(1);
            }
        }
        return;
    }

    let meter_only = has("--meter-only");
    let probe_only = has("--probe-only");
    emit(&Event::State { state: "STARTING", timestamp: timestamp() });
    if let Err(error) = run_capture(value("--input-device-id"), value("--output-device-id"), meter_only, probe_only) {
        emit(&Event::Error { component: "process", reason: error, recoverable: true, timestamp: timestamp() });
        emit(&Event::State { state: "FAILED", timestamp: timestamp() });
        std::process::exit(1);
    }
}
