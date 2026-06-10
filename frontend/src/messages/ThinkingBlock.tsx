import { useEffect, useState } from "react";

import { Icons } from "../ui/icons";

type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
};

export function ThinkingBlock({ content, streaming }: ThinkingBlockProps) {
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
        className="inline-flex cursor-pointer items-center gap-1.5 py-0.5 text-xs font-medium text-fg-muted select-none"
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
        <Icons.Chevron
          size={11}
          className={`text-fg-subtle transition-transform duration-[160ms]${open ? "" : " -rotate-90"}`}
        />
        {streaming ? "思考中…" : "已思考"}
      </div>
      <div
        className={`mt-1.5 max-h-[360px] overflow-y-auto text-[14px] whitespace-pre-wrap text-fg-muted [scrollbar-gutter:stable] max-[760px]:text-[15px]${open ? "" : " hidden"}`}
      >
        {content}
      </div>
    </div>
  );
}
