use serde::Serialize;
use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
pub const TARGET_CHANNELS: usize = 2;
pub const FRAMES_PER_PACKET: usize = 640;
pub const BYTES_PER_SAMPLE: usize = 2;
pub const PCM_PACKET_BYTES: usize = FRAMES_PER_PACKET * TARGET_CHANNELS * BYTES_PER_SAMPLE;
pub const MAX_BUFFER_DURATION_SECONDS: u32 = 3;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub default: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeviceList {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub sample_rate: u32,
    pub channels: u16,
    pub callback_count: u64,
    pub sample_count: u64,
    pub peak: f32,
}

impl CaptureStats {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            sample_rate,
            channels,
            ..Self::default()
        }
    }

    pub fn record(&mut self, samples: &[f32]) {
        self.callback_count += 1;
        self.sample_count += samples.len() as u64;
        self.peak = samples
            .iter()
            .map(|sample| sample.abs())
            .fold(self.peak, f32::max)
            .min(1.0);
    }

    pub fn ok(&self) -> bool {
        self.callback_count > 0 && self.sample_count > 0
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub mic: CaptureStats,
    pub system: CaptureStats,
    pub duration_ms: u64,
    pub timestamp: u128,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriftMetrics {
    pub mic_available_frames: usize,
    pub system_available_frames: usize,
    pub drift_frames: i64,
    pub drift_ms: i64,
    pub status: &'static str,
}

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "audio_state")]
    State {
        state: &'static str,
        timestamp: u128,
    },
    #[serde(rename = "audio_health")]
    Health {
        mic: &'static str,
        loopback: &'static str,
        timestamp: u128,
    },
    #[serde(rename = "meter")]
    Meter {
        mic: f32,
        system: f32,
        timestamp: u128,
    },
    #[serde(rename = "probe_result")]
    Probe {
        mic: CaptureStats,
        system: CaptureStats,
        duration_ms: u64,
        timestamp: u128,
    },
    #[serde(rename = "audio_buffer")]
    Buffer {
        queued_frames: usize,
        dropped_frames: u64,
        buffer_duration_ms: u64,
        timestamp: u128,
    },
    #[serde(rename = "audio_drift")]
    Drift {
        mic_available_frames: usize,
        system_available_frames: usize,
        drift_frames: i64,
        drift_ms: i64,
        status: &'static str,
        timestamp: u128,
    },
    #[serde(rename = "audio_error")]
    Error {
        component: &'static str,
        reason: String,
        recoverable: bool,
        timestamp: u128,
    },
}

pub fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// JSON events use stderr. stdout is reserved for raw PCM in capture mode.
pub fn emit(event: &Event) {
    let mut stderr = io::stderr().lock();
    let _ = serde_json::to_writer(&mut stderr, event);
    let _ = stderr.write_all(b"\n");
    let _ = stderr.flush();
}
