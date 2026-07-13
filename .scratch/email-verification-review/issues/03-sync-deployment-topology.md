# 让自动部署同步邮箱服务运行拓扑

Type: task

Status: completed

Blocked by: None

## What to build

主分支部署使用与当前提交一致的生产 Compose 和 nginx 定义，使 Redis、Celery worker、Celery beat 及真实客户端 IP 配置随应用版本一起发布。

## Acceptance criteria

- [x] 部署执行任何 Compose 命令前，服务器已取得触发部署提交对应的部署定义。
- [x] 部署会拉取镜像、执行迁移，并启动或更新 Redis、API、LLM worker、Celery worker、Celery beat 和 nginx。
- [x] 部署后的 nginx 使用仓库中受信任的 Cloudflare real-IP 配置，不继续沿用服务器上的旧配置。
- [x] 部署失败时返回非零状态，不能在同步部署定义失败后继续使用旧拓扑发布。
- [x] 自动化检查能够证明部署定义同步发生在 Compose 操作之前，并校验生产 Compose 配置有效。

## Comments

2026-07-12：实现与验收完成。部署 workflow 在远端 Compose 命令前检出并上传当前提交的 `compose.prod.yml` 与 `deploy/nginx.conf`，远端脚本使用 `set -eu`，执行完整拓扑的 pull、迁移、`up -d --remove-orphans`，并强制重建 nginx。自动化部署顺序测试和生产 Compose 解析校验均通过。
