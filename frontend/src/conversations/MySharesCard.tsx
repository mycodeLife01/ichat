import { useEffect, useState } from "react";
import { Copy, Share2, Trash2, X } from "lucide-react";

import type { UserShareResponse } from "../api/types";
import { Icons } from "../ui/icons";
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

  useEffect(() => {
    let active = true;
    void onLoad().then(
      (items) => {
        if (!active) return;
        setShares(items);
        setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [onLoad]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.36)] p-6 backdrop-blur-[1px] max-[760px]:p-2"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="flex max-h-[calc(100vh-24px)] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-raised shadow-[0_24px_80px_rgba(20,20,19,0.22)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="my-shares-card-title"
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            aria-label="关闭我的分享"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-[180px] overflow-y-auto px-6 py-5 max-[760px]:px-4">
          {status === "loading" && (
            <div className="flex h-36 items-center justify-center" role="status" aria-label="加载中">
              <Icons.Loading className="animate-spin text-fg-muted" size={20} />
            </div>
          )}
          {status === "error" && (
            <div className="flex h-36 flex-col items-center justify-center text-center">
              <p className="text-[13px] text-fg-muted">分享列表加载失败</p>
              <button
                type="button"
                className="mt-3 rounded-md border border-border-strong px-3 py-1.5 text-[12px] text-fg"
                onClick={() => {
                  setStatus("loading");
                  void onLoad().then(
                    (items) => {
                      setShares(items);
                      setStatus("ready");
                    },
                    () => setStatus("error"),
                  );
                }}
              >
                重试
              </button>
            </div>
          )}
          {status === "ready" && shares.length === 0 && (
            <div className="flex h-36 flex-col items-center justify-center text-center text-fg-muted">
              <Share2 size={22} />
              <p className="mt-3 text-[13px]">还没有有效的会话分享</p>
            </div>
          )}
          {status === "ready" && shares.length > 0 && (
            <div className="flex flex-col gap-2">
              {shares.map((share) => (
                <article
                  key={share.token}
                  className="group rounded-lg border border-border px-4 py-3.5 transition-colors hover:border-border-strong hover:bg-bg"
                  aria-label={share.conversation_title || "未命名会话"}
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-sunken text-fg-muted">
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
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
                      aria-label="复制链接"
                      onClick={() => void copy(share.token)}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
                      aria-label="撤销分享"
                      disabled={revoking === share.token}
                      onClick={() => void revoke(share)}
                    >
                      {revoking === share.token ? (
                        <Icons.Loading className="animate-spin" size={14} />
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
      </section>
    </div>
  );
}
