import type { ActiveRunState } from "../runs/state";
import { assistantContentColumn } from "../ui/classes";
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
  // Providers may emit a leading newline when switching from reasoning to
  // the formal answer. Keep the thinking block mounted until there is visible
  // answer text; otherwise the message briefly collapses to an empty Markdown
  // node and flashes at the bottom of the scroll container.
  // Cumulative text cannot describe the current model activity: one Run may
  // emit intermediate text, call a tool, and then resume reasoning. Follow the
  // latest SSE-driven phase instead, while preserving the leading-whitespace
  // handoff behavior in the reducer.
  const thinking = isStreaming && (run === null || run.streamPhase !== "text");
  const reasoningSummary = run?.draftReasoningSummary ?? "";
  const rawReasoning = run?.draftReasoning ?? "";
  const showingSummary = reasoningSummary.trim() !== "";
  const displayedReasoning = showingSummary ? reasoningSummary : rawReasoning;
  const hasReasoning = displayedReasoning.trim() !== "";

  // Header ownership: a running web_search always owns the label (正在搜索…).
  // Once the call finishes, its result label (已找到 n 个来源) only yields to a
  // user-facing summary preview. Raw reasoning stays behind the generic/tool
  // status and is never promoted into the label.
  const toolState = run?.streamPhase === "tool" ? run.toolState : null;
  const toolLabel = toolState ? labelForToolState(toolState) : undefined;
  const hasReasoningPreview =
    showingSummary && reasoningPreview(displayedReasoning) !== "";
  const label =
    toolState?.status === "running" || !hasReasoningPreview ? toolLabel : undefined;
  // Once visible answer text arrives, keep the reasoning surface mounted and
  // collapse it above the answer. Removing the expanded block outright makes
  // a bottom-pinned message jump by roughly one or more lines at the handoff.
  const showThinking = thinking || hasReasoning;

  return (
    <div className="msg assistant group flex scroll-mt-[60px] flex-col items-stretch gap-1.5">
      <div className={assistantContentColumn}>
        {showThinking && (
          <ThinkingBlock
            content={displayedReasoning}
            streaming={thinking}
            showStreamingPreview={showingSummary}
            autoExpandWhileStreaming={
              !showingSummary && hasReasoning && run?.streamPhase !== "tool"
            }
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
