import type { ComponentPropsWithoutRef } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { MessageSource } from "../api/types";
import { Icons } from "../ui/icons";
import { Citation } from "./Citation";
import { rehypeCitations } from "./citations";

type MarkdownProps = {
  content: string;
  // When provided (final assistant message), inline `[n]` markers become
  // citation chips. Omitted while streaming, so markers stay plain text.
  sources?: MessageSource[];
  isMobile?: boolean;
};

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

export function Markdown({ content, sources, isMobile }: MarkdownProps) {
  // Memoized so unrelated app re-renders (e.g. typing in the composer, which
  // lives in a shared ancestor) don't re-parse the markdown or remount the
  // citation subtree. Remounting <Citation> would rebuild each <img> favicon,
  // re-firing the network request and flashing the icons. Recomputes only when
  // the actual content/sources change (streaming deltas, a new message).
  const rendered = useMemo(() => {
    const hasCitations = (sources?.length ?? 0) > 0;
    // rehypeCitations runs AFTER rehypeSanitize so the injected <citation> nodes
    // (and their citeIds property) are not stripped by the sanitizer.
    const rehypePlugins = hasCitations
      ? [rehypeSanitize, rehypeCitations(new Set(sources!.map((s) => s.id)))]
      : [rehypeSanitize];

    // `citation` is a custom tag injected by the plugin; react-markdown's
    // Components type only knows standard tags, so widen via the typed object.
    const components: Components = {
      pre: Pre,
      ...(hasCitations
        ? {
            citation: (props: { node?: { properties?: Record<string, unknown> } }) => (
              <Citation node={props.node} sources={sources!} isMobile={isMobile} />
            ),
          }
        : {}),
    } as Components;

    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    );
  }, [content, sources, isMobile]);

  return (
    <div className="body md text-[16px] leading-[1.75] text-fg max-[760px]:text-[17px]">
      {rendered}
    </div>
  );
}
