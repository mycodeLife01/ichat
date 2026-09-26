import type { ComponentProps } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { focusRing } from "../ui/classes";
import { Icons } from "../ui/icons";
import { reasoningPreview } from "./reasoningPreview";

// Raw chains of thought and provider summaries share one behavior. While
// thinking, the header toggles a bounded live preview (the viewport) and the
// full content. When thinking ends the block collapses to its header whatever
// was shown, and the header then toggles only the full content: a settled
// preview would just repeat an arbitrary tail.
type ThinkingBlockProps = {
  content: string;
  streaming: boolean;
  // Overrides the default header — used while a tool call is in flight to
  // surface the search phase (正在搜索… / 已找到 n 个来源).
  label?: string;
  // Run id shared by the streaming surface and the persisted message, so a
  // choice made after thinking ends survives the handoff to history.
  handoffKey?: string | null;
};

// Written only by blocks that streamed and consumed by the next block that
// mounts with the same key, so entries never outlive one handoff.
const handoffChoices = new Map<string, boolean>();

export function ThinkingBlock({
  content,
  streaming,
  label,
  handoffKey,
}: ThinkingBlockProps) {
  const [open, setOpenState] = useState(
    () => (handoffKey && handoffChoices.get(handoffKey)) || false,
  );
  const streamed = useRef(streaming);
  const setOpen = (next: boolean) => {
    if (handoffKey && streamed.current) handoffChoices.set(handoffKey, next);
    setOpenState(next);
  };
  useEffect(() => {
    if (handoffKey && !streamed.current) handoffChoices.delete(handoffKey);
    // Consume once on mount; later key changes start a new block anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wasStreaming = useRef(streaming);
  useLayoutEffect(() => {
    if (streaming) streamed.current = true;
    if (wasStreaming.current && !streaming) {
      if (handoffKey) handoffChoices.delete(handoffKey);
      setOpenState(false);
    }
    wasStreaming.current = streaming;
  }, [streaming, handoffKey]);
  const toggle = () => setOpen(!open);
  const hasContent = content.trim() !== "";
  const mode = open ? "full" : streaming ? "preview" : "collapsed";
  const headline = streaming ? reasoningPreview(content) : "";
  const headerText = label ?? (streaming ? headline || "正在思考" : "已思考");

  // The header's vertical geometry (root + row padding) is unconditional: the
  // empty status and the first reasoning delta must share one layout, or the
  // hasContent flip would nudge the label ~3px down mid-stream. Only the
  // bottom margin and the body below the anchor react to stream state.
  return (
    <div
      className={`thinking${hasContent ? " mb-3.5" : ""} py-0.5 text-[14px] leading-[1.6] text-text-muted max-[760px]:text-[15px]`}
      data-thinking-mode={mode}
    >
      <div
        className={`group ${focusRing} inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-detail select-none py-0.5`}
        role="button"
        tabIndex={0}
        aria-expanded={open && hasContent}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
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
      {mode === "preview" && hasContent && <ThinkingViewport content={content} />}
      {open && hasContent && <ThinkingFullBody content={content} />}
    </div>
  );
}

function ThinkingViewport({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // Paragraph gaps would waste the few visible lines, so the preview packs
  // paragraphs tightly; the full body keeps the original spacing.
  const text = plainPreviewText(content).replace(/\n\s*\n/g, "\n");
  useLayoutEffect(() => {
    // Content overflows the start edge of a bottom-anchored flex column, which
    // scrollHeight does not report; compare the inner height instead.
    const el = ref.current;
    const inner = innerRef.current;
    if (el && inner) setOverflowing(inner.offsetHeight > el.clientHeight + 1);
  }, [text]);
  // Decorative live mirror of the reasoning: screen readers get the header
  // status instead of a token-by-token announcement.
  return (
    <div
      ref={ref}
      aria-hidden
      className={`thinking-window${overflowing ? " is-overflowing" : ""} mt-1.5 border-l-2 border-border-strong pl-3 text-[14px] leading-[1.6] whitespace-pre-wrap text-text-muted max-[760px]:text-[15px]`}
    >
      <div ref={innerRef}>{text}</div>
    </div>
  );
}

// Full reasoning renders as Markdown so summary headlines read as section
// headings. react-markdown drops raw HTML; the muted, compact typography lives
// in global.css (.thinking-md) rather than the answer styles.
function ThinkingFullBody({ content }: { content: string }) {
  const markdown = useMemo(() => headlinesAsHeadings(content), [content]);
  return (
    <div className="thinking-body thinking-md mt-1.5 border-l-2 border-border-strong pl-3 text-[14px] leading-[1.6] text-text-muted max-[760px]:text-[15px]">
      <ReactMarkdown remarkPlugins={thinkingRemarkPlugins}>{markdown}</ReactMarkdown>
    </div>
  );
}

type RemarkPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;
const thinkingRemarkPlugins: RemarkPlugins = [remarkGfm, remarkBreaks];

// Summary parts mark each section with a standalone `**Headline**`, sometimes
// glued to the end of the previous sentence. Promote those to real headings.
function headlinesAsHeadings(content: string): string {
  return content
    .replace(/(^|\n|[。！？.!?：:])[ \t]*\*\*([^*\n]+)\*\*[ \t]*(?=\n|$)/g, "$1\n\n#### $2\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Summary headlines already own the header, so the preview drops Markdown
// headline markers and keeps only the prose.
function plainPreviewText(content: string): string {
  return (
    content
      // Summary parts can glue a headline to the previous sentence; a bold run
      // that closes its line is a headline wherever it starts.
      .replace(/\*\*[^*\n]+\*\*[ \t]*(?=\n|$)/g, "\n")
      .split("\n")
      .filter((line) => !/^\s*(?:#{1,6}\s+.*|\*\*[^*\n]+\*\*)\s*$/.test(line))
      .join("\n")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
