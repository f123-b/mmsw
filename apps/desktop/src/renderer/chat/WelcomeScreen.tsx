import type { JSX } from "react";

interface WelcomeScreenProps {
  onPrepare: () => void;
  onPolish: () => void;
  onLanguage: () => void;
  onRefresh: () => void;
}

function WaveLogo(): JSX.Element {
  return <span className="welcome-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span>;
}

export function WelcomeScreen({ onPrepare, onPolish, onLanguage, onRefresh }: WelcomeScreenProps): JSX.Element {
  return (
    <section className="welcome-screen" aria-label="欢迎页">
      <WaveLogo />
      <h1>Interview Copilot</h1>
      <h2>面试，从准备开始</h2>
      <p>你好，我是 Interview Copilot，你的专属线上面试 AI 助手。开始前，我会先和你一起补齐关键信息，<br />整理个人项目细节和回答策略，让实时辅助更贴合你的背景和目标。</p>
      <div className="quick-actions">
        <button onClick={onPrepare}>快速开始面试准备</button>
        <button onClick={onPolish}>润色简历项目描述</button>
        <button onClick={onLanguage}>选择面试语言</button>
        <button className="refresh-button" onClick={onRefresh} aria-label="刷新欢迎页">↻</button>
      </div>
    </section>
  );
}
