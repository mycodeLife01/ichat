/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: sidebar · genre: modern-minimal · system: existing warm-neutral tokens */
import { useEffect, useState, type ReactNode, type UIEvent } from "react";
import { createPortal } from "react-dom";

import type { ConversationResponse, UserShareResponse } from "../api/types";
import { iconBtn, sheetItem, titleSkeleton } from "../ui/classes";
import { Icons } from "../ui/icons";
import { Wordmark } from "../ui/Wordmark";
import { BottomSheet } from "../ui/BottomSheet";
import { UserMenu } from "./UserMenu";

export type SidebarUser = {
  email: string;
  username: string;
  name: string;
  emailVerified: boolean;
  avatarUrl?: string | null;
};

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
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onUploadAvatar?: (blob: Blob) => Promise<string>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
  onLoadShares: () => Promise<UserShareResponse[]>;
  onRevokeShare: (conversationId: string, token: string) => Promise<unknown>;
  onToast: (message: string) => void;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
};

const sectionLabel =
  "px-2.5 pb-1.5 text-[13px] font-semibold leading-5 text-fg max-[760px]:text-[14px]";

type ConversationMenu = {
  conversationId: string;
  left: number;
  top: number;
};

const desktopMenuWidth = 156;
const desktopMenuHeight = 126;
const desktopMenuOverlap = 44;
const viewportInset = 8;
const desktopMenuItemBase =
  "flex h-9 w-full items-center gap-2.5 whitespace-nowrap rounded-[10px] px-3 text-left text-[14px] font-normal leading-none transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:text-fg-faint disabled:hover:bg-transparent";
const desktopMenuItem =
  `${desktopMenuItemBase} text-fg hover:bg-menu-hover focus-visible:bg-menu-hover active:bg-menu-hover`;
const desktopDangerMenuItem =
  `${desktopMenuItemBase} text-menu-danger hover:bg-danger-hover focus-visible:bg-danger-hover active:bg-danger-hover`;
const desktopRowActionOrder = ["share", "rename", "delete"] as const;
const mobileRowActionOrder = ["rename", "share", "delete"] as const;
type RowActionKey = (typeof desktopRowActionOrder)[number];

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
  onResendVerification,
  onUpdateNickname,
  onUploadAvatar,
  onChangePassword,
  onRequestDeletion,
  onLoadShares,
  onRevokeShare,
  onToast,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ConversationMenu | null>(null);

  useEffect(() => {
    const closeMenu = () => setMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    document.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuOnEscape);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuOnEscape);
      window.removeEventListener("resize", closeMenu);
    };
  }, []);

  const handleHistoryScroll = (event: UIEvent<HTMLDivElement>) => {
    setMenu(null);
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
    const menuOpen = menu?.conversationId === c.id;
    const active = selectedId === c.id;
    const rowActions: Record<
      RowActionKey,
      {
        label: string;
        mobileLabel?: string;
        desktopIcon: ReactNode;
        mobileIcon: ReactNode;
        danger?: boolean;
        run: () => void;
      }
    > = {
      share: {
        label: "分享",
        desktopIcon: <Icons.Upload size={18} />,
        mobileIcon: <Icons.Share size={13} />,
        run: () => {
          onRequestShare(c.id);
          setMenu(null);
        },
      },
      rename: {
        label: "重命名",
        desktopIcon: <Icons.Pen size={18} />,
        mobileIcon: <Icons.Pen size={13} />,
        run: () => {
          setRenameId(c.id);
          setMenu(null);
        },
      },
      delete: {
        label: "删除",
        mobileLabel: "删除对话",
        desktopIcon: <Icons.Trash size={18} />,
        mobileIcon: <Icons.Trash size={13} />,
        danger: true,
        run: () => {
          onRequestDelete(c.id);
          setMenu(null);
        },
      },
    };
    const renderRowActions = (surface: "desktop" | "mobile") => {
      const desktop = surface === "desktop";
      const order = desktop ? desktopRowActionOrder : mobileRowActionOrder;
      return order.map((key) => {
        const action = rowActions[key];
        return (
          <button
            key={key}
            className={
              desktop
                ? action.danger
                  ? desktopDangerMenuItem
                  : desktopMenuItem
                : `${sheetItem} ${action.danger ? "text-danger" : "text-fg"}`
            }
            role={desktop ? "menuitem" : undefined}
            onClick={action.run}
          >
            {desktop ? action.desktopIcon : action.mobileIcon}
            {desktop ? action.label : action.mobileLabel ?? action.label}
          </button>
        );
      });
    };
    return (
      <div
        key={c.id}
        // leading-[22px] keeps a stable line box (>= the 22px menu button) so
        // revealing the button on hover never shifts the rows below.
        className={`history-row group/row relative flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium leading-[22px] text-fg transition-colors duration-100 hover:bg-bg-hover max-[760px]:py-2 max-[760px]:text-[15px] max-[760px]:leading-[24px] ${
          active || menuOpen ? "active bg-bg-active hover:bg-bg-active" : ""
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
              isMobile || active || menuOpen
                ? "inline-flex"
                : "hidden group-hover/row:inline-flex group-focus-within/row:inline-flex"
            }`}
            aria-label="更多"
            aria-haspopup={isMobile ? "dialog" : "menu"}
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              if (menuOpen) {
                setMenu(null);
                return;
              }

              if (isMobile) {
                setMenu({ conversationId: c.id, left: 0, top: 0 });
                return;
              }

              const row = event.currentTarget.closest(".history-row");
              if (!(row instanceof HTMLElement)) return;
              const rect = row.getBoundingClientRect();
              const left = Math.max(
                viewportInset,
                Math.min(
                  rect.right - desktopMenuOverlap,
                  window.innerWidth - desktopMenuWidth - viewportInset,
                ),
              );
              const top = Math.max(
                viewportInset,
                Math.min(
                  rect.bottom - 4,
                  window.innerHeight - desktopMenuHeight - viewportInset,
                ),
              );
              setMenu({ conversationId: c.id, left, top });
            }}
          >
            <Icons.More size={14} />
          </button>
        )}
        {/* Desktop escapes the sidebar's overflow boundary; mobile uses a bottom sheet. */}
        {!isRenaming && menuOpen && !isMobile && (
          createPortal(
            <div
              className="history-menu fixed z-40 w-[156px] rounded-[14px] border border-border-strong bg-bg-raised p-1.5 shadow-menu"
              style={{ left: menu.left, top: menu.top }}
              role="menu"
              aria-label="会话操作"
              onClick={(event) => event.stopPropagation()}
            >
              {renderRowActions("desktop")}
            </div>,
            document.body,
          )
        )}
        {!isRenaming && isMobile && (
          <BottomSheet open={menuOpen} onClose={() => setMenu(null)}>
            {renderRowActions("mobile")}
          </BottomSheet>
        )}
      </div>
    );
  };

  return (
    <>
      <aside className={sidebarClasses.join(" ")}>
        <div className="flex h-full w-[var(--sidebar-width)] flex-col px-2.5 pt-3 pb-2.5">
          <div className="flex items-center justify-between px-2 pb-3.5">
            <Wordmark size={isMobile ? 20 : 18} />
            {!isMobile && (
              <button className={iconBtn} aria-label="收起侧栏" onClick={onToggleCollapsed}>
                <Icons.PanelLeft size={20} />
              </button>
            )}
          </div>

          <button
            className="flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium text-fg transition-colors duration-[120ms] hover:bg-bg-hover max-[760px]:py-2.5 max-[760px]:text-[15px]"
            onClick={() => {
              onNew();
              if (isMobile) onCloseMobile();
            }}
          >
            <Icons.NewChat size={20} />
            新建对话
          </button>

          {/* -mr-2.5/pr-2.5 cancel the parent's horizontal padding so the scrollbar sits flush
              against the sidebar's right border; rows keep their position. */}
          <div
            className="mt-5 -mr-2.5 flex flex-1 flex-col gap-px overflow-y-auto pr-2.5"
            data-testid="conversation-history"
            onScroll={handleHistoryScroll}
          >
            <div className={sectionLabel}>聊天</div>
            {items.map(renderRow)}
            {items.length === 0 && (
              <div className="px-2.5 py-3 text-[12.5px] leading-[1.6] text-fg-subtle max-[760px]:text-[13.5px]">
                还没有已保存的对话。开始一次对话后会自动出现在这里。
              </div>
            )}
            {isLoadingMore && (
              <div className="px-2.5 py-3 text-[12px] leading-[1.6] text-fg-subtle max-[760px]:text-[13px]">
                正在加载...
              </div>
            )}
          </div>

          <UserMenu
            user={user}
            onLogout={onLogout}
            onResendVerification={onResendVerification}
            onUpdateNickname={onUpdateNickname}
            onUploadAvatar={onUploadAvatar}
            onChangePassword={onChangePassword}
            onRequestDeletion={onRequestDeletion}
            onLoadShares={onLoadShares}
            onRevokeShare={onRevokeShare}
            onToast={onToast}
          />
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
