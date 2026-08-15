# 验证流式 prefix 与长回复性能

Type: performance

Status: completed

Blocked by: 03, 04

## What to build

在 rich surface 完成后验证累计 Markdown 的流式中间态和长回复成本。目标是在不修改 Run reducer、SSE cursor、服务端事实源或 reasoning 语义的前提下，确保每个增量 prefix 都可安全渲染，并用数据决定是否需要视图层 batching。

## Prefix matrix

为以下内容生成从空串到完成串的关键 prefix，而不是只测试最终结果：

- `*`、`**`、`~~` 强调/删除线；
- `[`、`[text](`、完整 link；
- opening fence、语言名、逐行 code、closing fence；
- 无序/有序/嵌套列表；
- table header、separator、rows；
- `\(` / `\[` 与 `$$` display math；
- citation marker 与普通方括号文本；
- blockquote 与中英文长段落。

## Performance method

- 准备 10k、20k、50k 字符的确定性 Markdown fixture，包含段落、代码、表格、math 和 citation。
- 使用一条脱敏的真实累计 delta trace，记录每次 parse/render/commit 的耗时分布、long task、内存和 Composer 输入响应。
- 分别记录最终静态渲染、典型流式、持续处于 code fence 和多个闭合 rich block 的结果。
- 首先保留当前全量 parse。只有实测出现超过 PRD 性能门或明显输入阻塞时，才在视图层按 animation frame/短时间窗合并展示更新；authoritative `draftText`、seq 和 reducer 仍逐事件更新。
- 不按空行切 Markdown，不自研增量 AST，不改变 closed block 的语义。

## Reasoning and Run invariants

- 不修改 `runs/state.ts` 的 delta、terminal、restore 或 cancel 行为。
- 不修改 `useRunStream`/`useRunRecovery` 的 cursor、Run id 隔离和成功重拉逻辑。
- 不修改 `ThinkingBlock` 的显示条件、展开状态或文案。
- 若增加视图层 buffer，失败/取消必须 flush 当前可见正文，succeeded 重拉不得重复或短暂清空消息。

## Acceptance criteria

- [x] prefix matrix 的每个阶段都不抛异常、不执行 raw HTML、不出现 KaTeX 红色半成品、不吞掉已完成的前缀正文。
- [x] 未闭合 code/table/link 完成后能进入与静态最终消息相同的 rich surface。
- [x] 10k/20k/50k 和真实 delta trace 的测试环境、输入、统计结果记录在 ticket Comments 或完成 handover 中。
- [x] 典型流式 trace 无超过 100ms 的 renderer long task，Composer 输入无可感知阻塞；若不满足，已实施并验证最小视图 batching。
- [x] 用户上滚、横向滚动代码/表格或复制时，后续 delta 不无故重置已闭合 block 的交互状态。
- [x] failed/cancelled partial、刷新恢复和 succeeded 物化替换保持既有行为。
- [x] reasoning 和 Run 相关既有测试没有被删除、跳过或弱化。

## Verification

```bash
cd frontend
pnpm exec vitest run \
  src/messages/Markdown.test.tsx \
  src/messages/StreamingMessage.test.tsx \
  src/messages/ThinkingBlock.test.tsx \
  src/runs/state.test.ts \
  src/runs/useRunStream.test.tsx \
  src/runs/useRunRecovery.test.tsx
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

性能结论必须来自真实浏览器；jsdom 用例只证明语义和状态，不作为 long-task 证据。

## Comments

- 2026-08-15：性能优化采用“先测量、后最小改动”；本 ticket 明确禁止借性能名义改 reducer 或自研不完整 Markdown parser。
- 2026-08-15：完成 14 组累计 prefix matrix（斜体、粗体、删除线、链接、fence、两类嵌套列表、表格、三类数学、citation/方括号、blockquote/中英文段落和危险 raw HTML），每组从空串推进到完成态；另固定 closed code/table 在追加 delta 后保持 DOM identity、复制状态和横向滚动位置。
- 2026-08-15：prefix red/green 发现并修复两处既有边界：未闭合 fenced code 内的 `$$` 不再被 streaming math clamp 截断；`\[...\]` 现在规范化为真正的 display flow fence，而非 inline KaTeX。
- 2026-08-15：性能环境为 Windows、Headless Chromium `151.0.7922.34`、`1440 × 900`、DPR 1、12 logical cores、Vite development React、reduced motion；Chromium 使用 `--enable-precise-memory-info`。Profiler 的 content-update duration 表示 Markdown parse + React render，update-to-commit 表示发起更新到 commit；Long Tasks API 记录主线程任务。JS heap 为无强制 GC 的场景内 high-water 数据，不解释为保留内存。
- 2026-08-15：确定性 rich Markdown 静态结果：10k parse/render `49.8ms`、commit `50.9ms`、long task max `50ms`、heap peak delta `12.12MB`；20k 为 `54.6ms` / `56.2ms` / `56ms` / `14.39MB`；50k 为 `118.1ms` / `121.9ms` / `121ms` / `26.79MB`。50k 单次静态冷渲染存在 1 个 >100ms long task，作为已知规模边界记录。
- 2026-08-15：脱敏真实 trace 复用 `docs/handover/2026-05-17-deepseek-smoke.md` run 1487 的真实形状（128 个 text delta、最终 174 字符），只替换私有正文。128 次 content update 的 parse/render p50/p95/max 为 `0.4/0.5/0.9ms`，commit p95/max 为 `1.0/1.4ms`，0 long task；25 次真实 textarea 输入 commit p95/max 为 `0.3/0.7ms`，Event Timing p95 为 `24ms`，heap peak delta `6.63MB`。
- 2026-08-15：20k 持续未闭合 code fence 的 parse/render p95/max 为 `10.8/11.7ms`、commit p95/max `14.0/15.3ms`；20k 多个闭合 rich block 为 `36.4/42.4ms`、`43.3/50.2ms`；两者均无 long task。浏览器还确认追加 delta 不重置上滚位置、code/table 横向滚动、复制成功态或节点 identity。
- 2026-08-15：PRD 的硬门针对典型累计流式 trace；该 trace 与两类 20k 流式压力均达标且 Composer 无可感知阻塞，因此保留当前全量 parse，不增加视图 batching。50k 单次静态冷渲染的边界不能由流式 batching 修复，也不足以授权增量 AST。
- 2026-08-15：验证通过：ticket 指定冻结回归 `7 files / 116 tests`；完整 Vitest `72 files / 613 tests`；Playwright visual `3 passed / 1 mobile performance project intentionally skipped`；typecheck、lint、production build 均通过。未修改 `runs/state.ts`、`useRunStream`、`useRunRecovery`、`ThinkingBlock` 或任何 SSE/recovery/reasoning 语义。
