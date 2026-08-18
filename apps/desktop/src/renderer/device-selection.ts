import type { AudioDevice } from "@interview-copilot/protocol";

export function selectDeviceId(devices: readonly AudioDevice[], savedId?: string): string {
  if (savedId && devices.some((device) => device.id === savedId)) return savedId;
  return devices.find((device) => device.default)?.id ?? devices[0]?.id ?? "";
}
