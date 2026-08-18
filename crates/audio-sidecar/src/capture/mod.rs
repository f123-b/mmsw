pub mod wasapi;

use crate::device::{select_input, select_output};
use crate::drift::{calculate as calculate_drift, correction_frames};
use crate::health;
use crate::meter::peak;
use crate::mixer::{drain_shared, stats_shared};
use crate::packet::write_packet;
use crate::protocol::{emit, timestamp, Event, FRAMES_PER_PACKET, TARGET_SAMPLE_RATE};
use crate::resample::{mono, LinearResampler};
use cpal::traits::StreamTrait;
use std::collections::VecDeque;
use std::io;
use std::thread;
use std::time::{Duration, Instant};

pub fn run(
    input_id: Option<&str>,
    output_id: Option<&str>,
    meter_only: bool,
    probe_only: bool,
) -> Result<(), String> {
    let host = cpal::default_host();
    let input = select_input(&host, input_id)?;
    let output = select_output(&host, output_id)?;
    let capture = wasapi::open(&input, &output)?;
    capture
        .mic_stream
        .play()
        .map_err(|error| format!("mic start failed: {error}"))?;
    capture
        .system_stream
        .play()
        .map_err(|error| format!("loopback start failed: {error}"))?;

    if probe_only {
        return run_probe(capture);
    }

    health::ready();
    let mut mic_resampler = LinearResampler::new(capture.mic_rate, capture.mic_channels as usize);
    let mut system_resampler =
        LinearResampler::new(capture.system_rate, capture.system_channels as usize);
    let mut mic = VecDeque::new();
    let mut system = VecDeque::new();
    let mut stdout = io::stdout().lock();
    let mut last_buffer_report = Instant::now();
    let mut last_drift_report = Instant::now();
    let mut persistent_drift_reports = 0_u8;

    loop {
        mic.extend(mono(
            mic_resampler.push(&drain_shared(&capture.mic_buffer)),
            capture.mic_channels as usize,
        ));
        system.extend(mono(
            system_resampler.push(&drain_shared(&capture.system_buffer)),
            capture.system_channels as usize,
        ));
        while mic.len() >= FRAMES_PER_PACKET && system.len() >= FRAMES_PER_PACKET {
            let mic_packet = mic.drain(..FRAMES_PER_PACKET).collect::<Vec<_>>();
            let system_packet = system.drain(..FRAMES_PER_PACKET).collect::<Vec<_>>();
            if !meter_only {
                write_packet(&mut stdout, &mic_packet, &system_packet)
                    .map_err(|error| format!("PCM output failed: {error}"))?;
            }
            emit(&Event::Meter {
                mic: peak(&mic_packet),
                system: peak(&system_packet),
                timestamp: timestamp(),
            });
        }
        if last_buffer_report.elapsed() >= Duration::from_secs(1) {
            let mic_stats = stats_shared(&capture.mic_buffer);
            let system_stats = stats_shared(&capture.system_buffer);
            emit(&Event::Buffer {
                queued_frames: mic_stats.queued_frames + system_stats.queued_frames,
                dropped_frames: mic_stats.dropped_frames + system_stats.dropped_frames,
                buffer_duration_ms: (mic_stats.buffer_duration_ms
                    + system_stats.buffer_duration_ms)
                    / 2,
                timestamp: timestamp(),
            });
            last_buffer_report = Instant::now();
        }
        if last_drift_report.elapsed() >= Duration::from_secs(1) {
            let drift = calculate_drift(mic.len(), system.len());
            if drift.drift_ms.abs() > 80 {
                persistent_drift_reports = persistent_drift_reports.saturating_add(1);
            } else {
                persistent_drift_reports = 0;
            }
            if persistent_drift_reports >= 3 {
                let (mic_drop, system_drop) =
                    correction_frames(drift.drift_frames, FRAMES_PER_PACKET);
                mic.drain(..mic_drop.min(mic.len()));
                system.drain(..system_drop.min(system.len()));
                persistent_drift_reports = 0;
            }
            emit(&Event::Drift {
                mic_available_frames: drift.mic_available_frames,
                system_available_frames: drift.system_available_frames,
                drift_frames: drift.drift_frames,
                drift_ms: drift.drift_ms,
                status: drift.status,
                timestamp: timestamp(),
            });
            last_drift_report = Instant::now();
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn run_probe(capture: wasapi::CaptureHandle) -> Result<(), String> {
    let started = Instant::now();
    thread::sleep(Duration::from_secs(2));
    let mic = capture
        .mic_stats
        .lock()
        .expect("mic stats poisoned")
        .clone();
    let system = capture
        .system_stats
        .lock()
        .expect("system stats poisoned")
        .clone();
    emit(&Event::Probe {
        mic: mic.clone(),
        system: system.clone(),
        duration_ms: started.elapsed().as_millis() as u64,
        timestamp: timestamp(),
    });
    if !mic.ok() || !system.ok() {
        return Err(format!(
            "probe produced no samples: mic={} callbacks, system={} callbacks",
            mic.callback_count, system.callback_count
        ));
    }
    health::ready();
    Ok(())
}

#[allow(dead_code)]
fn _target_rate() -> u32 {
    TARGET_SAMPLE_RATE
}
