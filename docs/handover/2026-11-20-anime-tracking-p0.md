# 番剧追更 P0 交接（Mikan RSS → OpenList/PikPak → Telegram）

- 日期：2026-11-20
- 分支：`feat/anime-tracking`
- 规格：[2026-11-18-anime-tracking.md](../specs/2026-11-18-anime-tracking.md)（§16 记录与设计的差异）
- 决策：[ADR 0015](../adr/0015-anime-downloads-via-openlist-adapter.md)
- 一致性原理：[eventual-consistency.md](../learning/eventual-consistency.md)

## 做了什么

无 LLM、无前端的自动追更管线：beat 定时拉取蜜柑个人 RSS → 过滤后为每个资源建下载任务 → 经 OpenList 向
PikPak 提交离线下载 → 自适应间隔检查云端任务 → 定位落盘文件 → Telegram 通知（截图、「打开文件页」按钮、
直链）。OpenList 不可用、订阅源连续失败时发告警，恢复后发恢复通知。

| 位置 | 内容 |
|---|---|
| `app/models/anime.py`、迁移 `20261120_0030` | `anime_feeds`、`anime_releases`、`anime_downloads`、`anime_integration_state` |
| `app/services/anime/feeds.py` | 订阅源 claim（`SKIP LOCKED` + 120 秒租约）、拉取入库（单事务、infohash 幂等）、过滤与 `skip_reason` |
| `app/services/anime/downloads.py` | 提交（`lease_owner` fencing、每次先 `find_existing`）、检查链（`next_check_at` 版本号、未到期丢弃）、定位文件、通知 claim（标题解析不出番名时用文件名补全）、兜底扫描、`retry` / 手动添加 |
| `app/services/anime/health.py` | 状态与「告警已发」分开记录，告警失败无限慢速重试 |
| `app/services/anime/openlist.py` | OpenList v4.2.10 适配器（同步 httpx），错误分类 transient / permanent，401 重新登录一次 |
| `app/services/anime/notify.py` | Telegram（`sendPhoto` / `sendMessage`），消息组装；不发播放器 scheme（见下文「Telegram 与播放器 scheme」） |
| `app/services/anime/sources.py`、`parsing.py`、`filters.py`、`infohash.py` | RSS 拉取（5MB 上限、URL 脱敏）、标题规则解析、过滤规则、infohash 规范化 |
| `app/tasks/anime_tasks.py` | 薄入口；全部在 `anime` 队列，`ANIME_ENABLED=false` 时直接返回 |
| `app/anime_admin.py` | 运维 CLI |
| `compose.yml` / `compose.prod.yml` | `openlist`（`openlistteam/openlist:v4.2.10`）与 `anime-worker`，都在 profile `anime` 下 |

## 上线步骤

1. **OpenList 初始化**（手动，一次）：

   ```bash
   # 新数据卷需先改属主，否则 OpenList（uid 1001）启动即退出
   docker volume create ichat_openlist_data
   docker run --rm -v ichat_openlist_data:/data alpine chown -R 1001:1001 /data
   COMPOSE_PROFILES=anime docker compose -f compose.prod.yml up -d openlist
   docker compose -f compose.prod.yml exec openlist ./openlist admin random   # 取得 admin 初始密码
   ```

   卷名以 `docker volume ls` 中 Compose 实际创建的名字为准（项目名前缀）。在 Web UI 中：admin 改为长随机
   密码；关闭 guest；挂载 PikPak 存储（挂载路径 `/pikpak`，关闭 Web 代理，缓存过期 0）；「设置 → 离线下载」
   配置 PikPak 临时目录；设置签名过期时间（规格 §7.6）；新建 iChat 用户：基本路径 `/pikpak/Anime-Tracker`，
   权限勾选**离线下载**与**创建目录或上传**，长随机密码。
2. **nginx**：OpenList 子域名 server 块尚未写（子域名未定），要求见规格 §10。未配置前通知里的文件页与直链
   在外网打不开，下载与通知本身不受影响。
3. **`.env`**：按 `.env.example`「Anime tracking」一节填写，并加 `COMPOSE_PROFILES=anime`，最后设
   `ANIME_ENABLED=true`。`ANIME_ENABLED=true` 时缺少 OpenList / Telegram 配置会拒绝启动。Telegram 需先对
   bot 执行 `/start`。
4. **迁移与启动**：照常部署（`migrate` 后 `up -d`）；`COMPOSE_PROFILES=anime` 使 `openlist` 与 `anime-worker`
   随之启动。`celery-beat` 只在 `ANIME_ENABLED=true` 时注册 anime 定时任务（否则没有 worker 消费 `anime`
   队列，消息会在 Redis 中堆积），所以改 `.env` 后要重建 beat：`up -d --force-recreate celery-beat anime-worker`。
5. **验证健康**：`docker compose -f compose.prod.yml exec anime-worker python -m app.anime_admin health`。
6. **添加订阅源**（URL 含个人 token，不要写进任何文件或聊天记录）：

   ```bash
   python -m app.anime_admin feeds add --name mikan --url '<个人 RSS URL>' \
     --include '1080p' --include '简繁|简日' --backfill-hours 24
   python -m app.anime_admin feeds poll-now mikan
   python -m app.anime_admin downloads list
   ```

关闭：`ANIME_ENABLED=false` 后重建 `anime-worker` 与 `celery-beat`；行状态保留，重新开启后由兜底扫描续上。

## 运维 CLI

```text
python -m app.anime_admin feeds add|list|update|enable|disable|poll-now
python -m app.anime_admin downloads list [--status S] | retry <public_id> | add --magnet M [--target-dir D]
python -m app.anime_admin releases parse "<标题>"
python -m app.anime_admin health
```

`--include` 可重复，表示全部命中；`--exclude` 可重复，任一命中即跳过。`feeds list` 中 URL 已脱敏。

目录（相对 iChat OpenList 用户的基本路径 `/pikpak/Anime-Tracker`）：订阅源下载到
`{target_dir}/{番名}`，解析不出番名时放 `{target_dir}/Unsorted`；`downloads add` 默认目标目录 `/Manual`。

## 验证

本地（Windows 开发机，PG 容器 `ichat-postgres-1` 在 localhost:5432）：

```powershell
$env:PYTHONUTF8 = '1'
.venv/Scripts/python.exe -m pytest tests/services/anime tests/tasks/test_anime_tasks.py tests/core tests/models -q
.venv/Scripts/ruff.exe check .
.venv/Scripts/mypy.exe app        # Windows 上 files/scanner.py、parsers.py 的 9 个既有错误与本功能无关
.venv/Scripts/alembic.exe upgrade head   # 需把 DATABASE_URL 的主机改为 localhost
```

PG 集成测试（`tests/services/anime/test_pipeline.py`）连接 `ANIME_TEST_DATABASE_URL`（默认本地开发库），
只创建并清理 infohash 前缀 `eeee0000`、名称前缀 `anime-test-` 的行。覆盖：拉取幂等与并发拉取、claim 互斥、
跳过规则、提交 fencing 与对账、transient / permanent / 耗尽、检查链并发收敛为一次通知、未到期检查丢弃、
`not_found` → 继续等待 → `cloud_task_missing`、唯一文件定位、通知重试与 dead、告警失败补发与恢复通知。

`tests/conftest.py` 默认设 `ANIME_ENABLED=false`（进程环境变量优先于 `.env`），本机 `.env` 开启追更时测试
不受影响。

### 真实 smoke（2026-11-20，本地）

本地 OpenList（`openlist-s0`，127.0.0.1:5244，iChat 用户已授予「离线下载」与「创建目录或上传」）+ 真实
PikPak + 真实 Telegram bot，开发库，直接调用服务函数（`add_manual_download` → `submit_download` →
`check_download` 循环 → `notify_download`），不经 Celery：

- 手动磁链只带 infohash 与 tracker（`9d9a3699…`，无 `dn`），目标目录 `/Manual`。
- 提交到完成 10 秒（命中 PikPak 秒传缓存），定位到
  `/Manual/[Nekomoe kissaten][Kusuriya no Hitorigoto][55][1080p][JPTC].mp4`。
- 通知 `sent`：截图 + 番名「Kusuriya no Hitorigoto 第 55 集」、字幕组、分辨率、大小（磁链没有标题，
  番名来自文件名解析）+ 直链 +「打开文件页」按钮。
- 开发库中保留了这一行（`public_id 6239af76-…`），未清理。

脚本在仓库外（`%TEMP%\claude\anime_smoke\smoke.py`），连接参数写死为本地开发环境，不入库。

### Telegram 与播放器 scheme

实测（同日，`sendMessage` + HTML）：正文中的 `potplayer://…`、`iina://…` 链接，Telegram 返回 200，但
`result.entities` 里没有对应的链接实体，客户端显示为不可点击的文字；`https://` 链接正常保留。Telegram
Web 与 Desktop 中点击直链都会跳到浏览器并触发下载，不会唤起播放器。所以通知里**去掉了全部 scheme**，
只保留直链与「打开文件页」按钮（OpenList 文件页自带外部播放器按钮），400 时去掉 scheme 重发的逻辑
也一并删除（规格 §7.6、§16）。

后续若要一键唤起播放器（第 2 步，未做）：在 OpenList 子域名的 nginx server 块里加跳转路径，例如
`/open/potplayer/<路径>?sign=…` → 302 到 `potplayer://https://<子域名>/d/<路径>?sign=…`，通知里以 https URL
按钮呈现。前提：子域名确定；先在 Windows 上用 Win+R 输入 `potplayer://https://example.com/x.mp4` 确认
PotPlayer 已注册该协议。

## 未完成

- **nginx 子域名**与 Cloudflare 配置（规格 §10）；之后可做上面的播放器跳转按钮。
- **规格 §13 P0 验收第 3、6 条**（`submitting` 时 `kill -9` anime-worker、首次检查前重启 OpenList）的实机演练，
  需在 Compose 中跑 `anime-worker`（`COMPOSE_PROFILES=anime`）。
- **S0-1 复查**（11-22 下午）与 S0-4 待测项（三端播放器打开 `/d/` 链接、手机经子域名访问）。
- 最小权限：`api`、`worker` 等其他服务目前也通过 `.env` 拿到 `OPENLIST_PASSWORD` / `TELEGRAM_BOT_TOKEN`；
  若要收紧，需在这些服务中同时置空这两项并设 `ANIME_ENABLED: "false"`（否则配置校验拒绝启动）。
