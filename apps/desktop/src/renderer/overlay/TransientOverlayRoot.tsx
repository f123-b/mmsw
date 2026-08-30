import type { JSX } from "react";
import type { OverlayRootProps } from "./OverlayRoot";

function ShortcutMenu({ props }: { props: OverlayRootProps }): JSX.Element {
  const endLabel = props.operationMode === "WRITTEN_TEST" ? "结束笔试" : "结束面试";
  return <section className="transient-card shortcut-card" role="dialog" aria-label="快捷操作" data-testid="shortcut-menu">
    <header className="transient-header"><strong>快捷操作</strong><button type="button" onClick={props.onToggleShortcuts} aria-label="关闭快捷操作">×</button></header>
    <div className="shortcut-actions">
      {props.operationMode !== "WRITTEN_TEST" && <button type="button" onClick={() => void props.onAnswerLatest()}><span>回答最新问题</span><kbd>Ctrl + Alt + A</kbd></button>}
      <button type="button" onClick={() => void props.onAnswerScreenshot()}><span>截图识别并回答</span><kbd>Ctrl + Alt + S</kbd></button>
      <button type="button" onClick={props.onHideAll}><span>隐藏悬浮窗</span><kbd>Ctrl + Alt + D</kbd></button>
      <button type="button" onClick={props.onToggleMode}><span>交互 / 穿透</span><kbd>Ctrl + Alt + P</kbd></button>
      <button type="button" className="shortcut-danger" onClick={props.onRequestEndInterview}><span>{endLabel}</span><kbd>Ctrl + Alt + Q</kbd></button>
    </div>
  </section>;
}

function EndConfirm({ props }: { props: OverlayRootProps }): JSX.Element {
  const endLabel = props.operationMode === "WRITTEN_TEST" ? "结束笔试" : "结束面试";
  return <section className="transient-card confirm-card" role="dialog" aria-modal="false" aria-labelledby="overlay-confirm-title" data-testid="end-confirm">
    <strong id="overlay-confirm-title">{endLabel}？</strong>
    <p>结束后本次记录会保存到面试历史。</p>
    <div className="transient-actions">
      <button type="button" data-testid="confirm-cancel" onClick={() => void window.interviewCopilot.overlay.cancelEndInterview()}>取消</button>
      <button type="button" className="confirm-danger" data-testid="confirm-end" onClick={() => void window.interviewCopilot.overlay.confirmEndInterview()}>结束</button>
    </div>
  </section>;
}

export function TransientOverlayRoot(props: OverlayRootProps): JSX.Element {
  const layer = props.hudState.transientLayer;
  return <main className="overlay-root transient-overlay-root" data-overlay-surface="transient" data-transient-layer={layer}>
    {layer === "shortcut" && <ShortcutMenu props={props} />}
    {layer === "end_confirm" && <EndConfirm props={props} />}
  </main>;
}
