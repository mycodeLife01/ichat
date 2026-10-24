import { ChevronDown, Search, Star, StarOff } from "lucide-react";
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: sidebar · genre: modern-minimal · system: existing warm-neutral tokens */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";

import type { ConversationResponse, UserShareResponse } from "../api/types";
import {
  dangerMenuItem,
  iconControl,
  interactiveItem,
  mobileActionItem,
  neutralMenuItem,
  popoverSurface,
  railIconControl,
  titleSkeleton,
} from "../ui/classes";
import { Icons } from "../ui/icons";
import type { ToastHandler } from "../ui/state";
import { Wordmark } from "../ui/Wordmark";
import { BottomSheet } from "../ui/BottomSheet";
import { PinGlyph } from "./PinGlyph";
import { UserMenu } from "./UserMenu";

export type SidebarUser = {
  email: string;
  username: string;
  name: string;
  emailVerified: boolean;
  avatarUrl?: string | null;
};

// Per-conversation run status shown at the row's trailing edge: a spinner
// while a run is in flight, a dot once a background run finishes unseen.
export type ConversationRowStatus = "running" | "unread";

type SidebarProps = {
  // Recent (unpinned) rows; pinned rows arrive separately in pinnedItems.
  items: ConversationResponse[];
  pinnedItems: ConversationResponse[];
  selectedId: string | null;
  user: SidebarUser | null;
  isMobile: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  pendingTitleIds: string[];
  rowStatus?: Record<string, ConversationRowStatus>;
  isLoadingList?: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSearch?: () => void;
  onLoadMore: () => void;
  onRename: (id: string, title: string) => void;
  onRequestShare: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onOpenFavorites: () => void;
  onLogout: () => void;
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onUploadAvatar?: (blob: Blob) => Promise<string>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
  onLoadShares: () => Promise<UserShareResponse[]>;
  onRevokeShare: (conversationId: string, token: string) => Promise<unknown>;
  onToast: ToastHandler;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
};

// Light section headers that double as collapse toggles; folding a section
// never shifts the header itself.
const quietSectionLabel =
  "section-label-quiet px-2.5 pb-1.5 font-normal leading-5";

type ConversationMenu = {
  conversationId: string;
  left: number;
  top: number;
};

const desktopMenuWidth = 156;
const desktopMenuItemHeight = 38;
const desktopMenuPadding = 12;
const desktopMenuOverlap = 44;
const viewportInset = 8;
// The collapsed rail lists only the newest conversations; the full history stays
// behind the expanded sidebar.
const railRecentLimit = 10;
const railRecentWidth = 260;
const rowActionOrder = ["pin", "favorite", "share", "rename", "delete"] as const;
type RowActionKey = (typeof rowActionOrder)[number];

export function Sidebar({
  items,
  pinnedItems,
  selectedId,
  user,
  isMobile,
  collapsed,
  mobileOpen,
  pendingTitleIds,
  rowStatus,
  isLoadingList = false,
  hasMore,
  isLoadingMore,
  onSelect,
  onNew,
  onSearch,
  onLoadMore,
  onRename,
  onRequestShare,
  onRequestDelete,
  onTogglePin,
  onToggleFavorite,
  onOpenFavorites,
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
  // Collapsed-rail recent-chats flyout: portaled like the row menu so the rail's
  // overflow boundary cannot clip it.
  const [recent, setRecent] = useState<{ left: number; top: number } | null>(null);
  const recentTriggerRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const [collapsedSections, setCollapsedSections] = useState<{
    pinned: boolean;
    recent: boolean;
  }>({ pinned: false, recent: false });
  const lastAutoLoadItemCountRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (recent === null) return;
    const close = () => setRecent(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", close);
    };
  }, [recent]);

  // The rail only exists while the sidebar is expanded away; closing it there
  // keeps a stale flyout from surviving the expand.
  useEffect(() => {
    if (!collapsed || isMobile) setRecent(null);
  }, [collapsed, isMobile]);

  const requestNextPageIfNeeded = useCallback((
    element: HTMLDivElement,
    automatic = false,
  ) => {
    if (items.length === 0 || !hasMore || isLoadingMore || collapsedSections.recent)
      return;
    const distanceToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToBottom <= 48) {
      if (
        automatic &&
        lastAutoLoadItemCountRef.current === items.length
      ) {
        return;
      }
      if (automatic) {
        lastAutoLoadItemCountRef.current = items.length;
      }
      onLoadMore();
    }
  }, [collapsedSections.recent, hasMore, isLoadingMore, items.length, onLoadMore]);

  const handleHistoryScroll = (event: UIEvent<HTMLDivElement>) => {
    setMenu(null);
    requestNextPageIfNeeded(event.currentTarget);
  };

  useEffect(() => {
    const element = historyRef.current;
    const visible = isMobile ? mobileOpen : !collapsed;
    if (!element || !visible) return;

    const measure = () => requestNextPageIfNeeded(element, true);
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [
    collapsed,
    isMobile,
    items.length,
    mobileOpen,
    requestNextPageIfNeeded,
  ]);

  // "sidebar" / "collapsed" / "open" are state hooks for tests; the visual
  // states branch on isMobile (drawer) vs desktop (collapsible column).
  const sidebarClasses = ["sidebar flex flex-col overflow-hidden bg-sidebar"];
  if (isMobile) {
    sidebarClasses.push(
      "fixed inset-y-0 left-0 z-30 w-[var(--sidebar-width)] max-w-[calc(100vw-44px)] border-r border-border " +
        "shadow-popover transition-transform duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
      mobileOpen ? "open translate-x-0" : "-translate-x-full",
    );
  } else {
    sidebarClasses.push(
      // The moving right edge is the whole animation: it starts on the first
      // frame in both directions so the main column reads as sliding over the
      // still panel, not as the panel sliding out of the viewport.
      "shrink-0 border-r border-border transition-[width] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] delay-0 motion-reduce:transition-none",
      collapsed ? "collapsed w-[var(--sidebar-rail-width)]" : "w-[var(--sidebar-width)]",
    );
  }

  // Rail-only entry point for the newest conversations. Positioned from the
  // trigger like the row menu, and portaled for the same reason.
  const toggleRecent = () => {
    if (recent !== null) {
      setRecent(null);
      return;
    }
    const rect = recentTriggerRef.current?.getBoundingClientRect();
    const left = rect
      ? Math.min(rect.right + 8, window.innerWidth - railRecentWidth - viewportInset)
      : viewportInset;
    const top = rect
      ? Math.min(Math.max(viewportInset, rect.top - 6), Math.max(viewportInset, window.innerHeight - 360))
      : viewportInset;
    setRecent({ left: Math.max(viewportInset, left), top });
  };

  const desktopMenuHeight =
    desktopMenuPadding + rowActionOrder.length * desktopMenuItemHeight;
  const renderRow = (
    c: ConversationResponse,
    options: { onSelected?: () => void; renderDesktopMenu?: boolean } = {},
  ) => {
    const isRenaming = renameId === c.id;
    const menuOpen = menu?.conversationId === c.id;
    const active = selectedId === c.id;
    const status = rowStatus?.[c.id];
    const rowActions: Record<
      RowActionKey,
      {
        label: string;
        desktopIcon: ReactNode;
        mobileIcon: ReactNode;
        danger?: boolean;
        run: () => void;
      }
    > = {
      pin: {
        label: c.pinned_at ? "取消置顶" : "置顶",
        desktopIcon: <PinGlyph size={18} slashed={!!c.pinned_at} />,
        mobileIcon: <PinGlyph size={13} slashed={!!c.pinned_at} />,
        run: () => {
          onTogglePin(c.id);
          setMenu(null);
        },
      },
      favorite: {
        label: c.favorited_at ? "取消收藏" : "收藏",
        desktopIcon: c.favorited_at ? <StarOff size={18} strokeWidth={1.6} /> : <Star size={18} strokeWidth={1.6} />,
        mobileIcon: c.favorited_at ? <StarOff size={13} strokeWidth={1.8} /> : <Star size={13} strokeWidth={1.8} />,
        run: () => {
          onToggleFavorite(c.id);
          setMenu(null);
        },
      },
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
      return rowActionOrder.map((key) => {
        const action = rowActions[key];
        return (
          <button
            key={key}
            className={`${action.danger ? dangerMenuItem : neutralMenuItem} ${
              desktop ? "" : mobileActionItem
            }`}
            role={desktop ? "menuitem" : undefined}
            data-variant={action.danger ? "danger" : "neutral"}
            onClick={action.run}
          >
            {desktop ? action.desktopIcon : action.mobileIcon}
            {action.label}
          </button>
        );
      });
    };
    return (
      <div
        key={c.id}
        // A fixed minimum height keeps revealing the desktop action button from
        // shifting adjacent rows; mobile raises the whole target to 44px.
        className={`history-row group/row relative flex min-h-9 items-center gap-1.5 text-[14px] font-normal leading-5 text-text-primary max-[760px]:min-h-11 max-[760px]:text-[15px] max-[760px]:leading-[24px] ${interactiveItem} history-row-spaced`}
        data-selected={active || menuOpen}
      >
        {isRenaming ? (
          <input
            autoFocus
            ref={(el) => el?.select()}
            defaultValue={c.title ?? ""}
            // Inline rename input — looks identical to the title text.
            className="m-0 min-w-0 flex-1 border-none bg-transparent px-2.5 py-1.5 font-[inherit] text-inherit outline-none selection:bg-[rgba(120,170,240,0.45)] selection:text-inherit focus:shadow-none focus:outline-none"
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
          <button
            className="min-w-0 flex-1 self-stretch rounded-item px-2.5 py-1.5 text-left font-[inherit] text-inherit focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring max-[760px]:py-2"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              onSelect(c.id);
              options.onSelected?.();
              if (isMobile) onCloseMobile();
            }}
          >
            {pendingTitleIds.includes(c.id) ? (
              // Auto-title is still being generated for this freshly-activated draft.
              <span className="block truncate text-text-muted">
                <span
                  className={titleSkeleton}
                  style={{ width: 120, verticalAlign: "middle" }}
                />
              </span>
            ) : (
              <span className="block truncate">{c.title || "新对话"}</span>
            )}
            {status && (
              <span className="sr-only">
                {status === "running" ? "，正在生成" : "，有新回复"}
              </span>
            )}
          </button>
        )}
        {/* Desktop: the indicator shares the hidden action button's slot and
            yields to it on hover/focus, so the row never reflows. Mobile keeps
            the action button visible and adds a fixed-width slot before it. */}
        {!isRenaming && status && (
          <span
            className={`pointer-events-none inline-flex shrink-0 items-center justify-center transition-opacity duration-[120ms] ${
              isMobile
                ? "-mr-1.5 h-11 w-4"
                : `absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2 group-hover/row:opacity-0 group-focus-within/row:opacity-0 ${
                    menuOpen ? "opacity-0" : ""
                  }`
            }`}
            data-row-status={status}
            aria-hidden="true"
          >
            <RowStatusMark status={status} />
          </span>
        )}
        {!isRenaming && (
          <button
            className={`${
              isMobile ? "mr-1" : ""
            } shrink-0 items-center justify-center text-text-muted transition-[color,opacity] duration-[120ms] hover:text-text-primary focus-visible:text-text-primary focus-visible:outline-none ${
              isMobile ? "h-11 w-11" : "h-7 w-7"
            } ${
              isMobile
                ? "inline-flex"
                : "pointer-events-none inline-flex opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
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
        {/* Every row reveals a tilted pin at the trailing edge on hover; it
            toggles the pin in one click, darker while pinned. Desktop only:
            mobile reaches it from the sheet. */}
        {!isRenaming && !isMobile && (
          <button
            className={`mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-item ${
              // Pinned stays in the sidebar's muted gray; the solid glyph carries the state.
              c.pinned_at
                ? "text-text-muted"
                : "text-text-muted hover:text-text-primary focus-visible:text-text-primary"
            } opacity-0 pointer-events-none transition-[color,opacity] duration-[120ms] group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none`}
            aria-label={c.pinned_at ? "取消置顶" : "置顶"}
            aria-pressed={!!c.pinned_at}
            title={c.pinned_at ? "取消置顶" : "置顶"}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin(c.id);
            }}
          >
            <PinGlyph size={15} filled={!!c.pinned_at} />
          </button>
        )}
        {/* Desktop escapes the sidebar's overflow boundary; mobile uses a bottom sheet. */}
        {!isRenaming && menuOpen && !isMobile && options.renderDesktopMenu !== false && (
          createPortal(
            <div
              className={`history-menu fixed z-40 w-[156px] p-1.5 ${popoverSurface}`}
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
          <BottomSheet
            open={menuOpen}
            onClose={() => setMenu(null)}
            ariaLabel="会话操作"
            dimBackground={false}
          >
            {renderRowActions("mobile")}
          </BottomSheet>
        )}
      </div>
    );
  };

  const renderSectionHeader = (key: "pinned" | "recent", label: string) => {
    const folded = collapsedSections[key];
    return (
      <button
        type="button"
        className={`${quietSectionLabel} group/section flex w-full items-center gap-1 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring`}
        aria-expanded={!folded}
        onClick={() =>
          setCollapsedSections((current) => ({ ...current, [key]: !current[key] }))
        }
      >
        {label}
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
          className={`transition-[opacity,transform] duration-[120ms] ${
            folded
              ? "-rotate-90 opacity-100"
              : "opacity-0 group-hover/section:opacity-100 group-focus-visible/section:opacity-100"
          }`}
        />
      </button>
    );
  };

  const renderUserMenu = (compact: boolean, railPinned = false) => (
    <UserMenu
      user={user}
      isMobile={isMobile}
      compact={compact}
      railPinned={railPinned}
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
  );

  const railCollapsed = collapsed && !isMobile;
  const hasUnread = Object.values(rowStatus ?? {}).includes("unread");

  return (
    <>
      <aside
        className={sidebarClasses.join(" ")}
        aria-hidden={isMobile && !mobileOpen ? "true" : undefined}
        inert={isMobile && !mobileOpen ? true : undefined}
      >
        <div
          className={`relative h-full ${
            isMobile ? "w-full" : "w-[var(--sidebar-width)]"
          }`}
        >
          <div
            className={`flex h-full flex-col px-2.5 ${
              isMobile ? "w-full pb-2.5" : "w-[var(--sidebar-width)]"
            }`}
          >
            {/* The panel never moves. It stays fully opaque while the shell's
                right edge sweeps in over it, so the crop itself is the motion;
                the trailing fade only clears the residual strip before the rail
                board takes over. Expanding mirrors it. */}
            <div
              className={`flex min-h-0 flex-1 flex-col whitespace-nowrap ${
                isMobile
                  ? ""
                  : "will-change-[opacity] transition-opacity ease-linear motion-reduce:transition-none"
              } ${
                railCollapsed
                  ? "opacity-0 duration-[110ms] delay-[70ms]"
                  : "opacity-100 duration-[130ms] delay-[90ms]"
              }`}
              aria-hidden={railCollapsed ? "true" : undefined}
              inert={railCollapsed ? true : undefined}
            >
              {/* ChatGPT keeps the whole navigation column in one scrollport.
                  The sticky controls remain fixed while its scrollbar starts at
                  the very top of the sidebar. The negative end margin keeps the
                  native scrollbar lane flush with the sidebar edge. */}
              <div
                ref={historyRef}
                className="-mr-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto pr-2.5"
                data-testid="conversation-history"
                onScroll={handleHistoryScroll}
              >
                <div
                  className={`sticky top-0 z-20 flex shrink-0 items-center justify-between bg-sidebar px-2 ${
                    isMobile ? "pt-3 pb-3.5" : "h-13"
                  }`}
                >
                  <Wordmark size={isMobile ? 20 : 18} />
                  {!isMobile && (
                    <button
                      className={`${iconControl} h-9 w-9`}
                      aria-label="收起侧栏"
                      onClick={onToggleCollapsed}
                    >
                      <Icons.PanelLeft size={20} />
                    </button>
                  )}
                </div>

                <div
                  className={`sticky z-20 shrink-0 bg-sidebar ${
                    isMobile ? "top-[46px]" : "top-13 pt-2"
                  }`}
                >
                  <button
                    className={`flex min-h-9 w-full items-center gap-2.5 whitespace-nowrap px-2.5 text-left text-[13.5px] font-medium text-text-primary max-[760px]:min-h-11 max-[760px]:text-[15px] ${interactiveItem}`}
                    onClick={() => {
                      onNew();
                      if (isMobile) onCloseMobile();
                    }}
                  >
                    <Icons.NewChat size={20} />
                    新建对话
                  </button>
                  {onSearch && <button className={`flex min-h-9 w-full items-center gap-2.5 whitespace-nowrap px-2.5 text-left text-[13.5px] font-medium text-text-primary max-[760px]:min-h-11 max-[760px]:text-[15px] ${interactiveItem}`} onClick={() => { onSearch(); if (isMobile) onCloseMobile(); }}><Search size={20} strokeWidth={1.6} />搜索对话</button>}
                  <button className={`flex min-h-9 w-full items-center gap-2.5 whitespace-nowrap px-2.5 text-left text-[13.5px] font-medium text-text-primary max-[760px]:min-h-11 max-[760px]:text-[15px] ${interactiveItem}`} aria-haspopup="dialog" onClick={() => { onOpenFavorites(); if (isMobile) onCloseMobile(); }}><Star size={20} strokeWidth={1.6} />收藏</button>
                </div>

                {pinnedItems.length > 0 && (
                  <div className="mt-5 flex flex-col" aria-label="置顶" role="group">
                    {renderSectionHeader("pinned", "置顶")}
                    {!collapsedSections.pinned &&
                      pinnedItems.map((c) =>
                        renderRow(c, { renderDesktopMenu: !railCollapsed }),
                      )}
                  </div>
                )}

                <div className="mt-5 flex flex-col">
                  {(items.length > 0 || pinnedItems.length === 0) &&
                    renderSectionHeader("recent", "最近")}
                  {!collapsedSections.recent &&
                    items.map((c) =>
                      renderRow(c, { renderDesktopMenu: !railCollapsed }),
                    )}
                  {items.length === 0 && pinnedItems.length === 0 && !collapsedSections.recent &&
                    isLoadingList && (
                      <HistorySkeleton rows={historySkeletonWidths.length} label="正在加载对话" />
                    )}
                  {isLoadingMore && !collapsedSections.recent && (
                    <HistorySkeleton rows={3} label="正在加载更多对话" />
                  )}
                </div>
              </div>
            </div>

            {renderUserMenu(railCollapsed, !isMobile)}
          </div>

          {!isMobile && (
            <div
              className={`absolute inset-y-0 left-0 z-10 flex w-[var(--sidebar-rail-width)] flex-col items-center bg-sidebar px-1.5 pt-2 pb-2.5 transition-opacity ease-linear motion-reduce:transition-none ${
                railCollapsed
                  ? "pointer-events-auto opacity-100 duration-[110ms] delay-[110ms]"
                  : "pointer-events-none opacity-0 duration-[90ms] delay-0"
              }`}
              aria-hidden={railCollapsed ? undefined : "true"}
              inert={railCollapsed ? undefined : true}
            >
            <button
              className={`${railIconControl} h-9 w-9`}
              aria-label="展开侧栏"
              onClick={onToggleCollapsed}
            >
              <Icons.PanelLeft size={20} />
            </button>
            <button
              className={`${railIconControl} mt-4 h-9 w-9`}
              aria-label="新建对话"
              onClick={onNew}
            >
              <Icons.NewChat size={20} />
            </button>
            {onSearch && <button className={`${railIconControl} h-9 w-9`} aria-label="搜索对话" title="搜索对话" onClick={onSearch}><Search size={20} strokeWidth={1.6} /></button>}
            <button className={`${railIconControl} h-9 w-9`} aria-label="收藏" title="收藏" aria-haspopup="dialog" onClick={onOpenFavorites}><Star size={20} strokeWidth={1.6} /></button>
            <button
              ref={recentTriggerRef}
              className={`${railIconControl} relative h-9 w-9`}
              aria-label={hasUnread ? "最近聊天，有新回复" : "最近聊天"}
              aria-haspopup="true"
              aria-expanded={recent !== null}
              onClick={(event) => {
                event.stopPropagation();
                toggleRecent();
              }}
            >
              <Icons.Chats size={20} />
              {hasUnread && <UnreadBadge />}
            </button>
            </div>
          )}
        </div>
      </aside>
      {railCollapsed && recent !== null &&
        createPortal(
          <nav
            className={`rail-recent fixed z-40 max-h-[min(70vh,520px)] overflow-y-auto p-1.5 ${popoverSurface}`}
            style={{ left: recent.left, top: recent.top, width: railRecentWidth }}
            aria-label="最近聊天"
            onClick={(event) => event.stopPropagation()}
          >
            {pinnedItems.length > 0 && (
              <>
                <div className={`${quietSectionLabel} pt-1`}>置顶</div>
                {pinnedItems.map((c) => renderRow(c, { onSelected: () => setRecent(null) }))}
              </>
            )}
            <div className={`${quietSectionLabel} pt-1`}>最近</div>
            {items
              .slice(0, railRecentLimit)
              .map((c) => renderRow(c, { onSelected: () => setRecent(null) }))}
            {items.length === 0 && pinnedItems.length === 0 && isLoadingList && (
              <HistorySkeleton rows={5} label="正在加载对话" />
            )}
          </nav>,
          document.body,
        )}
      {isMobile && (
        <div
          className={`scrim fixed inset-0 z-[29] bg-overlay ${
            mobileOpen ? "show pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
          onClick={onCloseMobile}
          aria-hidden={!mobileOpen}
        />
      )}
    </>
  );
}

// Uneven title widths so the placeholder reads as a list of real titles.
const historySkeletonWidths = ["72%", "54%", "86%", "62%", "78%", "46%", "68%", "58%"];

// Title-bar placeholders on the exact history-row geometry, so loaded rows
// replace them without shifting the column. Lower rows fade out to suggest a
// list continuing below rather than a fixed count.
function HistorySkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true">
      {historySkeletonWidths.slice(0, rows).map((width, index) => (
        <div
          key={index}
          className="flex min-h-9 items-center px-2.5 max-[760px]:min-h-11"
          style={{ opacity: 1 - (index / rows) * 0.7 }}
          aria-hidden="true"
        >
          <span className={titleSkeleton} style={{ width }} />
        </div>
      ))}
    </div>
  );
}

function RowStatusMark({ status }: { status: ConversationRowStatus }) {
  return status === "running" ? (
    <Icons.Loading
      size={14}
      strokeWidth={2}
      className="animate-spin text-text-muted motion-reduce:animate-none"
      // Slower than animate-spin's 1s so several running rows read as calm.
      style={{ animationDuration: "1.5s" }}
    />
  ) : (
    <span className="h-2 w-2 rounded-full bg-[var(--color-unread-indicator)]" />
  );
}

// Corner dot for entry points that hide the history list (rail, mobile menu).
export function UnreadBadge() {
  return (
    <span
      className="pointer-events-none absolute top-1.5 right-1.5 h-[7px] w-[7px] rounded-full bg-[var(--color-unread-indicator)] ring-2 ring-sidebar"
      aria-hidden="true"
    />
  );
}
