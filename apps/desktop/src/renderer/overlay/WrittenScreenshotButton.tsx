import type { JSX } from "react";
import { WrittenHoverButton } from "./WrittenHoverButton";

interface WrittenScreenshotButtonProps {
  active: boolean;
  busy: boolean;
  retry: boolean;
  statusLabel: string;
  onScreenshot: () => Promise<void>;
}

export function WrittenScreenshotButton({ active, busy, retry, onScreenshot }: WrittenScreenshotButtonProps): JSX.Element {
  return <WrittenHoverButton label={retry ? "重新截图" : "截图解题"} ariaLabel="截图解题" active={active} busy={busy}
    className="written-camera-control" onTrigger={onScreenshot}
    icon={<svg className="written-capture-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/><rect x="7" y="8" width="10" height="8" rx="2"/><circle cx="12" cy="12" r="2"/></svg>} />;
}
