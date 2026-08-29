import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./overlay/overlay-confirm.css";

function ConfirmDialogApp() {
  const [open, setOpen] = useState(false);
  useEffect(() => window.interviewCopilot.events.onOverlayDialogState((state) => setOpen(state.endInterviewConfirmOpen)), []);
  if (!open) return null;
  return <main className="overlay-confirm-root">
    <section className="overlay-confirm-card" role="dialog" aria-modal="true" aria-labelledby="overlay-confirm-title">
      <strong id="overlay-confirm-title">结束面试？</strong>
      <p>结束后将停止录音，并保存本次面试记录。</p>
      <div className="overlay-confirm-actions">
        <button type="button" data-testid="confirm-cancel" onClick={() => void window.interviewCopilot.overlay.cancelEndInterview()}>取消</button>
        <button type="button" data-testid="confirm-end" onClick={() => void window.interviewCopilot.overlay.confirmEndInterview()}>结束</button>
      </div>
    </section>
  </main>;
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<StrictMode><ConfirmDialogApp /></StrictMode>);
  document.documentElement.dataset.appReady = "true";
  window.interviewCopilot.diagnostics.markRendererReady();
}
