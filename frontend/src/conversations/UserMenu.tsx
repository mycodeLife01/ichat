/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: user-menu · genre: modern-minimal · system: existing warm-neutral tokens */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Share2, UserRound } from "lucide-react";

import { Avatar } from "../ui/Avatar";
import { BottomSheet } from "../ui/BottomSheet";
import type { ToastHandler } from "../ui/state";
import {
  dangerMenuItem,
  interactiveItem,
  mobileActionItem,
  neutralMenuItem,
  popoverSurface,
} from "../ui/classes";
import { Icons } from "../ui/icons";
import { AccountCard } from "./AccountCard";
import { MySharesCard } from "./MySharesCard";
import type { UserShareResponse } from "../api/types";

type UserMenuProps = {
  user: { email: string; username: string; name: string; emailVerified: boolean; avatarUrl?: string | null } | null;
  isMobile: boolean;
  onLogout: () => void;
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onUploadAvatar?: (blob: Blob) => Promise<string>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
  onLoadShares: () => Promise<UserShareResponse[]>;
  onRevokeShare: (conversationId: string, token: string) => Promise<unknown>;
  onToast: ToastHandler;
};

function UserAvatar({ name, url, size = "md" }: { name: string; url?: string | null; size?: "sm" | "md" }) {
  return (
    <Avatar
      name={name}
      url={url}
      className={size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm"}
    />
  );
}

export function UserMenu({
  user,
  isMobile,
  onLogout,
  onResendVerification,
  onUpdateNickname,
  onUploadAvatar,
  onChangePassword,
  onRequestDeletion,
  onLoadShares,
  onRevokeShare,
  onToast,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [sharesOpen, setSharesOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const name = user?.name || "User";
  const email = user?.email || "you@example.com";

  const closeLogout = useCallback(() => {
    setLogoutOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (logoutOpen) cancelButtonRef.current?.focus();
  }, [logoutOpen]);

  useEffect(() => {
    if (isMobile) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    const closeOnResize = () => setOpen(false);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [isMobile]);

  useEffect(() => {
    if (!open && !logoutOpen && !accountOpen && !sharesOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (logoutOpen) closeLogout();
      else if (accountOpen) {
        setAccountOpen(false);
        triggerRef.current?.focus();
      } else if (sharesOpen) {
        setSharesOpen(false);
        triggerRef.current?.focus();
      }
      else {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accountOpen, closeLogout, logoutOpen, open, sharesOpen]);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (!isMobile && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const width = Math.min(rect.width, window.innerWidth - 16);
      setMenuPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        width,
      });
    }
    setOpen(true);
  };

  const openAccount = () => {
    setOpen(false);
    setAccountOpen(true);
  };
  const openShares = () => {
    setOpen(false);
    setSharesOpen(true);
  };
  const openLogout = () => {
    setOpen(false);
    setLogoutOpen(true);
  };

  const renderMenuContent = (surface: "desktop" | "mobile") => {
    const desktop = surface === "desktop";
    const actionClass = (danger = false) =>
      `${danger ? dangerMenuItem : neutralMenuItem} ${
        desktop ? "" : mobileActionItem
      }`;
    const role = desktop ? ("menuitem" as const) : undefined;
    return (
      <>
        <div className="mb-1 flex min-w-0 items-center gap-2.5 rounded-item px-2.5 py-2.5">
          <UserAvatar name={name} url={user?.avatarUrl} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-text-primary">
              {name}
            </span>
            <span className="block truncate text-[10.5px] text-text-muted">{email}</span>
          </span>
        </div>
        <div className="my-1 border-t border-border" />
        <button
          className={actionClass()}
          role={role}
          data-variant="neutral"
          onClick={openAccount}
        >
          <UserRound size={desktop ? 18 : 16} />
          <span>账号</span>
        </button>
        <button
          className={actionClass()}
          role={role}
          data-variant="neutral"
          onClick={openShares}
        >
          <Share2 size={desktop ? 18 : 16} />
          <span>我的分享</span>
        </button>
        <div className="my-1 border-t border-border" />
        <button
          className={actionClass(true)}
          role={role}
          data-variant="danger"
          onClick={openLogout}
        >
          <Icons.LogOut size={desktop ? 18 : 16} />
          <span>退出登录</span>
        </button>
      </>
    );
  };

  return (
    <div ref={rootRef} className="relative mt-2 border-t border-border pt-2 pb-1">
      <button
        ref={triggerRef}
        className={`flex min-h-11 w-full items-center gap-2.5 px-2.5 py-2 text-left aria-expanded:bg-selected ${interactiveItem}`}
        aria-expanded={open}
        aria-haspopup={isMobile ? "dialog" : "menu"}
        aria-label="打开个人中心"
        onClick={toggleMenu}
      >
        <UserAvatar name={name} url={user?.avatarUrl} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium leading-[1.35] text-fg">
            {name}
          </span>
          <span className="block font-medium truncate text-[12.5px] leading-[1.4] text-fg-subtle">
            Pro
          </span>
        </span>
      </button>

      {open && !isMobile && menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            className={`fixed z-40 max-h-[calc(100dvh-16px)] overflow-x-hidden overflow-y-auto p-1.5 ${popoverSurface}`}
            style={menuPosition}
            role="menu"
            aria-label="个人中心"
          >
            {renderMenuContent("desktop")}
          </div>,
          document.body,
        )}

      {isMobile && (
        <BottomSheet
          open={open}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          ariaLabel="个人中心"
          dimBackground={false}
        >
          {renderMenuContent("mobile")}
        </BottomSheet>
      )}

      {accountOpen && user &&
        createPortal(
          <AccountCard
            user={user}
            onClose={() => {
              setAccountOpen(false);
              triggerRef.current?.focus();
            }}
            onResendVerification={onResendVerification}
            onUpdateNickname={onUpdateNickname}
            onUploadAvatar={onUploadAvatar}
            onChangePassword={onChangePassword}
            onRequestDeletion={onRequestDeletion}
            onToast={onToast}
          />,
          document.body,
        )}

      {sharesOpen &&
        createPortal(
          <MySharesCard
            onClose={() => {
              setSharesOpen(false);
              triggerRef.current?.focus();
            }}
            onLoad={onLoadShares}
            onRevoke={onRevokeShare}
            onToast={onToast}
          />,
          document.body,
        )}

      {logoutOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.32)] p-4"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) closeLogout();
            }}
          >
            <div
              className="w-full max-w-[420px] rounded-xl border border-border-strong bg-bg-raised px-10 py-9 text-center shadow-[0_18px_60px_rgba(20,20,19,0.18)] max-[760px]:px-6 max-[760px]:py-7"
              role="dialog"
              aria-modal="true"
              aria-labelledby="logout-dialog-title"
            >
              <h2
                id="logout-dialog-title"
                className="text-xl font-semibold tracking-[-0.02em] text-fg"
              >
                你确定要退出登录吗？
              </h2>
              <div className="mt-6 flex items-center gap-3 rounded-xl border border-border-strong px-4 py-3.5 text-left">
                <UserAvatar name={name} url={user?.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-fg">{name}</div>
                  <div className="mt-0.5 truncate text-[11.5px] text-fg-muted">{email}</div>
                </div>
              </div>
              <div className="mt-5 inline-flex items-center gap-2 rounded-lg bg-bg-sunken px-3.5 py-2 text-[11.5px] text-fg-muted">
                <Info size={13} aria-hidden="true" />
                这将使你退出 iChat。
              </div>
              <div className="mt-5 flex flex-col gap-2">
                <button
                  className="inline-flex h-10 w-full items-center justify-center rounded-full bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-85"
                  onClick={onLogout}
                >
                  退出登录
                </button>
                <button
                  ref={cancelButtonRef}
                  className="inline-flex h-10 w-full items-center justify-center rounded-full border border-border-strong bg-bg-raised px-4 text-[13px] font-medium text-fg transition-colors hover:bg-bg-hover"
                  onClick={closeLogout}
                >
                  取消
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
