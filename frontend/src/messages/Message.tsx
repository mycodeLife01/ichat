import { useEffect, useRef, useState } from "react";

import type { MessageResponse } from "../api/types";
import { BottomSheet } from "../ui/BottomSheet";
import { ghostBtn, msgAction, primaryBtn } from "../ui/classes";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { MessageAction } from "./MessageAction";
import { ThinkingBlock } from "./ThinkingBlock";

type MessageProps = {
  message: MessageResponse;
  // On mobile, actions move behind a "更多" button into a BottomSheet; desktop
  // shows an icon-only action bar with hover-dropdown labels.
  isMobile?: boolean;
  // null = enabled; a string = disabled with that Chinese reason.
  mutateDisabledReason?: string | null;
  onEditAndRegenerate?: (messageId: number, content: string) => void;
  onRegenerate?: (messageId: number) => void;
};

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

// `group` drives the action bar's hover/focus reveal; `scroll-mt-[60px]`
// preserves the .msg scroll-margin used by intent-based thread scrolling.
const msgBase = "msg group flex scroll-mt-[60px] flex-col gap-1.5";

export function Message({
  message,
  isMobile = false,
  mutateDisabledReason = null,
  onEditAndRegenerate,
  onRegenerate,
}: MessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disabled = mutateDisabledReason !== null;
  const isUser = message.role === "user";

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

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

  // Mobile sheet keeps readable text rows (icon + label).
  const sheetActions = (afterAction: () => void) => (
    <>
      <button
        className={`${msgAction} px-2 py-1`}
        onClick={() => {
          copy(message.content);
          afterAction();
        }}
      >
        <Icons.Copy size={15} />
        复制
      </button>
      <button
        className={`${msgAction} px-2 py-1`}
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
          <span className="copy-swap relative inline-flex h-[15px] w-[15px]" data-copied={copied}>
            <Icons.Copy
              size={15}
              className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? " opacity-0" : ""}`}
            />
            <Icons.Check
              size={15}
              className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? "" : " opacity-0"}`}
            />
          </span>
        }
        onClick={handleCopy}
      />
      <MessageAction
        label={mutateLabel}
        icon={<MutateIcon size={15} />}
        onClick={mutate}
        disabled={disabled}
        disabledReason={mutateDisabledReason}
      />
    </div>
  );

  const actionBar = isMobile ? (
    <div className={`${actionsBase}${isUser ? " justify-end" : ""}`}>
      <button
        className={`${msgAction} px-2 py-1`}
        aria-label="更多"
        onClick={() => setSheetOpen(true)}
      >
        <Icons.More size={14} />
      </button>
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        {sheetActions(() => setSheetOpen(false))}
      </BottomSheet>
    </div>
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
        <div className="w-full max-w-[78%] rounded-lg border border-border-strong bg-bg-sunken px-3.5 py-2.5">
          {/* p-[2px] preserves the UA default padding the pre-Tailwind version
              never reset (preflight zeroes it, shifting text wrapping); inline-block
              (the default — no `block`) keeps the old baseline gap below the box. */}
          <textarea
            autoFocus
            className="min-h-6 w-full resize-none border-none bg-transparent p-[2px] text-[14.5px] leading-[1.55] text-fg outline-none"
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
    return (
      <div className={`${msgBase} user items-end`}>
        <div className="max-w-[78%] rounded-[10px] border border-border bg-bg-sunken px-3.5 py-2.5 text-[14.5px] leading-[1.55] whitespace-pre-wrap text-fg max-[760px]:max-w-[86%] max-[760px]:text-[15px]">
          {message.content}
        </div>
        {actionBar}
      </div>
    );
  }

  return (
    <div className={`${msgBase} assistant items-stretch`}>
      <div className="min-w-0 flex-1">
        {message.reasoning && <ThinkingBlock content={message.reasoning} streaming={false} />}
        <Markdown content={message.content} />
        {actionBar}
      </div>
    </div>
  );
}
