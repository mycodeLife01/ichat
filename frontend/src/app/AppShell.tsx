import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { Sidebar } from "../conversations/Sidebar";
import { ThreadActions } from "../conversations/ThreadActions";
import { useConversationLoader } from "../conversations/useConversationLoader";
import { useQuickShare } from "../conversations/useQuickShare";
import { useRegenerate } from "../conversations/useRegenerate";
import { useSendMessage } from "../conversations/useSendMessage";
import { useTitlePolling } from "../conversations/useTitlePolling";
import { useAttachmentUploads } from "../files/useAttachmentUploads";
import type { FileAttachment, FilesCapability } from "../files/types";
import { MessageThread } from "../messages/MessageThread";
import { ScrollToBottomButton } from "../messages/ScrollToBottomButton";
import { SourcesPanel } from "../messages/SourcesPanel";
import { StreamingMessage } from "../messages/StreamingMessage";
import { useStickToBottom } from "../messages/useStickToBottom";
import { useRunRecovery } from "../runs/useRunRecovery";
import { useRunStream } from "../runs/useRunStream";
import { modelPreferenceStore } from "../runs/modelPreference";
import {
  clampThinkingLevel,
  thinkingLevelStore,
  type ThinkingLevel,
} from "../runs/thinkingLevel";
import { webSearchPreferenceStore } from "../runs/webSearchPreference";
import { useAuthSession } from "../auth/useAuthSession";
import { tokenStore } from "../auth/tokenStore";
import { Composer } from "../ui/Composer";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ShareDialog } from "../ui/ShareDialog";
import { VerifyEmailBanner } from "../ui/VerifyEmailBanner";
import { isNewChatHotkey } from "../ui/hotkeys";
import { Toast } from "../ui/Toast";
import type { ToastHandler } from "../ui/state";
import { useAppActions, useAppState } from "./context";
import type { ChatModelCapability, MessageResponse, MessageSource } from "../api/types";

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

export function AppShell() {
  const { user, logout } = useAuthSession();
  const { ui, activeRun, conversationIndex, pendingSubmission } = useAppState();
  const { dispatch, services, stateRef } = useAppActions();
  const {
    items,
    selectedId,
    detail,
    loadList,
    loadMore,
    hasMore,
    isLoadingMore,
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  } = useConversationLoader();

  // The conversation public id is carried in the URL (`/c/:publicId`), so the
  // address bar is shareable/deep-linkable. Parsed from the path (rather than a
  // <Route> match) so a single AppShell instance survives `/` ↔ `/c/:id` without
  // remounting and re-running bootstrap. `routerReady` gates the URL↔state sync
  // until the one-time bootstrap (list load + capabilities) settles.
  const location = useLocation();
  const navigate = useNavigate();
  const publicId = location.pathname.match(/^\/c\/([^/]+)/)?.[1];
  const [routerReady, setRouterReady] = useState(false);

  const isMobile = useIsMobile();
  const [composerValue, setComposerValue] = useState("");
  const [fileCapability, setFileCapability] = useState<FilesCapability>();
  const sentImagePreviewUrlsRef = useRef(new Map<string, string>());
  const [sentImagePreviews, setSentImagePreviews] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [messageRenderKeys, setMessageRenderKeys] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // Thinking level drives the per-request thinking options sent with every
  // send/edit/regenerate call (read from the store at call time); persisted so
  // the choice survives reloads.
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() =>
    thinkingLevelStore.read(),
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(() =>
    webSearchPreferenceStore.read(),
  );
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  // Selectable chat models arrive with capabilities; the persisted choice only
  // applies while the server still offers it (modelPreferenceStore.resolve()).
  const [models, setModels] = useState<ChatModelCapability[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const appliedImageContextRef = useRef<string | null>(null);
  const imageContext = detail.imageContext;
  const selectedModel = models.find((entry) => entry.id === modelId) ?? null;
  const onThinkingLevelChange = (level: ThinkingLevel) => {
    thinkingLevelStore.save(level);
    setThinkingLevel(level);
  };
  const onWebSearchEnabledChange = (enabled: boolean) => {
    webSearchPreferenceStore.save(enabled);
    setWebSearchEnabled(enabled);
  };
  const onModelChange = (id: string) => {
    modelPreferenceStore.save(id);
    setModelId(id);
    // Snap the persisted thinking level onto the new model's tiers so the
    // pill never shows a level the model cannot run.
    const entry = modelPreferenceStore.available().find((m) => m.id === id);
    if (entry && entry.thinking_levels.length > 0) {
      const clamped = clampThinkingLevel(thinkingLevelStore.read(), entry.thinking_levels);
      thinkingLevelStore.save(clamped);
      setThinkingLevel(clamped);
    }
  };
  // Gates the center → bottom composer transition. Only true while a brand-new
  // conversation sends its first message; navigating to an existing conversation
  // leaves it false so the final layout renders without animating.
  const [animateComposer, setAnimateComposer] = useState(false);
  // Sources panel (ChatGPT-style right sidebar). Always mounted so open and
  // close both transition; `sources` is kept through the close animation.
  const [sourcesPanel, setSourcesPanel] = useState<{
    sources: MessageSource[];
    open: boolean;
  }>({ sources: [], open: false });
  const showSources = (sources: MessageSource[]) =>
    setSourcesPanel({ sources, open: true });
  const closeSources = () =>
    setSourcesPanel((prev) => (prev.open ? { ...prev, open: false } : prev));

  const { start, cancel } = useRunStream();
  const registerCommittedSubmission = useCallback(
    (messageId: string, clientSubmissionId: string) => {
      setMessageRenderKeys((current) => {
        const next = new Map(current);
        next.set(messageId, clientSubmissionId);
        return next;
      });
    },
    [],
  );
  const send = useSendMessage(start, registerCommittedSubmission);
  const { editAndRegenerate, regenerate } = useRegenerate(start);
  const recover = useRunRecovery(start);
  const pollTitle = useTitlePolling();
  const quickShare = useQuickShare();
  const pendingTitleIds = conversationIndex.pendingTitleIds;
  const restoreComposerContent = useCallback((content: string) => {
    setComposerValue(content);
  }, []);
  const attachmentUploads = useAttachmentUploads({
    userId: user?.id ?? null,
    conversationId: selectedId,
    capability: fileCapability,
    selectedModel,
    canCreate: user?.email_verified === true,
    filesApi: services.filesApi,
    onRestoredContent: restoreComposerContent,
    onError: (message) => dispatch({ type: "ui/showToast", message, tone: "error" }),
    onImagesBlocked: () =>
      dispatch({
        type: "ui/showToast",
        message: "Switch to a vision model before uploading images.",
        tone: "warning",
      }),
  });
  const releaseSentImagePreview = useCallback((fileId: string) => {
    const url = sentImagePreviewUrlsRef.current.get(fileId);
    if (!url) return;
    sentImagePreviewUrlsRef.current.delete(fileId);
    URL.revokeObjectURL(url);
    setSentImagePreviews(new Map(sentImagePreviewUrlsRef.current));
  }, []);
  useEffect(
    () => () => {
      sentImagePreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      sentImagePreviewUrlsRef.current.clear();
    },
    [],
  );
  const onComposerValueChange = (value: string) => {
    setComposerValue(value);
    attachmentUploads.setDraftContent(value);
  };
  // The id of the newest user message in the thread; advances on send and on
  // edit-and-regenerate (the edited message is re-created with a new id).
  const lastUserMessageId = detail.messages.filter((m) => m.role === "user").at(-1)?.id;
  // Reasoning/tool deltas intentionally do not drive bottom-sticking: expanding
  // that status block would move its header on every chunk. Formal answer text
  // still follows the stream, and failures scroll their persistent alert in.
  const {
    ref: threadRef,
    showScrollToBottom,
    scrollToBottom,
  } = useStickToBottom<HTMLDivElement>(
    [
      detail.messages.length,
      activeRun?.draftText,
      activeRun?.status === "failed",
      pendingSubmission?.content,
    ],
    // Jump to the bottom unconditionally when entering a conversation or when
    // the user submits a new message — even if they had scrolled up. Keyed on
    // the loaded detail plus the pending content so both the optimistic turn
    // and the server-materialized message move the viewport after rendering.
    `${detail.conversation?.id}:${lastUserMessageId}:${pendingSubmission?.content ?? ""}`,
  );

  const onSend = () => {
    const text = composerValue;
    const readyImagesAllowed =
      !attachmentUploads.hasReadyImageAttachment || selectedModel?.supports_image_input === true;
    if (
      (!text.trim() && (!attachmentUploads.hasModelConsumableAttachment || !readyImagesAllowed)) ||
      attachmentUploads.hasPendingAttachments ||
      attachmentUploads.hasFailedAttachments ||
      pendingSubmission !== null
    ) {
      return;
    }
    // Animate the composer only for the first message of a brand-new conversation
    // (the empty/welcome state). Follow-up messages keep the composer pinned.
    if (selectedId == null || messages.length === 0) {
      setAnimateComposer(true);
    }
    onComposerValueChange("");
    const attachmentIds =
      attachmentUploads.readyAttachmentIds.length > 0
        ? attachmentUploads.readyAttachmentIds
        : undefined;
    const selectedAttachmentIds = new Set(attachmentIds ?? []);
    const optimisticAttachments = attachmentUploads.attachments
      .map((attachment) => attachment.file)
      .filter(
        (file): file is FileAttachment =>
          file !== null && selectedAttachmentIds.has(file.id),
      );
    const detachedImagePreviews = attachmentUploads.detachImagePreviews(attachmentIds ?? []);
    if (detachedImagePreviews.length > 0) {
      for (const preview of detachedImagePreviews) {
        const previousUrl = sentImagePreviewUrlsRef.current.get(preview.fileId);
        if (previousUrl && previousUrl !== preview.url) URL.revokeObjectURL(previousUrl);
        sentImagePreviewUrlsRef.current.set(preview.fileId, preview.url);
      }
      setSentImagePreviews(new Map(sentImagePreviewUrlsRef.current));
    }
    void send(text, attachmentIds, optimisticAttachments).then((sent) => {
      // A rapid duplicate call is ignored while the original submission stays
      // pending; only a real failure clears that state and restores the draft.
      if (!sent && stateRef.current.pendingSubmission === null) {
        setComposerValue((current) => {
          const restored = current === "" ? text : current;
          attachmentUploads.setDraftContent(restored);
          return restored;
        });
      }
      if (sent) {
        attachmentUploads.clear();
      } else if (detachedImagePreviews.length > 0) {
        attachmentUploads.restoreImagePreviews(detachedImagePreviews);
        let changed = false;
        for (const preview of detachedImagePreviews) {
          if (sentImagePreviewUrlsRef.current.get(preview.fileId) !== preview.url) continue;
          sentImagePreviewUrlsRef.current.delete(preview.fileId);
          changed = true;
        }
        if (changed) setSentImagePreviews(new Map(sentImagePreviewUrlsRef.current));
      }
    });
  };

  const onStop = () => {
    if (activeRun) void cancel(activeRun.runId);
  };

  // Stable so Toast's auto-dismiss effect doesn't re-arm on every render.
  const dismissToast = useCallback(
    () => dispatch({ type: "ui/hideToast" }),
    [dispatch],
  );
  // Stable so consumers can safely list it in effect deps (MySharesCard's
  // load effect reports failures through it).
  const showToast = useCallback<ToastHandler>(
    (message, tone) => dispatch({ type: "ui/showToast", message, tone }),
    [dispatch],
  );

  // Switching to / creating a conversation drives the URL; the param-sync effect
  // below performs the actual load + run recovery. The sources panel belongs to a
  // message in the previous thread, so it closes too.
  const onSelectConversation = (id: string) => {
    setAnimateComposer(false);
    closeSources();
    if (id !== selectedId) navigate(`/c/${id}`);
  };
  const onNewConversation = () => {
    setAnimateComposer(false);
    closeSources();
    navigate("/");
  };

  // Keep the pre-Run HTTP phase distinct from streaming: the submit action is
  // busy but cannot offer Stop until the server has returned a Run id.
  let composerState: "idle" | "submitting" | "streaming" | "stopping" = "idle";
  if (pendingSubmission !== null) {
    composerState = "submitting";
  } else if (activeRun != null && activeRun.conversationId === selectedId) {
    if (activeRun.status === "cancelling") {
      composerState = "stopping";
    } else if (
      activeRun.status === "queued" ||
      activeRun.status === "started" ||
      activeRun.status === "streaming"
    ) {
      composerState = "streaming";
    }
  }

  // Bootstrap (once): load list + capabilities, then let the current URL drive
  // the initial route. Landing on `/` is always a blank new conversation; only
  // `/c/:publicId` loads an existing conversation.
  useEffect(() => {
    let active = true;
    void (async () => {
      await loadList();
      try {
        const capabilities = await services.capabilitiesApi.get();
        webSearchPreferenceStore.setCapability(capabilities.web_search.enabled);
        setWebSearchAvailable(capabilities.web_search.enabled);
        modelPreferenceStore.setAvailable(capabilities.models);
        setModels(capabilities.models);
        setModelId(modelPreferenceStore.resolve()?.id ?? null);
        setFileCapability(capabilities.files);
      } catch {
        webSearchPreferenceStore.setCapability(false);
        setWebSearchAvailable(false);
        modelPreferenceStore.setAvailable([]);
        setFileCapability(undefined);
      }
      if (!active) return;
      setRouterReady(true);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!detail.conversation || models.length === 0) return;
    const key = `${detail.conversation.id}:${imageContext.state}:${imageContext.legacy_message_id ?? ""}:${imageContext.recommended_model ?? ""}`;
    if (appliedImageContextRef.current === key) return;
    appliedImageContextRef.current = key;
    const resolved = modelPreferenceStore.resolveForImageContext(imageContext);
    if (resolved && resolved.id !== modelId) {
      modelPreferenceStore.save(resolved.id);
      setModelId(resolved.id);
      if (resolved.thinking_levels.length > 0) {
        const clamped = clampThinkingLevel(thinkingLevelStore.read(), resolved.thinking_levels);
        thinkingLevelStore.save(clamped);
        setThinkingLevel(clamped);
      }
    }
  }, [detail.conversation, imageContext, modelId, models]);

  // URL → state: select the conversation named in the path (and recover any
  // in-flight run), or reset to a blank new conversation at the root.
  useEffect(() => {
    if (!routerReady) return;
    if (publicId) {
      if (publicId !== stateRef.current.conversationIndex.selectedId) {
        void selectConversation(publicId).then(() => recover(publicId));
      }
    } else if (stateRef.current.conversationIndex.selectedId != null) {
      newConversation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, routerReady]);

  // state → URL: mirror selection changes that originate in state (first message
  // of a new conversation, delete auto-select) back into the address bar. Read
  // the selection from stateRef, not the render closure: when a deep link is
  // being opened, the URL→state effect above has already set selectedId
  // synchronously via dispatch, but this render's `selectedId` is still stale
  // (null) — using it would navigate back to "/" and blow away the deep link.
  useEffect(() => {
    if (!routerReady) return;
    const current = stateRef.current.conversationIndex.selectedId;
    if ((publicId ?? null) !== current) {
      navigate(current ? `/c/${current}` : "/");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, routerReady]);

  // Ctrl/⌘+Shift+O starts a new conversation (see ui/hotkeys.ts for why not N).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isNewChatHotkey(event)) {
        event.preventDefault();
        onNewConversation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newConversation]);

  // Drive the auto-title poll loop for any conversation marked pending (e.g. by
  // useRunStream after a draft's first run succeeds). pollTitle dedups per id.
  useEffect(() => {
    for (const id of pendingTitleIds) {
      void pollTitle(id);
    }
  }, [pendingTitleIds, pollTitle]);

  const messages = detail.messages;
  const visiblePendingSubmission =
    pendingSubmission !== null &&
    pendingSubmission.conversationId === selectedId
      ? pendingSubmission
      : null;
  const pendingMessage: MessageResponse | null = visiblePendingSubmission
    ? {
        id: visiblePendingSubmission.clientId,
        conversation_id: visiblePendingSubmission.conversationId ?? "",
        run_id: null,
        role: "user",
        content: visiblePendingSubmission.content,
        reasoning: null,
        attachments: visiblePendingSubmission.attachments,
        position: (messages.at(-1)?.position ?? 0) + 1,
        created_at: "",
      }
    : null;
  const showWelcome =
    (selectedId == null || messages.length === 0) &&
    activeRun == null &&
    pendingMessage == null;
  const sidebarCollapsed = ui.sidebarCollapsed;
  // Edit / regenerate mutate the thread by queuing a new run; block them while a
  // run for this conversation is in flight (the backend would 409 anyway). A
  // terminal activeRun (stopped/failed partial kept on screen) must not block —
  // composerState is already "idle" for those.
  const mutateDisabledReason =
    composerState === "submitting"
      ? "请等待消息发送完成"
      : composerState !== "idle"
        ? "请先停止当前生成"
        : null;
  const visionUnavailable =
    imageContext.state === "vision_required" &&
    modelPreferenceStore.resolveForImageContext(imageContext) === null;
  // A vision-dependent branch must stay read-only until a compatible model is
  // selected. This also covers the brief render while model capabilities are
  // loading or a stale non-vision preference is being corrected.
  const visionMutationBlocked =
    imageContext.state === "vision_required" &&
    (visionUnavailable || selectedModel?.supports_image_input !== true);
  const mutationDisabledReason =
    mutateDisabledReason ??
    (visionMutationBlocked ? "This conversation requires a compatible vision model." : null);
  const readyImagesAllowed =
    !attachmentUploads.hasReadyImageAttachment || selectedModel?.supports_image_input === true;
  const sendDisabledReason =
    attachmentUploads.hasPendingAttachments
      ? "Wait until every attachment is ready before sending."
      : attachmentUploads.hasFailedAttachments
        ? "Remove or retry failed attachments before sending."
        : visionMutationBlocked
          ? visionUnavailable
            ? "No compatible vision model is currently available."
            : "This conversation requires a compatible vision model."
          : !readyImagesAllowed
            ? "Select a vision model before sending images."
        : !composerValue.trim() && attachmentUploads.attachments.length > 0 && !attachmentUploads.hasModelConsumableAttachment
          ? "Add text or a readable document. Images alone cannot be sent."
          : null;
  const canSend = composerState === "idle" && sendDisabledReason === null && (
    Boolean(composerValue.trim()) ||
    (attachmentUploads.hasModelConsumableAttachment && readyImagesAllowed)
  );

  const confirmTarget =
    ui.confirmDialog?.kind === "deleteConversation"
      ? ui.confirmDialog.conversationId
      : null;

  return (
    <div className="app flex h-full bg-bg">
      <Sidebar
        items={items}
        selectedId={selectedId}
        user={
          user
            ? {
                email: user.email,
                username: user.username,
                name: user.nickname,
                emailVerified: user.email_verified,
                avatarUrl: user.avatar_url,
              }
            : null
        }
        isMobile={isMobile}
        collapsed={sidebarCollapsed && !isMobile}
        mobileOpen={ui.mobileSidebarOpen}
        pendingTitleIds={pendingTitleIds}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onSelect={onSelectConversation}
        onNew={onNewConversation}
        onLoadMore={() => void loadMore()}
        onRename={(id, title) => void renameConversation(id, title)}
        onRequestShare={(id) =>
          dispatch({ type: "ui/openShare", dialog: { conversationId: id } })
        }
        onRequestDelete={(id) =>
          dispatch({
            type: "ui/openConfirm",
            dialog: { kind: "deleteConversation", conversationId: id },
          })
        }
        onLogout={() => void logout()}
        onResendVerification={() => services.authApi.resendVerificationEmail()}
        onUpdateNickname={async (nickname) => {
          const updated = await services.authApi.updateProfile(nickname);
          tokenStore.updateUser(updated);
          dispatch({ type: "auth/userUpdated", user: updated });
        }}
        onUploadAvatar={async (blob) => {
          if (!services.authApi.uploadAvatar || !user) throw new Error("Avatar upload is unavailable");
          const avatarUrl = await services.authApi.uploadAvatar(blob);
          const updated = { ...user, avatar_url: avatarUrl };
          tokenStore.updateUser(updated);
          dispatch({ type: "auth/userUpdated", user: updated });
          return avatarUrl;
        }}
        onChangePassword={async (currentPassword, newPassword) => {
          await services.authApi.changePassword(currentPassword, newPassword);
          await logout();
        }}
        onRequestDeletion={(password) => services.authApi.requestAccountDeletion(password)}
        onLoadShares={services.shareApi.listMine}
        onRevokeShare={services.shareApi.revoke}
        onToast={showToast}
        onToggleCollapsed={() => dispatch({ type: "ui/toggleSidebarCollapsed" })}
        onCloseMobile={() => dispatch({ type: "ui/setMobileSidebar", open: false })}
      />

      {/* "composer-animate" gates the center → bottom composer transition via
          [.composer-animate_&]: variants on the children below — intentional
          ONLY when a brand-new conversation sends its first message. */}
      <main
        className={`main relative flex min-w-0 flex-1 flex-col bg-[var(--chat-shell-bg)]${animateComposer ? " composer-animate" : ""}`}
        onTransitionEnd={(event) => {
          if (event.propertyName === "flex-grow") {
            setAnimateComposer(false);
          }
        }}
      >
        <VerifyEmailBanner />

        {/* scrollbar-gutter reserved so expanding a thinking block (which adds
            height and toggles the scrollbar) does not narrow the chat column.
            both-edges keeps the column centered: a right-only gutter would
            shift it 5px left of the composer's axis. */}
        <div className="relative flex min-h-0 flex-[1_1_0%] flex-col">
          <ThreadActions
            isMobile={isMobile}
            hasConversation={selectedId != null}
            onOpenMobileSidebar={() => dispatch({ type: "ui/setMobileSidebar", open: true })}
            onNew={onNewConversation}
            onShare={() => {
              if (selectedId == null) return;
              void quickShare(
                selectedId,
                detail.messages.some((message) => (message.attachments?.length ?? 0) > 0),
              );
            }}
            onDelete={() => {
              if (selectedId == null) return;
              dispatch({
                type: "ui/openConfirm",
                dialog: { kind: "deleteConversation", conversationId: selectedId },
              });
            }}
          />
          {/* Mobile pads the scroll container so the floating actions do not sit
              on top of the first message when the thread is at the top. */}
          <div
            className="thread-region native-scrollbar relative flex min-h-0 flex-1 flex-col overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] max-[760px]:pt-8"
            data-scroll-from-end={showScrollToBottom ? "" : undefined}
            ref={threadRef}
          >
            <div className="thread-stage flex flex-auto flex-col [.composer-animate_&]:[transition:flex-grow_520ms_cubic-bezier(0.4,0,0.2,1)]">
              {!showWelcome && (
                <MessageThread
                  messages={messages}
                  pendingMessage={pendingMessage}
                  pendingMessageKey={visiblePendingSubmission?.clientId}
                  messageRenderKeys={messageRenderKeys}
                  isMobile={isMobile}
                  mutateDisabledReason={mutationDisabledReason}
                  onEditAndRegenerate={(id, content, attachmentIds) => {
                    void editAndRegenerate(id, content, attachmentIds);
                  }}
                  onRegenerate={(id) => void regenerate(id)}
                  legacyMessageId={imageContext.legacy_message_id}
                  onUpgradeLegacy={(messageId) => {
                    const visual = models.find((entry) => entry.supports_image_input);
                    if (!visual) {
                      dispatch({
                        type: "ui/showToast",
                        message: "No compatible vision model is currently available.",
                        tone: "warning",
                      });
                      return;
                    }
                    onModelChange(visual.id);
                    void regenerate(messageId);
                  }}
                  onEditUpgradeLegacy={() => {
                    const visual = models.find((entry) => entry.supports_image_input);
                    if (!visual) {
                      dispatch({
                        type: "ui/showToast",
                        message: "No compatible vision model is currently available.",
                        tone: "warning",
                      });
                      return false;
                    }
                    onModelChange(visual.id);
                    return true;
                  }}
                  onStartNewConversation={onNewConversation}
                  onReadAttachment={services.filesApi.readUrl}
                  localImagePreviews={sentImagePreviews}
                  onLocalImagePreviewConsumed={releaseSentImagePreview}
                  onShowSources={showSources}
                >
                  {visiblePendingSubmission !== null ||
                  (activeRun && activeRun.conversationId === selectedId) ? (
                    <StreamingMessage
                      run={visiblePendingSubmission !== null ? null : activeRun}
                    />
                  ) : null}
                </MessageThread>
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
              {/* The collapsed state keeps the node mounted (opacity/max-height, not
                  display:none) so the welcome fade can animate; Tailwind's `hidden`
                  utility would kill the transition. */}
              <div
                className={`welcome-section flex flex-col items-center overflow-hidden [.composer-animate_&]:[transition:opacity_320ms_ease,max-height_480ms_cubic-bezier(0.4,0,0.2,1)] ${
                  showWelcome
                    ? "max-h-[120px] opacity-100"
                    : "pointer-events-none max-h-0 opacity-0"
                }`}
              >
                <h1 className="mt-0 mb-[22px] text-center text-2xl font-medium tracking-[-0.01em] text-fg">
                  我们先从哪里开始呢？
                </h1>
              </div>
              <Composer
                value={composerValue}
                onChange={onComposerValueChange}
                onSend={onSend}
                onStop={onStop}
                state={composerState}
                thinkingLevel={thinkingLevel}
                onThinkingLevelChange={onThinkingLevelChange}
                webSearchEnabled={webSearchEnabled}
                webSearchAvailable={webSearchAvailable}
                onWebSearchEnabledChange={onWebSearchEnabledChange}
                models={models}
                model={modelId}
                onModelChange={onModelChange}
                imageContext={imageContext}
                onRemoveImages={attachmentUploads.removeImages}
                fileCapability={fileCapability}
                fileUploadAllowed={user?.email_verified === true}
                attachments={pendingSubmission === null ? attachmentUploads.attachments : []}
                onSelectFiles={attachmentUploads.addFiles}
                onCancelAttachment={(clientId) =>
                  void attachmentUploads.cancelAttachment(clientId)
                }
                onRetryAttachment={attachmentUploads.retryAttachment}
                onMoveAttachment={attachmentUploads.moveAttachment}
                onReadAttachment={services.filesApi.readUrl}
                canSend={canSend}
                sendDisabledReason={sendDisabledReason}
                readOnly={visionMutationBlocked}
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
        sources={sourcesPanel.sources}
        open={sourcesPanel.open}
        isMobile={isMobile}
        onClose={closeSources}
      />

      {confirmTarget != null && (
        <ConfirmDialog
          title="删除对话？"
          body="此对话将从列表中移除，并在 30 天后永久删除。"
          confirmLabel="删除"
          destructive
          onConfirm={() =>
            // Deletion may auto-select the next conversation; the resulting
            // selection change drives the URL, and the URL→state effect attaches
            // to any pending run — no explicit recovery needed here.
            void deleteConversation(confirmTarget)
          }
          onCancel={() => dispatch({ type: "ui/closeConfirm" })}
        />
      )}

      {ui.shareDialog != null && (
        <ShareDialog
          conversationId={ui.shareDialog.conversationId}
          hasAttachments={detail.messages.some((message) => (message.attachments?.length ?? 0) > 0)}
          onClose={() => dispatch({ type: "ui/closeShare" })}
        />
      )}

      <Toast toast={ui.toast} onDismiss={dismissToast} />
    </div>
  );
}
