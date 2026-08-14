# ClamAV 启动与签名就绪修复

日期：2026-08-13

## 故障

ClamAV 使用持久化 `/var/lib/clamav` 卷时，官方镜像会把 `freshclam` 放到后台，再立即启动
clamd。若卷内签名需要更新，freshclam 可能先写入新数据库，却因 clamd socket 尚未创建而
无法通知重载；clamd 随后仍可能以内存中的旧签名提供扫描。原 Compose 健康检查只执行普通
扫描，因此这种状态仍会被标记为 healthy，并放行 file-worker。应用自己的 VERSION 年龄检查
会正确 fail-closed，但上传会进入 30 秒、5 分钟的基础设施重试。

## 修复

- `deploy/clamav/entrypoint.sh` 在官方 `/init` 前同步执行一次 freshclam，最多尝试三次；
  启动更新使用移除 `NotifyClamd` 的临时配置，因为此阶段 clamd 按设计尚未运行。
- 更新失败不会绕过安全边界：容器仍启动 clamd，但新的健康检查会阻止旧签名进入 healthy，
  后台 freshclam 成功并由 clamd 加载后才可恢复。
- `deploy/clamav/healthcheck.sh` 直接通过 clamd wire protocol 查询内存 VERSION，与
  `freshclam --version` 读取的磁盘版本比较，并使用与应用相同的
  `CLAMAV_SIGNATURE_MAX_AGE_SECONDS` 校验签名年龄，最后再执行真实扫描探针。
- 签名日期解析兼容本地 Debian 镜像的 GNU date 与生产镜像的 BusyBox date。
- 本地和生产 Compose 使用同一脚本；生产部署 workflow 显式同步两个脚本。

## 验证

```bash
pytest tests/core/test_compose_config.py tests/core/test_deploy_workflow.py -q
docker compose config --quiet
docker compose -f compose.prod.yml config --quiet
docker compose up -d --force-recreate clamav
docker compose exec -T clamav /bin/sh /usr/local/bin/ichat-clamav-healthcheck.sh
docker compose exec -T clamav env CLAMAV_SIGNATURE_MAX_AGE_SECONDS=1 \
  /bin/sh /usr/local/bin/ichat-clamav-healthcheck.sh  # 预期非零
```
