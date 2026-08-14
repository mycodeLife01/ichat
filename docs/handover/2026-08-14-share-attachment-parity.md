# 分享页附件与聊天页视觉/能力对齐

## 目标与结论

分享页此前用一套独立的旧版占位卡渲染附件（`rounded-item` 小卡、单色 18px 图标、附件塞在用户
气泡内部），与聊天页的图片网格与 320px 文件卡完全是两套视觉。本次让分享页与聊天页共用同一套
附件布局，并按用户决定放开匿名读取能力：图片显示真实缩略图并支持预览弹窗，非图片与预览弹窗
内的下载按钮可下载原件。

隐私边界随之变更，已记录为 ADR `0011-grant-attachment-reads-to-public-shares.md`；
`.scratch/file-upload/issues/10-share-title-privacy.md` 顶部加了修订说明，
`docs/architecture/frontend.md` 附件章节同步更新。**分享 token 现在是附件内容的凭证**，
泄露 token 等于泄露对应附件原件。

## 后端改动

- `app/schemas/files.py`：`SharedAttachmentResponse` 扩展为 `ref` / `position` /
  `model_input_kind` / `preview_available` / `stats`；新增 `ShareAttachmentReadRequest`。
  快照里另存 `file_id`，但该字段未在 schema 声明，因此永远不会序列化给公开调用方。
- `app/services/shares/service.py`：
  - `create_share` 改为复用 `attachment_responses`，快照因此继承聊天页同一套
    category/geometry/preview 事实；`_snapshot_attachments` 生成 `ref = {message_index}-{position}`，
    `stats` 只复制 `width`/`height`。`file_id` 为 NULL（资产已回收）的附件不带 ref，永久不可读。
  - 新增 `get_public_share_attachment_read_url`：撤销、过期、会话软删除、拥有者停用、资产进入
    删除流程任一命中即 404；快照仍是 edit-proof 授权凭据，会话后续编辑不破坏既有分享。
  - 新增 `guard_public_read_rate_limit`：双维度滑动窗口，Redis 不可用 fail-closed 503。
- `app/services/files/service.py`：抽出 `_sign_file_read_url`（对象解析 + 签名），
  `issue_read_url` 与新增的 `issue_shared_attachment_read_url` 共用。后者不做 live-message
  可见性校验（授权来自快照），但仍要求资产属于会话拥有者、purpose 正确、未删除且已绑定。
- `app/api/v1/share.py`：新增匿名 `POST /api/v1/share/{token}/attachments/{ref}/read-url`，
  限流在解析 token 之前执行，所以枚举探测同样消耗预算。
- `app/core/config.py`：新增六个限流设置（见下）。未加灰度开关（按用户要求）。

### 限流参数

| 维度 | 默认值 | 说明 |
|---|---|---|
| token × preview | 120 / 300s | 前端读 URL 缓存 4 分钟，一页每图 4 分钟内仅一次请求 |
| token × download | 30 / 3600s | 原件暴露面最大，卡得比 preview 紧 |
| IP（两种 role 合计） | 300 / 3600s | 防爬虫扫多个泄露 token，给 NAT 出口留余量 |

签名 TTL 沿用文件模块既有值，未为分享放宽。

## 前端改动

- 新增 `frontend/src/messages/MessageAttachments.tsx`：从 `Message.tsx` 抽出的共享布局组件
  （position 排序、images/files 连续分组、单图 `w-[70%]` + `fittedImageFrame`、多图
  `h-32 w-32` 首尾圆角）。聊天页与分享页共用；组件按附件是否带 `id` 决定 AttachmentCard 的 mode。
- `frontend/src/files/AttachmentCard.tsx`：`mode="share"` 进入 message 视觉分支
  （`isMessageLike`）；读取句柄改为 `readHandle()`，owner 用 file id、分享用 `ref`，两者都没有
  时预览/下载按钮保持 disabled。
- `frontend/src/messages/SharePage.tsx`：附件从用户气泡内部移到气泡外上方，与聊天页一致；
  新增绑定 token 的 `readAttachment` resolver（`useCallback` 保持函数标识稳定，否则
  AttachmentCard 的 (handle, role) 读 URL 缓存会失效）。
- `frontend/src/api/share.ts`：新增匿名 `readAttachment(token, ref, role)`。
- `frontend/src/files/types.ts`：`SharedAttachmentPlaceholder` 增加 `ref` / `position` / `stats`。

## 验证

```
.venv/Scripts/python.exe -m ruff check app/
.venv/Scripts/python.exe -m mypy app/services/shares app/api/v1/share.py app/services/files/service.py
.venv/Scripts/python.exe -m pytest tests/services/shares/test_share_service.py tests/api/test_shares.py -q
cd frontend && pnpm exec tsc --noEmit && pnpm exec vitest run
```

`app/services/files/parsers.py` 在 Windows 上有 6 个既有 mypy 报错（`os.killpg` 等 POSIX API），
与本次改动无关。后端测试前请先停 worker（见 `docs/README.md` 路由的相关说明）。

## 回归要点

- 引入本能力之前生成的快照没有 `ref`，必须保持不可读；前端对应断言在
  `SharePage.test.tsx` 的 "keeps legacy snapshots without a ref unreadable"。
- 快照绝不能把 `file_id` 序列化出去，断言在
  `test_snapshot_keeps_file_id_private_and_exposes_only_a_ref`。
- 撤销/过期/会话删除/拥有者停用/资产删除五种失效路径都有参数化测试覆盖。
