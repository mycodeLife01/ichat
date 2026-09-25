import { getDefaultApiClient, type ApiClient, type ApiRequestOptions } from "./client";

export type ModelThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelTokenProfile = "default" | "deepseek" | "openai";
export type ModelProviderAdapter = "deepseek" | "openai" | "openrouter" | "glm";
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

export type ModelAdminApi = ReturnType<typeof createModelAdminApi>;

function managementOptions(
  accessKey: string,
  options: ApiRequestOptions = {},
): ApiRequestOptions {
  return {
    ...options,
    headers: {
      ...options.headers,
      "X-Model-Admin-Key": accessKey,
    },
    auth: false,
    retryOnUnauthorized: false,
  };
}

export function createModelAdminApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    getCatalog(accessKey: string): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        "/model-admin",
        managementOptions(accessKey),
      );
    },

    upsertModel(
      accessKey: string,
      modelKey: string,
      body: UpsertChatModelRequest,
    ): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/models/${encodeURIComponent(modelKey)}`,
        managementOptions(accessKey, { method: "PUT", body }),
      );
    },

    setModelEnabled(
      accessKey: string,
      modelKey: string,
      enabled: boolean,
    ): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/models/${encodeURIComponent(modelKey)}/enabled`,
        managementOptions(accessKey, { method: "PATCH", body: { enabled } }),
      );
    },

    upsertUpstream(
      accessKey: string,
      upstreamKey: string,
      body: UpsertModelUpstreamRequest,
    ): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/upstreams/${encodeURIComponent(upstreamKey)}`,
        managementOptions(accessKey, { method: "PUT", body }),
      );
    },

    setUpstreamEnabled(
      accessKey: string,
      upstreamKey: string,
      enabled: boolean,
    ): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/upstreams/${encodeURIComponent(upstreamKey)}/enabled`,
        managementOptions(accessKey, { method: "PATCH", body: { enabled } }),
      );
    },

    upsertRoute(
      accessKey: string,
      body: UpsertModelRouteRequest,
    ): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        "/model-admin/routes",
        managementOptions(accessKey, { method: "PUT", body }),
      );
    },

    setRouteEnabled(
      accessKey: string,
      route: ModelRouteIdentity,
      enabled: boolean,
    ): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        "/model-admin/routes/enabled",
        managementOptions(accessKey, {
          method: "PATCH",
          body: {
            model_key: route.model_key,
            upstream_key: route.upstream_key,
            upstream_model: route.upstream_model,
            enabled,
          },
        }),
      );
    },

    setCatalogEnabled(accessKey: string, enabled: boolean): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        "/model-admin/catalog",
        managementOptions(accessKey, {
          method: "PATCH",
          body: { database_enabled: enabled },
        }),
      );
    },

    importEnvironment(accessKey: string, activate = false): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        "/model-admin/import-env",
        managementOptions(accessKey, {
          method: "POST",
          body: { activate },
        }),
      );
    },

    archiveModel(accessKey: string, modelKey: string): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/models/${encodeURIComponent(modelKey)}/archived`,
        managementOptions(accessKey, { method: "PATCH", body: { archived: true } }),
      );
    },

    archiveUpstream(accessKey: string, upstreamKey: string): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/upstreams/${encodeURIComponent(upstreamKey)}/archived`,
        managementOptions(accessKey, { method: "PATCH", body: { archived: true } }),
      );
    },

    archiveRoute(accessKey: string, route: ModelRouteIdentity): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        "/model-admin/routes/archived",
        managementOptions(accessKey, {
          method: "PATCH",
          body: {
            model_key: route.model_key,
            upstream_key: route.upstream_key,
            upstream_model: route.upstream_model,
            archived: true,
          },
        }),
      );
    },

    // Archived rows can share a key with an active row, so restore uses the ref.
    restoreArchived(accessKey: string, ref: string): Promise<ModelAdminCatalog> {
      return resolveClient().request<ModelAdminCatalog>(
        `/model-admin/archive/${encodeURIComponent(ref)}/restore`,
        managementOptions(accessKey, { method: "POST" }),
      );
    },
  };
}
