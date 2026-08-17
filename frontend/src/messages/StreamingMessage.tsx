import type { ActiveRunState } from "../runs/state";
import { assistantContentColumn, runStatusText } from "../ui/classes";
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
  const thinking = isStreaming && draftText.trim() === "";
  const hasReasoning = (run?.draftReasoning ?? "").trim() !== "";

  // Header ownership: a running web_search always owns the label (正在搜索…).
  // Once the call finishes, its result label (已找到 n 个来源) only holds until
  // reasoning text exists — reasoning streamed around tool calls would
  // otherwise stay hidden behind a stale tool label for the whole phase.
  const toolState = run?.toolState;
  const toolLabel = toolState ? labelForToolState(toolState) : undefined;
  const hasReasoningPreview = reasoningPreview(run?.draftReasoning ?? "") !== "";
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
          <InlineStatus tone="error" className={`mt-2 w-fit ${runStatusText}`}>
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
