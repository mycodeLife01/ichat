import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { Fragment, isValidElement, useEffect, useRef, useState } from "react";

import { focusRing } from "../../ui/classes";
import { Icons } from "../../ui/icons";
import type { HighlightedCodeChunk } from "./codeHighlight";
import { resolveCodeLanguage } from "./codeLanguage";
import { copyText } from "./copyText";

type CodeElementProps = {
  className?: string;
  children?: ReactNode;
};

type SyntaxHighlighter = typeof import("./codeHighlight");

type HighlightResult = {
  chunks: HighlightedCodeChunk[] | null;
  language: string;
  source: string;
};

let syntaxHighlighterPromise: Promise<SyntaxHighlighter> | null = null;

function loadSyntaxHighlighter() {
  syntaxHighlighterPromise ??= import("./codeHighlight");
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
  result: HighlightResult | null,
) {
  const keepsHighlightedPrefix =
    result?.chunks && result.language === language && source.startsWith(result.source);
  const chunks = keepsHighlightedPrefix ? result.chunks : null;
  const pendingSuffix = keepsHighlightedPrefix ? source.slice(result.source.length) : "";

  return (
    <code>
      {chunks
        ? (
            <>
              {chunks.map((chunk, index) =>
                chunk.type ? (
                  <span className={`token ${chunk.type}`} key={index}>
                    {chunk.content}
                  </span>
                ) : (
                  <Fragment key={index}>{chunk.content}</Fragment>
                ),
              )}
              {pendingSuffix}
            </>
          )
        : source}
    </code>
  );
}

export function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const child = children as ReactElement<CodeElementProps> | undefined;
  const source = sourceFromChild(child);
  const language = resolveCodeLanguage(codeClassName(child));
  const highlightKey = `${language.highlighterLanguage}\0${source}`;
  const [highlightResult, setHighlightResult] = useState<HighlightResult | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "failure">("idle");
  const [view, setView] = useState<"code" | "preview">("code");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAttempt = useRef(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const htmlPreview = language.label === "HTML" && language.highlighterLanguage === "markup";
  const pythonRunnable = language.highlighterLanguage === "python";

  useEffect(() => {
    let active = true;
    void loadSyntaxHighlighter()
      .then((loaded) => loaded.highlightSource(source, language.highlighterLanguage))
      .then(
        (chunks) => {
          if (active) {
            setHighlightResult({
              chunks,
              language: language.highlighterLanguage,
              source,
            });
          }
        },
        () => {
          // Plain source remains usable if an optional language chunk fails.
        },
      );
    return () => {
      active = false;
    };
  }, [highlightKey, language.highlighterLanguage, source]);

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
  const copyButton = (
    <button
      className={`code-block-copy ${focusRing}`}
      type="button"
      aria-label={copied ? "已复制" : "复制代码"}
      onClick={handleCopy}
    >
      {copied ? <Icons.Check size={20} /> : <Icons.CopyFilled size={20} />}
    </button>
  );
  const headerIcon = htmlPreview ? (
    <Icons.HtmlPreview className="code-block-language-icon" size={16} />
  ) : (
    <Icons.Code className="code-block-language-icon" size={16} />
  );

  const handleFullscreen = () => {
    const request = previewRef.current?.requestFullscreen();
    if (request) void request.catch(() => undefined);
  };

  const headerActions = htmlPreview ? (
    <div className="code-block-actions">
      <div className="code-block-view-toggle" role="group" aria-label="代码块视图切换">
        <span
          className={`code-block-view-indicator${view === "preview" ? " is-preview" : ""}`}
          aria-hidden="true"
        />
        <button
          className={`code-block-view-button ${focusRing}`}
          type="button"
          aria-label="代码"
          aria-pressed={view === "code"}
          onClick={() => setView("code")}
        >
          <Icons.Code size={20} />
        </button>
        <button
          className={`code-block-view-button ${focusRing}`}
          type="button"
          aria-label="预览"
          aria-pressed={view === "preview"}
          onClick={() => setView("preview")}
        >
          <Icons.Play size={20} />
        </button>
      </div>
      {view === "code" ? (
        copyButton
      ) : (
        <button
          className={`code-block-copy ${focusRing}`}
          type="button"
          aria-label="全屏"
          onClick={handleFullscreen}
        >
          <Icons.Fullscreen size={20} />
        </button>
      )}
    </div>
  ) : (
    <div className="code-block-actions">
      {copyButton}
      {pythonRunnable ? (
        <button
          className={`code-block-run ${focusRing}`}
          type="button"
          aria-label="运行代码"
          aria-disabled="true"
        >
          <span>
            <Icons.Play size={20} />
            运行
          </span>
        </button>
      ) : null}
    </div>
  );

  return (
    <div
      className={`code-block${language.showHeader ? "" : " code-block-plain"}${
        htmlPreview && view === "preview" ? " code-block-previewing" : ""
      }`}
      data-code-block
      data-language={language.highlighterLanguage}
      data-code-view={htmlPreview ? view : undefined}
    >
      {language.showHeader ? (
        <div className="code-block-header">
          <span className="code-block-language">
            {headerIcon}
            <span>{language.label}</span>
          </span>
          {headerActions}
        </div>
      ) : (
        <div className="code-block-plain-actions">{copyButton}</div>
      )}
      {htmlPreview && view === "preview" ? (
        <div className="code-block-preview" ref={previewRef}>
          <iframe
            title="预览"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={source}
          />
        </div>
      ) : (
        <div className="code-block-viewport" data-code-viewport tabIndex={0}>
          <pre aria-label={`${language.label} 代码`}>
            {highlightedSource(source, language.highlighterLanguage, highlightResult)}
          </pre>
        </div>
      )}
      {copyState === "failure" ? (
        <span className="sr-only" role="status">
          Copy failed. Try again.
        </span>
      ) : null}
    </div>
  );
}
