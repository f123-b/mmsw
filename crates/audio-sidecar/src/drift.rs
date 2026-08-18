use crate::protocol::DriftMetrics;

pub fn calculate(mic_available_frames: usize, system_available_frames: usize) -> DriftMetrics {
    let drift_frames = mic_available_frames as i64 - system_available_frames as i64;
    let drift_ms = drift_frames * 1_000 / 16_000;
    let absolute_ms = drift_ms.abs();
    let status = if absolute_ms < 40 {
        "normal"
    } else if absolute_ms <= 80 {
        "warning"
    } else {
        "degraded"
    };

    DriftMetrics {
        mic_available_frames,
        system_available_frames,
        drift_frames,
        drift_ms,
        status,
    }
}

#[cfg(test)]
mod tests {
    use super::calculate;

    #[test]
    fn calculates_signed_drift_and_thresholds() {
        assert_eq!(calculate(1_000, 1_000).status, "normal");
        assert_eq!(calculate(1_920, 640).drift_ms, 80);
        assert_eq!(calculate(1_920, 640).status, "warning");
        assert_eq!(calculate(2_000, 640).status, "degraded");
        assert_eq!(calculate(640, 1_920).drift_frames, -1_280);
        assert_eq!(calculate(640, 1_920).drift_ms, -80);
    }
}
