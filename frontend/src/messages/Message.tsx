import { useState } from "react";

import type { MessageResponse } from "../api/types";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type MessageProps = {
  message: MessageResponse;
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
  mutateDisabledReason = null,
  onEditAndRegenerate,
  onRegenerate,
}: MessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const disabled = mutateDisabledReason !== null;

  if (message.role === "user") {
    if (editing) {
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
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
        <div className="msg-actions">
          <button className="msg-action" onClick={() => copy(message.content)}>
            <Icons.Copy size={12} />
            复制
          </button>
          <button
            className="msg-action"
            disabled={disabled}
            title={mutateDisabledReason ?? undefined}
            onClick={() => {
              setDraft(message.content);
              setEditing(true);
            }}
          >
            <Icons.Pencil size={12} />
            编辑并重发
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div style={{ flex: 1, minWidth: 0 }}>
        {message.reasoning && (
          <ThinkingBlock content={message.reasoning} streaming={false} />
        )}
        <Markdown content={message.content} />
        <div className="msg-actions">
          <button className="msg-action" onClick={() => copy(message.content)}>
            <Icons.Copy size={12} />
            复制
          </button>
          <button
            className="msg-action"
            disabled={disabled}
            title={mutateDisabledReason ?? undefined}
            onClick={() => onRegenerate?.(message.id)}
          >
            <Icons.Refresh size={12} />
            重新生成
          </button>
        </div>
      </div>
    </div>
  );
}
