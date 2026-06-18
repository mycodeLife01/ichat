import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ApiError } from "../api/errors";
import type { MessageSource, PublicShareResponse, SharedMessage } from "../api/types";
import { useAppActions } from "../app/context";
import { Wordmark } from "../ui/Wordmark";
import { Markdown } from "./Markdown";
import { SourcesTrigger } from "./Message";
import { SourcesPanel } from "./SourcesPanel";
import { ThinkingBlock } from "./ThinkingBlock";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; share: PublicShareResponse };

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 760,
  );
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 760);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

// Public, read-only view of a shared conversation snapshot. Renders without a
// login: anyone with the token can read it. Reuses the same Markdown/thinking/
// sources rendering as the live thread, but deliberately NOT the <Message>
// component — that one carries edit/regenerate/copy affordances with no place
// on a public page.
export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { services } = useAppActions();
  const isMobile = useIsMobile();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [sourcesPanel, setSourcesPanel] = useState<{
    sources: MessageSource[];
    open: boolean;
  }>({ sources: [], open: false });

  useEffect(() => {
    let active = true;
    if (!token) {
      setState({ status: "error" });
      return;
    }
    setState({ status: "loading" });
    void services.shareApi
      .getPublic(token)
      .then((share) => {
        if (active) setState({ status: "ready", share });
      })
      .catch((error: unknown) => {
        // Unknown / revoked / expired all surface as a 404 from the API.
        if (active) setState({ status: "error" });
        if (!(error instanceof ApiError)) throw error;
      });
    return () => {
      active = false;
    };
  }, [token, services]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex h-[52px] shrink-0 items-center border-b border-border bg-bg">
        {/* Inner row matches the message column below (centered reading width)
            so the wordmark and login button line up with the conversation, not
            the viewport edges. */}
        <div className="mx-auto flex w-full max-w-[var(--reading-width)] items-center gap-3 px-8 max-[760px]:px-[18px]">
          <Link to="/" className="flex items-center" aria-label="iChat 首页">
            <Wordmark size={isMobile ? 20 : 18} />
          </Link>
          <span className="text-[13px] text-fg-subtle">只读分享</span>
          <Link
            to="/"
            className="ml-auto rounded-md border border-border bg-bg-raised px-3 py-1.5 text-[13px] font-medium text-fg transition-[background,border-color] duration-[120ms] hover:border-border-strong hover:bg-bg"
          >
            登录 iChat
          </Link>
        </div>
      </header>

      {/* Header stays full-width and fixed above; the scrollable thread and the
          SourcesPanel are flex-row siblings (matching AppShell) so the panel
          slides in from the right and the content column shrinks to make room
          without disturbing the header. */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          {state.status === "loading" && (
            <div className="px-8 pt-16 text-center text-[14px] text-fg-subtle">加载中…</div>
          )}
          {state.status === "error" && (
            <div className="mx-auto max-w-[var(--reading-width)] px-8 pt-16 text-center">
              <h1 className="mb-2 text-lg font-medium text-fg">分享不存在或已失效</h1>
              <p className="text-[14px] leading-[1.6] text-fg-muted">
                该分享链接可能已被撤销、已过期，或从未存在。
              </p>
              <Link
                to="/"
                className="mt-5 inline-block rounded-md bg-accent px-3.5 py-2 text-[13.5px] font-medium text-accent-fg transition-opacity duration-[120ms] hover:opacity-90"
              >
                前往 iChat
              </Link>
            </div>
          )}
          {state.status === "ready" && (
            <SharedThread
              share={state.share}
              isMobile={isMobile}
              onShowSources={(sources) => setSourcesPanel({ sources, open: true })}
            />
          )}
        </div>

        <SourcesPanel
          sources={sourcesPanel.sources}
          open={sourcesPanel.open}
          isMobile={isMobile}
          onClose={() =>
            setSourcesPanel((prev) => (prev.open ? { ...prev, open: false } : prev))
          }
        />
      </div>
    </div>
  );
}

function SharedThread({
  share,
  isMobile,
  onShowSources,
}: {
  share: PublicShareResponse;
  isMobile: boolean;
  onShowSources: (sources: MessageSource[]) => void;
}) {
  return (
    <>
      {share.title && (
        <h1 className="mx-auto mt-8 max-w-[var(--reading-width)] px-8 text-xl font-medium text-fg max-[760px]:px-[18px]">
          {share.title}
        </h1>
      )}
      {/* Same reading column as the live MessageThread. */}
      <div className="thread-inner mx-auto flex w-full max-w-[var(--reading-width)] flex-1 flex-col gap-[35.2px] px-8 pt-10 pb-16 max-[760px]:px-[18px] max-[760px]:pt-6">
        {share.messages.map((message, index) => (
          <SharedMessageView
            key={index}
            message={message}
            isMobile={isMobile}
            onShowSources={onShowSources}
          />
        ))}
      </div>
    </>
  );
}

function SharedMessageView({
  message,
  isMobile,
  onShowSources,
}: {
  message: SharedMessage;
  isMobile: boolean;
  onShowSources: (sources: MessageSource[]) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="msg user flex scroll-mt-[60px] flex-col items-end gap-1.5">
        <div className="max-w-[78%] rounded-[10px] border border-border bg-bg-sunken px-3 py-2 text-[15.5px] leading-[1.55] text-fg max-[760px]:max-w-[86%] max-[760px]:text-[17px]">
          <div className="whitespace-pre-wrap wrap-anywhere">{message.content}</div>
        </div>
      </div>
    );
  }

  const sources = message.sources ?? [];
  return (
    <div className="msg assistant flex scroll-mt-[60px] flex-col items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
        {message.reasoning && <ThinkingBlock content={message.reasoning} streaming={false} />}
        <Markdown
          content={message.content}
          sources={sources.length > 0 ? sources : undefined}
          isMobile={isMobile}
        />
        {sources.length > 0 && (
          <SourcesTrigger sources={sources} onClick={() => onShowSources(sources)} />
        )}
      </div>
    </div>
  );
}
