import { describe, expect, it } from "vitest";
import { AUDIO_PACKET_BYTES } from "@interview-copilot/protocol";
import { PcmPacketAssembler } from "./pcm-packet-assembler";

function bytes(length: number, value = 1): Buffer {
  return Buffer.alloc(length, value);
}

describe("PcmPacketAssembler", () => {
  it("assembles 1000 + 1560 bytes into one exact packet", () => {
    const assembler = new PcmPacketAssembler();
    expect(assembler.push(bytes(1_000))).toHaveLength(0);
    const packets = assembler.push(bytes(1_560));
    expect(packets).toHaveLength(1);
    expect(packets[0]).toHaveLength(AUDIO_PACKET_BYTES);
  });

  it("splits a 5120-byte chunk into two packets", () => {
    const packets = new PcmPacketAssembler().push(bytes(5_120));
    expect(packets).toHaveLength(2);
    expect(packets.every((packet) => packet.length === AUDIO_PACKET_BYTES)).toBe(true);
  });

  it("keeps partial bytes for the next stdout chunk", () => {
    const assembler = new PcmPacketAssembler();
    const first = assembler.push(bytes(3_000));
    expect(first).toHaveLength(1);
    expect(assembler.pendingBytes).toBe(440);
    const second = assembler.push(bytes(2_120));
    expect(second).toHaveLength(1);
    expect(second[0]).toHaveLength(AUDIO_PACKET_BYTES);
    expect(assembler.pendingBytes).toBe(0);
  });
});
