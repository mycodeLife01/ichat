import { ApiError } from "../api.js";
import * as api from "../api.js";
import { getAuth, logout, withAuth } from "../auth.js";
import {
  clearStoredConversationSelection,
  getState,
  readStoredConversationIds,
  setState,
  subscribe,
} from "../state.js";
import { el, toast } from "../ui.js";
import { escapeHtml, nearBottom, scrollToBottom } from "../ui.js";
import { streamRunEvents } from "../sse.js";

const TITLE_REFRESH_ATTEMPTS = 20;
const TITLE_REFRESH_DELAY_MS = 750;

export function renderChatView(container, { onLoggedOut }) {
  const { selectedId: persistedSelected, draftConversationId: persistedDraft } =
    readStoredConversationIds();
  if (persistedSelected) {
    setState({
      selectedId: persistedSelected,
      draftConversationId: persistedDraft,
      detail: null,
    });
  }
  container.replaceChildren(buildShell({ onLoggedOut }));
  const unsubscribe = subscribe(() => { rerenderSidebar(); rerenderMain(); });
  container._chatUnsubscribe = unsubscribe;
  void loadConversations();
  if (persistedSelected) {
    void selectConversation(persistedSelected);
  }
}

function buildShell({ onLoggedOut }) {
  const root = el("div", { class: "relative h-full min-h-0 w-full flex flex-col md:flex-row bg-white overflow-hidden" });
  root.append(buildSidebarBackdrop(), buildSidebar({ onLoggedOut }), buildMain());
  return root;
}

function buildSidebarBackdrop() {
  return el("button", {
    id: "sidebar-backdrop",
    type: "button",
    class: sidebarBackdropClass(),
    "aria-label": "隐藏历史对话",
    onClick: closeSidebar,
  });
}

function isSidebarOpen() {
  return getState().sidebarOpen === true;
}

function toggleSidebar() {
  setState({ sidebarOpen: !isSidebarOpen() });
}

function closeSidebar() {
  if (isSidebarOpen()) setState({ sidebarOpen: false });
}

function sidebarClass() {
  const mobileState = isSidebarOpen() ? "translate-x-0" : "-translate-x-full";
  return [
    "fixed inset-y-0 left-0 z-40",
    "w-80 max-w-[82vw] md:w-72 md:max-w-none shrink-0",
    "border-r border-zinc-200 flex flex-col min-h-0",
    "bg-zinc-50/95 md:bg-zinc-50/40 shadow-xl md:shadow-none",
    "transform transition-transform duration-200 ease-out",
    "md:static md:translate-x-0",
    mobileState,
  ].join(" ");
}

function sidebarBackdropClass() {
  return [
    "fixed inset-0 z-30 md:hidden bg-zinc-900/20 transition-opacity duration-200",
    isSidebarOpen() ? "opacity-100" : "pointer-events-none opacity-0",
  ].join(" ");
}

function buildSidebar({ onLoggedOut }) {
  const sidebar = el("aside", {
    id: "sidebar",
    class: sidebarClass(),
  });

  const header = el("div", { class: "shrink-0 flex items-center justify-between px-4 py-3 sm:py-4 border-b border-zinc-200" }, [
    el("span", { class: "text-base font-semibold text-zinc-900" }, ["iChat"]),
    el("div", { class: "flex items-center gap-2" }, [
      el("button", {
        class: "text-xs px-2 py-1 rounded-md border border-zinc-200 hover:bg-white",
        onClick: () => void createConversation(),
      }, ["+ 新建"]),
      el("button", {
        type: "button",
        class: "md:hidden inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 hover:bg-white hover:text-zinc-900",
        title: "隐藏历史对话",
        "aria-label": "隐藏历史对话",
        onClick: closeSidebar,
      }, ["×"]),
    ]),
  ]);

  const list = el("nav", {
    id: "conversation-list",
    class: "min-h-0 flex-1 overflow-y-auto scroll-thin px-2 py-2 space-y-1",
  });

  const auth = getAuth();
  const footer = el("div", {
    class: "shrink-0 px-4 py-2 sm:py-3 border-t border-zinc-200 flex items-center justify-between",
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
  return el("section", { id: "main", class: "min-h-0 flex-1 flex flex-col min-w-0" }, [
    el("header", {
      id: "main-header",
      class: "shrink-0 min-h-12 sm:h-14 px-4 sm:px-6 flex items-center gap-3 border-b border-zinc-200 text-sm font-medium text-zinc-900",
    }, [buildSidebarToggle(), el("span", { id: "main-title", class: "min-w-0 truncate" }, ["New chat"])]),
    el("div", { id: "messages", class: "min-h-0 flex-1 overflow-y-auto scroll-thin" }),
    el("div", { id: "composer-mount", class: "shrink-0 border-t border-zinc-200" }),
  ]);
}

function buildSidebarToggle() {
  return el("button", {
    type: "button",
    class: "md:hidden inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50",
    title: "显示历史对话",
    "aria-label": "显示历史对话",
    onClick: toggleSidebar,
  }, ["☰"]);
}

function renderMainHeader(header, title) {
  const titleNode = document.getElementById("main-title");
  if (titleNode && titleNode.parentElement === header) {
    titleNode.textContent = title;
    return;
  }
  header.replaceChildren(
    buildSidebarToggle(),
    el("span", { id: "main-title", class: "min-w-0 truncate" }, [title]),
  );
}

function rerenderMain() {
  const header = document.getElementById("main-header");
  const messages = document.getElementById("messages");
  if (!header || !messages) return;

  const { selectedId, detail } = getState();
  header.ondblclick = null;
  if (!selectedId) {
    renderMainHeader(header, "New chat");
    messages.replaceChildren(emptyHero());
    mountComposer();
    return;
  }
  if (!detail || detail.id !== selectedId) {
    renderMainHeader(header, "加载中…");
    messages.replaceChildren(emptyHero("加载中…"));
    mountComposer();
    return;
  }

  renderMainHeader(header, detail.title?.trim() || "新对话");
  header.ondblclick = () => {
    const conv = getState().detail;
    if (!conv) return;
    const input = el("input", {
      type: "text",
      value: conv.title || "",
      class: "bg-transparent border-b border-zinc-400 outline-none text-base sm:text-sm font-medium w-full",
    });
    header.replaceChildren(input);
    input.focus();
    input.select();
    const commit = async () => {
      const title = input.value.trim();
      if (title && title !== (conv.title || "")) {
        try {
          const updated = await withAuth((t) => api.conversations.rename(t, conv.id, title));
          setState({
            detail: { ...getState().detail, title: updated.title },
            conversations: getState().conversations.map((c) => c.id === conv.id ? updated : c),
          });
        } catch (err) {
          toast(errorMessage(err, "重命名失败"), "error");
        }
      }
      rerenderMain();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { input.blur(); }
      if (e.key === "Escape") { input.value = conv.title || ""; input.blur(); }
    });
  };
  if (detail.messages.length === 0) {
    messages.replaceChildren(emptyHero());
  } else {
    const shouldStickToBottom = nearBottom(messages);
    const list = el("div", { class: "w-full max-w-5xl mx-auto px-4 sm:px-8 py-5 sm:py-8 space-y-4 sm:space-y-6" },
      detail.messages.map(renderMessage));
    messages.replaceChildren(list);
    if (shouldStickToBottom) requestAnimationFrame(() => scrollToBottom(messages));
  }
  mountComposer();
}

function emptyHero(text = "今天想聊点什么？") {
  return el("div", {
    class: "h-full w-full flex flex-col items-center justify-center gap-2 px-4 pb-16 text-center",
  }, [
    el("p", { class: "text-2xl sm:text-3xl font-semibold text-zinc-900" }, [text]),
    el("p", { class: "text-sm text-zinc-400" }, ["发送一条消息开始新的对话"]),
  ]);
}

export function isThinkingPanelOpen(message) {
  if (typeof message?._thinkingOpen === "boolean") return message._thinkingOpen;
  return message?._thinking === "active";
}

function buildThinkingPanel(message) {
  const reasoning = message.reasoning;
  if (!reasoning) return null;
  const active = message._thinking === "active";
  const open = isThinkingPanelOpen(message);
  const contentId = thinkingContentId(message.id);
  const toggle = el("button", {
    type: "button",
    class: "thinking-toggle inline-flex min-h-8 items-center gap-2 text-left text-sm text-zinc-500 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300",
    "aria-expanded": String(open),
    "aria-controls": contentId,
    onClick: (event) => {
      event.stopPropagation();
      setAssistantThinkingOpen(message.id, !open);
    },
  }, [
    buildThinkingIcon(),
    el("span", { class: "thinking-title" }, [active ? "思考中…" : "已思考"]),
    buildThinkingChevron(open),
  ]);
  const children = [toggle];
  if (open) {
    children.push(buildThinkingContent(contentId, reasoning));
  }
  return el("div", {
    class: "thinking-panel mb-2",
    dataset: { messageId: String(message.id) },
  }, children);
}

function thinkingContentId(messageId) {
  return `thinking-content-${String(messageId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function buildThinkingContent(contentId, reasoning) {
  return el("div", {
    id: contentId,
    class: "thinking-content ml-4 mt-2 border-l border-zinc-200 pl-4 whitespace-pre-wrap break-words text-sm leading-7 text-zinc-500",
  }, [reasoning]);
}

function buildThinkingIcon() {
  const icon = el("span", {
    class: "thinking-icon inline-flex h-5 w-5 shrink-0 items-center justify-center text-indigo-500",
    "aria-hidden": "true",
  });
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="8.5" ry="3.4"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>`;
  return icon;
}

function buildThinkingChevron(open) {
  const chevron = el("span", {
    class: thinkingChevronClass(open),
    "aria-hidden": "true",
  });
  chevron.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 8 4 4 4-4"/></svg>`;
  return chevron;
}

function thinkingChevronClass(open) {
  return `thinking-chevron inline-flex h-4 w-4 shrink-0 items-center justify-center ${open ? "is-open" : ""}`;
}

function setAssistantThinkingOpen(messageId, open) {
  const detail = getState().detail;
  if (!detail) return;
  const next = detail.messages.map((m) =>
    m.id === messageId ? { ...m, _thinkingOpen: open } : m,
  );
  setState({ detail: { ...detail, messages: next } });
}

function renderMessage(message) {
  const isUser = message.role === "user";
  const bubble = el("div", {
    class: isUser
      ? "max-w-full bg-zinc-100 text-zinc-900 rounded-2xl rounded-tr-md px-3 sm:px-4 py-3 text-base whitespace-pre-wrap break-words"
      : "markdown-body w-full text-zinc-900 px-1 py-1 text-base break-words leading-relaxed",
    dataset: { messageId: String(message.id), role: message.role },
  });
  if (isUser) {
    bubble.textContent = message.content;
  } else {
    bubble.innerHTML = renderAssistantMarkdown(message.content);
  }
  if (!isUser && message._pending) {
    bubble.insertAdjacentHTML("beforeend", `<span class="streaming-caret">▍</span>`);
  }
  if (!isUser && message._terminal === "cancelled") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-zinc-400">已取消</span>`);
  }
  if (!isUser && message._terminal === "failed") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-red-500">失败</span>`);
  }

  const actionButtons = [buildCopyButton(message.content)];
  if (typeof message.id === "number") {
    if (isUser) {
      actionButtons.push(buildEditButton(message));
    } else {
      actionButtons.push(buildRegenerateButton(message));
    }
  }
  const actions = el("div", {
    class: `message-actions flex ${isUser ? "justify-end" : "justify-start"} px-1`,
  }, actionButtons);
  const roleClass = isUser ? "message-item user items-end" : "message-item assistant items-start";
  const thinkingPanel = isUser ? null : buildThinkingPanel(message);
  const stack = el("div", {
    class: `${roleClass} flex max-w-[92%] sm:max-w-[80%] flex-col`,
  }, [thinkingPanel, bubble, actions]);

  return el("div", { class: `flex ${isUser ? "justify-end" : "justify-start"}` }, [stack]);
}

function buildCopyButton(content) {
  return el("button", {
    type: "button",
    class: "copy-message-button inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300",
    title: "Copy message",
    "aria-label": "Copy message",
    onClick: async (event) => {
      event.stopPropagation();
      if (await copyMessageText(content)) {
        toast("Copied", "success");
      } else {
        toast("Copy failed", "error");
      }
    },
  }, [el("span", { class: "copy-icon", "aria-hidden": "true" })]);
}

function buildEditButton(message) {
  const { activeRun } = getState();
  const disabled = Boolean(activeRun);
  const button = el("button", {
    type: "button",
    class: "message-edit-button inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50",
    title: disabled ? "请先停止当前生成" : "编辑并重新生成",
    "aria-label": "Edit and regenerate",
    onClick: (event) => {
      event.stopPropagation();
      startEditingUserMessage(message);
    },
  }, ["编辑"]);
  if (disabled) button.disabled = true;
  return button;
}

function buildRegenerateButton(message) {
  const { activeRun } = getState();
  const disabled = Boolean(activeRun);
  const button = el("button", {
    type: "button",
    class: "message-regenerate-button inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 disabled:cursor-not-allowed disabled:opacity-50",
    title: disabled ? "请先停止当前生成" : "重新生成",
    "aria-label": "Regenerate",
    onClick: (event) => {
      event.stopPropagation();
      void triggerRegenerate(message);
    },
  });
  button.innerHTML = `<svg class="regenerate-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>`;
  if (disabled) button.disabled = true;
  return button;
}

function startEditingUserMessage(message) {
  const detail = getState().detail;
  if (!detail) return;
  const bubble = document.querySelector(
    `[data-message-id="${message.id}"][data-role="user"]`,
  );
  if (!bubble) return;

  const original = message.content;
  const textarea = el("textarea", {
    rows: "1",
    class: "edit-bubble-textarea w-full resize-none outline-none bg-transparent text-base whitespace-pre-wrap break-words",
  });
  textarea.value = original;

  const confirmButton = el("button", {
    type: "button",
    class: "h-8 px-4 rounded-full bg-zinc-900 text-white text-sm hover:bg-zinc-800 disabled:opacity-50",
  }, ["发送"]);
  const cancelButton = el("button", {
    type: "button",
    class: "h-8 px-4 rounded-full border border-zinc-200 text-sm text-zinc-700 hover:bg-zinc-100",
  }, ["取消"]);
  const buttonRow = el("div", { class: "mt-2 flex gap-2 justify-end" }, [cancelButton, confirmButton]);
  const editor = el("div", {
    class: "edit-bubble w-full max-w-full bg-zinc-100 rounded-2xl rounded-tr-md px-3 sm:px-4 py-3",
  }, [textarea, buttonRow]);
  bubble.replaceWith(editor);

  const autosize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  textarea.addEventListener("input", autosize);
  autosize();
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  cancelButton.addEventListener("click", () => { rerenderMain(); });
  confirmButton.addEventListener("click", async () => {
    const next = textarea.value.trim();
    if (!next) { toast("内容不能为空", "error"); return; }
    if (next === original) { rerenderMain(); return; }
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    try {
      const { run } = await withAuth((t) =>
        api.conversations.editAndRegenerate(t, detail.id, message.id, next),
      );
      const refreshed = await withAuth((t) => api.conversations.detail(t, detail.id));
      if (getState().selectedId === detail.id) setState({ detail: refreshed });
      void attachRunStream({ conversationId: detail.id, runId: run.id, afterSeq: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast("当前对话有生成进行中，请先停止后再试", "error");
      } else {
        toast(errorMessage(err, "编辑失败"), "error");
      }
      rerenderMain();
    }
  });
}

async function triggerRegenerate(message) {
  const detail = getState().detail;
  if (!detail) return;
  try {
    const { run } = await withAuth((t) =>
      api.conversations.regenerate(t, detail.id, message.id),
    );
    const refreshed = await withAuth((t) => api.conversations.detail(t, detail.id));
    if (getState().selectedId === detail.id) setState({ detail: refreshed });
    void attachRunStream({ conversationId: detail.id, runId: run.id, afterSeq: 0 });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      toast("当前对话有生成进行中，请先停止后再试", "error");
    } else {
      toast(errorMessage(err, "重新生成失败"), "error");
    }
  }
}

export async function copyMessageText(content) {
  const text = String(content ?? "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back below for browsers that expose Clipboard API but deny it on HTTP.
  }
  return copyTextWithSelectionFallback(text);
}

function copyTextWithSelectionFallback(text) {
  if (!document?.body || typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  return copied;
}

function rerenderSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.className = sidebarClass();
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.className = sidebarBackdropClass();
  const list = document.getElementById("conversation-list");
  if (!list) return;
  const { conversations, selectedId, pendingTitleConversationIds } = getState();
  list.replaceChildren(...conversations.map((conv) =>
    conversationRow(conv, conv.id === selectedId, pendingTitleConversationIds.includes(conv.id)),
  ));
}

function conversationRow(conv, isActive, isTitlePending = false) {
  const title = conv.title?.trim() || "新对话";
  const row = el("div", {
    class: `group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer ${
      isActive ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-100"
    }`,
    onClick: () => { closeSidebar(); void selectConversation(conv.id); },
  });
  const titleNode = isTitlePending && !conv.title?.trim()
    ? el("span", {
        class: "conversation-title-skeleton flex-1 h-4 rounded-full",
        "aria-label": "标题生成中",
      })
    : el("span", { class: "flex-1 text-sm truncate" }, [title]);
  row.append(
    titleNode,
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
    await createEmptyConversation();
    closeSidebar();
  } catch (err) {
    toast(errorMessage(err, "Failed to create conversation"), "error");
  }
}

async function createEmptyConversation() {
  const conv = await withAuth((t) => api.conversations.create(t, null));
  setState({
    selectedId: conv.id,
    draftConversationId: conv.id,
    detail: { ...conv, messages: [] },
  });
  return conv;
}

async function ensureConversationForSubmit() {
  const { selectedId } = getState();
  if (selectedId) return selectedId;
  const conv = await createEmptyConversation();
  closeSidebar();
  return conv.id;
}

async function selectConversation(id) {
  setState({ selectedId: id, detail: null });
  try {
    const detail = await withAuth((t) => api.conversations.detail(t, id));
    if (getState().selectedId !== id) return;
    const patch = { detail };
    if (detail.activated_at && getState().draftConversationId === id) {
      patch.draftConversationId = null;
    }
    setState(patch);
    await maybeResumeRun(detail);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      // Stale selection: the conversation was deleted, never belonged to this
      // user (e.g., a persisted selectedId carried over from a previous
      // account), or is otherwise inaccessible. Drop it silently instead of
      // surfacing the raw backend message ("Conversation not found").
      if (getState().selectedId === id) {
        setState({ selectedId: null, draftConversationId: null, detail: null });
      }
      return;
    }
    toast(errorMessage(err, "加载对话失败"), "error");
  }
}

async function maybeResumeRun(detail) {
  const lastUser = [...detail.messages].reverse().find((m) => m.role === "user");
  if (!lastUser || !lastUser.run_id) return;
  // 如果该 user message 之后已经存在 assistant message，且该 assistant 的 run_id 一致，
  // 说明 run 早已 succeeded 并物化，无需 replay。
  const hasAssistantAfter = detail.messages.some(
    (m) => m.role === "assistant" && m.position > lastUser.position && m.run_id === lastUser.run_id,
  );
  if (hasAssistantAfter) return;

  let state;
  try {
    state = await withAuth((t) => api.runs.state(t, lastUser.run_id));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return;
    toast(errorMessage(err, "恢复流式连接失败"), "error");
    return;
  }

  // 任何状态都从 after_seq=0 拉一遍：active run → 接管 mid-stream；
  // 已终止但无 assistant message（cancelled/failed）→ 拿到 partial deltas 后立即终止。
  void attachRunStream({ conversationId: detail.id, runId: lastUser.run_id, afterSeq: 0 });
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
      draftConversationId:
        getState().draftConversationId === conv.id ? null : getState().draftConversationId,
      pendingTitleConversationIds:
        getState().pendingTitleConversationIds.filter((id) => id !== conv.id),
      detail: selectedId === conv.id ? null : getState().detail,
    });
  } catch (err) {
    toast(errorMessage(err, "删除失败"), "error");
  }
}

function buildComposer() {
  const { activeRun } = getState();

  const textarea = el("textarea", {
    rows: "1",
    placeholder: "Ask iChat...",
    class: "flex-1 resize-none max-h-40 px-3 py-2 text-base sm:text-sm outline-none bg-transparent disabled:text-zinc-400",
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

  const wrapper = el("div", { class: "w-full max-w-5xl mx-auto px-4 sm:px-8 py-3" }, [
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

  let isComposing = false;
  textarea.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  textarea.addEventListener("compositionend", () => {
    isComposing = false;
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      if (event.isComposing || isComposing || event.keyCode === 229) return;
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
    if (!content) return;
    textarea.value = "";
    textarea.style.height = "auto";
    try {
      const conversationId = await ensureConversationForSubmit();
      const { message, run } = await withAuth((t) => api.conversations.sendMessage(t, conversationId, content));
      // Append the user message immediately while the assistant stream starts.
      const detail = getState().detail;
      if (detail && detail.id === conversationId) {
        setState({
          detail: { ...detail, messages: [...detail.messages, message] },
        });
      }
      void attachRunStream({ conversationId, runId: run.id, afterSeq: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast("This conversation already has an active generation. Please wait or stop it before retrying.", "error");
      } else {
        toast(errorMessage(err, "Failed to send message"), "error");
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
  const message = updateAssistantMessageSilently(placeholderId, { content: text });
  if (message) patchAssistantMessageInPlace(message);
}

function updateAssistantReasoning(placeholderId, reasoning, phase) {
  const message = updateAssistantMessageSilently(placeholderId, {
    reasoning,
    _thinking: phase,
  });
  if (message) patchAssistantMessageInPlace(message);
}

function updateAssistantMessageSilently(messageId, patch) {
  const state = getState();
  const detail = state.detail;
  if (!detail) return null;

  let updated = null;
  const next = detail.messages.map((m) => {
    if (m.id !== messageId) return m;
    updated = { ...m, ...patch };
    return updated;
  });
  if (!updated) return null;

  state.detail = { ...detail, messages: next };
  return updated;
}

function patchAssistantMessageInPlace(message) {
  patchThinkingPanelInPlace(message);
  patchAssistantBubbleInPlace(message);
}

function patchAssistantBubbleInPlace(message) {
  const bubble = findAssistantBubble(message.id);
  if (!bubble) return;

  bubble.innerHTML = renderAssistantMarkdown(message.content);
  if (message._pending) {
    bubble.insertAdjacentHTML("beforeend", `<span class="streaming-caret">▍</span>`);
  }
  if (message._terminal === "cancelled") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-zinc-400">已取消</span>`);
  }
  if (message._terminal === "failed") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-red-500">失败</span>`);
  }
}

function patchThinkingPanelInPlace(message) {
  const bubble = findAssistantBubble(message.id);
  if (!bubble) return;

  let panel = findThinkingPanel(message.id);
  if (!message.reasoning) {
    panel?.remove();
    return;
  }

  if (!panel) {
    panel = buildThinkingPanel(message);
    bubble.parentElement?.insertBefore(panel, bubble);
    return;
  }

  const open = isThinkingPanelOpen(message);
  const active = message._thinking === "active";
  const contentId = thinkingContentId(message.id);
  const toggle = panel.querySelector(".thinking-toggle");
  toggle?.setAttribute("aria-expanded", String(open));
  toggle?.setAttribute("aria-controls", contentId);

  const title = panel.querySelector(".thinking-title");
  if (title) title.textContent = active ? "思考中…" : "已思考";

  const chevron = panel.querySelector(".thinking-chevron");
  if (chevron) chevron.className = thinkingChevronClass(open);

  const content = panel.querySelector(".thinking-content");
  if (!open) {
    content?.remove();
    return;
  }
  if (content) {
    content.id = contentId;
    content.textContent = message.reasoning;
  } else {
    panel.append(buildThinkingContent(contentId, message.reasoning));
  }
}

function findAssistantBubble(messageId) {
  return findByMessageId('[data-role="assistant"][data-message-id]', messageId);
}

function findThinkingPanel(messageId) {
  return findByMessageId(".thinking-panel", messageId);
}

function findByMessageId(selector, messageId) {
  const id = String(messageId);
  return Array.from(document.querySelectorAll(selector)).find(
    (node) => node.dataset.messageId === id,
  ) ?? null;
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
  let reasoningDraft = "";
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
        if (event.type === "reasoning_delta") {
          const delta = readReasoningDelta(event);
          if (delta) {
            reasoningDraft += delta;
            updateAssistantReasoning(placeholderId, reasoningDraft, "active");
            maybeAutoScroll();
          }
        } else if (event.type === "text_delta") {
          const delta = readTextDelta(event);
          if (delta) {
            if (reasoningDraft) {
              updateAssistantReasoning(placeholderId, reasoningDraft, "done");
            }
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
        const needsTitle = !detail.title?.trim();
        if (needsTitle) {
          setTitlePending(conversationId);
        }
        await loadConversations();
        applyCompletedConversationDetail(conversationId, detail);
        if (needsTitle) {
          await waitForGeneratedTitle(conversationId);
        }
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

function applyCompletedConversationDetail(conversationId, detail) {
  if (detail.title?.trim()) {
    clearTitlePending(conversationId);
  }
  if (getState().selectedId === conversationId) {
    const patch = { detail };
    if (getState().draftConversationId === conversationId) {
      patch.draftConversationId = null;
    }
    setState(patch);
  } else if (getState().draftConversationId === conversationId) {
    setState({ draftConversationId: null });
  }
}

async function waitForGeneratedTitle(conversationId) {
  for (let attempt = 0; attempt < TITLE_REFRESH_ATTEMPTS; attempt += 1) {
    await sleep(TITLE_REFRESH_DELAY_MS);
    let detail;
    try {
      detail = await withAuth((t) => api.conversations.detail(t, conversationId));
    } catch {
      clearTitlePending(conversationId);
      return;
    }
    if (detail.title?.trim()) {
      await loadConversations();
      applyCompletedConversationDetail(conversationId, detail);
      return;
    }
    applyCompletedConversationDetail(conversationId, detail);
  }
  clearTitlePending(conversationId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setTitlePending(conversationId) {
  const ids = getState().pendingTitleConversationIds;
  if (ids.includes(conversationId)) return;
  setState({ pendingTitleConversationIds: [...ids, conversationId] });
}

function clearTitlePending(conversationId) {
  const ids = getState().pendingTitleConversationIds;
  if (!ids.includes(conversationId)) return;
  setState({ pendingTitleConversationIds: ids.filter((id) => id !== conversationId) });
}

function maybeAutoScroll() {
  const messages = document.getElementById("messages");
  if (!messages) return;
  if (nearBottom(messages)) requestAnimationFrame(() => scrollToBottom(messages));
}

export function readTextDelta(event) {
  return event.payload?.text ?? event.payload?.delta ?? "";
}

export function readReasoningDelta(event) {
  return event.payload?.text ?? event.payload?.reasoning ?? "";
}

export function renderAssistantMarkdown(content) {
  const text = String(content ?? "");
  const markedParser = globalThis.marked;
  const purifier = globalThis.DOMPurify;
  if (!markedParser?.parse || !purifier?.sanitize) {
    return renderEscapedText(text);
  }

  try {
    const html = markedParser.parse(text, { breaks: true, gfm: true });
    return purifier.sanitize(html);
  } catch {
    return renderEscapedText(text);
  }
}

function renderEscapedText(text) {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function errorMessage(err, fallback) {
  return err instanceof ApiError ? err.detail : fallback;
}
