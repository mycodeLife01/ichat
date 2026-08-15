import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { MessageResponse, MessageSource } from "../../src/api/types";
import { AppProvider } from "../../src/app/AppProvider";
import { Markdown } from "../../src/messages/Markdown";
import { MessageThread } from "../../src/messages/MessageThread";
import { SharePage } from "../../src/messages/SharePage";
import { StreamingMessage } from "../../src/messages/StreamingMessage";
import { ThinkingBlock } from "../../src/messages/ThinkingBlock";
import type { ActiveRunState } from "../../src/runs/state";
import { createFakeServices } from "../../src/test/appHarness";
import { streamingMarkdownFixtures } from "../../src/test/streamingMarkdownFixtures";
import "../../src/styles/global.css";
import completeMarkdown from "./assistant-rendering-content.md?raw";
import "./assistant-rendering.css";

type CopyScenario = "success" | "failure" | "default";

type CopyAttemptDetail = {
  scenario: CopyScenario;
  text: string;
};

const sources: MessageSource[] = [
  {
    id: 1,
    title: "脱敏视觉 fixture 来源",
    url: "/tests/visual/reference-source",
    snippet: "Local-only source data for citation rendering.",
    published_at: "2026-08-15",
    provider: "fixture",
  },
];

const completeMessage: MessageResponse = {
  id: "visual-message-1",
  conversation_id: "visual-conversation-1",
  run_id: "visual-run-1",
  role: "assistant",
  content: completeMarkdown,
  reasoning: null,
  metadata: { sources },
  position: 1,
  created_at: "2026-08-15T00:00:00Z",
};

const parityMarkdown = `## 三入口一致性

同一份 **Markdown** 正文包含 \`inline_code()\`、[站内链接](/help/visual-fixture) 与引用：

> final、streaming 与 share 应只保留入口特有动作差异。

\`\`\`typescript
const surface: "final" | "streaming" | "share" = "final";
\`\`\`

| Surface | Renderer | Overflow |
| --- | --- | --- |
| Code | shared | own scroller |
| Table | shared | own scroller |`;

const partialMarkdown = `## 可恢复 partial

已完成的正文保持可读，\`status\` 只由 Run 终态决定。

\`\`\`bash
pnpm run test:visual
\`\`\``;

const parityMessage: MessageResponse = {
  ...completeMessage,
  id: "visual-parity-message",
  run_id: "visual-parity-run",
  content: parityMarkdown,
  metadata: {},
};

type ConcreteRunState = NonNullable<ActiveRunState>;

function runState(
  status: ConcreteRunState["status"],
  draftText: string,
  overrides: Partial<ConcreteRunState> = {},
): ConcreteRunState {
  return {
    runId: `visual-${status}-run`,
    conversationId: "visual-conversation-1",
    providerName: "openai",
    latestSeq: 12,
    draftText,
    draftReasoning: "",
    toolState: null,
    status,
    cancelRequested: status === "cancelling",
    ...overrides,
  };
}

const streamingRun = runState("streaming", parityMarkdown);
const failedRun = runState("failed", partialMarkdown);
const cancelledRun = runState("cancelled", partialMarkdown);
const recoveredRun = runState("streaming", partialMarkdown, {
  runId: "visual-recovered-run",
  latestSeq: 41,
});

const shareServices = createFakeServices(
  {},
  {},
  {},
  {},
  {
    getPublic: async () => ({
      title: null,
      messages: [
        {
          role: "assistant",
          content: parityMarkdown,
          reasoning: null,
          sources: [],
        },
      ],
      created_at: "2026-08-15T00:00:00Z",
    }),
  },
);

function installClipboardFixture() {
  const writeText = async (text: string) => {
    const scenario: CopyScenario = text.includes("copy-failure-fixture")
      ? "failure"
      : text.includes("copy-success-fixture")
        ? "success"
        : "default";

    window.dispatchEvent(
      new CustomEvent<CopyAttemptDetail>("fixture-copy-attempt", {
        detail: { scenario, text },
      }),
    );

    if (scenario === "failure") {
      throw new DOMException("Fixture clipboard rejection", "NotAllowedError");
    }
  };

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    window.matchMedia("(max-width: 760px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const onChange = () => setIsMobile(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

export function CopyScenarioCard({
  scenario,
}: {
  scenario: Exclude<CopyScenario, "default">;
}) {
  const [outcome, setOutcome] = useState<"idle" | CopyScenario>("idle");

  useEffect(() => {
    const onAttempt = (event: Event) => {
      const detail = (event as CustomEvent<CopyAttemptDetail>).detail;
      if (detail.scenario === scenario) setOutcome(detail.scenario);
    };
    window.addEventListener("fixture-copy-attempt", onAttempt);
    return () => window.removeEventListener("fixture-copy-attempt", onAttempt);
  }, [scenario]);

  const label = scenario === "success" ? "复制成功注入" : "复制失败注入";
  const code = scenario === "success" ? "copy-success-fixture" : "copy-failure-fixture";

  return (
    <article className="fixture-card" data-copy-scenario={scenario}>
      <h3>{label}</h3>
      <Markdown content={`\`\`\`text\n${code}\n\`\`\``} />
      <p className="fixture-status" data-state={outcome} role="status">
        {outcome === "idle"
          ? "等待复制操作"
          : outcome === "success"
            ? "fixture 已让 Clipboard promise 成功"
            : "fixture 已让 Clipboard promise 失败"}
      </p>
    </article>
  );
}

function EntryHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="fixture-entry-heading">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function RunStateCard({
  testId,
  title,
  description,
  run,
}: {
  testId: string;
  title: string;
  description: string;
  run: ConcreteRunState;
}) {
  return (
    <article className="fixture-card fixture-run-state" data-testid={testId}>
      <h3>{title}</h3>
      <p className="fixture-card-description">{description}</p>
      <StreamingMessage run={run} />
    </article>
  );
}

export function AssistantRenderingFixture() {
  const isMobile = useIsMobile();

  return (
    <div className="visual-fixture" data-testid="assistant-rendering-fixture">
      <header className="fixture-header">
        <p className="fixture-kicker">Local visual harness · no API or authentication</p>
        <h1>助手回复渲染 fixture</h1>
        <p>
          固定内容仅用于真实 Chrome 的几何检查和诊断截图；本页不是正式应用路由。
        </p>
      </header>

      <main>
        <section className="fixture-section" data-testid="final-message">
          <div className="fixture-section-heading">
            <span>01</span>
            <div>
              <h2>完整助手回复</h2>
              <p>覆盖 GFM、代码、表格、KaTeX、citation、长内容与中英文混排。</p>
            </div>
          </div>
          <MessageThread messages={[completeMessage]} isMobile={isMobile} />
        </section>

        <section className="fixture-section" data-testid="entry-parity">
          <div className="fixture-section-heading">
            <span>02</span>
            <div>
              <h2>Final / streaming / share 三入口</h2>
              <p>同一正文直接经过三个生产入口，入口外壳与动作允许不同。</p>
            </div>
          </div>
          <div className="fixture-entry-list">
            <article className="fixture-entry" data-render-entry="final">
              <EntryHeading
                title="历史最终消息"
                description="生产 MessageThread → Message → Markdown。"
              />
              <div className="fixture-live-shell">
                <MessageThread messages={[parityMessage]} isMobile={isMobile} />
              </div>
            </article>
            <article className="fixture-entry" data-render-entry="streaming">
              <EntryHeading
                title="进行中流式消息"
                description="生产 MessageThread → StreamingMessage → Markdown。"
              />
              <div className="fixture-live-shell">
                <MessageThread messages={[]} isMobile={isMobile}>
                  <StreamingMessage run={streamingRun} />
                </MessageThread>
              </div>
            </article>
            <article
              className="fixture-entry fixture-share-entry"
              data-render-entry="share"
            >
              <EntryHeading
                title="公开分享"
                description="生产 SharePage 通过脱敏的本地 share service 读取快照。"
              />
              <div className="fixture-share-shell">
                <MemoryRouter initialEntries={["/share/visual-token"]}>
                  <AppProvider services={shareServices}>
                    <Routes>
                      <Route path="/share/:token" element={<SharePage />} />
                    </Routes>
                  </AppProvider>
                </MemoryRouter>
              </div>
            </article>
          </div>
        </section>

        <section className="fixture-section fixture-constrained" data-testid="run-states">
          <div className="fixture-section-heading">
            <span>03</span>
            <div>
              <h2>Run partial 与恢复状态</h2>
              <p>失败、取消和刷新恢复均直接复用生产 StreamingMessage。</p>
            </div>
          </div>
          <div className="fixture-grid">
            <RunStateCard
              testId="run-state-failed"
              title="失败 partial"
              description="保留正文，并显示持久错误状态。"
              run={failedRun}
            />
            <RunStateCard
              testId="run-state-cancelled"
              title="取消 partial"
              description="保留正文，不额外伪造终态消息。"
              run={cancelledRun}
            />
            <RunStateCard
              testId="run-state-recovered"
              title="刷新恢复 partial"
              description="以服务端 draft 与 cursor 重建的进行中视图。"
              run={recoveredRun}
            />
          </div>
        </section>

        <section className="fixture-section fixture-constrained" data-testid="streaming-prefixes">
          <div className="fixture-section-heading">
            <span>04</span>
            <div>
              <h2>流式未闭合 Markdown</h2>
              <p>每个卡片都是可单独观察的 parser prefix，不依赖 SSE。</p>
            </div>
          </div>
          <div className="fixture-grid">
            {streamingMarkdownFixtures.map((prefix) => (
              <article
                className="fixture-card"
                data-streaming-prefix={prefix.id}
                key={prefix.id}
              >
                <h3>{prefix.label}</h3>
                <Markdown content={prefix.prefixes.at(-2) ?? ""} streaming />
              </article>
            ))}
          </div>
        </section>

        <section className="fixture-section fixture-constrained" data-testid="copy-scenarios">
          <div className="fixture-section-heading">
            <span>05</span>
            <div>
              <h2>Clipboard promise 场景</h2>
              <p>fixture 注入成功与失败；组件仍走生产 Markdown 的复制按钮。</p>
            </div>
          </div>
          <div className="fixture-grid fixture-grid-two">
            <CopyScenarioCard scenario="success" />
            <CopyScenarioCard scenario="failure" />
          </div>
        </section>

        <section className="fixture-section fixture-constrained" data-testid="thinking-scenarios">
          <div className="fixture-section-heading">
            <span>06</span>
            <div>
              <h2>ThinkingBlock 回归状态</h2>
              <p>直接复用现有组件，不改变其 props、DOM 语义或交互逻辑。</p>
            </div>
          </div>
          <div className="fixture-grid fixture-grid-two">
            <article className="fixture-card" data-thinking-state="collapsed">
              <h3>完成后折叠</h3>
              <ThinkingBlock content="这是已完成且默认折叠的 reasoning fixture。" streaming={false} />
            </article>
            <article className="fixture-card" data-thinking-state="expanded">
              <h3>流式时展开</h3>
              <ThinkingBlock
                content={"第一步检查输入。\n第二步组织回答。"}
                streaming
                showStreamingPreview={false}
                autoExpandWhileStreaming
              />
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}

installClipboardFixture();

const root = document.getElementById("root");
if (!root) throw new Error("Visual fixture root is missing");
createRoot(root).render(<AssistantRenderingFixture />);
