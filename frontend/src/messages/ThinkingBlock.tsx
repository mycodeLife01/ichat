import { useState } from "react";

import { Icons } from "../ui/icons";

type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
};

export function ThinkingBlock({ content, streaming }: ThinkingBlockProps) {
  const [open, setOpen] = useState(streaming);

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
