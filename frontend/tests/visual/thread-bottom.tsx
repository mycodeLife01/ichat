import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import type {
  AuthTokenResponse,
  ConversationDetailResponse,
  ConversationResponse,
  MessageResponse,
} from "../../src/api/types";
import { AppProvider } from "../../src/app/AppProvider";
import { AppShell } from "../../src/app/AppShell";
import { createAuthSession, tokenStore } from "../../src/auth/tokenStore";
import { authTokenResponse } from "../../src/test/apiFixtures";
import { createFakeServices } from "../../src/test/appHarness";
import "../../src/styles/global.css";

const conversation: ConversationResponse = {
  id: "visual-thread-bottom",
  title: "底部滚动与模糊",
  activated_at: "2026-08-16T00:00:00Z",
  created_at: "2026-08-16T00:00:00Z",
  updated_at: "2026-08-16T00:00:00Z",
};

const replyQuoteFixtureText = Array.from(
  { length: 10 },
  (_, index) =>
    `这段较长的回复引用用于验证第 ${index + 1} 部分的正文宽度、三行限制、颜色和分享展示一致性。`,
).join("");

const longAnswer = `${Array.from(
  { length: 72 },
  (_, index) =>
    `### 段落 ${index + 1}\n\n正文继续向页面底部延伸，用于验证 Composer 后方的渐变模糊与滚动按钮。`,
).join("\n\n")}\n\n### 引用测试\n\n${replyQuoteFixtureText}`;

const messages: MessageResponse[] = [
  {
    id: "visual-user-message",
    conversation_id: conversation.id,
    run_id: "visual-run",
    role: "user",
    content: "请生成足够长的回复以验证滚动行为。",
    reasoning: null,
    metadata: null,
    position: 1,
    created_at: "2026-08-16T00:00:01Z",
  },
  {
    id: "visual-assistant-message",
    conversation_id: conversation.id,
    run_id: "visual-run",
    role: "assistant",
    content: longAnswer,
    reasoning: null,
    metadata: null,
    position: 2,
    created_at: "2026-08-16T00:00:02Z",
  },
];

const detail: ConversationDetailResponse = {
  ...conversation,
  messages,
};

const authResponse: AuthTokenResponse = {
  ...authTokenResponse,
  user: {
    ...authTokenResponse.user,
    nickname: "视觉验收",
    email_verified: true,
  },
};

const services = createFakeServices(
  { me: async () => authResponse.user },
  {
    list: async () => [conversation],
    detail: async () => detail,
    sendMessage: async (_conversationId, content, _options, _attachmentIds, replyQuote) => {
      const message: MessageResponse = {
        id: `visual-user-reply-${messages.length}`,
        conversation_id: conversation.id,
        run_id: "visual-reply-run",
        role: "user",
        content,
        reasoning: null,
        metadata: null,
        reply_quote: replyQuote ?? null,
        position: messages.length + 1,
        created_at: "2026-08-31T00:00:03Z",
      };
      return {
        message,
        run: {
          id: "visual-reply-run",
          conversation_id: conversation.id,
          user_message_id: message.id,
          status: "queued",
          provider_name: "deepseek",
          provider_model: "deepseek-chat",
          created_at: message.created_at,
        },
      };
    },
  },
);

tokenStore.save(createAuthSession(authResponse));

const root = document.getElementById("root");
if (!root) throw new Error("Thread bottom fixture root is missing");

createRoot(root).render(
  <MemoryRouter initialEntries={[`/c/${conversation.id}`]}>
    <AppProvider services={services}>
      <AppShell />
    </AppProvider>
  </MemoryRouter>,
);
