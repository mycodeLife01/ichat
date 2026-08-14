# 每次模型调用即时签发图片预览 URL

图像 transcript 只保存稳定的安全派生物快照；每次模型调用前，provider 通过注入的 `ImageInputResolver` 批量校验当前上下文并即时签发新的短期 GET URL，tool loop 后续调用和重试也重新签发，任一图片失败则不发起部分 provider 请求。resolver 的 files-service 实现拥有数据库与签名细节，provider 适配器只依赖窄协议，临时 URL 永不进入 transcript 或日志。该决定以 LLM Worker 持有 preview 最小只读签名能力为代价，避免长期 URL、Base64 常驻请求和 provider Files API 生命周期耦合，并确保用户很久后返回仍可重放图片上下文。
