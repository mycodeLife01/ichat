Type: refactor
Status: ready-for-agent
Blocked by: 02

# 标题生成迁移 Celery

## 目标

把标题生成从 run 收尾的内联 await 迁移为 Celery 任务，释放 executor 并发槽、
缩短 run 收尾时间、获得重试能力，并作为「后台任务归属判据」（ticket 01）的首个验证案例。

## 范围

1. 新任务模块（llm_tasks，与 email/media 任务并列）：任务
   `generate_conversation_title`，run 成功终态时 `apply_async` 投递。
2. 任务全程同步：DB 走既有 sync engine（psycopg，项目既定约定，禁止任务内
   asyncio.run 复用 async session）；LLM 调用走 Provider 的 sync 非流式路径（02 提供）。
3. 幂等保护沿用现状语义（仅首个成功 run + title IS NULL 条件更新），失败按 Celery
   重试策略处理（明确重试次数与退避，遵循 ticket 01 的三问）。
4. 配置复用同一套 Settings，不新增配置面。
5. 删除 worker 内的内联调用点及其传参链。

## 验收

- 存量测试更新为新路径后全绿（此处允许改测试——执行载体变更属于本 ticket 的
  声明行为，PR 中说明）。
- dev 环境手工验证：新对话首条回复成功后标题自动生成；人为让 provider 失败一次，
  验证任务重试。

## Comments
