import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Share2, UserRound } from "lucide-react";

import { Icons } from "../ui/icons";
import { AccountCard } from "./AccountCard";
import { MySharesCard } from "./MySharesCard";
import type { UserShareResponse } from "../api/types";

type UserMenuProps = {
  user: { email: string; name: string; emailVerified: boolean } | null;
  onLogout: () => void;
  onResendVerification: () => Promise<unknown>;
  onUpdateNickname: (nickname: string) => Promise<unknown>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<unknown>;
  onRequestDeletion: (password: string) => Promise<unknown>;
  onLoadShares: () => Promise<UserShareResponse[]>;
  onRevokeShare: (conversationId: string, token: string) => Promise<unknown>;
  onToast: (message: string) => void;
};

function UserAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const sizeClass = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  return (
    <span
      className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-fg`}
      aria-hidden="true"
    >
      {(name || "U").slice(0, 1).toUpperCase()}
    </span>
  );
}

export function UserMenu({
  user,
  onLogout,
  onResendVerification,
  onUpdateNickname,
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
  const rootRef = useRef<HTMLDivElement>(null);
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
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

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
      else setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accountOpen, closeLogout, logoutOpen, open, sharesOpen]);

  return (
    <div ref={rootRef} className="relative mt-2 border-t border-border pt-2 pb-1">
      <button
        ref={triggerRef}
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-150 ${
          open ? "bg-bg-active" : "hover:bg-bg-hover"
        }`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="打开个人中心"
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar name={name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium leading-[1.35] text-fg">
            {name}
          </span>
          <span className="block font-medium truncate text-[12.5px] leading-[1.4] text-fg-subtle">
            Pro
          </span>
        </span>
      </button>

      {open && (
        <div
          className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-full rounded-xl border border-border-strong bg-bg-raised p-1.5 shadow-[0_14px_42px_rgba(20,20,19,0.16)]"
          role="menu"
          aria-label="个人中心"
        >
          <div className="mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2.5">
            <UserAvatar name={name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-fg">{name}</span>
              <span className="block truncate text-[10.5px] text-fg-subtle">{email}</span>
            </span>
          </div>
          <div className="my-1 border-t border-border" />
          <button
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-fg transition-colors hover:bg-bg-hover"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAccountOpen(true);
            }}
          >
            <span className="flex h-5 w-5 items-center justify-center">
              <UserRound size={15} />
            </span>
            <span>账号</span>
          </button>
          <button
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-fg transition-colors hover:bg-bg-hover"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setSharesOpen(true);
            }}
          >
            <span className="flex h-5 w-5 items-center justify-center">
              <Share2 size={15} />
            </span>
            <span>我的分享</span>
          </button>
          <div className="my-1 border-t border-border" />
          <button
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-danger transition-colors hover:bg-danger-soft"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setLogoutOpen(true);
            }}
          >
            <span className="flex h-5 w-5 items-center justify-center">
              <Icons.LogOut size={15} />
            </span>
            <span>退出登录</span>
          </button>
        </div>
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
                <UserAvatar name={name} />
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
