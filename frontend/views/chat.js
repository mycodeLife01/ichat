import { ApiError } from "../api.js";
import * as api from "../api.js";
import { getAuth, logout, withAuth } from "../auth.js";
import { getState, setState, subscribe } from "../state.js";
import { el, toast } from "../ui.js";

export function renderChatView(container, { onLoggedOut }) {
  container.replaceChildren(buildShell({ onLoggedOut }));
  void loadConversations();
  const unsubscribe = subscribe(() => rerenderSidebar(container));
  container._chatUnsubscribe = unsubscribe;
}

function buildShell({ onLoggedOut }) {
  const root = el("div", { class: "h-full w-full flex bg-white" });
  root.append(buildSidebar({ onLoggedOut }), buildMainPlaceholder());
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

function buildMainPlaceholder() {
  return el("section", {
    id: "main",
    class: "flex-1 flex items-center justify-center text-zinc-400 text-sm",
  }, ["选择一个对话，或点击左上角"+" + 新建 创建一个新对话"]);
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
  // 详情/消息渲染在 Task 6 接入。
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
