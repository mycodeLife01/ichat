import type {
  AuthUserResponse,
  ConversationDetailResponse,
  MessageResponse,
  MessageSource,
  ChatModelCapability,
} from "../api/types";
import type { ModelAdminCatalog } from "../api/modelAdmin";
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
      key: "deepseek",
      label: "DeepSeek",
      thinking_levels: ["low", "high", "max"],
      supports_image_input: false,
      image_token_reserve: null,
      token_profile: "deepseek",
      sort_order: 0,
      enabled: true,
    },
    {
      key: "vision",
      label: "视觉模型",
      thinking_levels: ["low", "medium", "high"],
      supports_image_input: true,
      image_token_reserve: 4096,
      token_profile: "openai",
      sort_order: 1,
      enabled: true,
    },
  ],
  upstreams: [
    {
      key: "official",
      label: "官方入口",
      adapter: "deepseek",
      base_url: "https://api.example.test/v1",
      api_key_hint: "demo…only",
      enabled: true,
    },
    {
      key: "gateway",
      label: "备用入口",
      adapter: "openrouter",
      base_url: "https://gateway.example.test/v1",
      api_key_hint: "demo…only",
      enabled: true,
    },
  ],
  routes: [
    {
      model_key: "deepseek",
      upstream_key: "official",
      upstream_model: "deepseek-chat",
      reasoning_outputs: ["raw"],
      priority: 10,
      enabled: true,
      selected: true,
    },
    {
      model_key: "deepseek",
      upstream_key: "gateway",
      upstream_model: "deepseek/chat",
      reasoning_outputs: ["summary"],
      priority: 20,
      enabled: true,
      selected: false,
    },
  ],
};
