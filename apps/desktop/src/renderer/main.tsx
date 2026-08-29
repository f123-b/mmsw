import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import "./overlay-simplified.css";

function FatalStartupError() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "48px", background: "#0b1020", color: "#f4f7ff", fontFamily: "system-ui, sans-serif" }}>
      <section style={{ maxWidth: "560px", border: "1px solid #394463", borderRadius: "16px", padding: "32px", background: "#151d33", boxShadow: "0 18px 60px #0006" }}>
        <p style={{ margin: "0 0 12px", color: "#ff9f9f", fontSize: "12px", letterSpacing: "0.14em" }}>STARTUP ERROR</p>
        <h1 style={{ margin: "0 0 16px", fontSize: "28px" }}>Interview Copilot 启动失败</h1>
        <p style={{ margin: "0 0 12px", color: "#c6cee2" }}>Preload Bridge 未成功加载。</p>
        <p style={{ margin: "0 0 20px", color: "#ffcf8a", fontFamily: "ui-monospace, monospace" }}>错误代码：PRELOAD_BRIDGE_UNAVAILABLE</p>
        <p style={{ margin: 0, color: "#aeb8d0" }}>请重新安装或查看日志。</p>
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");
const isOverlayWindow = new URLSearchParams(window.location.search).get("window") === "overlay";
if (isOverlayWindow) {
  document.documentElement.classList.add("overlay-window");
  document.body.classList.add("overlay-window");
}
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(window.interviewCopilot ? (
    <StrictMode>
      <RootErrorBoundary><App /></RootErrorBoundary>
    </StrictMode>
  ) : <FatalStartupError />);
  document.documentElement.dataset.appReady = "true";
  if (window.interviewCopilot) window.interviewCopilot.diagnostics.markRendererReady();
} else {
  document.body.textContent = "Interview Copilot 启动失败：根节点不存在。";
}
