Type: bug
Status: backlog
Blocked by: none

# 多 model call run 的 usage 少计

## 现象

一个 run 若经历多次 model call（工具循环：model call → 工具 → 再 model call），
最终写入 `runs.usage_metadata` 的只有**最后一次** model call 的 usage；此前各次
model call 的 prompt/completion tokens 未被累加。`AgentFinal` 取最后一次 model call
的 usage，worker 原样落库。

## 背景

这是 issue 04（AgentRunner）既有行为，04b 再分层时所有者裁决**保持原口径**、不在
04b 修（见 `.scratch/agent-runtime-refactor/issues/04b-agent-layering.md` 与
`docs/handover/2026-07-20-agent-runtime-refactor-04b-decisions.md`）。本票单独记录，
待有计量/计费需求时再定口径。

## 影响

- 只影响启用 web search（会触发多轮 model call）的 run 的 usage 统计精度。
- 不影响对话正确性、SSE 契约、transcript 落库。

## 可能的修法（待定）

- 编排层在 `ChatAgent.stream()` 内累加每次 `ModelCallResult.usage`，由 `AgentFinal`
  交付合计值；worker 无需改动。需先定义「合计」语义（prompt_tokens 是否重复计入
  被 KV cache 命中的历史部分）。

## Comments

- 2026-07-20：由 04b 实施收尾补建（handover「已知限制单列」条目）。
