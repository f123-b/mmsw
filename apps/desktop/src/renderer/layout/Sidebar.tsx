import type { JSX } from "react";
import type { AppPage } from "../app/routes";

interface SidebarProps {
  page: AppPage;
  profileName?: string;
  projects: Array<{ id: string; name: string }>;
  conversations: Array<{ id: string; title: string }>;
  onNavigate: (page: AppPage) => void;
  onNewConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string, currentName: string) => void;
  onDeleteProject: (projectId: string, currentName: string) => void;
}

const items: Array<{ page: AppPage; label: string; icon: string }> = [
  { page: "home", label: "新对话", icon: "＋" },
  { page: "interview", label: "开始面试", icon: "◉" },
  { page: "preparation", label: "面试准备", icon: "✦" },
  { page: "history", label: "面试记录", icon: "◷" },
  { page: "profiles", label: "档案", icon: "▱" },
  { page: "knowledge", label: "知识库", icon: "▤" }
];

export function Sidebar({ page, profileName, projects, conversations, onNavigate, onNewConversation, onOpenConversation, onOpenProject, onRenameProject, onDeleteProject }: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <button className="sidebar-brand" onClick={onNewConversation} aria-label="新对话">
        <span className="brand-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="brand-copy"><span className="brand-name">Interview Copilot</span><small>AI 面试智能体</small></span>
      </button>
      <button className="sidebar-start-card" onClick={() => onNavigate("interview")}>
        <span className="sidebar-start-icon">↗</span>
        <span><strong>开始一场面试</strong><small>实时听题 · 生成回答</small></span>
      </button>
      <nav className="sidebar-nav" aria-label="主导航">
        {items.map((item) => (
          <button key={item.page} className={`sidebar-item ${page === item.page ? "selected" : ""}`} onClick={() => item.page === "home" ? onNewConversation() : onNavigate(item.page)}>
            <span className="sidebar-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-section-label">工作区</div>
      {projects.length === 0 ? <div className="sidebar-empty">还没有项目</div> : projects.slice(0, 6).map((project) => <div className="sidebar-project-row" key={project.id}><button className="sidebar-conversation" onClick={() => onOpenProject(project.id)}><span>▸</span><span className="sidebar-conversation-title">{project.name}</span></button><button className="sidebar-project-action" title="重命名项目" onClick={() => onRenameProject(project.id, project.name)}>✎</button><button className="sidebar-project-action danger-text" title="删除项目" onClick={() => onDeleteProject(project.id, project.name)}>×</button></div>)}
      <div className="sidebar-section-label conversation-label">最近对话</div>
      {conversations.length === 0 ? <div className="sidebar-empty">还没有对话</div> : conversations.slice(0, 8).map((conversation) => <button className="sidebar-conversation" key={conversation.id} onClick={() => onOpenConversation(conversation.id)}><span>•</span><span className="sidebar-conversation-title">{conversation.title}</span></button>)}
      <div className="sidebar-bottom">
        <button className="help-row" onClick={() => onNavigate("settings")}><span className="help-icon">?</span><span>快捷帮助</span></button>
        <button className="profile-row-bottom" onClick={() => onNavigate("profiles")}>
          <span className="avatar">{(profileName?.[0] ?? "I").toUpperCase()}</span>
          <span className="profile-bottom-copy"><strong>{profileName ?? "默认档案"}</strong><small>当前面试档案</small></span>
          <span className="chevron">⌄</span>
        </button>
      </div>
    </aside>
  );
}
