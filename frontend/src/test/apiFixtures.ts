import type {
  AuthTokenResponse,
  ConversationDetailResponse,
  ConversationResponse,
  RunEventResponse,
  RunResponse,
  RunStateResponse,
  SendMessageResponse,
  SuccessEnvelope,
} from "../api/types";

export const authTokenResponse: AuthTokenResponse = {
  user: {
    id: 1,
    username: "alice",
    email: "alice@example.com",
    email_verified: false,
  },
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
};

export const conversationResponse: ConversationResponse = {
  id: 10,
  title: "First chat",
  activated_at: "2026-05-24T10:00:00Z",
  created_at: "2026-05-24T09:59:00Z",
  updated_at: "2026-05-24T10:01:00Z",
};

export const assistantRun: RunResponse = {
  id: 100,
  conversation_id: conversationResponse.id,
  user_message_id: 501,
  status: "streaming",
  provider_name: "deepseek",
  provider_model: "deepseek-chat",
  created_at: "2026-05-24T10:02:00Z",
};

export const sendMessageResponse: SendMessageResponse = {
  message: {
    id: 501,
    conversation_id: conversationResponse.id,
    run_id: assistantRun.id,
    role: "user",
    content: "Hello",
    reasoning: null,
    position: 1,
    created_at: "2026-05-24T10:02:00Z",
  },
  run: assistantRun,
};

export const conversationDetailResponse: ConversationDetailResponse = {
  ...conversationResponse,
  messages: [sendMessageResponse.message],
};

export const textDeltaEvent: RunEventResponse = {
  seq: 1,
  type: "text_delta",
  payload: { text: "Hello" },
  created_at: "2026-05-24T10:02:01Z",
};

export const succeededEvent: RunEventResponse = {
  seq: 2,
  type: "run_succeeded",
  payload: {},
  created_at: "2026-05-24T10:02:02Z",
};

export const runStateResponse: RunStateResponse = {
  run_id: assistantRun.id,
  status: "streaming",
  latest_seq: 1,
  draft_text: "Hello",
  draft_reasoning: "",
  terminal_event: null,
};

export function envelope<T>(data: T): SuccessEnvelope<T> {
  return { data };
}
