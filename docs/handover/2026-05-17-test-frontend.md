# 2026-05-17 Test Frontend 交接文档

## 本次完成

基于 AIChat 后端 MVP 设计规格 (`docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md`)，构建了一个纯 vanilla HTML + ES modules + Tailwind CDN 的浏览器测试前端，覆盖当前所有已实现 API。

前端文件位于仓库 `frontend/` 目录，由 FastAPI `StaticFiles` 挂载到 `/` 同源提供，无 CORS 问题。13 个 commit，按计划逐 task 提交。

## 环境与启动

与后端 smoke 交接 (`docs/handover/2026-05-17-deepseek-smoke.md`) 使用相同环境。

启动栈（postgres 已由 docker compose 运行）：

```bash
cd /Users/jk/Projects/ichat
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' uv run alembic upgrade head
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 &
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' uv run python -m app.worker &
```

浏览器访问 `http://127.0.0.1:8000/` 即可使用。

配置走仓库 `.env`，无需额外设置。

## 技术栈

- HTML5 + ES2022 modules + Tailwind CSS (CDN)
- Fetch API + ReadableStream (SSE 解析)
- localStorage 存储 auth token
- 无构建步骤，无 npm 依赖

## 覆盖的 API 清单

| API | 方法 | UI 中触达方式 |
|-----|------|-------------|
| `/api/v1/auth/register` | POST | Login 页面 "注册" tab |
| `/api/v1/auth/login` | POST | Login 页面 "登录" tab |
| `/api/v1/auth/refresh` | POST | 自动：任意 API 返回 401 时触发 |
| `/api/v1/auth/logout` | POST | Sidebar 底部 "登出" 按钮 |
| `/api/v1/conversations` | GET | 页面加载/侧栏刷新 |
| `/api/v1/conversations` | POST | 侧栏 "+ 新建" 按钮 |
| `/api/v1/conversations/{id}` | GET | 点击侧栏对话项 |
| `/api/v1/conversations/{id}` | PATCH | 双击 header 标题编辑 / hover "✎" |
| `/api/v1/conversations/{id}` | DELETE | hover 对话项 "🗑" |
| `/api/v1/conversations/{id}/messages` | POST | 输入框 Enter / 点发送按钮 |
| `/api/v1/runs/{id}/events` | GET (SSE) | 发送消息后自动连接；切回对话 auto-resume |
| `/api/v1/runs/{id}/state` | GET | auto-resume 时检测 run 状态 |
| `/api/v1/runs/{id}/cancel` | POST | streaming 时点停止按钮 (■) |

## 手工 Smoke 矩阵

### 1. 注册与登录

- 打开 `http://127.0.0.1:8000/` → 看到居中 login 卡片，"登录" tab 默认选中。
- 切到 "注册" → 填入 username / email / password（≥ 8 位）→ 注册成功 toast + 自动进入 chat view。
- DevTools → Application → Local Storage：`ichat.auth` 包含 `accessToken`、`refreshToken`、`user`、`expiresAt`。
- 刷新页面：保持在 chat view（localStorage 恢复）。
- Console 执行 `(await import("/auth.js")).logout()` → 切回 login，localStorage 清空。
- 用错误密码登录 → 密码字段下方显示红色后端错误信息。

### 2. Conversation CRUD

- 登录后侧栏空列表，主区域显示空状态提示。
- 点 "+ 新建" 3 次：列表出现 3 条 "新对话"，Network 3 次 `POST 201`。
- hover 项 → 出现 "✎" / "🗑" 按钮。
- 点 "✎" → prompt 输入新名字 → 列表即时更新，刷新保持。
- 点 "🗑" → confirm 确认 → 项消失，选中状态清空。
- 侧栏底部显示当前 username + email，"登出" 按钮正常。

### 3. 发送消息 + SSE 流式

- 选中对话 → 输入框可用，placeholder "向 iChat 提问…"。
- 输入 "用一句话介绍你自己" + Enter：
  - user bubble 立刻出现在右侧区域（浅灰底、右对齐）。
  - assistant bubble 出现 + `▍` 光标闪烁。
  - 文本逐 token 增长，自动滚动跟随。
  - 终态 reached → 光标消失，send 按钮恢复。
- Network：`POST /messages` 201 → 紧接着 `GET /events?after_seq=0` EventStream pending。
- 重新打开同一对话：assistant message 正常显示（server-side 物化后的真实 id + content）。

### 4. Cancel

- 发长 prompt "写一篇关于江南雨季的散文" → 看到 text 流出。
- 点击 ■ 停止按钮 → 按钮变为 "…" 置灰，toast "已请求取消…"。
- 约 ≤ 心跳间隔（默认 10s）后 assistant bubble 停止增长，末尾出现 "已取消" 灰字。
- Composer 还原为 send 按钮。
- Network：`POST /runs/{id}/cancel` 200，SSE 以 `run_cancelled` 关闭。
- 重复点 cancel 在同一 run 上不抛错（API 幂等）。

### 5. Mid-stream Replay

- 发长 prompt 开始流式 → 关闭浏览器 tab。
- 重开 `http://127.0.0.1:8000/` → 登录 → 点同一对话。
- assistant bubble 继续从中段流出（非从 0 生成），直到终态。

### 6. Partial Cancelled / Failed 展示

- 取消失败：cancel 后 assistant bubble 保留 partial 文本 + "已取消" 标记。切走再切回仍可见，不触发新请求。
- Provider 失败：用非法 `DEEPSEEK_API_KEY` 起 worker → 发消息 → assistant bubble "失败" 红色标记，toast 显示后端 error message。切走切回 partial 保持。

### 7. 自动 Refresh

- 手动改 `expiresAt` 为过去时间 → 触发任意 API（如切换对话）→ Network 可见 `POST /auth/refresh` → 新 token 写入 localStorage → 原请求重试成功。

### 8. Error 场景

- 409：同一对话 active run 未结束时再次 send → toast "当前对话已有未完成的生成任务…"。
- 401：token 完全过期且 refresh 失败 → 切回 login 视图（`withAuth` 内的 refresh 失败清理 state）。
- 404：软删除的 conversation 返回 404 → toast 错误。

## 已知未覆盖

- **Regenerate**：`POST /api/v1/messages/{message_id}/regenerate` 后端尚未实现，前端无对应 UI。
- **Markdown 渲染**：流式文本全量纯文本 `textContent` + HTML-escape，无代码高亮。
- **移动端适配**：仅桌面 1280+ 布局。
- **深色模式**：未实现。
- **自动化前端测试**：无 JS 测试链。
- **`Last-Event-ID`**：SSE replay 只用 `after_seq` query cursor（后端同）。

## 注意事项

- `localStorage` 存储 token 非生产级（XSS 可读）。生产环境建议 httpOnly cookie + CSRF protection。
- Token 在 DevTools 明文可见——仅测试用途无需处理。
- Tailwind CSS 走 CDN 依赖外网，离线环境不可用。
- 前端与后端同源部署（FastAPI StaticFiles），若拆分需加 CORS middleware。
- 当前 `DEEPSEEK_MODEL=deepseek-v4-flash`（`.env` 原值），若后续报错请参考 smoke 交接文档回退 `deepseek-chat`。
- Cancel 延迟与 `WORKER_HEARTBEAT_INTERVAL_SECONDS` 同阶，默认约 10s，前端按钮已做 "取消中…" 反馈。

## Git 状态

- 13 个前端 commit，从 `49e6c91` 到 `caa1435`，均位于 `master` 分支。
- 除 `CLAUDE.md` 有未关联的本地修改外，工作区 clean。
