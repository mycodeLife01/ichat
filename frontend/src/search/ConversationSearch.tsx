import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Search, MessageCircle, CircleAlert } from "lucide-react";

import { ApiError } from "../api/errors";
import { conversationApi } from "../api/conversations";
import { ModalDialog } from "../ui/ModalDialog";
import { iconControl, interactiveItem, focusRing } from "../ui/classes";
import { Icons } from "../ui/icons";
import type { SearchItem, SearchPage, SearchRange } from "./types";

export function MatchText({
  text,
  match,
}: {
  text: string;
  match?: SearchRange | null;
}) {
  if (!match) return <>{text}</>;
  return (
    <>
      {text.slice(0, match.start)}
      <mark className="search-match">{text.slice(match.start, match.end)}</mark>
      {text.slice(match.end)}
    </>
  );
}

function dateGroup(value: string) {
  const now = new Date();
  const day = new Date(value);
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dayStart = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
  ).getTime();
  const days = Math.round((today - dayStart) / 86400000);
  return days === 0
    ? "今天"
    : days === 1
      ? "昨天"
      : days < 7
        ? "过去 7 天"
        : days < 30
          ? "过去 30 天"
          : `${day.getFullYear()} 年 ${day.getMonth() + 1} 月`;
}

export function ConversationSearch({
  open,
  onClose,
  onChoose,
  onStale,
  search = conversationApi.search,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (
    item: SearchItem,
    signal: AbortSignal,
    query: string,
  ) => Promise<void>;
  onStale: () => void;
  search?: typeof conversationApi.search;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<SearchPage>({
    items: [],
    next_cursor: null,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(-1);
  const [opening, setOpening] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollTop = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const choiceAbort = useRef<AbortController | null>(null);
  const moreLock = useRef(false);
  const revalidating = useRef(false);
  const cachedPage = useRef(page);
  cachedPage.current = page;
  const selectedRow = useRef<string | null>(null);
  selectedRow.current = page.items[active]?.conversation_id ?? null;
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);
  const lastQuery = useRef<string | null>(null);
  const seq = useRef(0);
  const normalized = query.replace(/\s+/g, " ").trim();
  const tooLong = [...query].length > 200;
  const composing = useRef(false);
  const [compositionDone, setCompositionDone] = useState(0);

  useEffect(() => {
    if (!open || composing.current) return;
    const request = ++seq.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const changed = lastQuery.current !== normalized;
    if (changed) {
      scrollTop.current = 0;
      scrollAnchor.current = null;
      setPage({ items: [], next_cursor: null });
      setActive(-1);
    }
    setLoadingMore(false);
    moreLock.current = false;
    setPageError(false);
    if (changed) setStatus("loading");
    if (tooLong) return () => controller.abort();
    revalidating.current = true;
    const previousCount = changed ? 0 : cachedPage.current.items.length;
    const timer = window.setTimeout(
      () => {
        void search({ q: normalized }, controller.signal)
          .then(async (result) => {
            while (
              !controller.signal.aborted &&
              request === seq.current &&
              result.next_cursor &&
              result.items.length < previousCount
            ) {
              const next = await search(
                { q: normalized, cursor: result.next_cursor },
                controller.signal,
              );
              result = {
                ...next,
                items: [
                  ...result.items,
                  ...next.items.filter(
                    (row) =>
                      !result.items.some(
                        (old) => old.conversation_id === row.conversation_id,
                      ),
                  ),
                ],
              };
            }
            if (controller.signal.aborted || request !== seq.current) return;
            setActive(
              result.items.length
                ? Math.max(
                    0,
                    result.items.findIndex(
                      (row) => row.conversation_id === selectedRow.current,
                    ),
                  )
                : -1,
            );
            setPage(result);
            lastQuery.current = normalized;
            setStatus("ready");
            requestAnimationFrame(() => {
              const element = list.current;
              if (!element || controller.signal.aborted) return;
              element.scrollTop = scrollTop.current;
              const anchor = scrollAnchor.current;
              const row =
                anchor &&
                [
                  ...element.querySelectorAll<HTMLElement>("[data-search-row]"),
                ].find((node) => node.dataset.conversationId === anchor.id);
              if (row && anchor)
                element.scrollTop +=
                  row.getBoundingClientRect().top -
                  element.getBoundingClientRect().top +
                  anchor.offset;
            });
          })
          .catch(() => {
            if (!controller.signal.aborted && request === seq.current)
              setStatus("error");
          })
          .finally(() => {
            if (request === seq.current) revalidating.current = false;
          });
      },
      normalized ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, normalized, retry, search, tooLong, compositionDone]);

  useEffect(() => {
    if (!open) {
      choiceAbort.current?.abort();
      setOpening(null);
    }
    return () => choiceAbort.current?.abort();
  }, [open]);

  const more = async () => {
    if (
      revalidating.current ||
      moreLock.current ||
      !page.next_cursor ||
      status !== "ready"
    )
      return;
    moreLock.current = true;
    setLoadingMore(true);
    setPageError(false);
    const request = seq.current;
    const signal = abort.current!.signal;
    try {
      const result = await search(
        { q: normalized, cursor: page.next_cursor },
        signal,
      );
      if (signal.aborted || request !== seq.current) return;
      setPage((previous) => ({
        ...result,
        items: [
          ...previous.items,
          ...result.items.filter(
            (item) =>
              !previous.items.some(
                (old) => old.conversation_id === item.conversation_id,
              ),
          ),
        ],
      }));
    } catch (error) {
      if (signal.aborted || request !== seq.current) return;
      if (error instanceof ApiError && error.code === "search_cursor_invalid") {
        scrollTop.current = 0;
        lastQuery.current = null;
        setRetry((value) => value + 1);
      } else setPageError(true);
    } finally {
      if (request === seq.current) {
        moreLock.current = false;
        setLoadingMore(false);
      }
    }
  };

  const choose = async (item: SearchItem) => {
    choiceAbort.current?.abort();
    const controller = new AbortController();
    choiceAbort.current = controller;
    setOpening(item.conversation_id);
    try {
      await onChoose(item, controller.signal, normalized);
      if (!controller.signal.aborted) onClose();
    } catch (error) {
      if (!controller.signal.aborted) {
        onStale();
        if (error instanceof ApiError && [403, 404].includes(error.status)) {
          setPage((previous) => ({
            ...previous,
            items: previous.items.filter(
              (row) => row.conversation_id !== item.conversation_id,
            ),
          }));
        }
      }
    } finally {
      if (!controller.signal.aborted) setOpening(null);
    }
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    const isTooLong = [...value].length > 200;
    if (
      value.replace(/\s+/g, " ").trim() === normalized &&
      isTooLong === tooLong
    )
      return;
    abort.current?.abort();
    choiceAbort.current?.abort();
    setOpening(null);
    setActive(-1);
    setStatus("loading");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.nativeEvent.isComposing ||
      composing.current ||
      status !== "ready"
    )
      return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(
          page.items.length - 1,
          active + (event.key === "ArrowDown" ? 1 : -1),
        ),
      );
      setActive(next);
      const rows =
        list.current?.querySelectorAll<HTMLElement>("[data-search-row]");
      rows?.[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && active >= 0 && page.items[active]) {
      event.preventDefault();
      void choose(page.items[active]);
    }
  };

  if (!open) return null;
  const EmptyIcon =
    status === "error" ? CircleAlert : normalized ? Search : MessageCircle;
  const emptyTitle = tooLong
    ? "搜索内容不能超过 200 个字符"
    : status === "error"
      ? "搜索失败，请重试"
      : normalized
        ? "未找到相关对话"
        : "还没有历史对话";
  const emptyDescription = tooLong
    ? "请缩短关键词后重试"
    : status === "error"
      ? "请检查网络连接后再试"
      : normalized
        ? "试试其他关键词，或缩短搜索内容"
        : "开始一段新对话后，可以在这里找到它";
  return createPortal(
    <ModalDialog
      titleId="conversation-search-title"
      onClose={onClose}
      className="conversation-search"
      backdropClassName="search-backdrop z-50"
    >
      <h2 id="conversation-search-title" className="sr-only">
        搜索历史对话
      </h2>
      <div className="flex h-[64px] shrink-0 items-center gap-3 border-b border-border px-5">
        <Search size={20} className="shrink-0 text-text-muted" aria-hidden />
        <input
          ref={searchInputRef}
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none"
          placeholder="搜索历史对话"
          aria-label="搜索历史对话"
          data-dialog-initial-focus
          value={query}
          role="combobox"
          aria-autocomplete="list"
          aria-controls="conversation-search-results"
          aria-expanded="true"
          aria-activedescendant={
            active >= 0 ? `search-result-${active}` : undefined
          }
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
            abort.current?.abort();
          }}
          onCompositionEnd={() => {
            composing.current = false;
            setCompositionDone((value) => value + 1);
          }}
        />
        {query && (
          <button
            className={`${iconControl} h-8 w-8`}
            aria-label="清空搜索"
            onClick={() => {
              updateQuery("");
              searchInputRef.current?.focus();
            }}
          >
            <Icons.Close size={18} />
          </button>
        )}
        <button
          className={`${iconControl} h-8 w-8`}
          aria-label="关闭搜索"
          onClick={onClose}
        >
          <Icons.Close size={20} />
        </button>
      </div>
      <div
        ref={list}
        className="search-results min-h-0 flex-1 overflow-y-auto p-2"
        id="conversation-search-results"
        role="listbox"
        aria-label="搜索结果"
        aria-busy={status === "loading" || loadingMore}
        onScroll={(event) => {
          const el = event.currentTarget;
          scrollTop.current = el.scrollTop;
          const first = [
            ...el.querySelectorAll<HTMLElement>("[data-search-row]"),
          ].find(
            (row) =>
              row.getBoundingClientRect().bottom >
              el.getBoundingClientRect().top,
          );
          scrollAnchor.current = first?.dataset.conversationId
            ? {
                id: first.dataset.conversationId,
                offset:
                  el.getBoundingClientRect().top -
                  first.getBoundingClientRect().top,
              }
            : null;
          if (
            el.scrollHeight - el.scrollTop - el.clientHeight < 100 &&
            !pageError
          )
            void more();
        }}
      >
        {tooLong ||
        status === "error" ||
        (status === "ready" && !page.items.length) ? (
          <div
            className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 text-center"
            role="status"
          >
            <EmptyIcon size={28} className="text-text-faint" aria-hidden />
            <div className="text-[15px] text-text-primary">{emptyTitle}</div>
            <p className="text-[13px] text-text-muted">{emptyDescription}</p>
            {status === "error" && !tooLong && (
              <button
                className={`${interactiveItem} px-4 py-2 text-sm`}
                onClick={() => setRetry((value) => value + 1)}
              >
                重试
              </button>
            )}
          </div>
        ) : status === "loading" ? (
          <div
            role="status"
            aria-label="正在搜索"
            className="space-y-3 px-3 py-4"
          >
            <span className="sr-only">正在搜索…</span>
            {[0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className="flex items-start gap-3 py-2 animate-pulse motion-reduce:animate-none"
                aria-hidden="true"
              >
                <div className="h-5 w-5 rounded-control bg-hover" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/5 rounded-detail bg-hover" />
                  <div className="h-3 w-4/5 rounded-detail bg-hover" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          page.items.map((item, index) => {
            const group = normalized ? dateGroup(item.updated_at) : "最近对话";
            const previous = index
              ? normalized
                ? dateGroup(page.items[index - 1].updated_at)
                : "最近对话"
              : null;
            return (
              <div key={item.conversation_id}>
                {group !== previous && (
                  <div className="px-3 pt-3 pb-2 text-xs text-text-muted">
                    {group}
                  </div>
                )}
                <button
                  type="button"
                  data-search-row
                  data-conversation-id={item.conversation_id}
                  id={`search-result-${index}`}
                  role="option"
                  aria-selected={active === index}
                  aria-busy={opening === item.conversation_id}
                  className={`search-result flex w-full items-start gap-3 rounded-item px-3 py-3 text-left ${focusRing} ${active === index ? "bg-hover" : "hover:bg-hover"}`}
                  onMouseMove={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onClick={() => void choose(item)}
                >
                  <Icons.Chats
                    size={20}
                    className="mt-0.5 shrink-0 text-text-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">
                      <MatchText
                        text={item.title || "新对话"}
                        match={item.title_match}
                      />
                    </div>
                    {item.snippet && (
                      <div className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-muted">
                        {item.snippet.truncated_before && "…"}
                        <MatchText
                          text={item.snippet.text}
                          match={item.snippet.match}
                        />
                        {item.snippet.truncated_after && "…"}
                      </div>
                    )}
                  </div>
                  {opening === item.conversation_id && (
                    <Icons.Loading
                      size={16}
                      className="shrink-0 animate-spin"
                    />
                  )}
                </button>
              </div>
            );
          })
        )}
        {status === "ready" && page.next_cursor && (
          <div className="flex justify-center p-2">
            <button
              className={`${interactiveItem} px-4 py-2 text-xs text-text-muted`}
              disabled={loadingMore}
              onClick={() => void more()}
            >
              {loadingMore
                ? "正在加载…"
                : pageError
                  ? "加载失败，点击重试"
                  : "加载更多"}
            </button>
          </div>
        )}
      </div>
    </ModalDialog>,
    document.body,
  );
}
