import { useEffect, useState, type JSX } from "react";
import "./written-test.css";
import type { WrittenTestState } from "../main/written-test-controller";

export function writtenStatusLabel(status: WrittenTestState["screenshotStatus"]): string {
  return { IDLE: "等待截图", CAPTURING: "正在截图", ANALYZING: "正在识别题目", SOLVING: "正在生成并检查答案", SUCCESS: "已通过格式检查，请核对答案", NEEDS_INPUT: "题目不完整，等待补图", REVIEW: "答案待核对", ERROR: "处理失败，可重新截图" }[status];
}

export function WrittenTestStatus({ state, showCapture = false }: { state: WrittenTestState; showCapture?: boolean }): JSX.Element {
  const [error, setError] = useState("");
  const [focusProtection, setFocusProtection] = useState<boolean>();
  const [savingFocusProtection, setSavingFocusProtection] = useState(false);
  useEffect(() => {
    let disposed = false;
    let updated = false;
    const unsubscribe = window.interviewCopilot.events.onOverlayPreferences((preferences) => {
      updated = true;
      if (!disposed) setFocusProtection(preferences.writtenTest.focusProtection);
    });
    void window.interviewCopilot.overlay.getPreferences().then((preferences) => {
      if (!disposed && !updated) setFocusProtection(preferences.writtenTest.focusProtection);
    }).catch((error) => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const busy = ["CAPTURING", "ANALYZING", "SOLVING"].includes(state.screenshotStatus);
  const run = async (action: () => Promise<unknown>) => { setError(""); try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } };
  const toggleFocusProtection = async () => {
    setSavingFocusProtection(true);
    try {
      const preferences = await window.interviewCopilot.overlay.setPreferences({ writtenTest: { focusProtection: !focusProtection } });
      setFocusProtection(preferences.writtenTest.focusProtection);
    } finally { setSavingFocusProtection(false); }
  };
  return <div className="written-test-status" data-status={state.screenshotStatus} aria-live="polite">
    <p className="written-process-label"><i aria-hidden="true" />{writtenStatusLabel(state.screenshotStatus)}</p>
    <div className="written-focus-protection">
      <button type="button" role="switch" aria-label="焦点屏蔽" aria-checked={focusProtection ?? false} disabled={!state.running || focusProtection === undefined || savingFocusProtection} onClick={() => void run(toggleFocusProtection)} title="笔试期间阻止主窗口抢占焦点，悬浮窗保持不激活">
        焦点屏蔽：{focusProtection === undefined ? "加载中" : focusProtection ? "已开启" : "已关闭"}
      </button>
      <small>{focusProtection ? "保持答题窗口焦点；结束练习后恢复主窗口。" : "开启后，笔试期间主窗口不会抢占焦点。"}</small>
    </div>
    {state.lastError && <p className="written-test-error" role="alert">{state.lastError}</p>}
    <div className="written-screenshot-relation" role="group" aria-label="下一张截图用途">
      <span>下一张截图：</span>
      {([
        ["NEW_QUESTION", "新题", "独立识别下一道题"],
        ["CONTINUATION", "补充本题", "合并原图，最多 4 张"],
        ["REPLACE_SCREENSHOT", "重拍本题", "用新截图替换识别内容"]
      ] as const).map(([relation, label, description]) => <button key={relation} type="button" aria-pressed={(state.nextScreenshotRelation ?? "NEW_QUESTION") === relation} disabled={!state.running || busy || (relation !== "NEW_QUESTION" && !state.currentProblem)} title={description} onClick={() => void run(() => window.interviewCopilot.writtenTest.setNextScreenshotRelation(relation))}>{label}</button>)}
    </div>
    {showCapture && <div className="detail-actions"><button disabled={!state.running || busy} onClick={() => void run(() => window.interviewCopilot.writtenTest.answerScreenshot())}>截图并分析</button><button disabled={!state.running} onClick={() => void run(() => window.interviewCopilot.writtenTest.stop())}>结束练习</button></div>}
    {error && <p className="written-test-error" role="alert">{error}</p>}
  </div>;
}
