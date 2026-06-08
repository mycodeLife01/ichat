import { useEffect, useMemo, useState } from "react";

import type { ConversationResponse } from "../api/types";
import { Icons } from "../ui/icons";
import { Wordmark } from "../ui/Wordmark";

export type SidebarUser = { email: string; name: string };

type SidebarProps = {
  items: ConversationResponse[];
  selectedId: number | null;
  user: SidebarUser | null;
  isMobile: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onRename: (id: number, title: string) => void;
  onRequestDelete: (id: number) => void;
  onLogout: () => void;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
};

type Groups = {
  today: ConversationResponse[];
  yesterday: ConversationResponse[];
  older: ConversationResponse[];
};

function groupByDate(items: ConversationResponse[]): Groups {
  const today: ConversationResponse[] = [];
  const yesterday: ConversationResponse[] = [];
  const older: ConversationResponse[] = [];
  const now = new Date();
  const yesterdayStr = new Date(now.getTime() - 86_400_000).toDateString();
  for (const c of items) {
    const d = new Date(c.updated_at).toDateString();
    if (d === now.toDateString()) today.push(c);
    else if (d === yesterdayStr) yesterday.push(c);
    else older.push(c);
  }
  return { today, yesterday, older };
}

export function Sidebar({
  items,
  selectedId,
  user,
  isMobile,
  collapsed,
  mobileOpen,
  onSelect,
  onNew,
  onRename,
  onRequestDelete,
  onLogout,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  const [renameId, setRenameId] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  useEffect(() => {
    const handler = () => setMenuFor(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const groups = useMemo(() => groupByDate(items), [items]);

  const sidebarClasses = ["sidebar"];
  if (collapsed) sidebarClasses.push("collapsed");
  if (mobileOpen) sidebarClasses.push("open");

  const renderRow = (c: ConversationResponse) => {
    const isRenaming = renameId === c.id;
    return (
      <div
        key={c.id}
        className={`history-row${selectedId === c.id ? " active" : ""}`}
        onClick={() => {
          if (isRenaming) return;
          onSelect(c.id);
          if (isMobile) onCloseMobile();
        }}
      >
        {isRenaming ? (
          <input
            autoFocus
            ref={(el) => el?.select()}
            defaultValue={c.title ?? ""}
            className="history-rename"
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              onRename(c.id, event.target.value);
              setRenameId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenameId(null);
            }}
          />
        ) : (
          // Title-pending skeleton is wired in step 10 (pendingTitleIds); this
          // step shows a "新对话" fallback for activated rows with no title.
          <span className="title">{c.title || "新对话"}</span>
        )}
        {!isRenaming && (
          <button
            className="menu-btn"
            aria-label="更多"
            onClick={(event) => {
              event.stopPropagation();
              setMenuFor(menuFor === c.id ? null : c.id);
            }}
          >
            <Icons.More size={14} />
          </button>
        )}
        {menuFor === c.id && (
          <div
            className="history-menu"
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "absolute",
              right: 6,
              top: "calc(100% - 4px)",
              background: "var(--bg-raised)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--menu-radius, 6px)",
              padding: 4,
              zIndex: 10,
              minWidth: 120,
              boxShadow: "0 6px 20px rgba(20,20,19,0.08)",
            }}
          >
            <button
              className="sheet-item"
              style={{ padding: "7px 10px", fontSize: 13 }}
              onClick={() => {
                setRenameId(c.id);
                setMenuFor(null);
              }}
            >
              <Icons.Pen size={13} />
              重命名
            </button>
            <button
              className="sheet-item destructive"
              style={{ padding: "7px 10px", fontSize: 13 }}
              onClick={() => {
                onRequestDelete(c.id);
                setMenuFor(null);
              }}
            >
              <Icons.Trash size={13} />
              删除对话
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <aside className={sidebarClasses.join(" ")}>
        <div className="sidebar-inner">
          <div className="brand">
            <Wordmark />
            {!isMobile && (
              <button className="icon-btn" aria-label="收起侧栏" onClick={onToggleCollapsed}>
                <Icons.PanelLeft size={15} />
              </button>
            )}
          </div>

          <button
            className="new-chat"
            onClick={() => {
              onNew();
              if (isMobile) onCloseMobile();
            }}
          >
            <Icons.Plus size={14} />
            新建对话
            {!isMobile && <span className="kbd">⌘ N</span>}
          </button>

          <div className="history">
            {groups.today.length > 0 && (
              <>
                <div className="history-section-label">今天</div>
                {groups.today.map(renderRow)}
              </>
            )}
            {groups.yesterday.length > 0 && (
              <>
                <div className="history-section-label">昨天</div>
                {groups.yesterday.map(renderRow)}
              </>
            )}
            {groups.older.length > 0 && (
              <>
                <div className="history-section-label">更早</div>
                {groups.older.map(renderRow)}
              </>
            )}
            {items.length === 0 && (
              <div
                style={{
                  padding: "16px 10px",
                  fontSize: 12.5,
                  color: "var(--fg-subtle)",
                  lineHeight: 1.6,
                }}
              >
                还没有已保存的对话。开始一次对话后会自动出现在这里。
              </div>
            )}
          </div>

          <div className="account">
            <div className="avatar">{(user?.name || "U").slice(0, 1).toUpperCase()}</div>
            <div className="account-name">{user?.email || "you@example.com"}</div>
            <button className="icon-btn" aria-label="退出登录" onClick={onLogout}>
              <Icons.LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>
      {isMobile && (
        <div
          className={`scrim${mobileOpen ? " show" : ""}`}
          onClick={onCloseMobile}
          aria-hidden={!mobileOpen}
        />
      )}
    </>
  );
}
