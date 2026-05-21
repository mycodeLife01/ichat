# DeepSeek reasoning_effort 设计

日期：2026-05-21

## 目标

在 DeepSeek 流式调用中支持思考强度控制参数 `reasoning_effort`。项目已有 `deepseek_thinking_enabled` 开关控制思考模式开/关，现在补充一个独立配置项控制思考强度，仅在思考模式开启时随请求发送。

## 背景

DeepSeek 文档（`deepseek_thinking.md`）说明：

- 思考模式开关由 `{"thinking": {"type": "enabled/disabled"}}` 控制（项目已实现）。
- 思考强度由 `reasoning_effort` 控制，文档化取值为 `high` / `max`。为兼容性，`low`、`medium` 会被服务端映射为 `high`，`xhigh` 映射为 `max`。
- 思考模式下普通请求默认 effort 为 `high`。
- `reasoning_effort` 只在思考模式下有意义。

## 行为

- 新增配置项 `deepseek_reasoning_effort`，可选，默认 `"high"`，与 DeepSeek 服务端默认一致。
- 启动时校验取值，规范化为小写，只接受 `{low, medium, high, xhigh, max}`，非法值（如拼写错误）在加载配置时即抛错。
- `DeepSeekProvider.stream()` 仅在 `deepseek_thinking_enabled` 为真时，向请求 payload 注入 `"reasoning_effort": <配置值>`；思考模式关闭时不发送该字段。
- `DeepSeekProvider.summarize()` 不受影响：它始终关闭思考模式，因此不发送 `reasoning_effort`。

## 实现边界

- 不新增数据库迁移。
- 配置项可选（带默认值），不加入 `ENV_KEYS` 必填集合、不要求 CI workflow 注入；仅在 `.env.example` 中以 `DEEPSEEK_REASONING_EFFORT=high` 形式记录作为文档。
- 不引入 `reasoning_content`（思维链返回内容）的解析与流式透传——本次仅发送 `reasoning_effort`，解析逻辑保持不变。
- 校验风格沿用 `app/core/config.py` 中 `log_level` 的 `field_validator` 模式。

## 涉及文件

- `app/core/config.py`：新增字段与校验器。
- `app/providers/deepseek.py`：`stream()` 条件注入 `reasoning_effort`。
- `.env.example`：在思考开关下方新增 `DEEPSEEK_REASONING_EFFORT=high`。
- `tests/core/test_config.py`、`tests/providers/test_deepseek_adapter.py`：补充测试。

## 验证

- 配置测试覆盖：环境变量解析、直接构造、`.env.example` 形状一致、非法取值被校验拒绝、大小写规范化。
- provider 适配器测试覆盖：思考模式开启时 payload 含 `reasoning_effort` 且取自配置值；思考模式关闭时 payload 不含 `reasoning_effort`。
- 回归命令：`pytest`、`ruff check app tests`、`mypy app`。
