import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type {
  AuthTokenResponse,
  ChatModelCapability,
  ConversationResponse,
  MessageResponse,
  MessageSource,
  UserShareResponse,
} from "../../src/api/types";
import { AppProvider } from "../../src/app/AppProvider";
import { AuthScreen } from "../../src/auth/AuthScreen";
import { ResetPasswordPage } from "../../src/auth/ResetPasswordPage";
import { createAuthSession, tokenStore } from "../../src/auth/tokenStore";
import { AccountCard } from "../../src/conversations/AccountCard";
import { AvatarCropper } from "../../src/conversations/AvatarCropper";
import { MySharesCard } from "../../src/conversations/MySharesCard";
import { Sidebar } from "../../src/conversations/Sidebar";
import { AttachmentCard } from "../../src/files/AttachmentCard";
import type {
  DraftAttachment,
  FileAttachment,
  FilesCapability,
} from "../../src/files/types";
import { Message } from "../../src/messages/Message";
import { Markdown } from "../../src/messages/Markdown";
import { SharePage } from "../../src/messages/SharePage";
import { SourcesPanel } from "../../src/messages/SourcesPanel";
import { StreamingMessage } from "../../src/messages/StreamingMessage";
import { ThinkingBlock } from "../../src/messages/ThinkingBlock";
import type { ActiveRunState } from "../../src/runs/state";
import { Composer } from "../../src/ui/Composer";
import { ConfirmDialog } from "../../src/ui/ConfirmDialog";
import { InlineStatus } from "../../src/ui/InlineStatus";
import { ShareDialog } from "../../src/ui/ShareDialog";
import { Toast } from "../../src/ui/Toast";
import { VerifyEmailBanner } from "../../src/ui/VerifyEmailBanner";
import {
  attachmentMeta,
  attachmentTitle,
  assistantText,
  composerMenuItem,
  composerMode,
  composerPlaceholder,
  composerText,
  controlText,
  formHelp,
  formLabel,
  formValue,
  inputControl,
  metaText,
  reasoningCollapsed,
  reasoningText,
  semanticStatus,
  sourceMeta,
  sourceTitle,
  surfaceTitle,
  uiLabel,
  uiText,
  userMessageText,
} from "../../src/ui/classes";
import { Wordmark } from "../../src/ui/Wordmark";
import { createFakeServices } from "../../src/test/appHarness";
import "../../src/styles/global.css";
import "./typography-system.css";

type WordmarkVariantProps = {
  id: string;
  label: string;
  size: number;
  sidebar?: boolean;
};

export function WordmarkVariant({ id, label, size, sidebar = false }: WordmarkVariantProps) {
  return (
    <article className="typography-brand-card" data-brand-variant={id}>
      <h3>{label}</h3>
      <div className={sidebar ? "typography-brand-preview sidebar-desktop" : "typography-brand-preview"}>
        <span data-brand-node>
          <Wordmark size={size} />
        </span>
      </div>
    </article>
  );
}

const assistantSample = `# Markdown H1 中文 English 123 🤖

中文、English、数字 123456、标点，。！？与 emoji 🤖 保持 **16 / 26px** 阅读节奏，并包含[长链接](https://example.com/a/very/long/path/that-must-wrap-without-overflow)。

## Markdown H2

### Markdown H3

#### Markdown H4

##### Markdown H5

###### Markdown H6

- Markdown list 中文 English 123 🤖
- SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity

> Markdown quote 中文 English 123 🤖

Inline code: \`const answer = 42\`

\`\`\`typescript
const answer: number = 42;
\`\`\`

| Header 中文 | Header English |
| --- | --- |
| Cell 123 | Emoji 🤖 |
`;

const sharedTypographyRoles = [
  { id: "uiText", className: uiText, sample: "普通 UI · Conversation 会话" },
  { id: "uiLabel", className: uiLabel, sample: "强调标签 · 已置顶" },
  { id: "metaText", className: metaText, sample: "Meta · 辅助说明 12:30" },
  { id: "surfaceTitle", className: surfaceTitle, sample: "页面与 Dialog 标题" },
  { id: "controlText", className: controlText, sample: "Control · Save changes" },
  { id: "formLabel", className: formLabel, sample: "表单标签 · Email" },
  { id: "formValue", className: formValue, sample: "表单值 · reviewer@example.test" },
  {
    id: "formHelp",
    className: formHelp,
    sample: "表单帮助 中文 English 123 🤖",
  },
  { id: "composerText", className: composerText, sample: "Composer 输入正文 🤖" },
  {
    id: "composerPlaceholder",
    className: composerPlaceholder,
    sample: "Composer placeholder",
  },
  { id: "composerMode", className: composerMode, sample: "Composer 当前模式 · 高" },
  {
    id: "composerMenuItem",
    className: composerMenuItem,
    sample: "Composer menu item · 模型",
  },
  { id: "userMessageText", className: userMessageText, sample: "用户消息\n保留换行" },
  { id: "assistantText", className: assistantText, sample: "助手正文保持自然换行" },
  {
    id: "reasoningCollapsed",
    className: reasoningCollapsed,
    sample: "思考了 18s",
  },
  { id: "reasoningText", className: reasoningText, sample: "展开思考正文" },
  {
    id: "attachmentTitle",
    className: attachmentTitle,
    sample: "attachment-typography-reference.pdf",
  },
  {
    id: "attachmentMeta",
    className: attachmentMeta,
    sample: "PDF · 42 KB · 已解析",
  },
  {
    id: "sourceTitle",
    className: sourceTitle,
    sample: "ChatGPT typography reference source",
  },
  {
    id: "sourceMeta",
    className: sourceMeta,
    sample: "example.com · 2026-08-16",
  },
  {
    id: "semanticStatus",
    className: `${semanticStatus} text-success-foreground`,
    sample: "Success：状态具有明确文案",
  },
] as const;

const chatSources: MessageSource[] = [
  {
    id: 1,
    title: "ChatGPT typography reference with a naturally wrapping source title",
    url: "https://www.example.com/typography/reference",
    snippet: "中文 English 123456：来源摘要使用 Meta 角色，并在窄屏自然回流。",
    published_at: "2026-08-16",
    provider: "tavily",
  },
  {
    id: 2,
    title: "Responsive text and overflow notes",
    url: "https://docs.example.org/responsive/long-path-for-overflow-verification",
    snippet: "LongURL and Supercalifragilisticexpialidocious remain readable without shrinking.",
    published_at: "2026-08-15",
    provider: "tavily",
  },
];

const longUserText = Array.from(
  { length: 18 },
  (_, index) =>
    `${index + 1}. 用户消息 中文 English 123456 🤖 ` +
    "SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
).join("\n");

const chatFile: FileAttachment = {
  id: "typography-file",
  name: "2026-Q4-typography-Supercalifragilisticexpialidocious-report.pdf",
  media_type: "application/pdf",
  size_bytes: 42_000,
  category: "pdf",
  model_input_kind: "document",
  preview_available: false,
};

const userMessage: MessageResponse = {
  id: "typography-user",
  conversation_id: "typography-conversation",
  run_id: null,
  role: "user",
  content: longUserText,
  reasoning: null,
  position: 1,
  created_at: "2026-08-16T12:00:00Z",
};

const assistantMessage: MessageResponse = {
  id: "typography-assistant",
  conversation_id: "typography-conversation",
  run_id: "typography-run",
  role: "assistant",
  content:
    "助手 Markdown 继续保持 **16 / 26px** 保护基线；引用与来源单独迁移。[1][2]\n\n" +
    "LongURL: https://example.com/a/very/long/path/that-must-wrap-without-overflow",
  reasoning: null,
  metadata: { sources: chatSources },
  attachments: [chatFile],
  position: 2,
  created_at: "2026-08-16T12:00:01Z",
};

const failedAttachment: DraftAttachment = {
  client_id: "typography-failed-draft",
  upload_id: "typography-upload",
  status: "failed",
  error_code: "upload_failed",
  error_message:
    "上传失败：请检查网络后重试；this deliberately long status wraps instead of shrinking.",
  file: null,
  name: "failed-typography-document-with-a-very-long-name.pdf",
  media_type: "application/pdf",
  size_bytes: 42_000,
  category: "pdf",
  model_input_kind: "document",
};

const chatModels: ChatModelCapability[] = [
  {
    id: "openai/gpt-5.6-typography-verification-with-a-long-model-name",
    provider: "openai",
    label: "gpt-5.6-typography-verification-with-a-long-model-name",
    thinking_levels: ["low", "medium", "high", "xhigh", "max"],
    default: true,
    supports_image_input: true,
  },
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "deepseek-v4-flash",
    thinking_levels: ["low", "high", "max"],
    default: false,
    supports_image_input: false,
  },
];

const fileCapability: FilesCapability = {
  enabled: true,
  allowed_extensions: ["pdf", "png", "txt"],
  category_max_bytes: { document: 25_000_000, image: 10_000_000 },
  max_attachments_per_message: 10,
  max_message_bytes: 50_000_000,
  quota_bytes: 1_000_000_000,
  target_turn_tokens: 128_000,
  context_budget_tokens: 256_000,
};

const failedRun = {
  runId: "typography-failed-run",
  conversationId: "typography-conversation",
  providerName: "openai",
  latestSeq: 4,
  draftText: "失败前保留的助手正文。",
  draftReasoning: "",
  toolState: null,
  status: "failed",
  cancelRequested: false,
} satisfies NonNullable<ActiveRunState>;

const cancelledRun = {
  ...failedRun,
  runId: "typography-cancelled-run",
  draftText: "取消前保留的助手正文。",
  status: "cancelled",
} satisfies NonNullable<ActiveRunState>;

const runningTool = {
  ...failedRun,
  runId: "typography-tool-run",
  draftText: "",
  draftReasoning: "",
  toolState: {
    status: "running",
    tool_name: "web_search",
    query: "ChatGPT typography 中文 English long query that should wrap",
    message: null,
    result_count: null,
    sources: [],
  },
  status: "streaming",
} satisfies NonNullable<ActiveRunState>;

function useMobileFixture() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 760);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 760);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return isMobile;
}

export function ChatCoreTypographyFixture() {
  const isMobile = useMobileFixture();
  const [composerValue, setComposerValue] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);

  return (
    <div
      className="typography-chat-grid"
      data-testid="chat-core-typography"
      data-mobile={isMobile ? "true" : "false"}
    >
      <article className="typography-chat-card typography-chat-composer" data-testid="chat-composer">
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSend={() => {}}
          onStop={() => {}}
          state="idle"
          thinkingLevel="max"
          onThinkingLevelChange={() => {}}
          webSearchAvailable
          models={chatModels}
          model={chatModels[0].id}
          fileCapability={fileCapability}
          canSend={composerValue.trim() !== ""}
          isMobile={isMobile}
        />
      </article>

      <article className="typography-chat-card" data-testid="chat-user-message">
        <Message
          message={userMessage}
          isMobile={isMobile}
          onEditAndRegenerate={() => {}}
        />
      </article>

      <article className="typography-chat-card" data-testid="chat-thinking-block">
        <ThinkingBlock
          content={
            "展开思考正文 中文 English 123456 🤖 " +
            "https://example.com/a/very/long/reasoning/path/that-must-wrap"
          }
          streaming={false}
        />
      </article>

      <article className="typography-chat-card" data-testid="chat-assistant-message">
        <Message
          message={assistantMessage}
          isMobile={isMobile}
          onRegenerate={() => {}}
          onShowSources={() => setSourcesOpen(true)}
        />
      </article>

      <article className="typography-chat-card typography-status-grid">
        <div data-testid="chat-tool-running">
          <StreamingMessage run={runningTool} />
        </div>
        <div data-testid="chat-run-failed">
          <StreamingMessage run={failedRun} />
        </div>
        <div data-testid="chat-run-cancelled">
          <StreamingMessage run={cancelledRun} />
        </div>
      </article>

      <article className="typography-chat-card" data-testid="chat-failed-attachment">
        <AttachmentCard attachment={failedAttachment} mode="composer" />
      </article>

      <div className="typography-source-shell" data-testid="chat-source-shell">
        <div className="typography-source-shell-placeholder">
          来源面板保持生产 desktop column / mobile drawer 行为。
        </div>
        <SourcesPanel
          sources={chatSources}
          open={sourcesOpen}
          isMobile={isMobile}
          onClose={() => setSourcesOpen(false)}
        />
      </div>
    </div>
  );
}

const secondaryAuthResponse: AuthTokenResponse = {
  user: {
    id: 42,
    username: "typography-reviewer",
    nickname: "中英文 Typography Reviewer With A Long Display Name",
    email:
      "typography-verification-with-a-long-address@example-organization.test",
    email_verified: false,
  },
  access_token: "typography-access-token",
  refresh_token: "typography-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
};

const secondaryConversations: ConversationResponse[] = [
  {
    id: "secondary-1",
    title:
      "中英文超长会话标题 Typography SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
    activated_at: "2026-08-16T12:00:00Z",
    created_at: "2026-08-16T12:00:00Z",
    updated_at: "2026-08-16T12:00:00Z",
  },
  {
    id: "secondary-2",
    title: "Desktop 与 Mobile 使用相同的 14 / 20px 角色",
    activated_at: "2026-08-16T11:00:00Z",
    created_at: "2026-08-16T11:00:00Z",
    updated_at: "2026-08-16T11:00:00Z",
  },
];

const secondaryShares: UserShareResponse[] = [
  {
    token: "secondary-share-token",
    conversation_id: "secondary-1",
    conversation_title:
      "中英文分享标题 Typography SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
    expires_at: "2026-09-16T12:00:00Z",
    revoked_at: null,
    created_at: "2026-08-16T12:00:00Z",
  },
];

const secondaryServices = createFakeServices(
  {
    me: async () => secondaryAuthResponse.user,
  },
  {},
  {},
  {},
  {
    list: async () => [],
    listMine: async () => secondaryShares,
    getPublic: async () => ({
      title:
        "公开分享标题 中文 English SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
      messages: [],
      created_at: "2026-08-16T12:00:00Z",
    }),
  },
);

function SecondarySidebarFixture() {
  const isMobile = useMobileFixture();

  return (
    <main
      className="typography-secondary-stage flex min-h-screen bg-bg"
      data-testid="secondary-sidebar-fixture"
      data-mobile={isMobile ? "true" : "false"}
    >
      <Sidebar
        items={secondaryConversations}
        selectedId="secondary-1"
        user={{
          email: secondaryAuthResponse.user.email,
          username: secondaryAuthResponse.user.username,
          name: secondaryAuthResponse.user.nickname,
          emailVerified: false,
        }}
        isMobile={isMobile}
        collapsed={false}
        mobileOpen
        pendingTitleIds={[]}
        hasMore={false}
        isLoadingMore={false}
        onSelect={() => {}}
        onNew={() => {}}
        onLoadMore={() => {}}
        onRename={() => {}}
        onRequestShare={() => {}}
        onRequestDelete={() => {}}
        onLogout={() => {}}
        onResendVerification={async () => ({ status: "ok" })}
        onUpdateNickname={async () => ({ status: "ok" })}
        onChangePassword={async () => ({ status: "ok" })}
        onRequestDeletion={async () => ({ status: "ok" })}
        onLoadShares={async () => secondaryShares}
        onRevokeShare={async () => ({ status: "ok" })}
        onToast={() => {}}
        onToggleCollapsed={() => {}}
        onCloseMobile={() => {}}
      />
      <div className="typography-secondary-placeholder" aria-hidden="true">
        Secondary surface viewport
      </div>
    </main>
  );
}

function SecondaryAuthFixture() {
  return (
    <MemoryRouter>
      <AppProvider services={secondaryServices}>
        <AuthScreen />
      </AppProvider>
    </MemoryRouter>
  );
}

function SecondaryAccountFixture() {
  return (
    <AccountCard
      user={{
        email: secondaryAuthResponse.user.email,
        username: secondaryAuthResponse.user.username,
        name: secondaryAuthResponse.user.nickname,
        emailVerified: false,
      }}
      onClose={() => {}}
      onResendVerification={async () => ({ status: "ok" })}
      onUpdateNickname={async () => ({ status: "ok" })}
      onUploadAvatar={async () => "https://images.example.test/avatar.png"}
      onChangePassword={async () => ({ status: "ok" })}
      onRequestDeletion={async () => ({ status: "ok" })}
      onToast={() => {}}
    />
  );
}

function SecondarySharesFixture() {
  return (
    <MySharesCard
      onClose={() => {}}
      onLoad={async () => secondaryShares}
      onRevoke={async () => ({ status: "ok" })}
      onToast={() => {}}
    />
  );
}

function SecondaryShareDialogFixture() {
  return (
    <MemoryRouter>
      <AppProvider services={secondaryServices}>
        <ShareDialog conversationId="secondary-1" hasAttachments onClose={() => {}} />
      </AppProvider>
    </MemoryRouter>
  );
}

function SecondaryConfirmFixture() {
  return (
    <ConfirmDialog
      title="确认这项 Typography 操作"
      body={
        "中文与 English 状态说明会自然回流；" +
        "SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity 不得裁切或越界。"
      }
      confirmLabel="确认操作"
      destructive
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  );
}

function SecondaryStatesFixture() {
  return (
    <MemoryRouter>
      <AppProvider services={secondaryServices}>
        <main className="typography-secondary-states" data-testid="secondary-states-fixture">
          <VerifyEmailBanner />
          <section className="typography-secondary-state-card">
            <h1 className={surfaceTitle}>表单与状态文字</h1>
            <label className={formLabel} htmlFor="secondary-placeholder">
              中英文表单标签
            </label>
            <input
              id="secondary-placeholder"
              className={`${inputControl} h-11 w-full px-3.5`}
              placeholder="Placeholder 中文 English 需要保持 tertiary 语义"
            />
            <label className={formLabel} htmlFor="secondary-disabled">
              Disabled control
            </label>
            <input
              id="secondary-disabled"
              className={`${inputControl} h-11 w-full px-3.5`}
              value="Disabled 中文 English"
              disabled
              readOnly
            />
            <p className={formHelp}>
              帮助文字自然回流：SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity
            </p>
            <InlineStatus tone="error">
              Error：输入内容无效，请检查后重试。
            </InlineStatus>
            <InlineStatus tone="warning">
              Warning：附件仍在解析，完成前请勿关闭页面。
            </InlineStatus>
            <InlineStatus tone="success">
              Success：更改已保存。
            </InlineStatus>
          </section>
          <Toast
            toast={{
              id: 1,
              tone: "warning",
              message:
                "Warning 中文 English SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
            }}
            onDismiss={() => {}}
            duration={60_000}
          />
        </main>
      </AppProvider>
    </MemoryRouter>
  );
}

const secondaryCropFile = new File(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">' +
      '<rect width="512" height="512" fill="#d9e7f7"/>' +
      '<circle cx="256" cy="210" r="96" fill="#0d0d0d"/>' +
      '<rect x="120" y="320" width="272" height="160" rx="80" fill="#0d0d0d"/>' +
      "</svg>",
  ],
  "typography-avatar.svg",
  { type: "image/svg+xml" },
);

function SecondaryCropperFixture() {
  return (
    <AvatarCropper
      file={secondaryCropFile}
      onCancel={() => {}}
      onConfirm={async () => {}}
      onError={() => {}}
    />
  );
}

function SecondaryLifecycleFixture() {
  return (
    <MemoryRouter initialEntries={["/reset-password?token=typography-token"]}>
      <AppProvider services={secondaryServices}>
        <ResetPasswordPage />
      </AppProvider>
    </MemoryRouter>
  );
}

function SecondarySharePageFixture() {
  return (
    <MemoryRouter initialEntries={["/share/typography-token"]}>
      <AppProvider services={secondaryServices}>
        <Routes>
          <Route path="/share/:token" element={<SharePage />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>
  );
}

export function TypographySystemFixture() {
  return (
    <main className="typography-system-fixture" data-testid="typography-system-fixture">
      <header className="typography-fixture-header">
        <p className="typography-fixture-kicker">Ticket 02 · token layer</p>
        <h1>iChat 文字系统基线</h1>
        <p>
          仅用于本地视觉验收；展示品牌冻结边界、已对齐区域和中英文混排压力样本。
        </p>
      </header>

      <section className="typography-fixture-section" aria-labelledby="brand-heading">
        <div className="typography-fixture-heading">
          <h2 id="brand-heading">品牌字标冻结边界</h2>
          <p>所有节点均复用生产 Wordmark；AuthScreen 标题保留其独立生产 class 契约。</p>
        </div>
        <div className="typography-brand-grid">
          <WordmarkVariant id="wordmark-18" label="Wordmark 18px" size={18} />
          <WordmarkVariant id="wordmark-20" label="Wordmark 20px" size={20} />
          <WordmarkVariant
            id="sidebar-desktop-expanded"
            label="Sidebar desktop expanded · 18px"
            size={18}
            sidebar
          />
          <article className="typography-brand-card" data-brand-variant="sidebar-desktop-collapsed">
            <h3>Sidebar desktop collapsed rail</h3>
            <div className="typography-brand-preview typography-collapsed-rail" data-testid="collapsed-rail">
              <span aria-hidden="true">☰</span>
              <span>No visible wordmark</span>
            </div>
          </article>
          <WordmarkVariant id="sidebar-mobile" label="Sidebar mobile drawer · 20px" size={20} />
          <WordmarkVariant id="share-desktop" label="SharePage desktop · 18px" size={18} />
          <WordmarkVariant id="share-mobile" label="SharePage mobile · 20px" size={20} />
          <WordmarkVariant id="verify-email" label="VerifyEmailPage · 18px" size={18} />
          <WordmarkVariant id="reset-password" label="ResetPasswordPage · 18px" size={18} />
          <WordmarkVariant
            id="confirm-account-deletion"
            label="ConfirmAccountDeletionPage · 18px"
            size={18}
          />
          <article className="typography-brand-card" data-brand-variant="auth-screen-title">
            <h3>AuthScreen independent title · 22px</h3>
            <div className="typography-brand-preview">
              <span
                className="auth-brand-title"
                data-brand-node
              >
                iChat
              </span>
            </div>
          </article>
        </div>
      </section>

      <section className="typography-fixture-section" aria-labelledby="aligned-heading">
        <div className="typography-fixture-heading">
          <h2 id="aligned-heading">已对齐区域</h2>
          <p>助手 Markdown 与桌面 Sidebar 在迁移前先固定 computed-style。</p>
        </div>
        <div className="typography-aligned-grid">
          <article className="typography-baseline-card sidebar-desktop" data-testid="sidebar-typography-baseline">
            <div className="typography-sidebar-label" data-testid="sidebar-group-label">聊天</div>
            <div className="typography-sidebar-row" data-testid="sidebar-row-text">
              中英混排 Conversation 2026 😀
            </div>
          </article>
          <article className="typography-baseline-card" data-testid="assistant-typography-baseline">
            <div className="assistant-content">
              <Markdown content={assistantSample} />
            </div>
          </article>
        </div>
      </section>

      <section className="typography-fixture-section" aria-labelledby="roles-heading">
        <div className="typography-fixture-heading">
          <h2 id="roles-heading">共享文字角色</h2>
          <p>角色只建立 token 与 class 契约；业务表面的迁移由后续 tickets 完成。</p>
        </div>
        <div className="typography-role-grid" data-testid="typography-role-grid">
          {sharedTypographyRoles.map((role) => (
            <article className="typography-role-card" data-type-role={role.id} key={role.id}>
              <code>{role.id}</code>
              <p className={role.className}>{role.sample}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="typography-fixture-section" aria-labelledby="chat-core-heading">
        <div className="typography-fixture-heading">
          <h2 id="chat-core-heading">Ticket 03 · 聊天核心生产表面</h2>
          <p>
            直接渲染 Composer、消息、思考、引用、来源、附件和 Run 状态，用于跨宽度 computed-style 与自然回流验收。
          </p>
        </div>
        <ChatCoreTypographyFixture />
      </section>

      <section className="typography-fixture-section" aria-labelledby="samples-heading">
        <div className="typography-fixture-heading">
          <h2 id="samples-heading">字符与换行压力样本</h2>
          <p>覆盖中文、英文、数字、标点、emoji、长单词和长 URL。</p>
        </div>
        <div className="typography-character-samples" data-testid="typography-character-samples">
          <p data-character-sample="mixed">
            简体中文 English 1234567890 ，。！？：；“”‘’ () [] {} — + = % 😀 🤖 🚀
          </p>
          <p data-character-sample="long-word">
            SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity
          </p>
          <p data-character-sample="long-url">
            https://example.com/typography/a/very/long/path?query=中文-English-1234567890&amp;emoji=🤖
          </p>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Typography system fixture root is missing");

const secondarySurface = new URLSearchParams(window.location.search).get("surface");
tokenStore.clear();
if (secondarySurface === "states") {
  tokenStore.save(createAuthSession(secondaryAuthResponse));
}

const fixture = (() => {
  switch (secondarySurface) {
    case "sidebar":
      return <SecondarySidebarFixture />;
    case "auth":
      return <SecondaryAuthFixture />;
    case "account":
      return <SecondaryAccountFixture />;
    case "shares":
      return <SecondarySharesFixture />;
    case "share-dialog":
      return <SecondaryShareDialogFixture />;
    case "confirm":
      return <SecondaryConfirmFixture />;
    case "states":
      return <SecondaryStatesFixture />;
    case "cropper":
      return <SecondaryCropperFixture />;
    case "lifecycle":
      return <SecondaryLifecycleFixture />;
    case "share-page":
      return <SecondarySharePageFixture />;
    default:
      return <TypographySystemFixture />;
  }
})();

createRoot(root).render(fixture);
