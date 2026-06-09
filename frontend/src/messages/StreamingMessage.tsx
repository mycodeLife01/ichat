import type { ActiveRunState } from "../runs/state";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type StreamingMessageProps = { run: NonNullable<ActiveRunState> };

export function StreamingMessage({ run }: StreamingMessageProps) {
  const isStreaming =
    run.status === "queued" ||
    run.status === "started" ||
    run.status === "streaming" ||
    run.status === "cancelling";
  const thinking = isStreaming && run.draftText === "";

  return (
    <div className="msg assistant">
      <div style={{ flex: 1, minWidth: 0 }}>
        {run.draftReasoning && (
          <ThinkingBlock content={run.draftReasoning} streaming={thinking} />
        )}
        <Markdown content={run.draftText} />
        {isStreaming && <span className="caret" />}
        {run.status === "cancelled" && (
          <div className="status-pill stopped">
            <span
              style={{ width: 8, height: 8, background: "var(--fg-subtle)", borderRadius: 2 }}
            />
            已停止
          </div>
        )}
        {run.status === "failed" && (
          <div className="status-pill failed">
            <Icons.Close size={12} />
            生成失败 · 请稍后重试
          </div>
        )}
      </div>
    </div>
  );
}
