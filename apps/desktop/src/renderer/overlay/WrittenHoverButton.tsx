import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { WRITTEN_SCREENSHOT_HOVER_DELAY_MS, WrittenScreenshotHoverTrigger, type WrittenScreenshotHoverPhase } from "./written-screenshot-hover";

interface WrittenHoverButtonProps {
  label: string;
  ariaLabel?: string;
  active: boolean;
  busy?: boolean;
  delayMs?: number;
  pressed?: boolean;
  className?: string;
  icon?: ReactNode;
  onTrigger: () => Promise<unknown>;
  onError?: (message: string) => void;
}

/** Hover-only controls never take focus or require a click. */
export function WrittenHoverButton({ label, ariaLabel = label, active, busy = false, delayMs = WRITTEN_SCREENSHOT_HOVER_DELAY_MS, pressed, className = "", icon, onTrigger, onError }: WrittenHoverButtonProps): JSX.Element {
  const [phase, setPhase] = useState<WrittenScreenshotHoverPhase>("idle");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const hoverRef = useRef<WrittenScreenshotHoverTrigger | undefined>(undefined);
  const inFlightRef = useRef(false);
  const enabled = active && !busy && !pending;
  // Frequent runtime updates must not restart an in-progress dwell.
  const latest = useRef({ available: active && !busy, onTrigger, onError });
  latest.current = { available: active && !busy, onTrigger, onError };

  useLayoutEffect(() => {
    let disposed = false;
    const hover = new WrittenScreenshotHoverTrigger(() => {
      hover.setEnabled(false);
      inFlightRef.current = true;
      setPending(true);
      setError("");
      void (async () => {
        try { await latest.current.onTrigger(); }
        catch (cause) {
          if (!disposed) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            latest.current.onError?.(message);
          }
        } finally {
          if (!disposed) {
            inFlightRef.current = false;
            hover.setEnabled(latest.current.available && !document.hidden);
            setPending(false);
          }
        }
      })();
    }, setPhase, delayMs);
    hoverRef.current = hover;
    const syncVisibility = () => hover.setEnabled(latest.current.available && !inFlightRef.current && !document.hidden);
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      disposed = true;
      hover.dispose();
      hoverRef.current = undefined;
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [delayMs]);

  useLayoutEffect(() => { hoverRef.current?.setEnabled(enabled && !document.hidden); }, [enabled]);
  const dwellLabel = `悬停 ${delayMs / 1000} 秒`;
  const hint = busy || pending ? "处理中…" : error ? "移开后重试" : phase === "arming" ? "保持悬停…" : phase === "triggered" ? "已触发，请移开" : dwellLabel;
  return <button className={`written-hover-control hud-interactive-region ${className}`} type="button" tabIndex={-1}
    aria-disabled={!enabled} aria-busy={busy || pending} aria-pressed={pressed} aria-label={ariaLabel}
    aria-description={error ? `操作失败：${error}。移开后重新悬停重试。` : `${dwellLabel}触发，移开取消。`}
    data-hover-phase={phase} data-hover-delay-ms={delayMs}
    onPointerEnter={event => { if (event.pointerType === "mouse" && event.buttons === 0) hoverRef.current?.enter(); }}
    onPointerLeave={() => hoverRef.current?.leave()} onPointerCancel={() => hoverRef.current?.leave()}
    onPointerDown={event => event.preventDefault()} onClick={event => event.preventDefault()}>
    {icon}
    <span className="written-capture-copy" aria-hidden="true"><strong>{busy || pending ? "处理中" : label}</strong><small>{hint}</small></span>
    {phase === "arming" && <span className="written-camera-progress" style={{ animationDuration: `${delayMs}ms` }} aria-hidden="true" />}
  </button>;
}
