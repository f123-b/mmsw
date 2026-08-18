use crate::protocol::{BYTES_PER_SAMPLE, FRAMES_PER_PACKET, PCM_PACKET_BYTES, TARGET_CHANNELS};
use std::io::{self, Write};

pub fn interleave_pcm16(mic: &[f32], system: &[f32]) -> Vec<u8> {
    let frames = mic.len().min(system.len()).min(FRAMES_PER_PACKET);
    let mut packet = Vec::with_capacity(frames * TARGET_CHANNELS * BYTES_PER_SAMPLE);
    for index in 0..frames {
        packet.extend_from_slice(
            &((mic[index].clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes(),
        );
        packet.extend_from_slice(
            &((system[index].clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes(),
        );
    }
    packet
}

pub fn write_packet<W: Write>(writer: &mut W, mic: &[f32], system: &[f32]) -> io::Result<usize> {
    let packet = interleave_pcm16(mic, system);
    debug_assert_eq!(packet.len(), PCM_PACKET_BYTES);
    writer.write_all(&packet)?;
    writer.flush()?;
    Ok(packet.len())
}

#[cfg(test)]
mod tests {
    use super::{interleave_pcm16, write_packet};
    use crate::protocol::PCM_PACKET_BYTES;

    #[test]
    fn interleaves_left_mic_and_right_system() {
        let bytes = interleave_pcm16(&[1.0, 2.0], &[3.0, 4.0]);
        assert_eq!(&bytes[0..2], &i16::MAX.to_le_bytes());
        assert_eq!(&bytes[2..4], &i16::MAX.to_le_bytes());
        assert_eq!(&bytes[4..6], &i16::MAX.to_le_bytes());
        assert_eq!(&bytes[6..8], &i16::MAX.to_le_bytes());
    }

    #[test]
    fn writes_2560_bytes_for_a_40ms_packet() {
        let mut output = Vec::new();
        let mic = vec![0.0; 640];
        let system = vec![0.0; 640];
        assert_eq!(
            write_packet(&mut output, &mic, &system).unwrap(),
            PCM_PACKET_BYTES
        );
        assert_eq!(output.len(), 2_560);
    }
}
