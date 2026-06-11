import type { ComponentPropsWithoutRef } from "react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Icons } from "../ui/icons";

type MarkdownProps = { content: string };

// Code block with a resident copy button in the top-right corner. Copies the
// rendered text of the block; the icon cross-fades to a check (same feedback
// pattern as the message action bar).
function Pre(props: ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = () => {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block relative">
      <pre ref={preRef} {...props} />
      <button
        className="absolute top-2 right-2 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-fg-muted transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-fg"
        type="button"
        aria-label={copied ? "已复制" : "复制代码"}
        onClick={handleCopy}
      >
        <span className="relative inline-flex h-[13px] w-[13px]">
          <Icons.Copy
            size={13}
            className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? " opacity-0" : ""}`}
          />
          <Icons.Check
            size={13}
            className={`absolute inset-0 transition-opacity duration-[120ms]${copied ? "" : " opacity-0"}`}
          />
        </span>
      </button>
    </div>
  );
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="body md text-[16px] leading-[1.75] text-fg max-[760px]:text-[17px]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{ pre: Pre }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
