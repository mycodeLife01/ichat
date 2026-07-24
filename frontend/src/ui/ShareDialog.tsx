import { useEffect, useState } from "react";

import type { ShareLinkResponse } from "../api/types";
import { useAppActions } from "../app/context";
import { dangerIconControl, focusRing, iconControl, primaryButton } from "./classes";
import { Icons } from "./icons";
import { ModalDialog } from "./ModalDialog";

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
  const [revoking, setRevoking] = useState(false);
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
        if (active) {
          dispatch({ type: "ui/showToast", message: "加载分享链接失败", tone: "error" });
        }
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
      () => dispatch({ type: "ui/showToast", message: "链接已复制", tone: "success" }),
      () => dispatch({ type: "ui/showToast", message: "复制失败", tone: "error" }),
    );
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const link = await services.shareApi.create(conversationId, EXPIRY_OPTIONS[expiryIndex].days);
      setActiveLink(link);
      // Creation succeeded regardless of what the clipboard does next; the
      // copy attempt then reports its own success/failure on top.
      dispatch({ type: "ui/showToast", message: "已创建分享链接", tone: "success" });
      copy(link.token);
    } catch {
      dispatch({ type: "ui/showToast", message: "创建分享失败", tone: "error" });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: string) => {
    if (revoking) return;
    setRevoking(true);
    try {
      await services.shareApi.revoke(conversationId, token);
      // The link is gone; the create form reappears so a new one can be minted.
      setActiveLink(null);
      dispatch({ type: "ui/showToast", message: "已撤销分享", tone: "success" });
    } catch {
      dispatch({ type: "ui/showToast", message: "撤销失败", tone: "error" });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <ModalDialog
      titleId="share-dialog-title"
      descriptionId="share-dialog-description"
      onClose={onClose}
      className="w-full max-w-[440px] p-[22px]"
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 id="share-dialog-title" className="text-[15px] font-semibold">
          分享对话
        </h3>
        <button
          type="button"
          className={`${iconControl} h-8 w-8`}
          aria-label="关闭"
          data-dialog-initial-focus
          onClick={onClose}
        >
          <Icons.Close size={15} />
        </button>
      </div>
      <p id="share-dialog-description" className="mb-4 text-[13px] leading-[1.6] text-text-muted">
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
            className="flex justify-center text-text-muted"
            role="status"
            aria-label="加载中"
          >
            <Icons.Loading className="animate-spin" size={18} aria-hidden="true" />
          </div>
        ) : activeLink ? (
          // One active link per conversation: show it with copy + revoke. To
          // issue a different one, revoke this first.
          <div className="flex items-center gap-2 rounded-item border border-border bg-canvas px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-text-primary">
                {shareUrl(activeLink.token)}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-muted">
                生效中
                {activeLink.expires_at && (
                  <> · 到期 {new Date(activeLink.expires_at).toLocaleDateString()}</>
                )}
              </div>
            </div>
            <button
              type="button"
              className={`${iconControl} h-8 w-8 shrink-0`}
              aria-label="复制链接"
              onClick={() => copy(activeLink.token)}
            >
              <Icons.Copy size={14} />
            </button>
            <button
              type="button"
              className={`${dangerIconControl} h-8 w-8 shrink-0`}
              aria-label="撤销链接"
              disabled={revoking}
              aria-busy={revoking}
              onClick={() => void revoke(activeLink.token)}
            >
              {revoking ? (
                <Icons.Loading className="animate-spin" size={14} aria-hidden="true" />
              ) : (
                <Icons.Trash size={14} />
              )}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1.5" role="radiogroup" aria-label="过期时间">
              {EXPIRY_OPTIONS.map((option, index) => (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={index === expiryIndex}
                  className={`rounded-control border px-3 py-1.5 text-[13px] ${focusRing} transition-colors duration-[120ms] ${
                    index === expiryIndex
                      ? "border-accent bg-accent text-accent-foreground"
                      : "border-border text-text-muted hover:bg-hover hover:text-text-primary"
                  }`}
                  onClick={() => setExpiryIndex(index)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`${primaryButton} ml-auto h-9 px-3.5 text-[13.5px] font-medium`}
              disabled={creating}
              aria-busy={creating}
              aria-label={creating ? "正在创建链接" : "创建链接"}
              onClick={() => void create()}
            >
              {/* Same stable-geometry pattern as LoadingButtonContent, with an
                  icon in the hidden layer so the button width never shifts. */}
              <span className="relative inline-flex items-center justify-center">
                <span
                  className={`inline-flex items-center gap-1.5 ${creating ? "opacity-0" : ""}`}
                >
                  <Icons.Share size={14} aria-hidden="true" />
                  创建链接
                </span>
                {creating && (
                  <Icons.Loading
                    className="absolute animate-spin"
                    size={15}
                    aria-hidden="true"
                  />
                )}
              </span>
            </button>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
