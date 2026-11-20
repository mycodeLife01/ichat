# 番剧追更与搜索助手（Anime tracking）

- 日期：2026-11-18
- 状态：草案，待确认（§15 待确认事项）；未实现
- 修订：2026-11-20 补充一致性约束（§5.1、§6.3–§6.5、§7.1、§7.2、§7.4、§7.7、§13）；通知渠道改为
  Telegram（§7.6）；`running` 检查改为自适应轮询（§7.4）；P0 只接入蜜柑，爱恋移到 P1（§2、§7.2）
- 范围：新增 `app/services/anime` 领域模块、`app/tasks/anime_tasks.py` Celery 任务与 `anime` 队列、
  `app/anime_admin.py` 运维 CLI、OpenList 部署；P1 新增聊天内番剧工具、动作提议与确认接口
- 不涉及（本期）：Run 挂起/恢复状态机、MCP client/server、浏览器自动化兜底、多租户、计费

## 1. 背景与目标

个人痛点：在蜜柑计划（mikan）/ 爱恋动漫（kisssub）复制磁力链接 → 打开 PikPak 添加离线下载 →
再打开播放器观看，每集都要手动走一遍。此前直接使用非官方 PikPak SDK 自动化，因 SDK 不稳定放弃。

本功能同时是 iChat 从「聊天应用」演进为「agent 运行时」的第一个真实业务领域：确定性管线负责
稳定执行，agent 只放在规则难以覆盖的边缘（模糊搜索、资源挑选、异常处理）。

目标：

1. **P0 自动追更（无 LLM）**：定时拉取 RSS，新资源经 OpenList 离线下载到 PikPak，完成后推送带
   播放链接的通知；全链路幂等、可恢复、可告警。
2. **P1 搜索助手（agent）**：在 iChat 聊天中用自然语言找番，agent 解析番名、跨源搜索、挑选候选并
   提出下载提议；用户确认后进入 P0 管线执行。
3. **可度量**：标题解析与资源挑选有离线评测集，能用数据比较规则与 LLM 的准确率和成本。

非目标：替代 PikPak 客户端的浏览/播放能力；做通用网盘管理；面向其他用户开放。

## 2. 外部依赖事实与风险

| 依赖 | 事实 | 风险与对策 |
|---|---|---|
| PikPak | 无公开开放 API；网页版提供 WebDAV（会员，据第三方资料为只读） | 写操作（离线下载）只能走非官方接口 → 经 OpenList 驱动隔离，见 §5 |
| OpenList | Alist 的社区分支，自托管网盘聚合程序；提供 Web UI、WebDAV、HTTP API 与离线下载工具 | 仍依赖 PikPak 非官方接口，维护成本转移给社区；需健康检查与告警 |
| 蜜柑计划 | 「我的番组」个人 RSS（`/RSS/MyBangumi?token=…`）、搜索 RSS（`/RSS/Search?searchstr=…`） | P0 唯一订阅来源。常见故障是某个域名不可达而非服务停摆 → base URL 可配置，故障时先切换镜像域名（个人 RSS 与站内字幕组选择不受影响）；个人 RSS 的 token 视为凭据，日志脱敏 |
| 爱恋动漫 | 第三方资料给出搜索 RSS 格式 `/rss-{关键词}.xml`、全站 `/rss.xml`，无官方说明 | P1 接入（搜索工具，兼作蜜柑不可用时的手动备用订阅源）；以站内 RSS 按钮生成的实际链接为准（P1 前验证） |
| bangumi.tv | 公开 API（`api.bgm.tv`），可搜索条目、取中日文名与别名；要求合理 User-Agent | 仅 P1 使用；失败时 agent 降级为直接关键词搜索 |

PikPak 的离线下载链接、文件直链均由 OpenList 在访问时换取，iChat 不保存任何 PikPak 直链或凭据。

## 3. 术语

以下术语在实现时补入 `CONTEXT.md`：

**订阅源（Feed）**：一个被定时拉取的 RSS 地址及其过滤规则，如蜜柑「我的番组」个人 RSS 或爱恋某关键词
搜索 RSS。_Avoid_：订阅（与「蜜柑站内订阅某番」混淆）。

**资源（Release）**：RSS 中的一条种子发布，以 infohash 唯一标识，带原始标题与解析字段。同一资源
可能出现在多个订阅源中。_Avoid_：种子、磁链（它们只是资源的定位方式）。

**下载任务（Download）**：把一个资源离线下载到云盘的工作单元，PG 中的状态行，与资源一对一
（infohash 唯一）。_Avoid_：离线任务（那是 PikPak/OpenList 侧的对象，见「云端任务」）。

**云端任务（Cloud Task）**：OpenList/PikPak 侧为一次离线下载创建的任务，由下载任务以不透明引用持有。

**动作提议（Action Proposal）**：agent 提出、尚未执行的副作用请求（P1 为「下载这些资源」），
必须由用户显式确认后才转化为下载任务。_Avoid_：待办、草稿。

## 4. 总体架构

```
             ┌──────────────── celery-beat ────────────────┐
             │ dispatch_due_feeds / poll_running_downloads /│
             │ maintain_downloads / health_check            │
             │（周期投递，均为兜底扫描）                      │
             └──────────────────────┬──────────────────────┘
                                    v  queue: anime
 蜜柑 RSS（P1 起可加爱恋）──> poll_feed ──> anime_releases ──> anime_downloads(pending)
                                                        │ claim + lease
                                                        v
                                      CloudDriveAdapter(OpenList) ──> PikPak 离线下载
                                                        │ check_download（自适应间隔）
                                                        v
                                      anime_downloads(completed) ──> Notifier(Telegram) ──> 手机
                                                                          │
                                         OpenList 文件页 / 直链 <── 点击播放（PotPlayer/IINA/Infuse）

 P1：聊天 Run ──> 番剧工具（解析/搜索/查库/提议）──> anime_action_proposals
                                    用户点击确认 ──> API ──> anime_downloads(pending)（并入上面管线）
```

遵循 `docs/architecture/background-tasks.md` 的统一骨架：**PG 状态行为事实源 + 可丢失唤醒信号 + 幂等
claim**。Celery 消息只是加速器，beat 周期扫描兜底。

任务形状判定：拉取、提交、轮询、通知都是有限、非流式、可重试的 → **Celery**，不进自研 async 运行时。
P1 的聊天 Run 仍由现有 LLM worker 执行。

## 5. 云盘适配层

### 5.1 接口

`app/services/anime/drive.py` 定义窄协议，业务代码只依赖它：

```python
class CloudDriveAdapter(Protocol):
    async def submit_offline(self, *, magnet: str, target_dir: str) -> SubmitReceipt: ...
    async def get_task(self, ref: CloudTaskRef) -> CloudTaskStatus: ...       # running/completed/failed/not_found
    async def find_existing(self, *, infohash: str, target_dir: str) -> CloudTaskRef | None: ...
    async def list_names(self, path: str) -> list[str]: ...                   # 目录下的文件/文件夹名
    async def health(self) -> DriveHealth: ...                                 # 登录有效、根目录可列
    def play_links(self, path: str) -> PlayLinks: ...                          # 文件页 + 直链 + 播放器 scheme
```

- `CloudTaskRef` 对业务不透明（JSON），只由所属适配器解释；云端在提交响应或任务详情中给出落盘名称时，
  适配器把它存入引用，供 §7.4 的 `not_found` 兜底使用。
- `not_found` 表示云端已查不到该任务（如 OpenList 清理任务列表或重启），**不等于失败**，处理见 §7.4。
- 所有适配器调用的 HTTP 超时为 `ANIME_DRIVE_CALL_TIMEOUT_SECONDS`，与提交租约的关系见 §6.5。
- 适配器错误分为 `transient`（网络、5xx、限流 → 退避重试）与 `permanent`（磁链非法、目录不存在、
  权限不足 → 直接 dead），由适配器归类，业务不解析错误文案。

### 5.2 OpenList 实现（P0 唯一实现）

- 调用 OpenList HTTP API：登录取 token、离线下载（工具选 PikPak、目标路径为 PikPak 存储下的目录）、
  查询离线下载任务、列目录。具体端点与字段在 S0 中以实测为准，写入实现计划。
- 鉴权：为 iChat 建立**专用 OpenList 用户**，只授予番剧根目录的读与离线下载权限，不使用管理员 token；
  401 时重新登录一次后重试。
- 存储设置：PikPak 存储关闭「Web 代理」，`/d/` 直链以 302 重定向到 PikPak CDN，播放流量不经服务器。
- 网络：OpenList 仅监听内网 / Docker 网络，经 Tailscale 供手机与电脑访问；不暴露公网。

### 5.3 备选实现（不在本期）

直连 PikPak 非官方 API、浏览器自动化（agent-browser 操作网页）。接口不变即可替换；健康检查失败时的
自动降级不在本期，避免两套路径同时写入。

## 6. 数据模型

迁移 `2026111x_0030_anime_tracking.py`。所有表为单用户运维数据（见 §15 Q1），不带 `user_id`。

### 6.1 `anime_feeds`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK | |
| `name` | varchar(100) unique | 运维可读名 |
| `source` | varchar(16) | `CHECK (source IN ('mikan','kisssub'))`；P0 只实现 `mikan`，约束预留 `kisssub` 以免 P1 迁移 |
| `url` | text | 视为凭据：日志与 CLI 输出中脱敏查询参数 |
| `target_dir` | text | 云盘目标目录（相对番剧根目录） |
| `filters` | jsonb | 过滤规则，见 §7.2 |
| `enabled` | bool | |
| `poll_interval_seconds` | int | 默认 600 |
| `next_poll_at` / `last_polled_at` | timestamptz | |
| `lease_expires_at` | timestamptz null | 拉取 claim 租约 |
| `etag` / `last_modified` | text null | 条件 GET |
| `consecutive_failures` / `last_error` | int / text | 连续失败达阈值告警 |
| `created_at` / `updated_at` | timestamptz | |

### 6.2 `anime_releases`

| 列 | 类型 | 说明 |
|---|---|---|
| `infohash` | char(40) PK | 小写 hex；base32 btih 统一转换 |
| `title` | text | 原始标题，**不受信任文本** |
| `source` / `source_url` | varchar / text | 首次发现来源与详情页 |
| `magnet` / `torrent_url` | text null | 至少一个非空；提交时优先磁链，否则由 infohash 构造磁链 |
| `size_bytes` / `published_at` | bigint null / timestamptz null | |
| `parsed` | jsonb | `series`、`episode`、`group`、`resolution`、`subtitle_lang`、`is_batch`、`parser`（`regex`/`llm`）、`parser_version` |
| `first_seen_at` | timestamptz | |

资源只增不改（`parsed` 可在解析器升级时重算）。

### 6.3 `anime_downloads`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK；`public_id` | 对外引用 |
| `infohash` | char(40) **unique** FK | 幂等键：同一资源只下载一次 |
| `origin` | varchar(16) | `feed` / `agent` / `manual` |
| `feed_id` / `proposal_id` | bigint null | 来源追溯 |
| `target_dir` | text | |
| `status` | varchar(16) | 见 §6.4 |
| `cloud_task` | jsonb null | 不透明 `CloudTaskRef` |
| `file_paths` | jsonb null | 完成后的云盘文件路径 |
| `attempt_count` / `next_attempt_at` / `lease_expires_at` / `last_error` | | claim 与退避 |
| `lease_owner` | varchar(255) null | 每次 claim 新生成，写回时校验（fencing，§6.5） |
| `next_check_at` | timestamptz null | 仅 `running` 使用：下一次检查云端任务的时间，同时作为检查链的版本号（§7.4） |
| `submitted_at` / `completed_at` | timestamptz null | `submitted_at` 也是自适应检查间隔的计时起点 |
| `notify_status` | varchar(16) | `none` / `pending` / `sent` / `dead`；完成通知与失败通知共用，内容按下载状态生成 |
| `notify_attempts` / `notified_at` | int / timestamptz null | |

### 6.4 下载任务状态机

```
skipped（过滤/回填窗口外，终态）

pending ──claim──> submitting ──成功──> running ──云端完成──> completed（终态）
   ^                  │  │                 │
   └──transient 退避──┘  └─permanent─> dead │ 云端失败 / 超过停滞上限
                                           v
                                         failed（终态）
```

三问（`background-tasks.md` §4）：

| 阶段 | 重试几次 | 退避 | 死了落到哪 |
|---|---|---|---|
| 提交（`pending→running`） | 最多 5 次 | 1m / 5m / 15m / 1h / 6h | `dead` + `last_error` + 失败通知（经 `notify_status`） |
| 云端运行（`running`） | 不重试提交；按 §7.4 自适应间隔检查（10s 起，逐步放宽到 10min） | — | 云端报失败、任务不可查且无法确认文件已落盘（§7.4）、或超过 `ANIME_DOWNLOAD_STALL_TIMEOUT_SECONDS`（默认 24h）→ `failed` + 失败通知（经 `notify_status`） |
| 通知 | 最多 5 次 | 同提交 | `notify_status=dead`，记日志，不影响下载状态 |

`failed` / `dead` / `skipped` 可经 CLI `downloads retry` 重置为 `pending`（`attempt_count` 清零）。

进入 `completed` / `failed` / `dead` 的同一事务内置 `notify_status=pending`：通知是否发出单独记录，
不随状态变化一起「假定已发」。

### 6.5 崩溃窗口与提交幂等

两个危险窗口：

- worker 已调用 `submit_offline` 成功，但在写回 `running` 前崩溃；
- worker 没有崩溃，只是调用慢于租约，行已被回收并由另一个 worker 接手，旧 worker 随后写回。

处理：

1. **claim**：调用前在单独提交的事务中把行置为 `submitting`，写入新生成的 `lease_owner` 与
   `lease_expires_at`，`attempt_count += 1`。
2. **租约大于调用超时**：提交租约 `ANIME_SUBMIT_LEASE_SECONDS`（默认 300）必须不小于
   `ANIME_DRIVE_CALL_TIMEOUT_SECONDS`（默认 30）加 60 秒，配置校验不满足时拒绝启动。正常情况下
   worker 一定在租约过期前得到结果（成功、失败或超时）。
3. **fencing 写回**：调用返回后，在 `SELECT … FOR UPDATE` 中校验 `status='submitting' AND
   lease_owner=:owner`。不成立说明所有权已丢失：不修改任何字段，记 `anime_download_stale_writeback`
   （带本次 `CloudTaskRef`）并告警，供人工核对是否多出一个云端任务。沿用头像处理的 `lease_owner`
   模式（`app/services/avatars/processing.py`）。
4. **对账**：租约过期的 `submitting` 行被回收时，**先调用 `find_existing(infohash, target_dir)`**：找到则
   直接置 `running` 并写入引用（同时写 `submitted_at`、`next_check_at`，进入 §7.4 检查链）；找不到才重新提交。`target_dir` 使用下载任务创建时落库的值，不重新计算，
   避免解析器升级后对账到另一个目录。
5. **前提与降级**：第 4 步依赖「云端任务在完成后、OpenList 重启后仍能按 infohash 查到」，由 S0-6 验证。
   不成立时 `find_existing` 恒返回 `None`，崩溃恢复退化为依赖 PikPak 对同一 infohash 去重（S0-3）；
   两者都不成立则接受「崩溃窗口内可能重复一份」，并写入 ADR（Q9）。即使重复，影响也只是同一目录
   多一份文件，不扩散。

通知同理：`notify_status` 先在事务中由 `pending` 原子 claim，发送成功后置 `sent`；崩溃窗口内最多
重复一次通知（至少一次语义），可接受。

## 7. P0 管线

### 7.1 拉取（`dispatch_due_feeds` → `poll_feed`）

- beat 每 60 秒投递 `dispatch_due_feeds`：`FOR UPDATE SKIP LOCKED` 选出到期且无有效租约的订阅源，
  写租约（120 秒，大于拉取超时与入库耗时）后逐个投递 `poll_feed(feed_id)`。重复拉取不影响正确性
  （入库幂等），租约只用于减少重复请求。
- `poll_feed`：条件 GET（ETag / Last-Modified），超时 15 秒；解析 RSS 条目 → 规范化 infohash →
  解析标题 → **同一事务内** `INSERT anime_releases ON CONFLICT DO NOTHING`，对通过过滤的资源
  `INSERT anime_downloads ON CONFLICT (infohash) DO NOTHING`，更新 `next_poll_at`、清租约。
- 提交后对新建的下载任务投递 `submit_download(public_id)` 作为唤醒信号；丢失由 `maintain_downloads`
  兜底。
- 失败：`consecutive_failures += 1`，按退避推迟 `next_poll_at`，并清租约；达到 5 次时把监控状态
  `feed:{id}` 置为 `failing`，成功拉取后置回 `ok`，告警按 §7.7 发送。

### 7.2 过滤规则（`filters` jsonb）

```json
{
  "include": ["1080p"],
  "exclude": ["合集", "Batch", "\\bHEVC\\b"],
  "skip_batch": true,
  "episode_dedupe": true,
  "backfill_hours": 24
}
```

- `include` / `exclude` 为对原始标题的正则，大小写不敏感；正则在写入时校验可编译并限制长度。
- `skip_batch`：解析为合集的资源记为 `skipped`。
- `episode_dedupe`：同一 `(series, episode)` 已存在状态为 `pending` / `submitting` / `running` /
  `completed` 的下载任务时，后来者记为 `skipped`（避免同一集不同字幕组、不同分辨率重复下载）；已有任务为
  `failed` / `dead` / `skipped` 时不阻挡，后来者正常进入 `pending`。解析不出集数时不做该去重。
  - 该判定是先查后插，没有唯一约束保护：两个订阅源被并发拉取且含同一集的不同资源时，可能各产生一个
    下载任务。P0 只有蜜柑单一订阅源，基本不会发生；P1 加入爱恋备用订阅源后接受这种少见的重复，不加锁。
  - 已跳过的资源不会在先前任务失败后自动补位：失败通知列出同集被跳过资源的 `public_id`，可经
    `downloads retry` 手动补位；自动补位属于 P2 异常处理 agent。
- `backfill_hours`：**首次拉取**时，发布时间早于「订阅源创建时间 − backfill_hours」的资源只入库为
  `skipped`，防止添加订阅源时一次性下载大量旧集。

蜜柑「我的番组」已在站内选好字幕组，P0 只依赖它，订阅源通常只有一个。

蜜柑不可用时的处置（人工，不自动切换）：

1. 订阅源连续失败 5 次后收到告警（§7.1）。
2. 优先 `feeds update --url` 把域名换成镜像，个人 RSS token 与站内字幕组选择不变。
3. 镜像也不可用时，P1 起可 `feeds add` 爱恋关键词订阅源作为临时备用；必须设置 `include` / `exclude`，
   并依赖 `backfill_hours` 防止下载旧集。同一种子由 infohash 唯一约束去重，同集不同字幕组由
   `episode_dedupe` 去重。

不做自动切换：两站的标题格式与字幕组覆盖不同，自动切换需要另一套过滤规则，且容易一次下载大量旧集。

### 7.3 标题解析（P0 规则版）

`app/services/anime/parsing.py`：纯函数，输入标题、输出 §6.2 的 `parsed` 字段。覆盖常见字幕组格式：
`[组名] 番名 - 01 [1080p][简日内嵌]`、`【组名】番名 第01话 …`、`… S01E01 …`、合集标记（`01-12`、
`Fin`、`合集`、`Batch`）。解析失败的字段为 `null`，不阻断下载。P1 用同一接口接入 LLM 解析并做评测对比（§11）。

### 7.4 提交与检查（`submit_download` / `check_download` / `poll_running_downloads` / `maintain_downloads`）

- `submit_download`：按 §6.5 claim 并提交。fencing 写回成功时，在同一事务内置 `running`、写
  `submitted_at=now()`、`next_check_at=now()+10s`；提交后投递 `check_download(public_id)`，`countdown=10`。

**检查间隔**：PikPak 对新番资源通常 10–30 秒内完成离线，检查前密后疏，按提交后经过的时间
（`now − submitted_at`）决定下一次间隔：

| 提交后经过 | 间隔 | 该段约检查次数 |
|---|---|---|
| 0–2 分钟 | 10 秒 | 12 |
| 2–10 分钟 | 30 秒 | 16 |
| 10–60 分钟 | 2 分钟 | 25 |
| 1–24 小时 | 10 分钟 | 约 138 |

档位为代码常量，不做配置；第一档在 S0-2 实测 OpenList 状态刷新延迟后确定（刷新本身慢于 10 秒时
改为 20 秒）。卡满 24 小时停滞上限的任务共检查约 190 次。

**`check_download(public_id)`**：

1. 读取行；不是 `running` 时直接结束。记下本次读到的 `next_check_at` 为 `:observed`。
2. 调用 `get_task`（只读，重复检查无害）。
3. 按结果写回，所有写回都带条件 `WHERE status='running' AND next_check_at=:observed`：
   - `running` 且未超停滞上限：写新的 `next_check_at`，影响 1 行才投递下一条 countdown 消息；
   - `completed`：写 `file_paths` 与 `completed_at`，置 `completed`、`notify_status=pending`、
     `next_check_at=NULL`，提交后投递 `notify_download`；
   - `failed` 或超过停滞上限：置 `failed`、`notify_status=pending`、`next_check_at=NULL`；
   - `not_found`：引用中有落盘名称且该名称出现在 `list_names(target_dir)` 中时，按 `completed` 处理；
     否则置 `failed`，`last_error=cloud_task_missing`，失败通知写明「云端任务已不可查，文件可能已在
     目录中，请核对」，与普通下载失败区分。
4. 条件不成立（影响 0 行）说明另一条检查链已推进或已处理该行：不写、不投递，直接结束。

`next_check_at` 充当检查链的版本号。迟到的消息、兜底补投与 broker 重投可能让同一行同时存在两条
检查链；每次推进只有一方成功，多余的链在下一步自然终止，不会永久翻倍检查，也不会重复发通知。

**`poll_running_downloads`**（beat 每 60 秒）：选出 `status='running' AND next_check_at < now() − 30s`
的行（检查消息已丢失或卡住），逐个投递 `check_download`。30 秒宽限避免与正常到期的 countdown 消息
竞争；最坏情况（消息全部丢失）下完成通知延迟约 1–1.5 分钟。

Redis broker 下 countdown 消息由 worker 预取并在内存中持有到期；worker 被 `kill -9` 时，这些消息要到
broker 的 visibility timeout（默认 1 小时）后才会重投。由于 `poll_running_downloads` 兜底，正确性不依赖
重投；最大间隔 10 分钟也远小于 visibility timeout，不会触发 countdown 超过 visibility timeout 的重复投递。

**`maintain_downloads`**（beat 每 5 分钟，不再检查 `running`）：

- 回收过期租约，`submitting` 行按 §6.5 第 4 步对账；补投到期的 `pending`。
- 补投到期的 `notify_status=pending`；补发 §7.7 中未发出的告警。

### 7.5 目标目录

`{ANIME_STORAGE_ROOT}/{feed.target_dir}/{series}`，`series` 来自解析结果并做文件名安全化；解析不出时
落到 `{feed.target_dir}/_未分类`。P1 的提议可显式指定目录。

### 7.6 通知与播放链接

- `Notifier` 协议，P0 唯一实现为 Telegram Bot：`sendMessage`（HTML 格式），发往 `TELEGRAM_CHAT_ID`
  （需先在 Telegram 中对 bot 执行 `/start`）。关闭链接预览：Telegram 服务器访问不到 Tailscale 地址，预览
  只会失败。
- Bot token 位于请求 URL 路径中（`/bot{token}/sendMessage`），视为凭据：日志、异常信息与 CLI 输出中
  一律脱敏，HTTP 客户端的请求日志不得记录完整 URL。
- 完成通知内容：番名、集数、字幕组、分辨率、大小，以及：
  - OpenList 文件页链接，以 inline keyboard 的 URL 按钮呈现（页面自带 PotPlayer / IINA / Infuse 等外部
    播放器按钮）——**主入口**；
  - 直链派生的播放器 scheme：`potplayer://{直链}`、`iina://weblink?url={编码直链}`、
    `infuse://x-callback-url/play?url={编码直链}`。Telegram 的 URL 按钮只接受 http(s) 与 `tg://`，scheme
    只能放在消息正文中；正文中的自定义 scheme 能否点击唤起在 S0 验证，不能则只保留文件页链接。
- 直链使用 OpenList `/d/{路径}`（必要时带签名），每次访问时才换取 PikPak CDN 地址，通知中的链接不会过期。
- iOS 也可直接用 PikPak App 或在 Infuse 中挂载 PikPak WebDAV，无需本功能参与。

### 7.7 健康检查（`health_check`，beat 每 6 小时）

调用 `CloudDriveAdapter.health()`（登录有效、番剧根目录可列）。结果写入监控状态表
`anime_integration_state`，每个监控对象一行：`key`（`drive` 或 `feed:{id}`）、`status`、`since`、
`last_error`、`alerted_status`、`alert_attempts`、`next_alert_at`。

告警只在状态变化时发出，避免刷屏；「状态已变」与「告警已发」分开记录，避免故障同时打断告警发送时
告警永久丢失：

- 状态变化时在同一事务内更新 `status` / `since`，并置 `next_alert_at=now()`。
- `health_check` 结束时与每轮 `maintain_downloads` 对 `status <> alerted_status AND next_alert_at <= now()`
  的行发送当前状态的告警或恢复通知，成功后置 `alerted_status=status`。
- 发送失败按 §6.4 的通知退避推迟；5 次耗尽后改为每 6 小时重试，直到发出。告警是无人值守系统唯一的
  故障信号，不设 `dead`。
- 告警发出前状态已变回 `alerted_status`（短暂故障在告警发出前恢复）时不再发送，可接受。

### 7.8 运维 CLI（`python -m app.anime_admin`）

P0 不做前端界面（前端变更需按 AGENTS.md 走设计门禁）。命令：

- `feeds add|list|update|enable|disable|poll-now`
- `downloads list [--status]`、`downloads retry <id>`（`failed` / `dead` / `skipped` → `pending`）、
  `downloads add --magnet …`（`origin=manual`）
- `releases parse "<标题>"`（调试解析器）
- `health`（立即执行一次健康检查并打印）

## 8. P1 搜索助手

### 8.1 入口与开关

- 聊天发送时的 Run 选项新增 `anime_tools_enabled`，与 `web_search_enabled` 同一机制写入
  `provider_options`。
- 服务端门禁：仅 `ANIME_ALLOWED_USER_EMAILS` 中的用户生效，其余用户该选项被忽略；capabilities 接口
  向前端暴露是否可用。
- 前端开关与提议卡片属于 UI 变更：先在 `design/` 出方案并获批准，再改 `frontend/`。

### 8.2 工具

工具实现 `app/agent/tools/base.py` 的 `Tool` 协议，代码放在 `app/services/anime/tools.py`（它们需要访问
数据库，不能放进内核 `app/agent`）。由 worker 通过 `services/anime` 的工厂构造并以新参数
`extra_tools` 注入 `build_chat_agent`：编排层只调用 `Tool.execute`，仍不直接读数据库。

| 工具 | 副作用 | 说明 |
|---|---|---|
| `anime_resolve(query)` | 无 | bangumi 搜索，返回候选条目（中文名、原名、别名、放送时间、集数） |
| `anime_search_releases(keywords[], sources?, limit?)` | 写 `anime_releases`（仅缓存） | 并发查询蜜柑与爱恋搜索 RSS，按 infohash 合并，返回紧凑表格：短引用、标题、字幕组、分辨率、字幕语言、大小、日期、是否合集、是否已在库 |
| `anime_library_status(query)` | 无 | 查询已下载与进行中的下载任务 |
| `anime_propose_downloads(infohashes[], reason, target_dir?)` | 写 `anime_action_proposals` | 只创建提议，不下载 |

约束：

- `anime_propose_downloads` **只接受数据库中已存在的 infohash**（即确实被搜索到过的资源），不接受
  任意磁链文本，避免模型编造或被注入的磁链进入下载。
- 资源标题、bangumi 简介都是不受信任文本：工具输出以明确的数据边界包裹，系统提示说明其中的指令
  一律不执行（沿用附件的 UNTRUSTED 约定）。
- 番剧模式下 `max_tool_calls` 使用独立上限 `ANIME_MAX_TOOL_CALLS`（默认 8），以支持多关键词搜索。
- 系统提示补充番剧模式说明：先确认作品，再多关键词搜索（中文名、原名、罗马音），按用户偏好筛选，
  给出不超过 3 个候选和理由，最后才提议。

### 8.3 动作提议与确认

表 `anime_action_proposals`：`id`、`public_id`、`user_id`、`run_id`、`conversation_id`、`kind`
（`download`）、`payload`（infohash 列表、目标目录、理由）、`status`（`pending` / `confirmed` /
`rejected` / `expired`）、`expires_at`（创建后 24h）、`decided_at`。

- 工具返回提议的 `public_id`；assistant message 的 metadata 记录提议引用，前端渲染为带「确认 / 取消」的卡片。
- `POST /api/v1/anime/proposals/{public_id}/confirm`：校验归属、未过期、`pending` → **同一事务**内置
  `confirmed` 并为每个 infohash 插入 `anime_downloads(origin=agent) ON CONFLICT DO NOTHING`，提交后投递
  唤醒；重复确认幂等，返回相同结果。`/reject` 同理。
- 之后的执行、通知完全复用 P0 管线。

**设计取舍**：本期不实现「Run 挂起等待审批再恢复」。提议-确认模式让 Run 正常结束，副作用由确定性管线
执行，不需要改 Run 状态机，也不占用 worker。Run 级挂起/恢复（`awaiting_approval`）列入 P2，届时可用同一
提议表作为审批事实源。

## 9. 模块与文件布局

```
app/services/anime/
  __init__.py        # 对外高层 interface
  sources.py         # MikanSource（P0）/ KisssubSource（P1）：RSS 拉取与条目规范化
  infohash.py        # magnet / torrent URL → 小写 hex infohash
  parsing.py         # 标题解析（规则版；P1 增加 LLM 版）
  filters.py         # §7.2 过滤规则
  feeds.py           # 订阅源 claim、拉取入库
  downloads.py       # 下载任务状态机、提交/对账/轮询
  drive.py           # CloudDriveAdapter 协议与错误分类
  openlist.py        # OpenList 实现
  notify.py          # Notifier 协议、Telegram 实现、消息组装
  health.py
  proposals.py       # P1
  tools.py           # P1
app/models/anime.py
app/schemas/anime.py         # P1
app/api/v1/anime.py          # P1：提议确认/拒绝
app/tasks/anime_tasks.py     # 薄入口，只调用 services/anime
app/anime_admin.py           # 运维 CLI
```

模块边界补充（实现时同步到 `docs/architecture/module-boundaries.md`）：`services/anime` 是订阅源、资源、
下载任务、提议的唯一业务拥有者；不调用聊天 provider（P1 的 LLM 标题解析通过注入的窄接口完成）；
`tasks/anime_tasks.py` 不实现状态机。

## 10. 配置与部署

新增环境变量（`.env.example` 同步）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANIME_ENABLED` | `false` | 总开关；关闭时 beat 任务直接返回 |
| `ANIME_ALLOWED_USER_EMAILS` | 空 | P1 工具门禁 |
| `OPENLIST_BASE_URL` | | 服务端访问地址（Docker 网络内） |
| `OPENLIST_PUBLIC_URL` | | 通知中的链接前缀（Tailscale 地址） |
| `OPENLIST_USERNAME` / `OPENLIST_PASSWORD` | | 专用低权限用户 |
| `OPENLIST_OFFLINE_TOOL` | `PikPak` | |
| `ANIME_STORAGE_ROOT` | `/PikPak/Anime` | OpenList 中的番剧根路径 |
| `MIKAN_BASE_URL` | 官方域名 | 故障时改为镜像（§7.2） |
| `KISSSUB_BASE_URL` | 官方域名 | P1 |
| `BANGUMI_API_BASE_URL` / `BANGUMI_USER_AGENT` | | P1 |
| `ANIME_DOWNLOAD_STALL_TIMEOUT_SECONDS` | `86400` | |
| `ANIME_DRIVE_CALL_TIMEOUT_SECONDS` | `30` | 适配器单次 HTTP 调用超时 |
| `ANIME_SUBMIT_LEASE_SECONDS` | `300` | 提交租约；须 ≥ 调用超时 + 60，否则拒绝启动（§6.5） |
| `ANIME_MAX_TOOL_CALLS` | `8` | P1 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | 通知渠道；token 视为凭据 |

部署：

- `compose.yml` / `compose.prod.yml` 新增 `openlist` 服务（数据卷持久化，只连 Docker 内网，宿主机端口
  只绑定 Tailscale 或 127.0.0.1）。
- 新增 `anime-worker`：`celery … worker --queues=anime --concurrency=2`，与邮件队列隔离，避免外部接口
  卡顿拖慢邮件；`task_routes` 增加 `app.tasks.anime_tasks.* → anime`。
- beat 新增 `dispatch-anime-feeds`（60s）、`poll-running-anime-downloads`（60s）、
  `maintain-anime-downloads`（300s）、`anime-health-check`（21600s），均投递到 `anime` 队列。
- `check_download` 的 countdown 消息与其他 anime 任务共用 `anime-worker`；并发 2 足够，单次检查只是
  一次短 HTTP 调用。

## 11. 评测（P1）

目录 `tests/evals/anime/`，不进 CI，手动运行并把结果记录到 handover：

1. **标题解析集**：从真实蜜柑/爱恋数据采集约 200 条标题，人工标注 `series`、`episode`、`group`、
   `resolution`、`subtitle_lang`、`is_batch`。比较规则解析、小模型、大模型的逐字段准确率、延迟和单条成本。
2. **搜索任务集**：约 20 条自然语言请求（如「找某番 BD 合集，简中，优先某组」），每条带脚本可判定的
   期望（候选中至少一个满足：作品正确、合集、简中、组名）。指标：成功率、工具调用次数、token、耗时。
3. 每次改 prompt、工具描述、模型或解析器都重跑，结论写入 handover。

## 12. 可观测性

结构化日志事件：`anime_feed_polled`（新条目数、耗时、是否 304）、`anime_download_transition`
（from/to、尝试次数、错误分类）、`anime_drive_call`（操作、耗时、结果）、`anime_notify_sent`、
`anime_health_changed`、`anime_alert_sent`、`anime_download_stale_writeback`、`anime_proposal_decided`。
URL 中的 token 一律脱敏。

## 13. 分期与验收

### S0 技术验证（实现前，约半天）

| # | 验证项 | 通过标准 |
|---|---|---|
| S0-1 | OpenList 挂载 PikPak 并保持登录 | 放置 48 小时后仍可列目录，无需人工处理 |
| S0-2 | API 发起 PikPak 离线下载 | curl 调用后任务出现在 PikPak，文件落到指定目录；记录端点、字段、任务查询方式。另记录：多个新番资源从提交到 OpenList 显示完成的耗时（决定 §7.4 第一档间隔）；能否一次调用查询全部任务（能则 `check_download` 可合并查询） |
| S0-3 | 重复提交同一 infohash | 记录 PikPak 行为（去重 / 重复文件），决定 §6.5 第 3 点是否可依赖 |
| S0-4 | 播放与通知 | PotPlayer、IINA、Infuse 均能播放 `/d/` 链接；部署服务器能直连 `api.telegram.org`（不能则在实现计划中加代理配置）；Telegram 正文中的自定义 scheme 能否点击唤起 |
| S0-5 | RSS 格式 | 蜜柑个人 RSS、蜜柑搜索 RSS 的条目字段与 infohash 提取方式；记录至少一个可用的蜜柑镜像域名（爱恋搜索 RSS 移到 P1 开工前验证） |
| S0-6 | 云端任务可查询性 | 记录：任务完成 1 小时后、OpenList 重启后能否查到该任务，能否从中取得磁链或 infohash；提交响应或任务详情能否给出落盘名称；文件是否只在下载完成后出现在目录中。据此确定 §6.5 第 4–5 步与 §7.4 `not_found` 兜底的实现 |

S0-1 至 S0-5 任一项不通过，回到本文调整方案后再实现；S0-6 只记录结果，按 §6.5 第 5 步与 §7.4 选择
已定义的降级路径。

### P0 验收

1. 蜜柑「我的番组」有新的一集发布后，在一个拉取周期加若干分钟内收到 Telegram 通知，点击后能在三端之一播放。
   其中云端完成到收到通知的延迟：正常不超过 20 秒；检查消息全部丢失时不超过 2 分钟。
2. 同一资源在多个订阅源、多次拉取中出现，只产生一个下载任务和一条完成通知。
3. 在 `submitting` 状态 `kill -9` anime-worker，重启后经对账不重复提交（以 PikPak 侧任务数核对）。
4. OpenList 停机期间：下载任务按退避重试，健康检查发出一次告警；恢复后自动继续并发出一次恢复通知。
   Telegram 不可达期间发生的状态变化，在恢复后补发。
5. 新增订阅源时不会下载回填窗口之外的旧集。
6. 下载进行中重启 OpenList：已完成的下载收到完成通知，或收到「云端任务已不可查」通知，不报普通下载失败。

### P1 验收

1. 在聊天中说「找某番的 BD 合集，简中」，agent 给出不超过 3 个带理由的候选与一张提议卡片；确认后进入
   下载并收到完成通知。
2. 未确认、拒绝或过期的提议不会产生任何下载任务；重复点击确认结果一致。
3. 非白名单用户发送的 `anime_tools_enabled` 被忽略，工具不出现在模型请求中。
4. 评测集首轮结果（准确率、成本）记录在 handover。

### 测试

- 单元：infohash 规范化、标题解析、过滤规则（含 `episode_dedupe` 对各状态的阻挡规则）、状态机转换
  （假适配器注入 transient/permanent 错误与 `not_found`）、检查间隔档位、通知内容组装、提议确认幂等。
- PG 集成：入库幂等（并发两次 `poll_feed`）、claim 互斥、租约过期回收与对账、fencing（租约被接手后
  旧 worker 写回不生效）、检查链收敛（同一行并发两次 `check_download`，只有一方推进 `next_check_at`、
  只产生一次完成通知）、`poll_running_downloads` 只补投过期行、告警发送失败后补发。
- 外部契约：针对真实 OpenList 的手动 smoke 脚本，不进 CI。
- 现有门禁：`ruff`、`mypy`、`pytest`；P1 前端改动另跑前端检查。

## 14. 后续（P2，不在本期设计范围）

- **MCP**：把 `services/anime` 以 MCP server 暴露，Claude Code / Codex 也能直接「帮我追某番」；为 agent
  内核增加 MCP client，外部工具以同一 `Tool` 协议接入。
- **Run 挂起与恢复**：新增 `awaiting_approval` 状态，审批期间释放 worker，确认后从 transcript 续跑；
  动作提议表作为审批事实源。
- **异常处理 agent**：下载任务 `failed` / `dead` 或「放送后 N 小时仍无资源」时触发 agent，寻找替代资源并
  生成提议。
- **LLM 标题解析入管线**：评测证明收益后，对规则解析失败的标题回退到 LLM。
- **浏览器兜底适配器**：OpenList 驱动失效时的备用写入路径。

## 15. 待确认事项

| # | 问题 | 推荐 |
|---|---|---|
| Q1 | 数据是否按用户隔离 | 否。P0/P1 为单用户运维功能，表不带 `user_id`（提议表除外，用于确认归属）；以后需要多用户再加 |
| Q2 | 通知渠道 | 已定：Telegram Bot，P0 唯一实现；`Notifier` 协议保留，以后可加其他渠道 |
| Q3 | 订阅源管理方式 | P0 只用 CLI，不做前端；P1 再考虑「让 agent 创建订阅源」 |
| Q4 | 标题解析的集数去重是否默认开启 | 开启（`episode_dedupe: true`），只在解析出集数时生效；已有任务失败时不阻挡后来者，并发下的少见重复可接受（§7.2） |
| Q5 | 目标目录按番名分子目录 | 是；解析不出番名时放 `_未分类` |
| Q6 | P1 审批方式 | 提议-确认（§8.3），Run 级挂起放到 P2 |
| Q7 | anime 任务是否独立 worker | 是，独立 `anime` 队列与 `anime-worker`，并发 2 |
| Q8 | OpenList 部署位置 | 与 iChat 同机、同一 Compose，经 Tailscale 访问 |
| Q9 | 是否为本功能写 ADR | 写一篇：「经 OpenList 适配非官方云盘接口，PG 状态行持有下载事实」，在 S0 通过后补 |
