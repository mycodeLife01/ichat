Type: refactor
Status: ready-for-agent
Blocked by: 02

# 转写持久化 blocks 化（expand-contract）

## 目标

转写表（`run_provider_messages`，表名不改）从 OpenAI wire format 扁平列演进为
provider 中立的 blocks 格式，采用 expand-contract：新行只写新列，旧行读取时转换。

## 范围

1. **Alembic 迁移**：新增 `blocks` JSONB 列（nullable）。不做数据回填，不删旧列
   （contract 阶段待存量老化后另行处理）。
2. **写路径**：新转写行只写 `blocks`（role + blocks 序列化），旧扁平列置 NULL；
   一条消息 = 一行（一次 turn 的多个工具结果在同一行 blocks 数组内，Q3）。
3. **读路径**：`blocks IS NULL` 的旧行走读取时转换——wire format → blocks 的转换
   逻辑归 DeepSeek 适配器所有，不散在 transcript 服务层。
4. **代码词汇**：转写相关新函数一律用 transcript 词根（`load_transcript` 等），
   provider_message 词汇从代码中消失（ORM 类名/表名除外）。

## 验收

- 存量测试不改断言通过；`alembic upgrade head` 在 dev 顺利执行。
- 新增：新格式写读往返测试；旧 wire format 行读取时转换的新旧对照测试（构造含
  tool_calls/tool 消息的存量样例行，断言转换后 blocks 与语义等价）。
- 含存量对话的 dev 库上，历史会话继续追问（触发转写回放）行为正确。

## Comments
