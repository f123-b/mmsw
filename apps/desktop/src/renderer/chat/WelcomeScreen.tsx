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
      <span className="welcome-kicker">PERSONAL INTERVIEW AGENT</span>
      <h1>把准备，变成面试底气</h1>
      <h2>先准备，再上场。</h2>
      <p>整理简历、JD 和项目经历，面试时实时听题、理解追问，<br />生成一眼能读懂、也能自然说出口的回答。</p>
      <div className="quick-actions">
        <button className="quick-primary" onClick={onPrepare}>开始准备 <span>↗</span></button>
        <button onClick={onPolish}>整理项目经历</button>
        <button onClick={onLanguage}>设置语言</button>
        <button className="refresh-button" onClick={onRefresh} aria-label="刷新欢迎页">↻</button>
      </div>
      <div className="welcome-feature-grid" aria-label="核心能力">
        <article><span>01</span><strong>面试档案</strong><p>简历、JD、技能卡统一管理</p></article>
        <article><span>02</span><strong>实时应答</strong><p>听题、识别意图、跟进追问</p></article>
        <article><span>03</span><strong>截图解题</strong><p>笔试和案例题一键拆解</p></article>
      </div>
    </section>
  );
}
