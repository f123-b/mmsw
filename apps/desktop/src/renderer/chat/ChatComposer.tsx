import type { JSX } from "react";

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCreateProject: () => void;
}

export function ChatComposer({ value, onChange, onSubmit, onCreateProject }: ChatComposerProps): JSX.Element {
  return (
    <section className="composer-wrap" aria-label="面试准备输入框">
      <div className="composer-context-row">
        <button className="conversation-select" aria-label="选择会话">独立对话 <span>⌄</span></button>
        <button className="create-project" onClick={onCreateProject}><span>⊞</span> 创建项目</button>
      </div>
      <div className="chat-composer">
        <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onSubmit(); } }} placeholder="向 Interview Copilot 咨询任何面试准备问题..." aria-label="面试准备问题" />
        <div className="composer-toolbar">
          <button className={`send-button ${value.trim() ? "active" : ""}`} onClick={onSubmit} aria-label="发送">↑</button>
        </div>
      </div>
      <div className="composer-hint">Ctrl / ⌘ + Enter 发送</div>
    </section>
  );
}
