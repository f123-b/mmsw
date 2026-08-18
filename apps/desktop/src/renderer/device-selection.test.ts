import { describe, expect, it } from "vitest";
import { selectDeviceId } from "./device-selection";

const devices = [
  { id: "first", name: "First", kind: "microphone", default: false },
  { id: "default", name: "Default", kind: "microphone", default: true }
] as const;

describe("selectDeviceId", () => {
  it("keeps a saved device when it is still present", () => {
    expect(selectDeviceId(devices, "first")).toBe("first");
  });

  it("falls back to the default device when the saved device disappeared", () => {
    expect(selectDeviceId(devices, "missing")).toBe("default");
  });

  it("falls back to the first device when no default exists", () => {
    expect(selectDeviceId([{ ...devices[0], default: false }], "missing")).toBe("first");
    expect(selectDeviceId([], "missing")).toBe("");
  });
});
