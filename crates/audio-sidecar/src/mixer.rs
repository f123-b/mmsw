use crate::protocol::MAX_BUFFER_FRAMES;
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
    channels: usize,
}

impl AudioBuffer {
    pub fn new(channels: usize) -> Self {
        assert!(channels > 0);
        Self {
            chunks: VecDeque::new(),
            queued_samples: 0,
            dropped_samples: 0,
            channels,
        }
    }

    pub fn push(&mut self, samples: Vec<f32>) {
        self.queued_samples += samples.len();
        self.chunks.push_back(samples);
        let max_samples = MAX_BUFFER_FRAMES * self.channels;
        while self.queued_samples > max_samples {
            if let Some(oldest) = self.chunks.pop_front() {
                self.queued_samples -= oldest.len();
                self.dropped_samples += (oldest.len() / self.channels) as u64;
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
            buffer_duration_ms: (queued_frames as u64 * 1_000) / 16_000,
        }
    }
}

pub type SharedAudioBuffer = Arc<Mutex<AudioBuffer>>;

pub fn new_shared_buffer(channels: usize) -> SharedAudioBuffer {
    Arc::new(Mutex::new(AudioBuffer::new(channels)))
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
    use crate::protocol::MAX_BUFFER_FRAMES;

    #[test]
    fn drops_oldest_data_after_three_seconds() {
        let mut buffer = AudioBuffer::new(1);
        buffer.push(vec![1.0; MAX_BUFFER_FRAMES]);
        buffer.push(vec![2.0; 1]);
        let stats = buffer.stats();
        assert_eq!(stats.queued_frames, MAX_BUFFER_FRAMES);
        assert_eq!(stats.dropped_frames, 1);
        assert_eq!(buffer.drain()[0], 2.0);
    }
}
