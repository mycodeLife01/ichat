# ADR 修订、真实 R2 验收与交接

Type: task

Status: ready-for-human

Blocked by: 04, 05, 06

## What to build

完成跨模块验收、Cloudflare 真实环境 smoke、账户注销 ADR 修订、领域/架构/部署文档同步和最终交接。

既有账户注销 ADR 规定停用时业务数据原样保留；本功能明确要求公开头像在注销时即时物理删除并 purge CDN。必须把该例外写入 ADR，而不是让实现静默偏离已接受决策。

## Acceptance criteria

- [x] 修订或新增 ADR，明确软停用继续保留会话、消息等业务数据，但公开头像是出于隐私和 CDN 可访问性的即时物理删除例外。
- [x] ADR 记录代价：运维恢复账户时头像不可恢复，用户需重新上传。
- [x] 架构、模块边界、部署和功能交接文档与最终实现一致，文档内容使用中文。
- [x] 后端全量测试、lint、类型检查通过；前端测试、lint、typecheck、生产构建通过。
- [ ] 使用开发 bucket 完成真实 R2 集成测试，验证预签名 PUT、精确 CORS、ETag、worker 处理、公开 GET、缓存、删除和按 URL purge。
- [ ] 使用真实浏览器和已验证测试账号完成选择、裁剪、上传、轮询、替换及多处头像同步 smoke。
- [ ] 验证未验证邮箱被阻止、原图超限提示、上传限流和处理失败回退。
- [ ] 使用专门测试账号验证注销使在途任务失效、当前头像清空、R2 对象删除且旧 CDN URL 不再可访问。
- [ ] 验证开发/生产资源隔离，普通 CI 未使用 Cloudflare Secret。
- [x] 交接文档记录配置、部署、监控信号、常见错误、积压排查、手工下架和回滚命令。
- [x] 更新 PRD ticket map 和 frontier；仅在全部实现及验收完成后将相关 ticket 标记 completed。

## Comments

- 2026-07-14：代码、迁移、fake 存储/API、图片转码、前端测试、全量后端/前端检查与本地 Compose 已通过。真实 R2、精确浏览器 CORS、公开域名缓存、按 URL purge 及注销旧 URL 失效需要开发 Cloudflare bucket/域名/最小权限凭证和专用测试账号，转为 `ready-for-human`。
