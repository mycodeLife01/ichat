# DeepSeek 视觉路由：视觉能力归位到聊天模型

## 结果

`deepseek` 适配器不再声明「不支持图像输入」。视觉能力现在只由 `chat_models.supports_image_input`
决定，与 provider 无关：同一个 `deepseek` 上游既可以承载纯文本模型（`deepseek-v4-flash`），也可以
承载视觉模型（`deepseek-v4-flash-vision-exp`）。管理页原有的视觉开关与 `image_token_reserve`
即完整控制面，不需要新的管理入口，也不需要新的适配器代码。

## 问题：能力判定有两份来源

重构前有六处把「DeepSeek 不能收图」当成事实写死：

| 层 | 位置 | 行为 |
|---|---|---|
| kernel | `deepseek.py` 的 `_CAPABILITIES.supports_image_input=False` | Provider 级能力为假 |
| kernel | `openai_compat._resolve_image_inputs` | 能力为假时抛 `<provider>_image_input_not_supported` |
| service | `service._database_chat_models` | 视觉模型 + deepseek 路由 → **静默剔除**（模型在 capabilities 里消失，无错误提示） |
| 管理 | `management.upsert_chat_model` / `upsert_model_upstream` | 拒绝「在已有 DeepSeek 路由的模型上开启视觉」 |
| 管理 | `management.upsert_model_route` / `set_chat_model_enabled` / `set_model_upstream_enabled` / `set_model_route_enabled` | 拒绝启用视觉模型与 DeepSeek 路由的组合 |
| 管理 | `management._validate_active_routes` | 激活数据库目录时再拦一次 |

其中 `_database_chat_models` 那处最隐蔽：管理员在页面上成功声明了视觉能力，模型却在目录里直接
消失，报错信息为空。这违反了 ADR 0006 的约定 —— 视觉白名单是**模型级**声明，前端也只读
`supports_image_input`，从不按 provider 名称推断。adapter 再保留一份判定，等于给同一事实造了
第二个事实来源，而模型粒度比适配器粒度更细，两者必然分叉。

## 修复

删除适配器侧的视觉能力，不做任何新增能力：

- `ProviderCapabilities.supports_image_input` 字段整体移除（`provider.py`），三个适配器的构造同步。
- `_resolve_image_inputs` 去掉 `supports_image_input` / `provider_name` 参数与对应分支
  （`openai_compat.py`）。该方法现在只负责「把快照解析成签名 URL」，不再做能力判定。
- `_database_chat_models` 移除 deepseek 视觉剔除（`service.py`）。
- `management.py` 移除全部 DeepSeek 视觉拦截，`_validate_active_routes` 因此不再需要 `ChatModel`
  列，改为只查 `(ModelRoute, ModelUpstream)`。

**没有新增 wire 编码代码**：`messages_to_wire` 早已按标准 OpenAI 多模态格式构造
`{"type": "image_url", "image_url": {"url": ..., "detail": "high"}}`，并在图片两侧包裹
`[BEGIN/END UNTRUSTED IMAGE ATTACHMENT]` 边界。DeepSeek 视觉模型的请求格式与之一致，所以视觉
模型只需把请求放行到既有编码路径。

## 现在的执行链

1. 创建/编辑聊天模型时勾选视觉能力，必须同时给出正数 `image_token_reserve`；仍会校验 preview
   运行时凭据（`_validate_vision_runtime`）不变。
2. `ChatModel.supports_image_input` 进入 Run 的 `model_config_snapshot`（v2），排队期间不受后续
   目录编辑影响。
3. Worker 组装 `ChatAgent` 时，`build_chat_agent` 用该标记判定：历史含 `ImageBlock` 且模型未声明
   视觉 → 抛 `<provider>_image_input_not_supported`，**在模型调用前失败**。
4. API 侧接纳图片、会话切换模型时的 `VISION_MODEL_REQUIRED` 约束（ADR 0006）同样读该标记，行为不变。
5. 适配器只负责把已解析的签名 URL 编码进 wire；签名失败仍以 `image_input_unavailable` 失败，不降级。

也就是说，能力判定只剩一处（模型目录），失败点依旧在发起模型请求之前，没有把错误推迟到上游。

## 配置提示

`image_token_reserve` 是上下文预留量，不是计费项。DeepSeek 视觉模型的单图计费上限约为 384
tokens，若沿用 OpenAI 路径的 8192 会让单图预留偏保守（不影响正确性，只影响可用上下文）。按
实际模型设置即可。

## 上线

1. 模型管理页新建（或复用）DeepSeek 上游，确认 `adapter=deepseek`、endpoint 与 API key 可用。
2. 新建聊天模型并勾选视觉能力，`image_token_reserve` 设为该模型的实际预留量；或为既有模型开启。
3. 为该模型添加路由，`upstream_model` 指向真实的视觉模型 id。
4. **必须先用真实上游做图片 smoke**：发送一张图片，确认返回内容确实描述了图片，而不是拒绝或
   假装理解。OpenRouter/OpenAI 路由同理，不能只因「兼容 OpenAI」就假定支持视觉。
5. 回滚：在管理页取消勾选视觉能力即可，Run 快照机制保证已排队的 Run 仍按当时声明执行。

## 验证

```bash
uv run ruff check app tests
uv run mypy app
uv run pytest tests/agent tests/services/model_catalog tests/services/agents -q
```

结果：ruff 通过；mypy 检查 145 个源文件通过；上述定向套件 128 个通过。改动后完整后端套件
773 个通过、1 个失败（`test_capabilities_endpoint_is_public_and_hides_provider_name`，因本地
`.env` 的 `CONVERSATION_SEARCH_ENABLED=true` 泄漏进未 pin 该开关的测试；已在未改动的基线上复现，
与本次改动无关）、8 个 ERROR（`test_search*.py`，本地 `DATABASE_URL` 指向未运行的实例，同样在
基线上复现）。

新增/改写的回归覆盖：

- `tests/agent/test_deepseek_adapter.py::test_image_input_reaches_deepseek_as_openai_image_url`
  —— 取代原先断言「fail closed」的用例，断言签名 URL 以 `image_url` 抵达 DeepSeek，且 resolver
  收到 `file-1`。
- `tests/services/model_catalog/test_model_catalog_service.py::test_deepseek_route_serves_a_vision_model_declared_by_the_catalog`
  —— 断言声明视觉的 DeepSeek 路由会出现在 `available_chat_models` 且保留 `supports_image_input`
  与 `image_token_reserve`。

`ProviderCapabilities` 的断言（`tests/agent/test_fake.py`）在字段移除后自动收紧，无需为视觉单列
用例。

## 未覆盖

真实 DeepSeek 视觉 API 未在本机联网验证：本机没有可用凭据，且该模型为 `-exp` 实验版本。上线前
的真实图片 smoke 仍是必需项，本文档不替代它。
