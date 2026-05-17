import { ApiError } from "../api.js";
import * as api from "../api.js";
import { getAuth, logout, withAuth } from "../auth.js";
import { getState, setState, subscribe } from "../state.js";
import { el, toast } from "../ui.js";
import { escapeHtml, nearBottom, scrollToBottom } from "../ui.js";
import { streamRunEvents } from "../sse.js";

export function renderChatView(container, { onLoggedOut }) {
  container.replaceChildren(buildShell({ onLoggedOut }));
  void loadConversations();
  const unsubscribe = subscribe(() => { rerenderSidebar(); rerenderMain(); });
  container._chatUnsubscribe = unsubscribe;
}

function buildShell({ onLoggedOut }) {
  const root = el("div", { class: "h-full w-full flex bg-white" });
  root.append(buildSidebar({ onLoggedOut }), buildMain());
  return root;
}

function buildSidebar({ onLoggedOut }) {
  const sidebar = el("aside", {
    class: "w-72 shrink-0 border-r border-zinc-200 flex flex-col bg-zinc-50/40",
    id: "sidebar",
  });

  const header = el("div", { class: "flex items-center justify-between px-4 py-4 border-b border-zinc-200" }, [
    el("span", { class: "text-base font-semibold text-zinc-900" }, ["iChat"]),
    el("button", {
      class: "text-xs px-2 py-1 rounded-md border border-zinc-200 hover:bg-white",
      onClick: () => void createConversation(),
    }, ["+ 新建"]),
  ]);

  const list = el("nav", {
    id: "conversation-list",
    class: "flex-1 overflow-y-auto scroll-thin px-2 py-2 space-y-1",
  });

  const auth = getAuth();
  const footer = el("div", {
    class: "px-4 py-3 border-t border-zinc-200 flex items-center justify-between",
  }, [
    el("div", { class: "min-w-0" }, [
      el("p", { class: "text-sm text-zinc-900 truncate" }, [auth?.user.username ?? ""]),
      el("p", { class: "text-xs text-zinc-500 truncate" }, [auth?.user.email ?? ""]),
    ]),
    el("button", {
      class: "text-xs text-zinc-500 hover:text-zinc-900",
      onClick: async () => { await logout(); onLoggedOut(); },
    }, ["登出"]),
  ]);

  sidebar.append(header, list, footer);
  return sidebar;
}

function buildMain() {
  return el("section", { id: "main", class: "flex-1 flex flex-col min-w-0" }, [
    el("header", {
      id: "main-header",
      class: "h-14 px-6 flex items-center border-b border-zinc-200 text-sm font-medium text-zinc-900",
    }, ["选择一个对话开始聊天"]),
    el("div", { id: "messages", class: "flex-1 overflow-y-auto scroll-thin" }),
    el("div", { id: "composer-mount", class: "border-t border-zinc-200" }),
  ]);
}

function rerenderMain() {
  const header = document.getElementById("main-header");
  const messages = document.getElementById("messages");
  if (!header || !messages) return;

  const { selectedId, detail } = getState();
  if (!selectedId) {
    header.textContent = "选择一个对话开始聊天";
    messages.replaceChildren(emptyHero("从左侧选一个对话，或新建一个开始"));
    return;
  }
  if (!detail || detail.id !== selectedId) {
    header.textContent = "加载中…";
    messages.replaceChildren(emptyHero("加载中…"));
    return;
  }

  header.textContent = detail.title?.trim() || "新对话";
  if (detail.messages.length === 0) {
    messages.replaceChildren(emptyHero("发出你的第一条消息开始对话"));
  } else {
    const list = el("div", { class: "max-w-3xl mx-auto px-6 py-8 space-y-6" },
      detail.messages.map(renderMessage));
    messages.replaceChildren(list);
    requestAnimationFrame(() => scrollToBottom(messages));
  }
  mountComposer();
}

function emptyHero(text) {
  return el("div", {
    class: "h-full w-full flex items-center justify-center text-zinc-400 text-sm",
  }, [text]);
}

function renderMessage(message) {
  const isUser = message.role === "user";
  const bubble = el("div", {
    class: isUser
      ? "max-w-[80%] ml-auto bg-zinc-100 text-zinc-900 rounded-2xl rounded-tr-md px-4 py-3 text-sm whitespace-pre-wrap break-words"
      : "max-w-[80%] mr-auto text-zinc-900 px-1 py-1 text-sm whitespace-pre-wrap break-words leading-relaxed",
    dataset: { messageId: String(message.id), role: message.role },
  });
  bubble.textContent = message.content;
  if (!isUser && message._pending) {
    bubble.insertAdjacentHTML("beforeend", `<span class="streaming-caret">▍</span>`);
  }
  if (!isUser && message._terminal === "cancelled") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-zinc-400">已取消</span>`);
  }
  if (!isUser && message._terminal === "failed") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-red-500">失败</span>`);
  }
  return el("div", { class: `flex ${isUser ? "justify-end" : "justify-start"}` }, [bubble]);
}

function rerenderSidebar() {
  const list = document.getElementById("conversation-list");
  if (!list) return;
  const { conversations, selectedId } = getState();
  list.replaceChildren(...conversations.map((c) => conversationRow(c, c.id === selectedId)));
}

function conversationRow(conv, isActive) {
  const title = conv.title?.trim() || "新对话";
  const row = el("div", {
    class: `group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer ${
      isActive ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-100"
    }`,
    onClick: () => void selectConversation(conv.id),
  });
  row.append(
    el("span", { class: "flex-1 text-sm truncate" }, [title]),
    el("button", {
      class: "opacity-0 group-hover:opacity-100 text-xs text-zinc-400 hover:text-zinc-900 px-1",
      title: "重命名",
      onClick: (e) => { e.stopPropagation(); void renameConversation(conv); },
    }, ["✎"]),
    el("button", {
      class: "opacity-0 group-hover:opacity-100 text-xs text-zinc-400 hover:text-red-600 px-1",
      title: "删除",
      onClick: (e) => { e.stopPropagation(); void deleteConversation(conv); },
    }, ["🗑"]),
  );
  return row;
}

async function loadConversations() {
  try {
    const list = await withAuth((t) => api.conversations.list(t));
    setState({ conversations: list });
  } catch (err) {
    toast(errorMessage(err, "加载对话列表失败"), "error");
  }
}

async function createConversation() {
  try {
    const conv = await withAuth((t) => api.conversations.create(t, null));
    setState({ conversations: [conv, ...getState().conversations] });
    await selectConversation(conv.id);
  } catch (err) {
    toast(errorMessage(err, "创建对话失败"), "error");
  }
}

async function selectConversation(id) {
  setState({ selectedId: id, detail: null });
  try {
    const detail = await withAuth((t) => api.conversations.detail(t, id));
    if (getState().selectedId === id) setState({ detail });
  } catch (err) {
    toast(errorMessage(err, "加载对话失败"), "error");
  }
}

async function renameConversation(conv) {
  const next = window.prompt("新对话名称", conv.title ?? "");
  if (next == null) return;
  const title = next.trim();
  if (!title) { toast("名称不能为空", "error"); return; }
  try {
    const updated = await withAuth((t) => api.conversations.rename(t, conv.id, title));
    setState({
      conversations: getState().conversations.map((c) => c.id === conv.id ? updated : c),
    });
  } catch (err) {
    toast(errorMessage(err, "重命名失败"), "error");
  }
}

async function deleteConversation(conv) {
  if (!window.confirm(`删除对话「${conv.title ?? "新对话"}」？`)) return;
  try {
    await withAuth((t) => api.conversations.remove(t, conv.id));
    const { selectedId } = getState();
    setState({
      conversations: getState().conversations.filter((c) => c.id !== conv.id),
      selectedId: selectedId === conv.id ? null : selectedId,
      detail: selectedId === conv.id ? null : getState().detail,
    });
  } catch (err) {
    toast(errorMessage(err, "删除失败"), "error");
  }
}

function buildComposer() {
  const { selectedId, activeRun } = getState();
  const disabled = !selectedId;

  const textarea = el("textarea", {
    rows: "1",
    placeholder: disabled ? "选择或新建一个对话后开始输入…" : "向 iChat 提问…",
    class: "flex-1 resize-none max-h-40 px-3 py-2 text-sm outline-none bg-transparent disabled:text-zinc-400",
    ...(disabled ? { disabled: "true" } : {}),
  });

  const sendButton = el("button", {
    class: "shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md bg-zinc-900 text-white text-sm hover:bg-zinc-800 disabled:bg-zinc-300",
    title: activeRun ? "停止生成" : "发送（Enter）",
  }, [activeRun ? "■" : "↑"]);

  if (activeRun && activeRun.cancelRequested) {
    sendButton.disabled = true;
    sendButton.title = "取消中…";
    sendButton.textContent = "…";
  }

  const wrapper = el("div", { class: "max-w-3xl mx-auto px-6 py-3" }, [
    el("div", {
      class: "flex items-end gap-2 border border-zinc-200 rounded-2xl px-2 py-1 bg-white shadow-sm focus-within:border-zinc-400",
    }, [textarea, sendButton]),
    el("p", { class: "text-[11px] text-zinc-400 mt-1 px-1" }, [
      activeRun ? "正在生成，按停止按钮可取消" : "Enter 发送，Shift+Enter 换行",
    ]),
  ]);

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!activeRun) void submit();
    }
  });

  sendButton.addEventListener("click", () => {
    if (activeRun) void cancelActiveRun();
    else void submit();
  });

  async function submit() {
    const content = textarea.value.trim();
    if (!content || !selectedId) return;
    textarea.value = "";
    textarea.style.height = "auto";
    try {
      const { message, run } = await withAuth((t) => api.conversations.sendMessage(t, selectedId, content));
      // 把 user message 立刻 append 到 detail.messages
      const detail = getState().detail;
      if (detail && detail.id === selectedId) {
        setState({
          detail: { ...detail, messages: [...detail.messages, message] },
        });
      }
      void attachRunStream({ conversationId: selectedId, runId: run.id, afterSeq: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast("当前对话已有未完成的生成任务，请稍候或取消后重试", "error");
      } else {
        toast(errorMessage(err, "发送失败"), "error");
      }
    }
  }

  return wrapper;
}

function mountComposer() {
  const mount = document.getElementById("composer-mount");
  if (!mount) return;
  mount.replaceChildren(buildComposer());
}

async function cancelActiveRun() {
  const { activeRun } = getState();
  if (!activeRun) return;
  setState({ activeRun: { ...activeRun, cancelRequested: true } });
  try {
    await withAuth((t) => api.runs.cancel(t, activeRun.runId));
    toast("已请求取消，等待生成停止…", "info");
  } catch (err) {
    toast(errorMessage(err, "取消失败"), "error");
  }
}

function ensureAssistantPlaceholder(conversationId, runId) {
  const detail = getState().detail;
  if (!detail || detail.id !== conversationId) return null;

  const placeholderId = `pending-${runId}`;
  if (detail.messages.some((m) => m.id === placeholderId)) return placeholderId;

  const placeholder = {
    id: placeholderId,
    conversation_id: conversationId,
    run_id: runId,
    role: "assistant",
    content: "",
    position: (detail.messages.at(-1)?.position ?? 0) + 1,
    created_at: new Date().toISOString(),
    _pending: true,
  };
  setState({ detail: { ...detail, messages: [...detail.messages, placeholder] } });
  return placeholderId;
}

function updateAssistantText(placeholderId, text) {
  const detail = getState().detail;
  if (!detail) return;
  const next = detail.messages.map((m) =>
    m.id === placeholderId ? { ...m, content: text } : m,
  );
  setState({ detail: { ...detail, messages: next } });
}

function markAssistantTerminal(placeholderId, kind) {
  // kind: "succeeded" | "failed" | "cancelled"
  const detail = getState().detail;
  if (!detail) return;
  const next = detail.messages.map((m) =>
    m.id === placeholderId ? { ...m, _terminal: kind, _pending: false } : m,
  );
  setState({ detail: { ...detail, messages: next } });
}

async function attachRunStream({ conversationId, runId, afterSeq = 0 }) {
  const previous = getState().activeRun;
  if (previous?.controller) {
    try { previous.controller.abort(); } catch {}
  }
  const placeholderId = ensureAssistantPlaceholder(conversationId, runId);
  if (!placeholderId) return;

  const controller = new AbortController();
  let draft = "";
  let terminalKind = null;
  let failureMessage = null;

  setState({
    activeRun: {
      runId, conversationId, controller, draftText: "", assistantPlaceholderId: placeholderId,
      status: "streaming",
    },
  });
  rerenderMain();

  try {
    const token = (await import("../auth.js")).getAccessToken();
    await streamRunEvents({
      runId, afterSeq, token, signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta") {
          const delta = event.payload?.delta ?? "";
          if (delta) {
            draft += delta;
            updateAssistantText(placeholderId, draft);
            maybeAutoScroll();
          }
        } else if (event.type === "run_succeeded") {
          terminalKind = "succeeded";
        } else if (event.type === "run_failed") {
          terminalKind = "failed";
          failureMessage = event.payload?.message || event.payload?.code || "Generation failed";
        } else if (event.type === "run_cancelled") {
          terminalKind = "cancelled";
        }
      },
    });
  } catch (err) {
    if (err.name !== "AbortError") {
      toast(errorMessage(err, "流式连接异常"), "error");
    }
  } finally {
    setState({ activeRun: null });
    if (terminalKind === "succeeded") {
      try {
        const detail = await withAuth((t) => api.conversations.detail(t, conversationId));
        if (getState().selectedId === conversationId) setState({ detail });
      } catch {
        markAssistantTerminal(placeholderId, "succeeded");
      }
    } else if (terminalKind === "failed") {
      markAssistantTerminal(placeholderId, "failed");
      toast(failureMessage ?? "生成失败", "error");
    } else if (terminalKind === "cancelled") {
      markAssistantTerminal(placeholderId, "cancelled");
    } else {
      markAssistantTerminal(placeholderId, "failed");
    }
    rerenderMain();
  }
}

function maybeAutoScroll() {
  const messages = document.getElementById("messages");
  if (!messages) return;
  if (nearBottom(messages)) requestAnimationFrame(() => scrollToBottom(messages));
}

function errorMessage(err, fallback) {
  return err instanceof ApiError ? err.detail : fallback;
}
