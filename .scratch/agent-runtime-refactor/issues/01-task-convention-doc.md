Type: docs
Status: completed
Blocked by: None

# 后台任务约定明文化

## 目标

把项目已在实践、但从未成文的后台任务模式写入 `docs/`，终结"新任务归谁执行"的逐案争论。

## 内容要求

1. **统一模式**：所有后台任务遵循「事务性状态行（PG 为事实源）+ 唤醒信号（仅加速器，
   丢失可由 sweep/poll 兜底）+ 幂等 claim」。现有两条链路（LLM run 的 runs 表 +
   pg_notify；邮件的 email_outbox + beat sweep）都是该模式的实例，文档中对照说明。
2. **归属判据**：流式、交互、需中途取消的任务 → 自研 async 运行时；有限时长、非流式、
   fire-and-forget 可重试的任务 → Celery。判据看任务形状，不看是否调用 LLM。
3. **反例说明**：为什么流式 LLM run 不进 Celery（协作式取消 vs revoke、租约心跳精度、
   事务性入队、asyncio 并发模型 vs prefork、长任务与 visibility timeout 互斥）。
4. 每类任务表必须回答的三个问题：重试几次、退避多少、死了落到哪。

## 验收

- 文档落在 `docs/` 适当位置（中文），并在 `docs/README.md` 索引与 `CLAUDE.md`
  相关小节挂链接。
- 内容与 PRD「架构要点/邮件栈先例对齐」一节一致。

## Comments

- 2026-07-17 完成（commit `06f1784`）。文档落在 `docs/architecture/background-tasks.md`，已挂入 `docs/README.md` 索引与 `CLAUDE.md` 架构小节。
