import { useLayoutEffect, useState } from "react";

import { focusRing } from "../ui/classes";
import { Icons } from "../ui/icons";
import { reasoningPreview } from "./reasoningPreview";

type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
  // OpenAI streams user-facing summary headlines. DeepSeek streams raw
  // reasoning, which stays behind the generic collapsed status instead.
  showStreamingPreview?: boolean;
  autoExpandWhileStreaming?: boolean;
  // Overrides the default header — used while a tool call is in flight to
  // surface the search phase (正在搜索… / 已找到 n 个来源).
  label?: string;
};

export function ThinkingBlock({
  content,
  streaming,
  showStreamingPreview = true,
  autoExpandWhileStreaming = false,
  label,
}: ThinkingBlockProps) {
  // OpenAI summaries and completed history start collapsed. DeepSeek raw
  // reasoning opens when its streaming phase begins, but later user toggles
  // remain authoritative because content deltas do not retrigger this effect.
  const [open, setOpen] = useState(autoExpandWhileStreaming && streaming);
  useLayoutEffect(() => {
    if (autoExpandWhileStreaming) setOpen(streaming);
  }, [autoExpandWhileStreaming, streaming]);
  const hasContent = content.trim() !== "";
  const preview = streaming && showStreamingPreview ? reasoningPreview(content) : "";
  const headerText =
    label ?? (streaming ? preview || "正在思考" : "已思考");

  return (
    <div
      className={`thinking${open ? "" : " collapsed"}${hasContent ? " mb-3.5 py-0.5" : " h-7"} text-[14px] leading-[1.6] text-text-muted max-[760px]:text-[15px]`}
    >
      <div
        className={`group ${focusRing} inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-detail select-none${hasContent ? " py-0.5" : " h-full"}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        {/* Label matches body size (16px). While streaming, a glow sweeps the
            text left→right (.is-streaming); hovering forces solid black in any
            state — both handled in global.css (.thinking-label). */}
        <span
          className={`thinking-label min-w-0 truncate text-[16px] leading-[1.6] max-[760px]:text-[17px]${streaming ? " is-streaming" : ""}`}
        >
          {headerText}
        </span>
        <Icons.Chevron
          size={14}
          className={`shrink-0 text-text-faint transition-transform duration-[160ms]${open ? "" : " -rotate-90"}`}
        />
      </div>
      {hasContent && (
        <div
          className={`thinking-body mt-1.5 text-[14px] whitespace-pre-wrap text-text-muted max-[760px]:text-[15px]${open ? "" : " hidden"}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
