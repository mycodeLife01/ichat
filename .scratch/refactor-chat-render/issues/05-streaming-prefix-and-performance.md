# 验证流式 prefix 与长回复性能

Type: performance

Status: ready-for-agent

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

- [ ] prefix matrix 的每个阶段都不抛异常、不执行 raw HTML、不出现 KaTeX 红色半成品、不吞掉已完成的前缀正文。
- [ ] 未闭合 code/table/link 完成后能进入与静态最终消息相同的 rich surface。
- [ ] 10k/20k/50k 和真实 delta trace 的测试环境、输入、统计结果记录在 ticket Comments 或完成 handover 中。
- [ ] 典型流式 trace 无超过 100ms 的 renderer long task，Composer 输入无可感知阻塞；若不满足，已实施并验证最小视图 batching。
- [ ] 用户上滚、横向滚动代码/表格或复制时，后续 delta 不无故重置已闭合 block 的交互状态。
- [ ] failed/cancelled partial、刷新恢复和 succeeded 物化替换保持既有行为。
- [ ] reasoning 和 Run 相关既有测试没有被删除、跳过或弱化。

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
