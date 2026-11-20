# 番剧离线下载经 OpenList 适配非官方云盘接口，PG 状态行持有下载事实

番剧追更（`docs/specs/2026-11-18-anime-tracking.md`）需要向 PikPak 发起离线下载，而 PikPak 没有公开的写接口。iChat 不直接调用 PikPak 非官方 API，而是经自托管的 OpenList 提交与查询离线任务，业务代码只依赖 `app/services/anime/drive.py` 的窄协议 `CloudDriveAdapter`，OpenList 是它在 P0 的唯一实现。PikPak 的登录态、直链换取都留在 OpenList 内，iChat 不保存 PikPak 凭据或 CDN 地址。

下载是否发生、处于哪一步，以 `anime_downloads` 行为准：infohash 唯一约束保证同一资源只有一个下载任务；提交前在单独提交的事务中 claim（`lease_owner` fencing），每次提交尝试前先用 `find_existing` 按任务名中的 infohash 与目标路径对账；云端任务只是行上的不透明引用 `cloud_task`。Celery 消息只是唤醒信号，beat 兜底补投。云端任务列表不是事实源：OpenList 重启会清空它，此时按目标目录中的条目（创建时间、`total_bytes` 精确相等、未被其他任务占用）确认文件，确认不了就继续等到停滞上限，以 `cloud_task_missing` 结束而不报普通失败。

接受一个已知的重复窗口：worker 在 `submitting` 崩溃，且恢复前 OpenList 也重启时，`find_existing` 查不到先前的任务，PikPak 又不对同一 infohash 去重（S0-3 实测会落成 `…(1).mp4`），结果是同一目录多一份文件。两者都要落在约 0.1 秒的提交窗口附近，常见于宿主机整体重启；影响只限一个目录里的一份副本，不扩散，不产生错误状态。

## 考虑过的替代方案

- 直接调用 PikPak 非官方 SDK：此前因 SDK 不稳定放弃；接口变动需要改 iChat 代码，OpenList 把这部分维护成本转给社区，并顺带提供文件页、签名直链与播放器入口。
- 以云端任务列表为事实源：OpenList 重启即丢失，且任务详情不给落盘文件名，无法作为完成判定的唯一依据。
- 用目录比对补上重复窗口（提交前先看目录里有没有同名或同大小的文件）：提交前不知道真实文件大小（RSS 声明值误差约 5%），落盘名由种子决定、与标题不同，按时间匹配又会误认同目录中并发下载的其他集，误判代价（漏下一集）比多一份文件更高。
- 浏览器自动化操作 PikPak 网页：更脆弱、更慢，留作 OpenList 驱动失效时的备用实现（P2）。

## 后果

更换云盘或 OpenList 失效时，只需新增 `CloudDriveAdapter` 实现，状态机与表结构不变；但同一时间只能有一个实现写入，避免两套路径重复提交。OpenList 成为需要运维的组件：健康检查每 6 小时一次，状态变化时经 Telegram 告警，且告警发出与否单独记录、失败持续重试。OpenList 用户需要离线下载与「创建目录或上传」权限，基本路径必须设到番剧目录，否则该用户能看到整个 PikPak。宿主机整体重启后，应在 OpenList 中核对最近提交的目录是否出现 `(1)` 副本。
