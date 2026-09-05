import type { JSX, ComponentType } from "react";
import type { AppPage } from "../app/routes";
import { sidebarHasProjectOverflow, visibleSidebarProjects } from "./sidebar-model";
import {
  Archive,
  CircleHelp,
  Clock3,
  FileText,
  FolderKanban,
  FolderOpen,
  Gauge,
  Library,
  MessageCircle,
  Mic2,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import youzhaoIcon from "../assets/youzhao-icon.png";

interface SidebarProps {
  page: AppPage;
  projects: Array<{ id: string; name: string }>;
  conversations: Array<{ id: string; title: string }>;
  onNavigate: (page: AppPage) => void;
  onNewConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string, currentName: string) => void;
  onDeleteProject: (projectId: string, currentName: string) => void;
}

type SidebarIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
const items: Array<{ page: AppPage; label: string; icon: SidebarIcon; section: string }> = [
  { page: "home", label: "新对话", icon: Plus, section: "工作台" },
  { page: "interview", label: "开始面试", icon: Mic2, section: "工作台" },
  { page: "written-test", label: "笔试解题", icon: FileText, section: "工作台" },
  { page: "preparation", label: "面试准备", icon: Sparkles, section: "准备" },
  { page: "profiles", label: "档案与简历", icon: Archive, section: "准备" },
  { page: "speech-script", label: "演讲稿", icon: FileText, section: "准备" },
  { page: "project-library", label: "项目库", icon: FolderKanban, section: "资料" },
  { page: "knowledge", label: "资料库", icon: Library, section: "资料" },
  { page: "question-bank", label: "通用题库", icon: Gauge, section: "资料" },
  { page: "job-targets", label: "岗位要求", icon: Target, section: "资料" },
  { page: "history", label: "面试历史", icon: Clock3, section: "记录" }
];

export function Sidebar({ page, projects, conversations, onNavigate, onNewConversation, onOpenConversation, onOpenProject, onRenameProject, onDeleteProject }: SidebarProps): JSX.Element {
  const visibleProjects = visibleSidebarProjects(projects, page === "project-library");
  return (
    <aside className="sidebar">
      <div className="window-traffic-lights" aria-label="窗口控制">
        <button className="traffic-close" title="关闭" aria-label="关闭窗口" onClick={() => void window.interviewCopilot.windowControls.close()} />
        <button className="traffic-minimize" title="最小化" aria-label="最小化窗口" onClick={() => void window.interviewCopilot.windowControls.minimize()} />
        <button className="traffic-maximize" title="最大化或还原" aria-label="最大化或还原窗口" onClick={() => void window.interviewCopilot.windowControls.toggleMaximize()} />
      </div>
      <div className="sidebar-header">
        <button className="sidebar-brand" onClick={onNewConversation} aria-label="新对话">
          <img className="brand-app-icon" src={youzhaoIcon} alt="" />
          <span className="brand-copy"><span className="brand-name">有招</span><small>AI 面试智能体</small></span>
        </button>
        <button className="sidebar-start-card" onClick={() => onNavigate("interview")}>
          <span className="sidebar-start-icon"><Mic2 size={16} strokeWidth={2.2} /></span>
          <span><strong>开始一场面试</strong><small>实时听题 · 生成回答</small></span>
        </button>
      </div>
      <div className="sidebar-main-scroll">
        <nav className="sidebar-nav" aria-label="主导航">
          {(["工作台", "准备", "资料", "记录"] as const).map((section) => <div className="sidebar-nav-group" key={section}>
            <div className="sidebar-section-label">{section}</div>
            {items.filter((item) => item.section === section).map((item) => {
              const Icon = item.icon;
              return <button key={item.page} className={`sidebar-item ${page === item.page ? "selected" : ""}`} onClick={() => item.page === "home" ? onNewConversation() : onNavigate(item.page)}>
                <span className="sidebar-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.85} /></span>
                <span>{item.label}</span>
              </button>;
            })}
          </div>)}
        </nav>
        <div className="sidebar-section-label sidebar-context-label">{page === "project-library" ? "我的项目" : "对话工作区"}</div>
        {projects.length === 0 ? <div className="sidebar-empty">还没有项目</div> : visibleProjects.map((project) => <div className="sidebar-project-row" key={project.id}><button className={`sidebar-conversation ${page === "project-library" ? "sidebar-project-library-link" : ""}`} onClick={() => onOpenProject(project.id)}><FolderOpen size={14} strokeWidth={1.8} /><span className="sidebar-conversation-title">{project.name}</span></button><button className="sidebar-project-action" title="重命名项目" aria-label={`重命名项目 ${project.name}`} onClick={() => onRenameProject(project.id, project.name)}><Pencil size={13} /></button><button className="sidebar-project-action danger-text" title="删除项目" aria-label={`删除项目 ${project.name}`} onClick={() => onDeleteProject(project.id, project.name)}><Trash2 size={13} /></button></div>)}
        {page !== "project-library" && sidebarHasProjectOverflow(projects, visibleProjects) && <button className="sidebar-conversation sidebar-project-more" onClick={() => onNavigate("project-library")}><Plus size={14} /><span className="sidebar-conversation-title">查看全部项目</span></button>}
        <div className="sidebar-section-label conversation-label">最近对话</div>
        {conversations.length === 0 ? <div className="sidebar-empty">还没有对话</div> : conversations.slice(0, 8).map((conversation) => <button className="sidebar-conversation" key={conversation.id} onClick={() => onOpenConversation(conversation.id)}><MessageCircle size={13} strokeWidth={1.8} /><span className="sidebar-conversation-title">{conversation.title}</span></button>)}
      </div>
      <div className="sidebar-footer">
        <button className={`help-row ${page === "settings" ? "selected" : ""}`} onClick={() => onNavigate("settings")} data-testid="sidebar-settings"><span className="help-icon"><Settings size={16} strokeWidth={1.8} /></span><span>设置</span></button>
        <button className={`help-row ${page === "help" ? "selected" : ""}`} type="button" onClick={() => onNavigate("help")} data-testid="sidebar-help"><span className="help-icon"><CircleHelp size={16} strokeWidth={1.8} /></span><span>帮助</span></button>
      </div>
    </aside>
  );
}
