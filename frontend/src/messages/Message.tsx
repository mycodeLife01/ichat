import { useState } from "react";

import type { MessageResponse } from "../api/types";
import { BottomSheet } from "../ui/BottomSheet";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type MessageProps = {
  message: MessageResponse;
  // On mobile, actions move behind a "更多" button into a BottomSheet; desktop
  // keeps the hover/focus action bar.
  isMobile?: boolean;
  // null = enabled; a string = disabled with that Chinese reason as the title.
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
  const disabled = mutateDisabledReason !== null;
  const isUser = message.role === "user";

  const startEditing = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const mutate = isUser ? startEditing : () => onRegenerate?.(message.id);
  const mutateLabel = isUser ? "编辑并重发" : "重新生成";
  const MutateIcon = isUser ? Icons.Pencil : Icons.Refresh;

  // Shared action buttons: a copy (always enabled) and the role's mutate action
  // (disabled with a reason while a run is active). Rendered both in the desktop
  // hover bar and the mobile sheet, with size/onClick tuned per surface.
  const actions = (size: number, afterAction?: () => void) => (
    <>
      <button
        className="msg-action"
        onClick={() => {
          copy(message.content);
          afterAction?.();
        }}
      >
        <Icons.Copy size={size} />
        复制
      </button>
      <button
        className="msg-action"
        disabled={disabled}
        title={mutateDisabledReason ?? undefined}
        onClick={() => {
          mutate();
          afterAction?.();
        }}
      >
        <MutateIcon size={size} />
        {mutateLabel}
      </button>
    </>
  );

  const actionBar = isMobile ? (
    <div className="msg-actions">
      <button className="msg-action" aria-label="更多" onClick={() => setSheetOpen(true)}>
        <Icons.More size={14} />
      </button>
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        {actions(15, () => setSheetOpen(false))}
      </BottomSheet>
    </div>
  ) : (
    <div className="msg-actions">{actions(12)}</div>
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
