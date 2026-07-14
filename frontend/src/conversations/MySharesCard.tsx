import { useEffect, useState } from "react";
import { Copy, Link2, Trash2, X } from "lucide-react";

import type { UserShareResponse } from "../api/types";
import { Icons } from "../ui/icons";

type MySharesCardProps = {
  onClose: () => void;
  onLoad: () => Promise<UserShareResponse[]>;
  onRevoke: (conversationId: string, token: string) => Promise<unknown>;
  onToast: (message: string) => void;
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
      onToast("链接已复制");
    } catch {
      onToast("复制失败");
    }
  };

  const revoke = async (share: UserShareResponse) => {
    if (revoking) return;
    setRevoking(share.token);
    try {
      await onRevoke(share.conversation_id, share.token);
      setShares((items) => items.filter((item) => item.token !== share.token));
      onToast("已撤销分享");
    } catch {
      onToast("撤销失败");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.32)] p-4"
      onClick={onClose}
    >
      <section
        className="flex max-h-[min(680px,calc(100vh-32px))] w-full max-w-[620px] flex-col rounded-xl border border-border-strong bg-bg-raised p-6 shadow-[0_18px_60px_rgba(20,20,19,0.18)] max-[760px]:p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="my-shares-card-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between">
          <div>
            <h2 id="my-shares-card-title" className="text-lg font-semibold text-fg">
              我的分享
            </h2>
            <p className="mt-1 text-[12px] text-fg-muted">管理你创建的有效会话分享。</p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:text-fg"
            aria-label="关闭我的分享"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="mt-5 min-h-[140px] overflow-y-auto">
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
              <Link2 size={22} />
              <p className="mt-3 text-[13px]">还没有有效的会话分享</p>
            </div>
          )}
          {status === "ready" && shares.length > 0 && (
            <div className="divide-y divide-border border-y border-border">
              {shares.map((share) => (
                <article
                  key={share.token}
                  className="flex items-center gap-4 py-4"
                  aria-label={share.conversation_title || "未命名会话"}
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[13.5px] font-medium text-fg">
                      {share.conversation_title || "未命名会话"}
                    </h3>
                    <p className="mt-1 text-[11.5px] text-fg-muted">
                      创建于 {new Date(share.created_at).toLocaleDateString()}
                      {share.expires_at
                        ? ` · 到期 ${new Date(share.expires_at).toLocaleDateString()}`
                        : " · 永不过期"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:text-fg"
                    aria-label="复制链接"
                    onClick={() => void copy(share.token)}
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:text-danger disabled:opacity-50"
                    aria-label="撤销分享"
                    disabled={revoking === share.token}
                    onClick={() => void revoke(share)}
                  >
                    {revoking === share.token ? (
                      <Icons.Loading className="animate-spin" size={15} />
                    ) : (
                      <Trash2 size={15} />
                    )}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
