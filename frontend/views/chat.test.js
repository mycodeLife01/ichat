import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { copyMessageText, readTextDelta, renderAssistantMarkdown } from "./chat.js";

const chatSource = readFileSync(new URL("./chat.js", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../state.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../auth.js", import.meta.url), "utf8");
const loginSource = readFileSync(new URL("./login.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("reads backend text_delta payload text", () => {
  const event = {
    type: "text_delta",
    payload: { text: "Hello" },
  };

  assert.equal(readTextDelta(event), "Hello");
});

test("keeps compatibility with legacy text_delta payload delta", () => {
  const event = {
    type: "text_delta",
    payload: { delta: "Hello" },
  };

  assert.equal(readTextDelta(event), "Hello");
});

test("uses responsive Tailwind classes for the chat layout", () => {
  assert.match(chatSource, /flex-col\s+md:flex-row/);
  assert.match(chatSource, /w-80\s+max-w-\[82vw\]\s+md:w-72/);
  assert.match(chatSource, /px-4\s+sm:px-6/);
  assert.match(chatSource, /max-w-\[92%\]\s+sm:max-w-\[80%\]/);
});

test("uses a wider message column with larger message text", () => {
  assert.match(chatSource, /w-full\s+max-w-5xl\s+mx-auto/);
  assert.doesNotMatch(chatSource, /max-w-3xl/);
  assert.match(chatSource, /py-3\s+text-base\s+whitespace-pre-wrap/);
  assert.match(chatSource, /text-base\s+break-words\s+leading-relaxed/);
});

test("shows a ChatGPT-style prompt on the empty chat screen", () => {
  assert.match(chatSource, /今天想聊点什么？/);
  assert.match(chatSource, /发送一条消息开始新的对话/);
  assert.match(chatSource, /text-2xl\s+sm:text-3xl\s+font-semibold/);
  assert.doesNotMatch(chatSource, /Send a message to start a new chat/);
  assert.doesNotMatch(chatSource, /发出你的第一条消息开始对话/);
});

test("only autoscrolls streaming messages when the viewport is already near the bottom", () => {
  assert.match(chatSource, /const shouldStickToBottom = nearBottom\(messages\)/);
  assert.match(
    chatSource,
    /messages\.replaceChildren\(list\);\s*if \(shouldStickToBottom\) requestAnimationFrame\(\(\) => scrollToBottom\(messages\)\)/,
  );
});

test("renders copy actions for user and assistant messages", () => {
  assert.match(chatSource, /buildCopyButton\(message\.content\)/);
  assert.match(chatSource, /copyMessageText\(content\)/);
  assert.match(chatSource, /navigator\.clipboard\?\.writeText/);
  assert.match(chatSource, /message-item user/);
  assert.match(chatSource, /message-item assistant/);
  assert.match(stylesSource, /\.message-item\.user \.message-actions/);
  assert.match(stylesSource, /\.message-item\.user:hover \.message-actions/);
  assert.match(stylesSource, /\.message-item\.assistant \.message-actions/);
  assert.match(stylesSource, /\.copy-icon::before/);
});

test("reveals the user copy action without changing message layout", () => {
  assert.match(stylesSource, /\.message-actions\s*\{[\s\S]*height:\s*1\.75rem/);
  assert.match(stylesSource, /\.message-item\.user \.message-actions\s*\{[\s\S]*opacity:\s*0/);
  assert.match(stylesSource, /\.message-item\.user:hover \.message-actions,[\s\S]*opacity:\s*1/);
  assert.doesNotMatch(stylesSource, /max-height:/);
});

test("falls back to textarea selection when the clipboard API fails", async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const appended = [];
  const textarea = {
    value: "",
    style: {},
    setAttribute(name, value) { this[name] = value; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    setSelectionRange(start, end) { this.range = [start, end]; },
    remove() { this.removed = true; },
  };

  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        body: { appendChild(node) { appended.push(node); } },
        createElement(tag) {
          assert.equal(tag, "textarea");
          return textarea;
        },
        execCommand(command) {
          assert.equal(command, "copy");
          return true;
        },
      },
    });

    assert.equal(await copyMessageText("hello"), true);
    assert.equal(appended[0], textarea);
    assert.equal(textarea.value, "hello");
    assert.equal(textarea.readonly, "");
    assert.equal(textarea.style.fontSize, "16px");
    assert.deepEqual(textarea.range, [0, 5]);
    assert.equal(textarea.removed, true);
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }
});

test("uses a toggleable mobile drawer for conversation history", () => {
  assert.match(chatSource, /isSidebarOpen\(\)/);
  assert.match(chatSource, /toggleSidebar/);
  assert.match(chatSource, /fixed\s+inset-y-0\s+left-0\s+z-40/);
  assert.match(chatSource, /-translate-x-full/);
  assert.match(chatSource, /translate-x-0/);
  assert.match(chatSource, /md:static\s+md:translate-x-0/);
  assert.match(chatSource, /md:hidden/);
  assert.match(chatSource, /sidebar-backdrop/);
});

test("allows the first message to create a conversation automatically", () => {
  assert.match(chatSource, /placeholder: "Ask iChat\.\.\."/);
  assert.match(chatSource, /const conversationId = await ensureConversationForSubmit\(\)/);
  assert.match(chatSource, /api\.conversations\.sendMessage\(t, conversationId, content\)/);
  assert.doesNotMatch(chatSource, /\.\.\.\(disabled \? \{ disabled: "true" \} : \{\}\)/);
  assert.doesNotMatch(chatSource, /if \(!content \|\| !selectedId\) return/);
});

test("keeps newly created draft conversations out of the sidebar list", () => {
  assert.match(chatSource, /draftConversationId:\s*conv\.id/);
  assert.doesNotMatch(chatSource, /conversations:\s*\[conv,\s*\.\.\.getState\(\)\.conversations\]/);
});

test("persists selected and draft conversation ids in localStorage", () => {
  assert.match(stateSource, /ichat\.selectedId/);
  assert.match(stateSource, /ichat\.draftConversationId/);
  assert.match(stateSource, /readStoredConversationIds/);
  assert.match(stateSource, /clearStoredConversationSelection/);
});

test("restores the selected draft conversation when chat view starts", () => {
  assert.match(chatSource, /readStoredConversationIds/);
  assert.match(chatSource, /void selectConversation\(persistedSelected\)/);
});

test("refreshes conversation list and clears draft marker after a successful run", () => {
  assert.match(chatSource, /if \(terminalKind === "succeeded"\)[\s\S]*await loadConversations\(\)/);
  assert.match(chatSource, /draftConversationId === conversationId/);
  assert.match(chatSource, /draftConversationId:\s*null/);
});

test("polls for the generated summary title after a successful first run", () => {
  assert.match(chatSource, /TITLE_REFRESH_ATTEMPTS/);
  assert.match(chatSource, /waitForGeneratedTitle\(conversationId\)/);
  assert.match(chatSource, /sleep\(TITLE_REFRESH_DELAY_MS\)/);
  assert.ok(chatSource.includes("detail.title?.trim()"));
});

test("shows a shimmering title placeholder while summary title is pending", () => {
  assert.match(stateSource, /pendingTitleConversationIds:\s*\[\]/);
  assert.match(chatSource, /setTitlePending\(conversationId\)[\s\S]*await loadConversations\(\)/);
  assert.match(chatSource, /pendingTitleConversationIds\.includes\(conv\.id\)/);
  assert.match(chatSource, /conversation-title-skeleton/);
  assert.match(stylesSource, /\.conversation-title-skeleton/);
  assert.match(stylesSource, /animation:\s*ichat-title-shimmer/);
});

test("clears persisted conversation selection on logout", () => {
  assert.match(authSource, /clearStoredConversationSelection/);
  assert.match(authSource, /save\(null\)/);
});

test("uses 16px text on mobile text inputs to prevent iOS focus zoom", () => {
  assert.match(chatSource, /resize-none[^"]*text-base\s+sm:text-sm/);
  assert.match(chatSource, /bg-transparent[^"]*text-base\s+sm:text-sm/);
  assert.match(loginSource, /rounded-md\s+text-base\s+sm:text-sm/);
});

test("loads markdown parsing and sanitizing libraries before the app module", () => {
  assert.match(indexSource, /marked/);
  assert.match(indexSource, /DOMPurify|purify/);
  assert.match(indexSource, /marked[\s\S]+purify[\s\S]+\/app\.js/);
});

test("renders assistant markdown through a sanitizer", () => {
  const previousMarked = globalThis.marked;
  const previousDOMPurify = globalThis.DOMPurify;
  try {
    globalThis.marked = {
      parse(markdown, options) {
        assert.equal(markdown, "**bold**");
        assert.equal(options.breaks, true);
        return "<p><strong>bold</strong></p><script>alert(1)</script>";
      },
    };
    globalThis.DOMPurify = {
      sanitize(html) {
        return html.replace(/<script>.*<\/script>/, "");
      },
    };

    assert.equal(renderAssistantMarkdown("**bold**"), "<p><strong>bold</strong></p>");
  } finally {
    globalThis.marked = previousMarked;
    globalThis.DOMPurify = previousDOMPurify;
  }
});

test("escapes assistant content when markdown libraries are unavailable", () => {
  const previousMarked = globalThis.marked;
  const previousDOMPurify = globalThis.DOMPurify;
  try {
    delete globalThis.marked;
    delete globalThis.DOMPurify;

    assert.equal(renderAssistantMarkdown("<b>x</b>\nnext"), "&lt;b&gt;x&lt;/b&gt;<br>next");
  } finally {
    globalThis.marked = previousMarked;
    globalThis.DOMPurify = previousDOMPurify;
  }
});

test("uses a light theme for markdown code blocks", () => {
  assert.match(stylesSource, /\.markdown-body pre\s*\{[\s\S]*background:\s*#f4f4f5/);
  assert.match(stylesSource, /\.markdown-body pre\s*\{[\s\S]*color:\s*#27272a/);
  assert.doesNotMatch(stylesSource, /\.markdown-body pre\s*\{[\s\S]*background:\s*#18181b/);
});

test("does not submit while the user is composing text with an IME", () => {
  assert.match(chatSource, /compositionstart/);
  assert.match(chatSource, /compositionend/);
  assert.match(chatSource, /event\.isComposing \|\| isComposing \|\| event\.keyCode === 229/);
  assert.match(
    chatSource,
    /if \(event\.isComposing \|\| isComposing \|\| event\.keyCode === 229\) return;[\s\S]*event\.preventDefault\(\)/,
  );
});

test("user messages expose an edit-and-regenerate affordance", () => {
  assert.match(chatSource, /buildEditButton\(message\)/);
  assert.match(chatSource, /message-edit-button/);
  assert.match(chatSource, /editAndRegenerate\(t, detail\.id, message\.id, next\)/);
});

test("assistant messages expose a regenerate affordance", () => {
  assert.match(chatSource, /buildRegenerateButton\(message\)/);
  assert.match(chatSource, /message-regenerate-button/);
  assert.match(chatSource, /api\.conversations\.regenerate\(t, detail\.id, message\.id\)/);
});

test("edit and regenerate actions are disabled while a run is active", () => {
  assert.match(chatSource, /buildEditButton[\s\S]{0,200}disabled\s*=\s*Boolean\(activeRun\)/);
  assert.match(chatSource, /buildRegenerateButton[\s\S]{0,200}disabled\s*=\s*Boolean\(activeRun\)/);
});

test("edit panel reuses the user bubble look", () => {
  assert.match(chatSource, /edit-bubble[\s\S]{0,400}bg-zinc-100[\s\S]{0,200}rounded-2xl/);
  assert.match(chatSource, /edit-bubble-textarea[\s\S]{0,200}bg-transparent/);
  assert.doesNotMatch(chatSource, /border-zinc-300\s+rounded-md\s+px-3\s+py-2[\s\S]{0,80}focus:border-zinc-500/);
});

test("edit confirm button reads as send", () => {
  assert.match(chatSource, /\["发送"\]/);
  assert.doesNotMatch(chatSource, /保存并重生/);
});

test("regenerate action uses an icon instead of label text", () => {
  assert.match(chatSource, /class="regenerate-icon"/);
  assert.doesNotMatch(chatSource, /\["重新生成"\]/);
});
