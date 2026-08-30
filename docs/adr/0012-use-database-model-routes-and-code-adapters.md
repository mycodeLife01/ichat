# 模型目录使用数据库路由与代码适配器

聊天模型、模型上游与模型路由以 PostgreSQL 为事实源。新 Run 在创建时选择一条启用路由并固化不含凭据的配置快照；上游凭据使用单一部署级密钥加密。模型、上游、路由、优先级、能力和 API key 的后续变更均由数据库事务完成，不要求修改环境变量或重启进程。

模型管理通过独立 Web 控制台和对应管理 API 暴露，暂不建立管理员账户或角色。API 只接受部署级模型管理访问密钥的专用 header，普通用户 JWT 不获得该权限，CLI 作为应急入口保留。该访问密钥只分发给 API 进程，浏览器仅在当前标签页会话中保存。

推理控制与推理输出是两个独立能力：`chat_models.thinking_levels` 表示用户能否调节思考强度，`model_routes.reasoning_outputs` 表示具体上游路径可能返回 `raw`、`summary` 中的哪些可见内容。Run 快照同时固化二者。该字段是能力声明，不是 transcript 过滤器；结构化输出由适配器结合网关 detail type 与明确的底层 format 语义归类并完整保存，无类型 plaintext 才按快照声明保守分类。不得按文本内容猜测类型：例如 OpenRouter 的 `reasoning.text` 通常是 raw，但 `format=google-gemini-v1` 承载的是 Gemini 对外提供的 thought summary，必须归为 summary。数据库只能选择代码定义的能力，不开放任意 provider wire 参数；管理服务必须按适配器支持矩阵验证路由配置和后续适配器变更。

DeepSeek 官方、OpenAI 官方和 OpenRouter 的请求、响应分类与历史回放差异由明确的代码适配器处理。Provider 输出统一归一化为带 `kind` 的 `ReasoningDelta` / `ReasoningBlock`。OpenRouter 等协议要求续传的签名、加密块和结构化 `reasoning_details` 作为 `ProviderContinuationBlock` 保存在既有 `run_provider_messages.blocks` 中，仅由所属适配器解释和原样回放；它不得暴露给用户 API、SSE、分享、模型管理或日志。

`run_provider_messages` 是一次 Run 全部模型调用和工具交互的完整事实记录。成功终态的 `messages.reasoning` 与 `messages.reasoning_summary` 分别只是全部 raw/summary block 的有序读取投影；失败或取消不物化 assistant message，但保留已完成调用和当前调用已产生的 partial transcript。

本期不在一次 Run 内自动切换上游，以保持行为、续传状态和归因稳定。故障切换通过路由优先级和启停原子完成，只影响随后创建的 Run。
