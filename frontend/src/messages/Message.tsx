import { useEffect, useRef, useState } from "react";

import type { MessageResponse } from "../api/types";
import { BottomSheet } from "../ui/BottomSheet";
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
        className="msg-action"
        onClick={() => {
          copy(message.content);
          afterAction();
        }}
      >
        <Icons.Copy size={15} />
        复制
      </button>
      <button
        className="msg-action"
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
  const desktopBar = (
    <div className={`msg-actions${isUser ? "" : " resident"}`}>
      <MessageAction
        label={copied ? "已复制" : "复制"}
        icon={
          <span className="copy-swap" data-copied={copied}>
            <Icons.Copy size={15} />
            <Icons.Check size={15} />
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
    <div className="msg-actions">
      <button className="msg-action" aria-label="更多" onClick={() => setSheetOpen(true)}>
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
      <div className="msg user">
        <div className="edit-box">
          <textarea
            autoFocus
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
          <div className="edit-actions">
            <button className="ghost-btn" onClick={cancel}>
              取消
            </button>
            <button className="primary-btn" onClick={save} disabled={draft.trim() === ""}>
              保存
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
        {actionBar}
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div style={{ flex: 1, minWidth: 0 }}>
        {message.reasoning && <ThinkingBlock content={message.reasoning} streaming={false} />}
        <Markdown content={message.content} />
        {actionBar}
      </div>
    </div>
  );
}
