import type { JSX } from "react";
import type { AppPage } from "../app/routes";
import type { SettingsSection } from "../settings/SettingsPage";

interface HelpPageProps {
  onNavigate: (page: AppPage) => void;
  onSettingsSection: (section: SettingsSection) => void;
  onOpenSetup: () => void;
}

const topics = [
  ["01", "快速开始", "先选档案，再确认模型、语音识别和悬浮窗设置；准备完成后点击开始面试。"],
  ["02", "面试档案", "档案保存简历、技能和个人表达偏好。只有已确认资料会被用于个人经历回答。"],
  ["03", "项目库", "导入项目材料后，系统会整理模块、技术点、问题和可验证事实，供面试上下文使用。"],
  ["04", "岗位要求", "导入 JD 后可查看重点要求；开始面试时可以选择岗位，也可以让系统自动匹配。"],
  ["05", "资料库", "原始 PDF、DOCX、TXT、MD 和项目压缩包集中保存在资料库，文档类型可以手动修正。"],
  ["06", "通用题库", "维护通用题、技能点和已核验答案卡；答案卡只作为优先参考，不会覆盖实时问题判断。"],
  ["07", "实时听题", "ASR 片段会先在本地组装成完整问题，追问、例子、约束和多个子问题会保留在同一题组。"],
  ["08", "回答模式", "FAST 优先低延迟，NORMAL 平衡速度与完整度，DEEP 适合需要更多推理的手动问题。"],
  ["09", "悬浮窗", "悬浮窗可以选择布局、交互模式、滚轮路由和显示模式；运行时内容在窗口内部滚动。"],
  ["10", "截图与笔试", "笔试模式支持 Ctrl + Alt + S 截图识别；中键截图仅在启用且处于允许的工作流时生效。"],
  ["11", "隐私与事实", "捕获保护、个人事实策略和项目资料来源可在设置中检查；未确认的个人经历不会被当成事实。"],
  ["12", "诊断与历史", "面试历史保存转写、问题、回答和延迟指标；遇到异常时先查看设置中的关于、语音识别和隐私诊断。"]
] as const;

export function HelpPage({ onNavigate, onSettingsSection, onOpenSetup }: HelpPageProps): JSX.Element {
  const openSettings = (section: SettingsSection) => { onSettingsSection(section); onNavigate("settings"); };
  return <section className="simple-page help-page" data-testid="help-page">
    <div className="page-heading"><div><span className="page-kicker">HELP CENTER</span><h1>帮助与快速开始</h1><p className="page-note">把面试前准备、实时听题和悬浮窗操作放在一页里。</p></div><button className="dark-pill" onClick={onOpenSetup}>开始模拟面试</button></div>
    <article className="help-quick-start detail-sheet">
      <div><span className="page-kicker">QUICK START</span><h2>五步开始第一场面试</h2></div>
      <div className="help-step-grid"><button onClick={() => onNavigate("profiles")}><b>1</b><strong>打开档案</strong><small>确认简历、技能和个人表达</small></button><button onClick={() => openSettings("models")}><b>2</b><strong>检查模型</strong><small>配置回答模型和任务路由</small></button><button onClick={() => openSettings("asr")}><b>3</b><strong>检查语音识别</strong><small>选择 ASR 与音频设备</small></button><button onClick={() => openSettings("overlay")}><b>4</b><strong>调整悬浮窗</strong><small>选择布局、交互和显示模式</small></button><button onClick={onOpenSetup}><b>5</b><strong>开始模拟面试</strong><small>选择 AUTO 或 MANUAL 后启动</small></button></div>
    </article>
    <div className="help-topic-grid">{topics.map(([number, title, description]) => <article className="help-topic-card" key={number}><span>{number}</span><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
  </section>;
}

export function OnboardingModal({ onFinish }: { onFinish: () => void }): JSX.Element {
  return <div className="modal-backdrop onboarding-backdrop" role="presentation"><section className="setup-modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><header><div><span className="page-kicker">FIRST RUN</span><h2 id="onboarding-title">五步熟悉 Interview Copilot</h2></div></header><ol><li><strong>选择或建立面试档案</strong><span>只使用你确认过的简历和项目事实。</span></li><li><strong>配置回答模型与 ASR</strong><span>设置页可以随时返回修改。</span></li><li><strong>选择悬浮窗布局</strong><span>运行时问题和回答会各自在固定窗口中滚动。</span></li><li><strong>开始模拟面试</strong><span>AUTO 自动回答，MANUAL 由你决定何时回答。</span></li><li><strong>遇到问题先看历史与诊断</strong><span>每场面试都会记录问题、回答和延迟阶段。</span></li></ol><footer><button className="dark-pill" onClick={onFinish}>开始使用</button></footer></section></div>;
}
