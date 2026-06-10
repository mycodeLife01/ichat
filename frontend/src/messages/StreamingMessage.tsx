import type { ActiveRunState } from "../runs/state";
import { Icons } from "../ui/icons";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type StreamingMessageProps = { run: NonNullable<ActiveRunState> };

const statusPill =
  "mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-[3px] text-xs";

export function StreamingMessage({ run }: StreamingMessageProps) {
  const isStreaming =
    run.status === "queued" ||
    run.status === "started" ||
    run.status === "streaming" ||
    run.status === "cancelling";
  const thinking = isStreaming && run.draftText === "";

  return (
    <div className="msg assistant group flex scroll-mt-[60px] flex-col items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        {run.draftReasoning && (
          <ThinkingBlock content={run.draftReasoning} streaming={thinking} />
        )}
        <Markdown content={run.draftText} />
        {run.status === "cancelled" && (
          <div className={`status-pill stopped ${statusPill} border-border bg-bg-sunken text-fg-muted`}>
            <span className="h-2 w-2 rounded-[2px] bg-fg-subtle" />
            已停止
          </div>
        )}
        {run.status === "failed" && (
          <div
            className={`status-pill failed ${statusPill} border-[rgba(181,74,46,0.18)] bg-danger-soft text-danger`}
          >
            <Icons.Close size={12} />
            生成失败 · 请稍后重试
          </div>
        )}
      </div>
    </div>
  );
}
