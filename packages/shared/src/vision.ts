export interface ScreenshotImage {
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width?: number;
  height?: number;
}
export interface VisionInput {
  prompt: string;
  image: {
    mimeType: ScreenshotImage["mimeType"];
    base64: string;
    bytes: number;
    width?: number;
    height?: number;
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function encodeBase64(bytes: Uint8Array): string {
  const globalValue = globalThis as typeof globalThis & {
    Buffer?: { from(value: Uint8Array): { toString(encoding: "base64"): string } };
  };
  if (globalValue.Buffer) return globalValue.Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  if (typeof btoa !== "function") throw new Error("VISION_BASE64_UNAVAILABLE");
  return btoa(binary);
}

export function buildVisionInput(image: ScreenshotImage, prompt: string, maxBytes = 8 * 1024 * 1024): VisionInput {
  if (!prompt.trim()) throw new Error("VISION_PROMPT_EMPTY");
  if (!image || image.bytes.byteLength === 0) throw new Error("EMPTY_IMAGE");
  if (image.bytes.byteLength > maxBytes) throw new Error("IMAGE_TOO_LARGE");
  if (image.mimeType === "image/png" && !hasPrefix(image.bytes, PNG_SIGNATURE)) throw new Error("INVALID_PNG");
  if (image.mimeType === "image/jpeg" && !hasPrefix(image.bytes, JPEG_SIGNATURE)) throw new Error("INVALID_JPEG");
  return {
    prompt: prompt.trim(),
    image: {
      mimeType: image.mimeType,
      base64: encodeBase64(image.bytes),
      bytes: image.bytes.byteLength,
      width: image.width,
      height: image.height
    }
  };
}
