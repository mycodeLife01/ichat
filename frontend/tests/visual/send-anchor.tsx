import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import type {
  AuthTokenResponse,
  ConversationResponse,
  MessageResponse,
  RunEventResponse,
  RunStreamEvent,
} from "../../src/api/types";
import { AppProvider } from "../../src/app/AppProvider";
import { AppShell } from "../../src/app/AppShell";
import { createAuthSession, tokenStore } from "../../src/auth/tokenStore";
import { authTokenResponse } from "../../src/test/apiFixtures";
import { createFakeServices } from "../../src/test/appHarness";
import "../../src/styles/global.css";

// Geometry fixture for send-anchored scrolling. `?turns=N` seeds N history
// turns of `?paragraphs=M` answer paragraphs; the page exposes a stream controller so the test can advance the
// reply delta by delta and finish it.
const params = new URLSearchParams(location.search);
const turns = Number(params.get("turns") ?? "6");
const paragraphs = Number(params.get("paragraphs") ?? "3");

const conversation: ConversationResponse = {
  id: "visual-send-anchor",
  title: "发送置顶",
  activated_at: "2026-09-26T00:00:00Z",
  created_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
};

const message = (
  id: string,
  role: "user" | "assistant",
  content: string,
  position: number,
): MessageResponse => ({
  id,
  conversation_id: conversation.id,
  run_id: `run-${Math.ceil(position / 2)}`,
  role,
  content,
  reasoning: null,
  metadata: null,
  position,
  created_at: "2026-09-26T00:00:01Z",
});

const messages: MessageResponse[] = [];
for (let turn = 0; turn < turns; turn += 1) {
  messages.push(message(`u${turn}`, "user", `历史问题 ${turn + 1}`, turn * 2 + 1));
  messages.push(
    message(
      `a${turn}`,
      "assistant",
      Array.from({ length: paragraphs }, (_, index) => `历史回答 ${turn + 1} 的第 ${index + 1} 段，用于填满对话区域。`).join("\n\n"),
      turn * 2 + 2,
    ),
  );
}

type Pending = { resolve: (event: RunEventResponse | null) => void };
const queue: RunEventResponse[] = [];
let waiting: Pending | null = null;
let seq = 0;
let streamed = "";
const push = (event: RunEventResponse) => {
  if (waiting) {
    const current = waiting;
    waiting = null;
    current.resolve(event);
  } else {
    queue.push(event);
  }
};

declare global {
  interface Window {
    sendAnchor: { delta: (text: string) => void; finish: () => void };
  }
}

window.sendAnchor = {
  delta: (text) => {
    streamed += text;
    seq += 1;
    push({ seq, type: "text_delta", payload: { text }, created_at: "t" });
  },
  finish: () => {
    messages.push(message(`a-live-${seq}`, "assistant", streamed, messages.length + 1));
    streamed = "";
    seq += 1;
    push({ seq, type: "run_succeeded", payload: {}, created_at: "t" });
  },
};

async function* stream(): AsyncGenerator<RunStreamEvent> {
  for (;;) {
    const event =
      queue.shift() ??
      (await new Promise<RunEventResponse | null>((resolve) => {
        waiting = { resolve };
      }));
    if (!event) return;
    yield { seq: event.seq, type: event.type, data: event };
    if (event.type === "run_succeeded") return;
  }
}

const authResponse: AuthTokenResponse = {
  ...authTokenResponse,
  user: { ...authTokenResponse.user, nickname: "视觉验收", email_verified: true },
};

const services = createFakeServices(
  { me: async () => authResponse.user },
  {
    list: async () => [conversation],
    detail: async () => ({ ...conversation, messages: [...messages] }),
    sendMessage: async (_conversationId, content) => {
      // Keep the optimistic turn visible long enough to measure it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const sent = message(`u-live-${messages.length}`, "user", content, messages.length + 1);
      sent.run_id = `live-run-${messages.length}`;
      messages.push(sent);
      return {
        message: sent,
        run: {
          id: sent.run_id,
          conversation_id: conversation.id,
          user_message_id: sent.id,
          status: "queued",
          provider_name: "deepseek",
          provider_model: "deepseek-chat",
          created_at: sent.created_at,
        },
      };
    },
  },
  { streamEvents: () => stream() },
);

tokenStore.save(createAuthSession(authResponse));

const root = document.getElementById("root");
if (!root) throw new Error("Send anchor fixture root is missing");

createRoot(root).render(
  <MemoryRouter initialEntries={[`/c/${conversation.id}`]}>
    <AppProvider services={services}>
      <AppShell />
    </AppProvider>
  </MemoryRouter>,
);
