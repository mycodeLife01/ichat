import type {
  AuthUserResponse,
  ConversationDetailResponse,
  MessageResponse,
  MessageSource,
  ChatModelCapability,
} from "../api/types";
import type {
  ModelAdminCatalog,
  ModelAdminChatModel,
  ModelAdminRoute,
  ModelAdminUpstream,
} from "../api/modelAdmin";
import type { FileAttachment, FilesCapability } from "../files/types";
export const fixedDate = "2026-09-06T02:00:00Z";
export const user: AuthUserResponse = {
  id: 1,
  username: "designer",
  nickname: "设计体验",
  email: "designer@example.test",
  email_verified: true,
  avatar_url: null,
};
export const sources: MessageSource[] = [
  {
    id: 1,
    title: "设计系统与界面一致性",
    url: "https://example.test/design",
    snippet: "用完整页面、共享组件与明确交互状态建立长期设计参照。",
    provider: "示例来源",
  },
];
export const answer = `## 从一个清晰的界面开始\n\n设计的价值，是让我们在实现之前**看见同一个结果**。这一段示例同时用于设计画布和原版对照。\n\n### 三个工作步骤\n\n1. 在完整页面里讨论布局。\n2. 点击体验关键交互，检查桌面与移动端。\n3. 固定确认版本，再开发真实功能。\n\n> 先把设计表达清楚，再让实现有据可依。\n\n| 阶段 | 产物 |\n| --- | --- |\n| 设计 | 页面与交互 |\n| 实现 | 可运行的产品 |\n\n\`\`\`typescript\nconst design = { status: "ready", version: 1 };\nconsole.log(design);\n\`\`\`\n\n行内公式 $E=mc^2$，以及 [设计说明](https://example.test/design)。\n\n- [x] 完整页面\n- [ ] 下一项设计需求\n`;
export const imageAttachment: FileAttachment = {
  id: "image",
  name: "landscape.svg",
  media_type: "image/svg+xml",
  size_bytes: 1240,
  category: "image",
  model_input_kind: "image",
  preview_available: true,
};
export const fileAttachment: FileAttachment = {
  id: "document",
  name: "设计说明.txt",
  media_type: "text/plain",
  size_bytes: 2048,
  category: "text",
  model_input_kind: "document",
  preview_available: false,
};
export function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  position: number,
): MessageResponse {
  return {
    id,
    conversation_id: "design-chat",
    run_id: null,
    role,
    content,
    position,
    reasoning: null,
    created_at: fixedDate,
  };
}
export function conversations(long = false): ConversationDetailResponse[] {
  return Array.from({ length: 36 }, (_, index) => ({
    id: index ? `design-${index}` : "design-chat",
    title: index
      ? ["周末旅行计划", "数据库连接与索引", "写作与阅读笔记"][index % 3] +
        ` · ${index}`
      : "从设计到实现",
    created_at: fixedDate,
    updated_at: fixedDate,
    activated_at: fixedDate,
    messages: [
      message(
        index ? `u-${index}` : "user-1",
        "user",
        "我们如何建立一个可以持续迭代的 UI 设计工程？",
        1,
      ),
      {
        ...message(
          index ? `a-${index}` : "10000000-0000-4000-8000-000000000001",
          "assistant",
          long && !index
            ? Array.from(
                { length: 12 },
                (_, i) => `## 第 ${i + 1} 节\n\n${answer}`,
              ).join("\n\n")
            : answer,
          2,
        ),
        metadata: { sources },
      },
    ],
  }));
}
export const models: ChatModelCapability[] = [
  {
    id: "deepseek",
    provider: "deepseek",
    label: "DeepSeek",
    thinking_levels: ["low", "high", "max"],
    supports_image_input: false,
    default: true,
  },
  {
    id: "vision",
    provider: "openai",
    label: "视觉模型",
    thinking_levels: ["low", "medium", "high"],
    supports_image_input: true,
    default: false,
  },
];
export const fileCapability: FilesCapability = {
  enabled: true,
  allowed_extensions: [
    "png",
    "jpg",
    "jpeg",
    "webp",
    "txt",
    "pdf",
    "md",
    "csv",
    "docx",
  ],
  category_max_bytes: {
    image: 10 * 1024 * 1024,
    text: 5 * 1024 * 1024,
    pdf: 25 * 1024 * 1024,
  },
  max_attachments_per_message: 10,
  max_message_bytes: 50 * 1024 * 1024,
  quota_bytes: 1024 * 1024 * 1024,
  target_turn_tokens: 32000,
  context_budget_tokens: 64000,
};
export const catalog: ModelAdminCatalog = {
  database_enabled: true,
  models: [
    {
      ref: "model-1",
      key: "deepseek",
      label: "DeepSeek",
      thinking_levels: ["low", "high", "max"],
      supports_image_input: false,
      image_token_reserve: null,
      token_profile: "deepseek",
      sort_order: 0,
      enabled: true,
      archived: false,
      archived_at: null,
    },
    {
      ref: "model-2",
      key: "vision",
      label: "视觉模型",
      thinking_levels: ["low", "medium", "high"],
      supports_image_input: true,
      image_token_reserve: 4096,
      token_profile: "openai",
      sort_order: 1,
      enabled: true,
      archived: false,
      archived_at: null,
    },
  ],
  upstreams: [
    {
      ref: "upstream-1",
      key: "official",
      label: "官方入口",
      adapter: "deepseek",
      base_url: "https://api.example.test/v1",
      api_key_hint: "demo…only",
      enabled: true,
      archived: false,
      archived_at: null,
    },
    {
      ref: "upstream-2",
      key: "gateway",
      label: "备用入口",
      adapter: "openrouter",
      base_url: "https://gateway.example.test/v1",
      api_key_hint: "demo…only",
      enabled: true,
      archived: false,
      archived_at: null,
    },
  ],
  routes: [
    {
      ref: "route-1",
      model_ref: "model-1",
      upstream_ref: "upstream-1",
      model_key: "deepseek",
      upstream_key: "official",
      upstream_model: "deepseek-chat",
      reasoning_outputs: ["raw"],
      priority: 10,
      enabled: true,
      archived: false,
      archived_at: null,
      selected: true,
    },
    {
      ref: "route-2",
      model_ref: "model-1",
      upstream_ref: "upstream-2",
      model_key: "deepseek",
      upstream_key: "gateway",
      upstream_model: "deepseek/chat",
      reasoning_outputs: ["summary"],
      priority: 20,
      enabled: true,
      archived: false,
      archived_at: null,
      selected: false,
    },
  ],
};

// Dense management sample: enough rows to stress long-page layouts, including
// archived items and one key that exists both archived and active.
const archivedAt = {
  separate: "2026-09-01T08:00:00Z",
  claudeLite: "2026-09-02T08:00:00Z",
  gpt5: "2026-09-03T08:00:00Z",
};
const denseModel = (
  id: number,
  key: string,
  label: string,
  extra: Partial<ModelAdminChatModel> = {},
): ModelAdminChatModel => ({
  ref: `model-${id}`,
  key,
  label,
  thinking_levels: ["low", "high", "max"],
  supports_image_input: false,
  image_token_reserve: null,
  token_profile: "default",
  sort_order: id * 10,
  enabled: true,
  archived: false,
  ...extra,
  archived_at: extra.archived ? (extra.archived_at ?? archivedAt.separate) : null,
});
const denseUpstream = (
  id: number,
  key: string,
  label: string,
  adapter: ModelAdminUpstream["adapter"],
  extra: Partial<ModelAdminUpstream> = {},
): ModelAdminUpstream => ({
  ref: `upstream-${id}`,
  key,
  label,
  adapter,
  base_url: `https://${key}.example.test/v1`,
  api_key_hint: "demo…only",
  enabled: true,
  archived: false,
  ...extra,
  archived_at: extra.archived ? archivedAt.separate : null,
});
const denseModels = [
  denseModel(1, "deepseek-v4", "DeepSeek V4", { token_profile: "deepseek" }),
  denseModel(2, "deepseek-v4-flash", "DeepSeek V4 Flash", { token_profile: "deepseek" }),
  denseModel(3, "gpt-5", "GPT-5", {
    thinking_levels: ["low", "medium", "high", "xhigh"],
    supports_image_input: true,
    image_token_reserve: 4096,
    token_profile: "openai",
  }),
  denseModel(4, "gpt-5-mini", "GPT-5 mini", { token_profile: "openai" }),
  denseModel(5, "gemini-3-pro", "Gemini 3 Pro", {
    supports_image_input: true,
    image_token_reserve: 2048,
  }),
  denseModel(6, "gemini-3-flash", "Gemini 3 Flash"),
  denseModel(7, "grok-5", "Grok 5", { enabled: false }),
  denseModel(8, "qwen-4-max", "Qwen 4 Max"),
  denseModel(9, "kimi-k3", "Kimi K3", { enabled: false }),
  denseModel(10, "glm-5", "GLM 5"),
  denseModel(11, "claude-lite", "Claude Lite（旧）", {
    archived: true,
    archived_at: archivedAt.claudeLite,
    enabled: false,
  }),
  // Same key as the active GPT-5 row: the archived copy must stay distinct.
  denseModel(12, "gpt-5", "GPT-5（旧配置）", {
    archived: true,
    archived_at: archivedAt.gpt5,
    token_profile: "openai",
  }),
];
const denseUpstreams = [
  denseUpstream(1, "deepseek-official", "DeepSeek 官方", "deepseek"),
  denseUpstream(2, "openrouter", "OpenRouter", "openrouter"),
  denseUpstream(3, "openai-official", "OpenAI 官方", "openai"),
  denseUpstream(4, "azure-east", "Azure East", "openai", { enabled: false }),
  denseUpstream(5, "gateway-cn", "国内网关", "openrouter"),
  denseUpstream(6, "legacy-proxy", "旧代理", "openai", { archived: true, enabled: false }),
];
const activeUpstreamRef = (key: string) =>
  denseUpstreams.find((u) => u.key === key && !u.archived)!.ref;
let denseRouteId = 0;
const denseRoute = (
  modelId: number,
  upstreamKey: string,
  upstreamModel: string,
  priority: number,
  extra: Partial<ModelAdminRoute> = {},
): ModelAdminRoute => {
  const model = denseModels[modelId - 1];
  denseRouteId += 1;
  return {
    ref: `route-${denseRouteId}`,
    model_ref: model.ref,
    upstream_ref: activeUpstreamRef(upstreamKey),
    model_key: model.key,
    upstream_key: upstreamKey,
    upstream_model: upstreamModel,
    reasoning_outputs: [],
    priority,
    enabled: true,
    archived: false,
    selected: false,
    ...extra,
    archived_at: extra.archived ? (extra.archived_at ?? archivedAt.separate) : null,
  };
};
export const denseCatalog: ModelAdminCatalog = {
  database_enabled: true,
  models: denseModels,
  upstreams: denseUpstreams,
  routes: [
    denseRoute(1, "deepseek-official", "deepseek-chat", 10, {
      reasoning_outputs: ["raw"],
      selected: true,
    }),
    denseRoute(1, "openrouter", "deepseek/deepseek-chat", 20, {
      reasoning_outputs: ["raw", "summary"],
    }),
    denseRoute(1, "gateway-cn", "deepseek/deepseek-chat", 30, {
      reasoning_outputs: ["raw"],
      enabled: false,
    }),
    denseRoute(2, "deepseek-official", "deepseek-v4-flash", 10, {
      reasoning_outputs: ["raw"],
      selected: true,
    }),
    denseRoute(2, "openrouter", "deepseek/deepseek-v4-flash", 20),
    denseRoute(3, "openai-official", "gpt-5", 10, { selected: true }),
    denseRoute(3, "azure-east", "gpt-5", 20),
    denseRoute(3, "openrouter", "openai/gpt-5", 30, { reasoning_outputs: ["summary"] }),
    denseRoute(4, "openai-official", "gpt-5-mini", 10, { selected: true }),
    denseRoute(4, "openrouter", "openai/gpt-5-mini", 20),
    denseRoute(5, "openrouter", "google/gemini-3-pro", 10, {
      reasoning_outputs: ["summary"],
      selected: true,
    }),
    denseRoute(5, "gateway-cn", "google/gemini-3-pro", 20, { reasoning_outputs: ["summary"] }),
    denseRoute(6, "openrouter", "google/gemini-3-flash", 10, {
      reasoning_outputs: ["summary"],
      selected: true,
    }),
    denseRoute(7, "openrouter", "x-ai/grok-5", 10, { reasoning_outputs: ["summary"] }),
    denseRoute(8, "openrouter", "qwen/qwen-4-max", 10, { selected: true }),
    denseRoute(8, "gateway-cn", "qwen/qwen-4-max", 20, { enabled: false }),
    denseRoute(9, "gateway-cn", "moonshot/kimi-k3", 10),
    denseRoute(10, "openrouter", "z-ai/glm-5", 10, { selected: true }),
    denseRoute(10, "gateway-cn", "z-ai/glm-5", 20),
    denseRoute(6, "gateway-cn", "google/gemini-3-flash", 20, {
      archived: true,
      reasoning_outputs: ["summary"],
    }),
    denseRoute(11, "openrouter", "anthropic/claude-lite", 10, {
      archived: true,
      archived_at: archivedAt.claudeLite,
      enabled: false,
    }),
    denseRoute(12, "openai-official", "gpt-5-2025-08", 10, {
      archived: true,
      archived_at: archivedAt.gpt5,
    }),
  ],
};
