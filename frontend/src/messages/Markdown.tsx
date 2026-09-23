import "katex/dist/katex.min.css";

import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import type { MessageSource } from "../api/types";
import { Citation } from "./Citation";
import { rehypeCitations } from "./citations";
import { CodeBlock } from "./markdown/CodeBlock";
import { MarkdownLink } from "./markdown/MarkdownLink";
import { rehypeReplyQuoteAnchors } from "./markdown/rehypeReplyQuoteAnchors";
import { TableBlock } from "./markdown/TableBlock";
import { normalizeMathDelimiters, clampStreamingMath } from "./mathDelimiters";

// remark-math emits math wrapped in `<code class="language-math math-inline">`
// (or `math-display`). The default sanitize schema allows `className` on `code`
// only when it matches `/^language-./`, so the second (math-*) class would be
// stripped — and rehype-katex keys off it. Extend just that one rule to keep
// the math markers through sanitization.
const mathSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};

// react-markdown's own plugin-list type, reused so the arrays below type-check
// without importing the transitive `unified` package (not hoisted under pnpm).
type PluggableList = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;

// `\(…\)` / `\[…\]` are normalized to `$$…$$` before parsing; single `$…$` is
// disabled (singleDollarTextMath: false) so prose like "$5 到 $10" is not
// misread as a formula.
const remarkPlugins: PluggableList = [
  remarkGfm,
  remarkBreaks,
  [remarkMath, { singleDollarTextMath: false }],
];

// Sources and layout for citation chips. Delivered through context so the
// `citation` renderer below keeps one component identity: a renderer recreated
// per render would remount every chip (re-fetching its favicon and closing an
// open card) on each streaming delta.
type CitationSurface = { sources: MessageSource[]; isMobile: boolean };
const CitationSurfaceContext = createContext<CitationSurface>({
  sources: [],
  isMobile: false,
});

function CitationElement({ node }: { node?: { properties?: Record<string, unknown> } }) {
  const { sources, isMobile } = useContext(CitationSurfaceContext);
  return <Citation node={node} sources={sources} isMobile={isMobile} />;
}

// `citation` is a custom tag injected by rehypeCitations; react-markdown's
// Components type only knows standard tags, so widen via the typed object.
const components: Components = {
  a: MarkdownLink,
  pre: CodeBlock,
  table: TableBlock,
  citation: CitationElement,
} as Components;

// While streaming, an unclosed trailing marker (`[`, `[1`) would flash as plain
// text before its `]` arrives and turns it into a chip; hold it back instead.
const TRAILING_PARTIAL_CITATION = /\[\d*$/;

type MarkdownProps = {
  content: string;
  // When provided, inline `[n]` markers whose id resolves become citation
  // chips — on final messages and live while a reply streams.
  sources?: MessageSource[];
  isMobile?: boolean;
  // True while the reply is still streaming: an unterminated display-math block
  // is clamped so KaTeX never renders a half-written formula as a red error.
  streaming?: boolean;
  // Final assistant and public-share surfaces opt in to stable source anchors.
  replyQuoteAnchors?: boolean;
};

export function Markdown({
  content,
  sources,
  isMobile,
  streaming,
  replyQuoteAnchors,
}: MarkdownProps) {
  // Memoized so unrelated app re-renders (e.g. typing in the composer, which
  // lives in a shared ancestor) don't re-parse the markdown or remount the
  // citation subtree. Remounting <Citation> would rebuild each <img> favicon,
  // re-firing the network request and flashing the icons. Recomputes only when
  // the actual content/sources change (streaming deltas, a new message).
  const rendered = useMemo(() => {
    const hasCitations = (sources?.length ?? 0) > 0;
    // Pipeline order: sanitize first (with math markers whitelisted), THEN
    // rehype-katex renders the trusted LaTeX text into KaTeX markup, THEN
    // rehypeCitations turns `[n]` markers into chips. Citations run last so the
    // injected <citation> nodes survive sanitize, and after katex so it can skip
    // the rendered math subtree.
    const rehypePlugins: PluggableList = hasCitations
      ? [
          [rehypeSanitize, mathSchema],
          rehypeKatex,
          rehypeCitations(new Set(sources!.map((s) => s.id))),
        ]
      : [[rehypeSanitize, mathSchema], rehypeKatex];
    if (replyQuoteAnchors && !streaming) rehypePlugins.push(rehypeReplyQuoteAnchors);

    // While streaming, clamp an unterminated display-math block so a
    // half-written formula never reaches KaTeX (it would render as a red error
    // and swallow the trailing prose). The final render is never clamped.
    const normalized = normalizeMathDelimiters(content);
    const clamped = streaming ? clampStreamingMath(normalized) : normalized;
    const prepared =
      streaming && hasCitations ? clamped.replace(TRAILING_PARTIAL_CITATION, "") : clamped;

    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {prepared}
      </ReactMarkdown>
    );
  }, [content, sources, streaming, replyQuoteAnchors]);
  const citationSurface = useMemo(
    () => ({ sources: sources ?? [], isMobile: isMobile ?? false }),
    [sources, isMobile],
  );

  return (
    <div className="assistant-markdown body md">
      <CitationSurfaceContext.Provider value={citationSurface}>
        {rendered}
      </CitationSurfaceContext.Provider>
    </div>
  );
}
