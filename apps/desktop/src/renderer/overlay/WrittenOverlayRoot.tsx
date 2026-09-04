import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { renderDiagramSvg } from "@interview-copilot/shared";
import type { OverlayRootProps } from "./OverlayRoot";
import { WrittenScreenshotButton } from "./WrittenScreenshotButton";
import { WrittenHoverButton } from "./WrittenHoverButton";
import { WRITTEN_EXIT_HOVER_DELAY_MS } from "./written-screenshot-hover";
import { writtenStatusLabel } from "../written-test-status";
import { nativeGestureBounds } from "./native-window-gesture";
import "./written-overlay.css";

/** One native, non-activating window owns both the reader and its controls. */
export function WrittenOverlayRoot(props: OverlayRootProps): JSX.Element {
  const state = props.writtenTest;
  const answer = state.currentAnswer;
  const busy = ["CAPTURING", "ANALYZING", "SOLVING"].includes(state.screenshotStatus);
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [state.currentQuestion?.id, answer]);
  const active = state.running && props.hudState.running && !props.hudState.shareMode && props.hudState.transientLayer === "none";
  const capture = async (relation = state.nextScreenshotRelation ?? "NEW_QUESTION") => {
    setError("");
    await window.interviewCopilot.writtenTest.setNextScreenshotRelation(relation);
    await props.onAnswerScreenshot();
  };
  const gesture = (resize: boolean, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    cleanup.current?.();
    const target = event.currentTarget;
    const start = { x: event.screenX, y: event.screenY };
    const origin = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
    let pending = origin;
    let raf = 0;
    let moved = false;
    const flush = () => { raf = 0; void window.interviewCopilot.overlay.setWindowBounds("question", pending, false); };
    const move = (e: PointerEvent) => { moved = true; pending = nativeGestureBounds(origin, resize ? "se" : "move", e.screenX - start.x, e.screenY - start.y); if (!raf) raf = requestAnimationFrame(flush); };
    const end = () => { if (raf) cancelAnimationFrame(raf); if (moved) void window.interviewCopilot.overlay.setWindowBounds("question", pending, true); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); try { target.releasePointerCapture(event.pointerId); } catch {} cleanup.current = undefined; };
    try { target.setPointerCapture(event.pointerId); } catch {}
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true }); cleanup.current = end;
  };
  return <main className="written-workspace" data-operation-mode="WRITTEN_TEST" data-overlay-surface="question">
    <header className="written-workspace-header" onPointerDown={event => gesture(false, event)}><strong>⠿ 笔试解题</strong><span className="written-workspace-status"><i className={busy ? "busy" : ""} />{writtenStatusLabel(state.screenshotStatus)}</span><span>{String(state.questionCount).padStart(2, "0")} 题</span></header>
    <div className="written-workspace-body overlay-scroll-region" ref={scroll}>
      {state.currentProblem && <p className="written-workspace-question">{state.currentProblem.canonicalQuestion}</p>}
      {(state.lastError || error) && <p className="written-workspace-error" role="alert">{error || state.lastError}</p>}
      {!answer && !state.currentProblem && <div className="written-workspace-empty"><strong>打开题目，截图即可解答</strong><p>将鼠标停在下方「截图解题」上，或按 Ctrl+Alt+S。</p><p>结论、代码和解题过程会直接显示在这里。</p></div>}
      {busy && <p className="written-workspace-progress" role="status">{writtenStatusLabel(state.screenshotStatus)}…</p>}
      {answer && <article className="written-workspace-answer" aria-label="完整笔试答案">
        <p className="written-final-answer">{answer.finalAnswer}</p>
        {answer.code && <section><h3>代码 · {answer.code.language}</h3><pre><code>{answer.code.content}</code></pre></section>}
        {answer.explanation && <p>{answer.explanation}</p>}
        {answer.steps.length > 0 && <section><h3>解题过程</h3><ol>{answer.steps.map((step, i) => <li key={i}><strong>{step.title}</strong><p>{step.content}</p></li>)}</ol></section>}
        {answer.equations.map((equation, i) => <pre key={i}>{equation}</pre>)}
        {answer.diagram && <img className="written-diagram" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderDiagramSvg(answer.diagram))}`} alt={answer.diagram.title ?? "解题图示"} />}
        {answer.table && <div className="written-table-scroll"><table><thead><tr>{answer.table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead><tbody>{answer.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>}
        {answer.complexity && <p>复杂度：{answer.complexity}</p>}
        {answer.warnings.map((warning, i) => <p className="written-workspace-warning" key={i}>{warning}</p>)}
      </article>}
    </div>
    <footer className="written-workspace-footer">
      <WrittenScreenshotButton active={active} busy={busy} retry={state.screenshotStatus === "ERROR"} statusLabel={writtenStatusLabel(state.screenshotStatus)} onScreenshot={() => capture()} />
      <WrittenHoverButton label="新题" active={active} busy={busy} pressed={state.nextScreenshotRelation === "NEW_QUESTION"} onTrigger={() => { setError(""); return window.interviewCopilot.writtenTest.setNextScreenshotRelation("NEW_QUESTION"); }} onError={setError} />
      <WrittenHoverButton label="补图" active={active && Boolean(state.currentProblem)} busy={busy} onTrigger={() => capture("CONTINUATION")} onError={setError} />
      <WrittenHoverButton label="重拍" active={active && Boolean(state.currentProblem)} busy={busy} onTrigger={() => capture("REPLACE_SCREENSHOT")} onError={setError} />
      <WrittenHoverButton label="退出" ariaLabel="退出笔试" active={active} delayMs={WRITTEN_EXIT_HOVER_DELAY_MS} onTrigger={props.onEndInterview} onError={setError} />
    </footer>
    <div className="written-workspace-resize" onPointerDown={event => gesture(true, event)} aria-label="调整笔试窗口大小" />
  </main>;
}
