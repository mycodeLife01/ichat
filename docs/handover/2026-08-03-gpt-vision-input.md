# GPT 图片输入交接与发布手册

## 状态与边界

本版本完成 GPT 安全图片输入的软件实现与普通 CI 门禁，但**尚未完成**真实 R2 权限、生产容量、`gpt-5-mini` 效果和灰度验收。真实资源操作属于 `.scratch/gpt-vision-input/issues/11-enable-vision-with-real-resources.md` 的人工步骤。在全部门禁留下可审计结果前，生产必须保持：

```env
OPENAI_VISION_MODELS=
```

清空白名单只关闭新视觉流量；不会删除 preview、改写 transcript 或停止文件生命周期任务。已有附件仍可展示和下载。

## 已实现合同

- 文件资产以 `model_input_kind=document|image|null` 描述安全模型输入表示。
- 图片 transcript 保存 `ImageBlock` 的稳定快照，不保存对象键、bucket、图片字节或预签名 URL。
- GPT 每次实际 Model Call 前批量解析裁剪后上下文中的全部图片；同一调用按文件身份去重，tool loop 和零输出重试都会重新签发 URL。
- resolver 校验资产生命周期、独立 preview 位置、WebP 媒体类型、哈希、尺寸、`image-v1` 和警告。任一图片失败时不调用 provider，也不降级为附件提示。
- DeepSeek 对越过业务层的图片块继续 fail-closed。
- 每张图片按模型配置预留 8,192 token；目标 turn 在创建消息和 Run 前完成接纳校验，历史只按完整 turn 裁剪。
- 当前有效分支派生 `none`、`vision_required`、`legacy_upgrade_required` 三态；四个创建 Run 入口使用同一候选分支规则。
- 公开分享仍只有附件占位；标题任务不读取图片 URL。

## 配置与凭证矩阵

必须使用独立的 preview 私有 bucket，且不能与 staging 或 canonical bucket 同名。五组凭证的最小权限如下：

| 进程/角色 | staging | canonical | preview |
|---|---|---|---|
| API upload | PUT、HEAD | 无 | 无 |
| API canonical download | 无 | GET/签名 | 无 |
| API preview read | 无 | 无 | GET/签名 |
| file-worker | 条件 GET、DELETE | PUT、DELETE、迁移读取 | PUT、DELETE、迁移写入 |
| LLM Worker preview read | 无 | 无 | GET/签名 |

关键环境变量：

```env
OPENAI_API_KEY=<secret>
OPENAI_MODELS=gpt-5-mini
OPENAI_VISION_MODELS=
OPENAI_IMAGE_TOKEN_RESERVE=8192

FILES_R2_ENDPOINT_URL=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
FILES_STAGING_BUCKET=ichat-prod-file-staging
FILES_CANONICAL_BUCKET=ichat-prod-files
FILES_PREVIEW_BUCKET=ichat-prod-file-previews

FILES_UPLOAD_ACCESS_KEY_ID=<upload-key>
FILES_UPLOAD_SECRET_ACCESS_KEY=<upload-secret>
FILES_WORKER_ACCESS_KEY_ID=<worker-key>
FILES_WORKER_SECRET_ACCESS_KEY=<worker-secret>
FILES_DOWNLOAD_ACCESS_KEY_ID=<download-key>
FILES_DOWNLOAD_SECRET_ACCESS_KEY=<download-secret>
FILES_PREVIEW_API_ACCESS_KEY_ID=<preview-api-key>
FILES_PREVIEW_API_SECRET_ACCESS_KEY=<preview-api-secret>
FILES_PREVIEW_LLM_ACCESS_KEY_ID=<preview-llm-key>
FILES_PREVIEW_LLM_SECRET_ACCESS_KEY=<preview-llm-secret>
```

API 和 LLM Worker 在视觉白名单非空但所需 key、endpoint、preview bucket 或 OpenAI key 缺失时拒绝启动。Compose 还会清空 LLM Worker 的 staging/canonical 配置及 upload、download、file-worker、preview API 凭证。

## 维护窗口与发布顺序

这是一次停机 schema 切换，不支持新旧后端或旧浏览器标签页混用。

1. 创建独立 preview bucket、五组最小权限凭证和精确 CORS；保持视觉白名单为空。
2. 备份 PostgreSQL，停止 API、LLM Worker、file-worker、Celery worker/beat；保留 PostgreSQL 和 Redis。
3. 发布同一提交的后端与前端，运行 `alembic upgrade head`；要求用户刷新旧标签页。
4. 启动 API、file-worker、Celery worker/beat 和 LLM Worker。此时新图片直接写 preview bucket，旧 preview 由 `maintain-files` 分批迁移。
5. 等待 backfill 剩余量为 0、每轮失败量为 0，并确认旧 canonical preview 删除补偿排空。
6. 完成下文自动化检查、权限反向测试、真实 R2/GPT smoke、日志审计和回滚演练。
7. 只有全部结果可审计时，才把 `OPENAI_VISION_MODELS` 改为 `gpt-5-mini`，同时 force-recreate API 与 LLM Worker。

开发和生产编排都必须先通过：

```bash
docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
```

## Backfill 门禁

`file-worker` 的周期任务 `app.tasks.file_tasks.maintain_files` 会幂等复制、校验、切换位置并创建旧对象删除补偿。不要手工改 `file_objects.storage_location`。

可用以下只读查询核对事实：

```sql
SELECT
  count(*) FILTER (
    WHERE fo.storage_location = 'canonical_private'
  ) AS preview_backfill_remaining,
  count(*) FILTER (
    WHERE fo.storage_location = 'canonical_private'
      AND (fo.size_bytes <= 0 OR fo.sha256 IS NULL OR length(fo.sha256) <> 64)
  ) AS preview_backfill_failed
FROM file_objects fo
JOIN files f ON f.id = fo.file_id
WHERE f.purpose = 'message_attachment'
  AND f.model_input_kind = 'image'
  AND fo.role = 'preview';
```

开启白名单的硬门槛是两个值都为 0；同时观察 `files_preview_backfill_remaining`、`files_preview_backfill_failed` 和未完成 `file_object_deletions`。若 remaining 长时间不下降，即使 failed 查询为 0，也应按迁移故障处理。

## 可观测性与日志审计

结构化日志提供以下安全指标：

- resolver：成功/失败率、耗时、图片数、稳定失败分类；
- 视觉 Run：provider/model、图片数、provider request ID、纯数值汇总 usage；
- 文件维护：preview backfill remaining/failed、删除补偿积压和最老积压时间。

建议告警：5 分钟 resolver 失败率超过 2%；任一永久快照错误突增；P95 resolver 超过 1 秒；backfill failed 非 0；remaining 连续 15 分钟不下降；删除补偿最老年龄超过两个维护周期。

日志、异常持久化和仪表严禁出现预签名 URL、`X-Amz-*` 查询参数、bucket、对象键、文件名、图片哈希、图片内容或完整 provider 请求。排障只使用内部 Run ID、稳定错误码、计数、耗时和聚合 usage。

## 真实资源 smoke（必须人工执行）

以下步骤尚未由本次代码任务执行：

1. 使用无敏感信息、带随机醒目标识的测试图；确认其 preview 是单帧去元数据 WebP。
2. 用 preview LLM 凭证对 preview 对象执行 GET/HEAD，应成功；对 canonical 原件执行 GET、对 preview 执行 PUT/DELETE，均应 `AccessDenied`。
3. 临时开启受控环境的 `gpt-5-mini` 白名单并 force-recreate API/Worker。
4. 发送纯图片，要求读出随机标识；第二轮不重新附图并追问图片细节。
5. 在测试环境缩短读取 TTL，等待旧 URL 过期后重新进入会话继续追问，确认新 Model Call 使用新许可。
6. 检查 R2 access log：LLM 角色只读取 preview bucket；检查应用日志不含上述禁止字段。
7. 记录延迟、resolver 失败率、provider usage 和回滚演练结果。任一项失败都恢复空白名单。

## 回滚与故障排查

回滚顺序固定：

1. 先清空 `OPENAI_VISION_MODELS`；
2. force-recreate API 与 LLM Worker，确认 capabilities 不再声明图片能力；
3. 排空已存在的 Run、上传、backfill 和删除补偿事实；
4. 保留 preview bucket、迁移后位置和 transcript，不回迁、不重写、不批量删除。

常见故障：

- 启动时报视觉配置缺失：核对当前进程对应的 preview 凭证和独立 bucket，不要把 file-worker key 注入 LLM Worker。
- `image_input_unavailable` 且不可重试：检查资产是否仍绑定、preview 行位置/哈希/尺寸/版本是否与 transcript 快照一致。
- 同码但发生零输出自动重试：检查 R2 签名与数据库瞬时故障；不要把 URL 或对象键写进工单。
- provider 无法拉取图片：核对 preview bucket 网络可达性、GET 权限和 TTL；重试必须观察到新的签名。
- legacy 会话返回 `LEGACY_IMAGE_CONTEXT`：从响应给出的最早消息锚点编辑或重新生成，不能直接普通切换模型。

## 自动化验收

```bash
pytest
ruff check .
mypy app

cd frontend
pnpm exec vitest run
pnpm run lint
pnpm run typecheck
pnpm run build
```

普通 CI 使用 fake provider/storage，不需要真实 R2、ClamAV 或 GPT 凭证。真实资源 smoke 结果必须单独留档，不能用普通 CI 通过替代。
