import "katex/dist/katex.min.css";

import type { ComponentProps } from "react";
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import type { MessageSource } from "../api/types";
import { Citation } from "./Citation";
import { rehypeCitations } from "./citations";
import { CodeBlock } from "./markdown/CodeBlock";
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
const remarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];

type MarkdownProps = {
  content: string;
  // When provided (final assistant message), inline `[n]` markers become
  // citation chips. Omitted while streaming, so markers stay plain text.
  sources?: MessageSource[];
  isMobile?: boolean;
  // True while the reply is still streaming: an unterminated display-math block
  // is clamped so KaTeX never renders a half-written formula as a red error.
  streaming?: boolean;
};

export function Markdown({ content, sources, isMobile, streaming }: MarkdownProps) {
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

    // `citation` is a custom tag injected by the plugin; react-markdown's
    // Components type only knows standard tags, so widen via the typed object.
    const components: Components = {
      pre: CodeBlock,
      ...(hasCitations
        ? {
            citation: (props: { node?: { properties?: Record<string, unknown> } }) => (
              <Citation node={props.node} sources={sources!} isMobile={isMobile} />
            ),
          }
        : {}),
    } as Components;

    // While streaming, clamp an unterminated display-math block so a
    // half-written formula never reaches KaTeX (it would render as a red error
    // and swallow the trailing prose). The final render is never clamped.
    const normalized = normalizeMathDelimiters(content);
    const prepared = streaming ? clampStreamingMath(normalized) : normalized;

    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {prepared}
      </ReactMarkdown>
    );
  }, [content, sources, isMobile, streaming]);

  return (
    <div className="assistant-markdown body md">
      {rendered}
    </div>
  );
}
