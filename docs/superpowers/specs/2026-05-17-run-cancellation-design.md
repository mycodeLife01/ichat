# Run Cancellation 设计

日期：2026-05-17

## 目标

实现 `POST /api/v1/runs/{run_id}/cancel`，让用户可以显式取消自己拥有的 run。HTTP 请求只表达取消意图，不直接拥有 provider stream 生命周期；worker 继续通过数据库中的 run 状态观察并完成取消收尾。

## 行为

- 请求必须使用当前认证体系。
- run 必须属于当前用户，并且所属 conversation 未软删除；否则返回 `404 Run not found`。
- `queued` run 还未被 worker claim，API 直接将其移动到 `cancelled`，写入 `run_cancelled` event，并清理 lease 字段。
- `started` 和 `streaming` run 已由 worker 执行，API 将状态改为 `cancelling`；worker heartbeat 发现后主动停止 provider stream，再写入 `run_cancelled` event 并将 run 置为 `cancelled`。
- `cancelling`、`succeeded`、`failed` 和 `cancelled` run 的取消请求是幂等操作，返回成功但不重复写 terminal event。
- 成功响应沿用命令接口格式：`{"data": {"status": "ok"}}`。

## 实现边界

- 不新增数据库迁移。
- 不修改 provider、worker 或 SSE 的现有生命周期逻辑。
- service 层负责 ownership 校验、行锁和状态转换；API handler 只负责依赖注入、提交事务和返回响应。
- 取消后仍保留已有 `text_delta` events；取消的 partial output 不物化为 assistant message。

## 验证

- service 测试覆盖 `queued` 直接取消、`streaming` 进入 `cancelling`、terminal 状态幂等，以及跨用户/软删除隔离。
- API 测试覆盖认证、ownership、响应 envelope、状态更新和 terminal event 写入规则。
