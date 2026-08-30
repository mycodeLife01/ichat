# Provider 续传状态按路由亲和性限定回放范围

`run_provider_messages` 继续保存不可变的完整 transcript，但构造目标 Run 的历史时，只对当前 Provider 续传阶段保留推理、续传块和工具交互。阶段由 `(adapter, upstream, 规范化 base_url, provider_model)` 相同的一段连续成功 Run 派生；遇到首个成功但亲和性不同或未知的 Run 即结束，失败或取消的 Run 不建立新阶段。阶段外的成功 Run 投影为精确用户输入与最终助手正文，缺失或无效快照也保守使用该可移植投影。

OpenRouter 新产生的 `reasoning_details.v2` 在不透明 payload 内携带由规范化 endpoint 与当前 model 生成的 replay key，适配器只向匹配请求回放；存量 v1 由历史投影保护并继续兼容读取。上游仍返回“加密续传来自其他模型”时，系统使用稳定错误 `openrouter_continuation_incompatible` 终止，不删除历史、不剥离后盲重试，也不把上游 endpoint 元数据写入错误消息。

## 考虑过的替代方案

- 删除或改写旧 transcript：会破坏事实源与审计/排障价值，且不能覆盖并发请求。
- 只按 `owner=openrouter` 回放：OpenRouter 是网关，不是加密状态的兼容域；Grok、Gemini、DeepSeek 等 endpoint 仍可能互不兼容。
- 只剥离 `reasoning.encrypted`：会破坏 `reasoning_details` 的完整顺序，也会遗留 DeepSeek `reasoning_content` 和工具协议历史。
- 切回旧路径时恢复切换前状态：中间成功模型已经形成新的对话阶段，复活旧不透明状态会把它错误接到非连续历史上。

## 后果

跨路径后仍保留用户输入、附件快照与最终回答，但不会把旧推理、工具调用或续传状态发给新路径；连续使用同一路径时继续完整回放。该决策不需要数据库迁移或数据清理，代价是快照缺失的旧 ENV Run 无法跨 Run 复用 provider 私有状态。
