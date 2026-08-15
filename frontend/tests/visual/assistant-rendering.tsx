import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { MessageResponse, MessageSource } from "../../src/api/types";
import { Markdown } from "../../src/messages/Markdown";
import { MessageThread } from "../../src/messages/MessageThread";
import { ThinkingBlock } from "../../src/messages/ThinkingBlock";
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

const streamingPrefixes = [
  {
    id: "emphasis",
    label: "未闭合 emphasis",
    content: "已完成正文。\n\n**仍在生成的重点",
  },
  {
    id: "link",
    label: "未闭合 link",
    content: "已完成正文。\n\n[仍在生成的链接](https://example.com/path",
  },
  {
    id: "fence",
    label: "未闭合 fence",
    content: "已完成正文。\n\n```typescript\nconst answer: number = 42;",
  },
  {
    id: "list",
    label: "未闭合 list",
    content: "- 已完成列表项\n  - 正在生成的嵌套项\n    -",
  },
  {
    id: "table",
    label: "未闭合 table",
    content: "| Surface | State |\n| --- | --- |\n| Markdown | streaming",
  },
  {
    id: "math",
    label: "未闭合 display math",
    content: "公式前正文保持可见。\n\n\\[\n\\frac{1}{",
  },
] as const;

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

        <section className="fixture-section fixture-constrained" data-testid="streaming-prefixes">
          <div className="fixture-section-heading">
            <span>02</span>
            <div>
              <h2>流式未闭合 Markdown</h2>
              <p>每个卡片都是可单独观察的 parser prefix，不依赖 SSE。</p>
            </div>
          </div>
          <div className="fixture-grid">
            {streamingPrefixes.map((prefix) => (
              <article
                className="fixture-card"
                data-streaming-prefix={prefix.id}
                key={prefix.id}
              >
                <h3>{prefix.label}</h3>
                <Markdown content={prefix.content} streaming />
              </article>
            ))}
          </div>
        </section>

        <section className="fixture-section fixture-constrained" data-testid="copy-scenarios">
          <div className="fixture-section-heading">
            <span>03</span>
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
            <span>04</span>
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
