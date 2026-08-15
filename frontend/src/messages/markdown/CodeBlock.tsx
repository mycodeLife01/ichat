import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { Fragment, isValidElement, useEffect, useRef, useState } from "react";

import { iconControl } from "../../ui/classes";
import { Icons } from "../../ui/icons";
import { resolveCodeLanguage } from "./codeLanguage";
import { copyText } from "./copyText";

type CodeElementProps = {
  className?: string;
  children?: ReactNode;
};

type SyntaxHighlighter = typeof import("prism-react-renderer");

let syntaxHighlighterPromise: Promise<SyntaxHighlighter> | null = null;

function loadSyntaxHighlighter() {
  syntaxHighlighterPromise ??= import("prism-react-renderer");
  return syntaxHighlighterPromise;
}

function sourceFromChild(child: ReactNode) {
  if (!isValidElement<CodeElementProps>(child)) return "";
  return String(child.props.children ?? "").replace(/\n$/, "");
}

function codeClassName(child: ReactNode) {
  if (!isValidElement<CodeElementProps>(child)) return undefined;
  return child.props.className;
}

function highlightedSource(
  source: string,
  language: string,
  highlighter: SyntaxHighlighter | null,
) {
  const grammar = highlighter?.Prism.languages[language];
  const tokens =
    highlighter && grammar
      ? highlighter.normalizeTokens(highlighter.Prism.tokenize(source, grammar))
      : null;

  return (
    <code>
      {tokens
        ? tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {line.map((token, tokenIndex) => (
                <span className={`token ${token.types.join(" ")}`} key={tokenIndex}>
                  {token.empty ? "" : token.content}
                </span>
              ))}
              {lineIndex < tokens.length - 1 ? "\n" : null}
            </Fragment>
          ))
        : source}
    </code>
  );
}

export function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const child = children as ReactElement<CodeElementProps> | undefined;
  const source = sourceFromChild(child);
  const language = resolveCodeLanguage(codeClassName(child));
  const [highlighter, setHighlighter] = useState<SyntaxHighlighter | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "failure">("idle");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAttempt = useRef(0);

  useEffect(() => {
    let active = true;
    void loadSyntaxHighlighter().then(
      (loaded) => {
        if (active) setHighlighter(loaded);
      },
      () => {
        // Plain source remains usable if the optional highlighting chunk fails.
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () => () => {
      copyAttempt.current += 1;
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    const attempt = ++copyAttempt.current;
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    const copied = await copyText(source);
    if (attempt !== copyAttempt.current) return;

    if (!copied) {
      setCopyState("failure");
      return;
    }

    setCopyState("success");
    copiedTimer.current = setTimeout(() => setCopyState("idle"), 1500);
  };

  const copied = copyState === "success";

  return (
    <div className="code-block" data-code-block data-language={language.highlighterLanguage}>
      <div className="code-block-header">
        <span className="code-block-language">{language.label}</span>
        <button
          className={`${iconControl} h-7 gap-1.5 px-2 text-xs`}
          type="button"
          aria-label={copied ? "已复制" : "复制代码"}
          onClick={handleCopy}
        >
          {copied ? <Icons.Check size={14} /> : <Icons.Copy size={14} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
        {copyState === "failure" ? (
          <span className="sr-only" role="status">
            Copy failed. Try again.
          </span>
        ) : null}
      </div>
      <div className="code-block-viewport" data-code-viewport tabIndex={0}>
        <pre aria-label={`${language.label} 代码`}>
          {highlightedSource(source, language.highlighterLanguage, highlighter)}
        </pre>
      </div>
    </div>
  );
}
