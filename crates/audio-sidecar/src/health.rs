use crate::protocol::{emit, timestamp, Event};

pub fn starting() {
    emit(&Event::State {
        state: "STARTING",
        capture_mode: None,
        timestamp: timestamp(),
    });
}
pub fn failed(reason: String) {
    emit(&Event::Error {
        component: "process",
        code: Some(if reason.contains("NO_AUDIO_CHANNEL_AVAILABLE") { "NO_AUDIO_CHANNEL_AVAILABLE".to_string() } else { "AUDIO_CAPTURE_FAILED".to_string() }),
        reason,
        recoverable: false,
        timestamp: timestamp(),
    });
    emit(&Event::State {
        state: "FAILED",
        capture_mode: None,
        timestamp: timestamp(),
    });
}
