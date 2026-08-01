# 统一文件上传与消息附件（交接）

日期：2026-08-01
需求来源：`.scratch/file-upload/PRD.md`（tickets 01–14）
相关决策：[ADR 0002](../adr/0002-unify-file-assets-and-avatar-uploads.md)、[账户软停用 ADR](../adr/2026-07-13-account-deletion-soft-deactivation.md)
相关历史交接：[头像直传](2026-07-14-r2-avatar-upload.md)、[账户注销](2026-07-13-password-reset-account-deletion.md)

## 状态与边界

本次实现把消息附件纳入统一的 `files` 深模块，并将新头像写入、文件删除补偿和生命周期逐步迁入同一领域。它不是一个面向用户的文件库：文件资产只能成为当前头像或消息附件，不能跨用途、跨无关消息自由复用。

本交接记录的是仓库的代码与部署设计；**不代表真实 R2、ClamAV、生产凭证隔离、容量目标或 CDN purge 已完成生产验收**。上线前必须执行本文的开发资源 smoke 与监控/权限检查。普通 CI 只能使用 fake adapter，不能携带生产对象存储、Cloudflare 或 ClamAV 凭证。

ticket 15 的 contract 阶段尚未满足前置条件，故意保留旧头像 object-key、旧状态表/任务和双读回退以排空历史事实。只有在完成生产映射核对、旧积压归零、历史保留窗口和 ticket 14 灰度验证后，才能删除这些兼容路径；不能把本交接当成删表或撤销旧 bucket 的授权。

## 领域模型与不变量

`app/models/files.py` 是统一文件持久化的拥有者。其职责和关系如下：

| 模型 | 事实 | 关键约束 |
|---|---|---|
| `FileUpload`（`file_uploads`） | 一次有期限、可重试的上传流程 | 随机 public ID、固定 `purpose`、确认 ETag、lease、尝试数、输出 manifest、成功 file ID；不是永久聊天历史 |
| `FileAsset`（`files`） | 已处理成功的不可变逻辑文件 | 固定所有者与用途，保存原始安全文件名、真实媒体类型、原件大小、SHA-256、warning、提取器版本、派生文本及生命周期字段 |
| `FileObject`（`file_objects`） | 资产在 R2 的物理表示 | role 与 storage location 显式建模；对象没有独立业务所有权 |
| `MessageAttachment`（`message_attachments`） | Message 与消息附件资产的显式关系 | 固定选择顺序与安全展示/分享元数据；被回收的资产可以置空外键，历史消息元数据仍保留 |
| `FileQuota`（`file_quotas`） | 每用户附件配额事实行 | `used_bytes` 与 `reserved_bytes` 必须在同一事务内改变；周期 reconciliation 只修复漂移 |
| `FileObjectDeletion`（`file_object_deletions`） | 正式对象删除的持久补偿 | 独立于业务关系生存，记录对象删除、CDN purge、重试时间、错误摘要和完成时间 |

用途是创建上传时固定、不可变的枚举：

- `message_attachment`：私有 staging/canonical R2 对象；成功资产保存原件和所需派生物，计入 1 GiB 附件配额。
- `avatar`：公开头像成品；只保留 `avatar_512` 静态 WebP，不保留原件或中间图，不计入消息附件配额。

同一字节在两个用途下也必须产生不同逻辑资产。`users.avatar_file_id` 是新当前头像引用；`message_attachments` 是消息引用。不得引入 `entity_type/entity_id` 式多态关联，也不得让私有附件改作公开头像。

## 上传、处理与删除状态机

消息附件状态机为：

```text
pending ──confirm──► queued ──claim──► processing ──► succeeded
   │                    │                   │             │
   ├── TTL ─► expired   │                   ├─ permanent ─► rejected
   └── cancel ─► cancelled ◄── cancel ──────┴─ temporary ─► queued
                                                    (30s / 5m；第 3 次失败)
                                                                  │
                                                                  └─► failed
```

- `pending` 会话 30 分钟后 `expired`；`pending`、`queued`、`processing` 都可被显式取消或账户停用取消。
- create 在锁住 `FileQuota` 行后预留声明大小；失败、取消、过期释放 reservation；成功按验证后的原件大小转入 used。
- confirm 对 staging 对象执行 HEAD，核对声明大小、`x-amz-meta-declared-size`、内容类型和 ETag；首次成功确认的 ETag 不可替换，重复 confirm 幂等。
- worker 用确认 ETag 执行 `If-Match` 条件读取，再核对长度、计算 SHA-256、扫描和解析。ETag 不是长期内容哈希。
- worker 在写 canonical 对象前持久化 output manifest。任何取消、崩溃、最终提交失败或 lease 恢复都可据此创建删除补偿，不能通过 bucket 全量扫描猜测孤儿对象。
- 处理尝试最多三次；暂时故障按 30 秒、5 分钟重投，第三次耗尽进入 `failed`。策略、安全、格式和资源上限错误进入 `rejected`，不会反复重试。`available_at` 是 PG 事实，Celery countdown 只作加速。

`FileObjectDeletion` 的处理也幂等：私有 canonical 对象只需 R2 delete；公开头像必须 R2 delete 与完整 URL 的 Cloudflare CDN purge 都成功。404 视作完成该外部步骤；任一分步失败只重试未完成步骤。删除补偿没有依赖仍存在的 `FileObject` 或业务行，避免级联删除后丢失外部副作用。

## API 契约摘要

普通附件入口固定为 `/api/v1/files`，客户端不能传 `purpose`：

| 路径 | 行为 |
|---|---|
| `POST /uploads` | 创建 `message_attachment` 上传会话；返回 upload ID、短期 PUT URL、签名头与到期时间。 |
| `POST /uploads/{upload_id}/confirm` | 以客户端读到的 ETag 确认 staging 对象，提交 queued 状态。 |
| `GET /uploads/{upload_id}` / `POST /uploads/status` | 查询单个或批量上传离散状态；批量接口供前端合并轮询。 |
| `DELETE /uploads/{upload_id}` | 显式取消；浏览器关闭或刷新不等价于此操作。 |
| `POST /{file_id}/read-url` | 在鉴权与可见性检查后签发 `preview` 或 `download` 的短期 URL。 |

`POST /conversations/with-message` 和 `POST /conversations/{conversation_id}/messages` 接收有序 `attachment_ids`；响应中的 message 附带稳定附件元数据。编辑/重新生成沿用既有会话路径，分别实现“省略继承 / 显式替换（含空列表）”与固定复用。`GET /conversations/deleted`、`POST /conversations/{conversation_id}/restore` 支持 30 天会话恢复期。创建公开分享时，含附件会话必须传递附件隐私确认。

## 文件格式、安全边界与模型输入

允许的精确扩展名为 `jpg/jpeg/png/webp/pdf/docx/pptx/xlsx/txt/md/csv/json/yaml/yml/py/js/ts/go/java/sql`。浏览器 MIME 只用于初筛；worker 必须验证真实字节和扩展名匹配，OOXML 还必须验证内部类型。

| 类别 | 限制与输出 |
|---|---|
| 图片 | JPG/PNG/静态 WebP，最大 10 MiB、最长边 8192、最多 2,000 万像素；完整解码，保留私有原件并生成去元数据安全预览。动画 WebP 拒绝。图片只生成 `AttachmentNoticeBlock`，本期不做视觉理解。 |
| PDF | 最大 25 MiB、最多 200 页；只提取可选择文本，不 OCR、渲染页面、执行脚本或读取附件。完全无可提取文本时拒绝；可读部分会带稳定 warning。 |
| DOCX/PPTX/XLSX | 单文件最大 20 MiB；解压后最多 100 MiB、10,000 entries，拒绝路径穿越、嵌套压缩和异常压缩比。只读可见主体：隐藏工作表/行列/幻灯片、备注、批注、已删除修订、动作和文档属性不会进入模型。XLSX 不执行公式、不访问外部连接。 |
| 文本、数据、源码 | 单文件最大 2 MiB，严格 UTF-8/UTF-8 BOM，无 NUL；派生文本去 BOM、换行规范化为 LF，原件不变。无效 JSON/YAML/CSV/源码仍可作为低信任文本进入模型。CSV 最多 100,000 行、每行最多 256 列。 |

所有原件在解析前经过 ClamAV/clamd。恶意签名命中是永久拒绝；扫描器不可用或签名超过配置年龄时 fail-closed，并作为可重试基础设施故障。解析在受时间与资源限制、无应用凭据的外部进程中进行：解析 wall-clock 上限 120 秒，Celery soft/hard 上限由整次尝试配置（默认 180 秒）派生；父任务异常会终止解析进程组，Linux hard-kill 由 parent-death signal 兜底。lease 为 5 分钟且不作持续 heartbeat。

文档型附件成为完整 `DocumentBlock`：包含文件身份、完整派生文本、SHA-256、提取器版本、warning 和摘要元数据。它们始终是低信任用户数据，不获得 system/developer 指令优先级。图片是仅展示附件，模型只收到安全文件名、类型和「当前无法读取图片内容」的 `AttachmentNoticeBlock`；不含字节、URL、OCR 或视觉描述。

不会把原件上传到 provider Files API。provider adapter 只投影中立内容块，DocumentBlock 的完整快照会写入该 Run 的 transcript。故旧 Run 重放不读取 R2，也不受未来解析器升级影响。

## 消息、编辑、历史与分享

- 一条用户消息最多五个附件、原件合计最多 50 MiB。消息文字可为空，但必须有非空文字或至少一个当前 provider 可消费的文档附件；纯图片不能单独发送，系统不会伪造「请分析此文件」等文字。
- Message、全部 `MessageAttachment`、待绑定保护和 Run 在一个事务中创建，任何一个附件不合格就没有部分消息或部分 Run。
- 当前总 context budget 是 256,000 tokens；目标用户 turn（文字、完整文档块和 notice）最多 128,000 estimated tokens，且不超过总预算 50%。超限时拒绝，不截断、不摘要、不做 RAG。旧历史按完整 turn 裁剪，目标 turn 永不裁剪。
- 编辑请求省略 `attachment_ids` 表示继承当前修订；显式列表是完整替换；空列表表示删除全部附件。直接 regenerate 固定复用原用户修订的附件。资产只能在自身当前消息修订链中继承，不能从任意历史消息挑选复用。
- 自动标题只可使用用户文字、附件安全元数据和首条助手回复，不能再次注入完整附件正文。
- 公开分享快照仅保存附件占位：安全名称、媒体类型、大小、类别和 warning。没有原件、预览、派生文本、下载 URL 或匿名读取能力；含附件会话创建分享必须显式确认额外隐私提示，因为助手回复可能已透露文件信息。

读取由 files 服务授权并签发 5 分钟 R2 GET URL，API 不代理字节：图片预览指向安全派生物并 inline，下载指向原件并 attachment。待绑定资产只能由所有者读取；绑定后依据当前可见的消息附件关系授权。停用账户、软删除会话、终态无效或正在删除的资产都不得签发新 URL。

## 生命周期、配额、会话与账户

| 事件 | 行为 |
|---|---|
| 上传 pending | 30 分钟后过期并释放 reservation；浏览器关闭/刷新不是取消。 |
| ready 但未绑定 | 24 小时后回收；查看、轮询或继续编辑不续期。 |
| 从所有当前消息修订移除 | 标记 detached，保留 30 天；归档消息继续保存元数据，旧 transcript 继续保存当时文档块。 |
| 删除会话 | 标记删除并给出 30 天恢复期；期间文件仍可恢复、仍占配额。恢复不会绕过既有会话删除状态。 |
| 删除会话到期 | 有界 sweep 物理删除会话、消息、Run，并为不再引用的资产创建删除补偿；资产 used 配额在开始删除的事务中释放。 |
| 账户注销 | 保持既有软停用：拒绝新上传和新读取 URL，取消在途上传；私有已绑定附件与业务数据保留，不启动账户整体 30 天物理清除。 |
| 账户注销中的头像 | 立即解除当前头像引用，创建公开 delete+purge 补偿；账户恢复不自动恢复旧头像。 |

消息附件配额为每用户 1 GiB，按原件字节计量；bound、unbound 和会话恢复期内文件都计入，预览和派生文本不计入，头像不计入。回收/删除开始时先释放数据库配额，R2 的最终删除由补偿独立完成，因此补偿积压必须单独观察。

## 服务、队列与凭证拓扑

```text
Browser ── presigned PUT ──► private files staging bucket
   │ POST confirm                         │
   ▼                                      ▼
API ── PG FileUpload ── wakeup ──► Celery files queue / file-worker
                                      │ If-Match GET + ClamAV + restricted parser
                                      ▼
                           private files canonical bucket + PG FileAsset/Object

avatar route ──► media queue / media-worker ──► public avatar bucket + CDN purge
```

PostgreSQL 行和补偿表是事实源；Celery broker/任务只负责唤醒与重投。`celery-beat` 必须单实例，周期投递 files maintenance：lease/过期恢复、staging 清理、unbound/detached 回收、到期会话物理清除、删除补偿和配额 reconciliation。

生产凭证必须按下表拆分，并在容器环境中实际验证，而不是仅依赖命名：

| 进程/角色 | 最小权限 | 明确不得持有 |
|---|---|---|
| API upload signer | files staging 的签名 PUT/HEAD | canonical 原件读取、公开头像写入、CDN purge |
| API download signer | canonical 的签名 GET | staging 写入、公开头像写入、CDN purge |
| file-worker | staging 条件 GET/delete、canonical PUT/delete、ClamAV 连接 | 头像公开 bucket、Cloudflare purge、LLM、邮件 secret |
| media-worker | 头像 staging/公开成品与 purge 所需权限 | files staging/canonical 凭证、ClamAV/文档解析权限 |

仓库 compose 为 file-worker 设置独立 `files` queue、`--prefetch-multiplier=1`、资源限制和显式环境；API 显式清空 worker 处理凭证，普通 LLM worker、邮件/标题 worker、media-worker 和 beat 固定关闭附件入口并清空全部 files 凭证。file-worker 固定 `FILE_UPLOAD_ENABLED=false`，但以实际 R2/ClamAV 配置继续排空已有 PG 事实。不得把这些服务退化为共享 `env_file`；上线时仍须通过容器 inspect/secret inventory 核对实际注入值。

`FILE_UPLOAD_ENABLED` 是 API 新附件入口的独立 feature flag。关闭时：API 拒绝创建新上传、capabilities 告知前端隐藏选择入口；已有附件继续显示和读取，已存在的 queued/processing 上传继续排空，维护和删除补偿继续运行。file-worker 固定关闭该入口开关而按实际 R2/ClamAV 配置排空，不能因 API 入口关闭而停掉事实行。

capabilities 对前端动态公开完整 allowlist、分类大小、每条五个、50 MiB、1 GiB、128k target turn、256k context 与 `image_model_input=false`。前端的预检查/隐藏只是体验，后端仍必须独立执行所有权限、配额、格式和预算约束。

## 部署、灰度与回滚

### 上线顺序

1. 创建开发/生产各自独立的 files staging 与 canonical 私有 bucket，以及头像公开 bucket；先配置精确 CORS、生命周期策略和最小权限凭证。
2. 部署 additive migration，保留 `users.avatar_object_key`、旧 avatar 表/worker 与读回退；核对 current avatar 映射数量、缺失与冲突报告。迁移不得访问 R2 或转换历史上传。
3. 启动并健康检查 `clamav`、`file-worker`、`media-worker`、单实例 `celery-beat`；先验证 queue 和凭证隔离，再开放 API。
4. 保持 `FILE_UPLOAD_ENABLED=false` 做 worker、删除补偿和真实资源 smoke；这时前端不应显示新上传入口。
5. 小范围启用 API capabilities 与前端入口，观察状态、解析、配额和删除指标；确认 rollback 不需要数据库降级后再扩大。

环境变量变更必须 force-recreate，`restart` 不会重载 `.env`：

```bash
docker compose -f compose.prod.yml config --quiet
docker compose -f compose.prod.yml run --rm migrate
docker compose -f compose.prod.yml up -d --force-recreate \
  api file-worker media-worker celery-beat clamav
docker compose -f compose.prod.yml ps
```

回滚顺序是先关闭 `FILE_UPLOAD_ENABLED` 并 force-recreate API（停止新事实），保留 file/media worker、ClamAV 和 beat 排空 queued/processing、staging 与删除补偿；确认积压为零后才撤销凭证或删除开发资源。不要先停 worker、更不能直接删表/bucket。历史附件仍应可展示和读取；如需前端回滚，保留附件卡片的只读显示。

### R2 CORS、ETag 与 If-Match smoke（开发资源）

staging bucket 的 CORS 至少应只允许真实前端 Origin 写入并暴露 ETag；不要使用 `*`：

```json
[
  {
    "AllowedOrigins": ["https://chat.example.test"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "x-amz-meta-declared-size"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

以下命令在已验证的**开发测试账户**、允许 Origin 与非生产 bucket 上运行；`ACCESS_TOKEN`、测试文件和 shell 临时输出均不得提交。它验证签名 PUT、浏览器可读 ETag、confirm 与 worker 状态，不代理字节：

```bash
export API_BASE_URL='http://localhost:8000/api/v1'
export ACCESS_TOKEN='<dev-access-token>'
printf 'file smoke\n' > /tmp/ichat-file-smoke.txt

CREATE=$(curl --fail-with-body -sS -X POST "$API_BASE_URL/files/uploads" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  --data '{"filename":"smoke.txt","content_type":"text/plain","size_bytes":11}')
UPLOAD_ID=$(jq -r '.data.upload_id' <<<"$CREATE")
UPLOAD_URL=$(jq -r '.data.upload_url' <<<"$CREATE")

curl --fail-with-body -sS -D /tmp/ichat-file-smoke.headers -X PUT "$UPLOAD_URL" \
  -H 'Content-Type: text/plain' -H 'x-amz-meta-declared-size: 11' \
  --upload-file /tmp/ichat-file-smoke.txt
ETAG=$(awk 'BEGIN{IGNORECASE=1} /^etag:/ {gsub("\\r", ""); print $2}' /tmp/ichat-file-smoke.headers)

curl --fail-with-body -sS -X POST "$API_BASE_URL/files/uploads/$UPLOAD_ID/confirm" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  --data "{\"etag\":$ETAG}"
curl --fail-with-body -sS "$API_BASE_URL/files/uploads/$UPLOAD_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

同时在浏览器 DevTools 中重复 PUT，确认允许 Origin 的响应可读取 `ETag`，并从未列入 CORS 的 Origin 验证预检/PUT 被拒绝。用隔离 staging key 进行条件读取语义验证；该步骤只使用开发 worker 凭证，完成后删除对象：

```bash
export AWS_ACCESS_KEY_ID="$FILES_WORKER_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$FILES_WORKER_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION='auto'
export TEST_KEY="if-match-smoke/$(uuidgen | tr '[:upper:]' '[:lower:]').txt"
printf 'first\n' > /tmp/ichat-if-match-a.txt
printf 'second\n' > /tmp/ichat-if-match-b.txt

aws --endpoint-url "$FILES_R2_ENDPOINT_URL" s3api put-object \
  --bucket "$FILES_STAGING_BUCKET" --key "$TEST_KEY" --body /tmp/ichat-if-match-a.txt
ETAG=$(aws --endpoint-url "$FILES_R2_ENDPOINT_URL" s3api head-object \
  --bucket "$FILES_STAGING_BUCKET" --key "$TEST_KEY" --query ETag --output text)
aws --endpoint-url "$FILES_R2_ENDPOINT_URL" s3api get-object \
  --bucket "$FILES_STAGING_BUCKET" --key "$TEST_KEY" --if-match "$ETAG" /tmp/ichat-if-match-ok.txt
aws --endpoint-url "$FILES_R2_ENDPOINT_URL" s3api put-object \
  --bucket "$FILES_STAGING_BUCKET" --key "$TEST_KEY" --body /tmp/ichat-if-match-b.txt
if aws --endpoint-url "$FILES_R2_ENDPOINT_URL" s3api get-object \
  --bucket "$FILES_STAGING_BUCKET" --key "$TEST_KEY" --if-match "$ETAG" /tmp/ichat-if-match-must-fail.txt; then
  echo 'If-Match unexpectedly succeeded after overwrite' >&2
  exit 1
fi
aws --endpoint-url "$FILES_R2_ENDPOINT_URL" s3api delete-object \
  --bucket "$FILES_STAGING_BUCKET" --key "$TEST_KEY"
rm -f /tmp/ichat-file-smoke.txt /tmp/ichat-file-smoke.headers \
  /tmp/ichat-if-match-a.txt /tmp/ichat-if-match-b.txt /tmp/ichat-if-match-ok.txt \
  /tmp/ichat-if-match-must-fail.txt
```

该流程还应检查：canonical 只有 worker 可写，download URL 在五分钟后失效且带安全 `Content-Disposition`，取消/过期上传的 staging 对象最终清理，delete 补偿完成后对象不可读。不要把真实用户文件、对象 URL、文件名或凭证贴入日志/工单。

### ClamAV smoke（不落盘样本）

先等待签名更新和容器健康，再从 EICAR 官方测试站以管道方式送入 clamd。命令不把 EICAR 内容写入宿主机或仓库；它只验证无害测试签名会被识别。以下以 Bash 执行，预期 `clamdscan` 的退出码为 `1`：

```bash
bash -ceu '
  docker compose exec -T clamav clamdscan --ping=1 --wait /etc/hosts
  set +e
  curl --fail --silent --show-error https://secure.eicar.org/eicar.com.txt \
    | docker compose exec -T clamav clamdscan -
  scan_status=${PIPESTATUS[1]}
  set -e
  test "$scan_status" -eq 1
'
```

随后在隔离测试环境验证 file-worker 的三条路径：签名命中进入 `rejected`；停止 clamd 时进入可重试 fail-closed；将签名年龄阈值临时设为过期时同样不产生 ready 资产。不要保存 EICAR、真实恶意文件或其字节内容；完成后恢复阈值和容器。

## 可观测性与告警

日志只能含内部 upload/file/user ID、purpose、状态、格式类别、大小、页/节点/单元格计数、token 估算、耗时与稳定错误码；不得记录原始文件名、正文、签名 URL、对象 URL、文档属性、未经清洗的 parser 错误或临时路径。

上线前应将安全结构化日志和 PG 有界查询接入下列看板/告警。仓库不把这些指标当作业务事实源，也不应通过采集原件内容实现它们：

| 信号 | 建议告警/动作 |
|---|---|
| queue wait、If-Match 下载、ClamAV、解析、R2 写入、最终提交、清理、delete/purge 的 P95/P99 与失败率 | 连续两个窗口超过基线或 `confirm→ready` 图片/文本 P95 > 10s、PDF/Office P95 > 30s、正常文件 P99 > 120s 时停止扩大灰度。浏览器 PUT 时间不计入。 |
| queued/processing/failed/rejected 数量、lease 过期数 | queued/processing 持续增长或 lease 过期出现时检查 files queue、worker 并发、ClamAV 和 R2。 |
| 最老未完成 `file_object_deletions`、object delete/purge 分步失败 | 达到删除/隐私 SLO 前告警；公开 purge 失败不得当作已完成。 |
| quota reconciliation drift | 非零 drift 持续出现时冻结扩容并审查事务路径。 |
| ClamAV 签名年龄、scanner unavailable、file-worker OOM/timeout/pid 终止 | 签名临近阈值或 scanner 不可用时保持 fail-closed，修复服务而不是临时放开上传。 |

可先使用下列不含文件名/URL 的查询检查积压；生产执行前将 `<...>` 替换为受控值：

```sql
select status, count(*)
from file_uploads
group by status
order by status;

select storage_location, count(*) as backlog, min(created_at) as oldest
from file_object_deletions
where completed_at is null
group by storage_location
order by storage_location;

select count(*) as overdue_processing
from file_uploads
where status = 'processing' and lease_expires_at < now();
```

## 已知限制与后续工作

- 没有 OCR、图片视觉理解、ImageBlock、自动图像描述或图片文字提取；图片仅预览/下载/notice。
- 没有 RAG、向量索引、分块检索、附件摘要、静默截断或 provider 原生 Files API；超预算必须拒绝。
- 没有 multipart、分片上传、断点续传或中断 PUT 恢复。
- 没有独立文件库、跨无关消息/跨用途复用、物理去重、引用计数或公开附件下载。
- 非图片附件没有浏览器内阅读器；PDF/Office/文本/代码只提供卡片与原件下载。
- 不解密密码保护文档，不保存密码，也不周期性全量重扫历史文件。
- 账户注销仍是软停用，私有附件的账户级物理清除不属于本期；会话删除的 30 天回收与账户注销不能混同。
- contract 阶段仍待生产前置验证：旧 avatar key/表/队列/任务/回退不可删除。届时应单独完成迁移演练、映射计数、旧积压检查、合同收缩与再次全量回归。

## 验证清单

在不启动会抢占测试数据库的外部 worker 时运行：

```bash
uv sync --all-groups
pytest
ruff check .
mypy app

pnpm --dir frontend exec vitest run
pnpm --dir frontend run lint
pnpm --dir frontend run typecheck
pnpm --dir frontend run build

docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
```

代码、单元/集成测试与 compose 配置通过后，仍须执行本交接的 R2/If-Match/ClamAV smoke、权限检查、灰度指标记录和回滚演练，才能宣称 ticket 14 的生产准备完成。
