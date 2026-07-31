import { useState } from "react";

import { focusRing } from "../ui/classes";
import { Icons } from "../ui/icons";
import { reasoningPreview } from "./reasoningPreview";

type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
  // Overrides the default header — used while a tool call is in flight to
  // surface the search phase (正在搜索… / 已找到 n 个来源).
  label?: string;
};

export function ThinkingBlock({ content, streaming, label }: ThinkingBlockProps) {
  // Collapsed by default: while streaming the header carries a rolling
  // preview of the latest reasoning line — expanded or not, so unfolding the
  // full text keeps the live status visible. Providers that send no
  // reasoning (OpenAI without a summary) keep the plain 正在思考 shimmer.
  const [open, setOpen] = useState(false);
  const preview = streaming ? reasoningPreview(content) : "";
  const headerText =
    label ?? (streaming ? preview || "正在思考" : "已思考");

  return (
    <div
      className={`thinking${open ? "" : " collapsed"} mb-3.5 py-0.5 text-[14px] leading-[1.6] text-text-muted max-[760px]:text-[15px]`}
    >
      <div
        className={`group ${focusRing} inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-detail py-0.5 select-none`}
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
      {content && (
        <div
          className={`thinking-body mt-1.5 text-[14px] whitespace-pre-wrap text-text-muted max-[760px]:text-[15px]${open ? "" : " hidden"}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
