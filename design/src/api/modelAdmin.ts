export type ModelThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelTokenProfile = "default" | "deepseek" | "openai";
export type ModelProviderAdapter = "deepseek" | "openai" | "openrouter";
export type ModelReasoningOutput = "raw" | "summary";

export type ModelAdminChatModel = {
  ref: string;
  key: string;
  label: string;
  thinking_levels: ModelThinkingLevel[];
  supports_image_input: boolean;
  image_token_reserve: number | null;
  token_profile: ModelTokenProfile;
  sort_order: number;
  enabled: boolean;
  archived: boolean;
  archived_at: string | null;
};

export type ModelAdminUpstream = {
  ref: string;
  key: string;
  label: string;
  adapter: ModelProviderAdapter;
  base_url: string;
  api_key_hint: string;
  enabled: boolean;
  archived: boolean;
  archived_at: string | null;
};

export type ModelAdminRoute = {
  ref: string;
  // Parent refs place archived routes under the right, possibly same-key, parent.
  model_ref: string;
  upstream_ref: string;
  model_key: string;
  upstream_key: string;
  upstream_model: string;
  reasoning_outputs: ModelReasoningOutput[];
  priority: number;
  enabled: boolean;
  archived: boolean;
  archived_at: string | null;
  selected: boolean;
};

export type ModelAdminCatalog = {
  database_enabled: boolean;
  models: ModelAdminChatModel[];
  upstreams: ModelAdminUpstream[];
  routes: ModelAdminRoute[];
};

type ServerOwned = "ref" | "archived" | "archived_at";

export type UpsertChatModelRequest = Omit<ModelAdminChatModel, "key" | ServerOwned>;
export type UpsertModelUpstreamRequest = Omit<
  ModelAdminUpstream,
  "key" | "api_key_hint" | ServerOwned
> & {
  api_key?: string;
};
export type UpsertModelRouteRequest = Omit<
  ModelAdminRoute,
  "selected" | "model_ref" | "upstream_ref" | ServerOwned
>;
export type ModelRouteIdentity = Pick<
  ModelAdminRoute,
  "model_key" | "upstream_key" | "upstream_model"
>;
