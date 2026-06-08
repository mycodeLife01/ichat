import type { MessageResponse } from "../api/types";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type MessageProps = { message: MessageResponse };

const MUTATE_DISABLED_HINT = "即将接入";

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

export function Message({ message }: MessageProps) {
  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
        <div className="msg-actions">
          <button className="msg-action" onClick={() => copy(message.content)}>
            <Icons.Copy size={12} />
            复制
          </button>
          <button className="msg-action" disabled title={MUTATE_DISABLED_HINT}>
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
          <button className="msg-action" disabled title={MUTATE_DISABLED_HINT}>
            <Icons.Refresh size={12} />
            重新生成
          </button>
        </div>
      </div>
    </div>
  );
}
