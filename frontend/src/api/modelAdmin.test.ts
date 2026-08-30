import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./client";
import { createModelAdminApi, type ModelAdminCatalog } from "./modelAdmin";

const catalog: ModelAdminCatalog = {
  database_enabled: false,
  models: [],
  upstreams: [],
  routes: [],
};

function mockClient() {
  return {
    request: vi.fn().mockResolvedValue(catalog),
  } as unknown as Pick<ApiClient, "request">;
}

describe("modelAdminApi", () => {
  it("uses the dedicated key header without user auth or refresh", async () => {
    const client = mockClient();
    const api = createModelAdminApi(client);

    await api.getCatalog("fixed-secret");

    expect(client.request).toHaveBeenCalledWith("/model-admin", {
      headers: { "X-Model-Admin-Key": "fixed-secret" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("updates model records with an encoded stable key", async () => {
    const client = mockClient();
    const api = createModelAdminApi(client);
    const body = {
      label: "DeepSeek V4",
      thinking_levels: ["high", "max"] as const,
      supports_image_input: false,
      image_token_reserve: null,
      token_profile: "deepseek" as const,
      sort_order: 0,
      enabled: true,
    };

    await api.upsertModel("fixed-secret", "deepseek/v4", {
      ...body,
      thinking_levels: [...body.thinking_levels],
    });

    expect(client.request).toHaveBeenCalledWith("/model-admin/models/deepseek%2Fv4", {
      method: "PUT",
      body: { ...body, thinking_levels: ["high", "max"] },
      headers: { "X-Model-Admin-Key": "fixed-secret" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });

  it("identifies a route by model, upstream, and provider model when toggling", async () => {
    const client = mockClient();
    const api = createModelAdminApi(client);

    await api.setRouteEnabled(
      "fixed-secret",
      {
        model_key: "deepseek-v4",
        upstream_key: "openrouter",
        upstream_model: "deepseek/deepseek-v4",
        reasoning_outputs: ["raw"],
        priority: 10,
        enabled: true,
        selected: true,
      },
      false,
    );

    expect(client.request).toHaveBeenCalledWith("/model-admin/routes/enabled", {
      method: "PATCH",
      body: {
        model_key: "deepseek-v4",
        upstream_key: "openrouter",
        upstream_model: "deepseek/deepseek-v4",
        enabled: false,
      },
      headers: { "X-Model-Admin-Key": "fixed-secret" },
      auth: false,
      retryOnUnauthorized: false,
    });
  });
});
