# 公开分享授予附件预览与下载能力

分享页的附件必须与聊天页在视觉与交互上完全一致，因此持有分享 token 的匿名访问者可以换取附件的短时签名 URL：图片走派生 preview 对象并支持预览弹窗，非图片与预览弹窗内的下载按钮走 canonical 原件。该决定取代了此前「公开快照只展示脱敏占位、任何匿名许可请求均拒绝」的边界（见 `.scratch/file-upload/issues/10-share-title-privacy.md` 第 3 条与 `docs/architecture/frontend.md` 附件章节的旧表述）。

威胁模型随之改变：**分享 token 从「快照文本的凭证」升级为「附件内容的凭证」**，token 泄露等于对应附件的原件泄露。为把暴露面限制在可接受范围，边界由以下机制共同保护，任一缺失都视为回归：

- 快照内保存 `file_id`，但公开响应只返回不透明的 `ref`（`{message_index}-{position}`），`SharedAttachmentResponse` 不声明 `file_id`，客户端始终拿不到任何内部标识；服务端凭 `ref` 在快照内反查。
- 读取端点为匿名的 `POST /api/v1/share/{token}/attachments/{ref}/read-url`，撤销、过期、会话软删除、拥有者停用（账号注销）、资产进入删除流程任一发生即 404，且不区分失败原因。
- 快照仍是 edit-proof 的授权凭据：会话后续编辑会归档消息但不破坏既有分享，这是与 owner 读取路径（`issue_read_url` 要求 live message 可见）刻意不同的地方。
- 引入公开读取能力之前生成的快照没有 `file_id`/`ref`，永久保持不可读，不做回填。
- 双维度滑动窗口限流（token 维度按 role 区分，IP 维度合并），限流在解析 token 之前执行，因此枚举探测同样消耗预算；Redis 不可用时 fail-closed 返回 503。
- 签名 TTL 沿用文件模块既有值（preview `files_preview_api_ttl_seconds`，download `files_download_ttl_seconds`），不为分享放宽。
- 快照只复制 `width`/`height` 两个 stats 字段用于布局，派生文档元数据（页数等）不进入快照。

创建含附件分享时的隐私确认继续保留，且其含义扩大：确认项现在既覆盖「助手回复可能包含附件信息」，也覆盖「附件本身可被链接持有者预览与下载」。
