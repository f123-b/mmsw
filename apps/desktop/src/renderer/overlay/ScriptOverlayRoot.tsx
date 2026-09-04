import { useEffect, useRef, useState, type JSX, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { SpeechScript } from "../../main/speech-script";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../../shared/overlay-preferences";
import { overlayWindowStyle, type OverlayRootProps } from "./OverlayRoot";
import { nativeGestureBounds, type NativeGesture } from "./native-window-gesture";

function useScriptScrollPosition(ref: RefObject<HTMLDivElement | null>, contentKey: string): { atStart: boolean; onScroll: () => void; rewind: () => void } {
  const [atStart, setAtStart] = useState(true);
  const lastContentKey = useRef(contentKey);
  useEffect(() => {
    if (lastContentKey.current !== contentKey) {
      lastContentKey.current = contentKey;
      if (ref.current) ref.current.scrollTop = 0;
      setAtStart(true);
    }
  }, [contentKey, ref]);
  const onScroll = () => {
    const element = ref.current;
    if (!element) return;
    setAtStart(element.scrollTop < 18);
  };
  const rewind = () => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: 0, behavior: "smooth" });
    setAtStart(true);
  };
  return { atStart, onScroll, rewind };
}

export function ScriptOverlayRoot(props: OverlayRootProps): JSX.Element {
  const [preferences, setPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [script, setScript] = useState<SpeechScript | undefined>(props.speechScript);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const [speed, setSpeed] = useState(30);
  const gestureCleanup = useRef<(() => void) | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let observedScript = false;
    void window.interviewCopilot.overlay.getPreferences().then((next) => { if (!disposed && next) setPreferences(next); }).catch(() => undefined);
    void window.interviewCopilot.speechScript.get().then((next) => { if (!disposed && !observedScript) setScript(next); }).catch(() => undefined);
    const unsubscribePreferences = window.interviewCopilot.events.onOverlayPreferences((next) => { if (!disposed) setPreferences(next); });
    const unsubscribeScript = window.interviewCopilot.events.onSpeechScript((next) => { observedScript = true; if (!disposed) setScript(next); });
    const unsubscribeLayout = window.interviewCopilot.events.onOverlayLayoutEditMode(setLayoutEditMode);
    return () => { disposed = true; gestureCleanup.current?.(); unsubscribePreferences(); unsubscribeScript(); unsubscribeLayout(); };
  }, []);
  useEffect(() => { if (props.speechScript) setScript(props.speechScript); }, [props.speechScript]);
  const visible = Boolean(script && (layoutEditMode || props.hudState.running && props.hudState.scriptVisible) && !props.hudState.shareMode);
  useEffect(() => { setAutoScroll(false); }, [script?.updatedAt, visible]);
  useEffect(() => {
    if (!visible || !autoScroll) return;
    let previous = performance.now();
    let fraction = 0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const element = scrollRef.current;
      fraction += Math.min(100, now - previous) * speed / 1_000;
      previous = now;
      if (!element) return;
      const step = Math.floor(fraction);
      fraction -= step;
      element.scrollTop += step;
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - 1) setAutoScroll(false);
    }, 32);
    return () => window.clearInterval(timer);
  }, [autoScroll, speed, visible]);
  const beginGesture = (gesture: NativeGesture, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || gesture === "move" && (event.target as HTMLElement).closest("button, select")) return;
    event.preventDefault(); event.stopPropagation();
    gestureCleanup.current?.();
    const target = event.currentTarget;
    const start = { x: event.screenX, y: event.screenY };
    const origin = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
    let pending = origin;
    let timer: number | undefined;
    const commit = () => { timer = undefined; void window.interviewCopilot.overlay.setWindowBounds("script", pending); };
    const move = (next: PointerEvent) => { pending = nativeGestureBounds(origin, gesture, next.screenX - start.x, next.screenY - start.y); if (timer === undefined) timer = window.setTimeout(commit, 32); };
    const end = () => { if (timer !== undefined) { window.clearTimeout(timer); commit(); } window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); try { target.releasePointerCapture(event.pointerId); } catch { /* pointer may have left */ } gestureCleanup.current = undefined; };
    try { target.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true }); window.addEventListener("blur", end, { once: true });
    gestureCleanup.current = end;
  };
  const changeFont = (delta: number) => { void window.interviewCopilot.overlay.setPreferences({ interview: { scriptWindow: { fontSize: Math.max(12, Math.min(32, preferences.interview.scriptWindow.fontSize + delta)) } } }); };
  const scrollPosition = useScriptScrollPosition(scrollRef, `${script?.updatedAt ?? 0}:${script?.text.length ?? 0}`);
  const protectionEnabled = props.captureProtectionEnabled ?? true;
  return <main className="overlay-root script-overlay-root" data-overlay-surface="script" data-layout-edit-mode={layoutEditMode ? "on" : "off"} data-hud-mode={props.hudState.mode} data-share-mode={props.hudState.shareMode ? "on" : "off"} data-overlay-mode={props.overlayMode} data-appearance-mode={preferences.appearance.mode} data-operation-mode={props.operationMode}>
    {visible && script && <div className="native-content-window native-window-shell script-panel" style={overlayWindowStyle(preferences.interview.scriptWindow, preferences.appearance)}>
      <section className="overlay-panel-card script-overlay-content" data-overlay-content="script" aria-label="演讲稿悬浮窗">
        <header className="script-overlay-header" onPointerDown={(event) => beginGesture("move", event)} title="拖动标题栏移动窗口"><strong>⠿ 演讲稿</strong><span title={script.filename}>{script.filename}</span><button onClick={props.onToggleScript} aria-label="隐藏演讲稿">−</button></header>
        <div ref={scrollRef} className="overlay-scroll-region script-overlay-scroll" onWheel={() => setAutoScroll(false)} onScroll={scrollPosition.onScroll} tabIndex={0}>
          <pre className="script-overlay-text">{script.text}</pre>
        </div>
        <footer className="script-reading-controls"><button onClick={() => setAutoScroll(value => !value)} aria-pressed={autoScroll}>{autoScroll ? "暂停" : "自动滚动"}</button><select aria-label="滚动速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={15}>慢速</option><option value={30}>中速</option><option value={50}>快速</option></select><button aria-label="缩小字号" onClick={() => changeFont(-1)}>A−</button><button aria-label="放大字号" onClick={() => changeFont(1)}>A+</button><button onClick={() => { setAutoScroll(false); scrollPosition.rewind(); }} disabled={scrollPosition.atStart}>回到开头</button></footer>
        {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map(handle => <div key={handle} className={`script-resize-handle script-resize-${handle}`} role="separator" aria-label={`调整演讲稿窗口大小 ${handle}`} onPointerDown={event => beginGesture(handle, event)} />)}
        <span className="script-resize-corner" aria-hidden="true">◢</span>
      </section>
    </div>}
    {visible && <div className={`hud-protection-indicator ${protectionEnabled ? "requested" : "off"}`} aria-hidden="true">{protectionEnabled ? "◈" : "·"}</div>}
  </main>;
}
