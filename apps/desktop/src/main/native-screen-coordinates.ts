export interface NativeScreenPoint {
  x: number;
  y: number;
}

export interface NativeScreenCoordinateOptions {
  screenToDipPoint?: (point: NativeScreenPoint) => NativeScreenPoint;
  scaleFactor?: number;
}

/** Converts Win32/native physical screen coordinates into Electron DIP space. */
export function normalizeNativeScreenPoint(point: NativeScreenPoint, options: NativeScreenCoordinateOptions = {}): NativeScreenPoint {
  if (options.screenToDipPoint) return options.screenToDipPoint(point);
  const scale = Number.isFinite(options.scaleFactor) && (options.scaleFactor ?? 0) > 0 ? options.scaleFactor! : 1;
  return { x: point.x / scale, y: point.y / scale };
}

/** Hit tests a visible content inset, avoiding transparent overlay edges. */
export function isInsideOverlayContent(point: NativeScreenPoint, bounds: { x: number; y: number; width: number; height: number }, inset = 8): boolean {
  return point.x >= bounds.x + inset
    && point.y >= bounds.y + inset
    && point.x <= bounds.x + bounds.width - inset
    && point.y <= bounds.y + bounds.height - inset;
}

