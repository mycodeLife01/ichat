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

  // While a web_search tool call is in flight, the collapsible header label
  // takes over the thinking copy: 正在搜索… → 已找到 n 个来源 (no preview box).
  const toolLabel = run.toolState ? labelForToolState(run.toolState) : undefined;
  const showThinking = run.draftReasoning !== "" || run.toolState !== null;

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
