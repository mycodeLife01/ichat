Type: feat
Status: ready-for-agent
Blocked by: 04

# Redis Stream 流式传输与降级

## 目标

流式 delta 从「逐批落 PG + pg_notify + SSE 回查」切换为「provider 每 chunk 立即
XADD Redis Stream + SSE 每连接 XREAD BLOCK」；PG 以 run_drafts checkpoint + 语义
事件兜底；Redis 故障优雅降级。SSE 对外契约逐字节冻结。独立交付（交付二）。

## 范围

1. **`RedisStreamSink`**：每 chunk 即时 XADD 到 `run:{internal_id}:events`
   （entry 携带 seq/type/payload）；`XADD MAXLEN ~ run_stream_maxlen`（初值 2048）；
   终态 EXPIRE `run_stream_ttl_seconds`（初值 600）+ 首写兜底 TTL
   `run_stream_orphan_ttl_seconds`（初值 24h）；XADD 失败＝丢弃该 delta 仅记警告
   （Q5，短超时如 200ms）。
2. **`PostgresEventSink` 瘦身**：只写语义事件（run_started/tool_call_*/run_
   succeeded/failed/cancelled，均携带 seq）；delta 不再落 run_events；批窗口机制
   及配置（worker_delta_batch_*）删除。语义事件经 `FanoutSink` 同时进 PG 与 Redis。
3. **`run_drafts` checkpoint**：Alembic 新表（run_id PK、seq、text、reasoning、
   updated_at），worker 侧 upsert 覆盖；触发＝3s 时间窗（主）/4KB 字符量（防御）
   先到先写 + 工具调用边界强制；run 终态删行；参数可配
   （draft_checkpoint_interval_seconds / draft_checkpoint_max_pending_chars）。
4. **SSE 端**：每连接独立 XREAD BLOCK（Q7）；重连 after_seq → XRANGE 补齐 → 转
   XREAD 跟随；Redis 不可用 → 降级为轮询 run_drafts checkpoint（粗粒度），恢复后
   新 run 回细粒度；共享 LISTEN 订阅管理器与 sse_fallback_interval_seconds 删除。
   事件格式与 id/event/data 帧结构逐字节不变（Q12）。
5. **`/state` 恢复端点**：改为 run_drafts checkpoint + Redis 增量拼装，响应 schema
   不变。
6. **部署配套**：确认复用的 Redis 实例 maxmemory-policy 为 noeviction；无新增
   compose 服务。
7. **回滚约定**：无双传输开关（Q13），退路为镜像回滚；PR 描述中注明单向门
   （回滚瞬间生成中的 run 其进行中内容不可恢复，终态不受影响）。

## 验收

- 功能场景（能自动化的写集成测试，其余入手工清单）：正常流、after_seq 断线重连
  补齐、流中取消、工具事件、多标签页同 run 订阅、**手动停 Redis 的降级演练**
  （对话完成、checkpoint 粗粒度可见、Redis 恢复后新 run 细粒度）。
- 性能：压测脚本 N=200 对比重构前基线——PG 连接占用与查询次数显著下降，首字节
  延迟不劣化。
- `pytest` / `ruff` / `mypy` 全绿；前端零改动、零部署配合。

## Comments
