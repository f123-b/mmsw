use crate::protocol::{emit, timestamp, Event};

pub fn starting() {
    emit(&Event::State {
        state: "STARTING",
        timestamp: timestamp(),
    });
}
pub fn ready() {
    emit(&Event::Health {
        mic: "ok",
        loopback: "ok",
        timestamp: timestamp(),
    });
    emit(&Event::State {
        state: "READY",
        timestamp: timestamp(),
    });
}
pub fn failed(reason: String) {
    emit(&Event::Error {
        component: "process",
        reason,
        recoverable: true,
        timestamp: timestamp(),
    });
    emit(&Event::State {
        state: "FAILED",
        timestamp: timestamp(),
    });
}
