import type { JSX } from "react";
import { ArrowRight, BookOpen, FolderOpen, Layers3, ShieldCheck, Sparkles, Waves } from "lucide-react";
import youzhaoIcon from "../assets/youzhao-icon.png";

interface WelcomeScreenProps {
  onPrepare: () => void;
  onPolish: () => void;
  onLanguage: () => void;
  onRefresh: () => void;
}

export function WelcomeScreen({ onPrepare, onPolish, onLanguage, onRefresh }: WelcomeScreenProps): JSX.Element {
  return (
    <section className="welcome-screen" aria-label="欢迎页">
      <div className="welcome-hero-glass">
        <div className="welcome-hero-copy">
          <span className="welcome-kicker">有招 · AI 面试智能体</span>
          <h1>把准备，变成<br /><em>面试底气</em></h1>
          <h2>先准备，再上场。</h2>
          <p>整理简历、JD 和项目经历，面试时实时听题、理解追问，<br />生成一眼能读懂、也能自然说出口的回答。</p>
          <div className="quick-actions">
            <button className="quick-primary" onClick={onPrepare}>开始准备 <ArrowRight size={17} /></button>
            <button onClick={onPolish}>整理项目经历</button>
            <button onClick={onLanguage}>设置语言</button>
          </div>
        </div>
        <div className="welcome-hero-art" aria-hidden="true">
          <span className="hero-float-tag hero-float-one"><Waves size={16} /> 实时理解</span>
          <span className="hero-float-tag hero-float-two"><Sparkles size={16} /> 智能生成</span>
          <span className="hero-float-tag hero-float-three">更从容的表达</span>
          <div className="hero-icon-stack"><i /><i /><img src={youzhaoIcon} alt="" /></div>
        </div>
      </div>
      <div className="welcome-feature-grid" aria-label="核心能力">
        <article><div className="feature-card-head"><span className="feature-icon blue"><FolderOpen /></span><ArrowRight /></div><strong>档案 · 嵌入式软件</strong><p>管理你的简历与资料</p><footer><BookOpen /><span><b>3 份简历</b><small>最近编辑 2 天前</small></span></footer></article>
        <article><div className="feature-card-head"><span className="feature-icon purple"><Layers3 /></span><ArrowRight /></div><strong>项目 · 自动</strong><p>整理项目经历与亮点</p><footer><Layers3 /><span><b>5 个项目</b><small>持续优化中</small></span></footer></article>
        <article><div className="feature-card-head"><span className="feature-icon green"><BookOpen /></span><ArrowRight /></div><strong>知识 · 自动检索</strong><p>快速获取面试知识点</p><footer><Sparkles /><span><b>1,200+ 条</b><small>覆盖常见技术面试题</small></span></footer></article>
        <article><div className="feature-card-head"><span className="feature-icon orange"><ShieldCheck /></span><ArrowRight /></div><strong>事实策略 · 仅已确认</strong><p>保证回答的准确性</p><footer><ShieldCheck /><span><b>98% 准确率</b><small>基于你的资料生成</small></span></footer></article>
      </div>
      <button className="welcome-refresh" onClick={onRefresh} aria-label="刷新欢迎页">刷新内容</button>
    </section>
  );
}
