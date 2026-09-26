# 头像领域模型、R2 配置与存储适配层

Type: task

Status: completed

Blocked by: None

## What to build

建立头像上传的后端基础：用户当前头像键、上传会话、删除补偿记录、配置项和可替换的 R2/CDN 适配接口。模型保持头像专用，不提前抽象通用文件领域。

上传会话需要表达 `pending / queued / processing / succeeded / failed / expired` 状态、有效期、lease、尝试次数、ETag、稳定错误代码和最终对象键。删除补偿需要分别跟踪 R2 删除和 CDN purge，直到两项均成功。

对象键由服务端生成随机 UUID，只保存相对对象键，不包含用户 ID、用户名、邮箱、原文件名或时间序列。开发与生产配置支持不同的私有临时 bucket 和公开成品 bucket。

## Acceptance criteria

- [x] 用户记录支持可空的当前头像对象键；既有用户迁移后保持无头像状态。
- [x] 上传会话能持久表达完整状态机、30 分钟有效期、排队/领取/完成时间、lease、尝试次数和稳定失败原因。
- [x] 删除补偿记录能独立表达 R2 删除与 CDN purge 的完成、失败和下次重试状态。
- [x] 临时键符合 `avatar-uploads/{random}.webp`，成品键符合 `avatars/{random}.webp`，且不包含任何用户身份信息。
- [x] 配置覆盖 bucket、R2 endpoint/account、API/worker 独立凭证、公开资源基址、Cloudflare zone/purge Token、TTL、lease、重试、限流和清理批量参数。
- [x] 对象存储、任务发布和 CDN purge 均有可替换接口及测试 fake；业务测试不直接依赖云 SDK。
- [x] 头像 URL 由公开资源基址和对象键统一生成，数据库不保存完整 URL。
- [x] 配置校验能阻止生产环境缺少关键 bucket、域名或凭证时静默启动错误链路。
- [x] 迁移、模型和配置测试通过；不引入通用 files/assets 表。

## Comments

（无）
