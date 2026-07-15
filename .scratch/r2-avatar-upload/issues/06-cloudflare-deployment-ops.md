# Cloudflare 环境配置与部署运维文档

Type: task

Status: completed

Blocked by: 01

## What to build

为开发和生产环境建立可复现的 Cloudflare R2、CORS、自定义域名、最小权限凭证和媒体 worker 部署说明。本期通过 Dashboard 或 Wrangler 手工创建资源，不引入基础设施即代码。

文档必须覆盖资源命名、Secret 分发、环境变量、验证、回滚、常见故障和运维下架，不把生产凭证放进仓库或普通 CI。

## Acceptance criteria

- [x] 文档定义生产/开发各自的私有临时 bucket 和公开成品 bucket，并说明公开域名绑定。
- [x] 提供精确 CORS 配置：生产仅允许生产 SPA Origin，开发仅允许明确本地 Origin，PUT 所需请求头完整且暴露 ETag，不使用通配符。
- [x] 说明预签名 URL 使用 R2 S3 API 域名而非公开自定义域名。
- [x] 分别创建并记录 API R2、media worker R2、Cloudflare Cache Purge 三类最小权限凭证。
- [x] 环境变量模板覆盖 bucket、endpoint、资源基址、zone、TTL、限流、lease、重试和清理批量参数，但不含真实 Secret。
- [x] 部署拓扑增加独立 media worker/queue，并说明 force-recreate 等环境变量生效要求。
- [x] 提供开发 bucket 真实 smoke 步骤：签名 PUT、CORS、ETag、HEAD、处理、公开 GET、缓存、删除和按 URL purge。
- [x] 提供按用户查询和下架头像、重试补偿、检查积压、验证 CDN 旧 URL 失效的运维步骤。
- [x] 说明 Cloudflare Pages 预览默认不得上传到生产 bucket；普通 CI 使用 fake 且无 Cloudflare Secret。
- [x] 提供资源创建错误或上线失败时的回滚步骤，不要求 Terraform/Pulumi。

## Comments

（无）
