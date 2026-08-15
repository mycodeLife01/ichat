# ChatGPT 风格流式 prefix 与长回复性能交接

日期：2026-08-15

分支：`refactor/ai-chat-render`

范围：`.scratch/refactor-chat-render/issues/05-streaming-prefix-and-performance.md`

下一步：ticket 06（三入口最终视觉验收与 golden baseline）

## 当前结论

Ticket 05 已完成。当前累计全量 Markdown parse 在典型真实形状 trace 和两类 20k 流式压力下均低于 PRD 门槛，Composer 输入没有可感知阻塞，因此没有增加视图 batching，也没有修改 Run reducer、SSE cursor、恢复或 reasoning 语义。

50k rich Markdown 的单次静态冷渲染出现约 121ms long task。这是已记录的极长最终回复规模边界，但不是典型累计流式门；流式 batching 也不会修复单次 final parse，因此本 ticket 不据此扩张到增量 AST 或稳定前缀缓存。

## Prefix matrix

新增共享的累计 prefix fixture，从空串逐步推进到完整内容，覆盖：

- `*`、`**`、`~~` 的打开、正文与闭合阶段；
- `[`、`[text](`、URL 逐步到完整 link；
- opening fence、语言名、逐行 code 和 closing fence；
- 无序、有序及嵌套列表；
- table header、separator 和 row；
- `\(...\)`、`\[...\]` 与 `$$...$$`；
- citation marker、普通方括号、blockquote、中英文长段落和危险 raw HTML。

每一阶段都从生产 `Markdown` Interface 观察：已完成正文持续可见、没有异常、raw HTML/事件属性不进入 DOM、没有 `.katex-error`。完整内容在 streaming 与 final 间保持相同语义 surface 和节点 identity。

矩阵额外暴露并修复了两个真实边界：

1. 未闭合 fenced code 中的 `$$` 过去会被 display-math clamp 误判并截断后续源码；现在 closed/streaming fence 都作为 math normalize 的跳过区域。
2. `\[...\]` 过去虽进入 KaTeX，却是 inline surface；现在规范化为 opener/closer 独占行的 flow fence，稳定落成 `.katex-display`。

另有 unit + Chromium 交互回归确认：已闭合 code/table 后续收到 delta 时，组件节点、复制成功态和横向滚动位置不重置；浏览器滚动容器的用户上滚位置也保持。

## 性能方法

隔离入口为 `frontend/tests/visual/assistant-rendering-performance.html`。它只包裹生产 `Markdown`，不进入 production build，也没有给 `MarkdownProps` 增加 profiling 参数。

测量环境：

- Windows、Headless Chromium `151.0.7922.34`；
- viewport `1440 × 900`、DPR 1、12 logical cores；
- Vite development React、浅色、reduced motion；
- Chromium 启用 `--enable-precise-memory-info`。

React Profiler 的 content-update duration 记录 Markdown parse + React render，update-to-commit 记录发起更新到 commit；Long Tasks API 记录主线程任务。JS heap 使用 `performance.memory` 记录场景 baseline、peak 和 end，未强制 GC，因此 peak delta 是分配 high-water，不等同于保留内存或泄漏。

10k/20k/50k fixture 均为精确字符数的确定性 rich Markdown，包含段落、代码、表格、数学和 citation。脱敏真实 trace 取自 `docs/handover/2026-05-17-deepseek-smoke.md` run 1487，只保留真实的 128 个 `text_delta` 和最终 174 字符形状，私有正文由固定本地文本替换。

## 浏览器结果

| 场景 | 字符 / 更新 | parse+render p95 / max | update→commit p95 / max | long task max / >100ms | heap peak delta |
|---|---:|---:|---:|---:|---:|
| 静态 rich Markdown | 10k / 1 | 49.8 / 49.8ms | 50.9 / 50.9ms | 50ms / 0 | 12.12MB |
| 静态 rich Markdown | 20k / 1 | 54.6 / 54.6ms | 56.2 / 56.2ms | 56ms / 0 | 14.39MB |
| 静态 rich Markdown | 50k / 1 | 118.1 / 118.1ms | 121.9 / 121.9ms | 121ms / 1 | 26.79MB |
| 脱敏真实累计 trace | 174 / 128 | 0.5 / 0.9ms | 1.0 / 1.4ms | 0 / 0 | 6.63MB |
| 持续未闭合 code fence | 20k / 128 | 10.8 / 11.7ms | 14.0 / 15.3ms | 0 / 0 | 43.76MB |
| 多个闭合 rich block | 20k / 128 | 36.4 / 42.4ms | 43.3 / 50.2ms | 0 / 0 | 50.69MB |

真实 trace 回放期间由 Playwright 向真实 textarea 输入 25 个字符：React controlled-input commit p95/max 为 `0.3/0.7ms`，Event Timing p95 为 `24ms`，低于本 ticket 采用的 p95 50ms / max 100ms 可感知门。

## 决策

保留当前全量 parse：

- 典型真实形状 trace 没有 renderer long task，输入响应明显低于门槛；
- 20k 未闭合 code fence 和多闭合 rich block 压力同样没有 long task；
- 追加 delta 不破坏已闭合 surface 的交互状态；
- 引入 animation-frame batching 会增加 failed/cancelled flush、succeeded 替换和测试复杂度，却没有当前数据收益。

50k 静态冷渲染的边界留作后续按真实产品数据观察。若未来真实回复经常达到该规模，应先用 production telemetry 复验，再单独评估稳定前缀缓存；仍不得按空行切 Markdown 或自研不完整增量 AST。

## 冻结边界

未修改：

- `runs/state.ts` 的 delta、terminal、restore、cancel；
- `useRunStream` / `useRunRecovery` 的 cursor 与 Run id 隔离；
- `ThinkingBlock`、reasoning preview 和显示条件；
- final、streaming、share 的入口结构和 `MarkdownProps`；
- SSE、服务端事实源、分享授权及后端契约。

## 验证

在 `frontend/` 下通过：

```bash
pnpm exec vitest run \
  src/messages/Markdown.test.tsx \
  src/messages/Markdown.streaming.test.tsx \
  src/messages/StreamingMessage.test.tsx \
  src/messages/ThinkingBlock.test.tsx \
  src/runs/state.test.ts \
  src/runs/useRunStream.test.tsx \
  src/runs/useRunRecovery.test.tsx
pnpm exec vitest run
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：

- ticket 指定冻结回归：`7 files / 116 tests`；
- 完整 Vitest：`72 files / 613 tests`；
- Playwright：desktop 视觉、mobile 视觉和 desktop 性能共 `3 passed`，mobile 性能项目因固定证据环境显式 `1 skipped`；
- typecheck、lint、production build 全部通过；
- production 主 JS `875.22 kB / gzip 268.09 kB`，相对 ticket 04 仅约 `+0.01 kB / gzip +0.01 kB`；syntax chunk 和 CSS 无变化。

## Ticket 06 注意事项

Ticket 06 应使用现有完整视觉页完成 final、streaming、share 三入口最终核对并在人工批准后固化 golden baseline。性能页是诊断与门禁证据，不属于待批准的视觉 golden；不要把 50k 压力画面加入常规截图基线。
