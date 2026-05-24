export type SuccessEnvelope<T> = {
  data: T;
  meta?: Record<string, unknown> | null;
};

export type AuthUserResponse = {
  id: number;
  username: string;
  email: string;
  email_verified: boolean;
};

export type AuthTokenResponse = {
  user: AuthUserResponse;
  access_token: string;
  refresh_token: string;
  token_type: "bearer" | string;
  expires_in: number;
};

export type CommandStatusResponse = {
  status: string;
};

export type ConversationResponse = {
  id: number;
  title: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRole = "user" | "assistant";

export type MessageResponse = {
  id: number;
  conversation_id: number;
  run_id: number | null;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  position: number;
  created_at: string;
};

export type RunStatus =
  | "queued"
  | "started"
  | "streaming"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export type RunResponse = {
  id: number;
  conversation_id: number;
  user_message_id: number;
  status: RunStatus;
  provider_name: string;
  provider_model: string;
  created_at: string;
};

export type ConversationDetailResponse = ConversationResponse & {
  messages: MessageResponse[];
};

export type SendMessageResponse = {
  message: MessageResponse;
  run: RunResponse;
};

export type RunEventType =
  | "run_started"
  | "text_delta"
  | "reasoning_delta"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled";

export type RunEventResponse = {
  seq: number;
  type: RunEventType;
  payload: Record<string, unknown>;
  created_at: string;
};

export type RunStateResponse = {
  run_id: number;
  status: RunStatus;
  latest_seq: number;
  draft_text: string;
  draft_reasoning: string;
  terminal_event: RunEventResponse | null;
};
