import type { ActiveRunState } from "../runs/state";
import { InlineStatus } from "../ui/InlineStatus";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

type StreamingMessageProps = { run: NonNullable<ActiveRunState> };

export function PendingAssistantMessage() {
  return (
    <div className="msg assistant group flex scroll-mt-[60px] flex-col items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        <ThinkingBlock content="" streaming />
      </div>
    </div>
  );
}

export function StreamingMessage({ run }: StreamingMessageProps) {
  const isStreaming =
    run.status === "queued" ||
    run.status === "started" ||
    run.status === "streaming" ||
    run.status === "cancelling";
  const thinking = isStreaming && run.draftText === "";

  // While a web_search tool call is in flight, the collapsible header label
  // takes over the thinking copy: 正在搜索… → 已找到 n 个来源 (no preview box).
  const toolLabel = run.toolState ? labelForToolState(run.toolState) : undefined;
  const showThinking = thinking;

  return (
    <div className="msg assistant group flex scroll-mt-[60px] flex-col items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        {showThinking && (
          <ThinkingBlock
            content={run.draftReasoning}
            streaming={thinking}
            label={toolLabel}
          />
        )}
        <Markdown content={run.draftText} streaming />
        {/* Failures remain in message context as a persistent alert. Cancelled
            runs keep any partial formal answer without an extra status block. */}
        {run.status === "failed" && (
          <InlineStatus tone="error" className="mt-2 w-fit">
            生成失败 · 请稍后重试
          </InlineStatus>
        )}
      </div>
    </div>
  );
}

function labelForToolState(
  toolState: NonNullable<NonNullable<ActiveRunState>["toolState"]>,
): string {
  if (toolState.status === "running") {
    return toolState.query ? `正在搜索 ${toolState.query}` : "正在搜索";
  }
  if (toolState.status === "succeeded") {
    return `已找到 ${toolState.result_count ?? toolState.sources.length} 个来源`;
  }
  return toolState.message ?? "搜索失败，继续生成";
}
