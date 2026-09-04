import type { OverlayLayoutBounds } from "../../shared/overlay-layout";

export type NativeGesture = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export function nativeGestureBounds(origin: OverlayLayoutBounds, gesture: NativeGesture, dx: number, dy: number, minimum = { width: 280, height: 180 }): OverlayLayoutBounds {
  if (gesture === "move") return { ...origin, x: origin.x + dx, y: origin.y + dy };
  const width = Math.max(minimum.width, origin.width + (gesture.includes("w") ? -dx : gesture.includes("e") ? dx : 0));
  const height = Math.max(minimum.height, origin.height + (gesture.includes("n") ? -dy : gesture.includes("s") ? dy : 0));
  return { x: gesture.includes("w") ? origin.x + origin.width - width : origin.x, y: gesture.includes("n") ? origin.y + origin.height - height : origin.y, width, height };
}
