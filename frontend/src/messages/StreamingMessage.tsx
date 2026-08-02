import type { ActiveRunState } from "../runs/state";
import { InlineStatus } from "../ui/InlineStatus";
import { Markdown } from "./Markdown";
import { reasoningPreview } from "./reasoningPreview";
import { ThinkingBlock } from "./ThinkingBlock";

type StreamingMessageProps = { run: ActiveRunState };

export function StreamingMessage({ run }: StreamingMessageProps) {
  const isStreaming =
    run === null ||
    run.status === "queued" ||
    run.status === "started" ||
    run.status === "streaming" ||
    run.status === "cancelling";
  const draftText = run?.draftText ?? "";
  const thinking = isStreaming && draftText === "";

  // Header ownership: a running web_search always owns the label (正在搜索…).
  // Once the call finishes, its result label (已找到 n 个来源) only holds until
  // reasoning text exists — reasoning streamed around tool calls would
  // otherwise stay hidden behind a stale tool label for the whole phase.
  const toolState = run?.toolState;
  const toolLabel = toolState ? labelForToolState(toolState) : undefined;
  const hasReasoningPreview = reasoningPreview(run?.draftReasoning ?? "") !== "";
  const label =
    toolState?.status === "running" || !hasReasoningPreview ? toolLabel : undefined;
  const showThinking = thinking;

  return (
    <div className="msg assistant group flex scroll-mt-[60px] flex-col items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        {showThinking && (
          <ThinkingBlock
            content={run?.draftReasoning ?? ""}
            streaming={thinking}
            showStreamingPreview={run?.providerName !== "deepseek"}
            autoExpandWhileStreaming={run?.providerName === "deepseek"}
            label={label}
          />
        )}
        <Markdown content={draftText} streaming />
        {/* Failures remain in message context as a persistent alert. Cancelled
            runs keep any partial formal answer without an extra status block. */}
        {run?.status === "failed" && (
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
