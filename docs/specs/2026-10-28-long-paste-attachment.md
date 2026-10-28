# 长文本粘贴转附件（Long paste attachment）

- 日期：2026-10-28
- 状态：已确认（2026-10-28，18 项待确认事项全部按推荐执行），已实现（分支 `feat/long-paste-attachment`，待提交）
- 范围：composer 粘贴与提示文字计数（`frontend/src/ui/Composer.tsx`）、附件上传 hook 与草稿
  （`frontend/src/files/`）、已发送消息附件与公开分享页附件卡片；文件上传 API、`file_uploads` /
  `files` / `message_attachments` 三张表、文本附件处理、模型输入标注、分享快照；新增两个
  文本读取接口
- 设计稿：`design/` current 的 `long-paste` / `over-limit` 场景（原「长文本粘贴转附件」proposal 已提升为 current；composer 卡片宽 220px、「在输入框中显示 ›」、
  只有 header 的全文弹窗、已发送卡片 320px / 移动端 240px）
- 不涉及：历史会话搜索（粘贴内容不进入搜索投影）、R2 CORS、文件安全管线、附件配额规则

## 1. 背景与目标

消息提示文字上限为 20,000 字符（`app/schemas/conversations.py`，按 code point 计）。用户粘贴一大段
日志、代码或文档时会直接超限报错，只能手动另存为文件再上传。ChatGPT / Claude 的做法是：粘贴超过一定
长度时自动把内容变成一个文本附件，用户仍可在输入框里继续写提示文字。

目标：

1. **粘贴即附件**：单次粘贴达到阈值时，内容自动成为一个 `.txt` 消息附件，复用现有上传、处理、
   绑定、配额链路。
2. **来源可辨**：粘贴生成的附件在草稿、已发送消息、刷新后的历史和分享页里都以「粘贴的文本」
   卡片展示（首行 + 行数），点击可看全文。
3. **模型知情**：模型输入中把这类附件标注为用户粘贴的内容，仍作为不受信任附件包裹。
4. **不放宽安全边界**：来源只影响展示与标注，不绕过任何文件校验。

## 2. 产品需求

| # | 场景 | 期望 |
|---|---|---|
| R1 | 单次粘贴 ≥ 4,000 字符或 ≥ 80 行 | 不插入输入框；生成 `pasted-text-N.txt` 附件（N 在当前草稿内递增），走正常上传 |
| R2 | 低于阈值的粘贴 | 行为不变，直接插入 |
| R3 | ⌘⇧V / Ctrl+Shift+V | 强制按纯文本插入输入框，不转附件；界面不显示该快捷键提示 |
| R4 | 文件上传不可用（功能关闭、邮箱未验证、附件数或总大小超限） | 降级为直接插入输入框，并 toast 说明原因 |
| R5 | 提示文字达到上限 80% | 显示 `当前/20,000` 计数；超限时计数变红、发送禁用，并提供「转为附件」把整段提示文字转成粘贴附件 |
| R6 | composer 卡片 | 宽 220px（移动端不超过 240px），高 60px，第一行为首个非空行，第二行为「在输入框中显示 ›」或上传状态 |
| R7 | 「在输入框中显示」 | 仅当附件已就绪且全文放回后不超过提示文字上限时可用；点击后删除附件、把全文插入输入框光标处 |
| R8 | 点击卡片 | 打开全文弹窗：header 显示「粘贴的文本」与「N 行 · N 字符」、关闭按钮；正文等宽字体可滚动；无页脚、无复制按钮 |
| R9 | 发送 | 与其他附件一致，必须上传处理完成才能发送 |
| R10 | 刷新页面后草稿 | 附件仍显示为粘贴卡片；全文通过本人文本接口取回 |
| R11 | 已发送消息 / 刷新后的历史 | 卡片宽 320px（移动端 240px），首行与行数来自服务端 `stats`；点击后通过文本接口读取全文 |
| R12 | 编辑已发送消息 | 卡片行为与 composer 一致 |
| R13 | 公开分享页 | 快照带来源与首行、行数；点击后通过分享文本接口读取全文（沿用分享读取限流）；旧快照按普通文件显示 |
| R14 | 模型上下文 | 粘贴附件的元数据带 `"origin":"paste"`；预算仍按现有 128k 文本附件规则；超出时服务端 413，前端给友好文案 |

## 3. 术语

「粘贴来源」是**消息附件**的来源属性（`origin`），取值 `upload`（默认，用户选择文件）或 `paste`
（由长文本粘贴生成）。它不是新的领域概念，记录在 `CONTEXT.md` 的「消息附件」条目中，不另写 ADR。

## 4. 数据模型与迁移

迁移 `20261028_0029_attachment_origin.py`：

| 表 | 新列 | 约束 |
|---|---|---|
| `file_uploads` | `origin varchar(16) not null default 'upload'` | `CHECK (origin IN ('upload','paste'))` |
| `files`（`FileAsset`） | 同上 | 同上 |
| `message_attachments` | 同上 | 同上 |

- 既有行一律回填 `upload`，不按文件名推断。
- `message_attachments` 也保存 `origin`：资产被回收后 `file_id` 为 NULL，来源仍需保留用于历史与分享展示。
- 链路：`CreateFileUploadRequest.origin` → `FileUpload.origin` → 处理成功时 `FileAsset.origin` →
  绑定时 `MessageAttachment.origin`。

## 5. API 契约

### 5.1 创建上传

`POST /api/v1/files/uploads` 新增可选字段 `origin: "upload" | "paste"`，默认 `upload`。
`origin = "paste"` 时文件名扩展名必须为 `.txt`，否则 422。该字段由客户端声明，只影响展示和标注，
文件仍经过完整的类型嗅探、大小、配额与处理校验。

### 5.2 统计信息

处理 `origin = paste` 的资产时，服务端由 `document_text` 推导并写入 `summary_metadata`：

- `line_count`：按 `\r\n|\r|\n` 切分的行数（空文本为 0）。
- `first_line`：首个非空行去首尾空白后截断到 120 个字符。

两者经现有 `stats` 字段下发（`asset_response` 已透出 `summary_metadata` 中的 int / str 值）。

### 5.3 附件响应

`MessageAttachmentResponse` 与 `SharedAttachmentResponse` 新增 `origin: "upload" | "paste"`。
上传记录（`FileUploadResponse` 中的资产）同样带 `origin`，供刷新后的草稿识别。

### 5.4 文本读取接口（新增）

前端无法跨域 GET 存储对象（R2 CORS 只允许 PUT），所以全文直接从 PG 的 `document_text` 返回。

| 接口 | 鉴权 | 可见性 |
|---|---|---|
| `POST /api/v1/files/{file_id}/text` | 登录用户 | 与 `read-url` 相同：本人资产；未绑定资产须在待绑定期内；已绑定资产须仍挂在本人未删除会话的未归档消息上 |
| `POST /api/v1/share/{token}/attachments/{ref}/text` | 匿名，share token 即授权 | 与分享 `read-url` 相同：分享有效、会话未删除、拥有者未停用、资产未删除且已绑定；限流沿用 `guard_public_read_rate_limit`，按 `preview` 角色计 |

- 响应：`{ "data": { "text": "<全文>" } }`。
- 仅对 `origin = paste` 且 `document_text` 非空的资产开放，其余一律 404（与「不存在」不可区分）。
- 文本上限受粘贴附件的文本类别大小限制约束，不另设分页。

## 6. 模型输入标注

- `DocumentBlock` 新增 `origin`，默认 `upload`；绑定时从资产带入，并写入 transcript。旧 transcript
  缺少该字段时按 `upload` 解析。
- `openai_compat` 构造附件元数据 JSON 时，仅 `origin = paste` 才加 `"origin":"paste"`，正文仍放在
  UNTRUSTED ATTACHMENT 包裹中；`upload` 附件的输出与现在逐字节相同。

## 7. 分享快照

- 快照条目新增 `origin`（仅 `paste` 写入；缺省即 `upload`）。
- `origin = paste` 时，`stats` 额外放行 `line_count` 与 `first_line`；其他附件仍只放行
  `width` / `height`。
- 旧快照没有 `origin`，分享页按普通文件卡片展示。

## 8. 前端交互

- 常量：提示上限 20,000；阈值 4,000 字符或 80 行；计数在 80% 时出现。字符计数与服务端一致，按
  code point（`Array.from(text).length`）。
- 粘贴：在 composer 的 paste 处理中读取 `text/plain`；命中阈值且无文件项时阻止默认插入，生成
  `File([text], "pasted-text-N.txt", { type: "text/plain" })` 并以 `origin: "paste"` 走 `addFiles`。
  原文保存在内存（按 client_id），供卡片与弹窗直接使用。
- 草稿：`DraftAttachment` 增加 `origin`；localStorage 只保存元数据，从不保存 File 或正文。刷新后
  通过 `POST /files/{id}/text` 懒加载全文（打开弹窗或「在输入框中显示」时）。
- 已发送卡片与分享卡片：首行与行数优先用 `stats`；打开弹窗时读取全文，加载中显示 spinner，失败
  显示错误文案。
- 视觉以 design proposal 为准；实现后把设计回补为 design current，并更新 catalog。

## 9. 验收与验证

| 检查 | 命令 / 方法 |
|---|---|
| 后端测试 | `.venv/bin/pytest` 相关文件测试、分享测试、provider 与 transcript 测试 |
| 后端静态检查 | `.venv/bin/ruff check app tests`、`.venv/bin/mypy app` |
| 迁移 | `alembic upgrade head` / `downgrade -1` 往返 |
| 前端 | `pnpm --dir frontend run lint`、`run typecheck`、`exec vitest run`、`run build` |
| 设计 | `design/` 的检查脚本，current 与 frontend 对齐 |
| 真实浏览器 | 粘贴长文本 → 卡片 → 弹窗 → 发送 → 刷新 → 分享页查看全文 |

验收要点：R1–R14 全部满足；`upload` 附件的 API 响应、模型输入与分享快照除新增 `origin` 字段外无变化。
