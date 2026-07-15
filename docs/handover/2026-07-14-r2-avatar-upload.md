# Cloudflare R2 用户头像上传（交接）

日期：2026-07-14  
需求来源：`.scratch/r2-avatar-upload/PRD.md`

## 概述

本期增加已验证邮箱用户的头像上传与替换能力。浏览器只把裁剪后的 `1024×1024` 静态 WebP 中间图直传到私有 R2 bucket；API 不转发图片字节。独立 `media-worker` 从私有 bucket 读取并按真实字节验证，再生成 `512×512 WebP` 成品写入公开 bucket。数据库切换成功前旧头像保持可见。

PostgreSQL 中的 `avatar_uploads` 与 `avatar_deletions` 是任务和补偿事实源；Redis/Celery 只负责唤醒。公开对象删除与 Cloudflare 按完整 URL purge 必须都成功，补偿记录才完成。

## 数据与状态

- `users.avatar_object_key`：当前公开头像的相对对象键；不保存完整 URL。
- `avatar_uploads`：`pending → queued → processing → succeeded | failed | expired`，包含当前资格、ETag、lease、尝试次数、稳定错误码和临时对象清理时间。
- `avatar_deletions`：分别记录 R2 删除和 CDN purge 完成时间，失败后指数退避。
- 临时键：`avatar-uploads/{随机 UUID}.webp`。
- 成品键：`avatars/{随机 UUID}.webp`。

对象键不包含用户 ID、用户名、邮箱、文件名或时间序列。头像 URL 统一由 `AVATAR_PUBLIC_BASE_URL + object_key` 构造。

## API

当前用户资源下新增：

- `POST /api/v1/auth/me/avatar-uploads`：请求体仅含 `size_bytes`；执行已登录、active、邮箱已验证、每用户/每 IP Redis 限流；返回 10 分钟预签名 PUT URL 与签名头。
- `POST /api/v1/auth/me/avatar-uploads/{upload_id}/confirm`：请求体仅含 R2 ETag；API HEAD 校验真实大小、`image/webp`、签名的声明大小和 ETag，事务提交为 `queued` 后尽力投递 media queue。
- `GET /api/v1/auth/me/avatar-uploads/{upload_id}`：仅所有者查询稳定状态、错误和成功头像 URL。

注册、登录、刷新、`GET/PATCH /auth/me` 的 user 数据增加可空 `avatar_url`。

## 前端流程

账号卡片执行以下步骤：

1. 本地限制 JPEG/PNG/静态 WebP、10 MiB、最小 `128×128`、最长边 8192、总像素 2000 万；动画 WebP 在上传前拒绝。
2. 自有 `AvatarCropper` 组件提供 1:1 拖动、触控 pointer 操作、缩放滑块和圆形预览。
3. Canvas 输出 `1024×1024`、质量 0.9、保留透明通道的 WebP，超过 2 MiB 拒绝。
4. 创建会话、直传 R2、读取 ETag、确认并轮询，成功后更新统一 auth user 状态。
5. 侧栏入口、UserMenu、账号卡片和退出确认框使用同一 `avatar_url`；加载失败回退昵称首字母。

不提供移除头像入口，不修改消息列表或公开分享页。

## Cloudflare 资源

开发与生产各自创建两个 bucket：

| 环境 | 私有临时 bucket | 公开成品 bucket |
|---|---|---|
| dev | `ichat-dev-avatar-uploads` | `ichat-dev-avatars` |
| prod | `ichat-prod-avatar-uploads` | `ichat-prod-avatars` |

公开 bucket 绑定独立资源域名；私有 bucket 不绑定公开域名。预签名 PUT 必须使用 R2 S3 API endpoint，不能把 hostname 换成公开自定义域名。

### 私有 bucket CORS

生产只允许 `https://chat.feslia.com`；开发只列出实际本地 Origin。Cloudflare Pages 预览域名默认不允许写生产 bucket。

```json
[
  {
    "AllowedOrigins": ["https://chat.feslia.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "x-amz-meta-declared-size"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

不得使用 Origin 通配符。浏览器必须能读取 `ETag`。

### 最小权限凭证

1. API R2 凭证：仅允许向私有临时 bucket 指定前缀执行签名 PUT 所需权限及 HEAD。
2. media worker R2 凭证：私有 bucket Get/Head/Delete；公开 bucket Put/Delete。
3. Cloudflare purge Token：仅目标 zone 的 Cache Purge 权限。

三类凭证分别分发，不提交仓库，不放入前端或普通 CI。

## 环境变量与部署

完整模板见 `.env.example`。`AVATAR_STORAGE_ENABLED=false` 时链路关闭；设为 `true` 后配置模型会强制检查 endpoint、两个 bucket、API/worker 两套凭证、公开资源基址、zone ID 和 purge Token。

变更变量后执行：

```bash
docker compose -f compose.prod.yml up -d --force-recreate api media-worker celery-beat
```

`media-worker` 只监听 `media` queue，图片解码/转码不会占用邮件 worker。`celery-beat` 仍必须单实例，每小时投递头像维护任务。

## 运维

```bash
# 查询用户当前头像和最近上传
psql -U ichat ichat -c "select id,email,avatar_object_key,is_active from users where lower(email)=lower('<EMAIL>');"
psql -U ichat ichat -c "select upload_id,status,is_current,attempt_count,error_code,created_at,completed_at from avatar_uploads where user_id=<USER_ID> order by id desc limit 20;"

# 查看删除/purge 积压及最老任务
psql -U ichat ichat -c "select count(*) as backlog,min(created_at) as oldest from avatar_deletions where completed_at is null;"
psql -U ichat ichat -c "select id,object_key,attempt_count,next_attempt_at,last_error from avatar_deletions where completed_at is null order by created_at limit 20;"

# 修复外部故障后立即重试补偿
psql -U ichat ichat -c "update avatar_deletions set next_attempt_at=now() where id=<ID> and completed_at is null;"
docker compose -f compose.prod.yml exec media-worker celery -A app.tasks.celery_app call app.tasks.media_tasks.maintain_avatars --queue media
```

人工下架应调用 `app.services.avatars.lifecycle.take_down_user_avatar` 所在的受控运维入口，确保清空用户当前键与创建删除/purge 补偿处于同一事务；禁止只手工清空数据库或只删 R2 对象。

## 真实 R2 smoke

普通 CI 使用 fake，不持有 Cloudflare Secret。上线前在开发资源执行：

1. 启用开发配置并迁移；创建已验证测试用户。
2. 浏览器创建上传会话，确认 PUT URL hostname 为 R2 S3 API endpoint。
3. 从允许的本地 Origin PUT，确认响应暴露 ETag；从未允许 Origin 验证 CORS 被拒绝。
4. 确认上传后观察 `pending → queued → processing → succeeded`；检查公开对象仅为 `512×512` 静态 WebP。
5. `curl -I` 公开 URL，确认 `Content-Type: image/webp`、一年期 immutable cache 和 `nosniff` 响应规则。
6. 替换头像，确认 URL 版本变化、旧对象进入补偿并在 R2 删除；保存旧 URL，确认 purge 后不可继续命中 CDN。
7. 注销专用测试账号，确认在途会话失效、当前键清空、公开对象删除且旧 URL 不可访问。
8. 删除所有 smoke 对象与测试记录。

## 回滚

1. 先设 `AVATAR_STORAGE_ENABLED=false` 并 force-recreate API，停止新会话。
2. 保持 `media-worker` 与 beat 运行，完成已有 queued/processing 和删除补偿；不要先撤销凭证。
3. 前端可回滚到字母头像，后端 `avatar_url` 可空字段保持向后兼容。
4. 确认私有临时对象与删除积压为零后，再停 media worker、撤销 R2/purge 凭证或删除开发资源。
5. 数据库迁移只在确认不再需要头像历史且对象已清理后降级。

## 验证命令

```bash
# 跑 pytest 前先停会抢占数据库任务的 worker
uv sync --all-groups
pytest
ruff check app tests
mypy app

pnpm --dir frontend exec vitest run
pnpm --dir frontend run lint
pnpm --dir frontend run typecheck
pnpm --dir frontend run build

docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
```
