import { describe, expect, it } from "vitest";
import { buildVisionInput } from "./vision";

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00
]);

describe("buildVisionInput", () => {
  it("normalizes a real PNG byte sequence into provider-neutral vision input", () => {
    const input = buildVisionInput({ mimeType: "image/png", bytes: png, width: 1, height: 1 }, "  分析截图  ");
    expect(input).toMatchObject({ prompt: "分析截图", image: { mimeType: "image/png", bytes: png.byteLength, width: 1, height: 1 } });
    expect(input.image.base64).toBe("iVBORw0KGgoAAAAA");
  });

  it("rejects empty, malformed and oversized images", () => {
    expect(() => buildVisionInput({ mimeType: "image/png", bytes: new Uint8Array() }, "分析截图")).toThrow("EMPTY_IMAGE");
    expect(() => buildVisionInput({ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }, "分析截图")).toThrow("INVALID_PNG");
    expect(() => buildVisionInput({ mimeType: "image/png", bytes: png }, "分析截图", 4)).toThrow("IMAGE_TOO_LARGE");
  });
});
