use crate::protocol::TARGET_SAMPLE_RATE;

pub struct LinearResampler {
    source_rate: f64,
    channels: usize,
    input: Vec<f32>,
    position: f64,
}

impl LinearResampler {
    pub fn new(source_rate: u32, channels: usize) -> Self {
        assert!(channels > 0);
        Self {
            source_rate: source_rate as f64,
            channels,
            input: Vec::new(),
            position: 0.0,
        }
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<f32> {
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

pub fn mono(samples: Vec<f32>, channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples;
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{mono, LinearResampler};

    fn output_frames(source_rate: u32, frames: usize) -> usize {
        let mut resampler = LinearResampler::new(source_rate, 1);
        let samples = (0..frames)
            .map(|index| (index as f32).sin())
            .collect::<Vec<_>>();
        resampler.push(&samples).len()
    }

    #[test]
    fn resamples_48k_to_16k() {
        assert!((output_frames(48_000, 4_800) as i32 - 1_600).abs() <= 2);
    }

    #[test]
    fn resamples_44k1_to_16k() {
        assert!((output_frames(44_100, 4_410) as i32 - 1_600).abs() <= 2);
    }

    #[test]
    fn keeps_16k_rate() {
        assert_eq!(output_frames(16_000, 1_600), 1_600);
    }

    #[test]
    fn converts_mono_and_stereo() {
        assert_eq!(mono(vec![1.0, 2.0], 1), vec![1.0, 2.0]);
        assert_eq!(mono(vec![1.0, 3.0, 2.0, 4.0], 2), vec![2.0, 3.0]);
    }
}
