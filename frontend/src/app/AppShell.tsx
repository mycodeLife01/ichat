import { useEffect, useState } from "react";

import { Sidebar } from "../conversations/Sidebar";
import { Topbar } from "../conversations/Topbar";
import { selectionStore } from "../conversations/selectionStore";
import { useConversationLoader } from "../conversations/useConversationLoader";
import { useSendMessage } from "../conversations/useSendMessage";
import { MessageThread } from "../messages/MessageThread";
import { StreamingMessage } from "../messages/StreamingMessage";
import { useStickToBottom } from "../messages/useStickToBottom";
import { useRunStream } from "../runs/useRunStream";
import { useAuthSession } from "../auth/useAuthSession";
import { Composer } from "../ui/Composer";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useAppActions, useAppState } from "./context";
import "../styles/chat.css";

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
  const { ui, activeRun } = useAppState();
  const { dispatch } = useAppActions();
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

  const { start, cancel } = useRunStream();
  const send = useSendMessage(start);
  const threadRef = useStickToBottom<HTMLDivElement>([
    detail.messages.length,
    activeRun?.draftText,
    activeRun?.draftReasoning,
    activeRun?.status,
  ]);

  const onSend = () => {
    const text = composerValue;
    setComposerValue("");
    void send(text);
  };

  const onStop = () => {
    if (activeRun) void cancel(activeRun.runId);
  };

  // demo Composer state: idle / streaming / stopping
  const composerState: "idle" | "streaming" | "stopping" =
    activeRun != null && activeRun.conversationId === selectedId
      ? activeRun.cancelRequested || activeRun.status === "cancelling"
        ? "stopping"
        : activeRun.status === "queued" ||
            activeRun.status === "started" ||
            activeRun.status === "streaming"
          ? "streaming"
          : "idle"
      : "idle";

  // Bootstrap: load list, then restore stored selection (non-streaming).
  useEffect(() => {
    let active = true;
    void (async () => {
      await loadList();
      if (!active) return;
      const storedId = selectionStore.read();
      if (storedId != null) {
        await selectConversation(storedId);
      } else {
        newConversation();
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+N starts a new conversation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newConversation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newConversation]);

  const activeConversation = detail.conversation;
  const messages = detail.messages;
  const showWelcome = (selectedId == null || messages.length === 0) && activeRun == null;
  const sidebarCollapsed = ui.sidebarCollapsed;

  const confirmTarget =
    ui.confirmDialog?.kind === "deleteConversation"
      ? ui.confirmDialog.conversationId
      : null;

  return (
    <div className="app">
      <Sidebar
        items={items}
        selectedId={selectedId}
        user={user ? { email: user.email, name: user.username } : null}
        isMobile={isMobile}
        collapsed={sidebarCollapsed && !isMobile}
        mobileOpen={ui.mobileSidebarOpen}
        onSelect={(id) => void selectConversation(id)}
        onNew={newConversation}
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

      <main className="main">
        <Topbar
          title={activeConversation?.title ?? null}
          titlePending={false}
          isMobile={isMobile}
          sidebarCollapsed={sidebarCollapsed}
          onOpenMobile={() => dispatch({ type: "ui/setMobileSidebar", open: true })}
          onToggleSidebar={() => dispatch({ type: "ui/toggleSidebarCollapsed" })}
          onNewMobile={newConversation}
        />

        <div className="thread-region" ref={threadRef}>
          {!showWelcome && (
            <MessageThread messages={messages}>
              {activeRun && activeRun.conversationId === selectedId && (
                <StreamingMessage run={activeRun} />
              )}
            </MessageThread>
          )}
        </div>

        <div className="composer-area">
          <div className={`welcome-section${showWelcome ? "" : " hidden"}`}>
            <h1 className="welcome-heading">我们先从哪里开始呢？</h1>
          </div>
          <Composer
            value={composerValue}
            onChange={setComposerValue}
            onSend={onSend}
            onStop={onStop}
            state={composerState}
          />
        </div>
        <div className={`spacer-below${showWelcome ? " show" : ""}`} />
      </main>

      {confirmTarget != null && (
        <ConfirmDialog
          title="删除对话？"
          body="此对话及其全部消息将永久删除，无法恢复。"
          confirmLabel="删除"
          destructive
          onConfirm={() => void deleteConversation(confirmTarget)}
          onCancel={() => dispatch({ type: "ui/closeConfirm" })}
        />
      )}
    </div>
  );
}
