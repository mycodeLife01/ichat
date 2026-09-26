# 媒体处理队列、状态机与任务恢复

Type: task

Status: completed

Blocked by: 01, 02

## What to build

增加独立 Celery media queue 和媒体 worker。worker 从私有 R2 下载裁剪后中间图，按真实字节验证静态 WebP、2 MiB 上限和精确 `1024×1024` 尺寸，去除元数据并保留透明通道，重新编码为 `512×512 WebP`、质量 82，再写入公开 bucket。

PostgreSQL 是任务事实源。worker 通过条件领取和 lease 驱动 `queued → processing → succeeded/failed`，Celery beat 负责重新投递滞留 queued 会话和恢复过期 processing lease。

## Acceptance criteria

- [x] 媒体任务使用独立 queue/worker，不与认证邮件任务共享执行队列。
- [x] worker 只处理数据库中仍有效、用户仍 active 的当前会话；执行前和数据库切换前均重新检查。
- [x] 输入必须按真实字节解码为静态 WebP，严格为 1024×1024 且不超过 2 MiB；动画、伪装、损坏和尺寸不符均永久失败。
- [x] 成品固定为 512×512 WebP、质量 82，去除元数据并保留透明通道。
- [x] 成品使用新的随机对象键，设置正确 Content-Type、安全响应元数据和一年期 immutable 缓存。
- [x] 只有公开对象写入成功后才条件更新用户当前头像键；条件失败时生成对象进入删除补偿。
- [x] 处理期间旧头像保持不变；失败不会清空或覆盖当前头像。
- [x] 暂时故障最多自动重试三次，采用指数退避和抖动；永久错误不重试。
- [x] 重复 Celery 消息、worker 重启和重复领取保持幂等，不会重复发布头像。
- [x] beat 可重新投递滞留 queued，并将过期 processing lease 恢复为可执行状态；达到尝试上限后稳定进入 failed。
- [x] 媒体 fixture 测试覆盖透明图片、静态图片、动画、伪装、损坏、超限、重试和失效会话竞态。

## Comments

（无）
