import { useEffect, useState } from "react";

import { Icons } from "../ui/icons";

type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
  // Overrides the default 思考中…/已思考 header — used while a tool call is in
  // flight to surface the search phase (正在搜索… / 已找到 n 个来源).
  label?: string;
};

export function ThinkingBlock({ content, streaming, label }: ThinkingBlockProps) {
  const [open, setOpen] = useState(streaming);

  // Expand while reasoning streams; auto-collapse once body text arrives
  // (caller flips `streaming` to false). Manual toggling within a phase persists.
  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <div
      className={`thinking${open ? "" : " collapsed"} mb-3.5 py-0.5 text-[14px] leading-[1.6] text-fg-muted max-[760px]:text-[15px]`}
    >
      <div
        className="group inline-flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 select-none"
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
          {label ?? (streaming ? "思考中…" : "已思考")}
        </span>
        <Icons.Chevron
          size={14}
          className={`shrink-0 text-fg-subtle transition-transform duration-[160ms]${open ? "" : " -rotate-90"}`}
        />
      </div>
      {content && (
        <div
          className={`mt-1.5 max-h-[360px] overflow-y-auto text-[14px] whitespace-pre-wrap text-fg-muted [scrollbar-gutter:stable] max-[760px]:text-[15px]${open ? "" : " hidden"}`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
