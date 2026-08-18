import { AUDIO_PACKET_BYTES } from "@interview-copilot/protocol";

export class PcmPacketAssembler {
  private pendingBuffer = Buffer.alloc(0);

  get pendingBytes(): number {
    return this.pendingBuffer.length;
  }

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.length > 0) {
      this.pendingBuffer = Buffer.concat([this.pendingBuffer, Buffer.from(chunk)]);
    }

    const packets: Buffer[] = [];
    while (this.pendingBuffer.length >= AUDIO_PACKET_BYTES) {
      packets.push(Buffer.from(this.pendingBuffer.subarray(0, AUDIO_PACKET_BYTES)));
      this.pendingBuffer = this.pendingBuffer.subarray(AUDIO_PACKET_BYTES);
    }
    return packets;
  }

  reset(): void {
    this.pendingBuffer = Buffer.alloc(0);
  }
}
