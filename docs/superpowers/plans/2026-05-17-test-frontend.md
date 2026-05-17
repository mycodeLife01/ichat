# Test Frontend 实现计划

> **给 agentic workers：** 必须使用子技能：实现本计划时使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）语法追踪进度。实际编写 UI 的 Task（Task 4、5、6、9、12）必须先调用 `frontend-design:frontend-design` 技能再开始动手。

**目标：** 为 MVP 后端构建一个最小、可手工验证的浏览器测试前端，覆盖当前所有已实现 API：auth（register/login/refresh/logout）、conversation CRUD、send message、SSE streaming、cancel、replay。

**架构：** 纯 vanilla HTML + ES module JS + Tailwind CDN，无构建步骤。前端文件放在仓库 `frontend/` 目录，由 FastAPI `StaticFiles` 挂载到根路径直接同源提供，避免 CORS。SSE 使用 `fetch` + `ReadableStream` 自行解析（因为 `EventSource` 不支持自定义 `Authorization` header）。auth token 存 `localStorage`，401 时单次 refresh 重试。UI 分两栏：左侧 conversation 列表 + 操作，右侧 chat 区域 + 输入框；以白色为主基调，主流 AI 聊天平台交互习惯。

**技术栈：** HTML5、ES2022 modules、Tailwind CSS（CDN）、Fetch API、ReadableStream、SSE。后端侧：FastAPI `StaticFiles`（已是依赖 `starlette` 内置，无需新增包）。

---

## 范围与边界

**包含：**
- 注册、登录、登出、access token 自动 refresh。
- Conversation 列表/创建/重命名/软删除。
- 打开 conversation 显示历史 message。
- 发送 user message → 自动开启 SSE → 实时流式渲染 assistant 文本。
- Streaming 中显示"停止生成"按钮，调用 cancel API。
- 页面刷新或切换回 conversation 时自动 replay 最近一次 run 的事件（涵盖 active run mid-stream replay 与 failed/cancelled partial deltas 展示两种场景）。
- 错误展示（401 提示重新登录、409 active run 冲突、provider failed 终态 message、其它 HTTP 错误用顶部 toast）。
- 后端 `app/main.py` 挂载 `frontend/` 为静态目录，并将 `/` 重定向到 `index.html`。

**不包含：**
- Regenerate 路径（后端尚未实现，按现状跳过）。
- 自动化前端测试或 JS 构建链。
- 邮箱验证、密码重置 UI（后端无 API）。
- Markdown / 代码高亮渲染（流式文本一律按纯文本+换行展示，HTML-escape 后插入）。
- 多用户切换、深色模式、移动端适配、i18n。
- 头像、用户名修改、设置面板。
- Service worker、PWA、离线缓存。

---

## 文件结构

新增：
- `frontend/index.html` — 单页入口，挂载 Tailwind CDN，定义 `#app` 容器，按需切换 login view / chat view。
- `frontend/app.js` — bootstrap：读取 token 状态，决定渲染 login 或 chat shell；订阅全局 auth 事件（logout 触发切回 login view）。
- `frontend/api.js` — 类型化 API client。每个方法返回业务 `data`；统一处理 `SuccessResponse` envelope 与 `{"detail": ...}` 错误。
- `frontend/auth.js` — token 存储（`localStorage` key `ichat.auth`）、`login`/`register`/`logout`/`refresh`、`getAccessToken()`、`onAuthChange(listener)`。
- `frontend/sse.js` — fetch-based SSE consumer：`streamRunEvents({ runId, afterSeq, token, signal, onEvent })`。手动解析 `event:` / `id:` / `data:` 三类行，按 `\n\n` 分隔。
- `frontend/state.js` — 简单 in-memory store：当前用户、conversation list、当前 conversation detail、当前 run（id、status、abort controller、draft text）。提供 `subscribe(listener)`。
- `frontend/views/login.js` — 渲染 login + register 表单（同页 tab 切换）。
- `frontend/views/chat.js` — 渲染左侧 conversation 列表、右侧消息列表 + 输入框；处理 send / cancel / 选中 conversation / rename / delete。
- `frontend/ui.js` — 小工具：`escapeHtml`、`createElement`、`toast(message, level)`、`confirmDialog(message)`、`nearBottom(scrollEl)`、`scrollToBottom(scrollEl)`。
- `frontend/styles.css` — 仅放 Tailwind utility 之外必要的少量自定义样式（streaming caret 动画、scrollbar、字体栈）。

修改：
- `app/main.py` — 在所有 router 注册之后挂载 `StaticFiles(directory="frontend", html=True)` 到 `/`，并保留 `/healthz`、`/readyz`。

不修改：
- 后端业务代码、数据库 schema、依赖列表。

---

## UI / 设计规范（execution 阶段必须先调用 `frontend-design:frontend-design`）

**整体基调：** 白色 + 极浅灰（`bg-white`、`bg-zinc-50`、`bg-zinc-100`），强调字色 `text-zinc-900`，弱化字色 `text-zinc-500`。主色用于 active conversation 高亮、primary button：选用克制的深蓝/近黑 `bg-zinc-900 hover:bg-zinc-800`，避免饱和度过高的品牌色，符合"简洁清新"。

**字体：** 使用系统字体栈 `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`。Mono 区域（如消息中的代码 fallback）使用 `ui-monospace, SFMono-Regular, Menlo, monospace`。

**布局（chat view）：**
- 顶层 `flex h-screen w-screen overflow-hidden bg-white`。
- 左侧 sidebar：`w-72 shrink-0 border-r border-zinc-200 flex flex-col`。
  - 顶部：logo 文本 "iChat"，右侧 "+ 新建" 按钮。
  - 滚动列表：每个 conversation 一行（title + relative time），hover 时显示右侧 "..." 菜单（rename / delete）。Active 项 `bg-zinc-100 text-zinc-900`。
  - 底部：当前 user 信息（username + 邮箱缩写）+ "登出" 文字按钮。
- 右侧 chat 区域：`flex-1 flex flex-col`。
  - 顶部 header：当前 conversation title（inline 双击可编辑）+ 占位的 model 标签。
  - 中部消息滚动区：`flex-1 overflow-y-auto px-6 py-8`。message bubble 最大宽 `max-w-3xl mx-auto`，user message 右对齐浅灰底，assistant message 左对齐白底无边框，仅靠间距区分；assistant 流式中末尾追加一个 `streaming-caret` 闪烁光标。
  - 底部输入条：`border-t border-zinc-200 px-6 py-4`，圆角 textarea + 右下角 send 按钮；streaming 时 send 按钮变为方形 stop 图标按钮，点击调用 cancel。
- 空状态：未选 conversation 时中部显示 "选择一个对话或新建对话"。conversation 为空时显示提示文案 + 推荐 prompt（静态占位 3 条）。

**布局（login view）：**
- 居中卡片 `max-w-sm w-full bg-white border border-zinc-200 rounded-xl p-8 shadow-sm`。
- 顶部品牌字 "iChat"。
- 同卡片内 tab 切换 "登录" / "注册"。
- 表单字段：登录 = identifier（用户名或邮箱）+ password；注册 = username + email + password。
- 主按钮全宽 `bg-zinc-900 text-white`。
- 错误信息显示在字段下方红色小字（`text-red-600 text-sm`）。

**交互细节：**
- Send：`Enter` 发送，`Shift+Enter` 换行。空内容不可发。
- 自动滚动：仅当用户已经在底部 80px 内时新 delta 触发滚动；否则保持位置并在右下角显示 "↓ 新消息" pill，点击跳到底部。
- 流式光标：assistant bubble 末尾 `<span class="streaming-caret">▍</span>` 用 CSS 动画 0.8s blink。
- Cancel：点击后按钮立即 disable，文案改为 "取消中…"，等待 SSE 终态事件后还原 send 按钮；同时在 assistant bubble 末尾追加灰色小字 "已取消"。
- Conversation 删除：弹自定义 confirm，确认后立即从列表移除并切到空状态。
- Toast：右上角，3 秒自动消失，最多堆叠 3 条。

---

## API 契约速查（执行时按此对接，无需再翻后端代码）

所有成功响应形如 `{ "data": <T>, "meta": <obj|null> }`；所有错误响应形如 `{ "detail": "<message>" }`，HTTP 状态码语义化（401/403/404/409/422/500）。

| Method | Path | Body | 200/201 data | 备注 |
|---|---|---|---|---|
| POST | `/api/v1/auth/register` | `{ username, email, password }` | `{ user:{id,username,email,email_verified}, access_token, refresh_token, token_type:"bearer", expires_in }` | password 8–128 字 |
| POST | `/api/v1/auth/login` | `{ identifier, password }` | 同 register | identifier 可为 username 或 email |
| POST | `/api/v1/auth/refresh` | `{ refresh_token }` | 同 register（轮换 refresh） | 401 表示 refresh token 已失效 |
| POST | `/api/v1/auth/logout` | `{ refresh_token }` | `{ status:"ok" }` | 幂等 |
| GET | `/api/v1/conversations` | — | `ConversationResponse[]` | 需 `Authorization: Bearer <access>` |
| POST | `/api/v1/conversations` | `{ title?: string }` | `ConversationResponse` | title 可空 |
| GET | `/api/v1/conversations/{id}` | — | `ConversationDetailResponse`（含 `messages[]`） | 软删除返回 404 |
| PATCH | `/api/v1/conversations/{id}` | `{ title }` | `ConversationResponse` | rename |
| DELETE | `/api/v1/conversations/{id}` | — | `{ status:"ok" }` | 软删除 |
| POST | `/api/v1/conversations/{id}/messages` | `{ content }` | `{ message: MessageResponse, run: RunResponse }` | 409 if 已有 active run |
| GET | `/api/v1/runs/{id}/state` | — | `{ run_id, status, latest_seq, draft_text, terminal_event? }` | poll 用 |
| GET | `/api/v1/runs/{id}/events?after_seq=N` | — | `text/event-stream` | 每条记录 `id: <seq>\nevent: <type>\ndata: <json>\n\n`，遇 terminal 自动关闭 |
| POST | `/api/v1/runs/{id}/cancel` | — | `{ status:"ok" }` | 幂等 |

SSE event 的 `type` 取值：`run_started`、`text_delta`（payload 含 `delta: string`）、`run_succeeded`、`run_failed`（payload 含 `code` + `message`）、`run_cancelled`。`MessageResponse` 含 `role: "user"|"assistant"`、`run_id?: number`、`position: number`。

---

### Task 1: 后端挂载 frontend 静态目录

**Files:**
- Modify: `app/main.py`
- Create: `frontend/index.html`（占位最小内容，仅为验证挂载）

- [ ] **Step 1: 创建占位 `frontend/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>iChat</title>
  </head>
  <body>
    <p>frontend mount ok</p>
  </body>
</html>
```

- [ ] **Step 2: 在 `app/main.py` 末尾（return app 之前）挂载静态目录**

在 `app/main.py` 顶部 import 中追加：

```python
from pathlib import Path
from fastapi.staticfiles import StaticFiles
```

在 `return app` 之前添加：

```python
    frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
    if frontend_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
```

> 说明：放在所有 `include_router(...)` 与 `@app.get("/healthz"|"/readyz")` 之后，确保 API 与 health 路由优先匹配。`html=True` 让 `/` 直接返回 `index.html`。`if frontend_dir.is_dir()` 守护让 CI/测试环境（无前端目录时）不报错。

- [ ] **Step 3: 启动 API 验证**

```bash
DATABASE_URL='postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat' \
  uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 &
sleep 1
curl -s http://127.0.0.1:8000/ | head -5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/v1/conversations
```

Expected:
- `/` 返回包含 `frontend mount ok` 的 HTML。
- `/healthz` → `200`。
- `/api/v1/conversations` 未带 token → `401`（路由未被静态目录抢占）。

- [ ] **Step 4: 提交**

```bash
git add app/main.py frontend/index.html
git commit -m "feat(frontend): serve frontend dir as static site from FastAPI"
```

---

### Task 2: API client 与错误处理

**Files:**
- Create: `frontend/api.js`

- [ ] **Step 1: 实现 `request` + 各 endpoint 包装**

`frontend/api.js`：

```js
const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function parseError(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body && typeof body.detail === "string") detail = body.detail;
  } catch {}
  return new ApiError(response.status, detail);
}

export async function request(path, { method = "GET", body, token, signal } = {}) {
  const headers = { "Accept": "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return null;
  const payload = await response.json();
  return payload.data;
}

export const auth = {
  register: (body) => request("/auth/register", { method: "POST", body }),
  login: (body) => request("/auth/login", { method: "POST", body }),
  refresh: (refresh_token) => request("/auth/refresh", { method: "POST", body: { refresh_token } }),
  logout: (refresh_token) => request("/auth/logout", { method: "POST", body: { refresh_token } }),
};

export const conversations = {
  list: (token) => request("/conversations", { token }),
  create: (token, title) => request("/conversations", { method: "POST", token, body: { title: title ?? null } }),
  detail: (token, id) => request(`/conversations/${id}`, { token }),
  rename: (token, id, title) => request(`/conversations/${id}`, { method: "PATCH", token, body: { title } }),
  remove: (token, id) => request(`/conversations/${id}`, { method: "DELETE", token }),
  sendMessage: (token, id, content) =>
    request(`/conversations/${id}/messages`, { method: "POST", token, body: { content } }),
};

export const runs = {
  state: (token, runId) => request(`/runs/${runId}/state`, { token }),
  cancel: (token, runId) => request(`/runs/${runId}/cancel`, { method: "POST", token }),
};
```

- [ ] **Step 2: 浏览器手工验证（先放到 Task 4 完成后跑）**

本任务无独立可运行验证。代码会在 Task 3、4 的实际调用中被覆盖。本 Step 仅做静态自检：在 DevTools Console 试执行 `import("/api.js").then(m => console.log(Object.keys(m)))`，预期输出包含 `ApiError, auth, conversations, request, runs`。

- [ ] **Step 3: 提交**

```bash
git add frontend/api.js
git commit -m "feat(frontend): add typed API client with SuccessResponse + detail-error handling"
```

---

### Task 3: Auth 模块（token 存储 + 自动 refresh 包装）

**Files:**
- Create: `frontend/auth.js`

- [ ] **Step 1: 实现 auth state 与带 refresh 的 `apiCall`**

`frontend/auth.js`：

```js
import { ApiError, auth as authApi, request } from "./api.js";

const STORAGE_KEY = "ichat.auth";
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(state) {
  if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  else localStorage.removeItem(STORAGE_KEY);
  for (const l of listeners) l(state);
}

let current = load();

export function getAuth() {
  return current;
}

export function onAuthChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setFromTokenResponse(data) {
  current = {
    user: data.user,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  save(current);
}

export async function login(identifier, password) {
  const data = await authApi.login({ identifier, password });
  setFromTokenResponse(data);
}

export async function register(username, email, password) {
  const data = await authApi.register({ username, email, password });
  setFromTokenResponse(data);
}

export async function logout() {
  const state = current;
  current = null;
  save(null);
  if (state?.refreshToken) {
    try { await authApi.logout(state.refreshToken); } catch {}
  }
}

async function refreshOnce() {
  if (!current?.refreshToken) throw new ApiError(401, "Not authenticated");
  const data = await authApi.refresh(current.refreshToken);
  setFromTokenResponse(data);
  return current.accessToken;
}

// Wrap an API call so a single 401 triggers refresh + retry.
export async function withAuth(callWithToken) {
  if (!current?.accessToken) throw new ApiError(401, "Not authenticated");
  try {
    return await callWithToken(current.accessToken);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    let token;
    try {
      token = await refreshOnce();
    } catch (refreshErr) {
      current = null;
      save(null);
      throw refreshErr;
    }
    return await callWithToken(token);
  }
}

export function getAccessToken() {
  return current?.accessToken ?? null;
}
```

- [ ] **Step 2: 浏览器手工验证**

后续 Task 4 完成后回头跑：在 DevTools Console 手测 `localStorage.getItem("ichat.auth")` 在登录后非空，在 logout 后为 `null`。本 Step 暂无运行验证。

- [ ] **Step 3: 提交**

```bash
git add frontend/auth.js
git commit -m "feat(frontend): add auth module with token storage and single-retry refresh"
```

---

### Task 4: Login / Register view（含 Tailwind 接入与首屏壳）

> **执行前必须先调用 `frontend-design:frontend-design` 技能**，确保表单视觉符合本计划"UI / 设计规范"白色简洁基调。

**Files:**
- Modify: `frontend/index.html`
- Create: `frontend/app.js`
- Create: `frontend/views/login.js`
- Create: `frontend/styles.css`
- Create: `frontend/ui.js`

- [ ] **Step 1: 重写 `frontend/index.html` 为 SPA 壳**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iChat</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="bg-white text-zinc-900 antialiased">
    <div id="app" class="h-screen w-screen"></div>
    <div id="toast-root" class="fixed top-4 right-4 z-50 flex flex-col gap-2"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: 创建 `frontend/styles.css`**

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
}

.streaming-caret {
  display: inline-block;
  width: 0.5ch;
  animation: ichat-blink 0.9s steps(1) infinite;
  color: #71717a;
}

@keyframes ichat-blink {
  50% { opacity: 0; }
}

.scroll-thin::-webkit-scrollbar { width: 8px; }
.scroll-thin::-webkit-scrollbar-thumb { background: #d4d4d8; border-radius: 999px; }
```

- [ ] **Step 3: 创建 `frontend/ui.js`**

```js
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function toast(message, level = "info") {
  const root = document.getElementById("toast-root");
  const color = level === "error" ? "bg-red-600" : level === "success" ? "bg-emerald-600" : "bg-zinc-900";
  const node = el("div", {
    class: `${color} text-white text-sm px-3 py-2 rounded-md shadow-md max-w-sm`,
  }, [message]);
  root.appendChild(node);
  setTimeout(() => node.remove(), 3000);
}

export function nearBottom(elem, threshold = 80) {
  return elem.scrollHeight - elem.scrollTop - elem.clientHeight < threshold;
}

export function scrollToBottom(elem) {
  elem.scrollTop = elem.scrollHeight;
}
```

- [ ] **Step 4: 创建 `frontend/views/login.js`**

```js
import { ApiError } from "../api.js";
import { login, register } from "../auth.js";
import { el, toast } from "../ui.js";

export function renderLoginView(container, { onAuthenticated }) {
  let mode = "login"; // "login" | "register"

  function render() {
    container.replaceChildren(build());
  }

  function build() {
    const root = el("div", { class: "h-full w-full flex items-center justify-center bg-zinc-50 px-4" });
    const card = el("div", {
      class: "max-w-sm w-full bg-white border border-zinc-200 rounded-xl p-8 shadow-sm",
    });
    const brand = el("h1", { class: "text-2xl font-semibold text-zinc-900 text-center mb-1" }, ["iChat"]);
    const subtitle = el("p", { class: "text-sm text-zinc-500 text-center mb-6" }, ["简洁的 AI 对话测试客户端"]);

    const tabs = el("div", { class: "flex bg-zinc-100 rounded-md p-1 mb-6 text-sm" }, [
      tabButton("登录", "login"),
      tabButton("注册", "register"),
    ]);

    const form = mode === "login" ? buildLoginForm() : buildRegisterForm();

    card.append(brand, subtitle, tabs, form);
    root.append(card);
    return root;
  }

  function tabButton(label, key) {
    const active = mode === key;
    return el("button", {
      type: "button",
      class: `flex-1 py-1.5 rounded ${active ? "bg-white shadow-sm text-zinc-900" : "text-zinc-500"}`,
      onClick: () => { mode = key; render(); },
    }, [label]);
  }

  function field(labelText, inputAttrs) {
    const errorId = `err-${inputAttrs.name}`;
    const input = el("input", {
      ...inputAttrs,
      class: "w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
    });
    const error = el("p", { id: errorId, class: "text-red-600 text-xs mt-1 hidden" });
    return {
      wrapper: el("label", { class: "block mb-4" }, [
        el("span", { class: "block text-xs font-medium text-zinc-600 mb-1" }, [labelText]),
        input,
        error,
      ]),
      input,
      setError: (msg) => {
        if (msg) { error.textContent = msg; error.classList.remove("hidden"); }
        else { error.classList.add("hidden"); }
      },
    };
  }

  function submitButton(label) {
    return el("button", {
      type: "submit",
      class: "w-full bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-medium py-2 rounded-md transition",
    }, [label]);
  }

  function buildLoginForm() {
    const identifier = field("用户名或邮箱", { name: "identifier", type: "text", required: true, autocomplete: "username" });
    const password = field("密码", { name: "password", type: "password", required: true, autocomplete: "current-password", minlength: 8 });
    const form = el("form", { class: "space-y-1" }, [identifier.wrapper, password.wrapper, submitButton("登录")]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      identifier.setError(null); password.setError(null);
      try {
        await login(identifier.input.value.trim(), password.input.value);
        onAuthenticated();
      } catch (err) {
        const message = err instanceof ApiError ? err.detail : "登录失败";
        password.setError(message);
      }
    });
    return form;
  }

  function buildRegisterForm() {
    const username = field("用户名", { name: "username", type: "text", required: true, autocomplete: "username", maxlength: 50 });
    const email = field("邮箱", { name: "email", type: "email", required: true, autocomplete: "email" });
    const password = field("密码（至少 8 位）", { name: "password", type: "password", required: true, autocomplete: "new-password", minlength: 8 });
    const form = el("form", { class: "space-y-1" }, [username.wrapper, email.wrapper, password.wrapper, submitButton("创建账号")]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      [username, email, password].forEach((f) => f.setError(null));
      try {
        await register(username.input.value.trim(), email.input.value.trim(), password.input.value);
        toast("注册成功", "success");
        onAuthenticated();
      } catch (err) {
        const message = err instanceof ApiError ? err.detail : "注册失败";
        password.setError(message);
      }
    });
    return form;
  }

  render();
}
```

- [ ] **Step 5: 创建 `frontend/app.js`**

```js
import { getAuth, onAuthChange } from "./auth.js";
import { renderLoginView } from "./views/login.js";

const root = document.getElementById("app");

function render() {
  const auth = getAuth();
  if (!auth) {
    renderLoginView(root, { onAuthenticated: render });
    return;
  }
  // Chat view 会在 Task 5 接入，先放占位。
  root.replaceChildren(Object.assign(document.createElement("div"), {
    className: "h-full flex items-center justify-center text-zinc-500",
    textContent: `已登录为 ${auth.user.username}（chat view 即将接入）`,
  }));
}

onAuthChange(render);
render();
```

- [ ] **Step 6: 手工验证（浏览器）**

预先确保后端在跑（参考 `docs/handover/2026-05-17-deepseek-smoke.md` 中"启动栈"段）。

1. 浏览器访问 `http://127.0.0.1:8000/`，预期看到 login 卡片，tab 默认在"登录"。
2. 切到"注册" tab，使用一个新邮箱注册（例如 `frontend_test_<unix_ts>@example.com`，password 至少 8 位）。预期：注册成功 → 顶部 toast "注册成功" → 主区域出现 `已登录为 xxx（chat view 即将接入）`。
3. DevTools → Application → Local Storage：`ichat.auth` 应存在并包含 `accessToken`、`refreshToken`、`user`、`expiresAt`。
4. 刷新页面：仍处于已登录占位（说明 `getAuth()` 从 localStorage 恢复成功）。
5. 在 Console 跑 `(await import("/auth.js")).logout()`：预期 UI 切回 login 视图，localStorage `ichat.auth` 被清除。
6. 用错误密码尝试登录：预期"密码"字段下出现红色错误文案，文案来自后端 `detail`。

- [ ] **Step 7: 提交**

```bash
git add frontend/index.html frontend/app.js frontend/auth.js frontend/api.js frontend/ui.js frontend/styles.css frontend/views/login.js
git commit -m "feat(frontend): scaffold SPA shell with login/register view"
```

---

### Task 5: Chat shell — sidebar 渲染 + conversation 列表/创建/重命名/删除

> 执行前必须先调用 `frontend-design:frontend-design` 技能。

**Files:**
- Create: `frontend/state.js`
- Create: `frontend/views/chat.js`
- Modify: `frontend/app.js`

- [ ] **Step 1: 创建 `frontend/state.js`（最小 store）**

```js
const listeners = new Set();
const state = {
  conversations: [],            // ConversationResponse[]
  selectedId: null,             // number | null
  detail: null,                 // ConversationDetailResponse | null（选中 conversation 的完整消息）
  activeRun: null,              // { runId, status, controller, draftText, assistantPlaceholderId } | null
};

export function getState() { return state; }

export function setState(patch) {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
```

- [ ] **Step 2: 创建 `frontend/views/chat.js`（本 Task 仅实现 sidebar + 占位主区域）**

```js
import { ApiError } from "../api.js";
import * as api from "../api.js";
import { getAuth, logout, withAuth } from "../auth.js";
import { getState, setState, subscribe } from "../state.js";
import { el, toast } from "../ui.js";

export function renderChatView(container, { onLoggedOut }) {
  container.replaceChildren(buildShell({ onLoggedOut }));
  void loadConversations();
  const unsubscribe = subscribe(() => rerenderSidebar(container));
  container._chatUnsubscribe = unsubscribe;
}

function buildShell({ onLoggedOut }) {
  const root = el("div", { class: "h-full w-full flex bg-white" });
  root.append(buildSidebar({ onLoggedOut }), buildMainPlaceholder());
  return root;
}

function buildSidebar({ onLoggedOut }) {
  const sidebar = el("aside", {
    class: "w-72 shrink-0 border-r border-zinc-200 flex flex-col bg-zinc-50/40",
    id: "sidebar",
  });

  const header = el("div", { class: "flex items-center justify-between px-4 py-4 border-b border-zinc-200" }, [
    el("span", { class: "text-base font-semibold text-zinc-900" }, ["iChat"]),
    el("button", {
      class: "text-xs px-2 py-1 rounded-md border border-zinc-200 hover:bg-white",
      onClick: () => void createConversation(),
    }, ["+ 新建"]),
  ]);

  const list = el("nav", {
    id: "conversation-list",
    class: "flex-1 overflow-y-auto scroll-thin px-2 py-2 space-y-1",
  });

  const auth = getAuth();
  const footer = el("div", {
    class: "px-4 py-3 border-t border-zinc-200 flex items-center justify-between",
  }, [
    el("div", { class: "min-w-0" }, [
      el("p", { class: "text-sm text-zinc-900 truncate" }, [auth?.user.username ?? ""]),
      el("p", { class: "text-xs text-zinc-500 truncate" }, [auth?.user.email ?? ""]),
    ]),
    el("button", {
      class: "text-xs text-zinc-500 hover:text-zinc-900",
      onClick: async () => { await logout(); onLoggedOut(); },
    }, ["登出"]),
  ]);

  sidebar.append(header, list, footer);
  return sidebar;
}

function buildMainPlaceholder() {
  return el("section", {
    id: "main",
    class: "flex-1 flex items-center justify-center text-zinc-400 text-sm",
  }, ["选择一个对话，或点击左上角"+" + 新建 创建一个新对话"]);
}

function rerenderSidebar() {
  const list = document.getElementById("conversation-list");
  if (!list) return;
  const { conversations, selectedId } = getState();
  list.replaceChildren(...conversations.map((c) => conversationRow(c, c.id === selectedId)));
}

function conversationRow(conv, isActive) {
  const title = conv.title?.trim() || "新对话";
  const row = el("div", {
    class: `group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer ${
      isActive ? "bg-zinc-100 text-zinc-900" : "text-zinc-700 hover:bg-zinc-100"
    }`,
    onClick: () => void selectConversation(conv.id),
  });
  row.append(
    el("span", { class: "flex-1 text-sm truncate" }, [title]),
    el("button", {
      class: "opacity-0 group-hover:opacity-100 text-xs text-zinc-400 hover:text-zinc-900 px-1",
      title: "重命名",
      onClick: (e) => { e.stopPropagation(); void renameConversation(conv); },
    }, ["✎"]),
    el("button", {
      class: "opacity-0 group-hover:opacity-100 text-xs text-zinc-400 hover:text-red-600 px-1",
      title: "删除",
      onClick: (e) => { e.stopPropagation(); void deleteConversation(conv); },
    }, ["🗑"]),
  );
  return row;
}

async function loadConversations() {
  try {
    const list = await withAuth((t) => api.conversations.list(t));
    setState({ conversations: list });
  } catch (err) {
    toast(errorMessage(err, "加载对话列表失败"), "error");
  }
}

async function createConversation() {
  try {
    const conv = await withAuth((t) => api.conversations.create(t, null));
    setState({ conversations: [conv, ...getState().conversations] });
    await selectConversation(conv.id);
  } catch (err) {
    toast(errorMessage(err, "创建对话失败"), "error");
  }
}

async function selectConversation(id) {
  setState({ selectedId: id, detail: null });
  // 详情/消息渲染在 Task 6 接入。
}

async function renameConversation(conv) {
  const next = window.prompt("新对话名称", conv.title ?? "");
  if (next == null) return;
  const title = next.trim();
  if (!title) { toast("名称不能为空", "error"); return; }
  try {
    const updated = await withAuth((t) => api.conversations.rename(t, conv.id, title));
    setState({
      conversations: getState().conversations.map((c) => c.id === conv.id ? updated : c),
    });
  } catch (err) {
    toast(errorMessage(err, "重命名失败"), "error");
  }
}

async function deleteConversation(conv) {
  if (!window.confirm(`删除对话「${conv.title ?? "新对话"}」？`)) return;
  try {
    await withAuth((t) => api.conversations.remove(t, conv.id));
    const { selectedId } = getState();
    setState({
      conversations: getState().conversations.filter((c) => c.id !== conv.id),
      selectedId: selectedId === conv.id ? null : selectedId,
      detail: selectedId === conv.id ? null : getState().detail,
    });
  } catch (err) {
    toast(errorMessage(err, "删除失败"), "error");
  }
}

function errorMessage(err, fallback) {
  return err instanceof ApiError ? err.detail : fallback;
}
```

- [ ] **Step 3: 接入 `frontend/app.js`**

替换 Task 4 中的占位渲染：

```js
import { getAuth, onAuthChange } from "./auth.js";
import { renderLoginView } from "./views/login.js";
import { renderChatView } from "./views/chat.js";

const root = document.getElementById("app");

function render() {
  const previous = root._chatUnsubscribe;
  if (typeof previous === "function") { previous(); root._chatUnsubscribe = null; }

  const auth = getAuth();
  if (!auth) {
    renderLoginView(root, { onAuthenticated: render });
    return;
  }
  renderChatView(root, { onLoggedOut: render });
}

onAuthChange(render);
render();
```

- [ ] **Step 4: 手工验证**

1. 登录后预期进入 chat shell，sidebar 显示空列表，主区域显示空状态文案。
2. 点击"+ 新建"：列表顶部出现"新对话"项并被选中（背景变浅灰）。继续点 2 次：列表共 3 条。Network 面板可见 3 次 `POST /api/v1/conversations` 均 201。
3. hover 列表项：右侧出现"✎"和"🗑"图标。点 ✎，输入新名字 → 列表对应项 title 立即更新，刷新页面后保持。
4. 点 🗑 → 确认 → 该项从列表消失。
5. 点登出 → 回到 login 视图，localStorage 清空。

- [ ] **Step 5: 提交**

```bash
git add frontend/state.js frontend/views/chat.js frontend/app.js
git commit -m "feat(frontend): chat shell with conversation list/create/rename/delete"
```

---

### Task 6: 打开 conversation → 加载详情 → 渲染历史消息

> 执行前必须先调用 `frontend-design:frontend-design` 技能。

**Files:**
- Modify: `frontend/views/chat.js`

- [ ] **Step 1: 把"主区域占位"换成基于 `detail` 的渲染**

修改 `buildShell` / `buildMainPlaceholder`：移除 placeholder，引入 `buildMain()` 并在 `subscribe` 里调用 `rerenderMain()`。

在 `chat.js` 顶部新增 import：

```js
import { escapeHtml, nearBottom, scrollToBottom } from "../ui.js";
```

将 `buildShell` 调整为：

```js
function buildShell({ onLoggedOut }) {
  const root = el("div", { class: "h-full w-full flex bg-white" });
  root.append(buildSidebar({ onLoggedOut }), buildMain());
  return root;
}
```

新增主区域构造器：

```js
function buildMain() {
  return el("section", { id: "main", class: "flex-1 flex flex-col min-w-0" }, [
    el("header", {
      id: "main-header",
      class: "h-14 px-6 flex items-center border-b border-zinc-200 text-sm font-medium text-zinc-900",
    }, ["选择一个对话开始聊天"]),
    el("div", { id: "messages", class: "flex-1 overflow-y-auto scroll-thin" }),
    el("div", { id: "composer-mount", class: "border-t border-zinc-200" }),
  ]);
}
```

更新 `renderChatView` 末尾的 subscribe：

```js
const unsubscribe = subscribe(() => { rerenderSidebar(); rerenderMain(); });
container._chatUnsubscribe = unsubscribe;
```

实现 `rerenderMain`：

```js
function rerenderMain() {
  const header = document.getElementById("main-header");
  const messages = document.getElementById("messages");
  if (!header || !messages) return;

  const { selectedId, detail } = getState();
  if (!selectedId) {
    header.textContent = "选择一个对话开始聊天";
    messages.replaceChildren(emptyHero("从左侧选一个对话，或新建一个开始"));
    return;
  }
  if (!detail || detail.id !== selectedId) {
    header.textContent = "加载中…";
    messages.replaceChildren(emptyHero("加载中…"));
    return;
  }

  header.textContent = detail.title?.trim() || "新对话";
  if (detail.messages.length === 0) {
    messages.replaceChildren(emptyHero("发出你的第一条消息开始对话"));
  } else {
    const list = el("div", { class: "max-w-3xl mx-auto px-6 py-8 space-y-6" },
      detail.messages.map(renderMessage));
    messages.replaceChildren(list);
    requestAnimationFrame(() => scrollToBottom(messages));
  }
}

function emptyHero(text) {
  return el("div", {
    class: "h-full w-full flex items-center justify-center text-zinc-400 text-sm",
  }, [text]);
}

function renderMessage(message) {
  const isUser = message.role === "user";
  const bubble = el("div", {
    class: isUser
      ? "max-w-[80%] ml-auto bg-zinc-100 text-zinc-900 rounded-2xl rounded-tr-md px-4 py-3 text-sm whitespace-pre-wrap break-words"
      : "max-w-[80%] mr-auto text-zinc-900 px-1 py-1 text-sm whitespace-pre-wrap break-words leading-relaxed",
    dataset: { messageId: String(message.id), role: message.role },
  });
  bubble.textContent = message.content;
  return el("div", { class: `flex ${isUser ? "justify-end" : "justify-start"}` }, [bubble]);
}
```

修改 `selectConversation`：

```js
async function selectConversation(id) {
  setState({ selectedId: id, detail: null });
  try {
    const detail = await withAuth((t) => api.conversations.detail(t, id));
    if (getState().selectedId === id) setState({ detail });
  } catch (err) {
    toast(errorMessage(err, "加载对话失败"), "error");
  }
}
```

- [ ] **Step 2: 手工验证**

1. 登录已有 smoke 账户（或用 Task 4 新建账号）。
2. 选中已有 conversation：header 显示标题，消息列表按 user/assistant 左右分列渲染，user 浅灰底，assistant 无底。
3. 切换不同 conversation：消息内容随之切换。新对话（无消息）显示 "发出你的第一条消息开始对话"。
4. DevTools Network：只在切换时触发一次 `GET /api/v1/conversations/{id}`，未重复请求。

- [ ] **Step 3: 提交**

```bash
git add frontend/views/chat.js
git commit -m "feat(frontend): render conversation detail with message history"
```

---

### Task 7: 输入框 + 发送 user message（不含流式渲染）

**Files:**
- Modify: `frontend/views/chat.js`

- [ ] **Step 1: 实现 composer + send 流程（产生 user message + queued run，先用 toast 提示返回值）**

在 `chat.js` 顶部新增辅助：

```js
function mountComposer() {
  const mount = document.getElementById("composer-mount");
  if (!mount) return;
  mount.replaceChildren(buildComposer());
}
```

在 `buildMain()` 末尾的 mount div 创建后，在 `rerenderMain` 末尾调用 `mountComposer()`（每次重渲都重建 composer 以反映 `selectedId` 是否存在；性能可接受）。

新增 `buildComposer`：

```js
function buildComposer() {
  const { selectedId, activeRun } = getState();
  const disabled = !selectedId;

  const textarea = el("textarea", {
    rows: "1",
    placeholder: disabled ? "选择或新建一个对话后开始输入…" : "向 iChat 提问…",
    class: "flex-1 resize-none max-h-40 px-3 py-2 text-sm outline-none bg-transparent disabled:text-zinc-400",
    ...(disabled ? { disabled: "true" } : {}),
  });

  const sendButton = el("button", {
    class: "shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md bg-zinc-900 text-white text-sm hover:bg-zinc-800 disabled:bg-zinc-300",
    title: activeRun ? "停止生成" : "发送（Enter）",
  }, [activeRun ? "■" : "↑"]);

  const wrapper = el("div", { class: "max-w-3xl mx-auto px-6 py-3" }, [
    el("div", {
      class: "flex items-end gap-2 border border-zinc-200 rounded-2xl px-2 py-1 bg-white shadow-sm focus-within:border-zinc-400",
    }, [textarea, sendButton]),
    el("p", { class: "text-[11px] text-zinc-400 mt-1 px-1" }, [
      activeRun ? "正在生成，按停止按钮可取消" : "Enter 发送，Shift+Enter 换行",
    ]),
  ]);

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!activeRun) void submit();
    }
  });

  sendButton.addEventListener("click", () => {
    if (activeRun) void cancelActiveRun();
    else void submit();
  });

  async function submit() {
    const content = textarea.value.trim();
    if (!content || !selectedId) return;
    textarea.value = "";
    textarea.style.height = "auto";
    try {
      const { message, run } = await withAuth((t) => api.conversations.sendMessage(t, selectedId, content));
      // 把 user message 立刻 append 到 detail.messages
      const detail = getState().detail;
      if (detail && detail.id === selectedId) {
        setState({
          detail: { ...detail, messages: [...detail.messages, message] },
        });
      }
      toast(`run ${run.id} queued (流式渲染将在 Task 9 接入)`, "info");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast("当前对话已有未完成的生成任务，请稍候或取消后重试", "error");
      } else {
        toast(errorMessage(err, "发送失败"), "error");
      }
    }
  }

  return wrapper;
}

async function cancelActiveRun() {
  // 占位，Task 10 实现。
  toast("cancel 将在 Task 10 接入", "info");
}
```

- [ ] **Step 2: 手工验证**

1. 选中对话 → 输入"你好" + Enter：右侧立刻出现 user message bubble，顶部 toast 显示 `run N queued`。
2. Network：`POST /api/v1/conversations/{id}/messages` 返回 201，`message` + `run` 字段都在。
3. 立刻再发一条：预期 toast 报错"当前对话已有未完成的生成任务…"（409）；如果后端 worker 已经在跑且已经写完 assistant message，会成功 → 这是 Task 8/9 接入后才可控验证，此处先确认 409 路径能触发即可（可以临时停 worker 来人为制造 active run）。
4. 输入框空内容时 Enter 无效。Shift+Enter 正常换行并撑高输入框。

- [ ] **Step 3: 提交**

```bash
git add frontend/views/chat.js
git commit -m "feat(frontend): composer + send user message (queued run, no streaming yet)"
```

---

### Task 8: fetch-based SSE consumer

**Files:**
- Create: `frontend/sse.js`

- [ ] **Step 1: 实现 `streamRunEvents`**

```js
// frontend/sse.js
import { ApiError } from "./api.js";

const TERMINAL_TYPES = new Set(["run_succeeded", "run_failed", "run_cancelled"]);

/**
 * Stream SSE events for a run. Returns when the stream closes (terminal event
 * or server EOF). Throws on HTTP / network failure (other than abort).
 *
 * @param {{ runId: number, afterSeq?: number, token: string, signal?: AbortSignal,
 *           onEvent: (event: { seq: number, type: string, payload: any }) => void }} opts
 */
export async function streamRunEvents({ runId, afterSeq = 0, token, signal, onEvent }) {
  const response = await fetch(`/api/v1/runs/${runId}/events?after_seq=${afterSeq}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "text/event-stream",
    },
    signal,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {}
    throw new ApiError(response.status, detail);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE records are separated by a blank line (\n\n). The server uses \n
      // (per format_sse_event in app/api/v1/runs.py).
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const record = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseRecord(record);
        if (parsed) {
          onEvent(parsed);
          if (TERMINAL_TYPES.has(parsed.type)) return;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function parseRecord(record) {
  let type = null;
  let seq = null;
  const dataLines = [];
  for (const line of record.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!type || dataLines.length === 0) return null;
  let payload = {};
  try {
    const parsed = JSON.parse(dataLines.join("\n"));
    // backend ships the full RunEventResponse json — pull payload field if present.
    payload = parsed.payload ?? parsed;
    if (typeof parsed.seq === "number") seq = parsed.seq;
  } catch {}
  return { seq: seq ?? 0, type, payload };
}

export { TERMINAL_TYPES };
```

- [ ] **Step 2: 手工验证（DevTools Console）**

预先确保有一个 conversation 里上一条 user message 触发过一次 succeeded 的 run（参考 smoke handover 的 run 1487）。在 Console 跑：

```js
const { streamRunEvents } = await import("/sse.js");
const { getAccessToken } = await import("/auth.js");
const events = [];
await streamRunEvents({
  runId: <某个 succeeded run id>,
  afterSeq: 0,
  token: getAccessToken(),
  onEvent: (e) => events.push(e),
});
console.log(events.length, events[0], events.at(-1));
```

预期：
- 不抛错。
- `events[0].type === "run_started"`。
- `events.at(-1).type === "run_succeeded"`。
- 中间元素为 `text_delta`，且 `payload.delta` 是字符串片段。

- [ ] **Step 3: 提交**

```bash
git add frontend/sse.js
git commit -m "feat(frontend): fetch-based SSE consumer for run events with bearer auth"
```

---

### Task 9: 串通 send → SSE → 流式渲染 → 终态收尾

> 执行前必须先调用 `frontend-design:frontend-design` 技能。

**Files:**
- Modify: `frontend/views/chat.js`

- [ ] **Step 1: 在 send 流程后启动 SSE 并实时渲染**

在 `chat.js` 顶部新增 import：

```js
import { streamRunEvents } from "../sse.js";
```

新增辅助：

```js
function ensureAssistantPlaceholder(conversationId, runId) {
  const detail = getState().detail;
  if (!detail || detail.id !== conversationId) return null;

  const placeholderId = `pending-${runId}`;
  if (detail.messages.some((m) => m.id === placeholderId)) return placeholderId;

  const placeholder = {
    id: placeholderId,
    conversation_id: conversationId,
    run_id: runId,
    role: "assistant",
    content: "",
    position: (detail.messages.at(-1)?.position ?? 0) + 1,
    created_at: new Date().toISOString(),
    _pending: true,
  };
  setState({ detail: { ...detail, messages: [...detail.messages, placeholder] } });
  return placeholderId;
}

function updateAssistantText(placeholderId, text) {
  const detail = getState().detail;
  if (!detail) return;
  const next = detail.messages.map((m) =>
    m.id === placeholderId ? { ...m, content: text } : m,
  );
  setState({ detail: { ...detail, messages: next } });
}

function markAssistantTerminal(placeholderId, kind) {
  // kind: "succeeded" | "failed" | "cancelled"
  const detail = getState().detail;
  if (!detail) return;
  const next = detail.messages.map((m) =>
    m.id === placeholderId ? { ...m, _terminal: kind, _pending: false } : m,
  );
  setState({ detail: { ...detail, messages: next } });
}

async function attachRunStream({ conversationId, runId, afterSeq = 0 }) {
  const previous = getState().activeRun;
  if (previous?.controller) {
    try { previous.controller.abort(); } catch {}
  }
  const placeholderId = ensureAssistantPlaceholder(conversationId, runId);
  if (!placeholderId) return;

  const controller = new AbortController();
  let draft = "";
  let terminalKind = null;
  let failureMessage = null;

  setState({
    activeRun: {
      runId, conversationId, controller, draftText: "", assistantPlaceholderId: placeholderId,
      status: "streaming",
    },
  });
  rerenderMain();

  try {
    const token = (await import("../auth.js")).getAccessToken();
    await streamRunEvents({
      runId, afterSeq, token, signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta") {
          const delta = event.payload?.delta ?? "";
          if (delta) {
            draft += delta;
            updateAssistantText(placeholderId, draft);
            maybeAutoScroll();
          }
        } else if (event.type === "run_succeeded") {
          terminalKind = "succeeded";
        } else if (event.type === "run_failed") {
          terminalKind = "failed";
          failureMessage = event.payload?.message || event.payload?.code || "Generation failed";
        } else if (event.type === "run_cancelled") {
          terminalKind = "cancelled";
        }
      },
    });
  } catch (err) {
    if (err.name !== "AbortError") {
      toast(errorMessage(err, "流式连接异常"), "error");
    }
  } finally {
    setState({ activeRun: null });
    if (terminalKind === "succeeded") {
      // 拉取 conversation detail，拿到后端物化的 assistant message id 与最终内容。
      try {
        const detail = await withAuth((t) => api.conversations.detail(t, conversationId));
        if (getState().selectedId === conversationId) setState({ detail });
      } catch {
        markAssistantTerminal(placeholderId, "succeeded");
      }
    } else if (terminalKind === "failed") {
      markAssistantTerminal(placeholderId, "failed");
      toast(failureMessage ?? "生成失败", "error");
    } else if (terminalKind === "cancelled") {
      markAssistantTerminal(placeholderId, "cancelled");
    } else {
      // 流被异常中断，留下 placeholder 上次的内容。
      markAssistantTerminal(placeholderId, "failed");
    }
    rerenderMain();
  }
}

function maybeAutoScroll() {
  const messages = document.getElementById("messages");
  if (!messages) return;
  if (nearBottom(messages)) requestAnimationFrame(() => scrollToBottom(messages));
}
```

修改 `renderMessage`（assistant bubble 末尾追加 streaming caret / terminal pill）：

```js
function renderMessage(message) {
  const isUser = message.role === "user";
  const bubble = el("div", {
    class: isUser
      ? "max-w-[80%] ml-auto bg-zinc-100 text-zinc-900 rounded-2xl rounded-tr-md px-4 py-3 text-sm whitespace-pre-wrap break-words"
      : "max-w-[80%] mr-auto text-zinc-900 px-1 py-1 text-sm whitespace-pre-wrap break-words leading-relaxed",
    dataset: { messageId: String(message.id), role: message.role },
  });
  bubble.textContent = message.content;
  if (!isUser && message._pending) {
    bubble.insertAdjacentHTML("beforeend", `<span class="streaming-caret">▍</span>`);
  }
  if (!isUser && message._terminal === "cancelled") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-zinc-400">已取消</span>`);
  }
  if (!isUser && message._terminal === "failed") {
    bubble.insertAdjacentHTML("beforeend", `<span class="ml-2 text-xs text-red-500">失败</span>`);
  }
  return el("div", { class: `flex ${isUser ? "justify-end" : "justify-start"}` }, [bubble]);
}
```

修改 Task 7 `submit()` 末尾，去掉占位 toast 改为：

```js
      // 把 user message 立刻 append 到 detail.messages
      const detail = getState().detail;
      if (detail && detail.id === selectedId) {
        setState({ detail: { ...detail, messages: [...detail.messages, message] } });
      }
      void attachRunStream({ conversationId: selectedId, runId: run.id, afterSeq: 0 });
```

- [ ] **Step 2: 手工验证**

1. 选中一个对话，发"用一句话介绍你自己"：
   - user bubble 立刻出现。
   - 紧接着 assistant bubble 出现 + 光标闪烁。
   - 文本逐 token 增长，DevTools Network 中 `/runs/{id}/events?after_seq=0` 是一个 pending 的 EventStream。
   - 终态到来：bubble 内文本停止增长，光标消失。
   - 重新打开同一对话：assistant message 正常显示（说明 `succeeded` 分支拉取 detail 把 placeholder 换成了真实 id）。
2. Composer 在流式中：send 按钮变成 "■"（cancel 行为留到 Task 10 验证）。
3. 终态后再发一条：能正常 send，没有 409。

- [ ] **Step 3: 提交**

```bash
git add frontend/views/chat.js
git commit -m "feat(frontend): stream run events into assistant bubble with terminal reconciliation"
```

---

### Task 10: Cancel 按钮串通

**Files:**
- Modify: `frontend/views/chat.js`

- [ ] **Step 1: 实现 `cancelActiveRun`**

```js
async function cancelActiveRun() {
  const { activeRun } = getState();
  if (!activeRun) return;
  try {
    await withAuth((t) => api.runs.cancel(t, activeRun.runId));
    toast("已请求取消，等待生成停止…", "info");
    // 不在这里修改 activeRun.status；等待 SSE 终态 run_cancelled 事件触发清理。
  } catch (err) {
    toast(errorMessage(err, "取消失败"), "error");
  }
}
```

可选优化：取消请求后将 composer 上的 stop 按钮 disable 并改文案为"取消中…"。在 `buildComposer` 中：

```js
  if (activeRun && activeRun.cancelRequested) {
    sendButton.disabled = true;
    sendButton.title = "取消中…";
    sendButton.textContent = "…";
  }
```

并在 `cancelActiveRun` 内先 `setState({ activeRun: { ...activeRun, cancelRequested: true } });` 再调 API。

- [ ] **Step 2: 手工验证**

1. 发一条长 prompt："写一篇 1000 字关于江南雨季的散文"。
2. 看到 text 流出后约 1 秒，点击 stop 按钮（■）。
3. 顶部 toast "已请求取消…"。stop 按钮置灰，文案 "…"。
4. 约 ≤ heartbeat（默认 10s）后：assistant bubble 停止增长，末尾出现"已取消"灰字，composer 还原成 send 按钮。
5. Network：`POST /runs/{id}/cancel` 返回 200。SSE 连接被服务器关闭（最后一条 event 为 `run_cancelled`）。
6. 再次点 stop（在已 cancel 后再发新消息 → 再次取消）应工作正常；重复点 cancel 在同一 active run 上不应抛错（API 幂等）。

- [ ] **Step 3: 提交**

```bash
git add frontend/views/chat.js
git commit -m "feat(frontend): wire cancel button to runs/{id}/cancel"
```

---

### Task 11: 进入 conversation 时自动 replay 未结束 run / 展示 partial 文本

**Files:**
- Modify: `frontend/views/chat.js`

- [ ] **Step 1: 在 `selectConversation` 拉取 detail 后探测最后一条 user message 的 run**

```js
async function selectConversation(id) {
  setState({ selectedId: id, detail: null });
  try {
    const detail = await withAuth((t) => api.conversations.detail(t, id));
    if (getState().selectedId !== id) return;
    setState({ detail });
    await maybeResumeRun(detail);
  } catch (err) {
    toast(errorMessage(err, "加载对话失败"), "error");
  }
}

async function maybeResumeRun(detail) {
  const lastUser = [...detail.messages].reverse().find((m) => m.role === "user");
  if (!lastUser || !lastUser.run_id) return;
  // 如果该 user message 之后已经存在 assistant message，且该 assistant 的 run_id 一致，
  // 说明 run 早已 succeeded 并物化，无需 replay。
  const hasAssistantAfter = detail.messages.some(
    (m) => m.role === "assistant" && m.position > lastUser.position && m.run_id === lastUser.run_id,
  );
  if (hasAssistantAfter) return;

  let state;
  try {
    state = await withAuth((t) => api.runs.state(t, lastUser.run_id));
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return;
    toast(errorMessage(err, "恢复流式连接失败"), "error");
    return;
  }

  // 任何状态都从 after_seq=0 拉一遍：active run → 接管 mid-stream；
  // 已终止但无 assistant message（cancelled/failed）→ 拿到 partial deltas 后立即终止。
  void attachRunStream({ conversationId: detail.id, runId: lastUser.run_id, afterSeq: 0 });
}
```

- [ ] **Step 2: 手工验证**

场景 A：mid-stream replay
1. 发长 prompt 开始流式。
2. 在流式进行时关闭浏览器 tab。
3. 重开 `http://127.0.0.1:8000/`，登录后点同一对话。
4. 预期：assistant bubble 出现并继续从中段流出（不会从 0 重新生成），直到终态 succeeded → 物化为真实 assistant message。

场景 B：partial cancelled 展示
1. 发长 prompt → 中途点 stop（按 Task 10 流程）→ 终态 cancelled。
2. 切到别的对话再切回来。
3. 预期：仍能看到取消时累积的 partial 文本（assistant bubble + "已取消" 灰字），未触发新一次后端调用。

场景 C：失败展示
1. 临时把 worker 用错误 `DEEPSEEK_API_KEY` 启动（参考 smoke handover 第 5 节）。
2. 发消息 → 等待 run_failed → 在 UI 看到 "失败" 红字，bubble 文本可能为空。
3. 切走再切回 → partial（如果有）仍展示，状态仍标记失败。
4. 用真实 key 重启 worker，新发消息能成功。

- [ ] **Step 3: 提交**

```bash
git add frontend/views/chat.js
git commit -m "feat(frontend): auto-resume run stream on conversation open, replay partials for terminal runs"
```

---

### Task 12: 设计 QA + 细节打磨

> 执行前必须先调用 `frontend-design:frontend-design` 技能，对每个 view 做一次视觉走查。

**Files:**
- Modify: `frontend/styles.css`、`frontend/views/chat.js`、`frontend/views/login.js`（按需）

- [ ] **Step 1: 走查清单**

人工对照本计划的"UI / 设计规范"逐项校对：

- [ ] login 卡片宽度、阴影、tab 视觉与计划一致；红色错误文案在 8 字以内仍可读。
- [ ] sidebar 行高、active 项背景、hover 显示的图标对齐良好。
- [ ] header 双击改名行为存在（如未实现，本步加上：双击 `#main-header` → 替换为 `<input>`，blur/Enter 提交 PATCH）。
- [ ] 消息 bubble：user/assistant 视觉差异清晰，长 URL/长无空白字符串能 wrap。
- [ ] composer：textarea 自动撑高至 ≤ 160px，超过则 textarea 内部滚动。
- [ ] 顶部 toast 在 3s 后消失，多条堆叠不超出右上区域。
- [ ] 整个界面在 1280×800 与 1440×900 下无横向滚动。
- [ ] 字体一致，无来自浏览器默认 serif 的字段。

- [ ] **Step 2: 实现遗漏项 + 视觉小修**

针对走查中标红的项，做最小修改。新增样式集中放 `styles.css`，避免散落在 JS 字符串里。

- [ ] **Step 3: 提交**

```bash
git add -A frontend/
git commit -m "polish(frontend): design QA pass on sidebar, composer, message bubbles"
```

---

### Task 13: 手工 smoke 交接文档

**Files:**
- Create: `docs/handover/2026-05-17-test-frontend.md`

- [ ] **Step 1: 写交接（与既有 handover 风格一致，使用中文）**

内容至少包含：

1. **本次完成**：列出 13 个 Task 的产物 & 验证结论。
2. **环境与启动命令**：复用 `docs/handover/2026-05-17-deepseek-smoke.md` 的启动栈，附加"浏览器访问 `http://127.0.0.1:8000/`"。
3. **覆盖的 API 清单**：与本计划"API 契约速查"一致，每条标注"已在 UI 中触达"。
4. **手工 smoke 矩阵**：登录/注册、conversation CRUD、send happy path、SSE 流式、cancel、刷新页面 mid-stream replay、partial cancelled 展示、failed 展示、logout、自动 refresh（让 access token 过期或手动改 expiresAt 提前 → 触发任意 API → 看到自动 refresh）。
5. **已知未覆盖**：regenerate（后端未实现）、markdown 渲染、移动端、深色模式、自动化测试。
6. **注意事项**：localStorage 不是生产级、token 在 DevTools 可见、CDN Tailwind 依赖外网。

- [ ] **Step 2: 提交**

```bash
git add docs/handover/2026-05-17-test-frontend.md
git commit -m "docs: add manual smoke handover for test frontend"
```

---

## Self-Review 备忘（计划作者完成，无需在 execution 中复跑）

- 已对照后端实际路由（`app/api/v1/{auth,conversations,runs}.py`）核对 method / path / body / response 结构。
- 已确认 `app/main.py` 当前无 CORS、无 StaticFiles 挂载（Task 1 需要补）。
- 已确认 `format_sse_event` 在 `app/api/v1/runs.py:91` 发出形如 `id:\nevent:\ndata: <json>\n\n` 的格式（Task 8 解析器与此一致）。
- 已确认 ACTIVE_RUN 冲突走 409（`ensure_no_active_run` in `app/services/conversations/service.py:215`），UI 文案对应。
- 已确认 regenerate 路由不存在，计划范围明确排除。
- 已确认 SSE endpoint 自身要求 Bearer，故 `EventSource` 不可用、必须 fetch + ReadableStream。
- 类型一致性：`runId`、`afterSeq`、`onEvent` 在 `sse.js`、`chat.js`、`auth.js` 间命名统一。
- 占位扫描：未发现 "TBD" / "类似于 Task N" / 仅描述不给代码的 step。
