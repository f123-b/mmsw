export interface MainWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_MAIN_WINDOW_BOUNDS: MainWindowBounds = { x: 0, y: 0, width: 1200, height: 780 };
export const MAIN_WINDOW_MIN_SIZE = { width: 920, height: 620 };

export function clampMainWindowBounds(bounds: MainWindowBounds, workArea: MainWindowBounds, minSize = MAIN_WINDOW_MIN_SIZE): MainWindowBounds {
  const width = Math.max(minSize.width, Math.min(bounds.width, workArea.width));
  const height = Math.max(minSize.height, Math.min(bounds.height, workArea.height));
  const visible = 80;
  const minX = workArea.x - width + visible;
  const maxX = workArea.x + workArea.width - visible;
  const minY = workArea.y - height + visible;
  const maxY = workArea.y + workArea.height - visible;
  return { x: Math.round(Math.max(minX, Math.min(bounds.x, maxX))), y: Math.round(Math.max(minY, Math.min(bounds.y, maxY))), width: Math.round(width), height: Math.round(height) };
}

export function resolveMainWindowBounds(saved: Partial<MainWindowBounds> | undefined, workArea: MainWindowBounds): MainWindowBounds {
  return clampMainWindowBounds({ ...DEFAULT_MAIN_WINDOW_BOUNDS, ...saved }, workArea);
}

