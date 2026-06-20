import { useEffect, useMemo, useState, type CSSProperties, type UIEvent } from "react";

import type { ConversationResponse } from "../api/types";
import { iconBtn, sheetItem, titleSkeleton } from "../ui/classes";
import { newChatHotkeyLabel } from "../ui/hotkeys";
import { Icons } from "../ui/icons";
import { Wordmark } from "../ui/Wordmark";
import { BottomSheet } from "../ui/BottomSheet";

export type SidebarUser = { email: string; name: string };

type SidebarProps = {
  items: ConversationResponse[];
  selectedId: string | null;
  user: SidebarUser | null;
  isMobile: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  pendingTitleIds: string[];
  hasMore: boolean;
  isLoadingMore: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onLoadMore: () => void;
  onRename: (id: string, title: string) => void;
  onRequestShare: (id: string) => void;
  onRequestDelete: (id: string) => void;
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

const sectionLabel =
  "px-2.5 pt-3.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-fg-subtle uppercase max-[760px]:text-[12px]";

export function Sidebar({
  items,
  selectedId,
  user,
  isMobile,
  collapsed,
  mobileOpen,
  pendingTitleIds,
  hasMore,
  isLoadingMore,
  onSelect,
  onNew,
  onLoadMore,
  onRename,
  onRequestShare,
  onRequestDelete,
  onLogout,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  useEffect(() => {
    const handler = () => setMenuFor(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const groups = useMemo(() => groupByDate(items), [items]);

  const handleHistoryScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!hasMore || isLoadingMore) return;
    const element = event.currentTarget;
    const distanceToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToBottom <= 48) {
      onLoadMore();
    }
  };

  // "sidebar" / "collapsed" / "open" are state hooks for tests; the visual
  // states branch on isMobile (drawer) vs desktop (collapsible column).
  const sidebarClasses = ["sidebar flex flex-col overflow-hidden bg-bg-sunken"];
  if (isMobile) {
    sidebarClasses.push(
      "fixed inset-y-0 left-0 z-30 w-[var(--sidebar-width)] border-r border-border " +
        "shadow-[0_0_30px_rgba(0,0,0,0.08)] transition-transform duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
      mobileOpen ? "open translate-x-0" : "-translate-x-full",
    );
  } else {
    sidebarClasses.push(
      "shrink-0 transition-[width,margin-left] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
      collapsed ? "collapsed w-0" : "w-[var(--sidebar-width)] border-r border-border",
    );
  }

  const renderRow = (c: ConversationResponse) => {
    const isRenaming = renameId === c.id;
    const menuOpen = menuFor === c.id;
    const active = selectedId === c.id;
    // The same two actions, rendered into a desktop dropdown or a mobile sheet.
    const rowActions = (itemStyle?: CSSProperties) => (
      <>
        <button
          className={`${sheetItem} text-fg`}
          style={itemStyle}
          onClick={() => {
            setRenameId(c.id);
            setMenuFor(null);
          }}
        >
          <Icons.Pen size={13} />
          重命名
        </button>
        <button
          className={`${sheetItem} text-fg`}
          style={itemStyle}
          onClick={() => {
            onRequestShare(c.id);
            setMenuFor(null);
          }}
        >
          <Icons.Share size={13} />
          分享
        </button>
        <button
          className={`${sheetItem} text-danger`}
          style={itemStyle}
          onClick={() => {
            onRequestDelete(c.id);
            setMenuFor(null);
          }}
        >
          <Icons.Trash size={13} />
          删除对话
        </button>
      </>
    );
    return (
      <div
        key={c.id}
        // leading-[22px] keeps a stable line box (>= the 22px menu button) so
        // revealing the button on hover never shifts the rows below.
        className={`history-row group/row relative flex cursor-pointer items-center gap-1.5 rounded-md px-[11px] py-[7.7px] text-[13.5px] leading-[22px] transition-[background,color] duration-100 max-[760px]:py-[9px] max-[760px]:text-[15px] max-[760px]:leading-[24px] ${
          active
            ? "active bg-bg-active font-medium text-fg"
            : "text-fg-muted hover:bg-bg-hover hover:text-fg"
        }`}
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
            // Inline rename input — looks identical to the title text.
            className="m-0 min-w-0 flex-1 border-none bg-transparent p-0 font-[inherit] text-inherit outline-none selection:bg-[rgba(120,170,240,0.45)] selection:text-inherit focus:shadow-none focus:outline-none focus-visible:outline-none"
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
        ) : pendingTitleIds.includes(c.id) ? (
          // Auto-title is still being generated for this freshly-activated draft.
          <span className="flex-1 truncate text-fg-subtle">
            <span className={titleSkeleton} style={{ width: 120, verticalAlign: "middle" }} />
          </span>
        ) : (
          <span className="flex-1 truncate">{c.title || "新对话"}</span>
        )}
        {!isRenaming && (
          <button
            className={`h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:text-fg ${
              active ? "inline-flex" : "hidden group-hover/row:inline-flex"
            }`}
            aria-label="更多"
            onClick={(event) => {
              event.stopPropagation();
              setMenuFor(menuOpen ? null : c.id);
            }}
          >
            <Icons.More size={14} />
          </button>
        )}
        {/* Desktop: an anchored dropdown. Mobile: a bottom sheet. */}
        {!isRenaming && menuOpen && !isMobile && (
          <div
            className="history-menu absolute top-[calc(100%-4px)] right-1.5 z-10 min-w-[120px] rounded-[8px] border border-border-strong bg-bg-raised p-1 shadow-[0_6px_20px_rgba(20,20,19,0.08)]"
            onClick={(event) => event.stopPropagation()}
          >
            {rowActions({
              padding: "7px 10px",
              fontSize: 13,
              borderRadius: 6,
            })}
          </div>
        )}
        {!isRenaming && isMobile && (
          <BottomSheet open={menuOpen} onClose={() => setMenuFor(null)}>
            {rowActions()}
          </BottomSheet>
        )}
      </div>
    );
  };

  return (
    <>
      <aside className={sidebarClasses.join(" ")}>
        <div className="flex h-full w-[var(--sidebar-width)] flex-col px-3 pt-4 pb-3">
          <div className="flex items-center justify-between pt-1 pr-2 pb-4 pl-2">
            <Wordmark size={isMobile ? 20 : 18} />
            {!isMobile && (
              <button className={iconBtn} aria-label="收起侧栏" onClick={onToggleCollapsed}>
                <Icons.PanelLeft size={15} />
              </button>
            )}
          </div>

          <button
            className="flex w-full items-center gap-2 rounded-md border border-border bg-bg-raised px-2.5 py-2 text-left text-sm font-medium text-fg transition-[background,border-color] duration-[120ms] hover:border-border-strong hover:bg-bg max-[760px]:py-2.5 max-[760px]:text-[15px]"
            onClick={() => {
              onNew();
              if (isMobile) onCloseMobile();
            }}
          >
            <Icons.Plus size={14} />
            新建对话
            {!isMobile && (
              <span className="ml-auto font-mono text-[11px] text-fg-subtle">
                {newChatHotkeyLabel}
              </span>
            )}
          </button>

          {/* -mr-3/pr-3 cancel the parent's px-3 so the scrollbar sits flush
              against the sidebar's right border; rows keep their position. */}
          <div
            className="mt-[18px] -mr-3 flex flex-1 flex-col gap-px overflow-y-auto pr-3"
            data-testid="conversation-history"
            onScroll={handleHistoryScroll}
          >
            {groups.today.length > 0 && (
              <>
                <div className={sectionLabel}>今天</div>
                {groups.today.map(renderRow)}
              </>
            )}
            {groups.yesterday.length > 0 && (
              <>
                <div className={sectionLabel}>昨天</div>
                {groups.yesterday.map(renderRow)}
              </>
            )}
            {groups.older.length > 0 && (
              <>
                <div className={sectionLabel}>更早</div>
                {groups.older.map(renderRow)}
              </>
            )}
            {items.length === 0 && (
              <div className="px-2.5 py-4 text-[12.5px] leading-[1.6] text-fg-subtle max-[760px]:text-[13.5px]">
                还没有已保存的对话。开始一次对话后会自动出现在这里。
              </div>
            )}
            {isLoadingMore && (
              <div className="px-2.5 py-3 text-[12px] leading-[1.6] text-fg-subtle max-[760px]:text-[13px]">
                正在加载...
              </div>
            )}
          </div>

          <div className="mt-2 flex items-center gap-2.5 border-t border-border px-2 pt-3 pb-1">
            <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg max-[760px]:h-7 max-[760px]:w-7 max-[760px]:text-[13px]">
              {(user?.name || "U").slice(0, 1).toUpperCase()}
            </div>
            <div className="flex-1 truncate text-[13px] text-fg max-[760px]:text-[14px]">
              {user?.email || "you@example.com"}
            </div>
            <button className={iconBtn} aria-label="退出登录" onClick={onLogout}>
              <Icons.LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>
      {isMobile && (
        <div
          className={`scrim fixed inset-0 z-[29] bg-[rgba(20,20,19,0.32)] transition-opacity duration-200 ${
            mobileOpen ? "show pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
          onClick={onCloseMobile}
          aria-hidden={!mobileOpen}
        />
      )}
    </>
  );
}
