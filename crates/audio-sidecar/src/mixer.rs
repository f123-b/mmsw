use crate::protocol::MAX_BUFFER_DURATION_SECONDS;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BufferStats {
    pub queued_frames: usize,
    pub dropped_frames: u64,
    pub buffer_duration_ms: u64,
}

pub struct AudioBuffer {
    chunks: VecDeque<Vec<f32>>,
    queued_samples: usize,
    dropped_samples: u64,
    sample_rate: u32,
    channels: usize,
}

impl AudioBuffer {
    pub fn new(sample_rate: u32, channels: usize) -> Self {
        assert!(sample_rate > 0);
        assert!(channels > 0);
        Self {
            chunks: VecDeque::new(),
            queued_samples: 0,
            dropped_samples: 0,
            sample_rate,
            channels,
        }
    }

    pub fn push(&mut self, samples: Vec<f32>) {
        self.queued_samples += samples.len();
        self.chunks.push_back(samples);
        let max_samples =
            self.sample_rate as usize * MAX_BUFFER_DURATION_SECONDS as usize * self.channels;
        let mut overflow_samples = self.queued_samples.saturating_sub(max_samples);
        while overflow_samples > 0 {
            if let Some(mut oldest) = self.chunks.pop_front() {
                if oldest.len() <= overflow_samples {
                    overflow_samples -= oldest.len();
                    self.queued_samples -= oldest.len();
                    self.dropped_samples += (oldest.len() / self.channels) as u64;
                } else {
                    oldest.drain(..overflow_samples);
                    self.dropped_samples += (overflow_samples / self.channels) as u64;
                    self.queued_samples -= overflow_samples;
                    self.chunks.push_front(oldest);
                    overflow_samples = 0;
                }
            }
        }
    }

    pub fn drain(&mut self) -> Vec<f32> {
        let mut output = Vec::with_capacity(self.queued_samples);
        while let Some(chunk) = self.chunks.pop_front() {
            output.extend(chunk);
        }
        self.queued_samples = 0;
        output
    }

    pub fn stats(&self) -> BufferStats {
        let queued_frames = self.queued_samples / self.channels;
        BufferStats {
            queued_frames,
            dropped_frames: self.dropped_samples,
            buffer_duration_ms: (queued_frames as u64 * 1_000) / self.sample_rate as u64,
        }
    }
}

pub type SharedAudioBuffer = Arc<Mutex<AudioBuffer>>;

pub fn new_shared_buffer(sample_rate: u32, channels: usize) -> SharedAudioBuffer {
    Arc::new(Mutex::new(AudioBuffer::new(sample_rate, channels)))
}

pub fn drain_shared(buffer: &SharedAudioBuffer) -> Vec<f32> {
    buffer.lock().expect("audio buffer poisoned").drain()
}

pub fn stats_shared(buffer: &SharedAudioBuffer) -> BufferStats {
    buffer.lock().expect("audio buffer poisoned").stats()
}

#[cfg(test)]
mod tests {
    use super::AudioBuffer;

    fn assert_three_seconds(sample_rate: u32) {
        let max_frames = sample_rate as usize * 3;
        let mut buffer = AudioBuffer::new(sample_rate, 1);
        buffer.push(vec![1.0; max_frames]);
        let stats = buffer.stats();
        assert_eq!(stats.queued_frames, max_frames);
        assert_eq!(stats.dropped_frames, 0);
        assert_eq!(stats.buffer_duration_ms, 3_000);
    }

    #[test]
    fn keeps_three_seconds_at_16k() {
        assert_three_seconds(16_000);
    }

    #[test]
    fn keeps_three_seconds_at_44k1() {
        assert_three_seconds(44_100);
    }

    #[test]
    fn keeps_three_seconds_at_48k() {
        assert_three_seconds(48_000);
    }

    #[test]
    fn drops_oldest_data_after_three_seconds() {
        let mut buffer = AudioBuffer::new(48_000, 1);
        buffer.push(vec![1.0; 144_000]);
        buffer.push(vec![2.0; 1]);
        let stats = buffer.stats();
        assert_eq!(stats.queued_frames, 144_000);
        assert_eq!(stats.dropped_frames, 1);
        let drained = buffer.drain();
        assert_eq!(drained[0], 1.0);
        assert_eq!(drained[drained.len() - 1], 2.0);
    }

    #[test]
    fn drops_only_oldest_frames_when_chunk_crosses_limit() {
        let mut buffer = AudioBuffer::new(44_100, 1);
        buffer.push(vec![1.0; 132_300]);
        buffer.push(vec![2.0; 100]);
        let stats = buffer.stats();
        assert_eq!(stats.queued_frames, 132_300);
        assert_eq!(stats.dropped_frames, 100);
        let drained = buffer.drain();
        assert_eq!(drained[0], 1.0);
        assert_eq!(drained[drained.len() - 1], 2.0);
    }
}
