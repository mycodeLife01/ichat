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
    <div className={`thinking${open ? "" : " collapsed"}`}>
      <div
        className="thinking-header"
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
        {streaming && <span className="pulse" />}
        <Icons.Chevron size={11} className="chev" />
        {streaming ? "思考中…" : "已思考"}
      </div>
      <div className="thinking-body">{content}</div>
    </div>
  );
}
