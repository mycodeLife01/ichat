import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Copy, Share2, Trash2, X } from "lucide-react";

import type { UserShareResponse } from "../api/types";
import {
  buttonControl,
  cardSurface,
  dangerIconControl,
  iconControl,
} from "../ui/classes";
import { Icons } from "../ui/icons";
import { ModalDialog } from "../ui/ModalDialog";
import type { ToastHandler } from "../ui/state";

type MySharesCardProps = {
  onClose: () => void;
  onLoad: () => Promise<UserShareResponse[]>;
  onRevoke: (conversationId: string, token: string) => Promise<unknown>;
  onToast: ToastHandler;
};

function shareUrl(token: string) {
  return `${window.location.origin}/share/${token}`;
}

export function MySharesCard({ onClose, onLoad, onRevoke, onToast }: MySharesCardProps) {
  const [shares, setShares] = useState<UserShareResponse[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revoking, setRevoking] = useState<string | null>(null);

  // Shared by the mount effect and the retry button. `isCurrent` lets the
  // effect drop results that land after unmount.
  const load = useCallback(
    (isCurrent: () => boolean = () => true) => {
      setStatus("loading");
      void onLoad().then(
        (items) => {
          if (!isCurrent()) return;
          setShares(items);
          setStatus("ready");
        },
        () => {
          if (!isCurrent()) return;
          setStatus("error");
          onToast("分享列表加载失败", "error");
        },
      );
    },
    [onLoad, onToast],
  );

  useEffect(() => {
    let active = true;
    load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      onToast("链接已复制", "success");
    } catch {
      onToast("复制失败", "error");
    }
  };

  const revoke = async (share: UserShareResponse) => {
    if (revoking) return;
    setRevoking(share.token);
    try {
      await onRevoke(share.conversation_id, share.token);
      setShares((items) => items.filter((item) => item.token !== share.token));
      onToast("已撤销分享", "success");
    } catch {
      onToast("撤销失败", "error");
    } finally {
      setRevoking(null);
    }
  };

  const retry = () => {
    load();
  };

  return (
    <ModalDialog
      titleId="my-shares-card-title"
      onClose={onClose}
      className="flex max-h-[calc(100vh-24px)] w-full max-w-[720px] flex-col overflow-hidden"
      backdropClassName="z-50 p-6 max-[760px]:p-2"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4 max-[760px]:px-4">
        <div>
          <h2 id="my-shares-card-title" className="text-[16px] font-semibold text-fg">
            我的分享
          </h2>
          <p className="mt-1 text-[11px] text-fg-subtle">查看和管理你创建的全部会话分享。</p>
        </div>
        <button
          type="button"
          className={`${iconControl} h-8 w-8 shrink-0`}
          aria-label="关闭我的分享"
          data-dialog-initial-focus
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>

      <div className="min-h-[180px] overflow-y-auto px-6 py-5 max-[760px]:px-4">
        {status === "loading" && (
          <div className="flex h-36 items-center justify-center" role="status" aria-label="加载中">
            <Icons.Loading className="animate-spin text-text-muted" size={20} aria-hidden="true" />
          </div>
        )}
        {status === "error" && (
          <div
            className="flex h-36 flex-col items-center justify-center text-center text-error-foreground"
            role="alert"
            aria-atomic="true"
          >
            <CircleAlert size={20} strokeWidth={1.8} aria-hidden="true" />
            <p className="mt-3 text-[13px]">分享列表加载失败</p>
            <button
              type="button"
              className={`${buttonControl} mt-3 h-8 border border-border-strong px-3 text-[12px]`}
              onClick={retry}
            >
              重试
            </button>
          </div>
        )}
        {status === "ready" && shares.length === 0 && (
          <div
            className="flex h-36 flex-col items-center justify-center text-center text-text-muted"
            role="status"
            aria-atomic="true"
          >
            <Share2 size={22} aria-hidden="true" />
            <p className="mt-3 text-[13px]">还没有有效的会话分享</p>
          </div>
        )}
        {status === "ready" && shares.length > 0 && (
          <div className="flex flex-col gap-2">
            {shares.map((share) => (
              <article
                key={share.token}
                className={`${cardSurface} group px-4 py-3.5 transition-colors hover:border-border-strong hover:bg-canvas`}
                aria-label={share.conversation_title || "未命名会话"}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-sunken text-text-muted">
                    <Share2 size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[12.5px] font-medium text-fg">
                      {share.conversation_title || "未命名会话"}
                    </h3>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-fg-subtle">
                      <span>{new Date(share.created_at).toLocaleDateString()}</span>
                      <span>
                        {share.expires_at
                          ? `到期 ${new Date(share.expires_at).toLocaleDateString()}`
                          : "永不过期"}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${iconControl} h-8 w-8 shrink-0`}
                    aria-label="复制链接"
                    onClick={() => void copy(share.token)}
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    type="button"
                    className={`${dangerIconControl} h-8 w-8 shrink-0`}
                    aria-label="撤销分享"
                    disabled={revoking === share.token}
                    aria-busy={revoking === share.token}
                    onClick={() => void revoke(share)}
                  >
                    {revoking === share.token ? (
                      <Icons.Loading className="animate-spin" size={14} aria-hidden="true" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
