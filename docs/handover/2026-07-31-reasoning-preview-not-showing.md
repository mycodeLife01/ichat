# Handoff：思考摘要滚动展示——工具调用后 reasoning 仍未显示，继续分析

日期：2026-07-31
分支：`feat/adaption-openai`
交接原因：用户反馈问题**尚未解决**——带 web search 的运行中,`reasoning_delta` 事件已到达前端,但界面没有展示思考过程,直接输出正文。本会话做了一次修复(标签优先级),但用户在修复后仍认为问题未解决,需要下一个会话继续分析验证。

## 背景与目标

需求:前端在「思考中」闪烁文字的位置**实时滚动展示思维摘要**(最新小标题),与 ChatGPT 行为一致。数据链路(后端 `ReasoningDelta` → `reasoning_delta` SSE 事件 → 前端 reducer `draftReasoning` → `ThinkingBlock`)早已完整,改动全部在前端展示层。

## 已提交的 commit(本分支)

- `d39fe04 feat(agent): add OpenAI-compatible provider with model selection` — OpenAI 适配主体 + 模型选择器(含飞出菜单向上展开修复)。
- `0b8da1c fix(frontend): align message thread gutters with composer` — 消息区与 composer 对齐。

## 未提交的改动(工作区,均为前端)

- `frontend/src/messages/reasoningPreview.ts`(新增)+ 测试:提取最新完整 `**标题**`/`# 标题` 行;无标题时(DeepSeek 原始 CoT)退回最后一个非空行;未闭合标题保持上一个值。
- `frontend/src/messages/ThinkingBlock.tsx`:默认折叠;流式中折叠时头部显示滚动预览,无 reasoning 时退回「正在思考」;展开时头部回「正在思考」、body 显示全文。
- `frontend/src/messages/StreamingMessage.tsx`:头部优先级改为——工具**运行中**标签 > reasoning 滚动预览 > 工具结果标签(已找到 n 个来源)> 正在思考。
- 测试更新:`ThinkingBlock.test.tsx`、`StreamingMessage.test.tsx`、`AppShell.test.tsx`(滚动稳定用例改名并改为匹配头部按钮)。
- `.scratch/probe_openrouter_reasoning.py`、`.scratch/probe_repeat.py`:OpenRouter 探针脚本(勿提交)。

验证状态:全量前端测试 445+ 通过、typecheck/lint 通过。**但用户实测后仍报告问题未解决。**

## 关键事实(已实证,勿重复排查)

1. 环境:`OPENAI_BASE_URL=https://openrouter.ai/api/v1`,模型 `openai/gpt-5.6-luna`(密钥在 `.env`,勿外泄)。
2. OpenAI 系模型经 OpenRouter 只回传**推理摘要**(`delta.reasoning`,`reasoning_details` 标 `reasoning.summary`/`format: openai-responses-v1`),从不回传原始 CoT;摘要是上游**非确定性**生成的(同一请求 6 连跑仅 1 次有摘要),简单问题常整场无摘要——这是上游限制,无参数可强制。
3. 用户提供的完整 SSE trace(见对话)显示:tool_call 结束后 seq 10-226 有大量 `reasoning_delta`(含「**Answering on popularity**」「**Citing series popularity**」两段),随后 text_delta。当时前端没显示——本会话归因于 `toolState.status === "succeeded"` 的标签一直压住摘要预览,已改 `StreamingMessage.tsx` 优先级。

## 下一步排查方向(按优先级)

1. **先确认用户复现的场景与版本**:用户是否在改动后的 dev server 上重测?复现时是否带 web search?让用户描述看到的头部文字(「已找到 n 个来源」还是「正在思考」)——这能区分标签优先级问题是否真的修掉,还是另有一层。
2. **审查 reducer 对 tool 事件的处理**:`frontend/src/runs/state.ts`。已知 reasoning 只在 `draftText === ""` 时累积;需确认 `tool_call_started/succeeded` 事件是否会重置/绕过 `draftReasoning`,以及 `toolState` 何时被清空(可能从不清空直到 run 结束)。
3. **审查 SSE → reducer 的事件分发**:`frontend/src/runs/` 的 stream hook(`useRunStream` 一类)是否把 `reasoning_delta` 在存在 `toolState` 时丢弃或分支处理。
4. **用用户 trace 做集成级复现**:把该 trace 的事件序列喂进 AppShell 测试 harness(`frontend/src/test/apiFixtures.ts` 有 `reasoningDeltaEvent` fixture),断言 seq 10 后头部出现「Answering on popularity」——这是最能钉死问题的手段。
5. 若集成复现通过但真实浏览器不显示,查构建/HMR 缓存、以及断线恢复路径(`useRunRecovery.ts` 的 `draft_reasoning` 快照)。

## 相关文件速查

- 展示层:`frontend/src/messages/StreamingMessage.tsx`、`ThinkingBlock.tsx`、`reasoningPreview.ts`
- 状态:`frontend/src/runs/state.ts`、`useRunStream`/`useRunRecovery`
- 后端事件映射:`app/worker/executor.py:337`(ReasoningDelta → reasoning_delta)
- OpenAI 适配器:`app/agent/providers/openai.py`(`_reasoning_from_delta` 读 `delta.reasoning`/`reasoning_content`)

## 待办(问题解决后)

- 将本次全部前端未提交改动以 Conventional Commits 提交(可拆:feat 摘要滚动展示 + fix 标签优先级)。
- `.scratch/probe_*.py` 不提交。

## 建议调用的 skills

- `diagnosing-bugs`:本次交接的核心就是一个未解决的 bug,按其诊断循环走(复现 → 假设 → 验证)。
- `tdd`:用用户 trace 写失败的集成测试再修(上文方向 4)。
- `agent-browser`:需要在真实浏览器里驱动 dev server 复现流式渲染时使用。

## 注意事项(项目规则)

- 会话交流用中文;代码注释/docstring 用英文;`docs/` 中文。
- 直接在当前分支开发,不建 worktree;不主动进 plan mode。
- 前端包管理器是 pnpm;跑后端 pytest 前先停 worker(见 memory)。
