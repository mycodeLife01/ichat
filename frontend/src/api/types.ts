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
  id: string;
  title: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRole = "user" | "assistant";

export type MessageSource = {
  id: number;
  title: string;
  url: string;
  snippet?: string | null;
  published_at?: string | null;
  provider?: string | null;
};

export type MessageMetadata = {
  sources?: MessageSource[];
};

export type MessageResponse = {
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  metadata?: MessageMetadata | null;
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
  id: string;
  conversation_id: string;
  user_message_id: string;
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
  | "tool_call_started"
  | "tool_call_succeeded"
  | "tool_call_failed"
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
  run_id: string;
  status: RunStatus;
  latest_seq: number;
  draft_text: string;
  draft_reasoning: string;
  tool_state?: RunToolState | null;
  terminal_event: RunEventResponse | null;
};

export type RunStreamEvent = {
  seq: number;
  type: RunEventType;
  data: RunEventResponse;
};

export type RunToolSource = {
  id: number;
  title: string;
  url: string;
};

export type RunToolState = {
  status: "running" | "succeeded" | "failed";
  tool_name: string;
  query: string | null;
  message: string | null;
  result_count: number | null;
  sources: RunToolSource[];
};

export type CapabilitiesResponse = {
  web_search: {
    enabled: boolean;
  };
};
