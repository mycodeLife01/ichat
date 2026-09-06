export type ModelThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelTokenProfile = "default" | "deepseek" | "openai";
export type ModelProviderAdapter = "deepseek" | "openai" | "openrouter";
export type ModelReasoningOutput = "raw" | "summary";

export type ModelAdminChatModel = {
  key: string;
  label: string;
  thinking_levels: ModelThinkingLevel[];
  supports_image_input: boolean;
  image_token_reserve: number | null;
  token_profile: ModelTokenProfile;
  sort_order: number;
  enabled: boolean;
};

export type ModelAdminUpstream = {
  key: string;
  label: string;
  adapter: ModelProviderAdapter;
  base_url: string;
  api_key_hint: string;
  enabled: boolean;
};

export type ModelAdminRoute = {
  model_key: string;
  upstream_key: string;
  upstream_model: string;
  reasoning_outputs: ModelReasoningOutput[];
  priority: number;
  enabled: boolean;
  selected: boolean;
};

export type ModelAdminCatalog = {
  database_enabled: boolean;
  models: ModelAdminChatModel[];
  upstreams: ModelAdminUpstream[];
  routes: ModelAdminRoute[];
};

export type UpsertChatModelRequest = Omit<ModelAdminChatModel, "key">;
export type UpsertModelUpstreamRequest = Omit<
  ModelAdminUpstream,
  "key" | "api_key_hint"
> & {
  api_key?: string;
};
export type UpsertModelRouteRequest = Omit<ModelAdminRoute, "selected">;
