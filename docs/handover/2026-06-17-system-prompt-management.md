# 2026-06-17 System Prompt 管理与注入

## 背景

此前 system prompt 只有 `.env` 里的一句话 `DEFAULT_SYSTEM_PROMPT=You are a helpful assistant.`，注入逻辑散在 `app/worker/executor.py` 里临时字符串拼接。多段生产级 prompt 塞进环境变量难维护、不进版本库、无法 review/diff。同时发现 `runs.system_prompt_snapshot` 在建 run 时被写入，但 executor 执行时并不读它、而是用实时 settings 重新拼装——快照与真正发给模型的内容对不上。

## 方案

### Prompt 模块（`app/prompts/`）

- `base_system_prompt.md` — 生产级基础 prompt 正文，版本化、可 review/diff。身份为 iChat，跟随用户语言回复，含诚实性、推理与语气、Markdown/LaTeX 格式、安全拒答、身份口径等段落。正文为英文（遵循"代码注释/prompt 用英文"的项目约定）。
- `builder.py` — 装配逻辑：
  - `bundled_base_prompt()`：`@lru_cache` 读入上面的 `.md`。
  - `build_system_prompt(*, settings, web_search_enabled, now)`：组装最终 system prompt，是注入的**唯一入口**。
- `__init__.py` 导出 `build_system_prompt`、`bundled_base_prompt`。

### 注入与组合顺序

`build_system_prompt` 按固定顺序拼装：

1. **base**：`settings.default_system_prompt` 非空时用它作为覆盖，否则用 `bundled_base_prompt()`。
2. **动态块（仅当 `web_search_enabled`）**：追加 `\n\n` + `Today's date is YYYY-MM-DD (UTC). ` + web_search 使用与引用指引（`[1]` 行内引用、禁用 `[^1]` 脚注——对应前端 citation chip 渲染）。

非联网 run 不注入日期与 web_search 段落，行为与改造前一致。

### 配置覆盖语义

`app/core/config.py` 中 `default_system_prompt` 改为可选（默认 `""`）：
- 留空 → 用代码内 bundled prompt（生产默认）。
- 非空 → 作为 base 覆盖，供运维在不改代码的情况下临时调整。

`.env.example` 的 `DEFAULT_SYSTEM_PROMPT` 已留空并加注释。CI / 测试仍设 `"Be helpful."`，因此走覆盖分支，既有断言不受影响。

### 快照一致性修复

`system_prompt_snapshot` 改由 **executor 在执行时写入**：worker 用 `build_system_prompt(...)` 装配出最终 prompt，先 `run.system_prompt_snapshot = system_prompt` 再 `build_context`，随后随同一事务 commit。executor 是唯一掌握运行时真实信息（工具是否注册、当前日期）的地方，因此快照能忠实记录真正发给模型的内容。

API 三个建 run 路由（send / edit-and-regenerate / regenerate）与 smoke 脚本不再预写快照；新建（queued）状态的 run 此时 `system_prompt_snapshot` 为 `NULL`，执行后才被写入。该字段目前只写不读、无前端/回放依赖，改动安全。

## 如何修改 prompt

- 调整正文 → 编辑 `app/prompts/base_system_prompt.md`（普通文本，随代码部署）。
- 临时覆盖（不改代码）→ 设服务器 `.env` 的 `DEFAULT_SYSTEM_PROMPT`，重建容器使其生效。
- 调整 web_search 指引或动态块 → 改 `app/prompts/builder.py`。

## 关键文件

- `app/prompts/base_system_prompt.md`、`app/prompts/builder.py`、`app/prompts/__init__.py`
- `app/core/config.py`（`default_system_prompt` 默认值）
- `app/worker/executor.py`（调用 `build_system_prompt` + 写快照）
- `app/api/v1/conversations.py`、`scripts/web_search_worker_smoke.py`（去除预写快照）

## 验证

```bash
uv run pytest tests/prompts tests/worker tests/api/test_conversations.py tests/context tests/core -q
uv run ruff check app tests scripts
uv run mypy app
```

全绿。`tests/prompts/test_builder.py` 覆盖：无覆盖时用 bundled、覆盖替换 base、联网时追加日期与指引、非联网时不含日期与指引。
