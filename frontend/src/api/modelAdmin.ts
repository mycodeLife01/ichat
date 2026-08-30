import { getDefaultApiClient, type ApiClient, type ApiRequestOptions } from "./client";

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
      route: ModelAdminRoute,
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
  };
}
