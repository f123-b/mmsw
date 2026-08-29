import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function ConfirmDialogApp() {
  const [open, setOpen] = useState(false);
  useEffect(() => window.interviewCopilot.events.onOverlayDialogState((state) => setOpen(state.endInterviewConfirmOpen)), []);
  if (!open) return null;
  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20, color: "#f8fafc", fontFamily: "system-ui, sans-serif" }}>
    <section role="dialog" aria-modal="true" aria-labelledby="overlay-confirm-title" style={{ width: "100%", boxSizing: "border-box", border: "1px solid rgba(255,255,255,.18)", borderRadius: 16, padding: 24, background: "rgba(20,26,38,.97)", boxShadow: "0 18px 50px rgba(0,0,0,.38)" }}>
      <strong id="overlay-confirm-title" style={{ display: "block", fontSize: 19 }}>结束面试？</strong>
      <p style={{ margin: "12px 0 22px", color: "#b8c1d1", lineHeight: 1.55 }}>结束后将停止录音，并保存本次面试记录。</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button type="button" data-testid="confirm-cancel" onClick={() => void window.interviewCopilot.overlay.cancelEndInterview()} style={{ minWidth: 84, border: "1px solid #58657b", borderRadius: 9, padding: "9px 14px", background: "transparent", color: "#e6ebf4", cursor: "pointer" }}>取消</button>
        <button type="button" data-testid="confirm-end" onClick={() => void window.interviewCopilot.overlay.confirmEndInterview()} style={{ minWidth: 84, border: 0, borderRadius: 9, padding: "9px 14px", background: "#e66a5c", color: "#fff", cursor: "pointer" }}>结束</button>
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
