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
    pub ok: bool,
    pub stream_ok: bool,
    pub signal_detected: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub callback_count: u64,
    pub sample_count: u64,
    pub peak: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_callback_ms: Option<u64>,
}

impl CaptureStats {
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            sample_rate,
            channels,
            state: Some("UNAVAILABLE"),
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
        self.stream_ok = self.callback_count > 0 && self.sample_count > 0;
        self.ok = self.stream_ok;
        self.signal_detected = self.peak >= 0.01;
        self.state = Some(if self.signal_detected { "READY" } else { "SILENT" });
    }

    pub fn stream_ok(&self) -> bool {
        self.callback_count > 0 && self.sample_count > 0
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCapability {
    pub state: &'static str,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u16>,
    pub signal_detected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_callback_ms: Option<u64>,
}

impl ChannelCapability {
    pub fn from_stats(stats: &CaptureStats) -> Self {
        let state = stats.state.unwrap_or(if stats.stream_ok { "READY" } else { "UNAVAILABLE" });
        Self {
            state,
            available: stats.stream_ok,
            device_id: stats.device_id.clone(),
            device_name: stats.device_name.clone(),
            sample_rate: Some(stats.sample_rate),
            channels: Some(stats.channels),
            signal_detected: stats.signal_detected,
            error: stats.error.clone(),
            code: stats.code.clone(),
            first_callback_ms: stats.first_callback_ms,
        }
    }
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
        #[serde(rename = "captureMode", skip_serializing_if = "Option::is_none")]
        capture_mode: Option<&'static str>,
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
        #[serde(rename = "captureMode", skip_serializing_if = "Option::is_none")]
        capture_mode: Option<&'static str>,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        timestamp: u128,
    },
    #[serde(rename = "audio_capability")]
    Capability {
        #[serde(rename = "captureMode")]
        capture_mode: &'static str,
        mic: ChannelCapability,
        system: ChannelCapability,
        timestamp: u128,
        source: &'static str,
    },
    #[serde(rename = "audio_probe_trace")]
    Trace {
        stage: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<&'static str>,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        timestamp: u128,
    },
    #[serde(rename = "audio_buffer")]
    Buffer {
        #[serde(rename = "queuedFrames")]
        queued_frames: usize,
        #[serde(rename = "droppedFrames")]
        dropped_frames: u64,
        #[serde(rename = "bufferDurationMs")]
        buffer_duration_ms: u64,
        timestamp: u128,
    },
    #[serde(rename = "audio_drift")]
    Drift {
        #[serde(rename = "micAvailableFrames")]
        mic_available_frames: usize,
        #[serde(rename = "systemAvailableFrames")]
        system_available_frames: usize,
        #[serde(rename = "driftFrames")]
        drift_frames: i64,
        #[serde(rename = "driftMs")]
        drift_ms: i64,
        status: &'static str,
        timestamp: u128,
    },
    #[serde(rename = "audio_error")]
    Error {
        component: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::{CaptureStats, Event};
    use serde_json::Value;

    #[test]
    fn probe_serialization_matches_shared_contract_fixture() {
        let actual = serde_json::to_value(Event::Probe {
            mic: CaptureStats {
                ok: true,
                stream_ok: true,
                signal_detected: true,
                sample_rate: 48_000,
                channels: 1,
                callback_count: 50,
                sample_count: 2_400_000,
                peak: 0.43,
                state: None,
                device_id: None,
                device_name: None,
                error: None,
                code: None,
                first_callback_ms: None,
            },
            system: CaptureStats {
                ok: true,
                stream_ok: true,
                signal_detected: false,
                sample_rate: 48_000,
                channels: 2,
                callback_count: 50,
                sample_count: 4_800_000,
                peak: 0.0,
                state: None,
                device_id: None,
                device_name: None,
                error: None,
                code: None,
                first_callback_ms: None,
            },
            capture_mode: None,
            duration_ms: 2_000,
            timestamp: 123,
        })
        .expect("probe event should serialize");
        let expected: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/fixtures/audio-probe-result.json"
        ))
        .expect("shared probe fixture should be valid JSON");
        assert_eq!(actual, expected);
    }

    #[test]
    fn silent_stream_is_ready_but_not_signal_detected() {
        let mut stats = CaptureStats::new(48_000, 2);
        stats.record(&[0.0, 0.0, 0.0, 0.0]);
        assert!(stats.stream_ok());
        assert!(stats.ok);
        assert!(!stats.signal_detected);
    }
}
