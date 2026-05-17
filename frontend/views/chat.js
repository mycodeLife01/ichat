import { ApiError } from "../api.js";
import * as api from "../api.js";
import { getAuth, logout, withAuth } from "../auth.js";
import { getState, setState, subscribe } from "../state.js";
import { el, toast } from "../ui.js";
import { escapeHtml, nearBottom, scrollToBottom } from "../ui.js";

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

function errorMessage(err, fallback) {
  return err instanceof ApiError ? err.detail : fallback;
}
