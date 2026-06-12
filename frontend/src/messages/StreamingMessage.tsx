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
        {run.toolState && <ToolStatePill toolState={run.toolState} />}
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

function ToolStatePill({
  toolState,
}: {
  toolState: NonNullable<NonNullable<ActiveRunState>["toolState"]>;
}) {
  const title =
    toolState.status === "running"
      ? "正在搜索网页..."
      : toolState.status === "succeeded"
        ? `已找到 ${toolState.result_count ?? toolState.sources.length} 个来源`
        : toolState.message ?? "搜索失败，继续生成";
  return (
    <div className="tool-state mb-2 rounded-lg border border-border bg-bg-sunken px-3 py-2 text-[13px] text-fg-muted">
      <div className="font-medium text-fg">{title}</div>
      {toolState.query && <div className="mt-0.5 wrap-anywhere">{toolState.query}</div>}
      {toolState.status === "succeeded" && toolState.sources.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {toolState.sources.slice(0, 3).map((source) => (
            <span
              key={`${source.id}:${source.url}`}
              className="max-w-full truncate rounded-full border border-border bg-bg px-2 py-[2px] text-[12px]"
            >
              [{source.id}] {source.title}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
