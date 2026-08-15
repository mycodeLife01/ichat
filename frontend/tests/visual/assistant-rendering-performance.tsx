import {
  Profiler,
  type ProfilerOnRenderCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

import type { MessageSource } from "../../src/api/types";
import { Markdown } from "../../src/messages/Markdown";
import {
  createLongMarkdownFixture,
  sanitizedRealDeltaTrace,
} from "../../src/test/longMarkdownFixtures";
import { assistantContentColumn } from "../../src/ui/classes";
import "../../src/styles/global.css";
import "./assistant-rendering-performance.css";

type ScenarioName =
  | "static-10000"
  | "static-20000"
  | "static-50000"
  | "sanitized-real-trace"
  | "open-code-fence"
  | "closed-rich-blocks";

type RenderSample = {
  phase: string;
  contentLength: number;
  actualDurationMs: number;
  baseDurationMs: number;
  updateToCommitMs: number | null;
};

type TimedEntry = {
  name: string;
  startTime: number;
  duration: number;
};

type ActiveMeasurement = {
  scenario: ScenarioName;
  startedAt: number;
  baselineHeapBytes: number | null;
  peakHeapBytes: number | null;
  renderSamples: RenderSample[];
  longTasks: TimedEntry[];
  eventTimings: TimedEntry[];
  composerCommitMs: number[];
};

type PendingCommit = {
  contentLength: number;
  requestedAt: number;
  resolve: (sample: RenderSample) => void;
};

type PerformanceMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type ScenarioResult = ReturnType<typeof createScenarioResult>;

const sources: MessageSource[] = [
  {
    id: 1,
    title: "Local performance fixture source",
    url: "/tests/visual/performance-source",
    snippet: "Deterministic local-only citation data.",
    published_at: "2026-08-15",
    provider: "fixture",
  },
];

function installClipboardFixture() {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => undefined },
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function currentHeapBytes() {
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
  return memory?.usedJSHeapSize ?? null;
}

function maxNullable(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function summarize(values: readonly number[]) {
  if (values.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, total: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? 0,
    total: sorted.reduce((total, value) => total + value, 0),
  };
}

function createScenarioResult(
  active: ActiveMeasurement,
  finishedAt: number,
  finalContentLength: number,
  longTaskSupported: boolean,
  eventTimingSupported: boolean,
) {
  const renderDurationMs = active.renderSamples.map((sample) => sample.actualDurationMs);
  const contentUpdateRenderDurationMs = active.renderSamples.flatMap((sample) =>
    sample.updateToCommitMs === null ? [] : [sample.actualDurationMs],
  );
  const updateToCommitMs = active.renderSamples.flatMap((sample) =>
    sample.updateToCommitMs === null ? [] : [sample.updateToCommitMs],
  );
  const longTaskDurationMs = active.longTasks.map((entry) => entry.duration);
  const eventTimingDurationMs = active.eventTimings.map((entry) => entry.duration);
  const endHeapBytes = currentHeapBytes();
  const peakHeapBytes = maxNullable(active.peakHeapBytes, endHeapBytes);

  return {
    scenario: active.scenario,
    environment: {
      userAgent: navigator.userAgent,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      hardwareConcurrency: navigator.hardwareConcurrency,
      longTaskSupported,
      eventTimingSupported,
    },
    fixture: {
      finalContentLength,
      source:
        active.scenario === "sanitized-real-trace"
          ? sanitizedRealDeltaTrace.source
          : "deterministic local rich Markdown",
      observedRunId:
        active.scenario === "sanitized-real-trace"
          ? sanitizedRealDeltaTrace.sourceRunId
          : null,
    },
    elapsedMs: finishedAt - active.startedAt,
    renderer: {
      samples: active.renderSamples.length,
      renderDurationMs: summarize(renderDurationMs),
      contentUpdateRenderDurationMs: summarize(contentUpdateRenderDurationMs),
      updateToCommitMs: summarize(updateToCommitMs),
    },
    longTasks: {
      entries: active.longTasks,
      durationMs: summarize(longTaskDurationMs),
      over100ms: active.longTasks.filter((entry) => entry.duration > 100).length,
    },
    composer: {
      commitMs: summarize(active.composerCommitMs),
      eventTimingMs: summarize(eventTimingDurationMs),
    },
    memory: {
      baselineHeapBytes: active.baselineHeapBytes,
      peakHeapBytes,
      endHeapBytes,
      peakDeltaBytes:
        peakHeapBytes === null || active.baselineHeapBytes === null
          ? null
          : peakHeapBytes - active.baselineHeapBytes,
    },
  };
}

function cumulativePrefixes(finalText: string, updateCount: number) {
  return Array.from({ length: updateCount }, (_, index) =>
    finalText.slice(0, Math.ceil(((index + 1) * finalText.length) / updateCount)),
  );
}

function openCodeFenceFixture(targetLength: number) {
  const prefix = "已完成正文。\n\n```typescript\n";
  const source =
    'const stable_identifier_abcdefghijklmnopqrstuvwxyz0123456789 = "$$ stays source";\n';
  return `${prefix}${source.repeat(Math.ceil((targetLength - prefix.length) / source.length))}`.slice(
    0,
    targetLength,
  );
}

export function PerformanceFixture() {
  const [renderState, setRenderState] = useState({
    content: "",
    streaming: true,
    revision: 0,
  });
  const [composerText, setComposerText] = useState("");
  const [status, setStatus] = useState<{
    state: "idle" | "running" | "complete" | "error";
    label: string;
  }>({ state: "idle", label: "Ready" });
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const renderStateRef = useRef(renderState);
  const activeRef = useRef<ActiveMeasurement | null>(null);
  const pendingCommitRef = useRef<PendingCommit | null>(null);
  const composerStartedAtRef = useRef<number | null>(null);
  const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
  const eventTimingSupported = PerformanceObserver.supportedEntryTypes.includes("event");

  useEffect(() => {
    const observers: PerformanceObserver[] = [];
    if (longTaskSupported) {
      const observer = new PerformanceObserver((list) => {
        const active = activeRef.current;
        if (!active) return;
        for (const entry of list.getEntries()) {
          active.longTasks.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: false });
      observers.push(observer);
    }
    if (eventTimingSupported) {
      const observer = new PerformanceObserver((list) => {
        const active = activeRef.current;
        if (!active) return;
        for (const entry of list.getEntries()) {
          if (!new Set(["keydown", "beforeinput", "input"]).has(entry.name)) continue;
          active.eventTimings.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({
        type: "event",
        buffered: false,
        durationThreshold: 16,
      } as PerformanceObserverInit & { durationThreshold: number });
      observers.push(observer);
    }
    return () => observers.forEach((observer) => observer.disconnect());
  }, [eventTimingSupported, longTaskSupported]);

  useLayoutEffect(() => {
    const startedAt = composerStartedAtRef.current;
    composerStartedAtRef.current = null;
    if (startedAt !== null && activeRef.current) {
      activeRef.current.composerCommitMs.push(performance.now() - startedAt);
    }
  }, [composerText]);

  const onRender: ProfilerOnRenderCallback = (
    _id,
    phase,
    actualDuration,
    baseDuration,
  ) => {
    const pending = pendingCommitRef.current;
    const sample: RenderSample = {
      phase: String(phase),
      contentLength: pending?.contentLength ?? renderStateRef.current.content.length,
      actualDurationMs: actualDuration,
      baseDurationMs: baseDuration,
      updateToCommitMs: pending ? performance.now() - pending.requestedAt : null,
    };
    const active = activeRef.current;
    if (active) {
      active.renderSamples.push(sample);
      active.peakHeapBytes = maxNullable(active.peakHeapBytes, currentHeapBytes());
    }
    if (pending) {
      pendingCommitRef.current = null;
      pending.resolve(sample);
    }
  };

  const commitContent = (content: string, streaming: boolean) =>
    new Promise<RenderSample>((resolve) => {
      pendingCommitRef.current = {
        contentLength: content.length,
        requestedAt: performance.now(),
        resolve,
      };
      setRenderState((current) => {
        const next = { content, streaming, revision: current.revision + 1 };
        renderStateRef.current = next;
        return next;
      });
    });

  const runScenario = async (
    scenario: ScenarioName,
    execute: () => Promise<void>,
  ) => {
    if (status.state === "running") return;
    setResult(null);
    setStatus({ state: "running", label: `Running ${scenario}` });
    try {
      await commitContent("", true);
      await nextFrame();
      const baselineHeapBytes = currentHeapBytes();
      const active: ActiveMeasurement = {
        scenario,
        startedAt: performance.now(),
        baselineHeapBytes,
        peakHeapBytes: baselineHeapBytes,
        renderSamples: [],
        longTasks: [],
        eventTimings: [],
        composerCommitMs: [],
      };
      activeRef.current = active;
      await nextFrame();
      await execute();
      await nextFrame();
      await delay(50);
      const finishedAt = performance.now();
      activeRef.current = null;
      const nextResult = createScenarioResult(
        active,
        finishedAt,
        renderStateRef.current.content.length,
        longTaskSupported,
        eventTimingSupported,
      );
      setResult(nextResult);
      setStatus({ state: "complete", label: `Completed ${scenario}` });
    } catch (error) {
      activeRef.current = null;
      setStatus({
        state: "error",
        label: error instanceof Error ? error.message : "Performance scenario failed",
      });
    }
  };

  const runStatic = (targetLength: 10_000 | 20_000 | 50_000) =>
    runScenario(`static-${targetLength}` as ScenarioName, async () => {
      await commitContent(createLongMarkdownFixture(targetLength), false);
      const deadline = performance.now() + 5_000;
      while (!document.querySelector('[data-testid="performance-markdown"] .token.keyword')) {
        if (performance.now() >= deadline) throw new Error("Syntax highlighting timed out");
        await nextFrame();
      }
      await nextFrame();
    });

  const replay = async (prefixes: readonly string[]) => {
    for (const prefix of prefixes) {
      await commitContent(prefix, true);
      await nextFrame();
    }
  };

  const appendDelta = async () => {
    await commitContent(`${renderStateRef.current.content}\n\n后续 delta`, true);
  };

  const busy = status.state === "running";

  return (
    <main className="performance-fixture" data-testid="performance-fixture">
      <div className="performance-shell">
        <h1>Assistant Markdown performance fixture</h1>
        <p className="performance-description">
          Isolated browser measurements for deterministic static documents and cumulative
          streaming traces.
        </p>

        <div className="performance-controls">
          <button disabled={busy} type="button" onClick={() => void runStatic(10_000)}>
            Measure static 10k
          </button>
          <button disabled={busy} type="button" onClick={() => void runStatic(20_000)}>
            Measure static 20k
          </button>
          <button disabled={busy} type="button" onClick={() => void runStatic(50_000)}>
            Measure static 50k
          </button>
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void runScenario("sanitized-real-trace", () =>
                replay(sanitizedRealDeltaTrace.prefixes),
              )
            }
          >
            Replay sanitized real trace
          </button>
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void runScenario("open-code-fence", () =>
                replay(cumulativePrefixes(openCodeFenceFixture(20_000), 128)),
              )
            }
          >
            Replay open code fence
          </button>
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void runScenario("closed-rich-blocks", () =>
                replay(cumulativePrefixes(createLongMarkdownFixture(20_000), 128)),
              )
            }
          >
            Replay closed rich blocks
          </button>
          <button disabled={busy} type="button" onClick={() => void appendDelta()}>
            Append delta
          </button>
        </div>

        <textarea
          className="performance-composer"
          data-testid="performance-composer"
          aria-label="Composer responsiveness probe"
          value={composerText}
          onChange={(event) => {
            composerStartedAtRef.current = performance.now();
            setComposerText(event.target.value);
          }}
        />

        <p className="performance-status" data-state={status.state} role="status">
          {status.label}
        </p>

        <div className="performance-viewport" data-testid="performance-viewport">
          <div className={assistantContentColumn} data-testid="performance-markdown">
            <Profiler id="assistant-markdown" onRender={onRender}>
              <Markdown
                content={renderState.content}
                sources={renderState.streaming ? undefined : sources}
                streaming={renderState.streaming}
              />
            </Profiler>
          </div>
        </div>

        <pre className="performance-result" data-testid="performance-result">
          {result ? JSON.stringify(result, null, 2) : "No measurement yet"}
        </pre>
      </div>
    </main>
  );
}

installClipboardFixture();

const root = document.getElementById("root");
if (!root) throw new Error("Performance fixture root is missing");
createRoot(root).render(<PerformanceFixture />);
