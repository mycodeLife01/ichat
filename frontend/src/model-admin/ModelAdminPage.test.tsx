import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import type { ModelAdminCatalog } from "../api/modelAdmin";
import { App } from "../app/App";
import { createFakeServices, renderWithApp } from "../test/appHarness";
import { modelAdminAccessKeyStore } from "./accessKeyStore";

const catalog: ModelAdminCatalog = {
  database_enabled: true,
  models: [
    {
      key: "deepseek-v4",
      label: "DeepSeek V4",
      thinking_levels: ["low", "high", "max"],
      supports_image_input: false,
      image_token_reserve: null,
      token_profile: "deepseek",
      sort_order: 0,
      enabled: true,
    },
  ],
  upstreams: [
    {
      key: "openrouter",
      label: "OpenRouter",
      adapter: "openrouter",
      base_url: "https://openrouter.example/api/v1",
      api_key_hint: "…cret",
      enabled: true,
    },
  ],
  routes: [
    {
      model_key: "deepseek-v4",
      upstream_key: "openrouter",
      upstream_model: "deepseek/deepseek-v4",
      reasoning_outputs: ["raw", "summary"],
      priority: 10,
      enabled: true,
      selected: true,
    },
  ],
};

function servicesWithModelAdmin(overrides: Parameters<typeof createFakeServices>[6]) {
  return createFakeServices({}, {}, {}, {}, {}, {}, overrides);
}

describe("ModelAdminPage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("opens outside ordinary user auth and unlocks with the fixed key", async () => {
    const user = userEvent.setup();
    const getCatalog = vi.fn(async () => catalog);
    renderWithApp(
      <App />,
      servicesWithModelAdmin({ getCatalog }),
      undefined,
      ["/model-admin"],
    );

    expect(screen.queryByRole("tab", { name: "登录" })).toBeNull();
    await user.type(screen.getByLabelText("固定访问密钥"), "fixed-secret");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));

    expect(await screen.findByText("DeepSeek V4")).toBeInTheDocument();
    expect(screen.getByText("当前路由")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "从 ENV 导入模型配置" }),
    ).toBeInTheDocument();
    expect(getCatalog).toHaveBeenCalledWith("fixed-secret");
    expect(modelAdminAccessKeyStore.read()).toBe("fixed-secret");
  });

  it("locks the console and clears its tab-scoped key", async () => {
    const user = userEvent.setup();
    modelAdminAccessKeyStore.save("fixed-secret");
    renderWithApp(
      <App />,
      servicesWithModelAdmin({ getCatalog: async () => catalog }),
      undefined,
      ["/model-admin"],
    );

    await screen.findByText("DeepSeek V4");
    await user.click(screen.getByRole("button", { name: "锁定模型管理控制台" }));

    expect(screen.getByLabelText("固定访问密钥")).toHaveValue("");
    expect(modelAdminAccessKeyStore.read()).toBeNull();
  });

  it("updates a model status immediately from its switch", async () => {
    const user = userEvent.setup();
    const setModelEnabled = vi.fn(async () => ({
      ...catalog,
      models: [{ ...catalog.models[0], enabled: false }],
      routes: [{ ...catalog.routes[0], selected: false }],
    }));
    renderWithApp(
      <App />,
      servicesWithModelAdmin({
        getCatalog: async () => catalog,
        setModelEnabled,
      }),
      undefined,
      ["/model-admin"],
    );

    await user.type(screen.getByLabelText("固定访问密钥"), "fixed-secret");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));
    await user.click(await screen.findByRole("switch", { name: "下线：DeepSeek V4" }));

    expect(setModelEnabled).toHaveBeenCalledWith("fixed-secret", "deepseek-v4", false);
    expect(await screen.findByRole("switch", { name: "上线：DeepSeek V4" })).toBeInTheDocument();
    expect(screen.getByText("模型已下线。")).toBeInTheDocument();
  });

  it("creates a model through the editor without exposing ENV", async () => {
    const user = userEvent.setup();
    const upsertModel = vi.fn(async () => catalog);
    renderWithApp(
      <App />,
      servicesWithModelAdmin({ getCatalog: async () => catalog, upsertModel }),
      undefined,
      ["/model-admin"],
    );
    await user.type(screen.getByLabelText("固定访问密钥"), "fixed-secret");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));
    await user.click(await screen.findByRole("button", { name: "添加模型" }));

    const dialog = screen.getByRole("dialog", { name: "添加聊天模型" });
    await user.type(within(dialog).getByLabelText("模型标识"), "gpt-5-mini");
    await user.type(within(dialog).getByLabelText("显示名称"), "GPT-5 Mini");
    await user.selectOptions(within(dialog).getByLabelText("Token 计数配置"), "openai");
    await user.click(within(dialog).getByLabelText("high"));
    await user.click(within(dialog).getByLabelText("保存后上线"));
    await user.click(within(dialog).getByRole("button", { name: "保存配置" }));

    expect(upsertModel).toHaveBeenCalledWith("fixed-secret", "gpt-5-mini", {
      label: "GPT-5 Mini",
      thinking_levels: ["high"],
      supports_image_input: false,
      image_token_reserve: null,
      token_profile: "openai",
      sort_order: 100,
      enabled: true,
    });
  });

  it("saves route-level reasoning outputs from the editor", async () => {
    const user = userEvent.setup();
    const upsertRoute = vi.fn(async () => catalog);
    renderWithApp(
      <App />,
      servicesWithModelAdmin({ getCatalog: async () => catalog, upsertRoute }),
      undefined,
      ["/model-admin"],
    );
    await user.type(screen.getByLabelText("固定访问密钥"), "fixed-secret");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));
    await user.click(await screen.findByRole("button", { name: "添加路由" }));

    const dialog = screen.getByRole("dialog", { name: "添加模型路由" });
    await user.type(
      within(dialog).getByLabelText("上游 Model ID"),
      "deepseek/deepseek-reasoner",
    );
    expect(within(dialog).getByLabelText("raw")).toBeChecked();
    await user.click(within(dialog).getByLabelText("summary"));
    await user.click(within(dialog).getByLabelText("保存后上线"));
    await user.click(within(dialog).getByRole("button", { name: "保存配置" }));

    expect(upsertRoute).toHaveBeenCalledWith("fixed-secret", {
      model_key: "deepseek-v4",
      upstream_key: "openrouter",
      upstream_model: "deepseek/deepseek-reasoner",
      reasoning_outputs: ["raw", "summary"],
      priority: 100,
      enabled: true,
    });
  });

  it("rejects an invalid fixed key without starting user-token recovery", async () => {
    const user = userEvent.setup();
    const getCatalog = vi.fn(async () => {
      throw new ApiError({
        status: 401,
        detail: "Invalid model management access key",
      });
    });
    renderWithApp(
      <App />,
      servicesWithModelAdmin({ getCatalog }),
      undefined,
      ["/model-admin"],
    );

    await user.type(screen.getByLabelText("固定访问密钥"), "wrong-secret");
    await user.click(screen.getByRole("button", { name: "进入控制台" }));

    expect(await screen.findByText("Invalid model management access key")).toBeInTheDocument();
    expect(modelAdminAccessKeyStore.read()).toBeNull();
    expect(screen.queryByText("登录状态已失效，请重新登录")).toBeNull();
  });
});
