import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "../conversations/Sidebar";
import { AccountCard } from "../conversations/AccountCard";
import { MySharesCard } from "../conversations/MySharesCard";
import { ThreadActions } from "../conversations/ThreadActions";
import { MessageThread } from "../messages/MessageThread";
import { StreamingMessage } from "../messages/StreamingMessage";
import { SourcesPanel } from "../messages/SourcesPanel";
import { ScrollToBottomButton } from "../messages/ScrollToBottomButton";
import { useStickToBottom } from "../messages/useStickToBottom";
import { revealReplyQuoteSource } from "../messages/replyQuoteSourceNavigation";
import { Composer } from "../ui/Composer";
import { VerifyEmailBanner } from "../ui/VerifyEmailBanner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ShareDialog } from "../ui/ShareDialog";
import {
  ConversationSearch,
  type SearchCallback,
} from "../search/ConversationSearch";
import {
  SearchRevealContext,
  revealSearchResult,
} from "../search/revealSearchResult";
import { buildVisibleSearchText, searchTextHash } from "../search/searchText";
import { useDesignActions } from "../runtime/context";
import {
  answer,
  fixedDate,
  fileCapability,
  fileAttachment,
  imageAttachment,
  message,
  models,
  sources,
} from "../scenarios/data";
import type { Scene } from "../scenarios/registry";
import type {
  ConversationDetailResponse,
  MessageSource,
  ReplyQuote,
  ReplyQuoteDraft,
} from "../api/types";
import {
  categoryForFileName,
  categoryLimit,
  fileExtension,
} from "../files/utils";
import type { DraftAttachment } from "../files/types";
import type { ActiveRunState } from "../runs/state";
import type { ThinkingLevel } from "../runs/thinkingLevel";
import type { SearchItem } from "../search/types";
import { copyText } from "../messages/markdown/copyText";

type Props = {
  scene: Scene;
  conversations: ConversationDetailResponse[];
  onConversations: (items: ConversationDetailResponse[]) => void;
};
export function ChatPage({ scene, conversations, onConversations }: Props) {
  const { services, user, setUser, dispatch } = useDesignActions();
  const navigate = useNavigate();
  const location = useLocation();
  const selectedId = location.pathname.startsWith("/c/")
    ? location.pathname.split("/")[2]
    : null;
  const current = conversations.find((c) => c.id === selectedId);
  const messages = current?.messages ?? [];
  const [isMobile, setMobile] = useState(
    matchMedia("(max-width:760px)").matches,
  );
  useEffect(() => {
    const q = matchMedia("(max-width:760px)");
    const update = () => setMobile(q.matches);
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  const [collapsed, setCollapsed] = useState(scene.initial === "rail");
  const [mobileOpen, setMobileOpen] = useState(
    isMobile && ["account", "my-shares"].includes(scene.initial ?? ""),
  );
  const [limit, setLimit] = useState(30);
  const [loadingMore, setLoadingMore] = useState(false);
  const [value, setValue] = useState("");
  const drafts = useRef(
    new Map<
      string,
      {
        value: string;
        quote: ReplyQuoteDraft | null;
        attachments: DraftAttachment[];
      }
    >(),
  );
  const [quote, setQuote] = useState<ReplyQuoteDraft | null>(
    scene.initial === "quote"
      ? {
          source_message_id: "10000000-0000-4000-8000-000000000001",
          excerpt: "设计的价值，是让我们在实现之前看见同一个结果。",
        }
      : null,
  );
  const [attachments, setAttachments] = useState<DraftAttachment[]>(() =>
    scene.initial?.includes("attachment") || scene.initial === "upload-error"
      ? [imageAttachment, fileAttachment].map((file, i) => ({
          client_id: `sample-${i}`,
          upload_id: `sample-${i}`,
          status: scene.initial === "upload-error" ? "failed" : "succeeded",
          error_code: scene.initial === "upload-error" ? "upload_failed" : null,
          file,
          name: file.name,
          media_type: file.media_type,
          size_bytes: file.size_bytes,
          category: file.category,
          local_preview_url: i === 0 ? "/assets/landscape.svg" : undefined,
        }))
      : [],
  );
  const [model, setModel] = useState("deepseek");
  const [level, setLevel] = useState<ThinkingLevel>("low");
  const [web, setWeb] = useState(false);
  const [shareId, setShareId] = useState<string | null>(
    scene.initial === "share" ? "design-chat" : null,
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [account, setAccount] = useState(scene.initial === "account");
  const [myShares, setMyShares] = useState(scene.initial === "my-shares");
  const [sourcePanel, setSourcePanel] = useState<{
    open: boolean;
    sources: MessageSource[];
  }>({
    open: scene.initial === "sources",
    sources: scene.initial === "sources" ? sources : [],
  });
  const [searchOpen, setSearchOpen] = useState(scene.initial === "search");
  const [searchTarget, setSearchTarget] = useState<SearchItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<ReturnType<
    typeof message
  > | null>(null);
  const [animateComposer, setAnimateComposer] = useState(false);
  const [run, setRun] = useState<ActiveRunState>(() =>
    initialRun(scene.initial),
  );
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(0);
  const seq = useRef(0);
  const alive = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const {
    ref: threadRef,
    showScrollToBottom,
    scrollToBottom,
    pauseFollowing,
  } = useStickToBottom<HTMLDivElement>(
    [messages.length, run?.draftText, run?.status === "failed", submitting],
    `${selectedId}:${messages.filter((m) => m.role === "user").at(-1)?.id}:${submitting}`,
  );
  const showWelcome = !messages.length && !run && !submitting;
  const busy =
    submitting ||
    (!!run &&
      ["started", "streaming", "queued", "cancelling"].includes(run.status));
  const toast = useCallback(
    (
      message: string,
      tone: "neutral" | "success" | "error" | "warning" = "error",
    ) => dispatch({ type: "ui/showToast", message, tone }),
    [dispatch],
  );
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const update = (
    id: string,
    change: (c: ConversationDetailResponse) => ConversationDetailResponse,
  ) => onConversations(conversations.map((c) => (c.id === id ? change(c) : c)));
  function select(id: string | null) {
    ++seq.current;
    setSubmitting(false);
    setPendingMessage(null);
    setStep(0);
    drafts.current.set(selectedId ?? "new", { value, quote, attachments });
    const draft = drafts.current.get(id ?? "new");
    setValue(draft?.value ?? "");
    setQuote(draft?.quote ?? null);
    setAttachments(draft?.attachments ?? []);
    setMobileOpen(false);
    setRun(null);
    setPlaying(false);
    navigate(id ? `/c/${id}` : "/");
  }
  async function send(
    content = value,
    editId?: string,
    attachmentIds?: string[],
  ) {
    if (submitting) return;
    setSubmitting(true);
    setSearchTarget(null);
    const ticket = ++seq.current;
    const original = messages.find((item) => item.id === editId);
    const sentQuote = original?.reply_quote ?? quote;
    const sentAttachments = original
      ? (original.attachments ?? []).filter(
          (file) => !attachmentIds || attachmentIds.includes(file.id),
        )
      : attachments.flatMap((item) => (item.file ? [item.file] : []));
    if (!editId) {
      setPendingMessage({
        ...message(
          `sent-${ticket}`,
          "user",
          content.trim(),
          messages.length + 1,
        ),
        attachments: sentAttachments,
        reply_quote: sentQuote,
      });
      setValue("");
      setQuote(null);
      if (!selectedId) setAnimateComposer(true);
    }
    try {
      await services.outcomes.run("send", null);
      if (!alive.current || ticket !== seq.current) return;
      const id = selectedId ?? `design-new-${ticket}`;
      let history = messages;
      if (editId) {
        const at = history.findIndex((m) => m.id === editId);
        history = history.slice(0, Math.max(0, at));
      }
      const next = {
        ...message(`sent-${ticket}`, "user", content, history.length + 1),
        conversation_id: id,
        attachments: sentAttachments,
        reply_quote: sentQuote,
      };
      const result = [...history, next];
      if (current) update(id, (c) => ({ ...c, messages: result }));
      else {
        onConversations([
          {
            id,
            title: content.slice(0, 30) || "新对话",
            created_at: fixedDate,
            updated_at: fixedDate,
            activated_at: fixedDate,
            messages: result,
          },
          ...conversations,
        ]);
        setAnimateComposer(true);
        navigate(`/c/${id}`);
      }
      setValue("");
      setAttachments([]);
      setQuote(null);
      setStep(0);
      setRun({ ...initialRun("thinking")!, conversationId: id });
      setPlaying(true);
    } catch {
      if (!alive.current || ticket !== seq.current) return;
      if (!editId) {
        setValue(content);
        setQuote(quote);
      }
      toast("发送失败，请重试");
    } finally {
      if (alive.current && ticket === seq.current) {
        setSubmitting(false);
        setPendingMessage(null);
      }
    }
  }
  const advance = useCallback(() => setStep((s) => s + 1), []);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(advance, 180);
    return () => clearInterval(timer);
  }, [playing, advance]);
  useEffect(() => {
    if (step === 0 || !run) return;
    if (step < 4)
      setRun((r) =>
        r
          ? {
              ...r,
              streamPhase: "reasoning",
              draftReasoning: "正在整理界面、状态和交互。".slice(0, step * 5),
            }
          : r,
      );
    else if (step < 28)
      setRun((r) =>
        r
          ? {
              ...r,
              streamPhase: "text",
              draftText: answer.slice(
                0,
                Math.ceil((answer.length * (step - 3)) / 24),
              ),
            }
          : r,
      );
    else {
      setPlaying(false);
      update(selectedId!, (c) => ({
        ...c,
        messages: [
          ...c.messages,
          {
            ...message(
              `answer-${seq.current}`,
              "assistant",
              answer,
              c.messages.length + 1,
            ),
            conversation_id: c.id,
            reasoning: run.draftReasoning,
          },
        ],
      }));
      setRun(null);
      setStep(0);
    }
    // The deterministic timeline reads the latest scene on each discrete step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    const control = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.data?.type !== "design:control"
      )
        return;
      switch (event.data.action) {
        case "play":
          if (!run || ["failed", "cancelled"].includes(run.status)) {
            ++seq.current;
            setStep(0);
            setRun({
              ...initialRun("thinking")!,
              conversationId: selectedId ?? "design-chat",
            });
          }
          setPlaying(true);
          break;
        case "pause":
          setPlaying(false);
          break;
        case "step":
          if (!run) {
            ++seq.current;
            setRun(initialRun("thinking"));
            setStep(0);
          } else advance();
          break;
        case "release":
          services.outcomes.release();
          break;
      }
    };
    window.addEventListener("message", control);
    return () => window.removeEventListener("message", control);
  }, [advance, run, services, selectedId]);
  const search: SearchCallback = useCallback(
    async (params, signal) => {
      await services.outcomes.run("search", null);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const q = params.q.toLowerCase();
      const items: SearchItem[] = conversations
        .filter(
          (c) =>
            !q ||
            `${c.title} ${c.messages.map((m) => m.content).join(" ")}`
              .toLowerCase()
              .includes(q),
        )
        .map((c) => {
          const m = [...c.messages]
            .reverse()
            .find((m) => m.content.toLowerCase().includes(q));
          const index = (c.title ?? "").toLowerCase().indexOf(q);
          return {
            conversation_id: c.id,
            title: c.title,
            updated_at: c.updated_at,
            title_match:
              q && index >= 0 ? { start: index, end: index + q.length } : null,
            snippet:
              q && m
                ? {
                    text: m.content.slice(
                      Math.max(0, m.content.toLowerCase().indexOf(q) - 20),
                      m.content.toLowerCase().indexOf(q) + q.length + 55,
                    ),
                    match: {
                      start: Math.min(20, m.content.toLowerCase().indexOf(q)),
                      end:
                        Math.min(20, m.content.toLowerCase().indexOf(q)) +
                        q.length,
                    },
                    truncated_before: false,
                    truncated_after: true,
                  }
                : null,
            target:
              q && m
                ? {
                    message_id: m.id,
                    field: "body",
                    start: 0,
                    end: 0,
                    projection_version: 1,
                    projection_hash: q,
                  }
                : null,
          };
        });
      const start = Number(params.cursor ?? 0);
      const size = q ? 15 : 10;
      return {
        items: items.slice(start, start + size),
        next_cursor:
          q && start + size < items.length ? String(start + size) : null,
      };
    },
    [conversations, services],
  );
  useEffect(() => {
    const target = searchTarget?.target;
    const root = threadRef.current;
    if (!target || !root) return;
    let dispose: (() => void) | undefined;
    let active = true;
    const frame = requestAnimationFrame(async () => {
      const el = [
        ...root.querySelectorAll<HTMLElement>('[data-search-field="body"]'),
      ].find((e) => e.dataset.searchMessageId === target.message_id);
      if (!el) return;
      const projection = buildVisibleSearchText(el);
      const start = projection.text
        .toLowerCase()
        .indexOf(target.projection_hash);
      if (start < 0) return;
      const hash = await searchTextHash(projection.text);
      if (active)
        dispose = revealSearchResult(
          root,
          {
            ...target,
            start,
            end: start + target.projection_hash.length,
            projection_hash: hash,
          },
          () => toast("无法定位此段文字"),
        );
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      dispose?.();
    };
  }, [searchTarget, selectedId, threadRef, toast]);
  function reveal(quote: ReplyQuote) {
    const root = threadRef.current;
    if (!root) return;
    const source =
      [
        ...root.querySelectorAll<HTMLElement>("[data-reply-quote-source-id]"),
      ].find((e) => e.dataset.replyQuoteSourceId === quote.source_message_id) ??
      [
        ...root.querySelectorAll<HTMLElement>('[data-search-field="body"]'),
      ].find((e) => e.dataset.searchMessageId === quote.source_message_id);
    if (source) {
      pauseFollowing(false);
      revealReplyQuoteSource({
        scrollRoot: root,
        sourceRoot: source,
        excerpt: quote.excerpt,
        sourceAnchor: quote.source_anchor,
      });
    }
  }
  async function quickShare() {
    if (!selectedId) return;
    try {
      const rows = await services.shareApi.list(selectedId);
      const link =
        rows[0] ?? (await services.shareApi.create(selectedId, null));
      const copied = await copyText(
        `${window.location.origin}/share/${link.token}`,
      );
      if (!copied) throw new Error("Clipboard write failed");
      toast("公开链接已复制到剪贴板", "success");
    } catch {
      toast("复制失败");
    }
  }
  async function addFiles(files: FileList | File[]) {
    if (!user?.email_verified) {
      toast("Verify your email before uploading files.");
      return;
    }
    const selected = Array.from(files);
    if (
      selected.some((file) => categoryForFileName(file.name) === "image") &&
      model !== "vision"
    ) {
      toast("Switch to a vision model before uploading images.");
      return;
    }
    let count = attachments.length;
    let bytes = attachments.reduce((sum, file) => sum + file.size_bytes, 0);
    for (const file of selected) {
      if (
        !fileCapability.allowed_extensions.includes(fileExtension(file.name))
      ) {
        toast("The file could not be uploaded. Please try again.");
        continue;
      }
      if (count >= fileCapability.max_attachments_per_message) {
        toast(
          `You can attach at most ${fileCapability.max_attachments_per_message} files to one message.`,
        );
        break;
      }
      const limit = categoryLimit(fileCapability.category_max_bytes, file.name);
      if (limit !== null && file.size > limit) {
        toast("This file is larger than the allowed limit.");
        continue;
      }
      if (bytes + file.size > fileCapability.max_message_bytes) {
        toast("The selected files exceed the message size limit.");
        continue;
      }
      count++;
      bytes += file.size;
      const id = `local-${crypto.randomUUID()}`;
      const image = file.type.startsWith("image/");
      const url = services.registerFile(id, file);
      setAttachments((a) => [
        ...a,
        {
          client_id: id,
          upload_id: id,
          status: "uploading",
          error_code: null,
          file: null,
          name: file.name,
          media_type: file.type,
          size_bytes: file.size,
          category: categoryForFileName(file.name),
          local_preview_url: url,
        },
      ]);
      try {
        await services.outcomes.run("upload", null);
        if (alive.current)
          setAttachments((a) =>
            a.map((x) =>
              x.client_id === id
                ? {
                    ...x,
                    status: "succeeded",
                    file: {
                      id,
                      name: file.name,
                      media_type: file.type,
                      size_bytes: file.size,
                      category: categoryForFileName(file.name),
                      model_input_kind: image ? "image" : "document",
                      preview_available: image,
                    },
                  }
                : x,
            ),
          );
      } catch {
        if (alive.current)
          setAttachments((a) =>
            a.map((x) =>
              x.client_id === id
                ? { ...x, status: "failed", error_code: "upload_failed" }
                : x,
            ),
          );
      }
    }
  }
  const accountProps = {
    user: {
      email: user!.email,
      username: user!.username,
      name: user!.nickname,
      emailVerified: user!.email_verified,
      avatarUrl: user!.avatar_url,
    },
    onResendVerification: services.authApi.resendVerificationEmail,
    onUpdateNickname: async (nickname: string) =>
      setUser(await services.authApi.updateProfile(nickname)),
    onUploadAvatar: async (blob: Blob) => {
      const url = await services.authApi.uploadAvatar(blob);
      setUser({ ...user!, avatar_url: url });
      return url;
    },
    onChangePassword: async (a: string, b: string) => {
      await services.authApi.changePassword(a, b);
      setUser(null);
    },
    onRequestDeletion: services.authApi.requestAccountDeletion,
    onToast: toast,
  };
  return (
    <div className="app flex h-full bg-bg">
      <ConversationSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        search={search}
        onChoose={async (item) => {
          pauseFollowing(false);
          select(item.conversation_id);
          setSearchTarget(item);
          setSearchOpen(false);
        }}
        onStale={() => toast("无法打开这段对话，请重新搜索后再试。")}
      />
      <Sidebar
        items={conversations.slice(0, limit)}
        selectedId={selectedId}
        {...accountProps}
        isMobile={isMobile}
        collapsed={collapsed && !isMobile}
        mobileOpen={mobileOpen}
        pendingTitleIds={[]}
        hasMore={limit < conversations.length}
        isLoadingMore={loadingMore}
        onSelect={(id) => select(id)}
        onNew={() => select(null)}
        onSearch={() => {
          setMobileOpen(false);
          setSearchOpen(true);
        }}
        onLoadMore={() => {
          setLoadingMore(true);
          void services.outcomes
            .run("more", null)
            .then(() => setLimit((n) => n + 30))
            .catch(() => toast("加载失败"))
            .finally(() => setLoadingMore(false));
        }}
        onRename={(id, title) => {
          void services.outcomes
            .run("rename", null)
            .then(() => update(id, (c) => ({ ...c, title })))
            .catch(() => toast("重命名失败"));
        }}
        onRequestShare={setShareId}
        onRequestDelete={setDeleteId}
        onLogout={() => setUser(null)}
        onLoadShares={services.shareApi.listMine}
        onRevokeShare={services.shareApi.revoke}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <main
        className={`main relative flex min-w-0 flex-1 flex-col${animateComposer ? " composer-animate" : ""}`}
        onTransitionEnd={(e) => {
          if (e.propertyName === "flex-grow") setAnimateComposer(false);
        }}
      >
        <VerifyEmailBanner />
        <div className="relative flex min-h-0 flex-[1_1_0%] flex-col">
          <ThreadActions
            isMobile={isMobile}
            hasConversation={selectedId != null}
            onOpenMobileSidebar={() => setMobileOpen(true)}
            onNew={() => select(null)}
            onShare={() => void quickShare()}
            onDelete={() => setDeleteId(selectedId)}
          />
          <div
            className="thread-region relative flex min-h-0 flex-1 flex-col overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] max-[760px]:pt-8"
            data-scroll-from-end={showScrollToBottom ? "" : undefined}
            ref={threadRef}
          >
            <div className="thread-stage flex flex-auto flex-col [.composer-animate_&]:[transition:flex-grow_520ms_cubic-bezier(0.4,0,0.2,1)]">
              {!showWelcome && (
                <SearchRevealContext.Provider
                  value={searchTarget?.target?.message_id ?? null}
                >
                  <MessageThread
                    messages={messages}
                    pendingMessage={pendingMessage}
                    pendingMessageKey={pendingMessage?.id}
                    isMobile={isMobile}
                    mutateDisabledReason={
                      submitting
                        ? "请等待消息发送完成"
                        : busy
                          ? "请先停止当前生成"
                          : null
                    }
                    onEditAndRegenerate={(id, content, attachmentIds) =>
                      void send(content, id, attachmentIds)
                    }
                    onRegenerate={(id) => {
                      const at = messages.findIndex((m) => m.id === id);
                      const previous = messages
                        .slice(0, at + 1)
                        .reverse()
                        .find((m) => m.role === "user");
                      if (previous) void send(previous.content, previous.id);
                    }}
                    onReadAttachment={services.filesApi.readUrl}
                    onShowSources={(items) =>
                      setSourcePanel({ open: true, sources: items })
                    }
                    conversationId={selectedId}
                    onReplyQuote={(q) => {
                      setQuote(q);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                    onReplyQuoteError={toast}
                    onRevealReplyQuote={reveal}
                  >
                    {(submitting || run) && (
                      <StreamingMessage run={submitting ? null : run} />
                    )}
                  </MessageThread>
                </SearchRevealContext.Provider>
              )}
            </div>
            <div
              className="thread-bottom-container pointer-events-none sticky bottom-0 z-10 flex w-full shrink-0 flex-col max-[760px]:w-screen"
              data-welcome={showWelcome ? "true" : undefined}
            >
              <ScrollToBottomButton
                visible={!showWelcome && showScrollToBottom}
                onClick={scrollToBottom}
              />
              <div
                className={`welcome-section flex flex-col items-center overflow-hidden [.composer-animate_&]:[transition:opacity_320ms_ease,max-height_480ms_cubic-bezier(0.4,0,0.2,1)] ${showWelcome ? "max-h-[120px] opacity-100" : "pointer-events-none max-h-0 opacity-0"}`}
              >
                <h1 className="mt-0 mb-[22px] text-center text-2xl font-medium tracking-[-0.01em] text-fg">
                  我们先从哪里开始呢？
                </h1>
              </div>
              <Composer
                value={value}
                onChange={setValue}
                onSend={() => void send()}
                onStop={() => {
                  setPlaying(false);
                  setRun((r) =>
                    r
                      ? { ...r, status: "cancelling", cancelRequested: true }
                      : r,
                  );
                  void services.outcomes
                    .run("stop", null)
                    .then(() => {
                      if (alive.current)
                        setRun((r) => (r ? { ...r, status: "cancelled" } : r));
                    })
                    .catch(() => {
                      setRun((r) =>
                        r
                          ? {
                              ...r,
                              status: "streaming",
                              cancelRequested: false,
                            }
                          : r,
                      );
                      setPlaying(true);
                      toast("停止失败，请重试");
                    });
                }}
                state={
                  submitting
                    ? "submitting"
                    : run?.status === "cancelling"
                      ? "stopping"
                      : busy
                        ? "streaming"
                        : "idle"
                }
                thinkingLevel={level}
                onThinkingLevelChange={setLevel}
                webSearchEnabled={web}
                webSearchAvailable
                onWebSearchEnabledChange={setWeb}
                models={models}
                model={model}
                onModelChange={setModel}
                imageContext={{ state: "none" }}
                onRemoveImages={() =>
                  setAttachments((a) => a.filter((x) => x.category !== "image"))
                }
                fileCapability={fileCapability}
                fileUploadAllowed={user?.email_verified}
                attachments={submitting ? [] : attachments}
                onSelectFiles={(files) => void addFiles(files)}
                onCancelAttachment={(id) =>
                  setAttachments((a) => a.filter((x) => x.client_id !== id))
                }
                onRetryAttachment={(id) =>
                  setAttachments((a) =>
                    a.map((x) =>
                      x.client_id === id
                        ? {
                            ...x,
                            status: "succeeded",
                            error_code: null,
                            file: x.file ?? {
                              id: x.client_id,
                              name: x.name,
                              media_type: x.media_type,
                              size_bytes: x.size_bytes,
                              category: x.category,
                              model_input_kind:
                                x.category === "image" ? "image" : "document",
                              preview_available: x.category === "image",
                            },
                          }
                        : x,
                    ),
                  )
                }
                onMoveAttachment={(id, direction) =>
                  setAttachments((a) => {
                    const next = [...a];
                    const i = a.findIndex((x) => x.client_id === id);
                    const j = i + direction;
                    if (j >= 0 && j < a.length)
                      [next[i], next[j]] = [next[j], next[i]];
                    return next;
                  })
                }
                onReadAttachment={services.filesApi.readUrl}
                replyQuote={quote}
                onRemoveReplyQuote={() => setQuote(null)}
                onRevealReplyQuote={quote ? () => reveal(quote) : undefined}
                inputRef={inputRef}
                sendDisabledReason={
                  attachments.some((a) => a.status === "failed")
                    ? "Remove or retry failed attachments before sending."
                    : attachments.some((a) => a.status !== "succeeded")
                      ? "Wait until every attachment is ready before sending."
                      : attachments.some((a) => a.category === "image") &&
                          model !== "vision"
                        ? "Select a vision model before sending images."
                        : null
                }
                canSend={
                  !busy &&
                  !!(value.trim() || quote || attachments.length) &&
                  attachments.every((a) => a.status === "succeeded") &&
                  (!attachments.some((a) => a.category === "image") ||
                    model === "vision")
                }
                isMobile={isMobile}
              />
            </div>
            <div
              className={`min-h-0 shrink basis-0 [.composer-animate_&]:[transition:flex-grow_520ms_cubic-bezier(0.4,0,0.2,1)] ${showWelcome ? "grow" : "grow-0"}`}
            />
          </div>
        </div>
      </main>
      <SourcesPanel
        {...sourcePanel}
        isMobile={isMobile}
        onClose={() => setSourcePanel((p) => ({ ...p, open: false }))}
      />
      {deleteId && (
        <ConfirmDialog
          title="删除对话？"
          body="此对话将从列表中移除，并在 30 天后永久删除。"
          confirmLabel="删除"
          destructive
          onConfirm={() => {
            void services.outcomes
              .run("delete", null)
              .then(() => {
                onConversations(conversations.filter((c) => c.id !== deleteId));
                setDeleteId(null);
                if (selectedId === deleteId) select(null);
              })
              .catch(() => toast("删除失败"));
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}
      {shareId && (
        <ShareDialog
          conversationId={shareId}
          onClose={() => setShareId(null)}
        />
      )}
      {account && (
        <AccountCard {...accountProps} onClose={() => setAccount(false)} />
      )}
      {myShares && (
        <MySharesCard
          onLoad={services.shareApi.listMine}
          onRevoke={services.shareApi.revoke}
          onToast={toast}
          onClose={() => setMyShares(false)}
        />
      )}
    </div>
  );
}
function initialRun(phase?: string): ActiveRunState {
  if (
    !["thinking", "tool", "streaming", "failed", "cancelled"].includes(
      phase ?? "",
    )
  )
    return null;
  return {
    runId: "design-run",
    conversationId: "design-chat",
    providerName: "deepseek",
    latestSeq: 0,
    draftText:
      phase === "streaming" || phase === "failed" || phase === "cancelled"
        ? answer.slice(0, 180)
        : "",
    draftReasoning: "正在分析页面结构与交互状态。",
    draftReasoningSummary: "",
    streamPhase:
      phase === "tool" ? "tool" : phase === "thinking" ? "reasoning" : "text",
    toolState:
      phase === "tool"
        ? {
            status: "running",
            tool_name: "web_search",
            query: null,
            message: null,
            result_count: null,
            sources: [],
          }
        : null,
    status:
      phase === "failed"
        ? "failed"
        : phase === "cancelled"
          ? "cancelled"
          : "streaming",
    cancelRequested: false,
  };
}
