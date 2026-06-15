import { useEffect, useRef, useState } from "react";

import type { MessageResponse, MessageSource } from "../api/types";
import { BottomSheet } from "../ui/BottomSheet";
import { ghostBtn, primaryBtn, sheetItem } from "../ui/classes";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { MessageAction } from "./MessageAction";
import { SourceFavicon } from "./SourcesPanel";
import { ThinkingBlock } from "./ThinkingBlock";

type MessageProps = {
  message: MessageResponse;
  // On mobile, assistant actions stay resident; user actions open in a
  // BottomSheet via long-press on the bubble. Desktop shows an icon-only
  // action bar with hover-dropdown labels.
  isMobile?: boolean;
  // null = enabled; a string = disabled with that Chinese reason.
  mutateDisabledReason?: string | null;
  onEditAndRegenerate?: (messageId: number, content: string) => void;
  onRegenerate?: (messageId: number) => void;
  // Opens the sources side panel (AppShell owns the panel state).
  onShowSources?: (sources: MessageSource[]) => void;
};

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

// `group` drives the action bar's hover/focus reveal; `scroll-mt-[60px]`
// preserves the .msg scroll-margin used by intent-based thread scrolling.
const msgBase = "msg group flex scroll-mt-[60px] flex-col gap-1.5";

// Edit textarea grows with content up to this cap, then scrolls.
const EDIT_MAX_HEIGHT = 480;

// Long user messages are clipped to this height with an expand toggle.
const COLLAPSE_MAX_HEIGHT = 320;

export function Message({
  message,
  isMobile = false,
  mutateDisabledReason = null,
  onEditAndRegenerate,
  onRegenerate,
  onShowSources,
}: MessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Long user messages collapse to COLLAPSE_MAX_HEIGHT with an expand toggle;
  // `overflowing` is measured from the rendered content.
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mobile user messages have no visible action button (no hover on touch);
  // a long-press on the bubble opens the action sheet instead.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const disabled = mutateDisabledReason !== null;
  const isUser = message.role === "user";

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    [],
  );

  // Auto-grow the edit textarea to fit its content (same pattern as the
  // Composer); beyond EDIT_MAX_HEIGHT it scrolls.
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, EDIT_MAX_HEIGHT)}px`;
  }, [editing, draft]);

  // Detect whether the bubble content exceeds the collapse cap. Re-measure on
  // resize since reflow changes the wrapped height.
  useEffect(() => {
    if (editing) return;
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSE_MAX_HEIGHT);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [editing, message.content]);

  const startLongPress = () => {
    longPressTimer.current = setTimeout(() => setSheetOpen(true), 450);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const startEditing = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const mutate = isUser ? startEditing : () => onRegenerate?.(message.id);
  const mutateLabel = isUser ? "编辑并重发" : "重新生成";
  const MutateIcon = isUser ? Icons.Pencil : Icons.Refresh;

  // Copy shows a transient check (已复制) before reverting to the copy icon.
  const handleCopy = () => {
    copy(message.content);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  // Mobile sheet rows match the sidebar's conversation menu sheet (sheetItem).
  const sheetActions = (afterAction: () => void) => (
    <>
      <button
        className={`${sheetItem} text-fg`}
        onClick={() => {
          copy(message.content);
          afterAction();
        }}
      >
        <Icons.Copy size={15} />
        复制
      </button>
      <button
        className={`${sheetItem} text-fg`}
        disabled={disabled}
        title={mutateDisabledReason ?? undefined}
        onClick={() => {
          mutate();
          afterAction();
        }}
      >
        <MutateIcon size={15} />
        {mutateLabel}
      </button>
    </>
  );

  // Desktop bar: icon-only actions with a hover-dropdown label. The assistant
  // bar is always visible (resident); the user bar reveals on message hover.
  // Copy cross-fades to a check (已复制); both icons stay mounted so the swap
  // doesn't remount a node under the cursor (which would re-open the dropdown).
  // The bar reveals on message hover/focus via the parent `group`; the
  // assistant bar is always visible (resident).
  const actionsBase =
    "msg-actions mt-1 flex gap-0.5 transition-opacity duration-[120ms] " +
    "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
  const desktopBar = (
    <div
      className={`${actionsBase}${isUser ? " justify-end" : " resident opacity-100"}`}
    >
      <MessageAction
        label={copied ? "已复制" : "复制"}
        icon={
          <span className="copy-swap relative inline-flex h-[18px] w-[18px]" data-copied={copied}>
            <Icons.Copy
              size={18}
              className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? " opacity-0" : ""}`}
            />
            <Icons.Check
              size={18}
              className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? "" : " opacity-0"}`}
            />
          </span>
        }
        onClick={handleCopy}
      />
      <MessageAction
        label={mutateLabel}
        icon={<MutateIcon size={18} />}
        onClick={mutate}
        disabled={disabled}
        disabledReason={mutateDisabledReason}
      />
    </div>
  );

  // Mobile: assistant actions stay resident (the desktop bar already is — no
  // hover exists on touch); user actions open via long-press on the bubble.
  const actionBar =
    isMobile && isUser ? (
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        {sheetActions(() => setSheetOpen(false))}
      </BottomSheet>
    ) : (
      desktopBar
    );

  if (isUser && editing) {
    const save = () => {
      const trimmed = draft.trim();
      if (trimmed === "") return;
      setEditing(false);
      onEditAndRegenerate?.(message.id, trimmed);
    };
    const cancel = () => {
      setDraft(message.content);
      setEditing(false);
    };
    return (
      <div className={`${msgBase} user items-end`}>
        {/* Full thread width (matches the reading column) so long content has
            room; the textarea auto-grows, so short content still gets a
            comfortable editing area via min-h. */}
        <div className="w-full animate-edit-in rounded-lg border border-border-strong bg-bg-sunken px-3.5 py-2.5">
          {/* p-[2px] preserves the UA default padding the pre-Tailwind version
              never reset (preflight zeroes it, shifting text wrapping); inline-block
              (the default — no `block`) keeps the old baseline gap below the box. */}
          <textarea
            autoFocus
            ref={editRef}
            className="min-h-[88px] w-full resize-none overflow-y-auto border-none bg-transparent p-[2px] text-[15.5px] leading-[1.55] text-fg outline-none max-[760px]:text-[17px]"
            style={{ maxHeight: `${EDIT_MAX_HEIGHT}px` }}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                save();
              }
              if (event.key === "Escape") cancel();
            }}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button className={ghostBtn} onClick={cancel}>
              取消
            </button>
            <button className={primaryBtn} onClick={save} disabled={draft.trim() === ""}>
              保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isUser) {
    const collapsed = overflowing && !expanded;
    return (
      <div className={`${msgBase} user items-end`}>
        <div
          className={`max-w-[78%] rounded-[10px] border border-border bg-bg-sunken px-3 py-2 text-[15.5px] leading-[1.55] text-fg max-[760px]:max-w-[86%] max-[760px]:text-[17px]${
            isMobile ? " select-none [-webkit-touch-callout:none]" : ""
          }`}
          onTouchStart={isMobile ? startLongPress : undefined}
          onTouchEnd={isMobile ? cancelLongPress : undefined}
          onTouchMove={isMobile ? cancelLongPress : undefined}
          onTouchCancel={isMobile ? cancelLongPress : undefined}
          // Android fires contextmenu on long-press — keep the sheet, not the
          // system menu. (select-none/touch-callout cover iOS selection.)
          onContextMenu={isMobile ? (event) => event.preventDefault() : undefined}
        >
          <div className="relative">
            <div
              ref={contentRef}
              className="whitespace-pre-wrap wrap-anywhere"
              style={collapsed ? { maxHeight: `${COLLAPSE_MAX_HEIGHT}px`, overflow: "hidden" } : undefined}
            >
              {message.content}
            </div>
            {/* Fade the clipped last line into the bubble background. */}
            {collapsed && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-bg-sunken to-transparent" />
            )}
          </div>
          {overflowing && (
            <button
              className="mt-1.5 inline-flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[13px] font-medium text-fg-muted transition-colors duration-[120ms] hover:text-fg"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起" : "展开"}
              <Icons.Chevron
                size={13}
                className={`transition-transform duration-[160ms]${expanded ? " rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
        {actionBar}
      </div>
    );
  }

  const sources = message.metadata?.sources ?? [];
  return (
    <div className={`${msgBase} assistant items-stretch`}>
      <div className="min-w-0 flex-1">
        {message.reasoning && <ThinkingBlock content={message.reasoning} streaming={false} />}
        {/* Pass the raw (possibly undefined) sources ref, not the `?? []`
            fallback, so Markdown's memo stays stable across unrelated re-renders
            (a fresh [] each render would bust it). */}
        <Markdown content={message.content} sources={message.metadata?.sources} isMobile={isMobile} />
        {sources.length > 0 && (
          <SourcesTrigger sources={sources} onClick={() => onShowSources?.(sources)} />
        )}
        {actionBar}
      </div>
    </div>
  );
}

// ChatGPT-style trigger pill: stacked favicons of the first sources plus a
// 「来源」 label; clicking opens the sources side panel.
function SourcesTrigger({
  sources,
  onClick,
}: {
  sources: MessageSource[];
  onClick: () => void;
}) {
  return (
    <button
      className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-bg-sunken py-1 pr-3 pl-1.5 text-[12.5px] text-fg-muted transition-colors duration-[120ms] hover:bg-bg-hover hover:text-fg"
      type="button"
      aria-label={`查看 ${sources.length} 个来源`}
      onClick={onClick}
    >
      <span className="flex items-center -space-x-1.5">
        {sources.slice(0, 3).map((source) => (
          <span
            key={`${source.id}:${source.url}`}
            className="inline-flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-full border border-border bg-bg-raised"
          >
            <SourceFavicon url={source.url} size={12} />
          </span>
        ))}
      </span>
      来源
    </button>
  );
}
