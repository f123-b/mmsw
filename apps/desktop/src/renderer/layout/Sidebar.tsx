import type { JSX } from "react";
import type { AppPage } from "../app/routes";

interface SidebarProps {
  page: AppPage;
  profileName?: string;
  onNavigate: (page: AppPage) => void;
  onNewConversation: () => void;
}

const items: Array<{ page: AppPage; label: string; icon: string }> = [
  { page: "home", label: "新对话", icon: "＋" },
  { page: "history", label: "面试记录", icon: "◷" },
  { page: "profiles", label: "档案", icon: "▱" },
  { page: "knowledge", label: "知识库", icon: "▤" }
];

export function Sidebar({ page, profileName, onNavigate, onNewConversation }: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <button className="sidebar-brand" onClick={onNewConversation} aria-label="新对话">
        <span className="brand-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="brand-name">Interview Copilot</span>
      </button>
      <nav className="sidebar-nav" aria-label="主导航">
        {items.map((item) => (
          <button key={item.page} className={`sidebar-item ${page === item.page ? "selected" : ""}`} onClick={() => item.page === "home" ? onNewConversation() : onNavigate(item.page)}>
            <span className="sidebar-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-section-label">项目</div>
      <div className="sidebar-empty">还没有项目</div>
      <div className="sidebar-section-label conversation-label">对话</div>
      <button className="sidebar-conversation" onClick={() => onNavigate("preparation")}><span>•</span>选择面试语言</button>
      <button className="sidebar-conversation" onClick={() => onNavigate("preparation")}><span>•</span>快速开始面试准备</button>
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
