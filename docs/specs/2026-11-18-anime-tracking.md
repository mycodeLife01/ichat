# 番剧追更与搜索助手（Anime tracking）

- 日期：2026-11-18
- 状态：P0 已实现（2026-11-20，见 §16 实现记录）；P1 未实现
- 修订：2026-11-20 补充一致性约束（§5.1、§6.3–§6.5、§7.1、§7.2、§7.4、§7.7、§13）；通知渠道改为
  Telegram（§7.6）；`running` 检查改为自适应轮询（§7.4）；P0 只接入蜜柑，爱恋移到 P1（§2、§7.2）
- 修订：2026-11-20 按 S0 实测结果调整（§13 S0 结果）：适配器改为返回目录条目（§5.1、§5.2）；崩溃恢复
  去掉 PikPak 去重层（§6.5）；`not_found` 改为按目录条目匹配并继续检查（§7.4）；拉取去掉条件 GET、
  pubDate 按 UTC+8 解析（§6.1、§6.2、§7.1）；蜜柑无独立镜像（§2、§7.2）；播放链接签名来源（§7.6）；
  OpenList 改为经 nginx + Cloudflare 公开 HTTPS 访问，不用 Tailscale（§5.2、§7.6、§10、Q8）；完成通知附
  视频截图（§7.6）
- 修订：2026-11-20 P0 实现回写：适配器改为同步接口（§5.1）；mkdir 权限（§5.2）；主键与新增列（§6.2、§6.3）；
  每次提交前都先 `find_existing`（§6.5）；`include` 为「全部命中」、回填窗口每次拉取都生效、被过滤资源
  也落 `skipped` 行（§7.2）；未到期的检查直接丢弃（§7.4）；定位文件下界改为首次 claim 时间（§7.4）；
  去掉播放器 scheme、标题解析不出番名时用文件名补全（§7.6）；去掉 `MIKAN_BASE_URL`、Compose profile（§10）；
  差异汇总见 §16
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
| 蜜柑计划 | 「我的番组」个人 RSS（`/RSS/MyBangumi?token=…`，只返回最近一段时间的条目）、搜索 RSS（`/RSS/Search?searchstr=…`，最多 100 条）、番剧 RSS（`/RSS/Bangumi?bangumiId=…`，不截断） | P0 唯一订阅来源。未找到独立镜像（`mikanime.tv` 只是 302 到 `mikanani.me`），base URL 仍可配置以备换域名；个人 RSS 有时间窗口，停机超过窗口会漏集，补救见 §7.2；个人 RSS 的 token 视为凭据，日志脱敏 |
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
                                         OpenList 文件页 / 直链 <── 点击打开（文件页内选外部播放器）

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
    def submit_offline(self, *, magnet: str, target_dir: str) -> SubmitReceipt: ...
    def get_task(self, ref: CloudTaskRef) -> CloudTaskStatus: ...       # running/completed/failed/not_found + total_bytes
    def find_existing(self, *, infohash: str, target_dir: str) -> CloudTaskRef | None: ...
    def list_dir(self, path: str) -> list[DirEntry]: ...                # 名称、大小、创建时间、播放签名、截图 URL
    def health(self) -> DriveHealth: ...                                 # 登录有效、根目录可列
    def play_links(self, path: str, entry: DirEntry | None) -> PlayLinks: ...  # 文件页 + 直链
```

- 接口是**同步**的：调用方全部是 Celery prefork 任务，使用同步 SQLAlchemy 会话（与邮件、头像 worker 一致），
  异步接口只会在每个任务里多套一层事件循环。`entry` 为 `None`（未取到目录条目）时只返回文件页链接。

- `CloudTaskRef` 对业务不透明（JSON），只由所属适配器解释。云端任务详情不给落盘文件名，只给
  `total_bytes`；`check_download` 每次看到它就写回引用，供 §7.4 的 `not_found` 兜底按大小匹配文件。
- `not_found` 表示云端已查不到该任务（OpenList 重启会清空任务列表），**不等于失败**，处理见 §7.4。
- 落盘文件名由种子决定，与 RSS 标题不同（如标题写「悠哈璃羽字幕社」，文件名为 `[UHA-WINGS]…`），
  不能由标题推出；完成后的文件一律由 `list_dir` 按大小与创建时间确定。
- 所有适配器调用的 HTTP 超时为 `ANIME_DRIVE_CALL_TIMEOUT_SECONDS`，与提交租约的关系见 §6.5。
- 适配器错误分为 `transient`（网络、5xx、限流 → 退避重试）与 `permanent`（磁链非法、目录不存在、
  权限不足 → 直接 dead），由适配器归类，业务不解析错误文案。

### 5.2 OpenList 实现（P0 唯一实现）

- 调用 OpenList HTTP API（v4.2.10 实测）：
  - 登录：`POST /api/auth/login` 取 token，放在 `Authorization` 头（无 `Bearer` 前缀）。
  - 提交：`POST /api/fs/add_offline_download`，`{"path", "urls": [磁链], "tool": "PikPak",
    "delete_policy": "delete_on_upload_succeed"}`；目标目录不存在时先 `fs/get` 探测、再 `fs/mkdir` 创建；响应直接返回
    任务 `id`，任务 `name` 形如 `download magnet:?xt=urn:btih:{infohash} to ({存储绝对路径})`。
  - 查询：`GET /api/task/offline_download/undone` 与 `/done` 各一次即可取得全部任务；`state=1` 运行中、
    `2` 成功、`7` 失败（`error` 为 PikPak 原始文案）。`status` 文案中的「maybe transferring」可忽略：
    文件在任务标为成功前已出现在目录中。
  - 列目录：`POST /api/fs/list`，条目带 `size`、`created`（带时区）与 `sign`。
  - 只用 infohash 拼出的磁链（`magnet:?xt=urn:btih:{infohash}`，不带 tracker）可以正常下载。
- 鉴权：为 iChat 建立**专用 OpenList 用户**，基本路径设为番剧根目录 `/pikpak/Anime-Tracker`（PikPak 根目录下的 `Anime-Tracker`；`/pikpak` 为存储挂载路径），只授予离线下载
  与**「创建目录或上传」**权限（按番名分子目录需要 `fs/mkdir`，缺少时返回 `403 permission denied`，下载任务
  按 permanent 错误直接 `dead`），不使用管理员 token。普通用户可以提交与查询离线任务（实测）。基本路径限制的是 OpenList 虚拟路径，
  设为 `/pikpak` 时该用户能看到整个 PikPak 根目录，所以必须设到番剧目录。
- OpenList 重启后任务列表清空、登录 token 失效：401 时重新登录一次后重试。
- 存储设置：
  - PikPak 存储关闭「Web 代理」，`/d/` 直链以 302 重定向到 PikPak CDN，播放流量不经服务器（实测）。
  - **缓存过期设为 0**。默认目录缓存下，完成的文件要过期后才对 iChat 用户可见，而普通用户没有刷新权限
    （`Refresh without permission`）。
  - 「设置 → 离线下载」中配置 PikPak 临时目录，否则工具列表里没有 `PikPak`。
- 路径：API 中的路径相对于用户基本路径；`/d/` 直链必须用存储绝对路径（基本路径 + 相对路径），否则 401。
  适配器登录后从 `GET /api/me` 读取 `base_path`，不另设配置。
- 网络（P0 取舍：先跑通功能）：OpenList **经现有 nginx + Cloudflare 以独立子域名公开 HTTPS 访问**，手机与
  电脑不需要额外客户端，可与日常代理共存。容器端口不映射到宿主机，只由 nginx 经 Docker 内网转发；iChat
  后端也走 Docker 内网（`OPENLIST_BASE_URL`），不绕公网。
- 公开带来的风险与 P0 缓解：
  - OpenList 全部接口暴露在公网扫描下：admin 与 iChat 用户都用长随机密码；关闭 guest 用户；nginx 对
    `/api/auth/login` 限流；OpenList 跟进安全更新。
  - 签名直链「拿到即可访问」：链接泄露后可被他人下载该文件、消耗 PikPak 流量，但不能浏览网盘或发起下载。
    签名过期策略见 §7.6；必要时在 OpenList 中重置签名密钥使全部旧链接失效。
  - 收紧暴露面（只公开 `/d/`，或改回 Tailscale）列入 P2（§14）。
- 播放流量不经服务器与 Cloudflare：`/d/` 只返回 302，视频直接从 PikPak CDN 下载（实测）。

### 5.3 备选实现（不在本期）

直连 PikPak 非官方 API、浏览器自动化（agent-browser 操作网页）。接口不变即可替换；健康检查失败时的
自动降级不在本期，避免两套路径同时写入。

## 6. 数据模型

迁移 `20261120_0030_anime_tracking.py`。所有表为单用户运维数据（见 §15 Q1），不带 `user_id`。所有表的主键
都是 bigint 自增 `id`（项目约束，`tests/models/test_metadata.py`），业务键用唯一约束表达。

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
| `consecutive_failures` / `last_error` | int / text | 连续失败达阈值告警 |
| `created_at` / `updated_at` | timestamptz | |

### 6.2 `anime_releases`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK | |
| `infohash` | varchar(40) unique | 小写 hex（`CHECK` 校验）；base32 btih 统一转换 |
| `title` | text | 原始标题，**不受信任文本** |
| `source` / `source_url` | varchar / text | 首次发现来源与详情页 |
| `magnet` / `torrent_url` | text null | 至少一个非空；提交时优先磁链，否则由 infohash 构造磁链 |
| `size_bytes` / `published_at` | bigint null / timestamptz null | 均为 RSS 声明值。`size_bytes` 与实际文件可相差约 5%，不能用于匹配文件；蜜柑 pubDate 不带时区，按 Asia/Shanghai 解析 |
| `parsed` | jsonb | `series`、`episode`、`group`、`resolution`、`subtitle_lang`、`is_batch`、`parser`（`regex`/`llm`）、`parser_version` |
| `first_seen_at` | timestamptz | |

资源只增不改（`parsed` 可在解析器升级时重算）。

### 6.3 `anime_downloads`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK；`public_id` | 对外引用 |
| `infohash` | varchar(40) **unique** FK → `anime_releases.infohash` | 幂等键：同一资源只下载一次 |
| `origin` | varchar(16) | `feed` / `agent` / `manual` |
| `feed_id` / `proposal_id` | bigint null | 来源追溯 |
| `target_dir` | text | |
| `status` | varchar(16) | 见 §6.4 |
| `skip_reason` | varchar(64) null | `include` / `exclude` / `batch` / `backfill` / `episode_dedupe`（§7.2） |
| `cloud_task` | jsonb null | 不透明 `CloudTaskRef`；含云端任务 id、观察到的 `total_bytes`、是否已丢失（§7.4） |
| `file_paths` | jsonb null | 完成后的云盘文件路径 |
| `attempt_count` / `next_attempt_at` / `lease_expires_at` / `last_error` | | claim 与退避 |
| `lease_owner` | varchar(255) null | 每次 claim 新生成，写回时校验（fencing，§6.5） |
| `next_check_at` | timestamptz null | 仅 `running` 使用：下一次检查云端任务的时间，同时作为检查链的版本号（§7.4） |
| `first_claimed_at` | timestamptz null | 首次 claim 时间，跨重试保留：结果未知的早先尝试可能已创建云端任务，定位文件的时间下界取它（§7.4） |
| `submitted_at` / `completed_at` | timestamptz null | `submitted_at` 也是自适应检查间隔的计时起点 |
| `notify_status` | varchar(16) | `none` / `pending` / `sent` / `dead`；完成通知与失败通知共用，内容按下载状态生成 |
| `notify_attempts` / `notified_at` | int / timestamptz null | |
| `notify_next_attempt_at` / `notify_lease_expires_at` | timestamptz null | 通知的退避时间与 claim 租约（120 秒），与提交的 `next_attempt_at` / `lease_expires_at` 分开 |

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
4. **对账**：**每次提交尝试**（不只是回收过期租约时）都先调用 `find_existing(infohash, target_dir)`：找到则
   直接置 `running` 并写入引用（同时写 `submitted_at`、`next_check_at`，进入 §7.4 检查链）；找不到才提交。
   transient 重试同样需要它：超时的那次调用可能已在云端创建了任务。
   `target_dir` 使用下载任务创建时落库的值，不重新计算，避免解析器升级后对账到另一个目录。
   `find_existing` 遍历 `undone` 与 `done` 两个任务列表，从任务 `name` 中解析 infohash 与目标路径匹配；
   有多个匹配时取非失败的最新一个。
5. **对账的边界（S0 实测）**：
   - 云端任务列表在 OpenList 进程存活期间保留（含已完成任务），所以**只有 anime-worker 崩溃**（P0 验收
     第 3 条的场景）时对账有效。
   - OpenList 重启会清空任务列表，此时 `find_existing` 返回 `None`。PikPak **不对同一 infohash 去重**，
     重复提交会落成 `…(1).mp4`（S0-3）。
   - 因此「worker 在 `submitting` 崩溃」与「恢复前 OpenList 也重启」同时发生时会多一份文件。两者都发生在
     约 0.1 秒的提交窗口附近，常见于宿主机整体重启。接受这一重复并写入 ADR（Q9）；影响只是同一目录多一份
     文件，不扩散。不用目录比对来补这个洞：提交前不知道文件大小（RSS 声明值误差约 5%），按时间匹配又会
     误认同目录里并发下载的其他集。

通知同理：`notify_status=pending` 且到期、无有效租约的行，用一条 `UPDATE … RETURNING` 原子 claim
（`notify_attempts += 1`、写 `notify_lease_expires_at`），发送后的写回以 `notify_attempts` 为条件；崩溃窗口内
最多重复一次通知（至少一次语义），可接受。

## 7. P0 管线

### 7.1 拉取（`dispatch_due_feeds` → `poll_feed`）

- beat 每 60 秒投递 `dispatch_due_feeds`：`FOR UPDATE SKIP LOCKED` 选出到期且无有效租约的订阅源，
  写租约（120 秒，大于拉取超时与入库耗时）后逐个投递 `poll_feed(feed_id)`。重复拉取不影响正确性
  （入库幂等），租约只用于减少重复请求。
- `poll_feed`：普通 GET，超时 15 秒（蜜柑不返回 ETag / Last-Modified，条件请求也只回 200，不做条件 GET；
  个人 RSS 只有几 KB）；解析 RSS 条目 → 取 infohash（蜜柑条目没有磁链，infohash 即 `enclosure` 种子地址与
  `link` 详情页地址末段的 40 位 hex，已与种子实际 infohash 核对一致）→ 解析标题 → **同一事务内**按发布时间
  从旧到新 `INSERT anime_releases ON CONFLICT DO NOTHING`，再为每个资源 `INSERT anime_downloads ON CONFLICT
  (infohash) DO NOTHING`：通过过滤的为 `pending`，未通过的为 `skipped` 并记 `skip_reason`；更新 `next_poll_at`、
  清租约。被过滤的资源也落一行，使「该资源是否下载」只在首次出现时决定一次，之后改过滤规则不会让旧资源
  突然被下载，需要时用 `downloads retry` 补位。没有 `enclosure` 的条目以 infohash 构造的磁链作为定位符。
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

- `include` / `exclude` 为对原始标题的正则，大小写不敏感；正则在写入时校验可编译并限制长度（各最多 20 条、
  每条 200 字符）。`include` 要求**全部命中**（如 `["1080p", "简繁"]` 表示两者都要有），`exclude` 任一命中即跳过。
- `skip_batch`：解析为合集的资源记为 `skipped`。
- `episode_dedupe`：同一 `(series, episode)` 已存在状态为 `pending` / `submitting` / `running` /
  `completed` 的下载任务时，后来者记为 `skipped`（避免同一集不同字幕组、不同分辨率重复下载）；已有任务为
  `failed` / `dead` / `skipped` 时不阻挡，后来者正常进入 `pending`。解析不出集数时不做该去重。
  - 该判定是先查后插，没有唯一约束保护：两个订阅源被并发拉取且含同一集的不同资源时，可能各产生一个
    下载任务。P0 只有蜜柑单一订阅源，基本不会发生；P1 加入爱恋备用订阅源后接受这种少见的重复，不加锁。
  - 已跳过的资源不会在先前任务失败后自动补位：失败通知列出同集被跳过资源的 `public_id`，可经
    `downloads retry` 手动补位；自动补位属于 P2 异常处理 agent。
- `backfill_hours`：发布时间早于「订阅源创建时间 − backfill_hours」的资源只入库为 `skipped`，防止添加订阅源时
  一次性下载大量旧集。该判定**每次拉取都生效**而不只在首次：首次拉取失败、或个人 RSS 稍后才返回更旧的条目
  时同样不会下载旧集；下限固定为创建时间，正常追更的新集不受影响。

蜜柑「我的番组」已在站内选好番剧与字幕组，P0 只依赖它，订阅源通常只有一个。但同一字幕组常对同一集发多个
版本（如简繁内封、繁体内嵌、简体内嵌），个人 RSS 中同一集可有 4 条，所以仍需 `include` / `exclude` 选定
版本，`episode_dedupe` 兜底。条目不带字幕组 ID，字幕组只能从标题解析。

蜜柑不可用、或拉取中断时间超过个人 RSS 窗口时的处置（人工，不自动切换）：

1. 订阅源连续失败 5 次后收到告警（§7.1）。
2. 已知可用的新域名时，`feeds update --url` 换域名，个人 RSS token 与站内字幕组选择不变。目前未找到独立镜像。
3. 恢复后若中断超过个人 RSS 窗口，按番剧 RSS（`/RSS/Bangumi?bangumiId=…`，不截断）临时 `feeds add`
   补齐漏掉的集，设置 `backfill_hours` 覆盖中断时长，补齐后删除。
4. 蜜柑长时间不可用时，P1 起可 `feeds add` 爱恋关键词订阅源作为临时备用；必须设置 `include` / `exclude`，
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

**检查间隔**：PikPak 对新番资源通常 10–30 秒内完成离线（S0-2 实测 300–480MB 单集 6–8 秒），检查前密后疏，按提交后经过的时间
（`now − submitted_at`）决定下一次间隔：

| 提交后经过 | 间隔 | 该段约检查次数 |
|---|---|---|
| 0–2 分钟 | 10 秒 | 12 |
| 2–10 分钟 | 30 秒 | 16 |
| 10–60 分钟 | 2 分钟 | 25 |
| 1–24 小时 | 10 分钟 | 约 138 |

档位为代码常量，不做配置。卡满 24 小时停滞上限的任务共检查约 190 次。一次 `undone` + `done` 查询即可
取得全部任务，实现可以让同一轮到期的多个 `check_download` 共用一次查询，但正确性不依赖它。

**`check_download(public_id)`**：

1. 读取行；不是 `running`，或 `next_check_at` 晚于当前时间 2 秒以上（尚未到期）时直接结束。记下本次读到的
   `next_check_at` 为 `:observed`。未到期判定防止检查链分叉：兜底补投的消息在正常 countdown 推进之后才执行时，
   读到的是新版本号，若不丢弃就会再投一条 countdown，形成两条长期并存的检查链。
2. 调用 `get_task`（只读，重复检查无害）；引用已标记丢失时跳过，直接按 `not_found` 处理。
3. 按结果写回，所有写回都带条件 `WHERE status='running' AND next_check_at=:observed`：
   - `running` 且未超停滞上限：写新的 `next_check_at`（及首次观察到的 `total_bytes`），影响 1 行才投递
     下一条 countdown 消息；
   - `completed`：按下文「定位文件」确定 `file_paths`，写 `completed_at`，置 `completed`、
     `notify_status=pending`、`next_check_at=NULL`，提交后投递 `notify_download`；
   - `failed` 或超过停滞上限：置 `failed`、`notify_status=pending`、`next_check_at=NULL`；
   - `not_found`：按「定位文件」查目标目录。找到唯一匹配时按 `completed` 处理；否则在引用中标记丢失，
     按正常间隔继续检查（PikPak 侧的下载不受 OpenList 重启影响，文件可能稍后出现）；超过停滞上限仍未
     找到时置 `failed`，`last_error=cloud_task_missing`，失败通知写明「云端任务已不可查，文件可能已在
     目录中，请核对」，与普通下载失败区分。
4. 条件不成立（影响 0 行）说明另一条检查链已推进或已处理该行：不写、不投递，直接结束。

**定位文件**：`list_dir(target_dir)` 中满足以下全部条件的条目（文件或文件夹）：

- `created ≥ first_claimed_at − 60s`（60 秒容忍时钟偏差；`created` 带时区，实测落在提交与任务完成之间）。下界取
  首次 claim 而不是 `submitted_at`：结果未知的早先尝试可能已创建云端任务，文件可能早于本次进入 `running`；
- 未出现在其他下载任务的 `file_paths` 中；
- 引用中已有 `total_bytes` 时，大小与之**完全相等**（实测一致）。

落盘形态（实测）：单文件种子直接落成文件；多文件种子落成一个以种子名命名的文件夹，视频在其中。
`fs/list` 中文件夹条目的 `size` 为 0，所以对 `created` 满足条件的文件夹再列一次，以其中文件 `size` 之和
作为大小（实测 4 集合集之和与 `total_bytes` 逐字节相等）。匹配到文件夹时 `file_paths` 记文件夹内的各个
文件路径，通知的截图与直链取第一个视频文件。

`completed` 分支下有多个匹配时取 `created` 最早者并记日志；`not_found` 分支只接受唯一匹配，宁可继续
等待也不误认同目录中并发下载的另一集。文件夹最多向下列 3 层。`completed` 分支找不到匹配时仍置 `completed`
（`file_paths` 为空），通知写明「未在目标目录定位到文件，请在 OpenList 中核对」：云端已报成功，不应因定位
失败而报下载失败。

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
落到 `{feed.target_dir}/Unsorted`。P1 的提议可显式指定目录。

### 7.6 通知与播放链接

- `Notifier` 协议，P0 唯一实现为 Telegram Bot，发往 `TELEGRAM_CHAT_ID`（需先在 Telegram 中对 bot 执行
  `/start`）。完成通知有截图时用 `sendPhoto`（文字作为 HTML caption），否则与失败通知、告警一样用
  `sendMessage`（HTML 格式）。关闭链接预览：预览会让 Telegram 服务器抓取签名直链，触发一次
  CDN 下载，并把签名链接交给第三方；文件页需要登录，预览也没有内容。
- Bot token 位于请求 URL 路径中（`/bot{token}/sendMessage`），视为凭据：日志、异常信息与 CLI 输出中
  一律脱敏，HTTP 客户端的请求日志不得记录完整 URL。
- 完成通知内容：截图（有则发）、番名、集数、字幕组、分辨率、大小，以及：
  - OpenList 文件页链接，以 inline keyboard 的 URL 按钮呈现（页面自带 PotPlayer / IINA / Infuse 等外部
    播放器按钮）——**主入口**。guest 已关闭，首次在某个浏览器打开需登录 OpenList（用自己的账号，不是
    iChat 用户）；
  - 正文中的「直链」链接（`/d/` 签名链接，见下文）。
  - **不放播放器 scheme**（`potplayer://`、`iina://`、`infuse://`）。Telegram 的 URL 按钮只接受 http(s) 与
    `tg://`；正文里的自定义 scheme 链接 Telegram 照常返回 200，但会静默丢弃该链接实体，只剩不可点击的
    文字（S0-4，2026-11-20 实测）。若以后需要一键唤起播放器，做法是在 OpenList 子域名上加 nginx 跳转路径
    （如 `/open/potplayer/<路径>?sign=` → 302 到 `potplayer://https://<子域名>/d/<路径>?sign=`），以 https
    URL 按钮呈现；属于部署后的增强，不在 P0 范围。
- 番名与集数取自 RSS 标题解析；手动添加的磁链只有 `dn`（或连 `dn` 都没有）、解析不出番名时，用定位到的
  第一个视频文件名（去扩展名）重新解析，解析得到的字段优先，其余沿用原值。
- 截图：PikPak 为视频自动生成截图，`fs/list` 条目的 `thumb` 字段是其 CDN 地址（实测 720×405 JPEG，无需
  认证即可下载，内容为视频中的一帧，可能是 OP 或剧情画面）。
  - `notify_download` 发送前调用一次 `list_dir(target_dir)`，按 `file_paths` 中的文件名取当前的 `sign` 与
    `thumb`。在发送时现取而不是沿用完成检查时的结果：截图可能在完成后才生成，签名也以当时为准。
  - worker 下载截图（限 5MB、超时 10 秒）后以 multipart 上传给 `sendPhoto`，不把 PikPak 的地址交给
    Telegram：不依赖该地址的有效期，也不向第三方暴露。
  - `thumb` 为空、下载失败或 caption 超过 1024 字符（按解析后的可见文本计）时，退回 `sendMessage` 纯文字
    通知，不等待截图、不因此重试。实测提交后约 95 秒查看时，合集中 4 个文件均已有截图；更早时刻未测，
    且该资源命中 PikPak 秒传缓存，冷门资源可能更慢。实现后按 `notify_download` 无截图的比例再决定是否
    短暂延后发送。
- 直链使用 OpenList `/d/{存储绝对路径}?sign={签名}`，每次访问时才换取 PikPak CDN 地址。签名规则（实测）：
  - 签名**只能取 `fs/list` 条目中的 `sign`**；同一文件 `fs/get` 返回的 `sign` 在 `/d/` 上一律
    `sign invalid`，与基本路径无关。取用时机见上条「截图」。
  - 路径必须是存储绝对路径（含用户基本路径，见 §5.2），路径段逐段 URL 编码。
  - 签名后缀 `:0` 表示永不过期，此时通知中的链接长期有效；若在 OpenList 设置了链接过期时间，旧通知中的
    链接会失效，需要从文件页重新打开。OpenList 公开部署（§5.2）下推荐设置过期时间（如 30 天）：文件页
    是主入口，过期只影响旧通知正文里的直链。部署时确定并写入部署文档。
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
| `OPENLIST_PUBLIC_URL` | | 通知中的链接前缀（OpenList 公开子域名，HTTPS） |
| `OPENLIST_USERNAME` / `OPENLIST_PASSWORD` | | 专用低权限用户 |
| `OPENLIST_OFFLINE_TOOL` | `PikPak` | |
| `ANIME_STORAGE_ROOT` | `/` | 番剧根路径，相对于 iChat 用户的基本路径（基本路径本身设为番剧目录，§5.2） |
| `KISSSUB_BASE_URL` | 官方域名 | P1 |
| `BANGUMI_API_BASE_URL` / `BANGUMI_USER_AGENT` | | P1 |
| `ANIME_DOWNLOAD_STALL_TIMEOUT_SECONDS` | `86400` | |
| `ANIME_DRIVE_CALL_TIMEOUT_SECONDS` | `30` | 适配器单次 HTTP 调用超时 |
| `ANIME_SUBMIT_LEASE_SECONDS` | `300` | 提交租约；须 ≥ 调用超时 + 60，否则拒绝启动（§6.5） |
| `ANIME_MAX_TOOL_CALLS` | `8` | P1 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | | 通知渠道；token 视为凭据 |

部署：

- `compose.yml` / `compose.prod.yml` 新增 `openlist` 服务（镜像固定 `openlistteam/openlist:v4.2.10`，数据卷
  `openlist_data` 持久化，只连 Docker 内网，`compose.prod.yml` 中不映射宿主机端口；本地 `compose.yml` 只绑定
  127.0.0.1:5244 便于初始化）。`openlist` 与 `anime-worker` 都放在 Compose profile `anime` 下：服务器 `.env`
  中设 `COMPOSE_PROFILES=anime` 后才会随部署启动，未初始化 OpenList 前不影响现有部署。OpenList v4.1 起容器以 uid 1001
  运行，新建数据卷需先 `chown 1001:1001`，否则启动即退出。
- `deploy/nginx.conf` 新增 OpenList 子域名的 server 块：复用现有 Cloudflare real-IP 配置与源站防火墙规则，
  反代到 `openlist:5244`；`/api/auth/login` 加 `limit_req`；证书需覆盖该子域名。Cloudflare 侧为该子域名
  开启代理，`/d/*` 不缓存（302 响应带签名）。
- OpenList 初始化（部署文档中列为手动步骤）：admin 改为长随机密码、关闭 guest、挂载 PikPak 存储（关闭 Web
  代理、缓存过期 0）、设置 PikPak 离线临时目录、设置签名过期时间（§7.6）、创建 iChat 用户（基本路径为番剧
  目录、只开离线下载权限、长随机密码）。
- 新增 `anime-worker`：`celery … worker --queues=anime --concurrency=2`，与邮件队列隔离，避免外部接口
  卡顿拖慢邮件；`task_routes` 增加 `app.tasks.anime_tasks.* → anime`。
- beat 新增 `dispatch-anime-feeds`（60s）、`poll-running-anime-downloads`（60s）、
  `maintain-anime-downloads`（300s）、`anime-health-check`（21600s），均投递到 `anime` 队列；只在
  `ANIME_ENABLED=true` 时注册，避免未启用 `anime-worker` 时消息在 Redis 中堆积。
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

结构化日志事件：`anime_feed_polled`（条目数、新条目数、耗时）、`anime_download_transition`
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
| S0-4 | 播放与通知 | PotPlayer、IINA、Infuse 均能播放 `/d/` 链接；部署服务器能直连 `api.telegram.org`（不能则在实现计划中加代理配置）；Telegram 正文中的自定义 scheme 能否点击唤起；手机在日常网络（开着代理）下经公开子域名打开文件页与 `/d/` 链接 |
| S0-5 | RSS 格式 | 蜜柑个人 RSS、蜜柑搜索 RSS 的条目字段与 infohash 提取方式；记录至少一个可用的蜜柑镜像域名（爱恋搜索 RSS 移到 P1 开工前验证） |
| S0-6 | 云端任务可查询性 | 记录：任务完成 1 小时后、OpenList 重启后能否查到该任务，能否从中取得磁链或 infohash；提交响应或任务详情能否给出落盘名称；文件是否只在下载完成后出现在目录中。据此确定 §6.5 第 4–5 步与 §7.4 `not_found` 兜底的实现 |

S0-1 至 S0-5 任一项不通过，回到本文调整方案后再实现；S0-6 只记录结果，按 §6.5 第 5 步与 §7.4 选择
已定义的降级路径。

**S0 结果（2026-11-20，开发机 Docker 中的 OpenList v4.2.10 + 正式 PikPak 账号）**：

| # | 结果 | 结论与落点 |
|---|---|---|
| S0-1 | 进行中 | 11-20 16:44 挂载，11-22 下午复查。部署服务器上重新登录 PikPak 时另观察是否触发验证码或设备限制 |
| S0-2 | 通过 | 普通用户可提交与查询；只带 infohash 的磁链可下载；两集 300–480MB 提交到完成 6–8 秒（§7.4 第一档 10 秒不变）；一次 `undone` + `done` 查询取得全部任务；需配置 PikPak 临时目录、缓存过期设 0（§5.2） |
| S0-3 | 不通过 | PikPak **不去重**，重复提交落成 `…(1).mp4`；§6.5 去掉该降级层，改为接受并写 ADR |
| S0-4 | 部分通过 | 开发机与部署服务器均可直连 `api.telegram.org`；`/d/` 链接在浏览器中 302 到 PikPak CDN；签名只能取自 `fs/list`（§7.6）；`fs/list` 的 `thumb` 为可匿名下载的视频截图，提交后约 95 秒已生成（§7.6）；基本路径设为 `/pikpak/Anime-Tracker` 时，子文件夹内文件的 `fs/list` 签名直链仍 302。Telegram 正文中的自定义 scheme 链接**不可点击**：`sendMessage` 返回 200，但 `potplayer://`、`iina://` 链接实体被静默丢弃，只有 https 链接保留（2026-11-20，§7.6 已去掉 scheme）；本地端到端 smoke 通过（手动磁链提交到完成约 12 秒，截图通知送达）。待测：三端播放器打开 `/d/` 链接、手机经公开子域名访问（部署后） |
| S0-5 | 部分通过 | infohash 取自 `enclosure` / `link` 末段并与种子核对一致；无 ETag（§7.1）；pubDate 为 UTC+8 无时区（§6.2）；搜索 RSS 上限 100 条，个人 RSS 只返回最近一段；**未找到独立镜像**（§2、§7.2） |
| S0-6 | 已记录 | OpenList 重启后任务列表清空、token 失效；任务详情无落盘文件名，只有 `total_bytes`，与文件 `size`（多文件种子为文件夹内文件之和）完全相等；单文件种子落成文件、多文件种子落成文件夹；`created` 落在提交与完成之间（§6.5 第 5 步、§7.4 定位文件） |

S0 中可在开发机完成的验证已全部完成；其余各项见上表「待测」与 S0-1。

### P0 验收

1. 蜜柑「我的番组」有新的一集发布后，在一个拉取周期加若干分钟内收到 Telegram 通知，点击后能在三端之一播放。
   其中云端完成到收到通知的延迟：正常不超过 20 秒；检查消息全部丢失时不超过 2 分钟。
2. 同一资源在多个订阅源、多次拉取中出现，只产生一个下载任务和一条完成通知。
3. 在 `submitting` 状态 `kill -9` anime-worker（OpenList 不重启），重启后经对账不重复提交（以目标目录中
   无 `(1)` 副本核对）。
4. OpenList 停机期间：下载任务按退避重试，健康检查发出一次告警；恢复后自动继续并发出一次恢复通知。
   Telegram 不可达期间发生的状态变化，在恢复后补发。
5. 新增订阅源时不会下载回填窗口之外的旧集。
6. 提交后、首次检查前重启 OpenList：经「定位文件」收到完成通知；找不到文件时继续检查，直到停滞上限才发
   「云端任务已不可查」通知，不报普通下载失败。

### P1 验收

1. 在聊天中说「找某番的 BD 合集，简中」，agent 给出不超过 3 个带理由的候选与一张提议卡片；确认后进入
   下载并收到完成通知。
2. 未确认、拒绝或过期的提议不会产生任何下载任务；重复点击确认结果一致。
3. 非白名单用户发送的 `anime_tools_enabled` 被忽略，工具不出现在模型请求中。
4. 评测集首轮结果（准确率、成本）记录在 handover。

### 测试

- 单元：infohash 规范化（含从蜜柑 `enclosure` / `link` 提取）、pubDate 按 UTC+8 解析、标题解析、过滤规则
  （含 `episode_dedupe` 对各状态的阻挡规则）、状态机转换（假适配器注入 transient/permanent 错误与
  `not_found`）、检查间隔档位、定位文件（时间下界、排除他人文件、`total_bytes` 精确匹配、多匹配）、
  `find_existing` 解析任务 `name`、直链拼接（基本路径前缀、逐段编码、`fs/list` 签名）、通知内容组装（有无截图、caption 超长退回纯文字）、
  提议确认幂等。
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
- **收紧 OpenList 暴露面**：反代只放行 `/d/*`，管理界面与 API 只在内网或 SSH 隧道访问；代价是通知主入口
  改为直链（没有文件页）。或在手机代理与 Tailscale 能共存时改回 Tailscale。

## 15. 待确认事项

| # | 问题 | 推荐 |
|---|---|---|
| Q1 | 数据是否按用户隔离 | 否。P0/P1 为单用户运维功能，表不带 `user_id`（提议表除外，用于确认归属）；以后需要多用户再加 |
| Q2 | 通知渠道 | 已定：Telegram Bot，P0 唯一实现；`Notifier` 协议保留，以后可加其他渠道 |
| Q3 | 订阅源管理方式 | P0 只用 CLI，不做前端；P1 再考虑「让 agent 创建订阅源」 |
| Q4 | 标题解析的集数去重是否默认开启 | 开启（`episode_dedupe: true`），只在解析出集数时生效；已有任务失败时不阻挡后来者，并发下的少见重复可接受（§7.2） |
| Q5 | 目标目录按番名分子目录 | 是；解析不出番名时放 `Unsorted` |
| Q6 | P1 审批方式 | 提议-确认（§8.3），Run 级挂起放到 P2 |
| Q7 | anime 任务是否独立 worker | 是，独立 `anime` 队列与 `anime-worker`，并发 2 |
| Q8 | OpenList 部署位置 | 已定：与 iChat 同机、同一 Compose，经现有 nginx + Cloudflare 以子域名公开 HTTPS 访问（§5.2）；不用 Tailscale，因为手机需与日常代理共存 |
| Q9 | 是否为本功能写 ADR | 已写：[ADR 0015](../adr/0015-anime-downloads-via-openlist-adapter.md)，含 §6.5 第 5 步接受的重复下载窗口 |

## 16. P0 实现记录（2026-11-20）

代码：`app/services/anime/`、`app/tasks/anime_tasks.py`、`app/anime_admin.py`、`app/models/anime.py`、迁移
`alembic/versions/20261120_0030_anime_tracking.py`；测试 `tests/services/anime/`（纯函数、mock HTTP 适配器、
PG 集成）、`tests/tasks/test_anime_tasks.py`。上线步骤与验证命令见
[handover](../handover/2026-11-20-anime-tracking-p0.md)。

与实现前设计的差异（已回写到对应章节）：

| 位置 | 设计 | 实现 | 原因 |
|---|---|---|---|
| §5.1 | 异步适配器接口 | 同步接口 | 调用方都是 prefork Celery 任务 + 同步会话 |
| §5.2 | 只授予离线下载权限 | 另需「创建目录或上传」 | 按番名分子目录要 `fs/mkdir` |
| §6.2 | `infohash` 为主键 | bigint `id` 主键 + `infohash` 唯一 | 项目约束所有主键为 bigint |
| §6.3 | — | 新增 `skip_reason`、`first_claimed_at`、`notify_next_attempt_at`、`notify_lease_expires_at` | 跳过原因可查；定位文件下界；通知退避与租约独立于提交 |
| §6.5 | 只在回收过期租约时 `find_existing` | 每次提交尝试前都调用 | transient 超时的那次也可能已创建任务 |
| §7.1 | 只为通过过滤的资源建下载行 | 全部建行，未通过的为 `skipped` | 「是否下载」只决定一次；可 `retry` 补位 |
| §7.2 | `include` 语义未定；回填只在首次拉取 | `include` 全部命中；回填每次拉取都生效 | 多条件组合更常用；首次拉取失败时仍能挡住旧集 |
| §7.4 | 检查不判断是否到期 | 未到期（>2 秒）直接丢弃 | 防止检查链分叉为两条长期并存的链 |
| §7.4 | 定位下界 `submitted_at − 60s` | `first_claimed_at − 60s` | 同 §6.3 |
| §7.6 | 正文放播放器 scheme | 不放 scheme，只留直链与文件页按钮；标题解析不出番名时用文件名补全；未定位到文件仍发完成通知 | S0-4 实测 Telegram 静默丢弃非 http(s) 链接；手动磁链常只有 infohash |
| §10 | `MIKAN_BASE_URL` | 去掉 | 蜜柑只用个人 RSS 完整 URL，换域名用 `feeds update --url` |
| §10 | 服务随部署启动 | Compose profile `anime` 显式开启；beat 只在启用时注册 anime 任务 | OpenList 需先手动初始化；未启用时 `anime` 队列无人消费 |

未完成（P0 范围内，等外部条件）：

- `deploy/nginx.conf` 的 OpenList 子域名 server 块（子域名未定）。
- S0-1 复查（11-22）与 S0-4 待测项（部署后）。
- §13 P0 验收第 3、6 条（`kill -9` anime-worker、OpenList 重启）的实机演练。
