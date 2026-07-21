Type: chore
Status: ready-for-human
Blocked by: 06

# 存量 delta 清理与配置删除

> **执行时机由项目所有者决定**：本 ticket 不进入 agent frontier、不阻碍本批次
> tickets 的完成判定。06 上线后随时可由所有者触发（触发时可改回
> `ready-for-agent` 交给 agent 执行）。清理前建议观察 Redis 内存曲线与降级日志，
> 但观察时长由所有者自行掌握。

## 目标

交付二上线后，清理 run_events 表中已无读路径的存量 delta 行，完成遗留收尾。

## 前置条件（硬性）

- ticket 06 已上线。
- 确认代码中不存在任何仍依赖 run_events delta 行的读路径（/state 与 SSE 均已
  改造为 checkpoint + Redis 路径）。

## 范围

1. 分批 `DELETE FROM run_events WHERE type IN ('text_delta','reasoning_delta')`
   （按 id 范围分批，避免长事务），完成后视表膨胀情况执行 VACUUM。
2. 若 run_events 的 type CHECK 约束仍含 delta 类型，评估是否收紧（保留亦可，
   写路径已不产生）。
3. 复查并删除交付一/二遗留的死代码：批窗口残留、共享 LISTEN 管理器、
   deepseek_parser、旧顶层包空壳（若 02 采用了 re-export 过渡）。

## 验收

- 清理脚本在 dev 库演练后于生产执行，记录删除行数与耗时。
- 清理后回归：历史会话加载、继续追问、`/state` 恢复均正常。
- `ruff` 死代码检查通过；grep 确认被删配置项无残留引用。

## Comments
