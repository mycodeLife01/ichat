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

const longAnswer = Array.from(
  { length: 72 },
  (_, index) =>
    `### 段落 ${index + 1}\n\n正文继续向页面底部延伸，用于验证 Composer 后方的渐变模糊与滚动按钮。`,
).join("\n\n");

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
