import { useCallback, useEffect, useState } from "react";

import { Sidebar } from "../conversations/Sidebar";
import { Topbar } from "../conversations/Topbar";
import { selectionStore } from "../conversations/selectionStore";
import { useConversationLoader } from "../conversations/useConversationLoader";
import { useRegenerate } from "../conversations/useRegenerate";
import { useSendMessage } from "../conversations/useSendMessage";
import { useTitlePolling } from "../conversations/useTitlePolling";
import { MessageThread } from "../messages/MessageThread";
import { StreamingMessage } from "../messages/StreamingMessage";
import { useStickToBottom } from "../messages/useStickToBottom";
import { useRunRecovery } from "../runs/useRunRecovery";
import { useRunStream } from "../runs/useRunStream";
import { thinkingLevelStore, type ThinkingLevel } from "../runs/thinkingLevel";
import { webSearchPreferenceStore } from "../runs/webSearchPreference";
import { useAuthSession } from "../auth/useAuthSession";
import { Composer } from "../ui/Composer";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { isNewChatHotkey } from "../ui/hotkeys";
import { Toast } from "../ui/Toast";
import { useAppActions, useAppState } from "./context";

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
  const { ui, activeRun, conversationIndex } = useAppState();
  const { dispatch, services, stateRef } = useAppActions();
  const {
    items,
    selectedId,
    detail,
    loadList,
    selectConversation,
    newConversation,
    renameConversation,
    deleteConversation,
  } = useConversationLoader();

  const isMobile = useIsMobile();
  const [composerValue, setComposerValue] = useState("");
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
  const onThinkingLevelChange = (level: ThinkingLevel) => {
    thinkingLevelStore.save(level);
    setThinkingLevel(level);
  };
  const onWebSearchEnabledChange = (enabled: boolean) => {
    webSearchPreferenceStore.save(enabled);
    setWebSearchEnabled(enabled);
  };
  // Gates the center → bottom composer transition. Only true while a brand-new
  // conversation sends its first message; navigating to an existing conversation
  // leaves it false so the final layout renders without animating.
  const [animateComposer, setAnimateComposer] = useState(false);

  const { start, cancel } = useRunStream();
  const send = useSendMessage(start);
  const { editAndRegenerate, regenerate } = useRegenerate(start);
  const recover = useRunRecovery(start);
  const pollTitle = useTitlePolling();
  const pendingTitleIds = conversationIndex.pendingTitleIds;
  // The id of the newest user message in the thread; advances on send and on
  // edit-and-regenerate (the edited message is re-created with a new id).
  const lastUserMessageId = detail.messages.filter((m) => m.role === "user").at(-1)?.id;
  const threadRef = useStickToBottom<HTMLDivElement>(
    [
      detail.messages.length,
      activeRun?.draftText,
      activeRun?.draftReasoning,
      activeRun?.toolState,
      activeRun?.status,
    ],
    // Jump to the bottom unconditionally when entering a conversation or when
    // the user submits a new message — even if they had scrolled up. Keyed on
    // the loaded detail's id (not selectedId) so the jump happens in the same
    // commit the messages render, when scrollHeight is final.
    `${detail.conversation?.id}:${lastUserMessageId}`,
  );

  const onSend = () => {
    const text = composerValue;
    // Animate the composer only for the first message of a brand-new conversation
    // (the empty/welcome state). Follow-up messages keep the composer pinned.
    if (selectedId == null || messages.length === 0) {
      setAnimateComposer(true);
    }
    setComposerValue("");
    void send(text);
  };

  const onStop = () => {
    if (activeRun) void cancel(activeRun.runId);
  };

  // Stable so Toast's auto-dismiss effect doesn't re-arm on every render.
  const dismissToast = useCallback(
    () => dispatch({ type: "ui/hideToast" }),
    [dispatch],
  );

  // Switching to / creating a conversation must not inherit a pending animation:
  // the target layout should render immediately.
  const onSelectConversation = (id: number) => {
    setAnimateComposer(false);
    void selectConversation(id).then(() => recover(id));
  };
  const onNewConversation = () => {
    setAnimateComposer(false);
    newConversation();
  };

  // demo Composer state: idle / streaming / stopping. Derived from status alone:
  // cancelRequested stays true after the run_cancelled terminal, so checking it
  // would leave the composer stuck on a disabled "停止中" after the stop lands.
  const composerState: "idle" | "streaming" | "stopping" =
    activeRun != null && activeRun.conversationId === selectedId
      ? activeRun.status === "cancelling"
        ? "stopping"
        : activeRun.status === "queued" ||
            activeRun.status === "started" ||
            activeRun.status === "streaming"
          ? "streaming"
          : "idle"
      : "idle";

  // Bootstrap: load list, restore stored selection, then re-attach to a run the
  // thread may still be waiting on (refresh recovery).
  useEffect(() => {
    let active = true;
    void (async () => {
      await loadList();
      try {
        const capabilities = await services.capabilitiesApi.get();
        webSearchPreferenceStore.setCapability(capabilities.web_search.enabled);
        setWebSearchAvailable(capabilities.web_search.enabled);
      } catch {
        webSearchPreferenceStore.setCapability(false);
        setWebSearchAvailable(false);
      }
      if (!active) return;
      const storedId = selectionStore.read();
      if (storedId != null) {
        await selectConversation(storedId);
        if (!active) return;
        await recover(storedId);
      } else {
        newConversation();
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const activeConversation = detail.conversation;
  const messages = detail.messages;
  const showWelcome = (selectedId == null || messages.length === 0) && activeRun == null;
  const sidebarCollapsed = ui.sidebarCollapsed;
  // Edit / regenerate mutate the thread by queuing a new run; block them while a
  // run for this conversation is in flight (the backend would 409 anyway). A
  // terminal activeRun (stopped/failed partial kept on screen) must not block —
  // composerState is already "idle" for those.
  const mutateDisabledReason =
    composerState !== "idle" ? "请先停止当前生成" : null;

  const confirmTarget =
    ui.confirmDialog?.kind === "deleteConversation"
      ? ui.confirmDialog.conversationId
      : null;

  return (
    <div className="app flex h-full bg-bg">
      <Sidebar
        items={items}
        selectedId={selectedId}
        user={user ? { email: user.email, name: user.username } : null}
        isMobile={isMobile}
        collapsed={sidebarCollapsed && !isMobile}
        mobileOpen={ui.mobileSidebarOpen}
        pendingTitleIds={pendingTitleIds}
        onSelect={onSelectConversation}
        onNew={onNewConversation}
        onRename={(id, title) => void renameConversation(id, title)}
        onRequestDelete={(id) =>
          dispatch({
            type: "ui/openConfirm",
            dialog: { kind: "deleteConversation", conversationId: id },
          })
        }
        onLogout={() => void logout()}
        onToggleCollapsed={() => dispatch({ type: "ui/toggleSidebarCollapsed" })}
        onCloseMobile={() => dispatch({ type: "ui/setMobileSidebar", open: false })}
      />

      {/* "composer-animate" gates the center → bottom composer transition via
          [.composer-animate_&]: variants on the children below — intentional
          ONLY when a brand-new conversation sends its first message. */}
      <main
        className={`main relative flex min-w-0 flex-1 flex-col${animateComposer ? " composer-animate" : ""}`}
      >
        <Topbar
          title={activeConversation?.title ?? null}
          titlePending={selectedId != null && pendingTitleIds.includes(selectedId)}
          isMobile={isMobile}
          sidebarCollapsed={sidebarCollapsed}
          onOpenMobile={() => dispatch({ type: "ui/setMobileSidebar", open: true })}
          onToggleSidebar={() => dispatch({ type: "ui/toggleSidebarCollapsed" })}
          onNewMobile={onNewConversation}
        />

        {/* scrollbar-gutter reserved so expanding a thinking block (which adds
            height and toggles the scrollbar) does not narrow the chat column.
            both-edges keeps the column centered: a right-only gutter would
            shift it 5px left of the composer's axis. */}
        <div
          className="thread-region min-h-0 flex-[1_1_0%] overflow-y-auto [scrollbar-gutter:stable_both-edges] [.composer-animate_&]:[transition:flex-grow_520ms_cubic-bezier(0.4,0,0.2,1)]"
          ref={threadRef}
        >
          {!showWelcome && (
            <MessageThread
              messages={messages}
              isMobile={isMobile}
              mutateDisabledReason={mutateDisabledReason}
              onEditAndRegenerate={(id, content) => void editAndRegenerate(id, content)}
              onRegenerate={(id) => void regenerate(id)}
            >
              {activeRun && activeRun.conversationId === selectedId && (
                <StreamingMessage run={activeRun} />
              )}
            </MessageThread>
          )}
        </div>

        <div className="flex shrink-0 flex-col">
          {/* The collapsed state keeps the node mounted (opacity/max-height, not
              display:none) so the welcome fade can animate; Tailwind's `hidden`
              utility would kill the transition. */}
          <div
            className={`welcome-section flex flex-col items-center overflow-hidden [.composer-animate_&]:[transition:opacity_320ms_ease,max-height_480ms_cubic-bezier(0.4,0,0.2,1)] ${
              showWelcome ? "max-h-[120px] opacity-100" : "pointer-events-none max-h-0 opacity-0"
            }`}
          >
            <h1 className="mt-0 mb-[22px] text-center text-2xl font-medium tracking-[-0.01em] text-fg">
              我们先从哪里开始呢？
            </h1>
          </div>
          <Composer
            value={composerValue}
            onChange={setComposerValue}
            onSend={onSend}
            onStop={onStop}
            state={composerState}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={onThinkingLevelChange}
            webSearchEnabled={webSearchEnabled}
            webSearchAvailable={webSearchAvailable}
            onWebSearchEnabledChange={onWebSearchEnabledChange}
          />
        </div>
        <div
          className={`min-h-0 shrink basis-0 [.composer-animate_&]:[transition:flex-grow_520ms_cubic-bezier(0.4,0,0.2,1)] ${showWelcome ? "grow" : "grow-0"}`}
        />
      </main>

      {confirmTarget != null && (
        <ConfirmDialog
          title="删除对话？"
          body="此对话及其全部消息将永久删除，无法恢复。"
          confirmLabel="删除"
          destructive
          onConfirm={() =>
            void deleteConversation(confirmTarget).then(() => {
              // Deletion may auto-select the next conversation; attach to its
              // pending run the same way a manual selection would.
              const nextId = stateRef.current.conversationIndex.selectedId;
              if (nextId != null) void recover(nextId);
            })
          }
          onCancel={() => dispatch({ type: "ui/closeConfirm" })}
        />
      )}

      <Toast toast={ui.toast} onDismiss={dismissToast} />
    </div>
  );
}
