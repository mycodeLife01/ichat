# 将安全预览与附件原件隔离存储

iChat 将安全图片 `preview` 迁入独立私有 bucket，并以 `model_preview_private` 显式标识位置；LLM Worker 只持有该 bucket 的 GET/签名权限，无法在凭证层读取 canonical 原件。迁移采用复制、哈希校验、事务切换与删除补偿，只有积压和失败归零且真实 GPT 冒烟成功后才开启视觉白名单；回滚只关闭白名单，不回迁对象。该决定增加 bucket、凭证和迁移运维成本，以确保“原件不进入 provider”是基础设施权限边界，而不只是应用代码约定。
