import { useEffect, useState } from "react";

import type { ShareLinkResponse } from "../api/types";
import { useAppActions } from "../app/context";
import { ghostBtn, primaryBtn } from "./classes";
import { Icons } from "./icons";

type ShareDialogProps = {
  conversationId: string;
  onClose: () => void;
};

// Expiry presets. null = never expires.
const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "7 天", days: 7 },
  { label: "30 天", days: 30 },
  { label: "永不", days: null },
];

function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}

export function ShareDialog({ conversationId, onClose }: ShareDialogProps) {
  const { services, dispatch } = useAppActions();
  const [expiryIndex, setExpiryIndex] = useState(0);
  // The API returns only the active link (at most one per conversation);
  // revoked/expired rows are retained server-side for audit but never shown.
  const [activeLink, setActiveLink] = useState<ShareLinkResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void services.shareApi
      .list(conversationId)
      .then((items) => {
        if (active) setActiveLink(items[0] ?? null);
      })
      .catch(() => {
        if (active) dispatch({ type: "ui/showToast", message: "加载分享链接失败" });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [conversationId, services, dispatch]);

  const copy = (token: string) => {
    navigator.clipboard?.writeText(shareUrl(token)).then(
      () => dispatch({ type: "ui/showToast", message: "链接已复制" }),
      () => dispatch({ type: "ui/showToast", message: "复制失败" }),
    );
  };

  const create = async () => {
    setCreating(true);
    try {
      const link = await services.shareApi.create(conversationId, EXPIRY_OPTIONS[expiryIndex].days);
      setActiveLink(link);
      copy(link.token);
    } catch {
      dispatch({ type: "ui/showToast", message: "创建分享失败" });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: string) => {
    try {
      await services.shareApi.revoke(conversationId, token);
      // The link is gone; the create form reappears so a new one can be minted.
      setActiveLink(null);
      dispatch({ type: "ui/showToast", message: "已撤销分享" });
    } catch {
      dispatch({ type: "ui/showToast", message: "撤销失败" });
    }
  };

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.4)] p-6"
      onClick={onClose}
    >
      <div
        className="dialog flex w-full max-w-[440px] flex-col rounded-lg border border-border-strong bg-bg-raised p-[22px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">分享对话</h3>
          <button className={ghostBtn} aria-label="关闭" onClick={onClose}>
            <Icons.Close size={15} />
          </button>
        </div>
        <p className="mb-4 text-[13px] leading-[1.6] text-fg-muted">
          创建一个只读链接，任何人都可查看此刻的会话快照。之后的新消息不会出现在链接中。
        </p>

        {/* Reserve a stable min-height across the loading / active-link /
            create-form states so swapping between them doesn't jolt the
            dialog's height (the list call resolves fast, so the brief loading
            state would otherwise flash a visible resize). Shorter states are
            centered within the reserved height. */}
        <div className="flex min-h-[60px] flex-col justify-center">
          {loading ? (
            <div
              className="flex justify-center text-fg-subtle"
              role="status"
              aria-label="加载中"
            >
              <Icons.Loading className="animate-spin" size={18} />
            </div>
          ) : activeLink ? (
            // One active link per conversation: show it with copy + revoke. To
            // issue a different one, revoke this first.
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded-md border border-border bg-bg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-fg">{shareUrl(activeLink.token)}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-subtle">
                    生效中
                    {activeLink.expires_at && (
                      <> · 到期 {new Date(activeLink.expires_at).toLocaleDateString()}</>
                    )}
                  </div>
                </div>
                <button
                  className={ghostBtn}
                  aria-label="复制链接"
                  onClick={() => copy(activeLink.token)}
                >
                  <Icons.Copy size={14} />
                </button>
                <button
                  className={`${ghostBtn} hover:text-danger`}
                  aria-label="撤销链接"
                  onClick={() => void revoke(activeLink.token)}
                >
                  <Icons.Trash size={14} />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5" role="radiogroup" aria-label="过期时间">
                {EXPIRY_OPTIONS.map((option, index) => (
                  <button
                    key={option.label}
                    role="radio"
                    aria-checked={index === expiryIndex}
                    className={`rounded-md border px-3 py-1.5 text-[13px] transition-colors duration-[120ms] ${
                      index === expiryIndex
                        ? "border-accent bg-accent text-accent-fg"
                        : "border-border text-fg-muted hover:bg-bg-hover hover:text-fg"
                    }`}
                    onClick={() => setExpiryIndex(index)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button
                className={`${primaryBtn} ml-auto inline-flex items-center gap-1.5`}
                disabled={creating}
                onClick={() => void create()}
              >
                <Icons.Share size={14} />
                创建链接
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
