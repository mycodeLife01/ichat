import { useEffect, useState } from "react";
import { Search, Star } from "lucide-react";

import type { ConversationResponse } from "../api/types";
import { useAppActions } from "../app/context";
import { ModalDialog } from "../ui/ModalDialog";
import { focusRing, iconControl, interactiveItem } from "../ui/classes";
import { Icons } from "../ui/icons";

function shortDate(value: string) {
  const day = new Date(value);
  return `${day.getMonth() + 1} 月 ${day.getDate()} 日`;
}

// Favorites browser opened from the sidebar's resident entry. Rows are fixed
// when the dialog loads, so un-starring one keeps it in place (as an outline
// star) and can be undone until the dialog closes.
export function FavoritesDialog({
  selectedId,
  onClose,
  onChoose,
  onToggleFavorite,
}: {
  selectedId: string | null;
  onClose: () => void;
  onChoose: (id: string) => void;
  // Resolves to the saved favorite state, or null when the request failed.
  onToggleFavorite: (
    id: string,
    conversation: ConversationResponse,
  ) => Promise<boolean | null>;
}) {
  const { services } = useAppActions();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ConversationResponse[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    services.conversationApi.list({ view: "favorites" }).then(
      (items) => {
        if (!active) return;
        setRows(items);
        setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [retry, services]);

  const setRowFavorite = (id: string, favoritedAt: string | null) =>
    setRows((current) =>
      current.map((c) => (c.id === id ? { ...c, favorited_at: favoritedAt } : c)),
    );

  const toggle = async (c: ConversationResponse) => {
    const previous = c.favorited_at ?? null;
    setRowFavorite(c.id, previous ? null : new Date().toISOString());
    const saved = await onToggleFavorite(c.id, c);
    if (saved === null) setRowFavorite(c.id, previous);
  };

  const normalized = query.trim().toLowerCase();
  const visible = rows.filter(
      (c) => !normalized || (c.title || "新对话").toLowerCase().includes(normalized),
    );

  return (
    <ModalDialog
      titleId="favorites-title"
      onClose={onClose}
      className="conversation-search favorites-dialog"
      backdropClassName="search-backdrop z-50"
    >
      <h2 id="favorites-title" className="sr-only">
        收藏
      </h2>
      <div className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border px-5">
        <Search size={20} className="shrink-0 text-text-muted" aria-hidden />
        <input
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none"
          placeholder="在收藏中查找"
          aria-label="在收藏中查找"
          data-dialog-initial-focus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className={`${iconControl} h-9 w-9 shrink-0 max-[760px]:h-11 max-[760px]:w-11`}
          aria-label="关闭收藏"
          onClick={onClose}
        >
          <Icons.Close size={20} />
        </button>
      </div>
      <div className="search-results min-h-0 flex-1 overflow-y-auto p-2">
        {status === "loading" ? (
          <span role="status" aria-label="正在加载收藏" className="sr-only">
            正在加载收藏
          </span>
        ) : status === "error" ? (
          <div
            className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center"
            role="status"
          >
            <div className="text-[15px] text-text-primary">加载收藏失败</div>
            <button
              className={`${interactiveItem} px-4 py-2 text-sm`}
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div
            className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 text-center"
            role="status"
          >
            <Star size={28} strokeWidth={1.6} className="text-text-faint" aria-hidden />
            <div className="text-[15px] text-text-primary">
              {rows.length ? "没有匹配的收藏" : "还没有收藏的对话"}
            </div>
            {!rows.length && (
              <p className="text-[13px] text-text-muted">
                在对话的“更多”菜单中选择“收藏”，即可在这里快速找到。
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="px-3 pt-3 pb-2 text-xs text-text-muted">
              {normalized ? `${visible.length} 个匹配` : `全部收藏 · ${rows.length}`}
            </div>
            <ul aria-label="收藏的对话">
              {visible.map((c) => {
                const starred = !!c.favorited_at;
                return (
                  <li
                    key={c.id}
                    className="group/fav relative flex items-center rounded-item hover:bg-hover"
                  >
                    <button
                      type="button"
                      className={`flex min-w-0 flex-1 items-center gap-3 rounded-item py-3 pr-14 pl-3 text-left ${focusRing}`}
                      aria-current={c.id === selectedId ? "page" : undefined}
                      onClick={() => onChoose(c.id)}
                    >
                      <Icons.Chats size={20} className="shrink-0 text-text-muted" />
                      <span
                        className={`min-w-0 flex-1 truncate text-[15px] ${
                          starred ? "text-text-primary" : "text-text-muted"
                        }`}
                      >
                        {c.title || "新对话"}
                      </span>
                      <span className="shrink-0 text-[12.5px] text-text-muted tabular-nums">
                        {shortDate(c.updated_at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`${interactiveItem} absolute right-2 inline-flex h-9 w-9 items-center justify-center ${
                        starred ? "text-[var(--color-favorite)]" : "text-text-muted"
                      } max-[760px]:h-11 max-[760px]:w-11`}
                      aria-label={starred ? "取消收藏" : "重新收藏"}
                      aria-pressed={starred}
                      title={starred ? "取消收藏" : "重新收藏"}
                      onClick={() => void toggle(c)}
                    >
                      <Star
                        size={18}
                        strokeWidth={1.6}
                        fill={starred ? "currentColor" : "none"}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </ModalDialog>
  );
}
