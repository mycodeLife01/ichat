# 思考面板统一为「固定取景窗」（2026-09-26）

## 背景

旧 `ThinkingBlock` 按模型类型分叉：raw 思维链（DeepSeek / GLM）流式时自动展开完整正文，
summary 模型（GPT / Gemini）只把小标题滚动进 header、正文隐藏。两种路径体验不一致，raw
长思考会把页面撑得很长。本次在 design 工作台比较了两个候选（A 固定取景窗、B 单行最新一句），
用户选定 A，并已实现到前端。审批记录：`design/approvals/2026-09-26-thinking-viewport.json`。

## 行为

所有模型共用一套状态：`mode = open ? "full" : streaming ? "preview" : "collapsed"`，挂在根节点
`data-thinking-mode` 上。

- **思考中**：默认显示取景窗（`.thinking-window`）。它是 `justify-content: flex-end` 的
  flex 列，`max-height: calc(1.6em * 4)`，≤760px 为 3 行，内容贴底跟随。溢出时才加
  `.is-overflowing` 顶部渐隐 mask。溢出判断用 `inner.offsetHeight > el.clientHeight + 1`，
  因为 scrollHeight 测不到起始边溢出。取景窗是 `aria-hidden` 的装饰性镜像，读屏跟随 header。
- 点击 header 在取景窗与完整过程之间切换。新的 delta 不会覆盖用户的选择，也没有额外按钮。
- **思考结束**（`streaming` 由 true 变 false，即正文开始）：`useLayoutEffect` 强制收起为「已思考」，
  之后点击只在收起与完整过程之间切换。结束后再显示取景窗只会重复一段任意的尾巴。
- **完整过程**（`.thinking-body.thinking-md`）按 Markdown 渲染（remark-gfm + remark-breaks）。
  摘要里独占一行、或粘在句末的 `**小标题**` 会被 `headlinesAsHeadings` 提升为 `####`；
  句中的加粗保持为加粗。样式在 `global.css` 的 `.thinking-md`。
- 取景窗用 `plainPreviewText`：去掉小标题（小标题已占用 header），并把空行压成单换行，
  节省可见行数。
- **Header 文案**：显式 `label` 优先（工具调用中的「正在搜索 …」「已找到 n 个来源」，
  优先级规则沿用 `StreamingMessage`）。否则流式时显示 `reasoningPreview` 的小标题或「正在思考」，
  结束后显示「已思考」。
- **交接**：`StreamingMessage` 传 `handoffKey={run.runId}`，`Message` 传
  `handoffKey={message.run_id}`。模块级 `handoffChoices` 只由真正流式过的 block 写入，
  由下一个以同一 key 挂载的非流式 block 消费（挂载后删除），因此条目不会跨越一次交接后残留，
  测试之间也不会互相污染。

`showStreamingPreview` 与 `autoExpandWhileStreaming` 两个 prop 已删除。

## 工具调用穿插

reducer 语义不变：reasoning delta 清空 toolState，toolState 事件把 phase 置为 `tool`。
工具调用期间 header 显示搜索状态，取景窗停留在最后的推理内容上。完整过程中不标注工具调用，
这是用户在 review「思考中 · 穿插工具调用」场景后的决定。

## Design 工作台

- 候选已提升为 current：`design/src/messages/ThinkingBlock.tsx` 与前端一致，候选 CSS 并入
  `design/src/styles/global.css`。`ThinkingPanel.tsx`、`thinking-viewport` / `thinking-ticker`
  proposal 和 `thinkingVariant` 已删除。
- 保留新增场景：`thinking-raw-long`、`thinking-summary-long`、`thinking-tool`。`ChatPage` 的
  脚本帧（`ScriptFrame`）可以在推理中插入工具帧。

## 验证

- `frontend`：`pnpm exec vitest run` 共 744 个测试通过；`typecheck`、`lint`、`build` 均通过。
- `frontend`：`pnpm test:visual` 中，assistant-rendering 在两个 project 下都通过。
  `sidebar-scroll` 失败为存量问题：干净工作区（stash 后）同样失败，与本次无关。
- win32 golden 截图 `assistant-rendering.visual.ts-snapshots` 需要在 Windows 上重新生成，
  因为展开态卡片改成了取景窗卡片。
- `design`：lint、typecheck、check:boundaries、test 均通过；test:visual 122 个通过，
  test:parity 56 个通过；catalog 共 44 个场景。
- **真实 Chrome 几何测量**：方法见 `docs/handover/2026-08-31-thinking-header-geometry-shift.md`，
  使用临时 fixture，测完已删除。
  - 覆盖 1440 与 390 两种宽度、summary 与 raw 两条路径，以及「不切换」和「长推理后切到完整过程」两种操作。
  - phase 时间线为 waiting → reasoning → 长 reasoning → tool running → tool succeeded → 恢复 reasoning → text。
  - `.thinking-label` 相对 `.thinking` 的 top 在所有步骤中恒为 4px。
  - 取景窗高度：桌面上限 89.6px（4 × 22.4），移动端上限 72px（3 × 24）。
  - 结束时均为 collapsed。

## 回滚

`ThinkingBlock.tsx`、`StreamingMessage.tsx`、`Message.tsx`、`global.css` 中的
`.thinking-window` / `.thinking-md` 规则，以及对应测试，一起还原即可。reducer 和 API 没有变化。
