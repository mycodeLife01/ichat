# 前端 React 工程重构设计

日期：2026-05-24

## 目标

把当前 `frontend/` 中用于验证后端能力的原生 JavaScript 前端，一次性替换为专业的 React 应用，并直接接入真实后端 API 与 SSE 流。新前端不再由 FastAPI 挂载或服务，生产环境采用 Cloudflare Pages 托管，后端仅作为独立 API 服务存在。

本设计承接 `2026-05-23-frontend-ui-ux-redesign-design.md` 的 UI/UX 蓝图，并补充 React、TypeScript、请求层、状态管理、测试、部署和后端解耦方案。实现阶段必须保留当前前端已经覆盖的产品语义：认证刷新、草稿对话、自动标题、SSE replay、停止生成、失败/取消 partial 内容、编辑并重新生成、重新生成回答、思考过程展示与刷新恢复。

## 已确认决策

| 决策点 | 选择 |
|--------|------|
| 重构方式 | 一次性替换当前 `frontend/`，不做静态假数据中间版本 |
| 工程路线 | 新建标准 React 工程，按业务语义拆分模块 |
| 技术栈 | Vite + React + TypeScript + 标准前端测试工具 |
| 状态管理 | 首期使用 React Context + reducer + custom hooks，不先引入 Redux/Zustand |
| 后端接入 | 直接接真实 API 与 fetch-based SSE stream |
| UI 落地目标 | 生产化实现 `uiux_v1.html` 已确认的首版设计，不重新设计一套新界面 |
| 登录/注册页 | 沿用 `uiux_v1.html` 的认证入口设计，接入真实登录/注册 API |
| 部署边界 | 前后端完全分离，FastAPI 不再绑定前端资源 |
| 生产前端托管 | Cloudflare Pages 托管 `feslia.com` |
| 生产 API 暴露 | `api.feslia.com` 指向现有服务器 Nginx → FastAPI |
| 主推荐部署 | Cloudflare Pages 前端 + VPS/Docker 后端 |

## 背景与现状

当前 `frontend/` 是无构建步骤的原生 ES modules 应用，由 FastAPI 通过 `StaticFiles(directory="frontend", html=True)` 挂载到 `/`。它虽然视觉上仍像测试客户端，但已经承载真实后端行为：

- 登录、注册、refresh token 自动刷新、退出清理。
- 会话列表、草稿会话、当前选择持久化。
- 首次成功回复后激活草稿、刷新列表、标题 pending 占位和标题轮询。
- SSE `after_seq` replay、流式正文和思考过程增量更新。
- run cancel、失败、partial 内容保留。
- 用户消息编辑并重新生成、助手消息重新生成。
- Markdown 安全渲染、复制 fallback、移动端抽屉基础适配。

`uiux_v1.html` 是一个打包后的 React mockup。解包后可见它已经包含接近目标视觉结构的组件：`Sidebar`、`Topbar`、`Message`、`ThinkingBlock`、`Composer`、`BottomSheet`、`ConfirmDialog`、`Toast`、`AuthScreen`。本次 React 重构应把它作为首版 UI 的实现基准：视觉语言、布局结构、组件边界和认证入口都以 `uiux_v1` 为准做生产化落地。实现阶段不重新设计另一套界面；只移除 demo-only 内容，并把假状态机替换为真实 API、SSE 和业务状态。

## 范围

### 首期包含

- 新建 `frontend/` 下的 Vite React TypeScript 应用。
- 迁移并类型化真实 API client、认证刷新、SSE parser/stream client。
- 将 `uiux_v1` 中的登录/注册页和聊天工作区生产化，接入真实认证、会话和 run API。
- 实现桌面侧栏、移动抽屉、消息列表、输入框、思考过程、消息操作、确认框、toast、底部操作面板。
- 保留并测试草稿、标题 pending、SSE replay、刷新恢复、停止生成、失败/取消 partial 内容、编辑/重新生成语义。
- 后端移除静态前端挂载，增加 CORS 配置。
- 调整本地开发、CI、生产部署和文档，使前端与后端独立运行。

### 首期不包含

- 新增后端业务 API。
- 模型切换、参数控制、文件上传、语音输入、附件入口。
- 深色模式。
- 对话搜索、标签、文件夹、归档管理。
- Cloudflare Pages Functions 或 Worker 代理 API。
- 把认证迁移到 httpOnly cookie。现有 access/refresh token localStorage 策略保留，安全加固另行设计。
- 引入全局状态库，除非实现阶段证明 reducer 难以维护。

## 部署设计

### 推荐生产拓扑

```text
用户
  ↓
Cloudflare
  ├─ https://feslia.com       → Cloudflare Pages → React/Vite 静态产物
  └─ https://api.feslia.com   → Cloudflare DNS → 现有服务器 Nginx → FastAPI API
                                                       ↓
                                                    Worker
                                                       ↓
                                                   PostgreSQL
```

前端和后端完全分离：

- `feslia.com` 绑定 Cloudflare Pages 项目。
- `api.feslia.com` 绑定当前服务器，Nginx 只反代 API、SSE、健康检查等后端端点。
- FastAPI 不再服务 `/index.html`、`/app.js`、`/styles.css` 等静态文件。
- React 生产环境通过 `VITE_API_BASE_URL=https://api.feslia.com/api/v1` 请求后端。
- 本地开发使用 `VITE_API_BASE_URL=http://127.0.0.1:8000/api/v1`。

### 被比较但不推荐为主线的方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 同服务器 Nginx 托管前端静态文件 | 无跨域，迁移少 | 前后端仍共享服务器部署链路，不符合完全分离目标 | 不作为主线 |
| 前端容器加入 Docker Compose | 工程分离，仍可同机部署 | 没有 Pages 的 CDN、preview 和静态站优势 | 仅作为自托管备选 |
| Pages Functions/Worker 代理 API | 浏览器视角可保持同源 | 多一层边缘代理，SSE、鉴权和排障复杂 | 暂不采用 |
| Pages + `api.feslia.com` | 边界清晰、部署专业、风险可控 | 需要 CORS 和 API 子域配置 | 采用 |

### 后端部署改动

后端需要新增跨域配置：

- 新增环境变量，例如 `CORS_ALLOWED_ORIGINS`，生产值包含 `https://feslia.com`。
- 本地开发值包含 `http://localhost:5173`、`http://127.0.0.1:5173`。
- 允许 `Authorization`、`Content-Type`、`Accept` 等请求头。
- 允许 `GET`、`POST`、`PATCH`、`DELETE`、`OPTIONS`。
- SSE endpoint 继续通过 `fetch` + `Authorization` header 访问，不改用原生 `EventSource`。

FastAPI 根挂载需要移除：

- 删除或条件禁用 `app.mount("/", StaticFiles(...), name="frontend")`。
- 保留 `/healthz`、`/readyz` 和 `/api/v1/*`。
- 后端测试应断言根路径不再返回前端 HTML。

Nginx 需要从“整站反代 API”调整为 API 子域：

- `server_name api.feslia.com`。
- 继续保留 SSE 友好配置：`proxy_buffering off`、`proxy_cache off`、`proxy_read_timeout 300s`。
- Cloudflare SSL/TLS 和 Origin Certificate 配置随新子域同步。

### 前端部署改动

Cloudflare Pages 构建配置建议：

- Root directory：`frontend`
- Build command：`npm ci && npm run build`
- Build output directory：`dist`
- Production env：`VITE_API_BASE_URL=https://api.feslia.com/api/v1`
- Preview env：默认可指向 staging API；若暂无 staging API，preview deployment 应受限使用或通过 Cloudflare Access 保护。

GitHub Actions 可拆分为：

- 后端 CI：继续执行 `uv run ruff check .`、`uv run mypy app`、`uv run pytest`、Docker build。
- 前端 CI：执行 `npm ci`、`npm run lint`、`npm run typecheck`、`npm run test`、`npm run build`。
- 后端 deploy：继续构建并推送 API/worker 镜像，服务器 `docker compose pull && migrate && up -d`。
- 前端 deploy：可交给 Cloudflare Pages Git 集成，也可由 GitHub Actions 使用 Cloudflare Pages Direct Upload。首期推荐 Git 集成，减少部署脚本复杂度。

## 前端工程结构

推荐目录：

```text
frontend/
├── package.json
├── package-lock.json
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx
│   ├── app/
│   ├── api/
│   ├── auth/
│   ├── conversations/
│   ├── runs/
│   ├── messages/
│   ├── ui/
│   ├── styles/
│   └── test/
└── dist/                 # 构建产物，不提交
```

职责边界：

| 目录 | 职责 |
|------|------|
| `app/` | 应用根组件、provider 装配、顶层状态协调 |
| `api/` | typed API client、`ApiError`、中文错误映射、SSE parser/stream client |
| `auth/` | 登录/注册、token 存储、refresh/retry、身份切换清理 |
| `conversations/` | 会话列表、当前选择、草稿 id、标题 pending、详情加载 |
| `runs/` | active run、取消、SSE replay、terminal 状态 |
| `messages/` | 消息渲染、Markdown、复制、编辑并重新生成、重新生成回答 |
| `ui/` | 纯 UI 组件：Sidebar、Composer、Dialog、Toast、Sheet 等 |
| `styles/` | design tokens、全局样式、Markdown 样式 |
| `test/` | 测试工具、fixtures、MSW handlers、stream helpers |

## 依赖选择

基础工程：

- `react`
- `react-dom`
- `typescript`
- `vite`
- `@vitejs/plugin-react`

UI 与内容：

- `lucide-react`：统一图标来源。
- `react-markdown`、`remark-gfm`、`rehype-sanitize`：安全 Markdown 渲染。

测试：

- `vitest`
- `@testing-library/react`
- `@testing-library/user-event`
- `@testing-library/jest-dom`
- `jsdom`
- `msw`

首期不引入：

- Redux / Zustand：先用 reducer 保持状态转移显式。
- Tailwind CDN：生产应用不依赖 CDN。
- 大型组件库：当前设计需要克制、专注的聊天界面，本地组件足够。
- 代码高亮库：代码块先确保可读性，复杂工具栏和高亮后续再评估。

## 状态模型

前端状态按业务语义分层：

| 状态 | 内容 |
|------|------|
| `AuthSession` | 当前用户、access token、refresh token、过期时间、refresh 中状态 |
| `ConversationIndex` | 已激活会话列表、当前选中 id、草稿 id、标题 pending id 集合 |
| `ConversationDetail` | 当前会话详情、消息列表、加载/不可访问状态 |
| `ActiveRun` | `runId`、`conversationId`、`latestSeq`、`draftText`、`draftReasoning`、`status`、`cancelRequested`、`AbortController` |
| `ComposerState` | 输入内容、IME composing、发送可用性 |
| `UiState` | 移动侧栏、消息操作 sheet、确认框、toast |

实现原则：

- reducer 负责状态转移，不直接发请求。
- hooks 负责副作用编排，例如 `useAuthSession`、`useConversationLoader`、`useRunStream`。
- API/SSE 模块只负责通信和解析，不直接依赖 React。
- UI 组件尽量纯展示，业务动作通过 props 回调传入。
- active run 是全局互斥语义的一部分，编辑和重新生成按钮根据它禁用，并显示中文原因。

## API 设计

前端 API client 对现有后端接口做类型化封装：

```text
authApi
  register(body)
  login(body)
  refresh(refreshToken)
  logout(refreshToken)

conversationApi
  list()
  create(title?)
  detail(id)
  rename(id, title)
  remove(id)
  sendMessage(id, content)
  editAndRegenerate(conversationId, messageId, content)
  regenerate(conversationId, messageId)

runApi
  state(runId)
  cancel(runId)
  streamEvents(runId, afterSeq, signal)
```

通用规则：

- 所有 JSON 成功响应统一读取 `payload.data`。
- 非 2xx 响应转换为 `ApiError`。
- 401 触发一次 refresh + retry。
- refresh 失败时清空 `AuthSession`、`ConversationIndex`、`ConversationDetail`、`ActiveRun` 和本地持久化选择。
- 用户可见错误通过前端映射为中文，不直接展示后端英文 `detail`。
- API base URL 从 `import.meta.env.VITE_API_BASE_URL` 读取。

## SSE 与 run 生命周期

### 发送消息

1. 用户提交内容。
2. 若当前没有选中会话，则先创建草稿会话。
3. 调用 `sendMessage`。
4. 立即把 user message 放入当前消息列表。
5. 创建 assistant placeholder。
6. 建立 `events?after_seq=0` SSE stream。

### 流式事件处理

| 事件 | 前端行为 |
------|----------|
| `reasoning_delta` | 累加 `draftReasoning`，思考区默认展开并显示“思考中…” |
| `text_delta` | 首次正文到达时把思考区切为“已思考”并自动收起；累加 `draftText` |
| `run_succeeded` | 关闭 active run；重拉会话详情；重拉会话列表；处理草稿激活和标题 pending |
| `run_failed` | 保留 partial 内容；标记“生成失败”；恢复输入区 |
| `run_cancelled` | 保留 partial 内容；标记“已停止”；恢复输入区 |

生成中自动滚动遵循 UI/UX 设计：

- 用户接近底部时，流式内容跟随到底部。
- 用户向上阅读历史时，不强制拉回底部。

### 停止生成

- 点击“停止生成”后，按钮立即进入“正在停止…”且不可重复点击。
- 调用 `POST /runs/{id}/cancel`。
- 在服务端 terminal event 到达前，不显示“已停止”。
- 若取消请求失败，显示中文错误并允许用户重试或继续等待当前 run。

### 成功后的草稿激活与标题

run 成功后：

- 重拉 `GET /conversations/{id}`，用服务端物化后的真实 assistant message 替换 placeholder。
- 调 `GET /conversations` 刷新列表。
- 若当前会话是草稿并已激活，清空 `draftConversationId`。
- 若会话标题仍为空，加入 `pendingTitleConversationIds`，侧栏展示 skeleton。
- 按现有策略轮询详情/列表，直到标题出现或超时；超时后显示“新对话”。

### 刷新恢复

React 应用启动时：

1. 从 localStorage 读取 `selectedConversationId` 与 `draftConversationId`。
2. 如果有选中 id，调用 `conversationApi.detail(id)`。
3. 回填服务端已持久化消息。
4. 查找最后一个带 `run_id`、且后面没有同 run assistant 物化消息的 user message。
5. 调用 `runApi.state(runId)`。
6. 用 `draft_text` 和 `draft_reasoning` 创建 assistant placeholder。
7. 如果 `terminal_event` 为空，用 `latest_seq` 建立 `events?after_seq=<latest_seq>` 继续接收后续事件。
8. 如果会话 403/404，静默清理失效选择并回到空白新对话。

该流程保证刷新时不会从空白重新生成，也不会重复追加已展示内容。

## UI 设计落地

生产 UI 以 UI/UX spec 和 `uiux_v1` 的成熟部分为基准。这里的“基准”是验收约束，而不是灵感参考：首版 React 应用应实现 `uiux_v1` 已确认的视觉布局、组件层次、交互密度和认证入口，只在生产化过程中删除未实现能力入口、demo tweaks 和假数据逻辑。

- 浅色温和主题，背景 `#fbfbfa` 一类中性浅色。
- 左侧低对比历史侧栏，桌面常驻，移动端抽屉。
- 阅读列限制最大宽度，与输入框对齐。
- 用户消息使用浅色轻气泡，靠右。
- 助手消息使用靠左正文排版，不使用厚重气泡。
- 思考过程是次要信息层，折叠区在正文上方。
- 消息操作默认不抢正文注意力：桌面 hover/focus 出现，移动端更多按钮打开底部 sheet。
- 登录/注册页沿用 `uiux_v1` 已实现的认证入口设计，不另起一轮页面设计；实现阶段只补真实表单校验、真实 API 调用、提交中状态和中文错误反馈。

从 `uiux_v1` 吸收的组件边界：

- `AuthScreen`
- `Sidebar`
- `Topbar`
- `Composer`
- `Message`
- `ThinkingBlock`
- `BottomSheet`
- `ConfirmDialog`
- `Toast`

不吸收的 demo-only 内容：

- tweaks 面板和可视化调参协议。
- 假数据与 canned responses。
- 附件、语音、模型模式等未实现入口。
- 欢迎页提示卡片。
- demo 状态机中的非真实 regenerate 行为。

## 交互细节

### Composer

- placeholder 使用“向 iChat 提问”。
- 桌面 `Enter` 发送，`Shift+Enter` 换行。
- IME composition 期间不得误发送。
- textarea 自动增高，超过最大高度后内部滚动。
- active run 时主按钮切为“停止生成”。
- cancel requested 时显示“正在停止…”。

### 消息操作

用户消息：

- 复制。
- 编辑并重新生成。

助手消息：

- 复制。
- 重新生成。

限制：

- active run 存在时，复制仍可用。
- 编辑并重新生成、重新生成回答禁用，原因显示“请先停止当前生成”。

### 删除和重命名

- 侧栏历史项支持重命名和删除。
- 重命名使用就地输入，不使用 `window.prompt`。
- 删除使用 `ConfirmDialog`，不使用 `window.confirm`。
- 移动端通过触控友好的操作入口触发。

### 认证入口

- 登录和注册共用一个卡片式入口。
- 用户可见文案统一中文。
- 字段错误就近展示，跨表单错误使用 toast。
- 退出登录和 refresh 失败必须 abort active stream 并清空私有状态。

## 测试策略

### 前端单元与组件测试

使用 Vitest + Testing Library：

- API client：成功 envelope、错误解析、401 refresh retry、refresh 失败清理。
- SSE parser：`event:`、`id:`、`data:` 解析，terminal event 识别，legacy payload 兼容。
- reducer：发送消息、reasoning/text delta、terminal、cancel requested、标题 pending、草稿清理。
- Auth UI：登录/注册校验、提交中状态、错误显示。
- Composer：Enter / Shift+Enter / IME composition。
- ThinkingBlock：生成中展开、正文开始后自动收起、历史可手动展开。
- Message actions：active run 禁用原因、移动端 bottom sheet。
- Markdown：GFM 渲染、安全 sanitize、无库 fallback 不需要保留。

MSW 用于 mock HTTP API。SSE 流不强依赖 MSW 事件流能力，优先用可控的 `ReadableStream` helper 测试 stream client 和 reducer。

### 后端测试

新增或调整后端测试：

- CORS middleware 配置允许预期 origin。
- 不再挂载 `frontend/` 静态文件。
- `/api/v1/*`、`/healthz`、`/readyz` 行为不受影响。
- SSE 响应头继续适合跨域 streaming。

### 集成与手动 smoke

本地验证：

```bash
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
npm run dev --prefix frontend
```

关键流程：

- 注册、登录、刷新页面保持登录态。
- 新空白对话发送首条消息。
- 流式正文和思考过程实时显示。
- 停止生成进入“正在停止…”并在 terminal 后显示“已停止”。
- 首次成功后草稿进入历史列表，标题 pending skeleton 稳定。
- 刷新进行中的 run 后继续 replay，不丢、不重。
- 编辑用户消息并重新生成。
- 重新生成助手回答。
- 重命名和删除历史会话。
- 退出登录后前一身份私有状态不可见。
- 桌面和移动宽度均可用。

## CI/CD 设计

### CI

后端：

```bash
uv sync --frozen
uv run ruff check .
uv run mypy app
uv run alembic upgrade head
uv run pytest --tb=short -q
docker build -t ichat-api:ci .
```

前端：

```bash
cd frontend
npm ci
npm run lint
npm run typecheck
npm run test -- --run
npm run build
```

### Deploy

后端继续使用 GHCR 镜像部署到服务器。

前端推荐使用 Cloudflare Pages Git 集成：

- push 到 `main` 触发 Pages production deployment。
- PR 触发 preview deployment。
- 通过 Pages 环境变量注入 `VITE_API_BASE_URL`。

如果后续希望所有部署都在 GitHub Actions 中统一控制，可改为 Cloudflare Pages Direct Upload，但首期不增加这层复杂度。

## 实施顺序建议

后续 implementation plan 应按风险递增排序：

1. 建立 Vite React TS 工程与测试脚手架。
2. 抽出 typed API client、auth session、SSE parser，并用测试覆盖。
3. 后端移除静态挂载，增加 CORS 配置和测试。
4. 建立 React 状态 reducer 与核心 hooks。
5. 实现认证页。
6. 实现聊天 shell、侧栏、移动抽屉、空白态、composer。
7. 接入会话列表、详情、草稿选择持久化。
8. 接入发送消息和 SSE 流式。
9. 接入停止、失败、取消、刷新恢复。
10. 接入标题 pending、编辑并重新生成、重新生成回答。
11. 落地 Markdown、思考面板、消息操作、确认框、toast。
12. 更新 CI/CD、部署文档、Nginx/Cloudflare 配置说明。
13. 做桌面和移动 smoke，修正视觉和状态细节。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| SSE 跨域 streaming 与浏览器行为差异 | 保持 fetch + ReadableStream，不改 EventSource；增加 stream parser 测试和本地跨域 smoke |
| React 重渲染导致流式滚动跳动 | 把自动滚动条件封装为 hook，仅 near-bottom 时跟随 |
| placeholder 与服务端物化消息重复 | run 成功后以重拉详情为准替换当前消息列表，不叠加 |
| refresh 失败后旧用户数据泄漏 | auth failure 统一 dispatch reset，并 abort active stream |
| Cloudflare Pages preview 误连生产 API | preview 环境变量单独配置；无 staging 前使用 Access 或限制 preview |
| 旧 vanilla 行为遗漏 | 把 `chat.test.js` 中的行为断言迁移为真正组件/状态测试 |
| 前后端部署文档不一致 | 同步更新 `docs/deployment.md` 和 CI/CD handover |

## 验收标准

- `frontend` 可独立执行 `npm ci`、`npm run test -- --run`、`npm run build`。
- React 应用在 `localhost:5173` 能通过 `VITE_API_BASE_URL` 连接本地 API 完成核心流程。
- 生产构建产物可部署到 Cloudflare Pages。
- FastAPI 不再挂载或服务前端静态资源。
- 后端 CORS 允许 `https://feslia.com` 与本地开发 origin。
- `api.feslia.com` 的 Nginx 配置保留 SSE 支持。
- 用户可见主要文案统一中文。
- 当前 vanilla 前端核心行为不丢失：认证刷新、草稿激活、自动标题、SSE replay、思考过程、停止生成、失败/取消 partial、编辑并重新生成、重新生成回答、退出清理。
- 桌面端和移动端都能完成注册、登录、发消息、停止、复制、编辑、重新生成、历史重命名、删除、退出。

## 关联文档

- UI/UX 蓝图：[`2026-05-23-frontend-ui-ux-redesign-design.md`](2026-05-23-frontend-ui-ux-redesign-design.md)
- 架构总览：[`../../architecture/overview.md`](../../architecture/overview.md)
- 模块边界：[`../../architecture/module-boundaries.md`](../../architecture/module-boundaries.md)
- 测试前端交接：[`../../handover/2026-05-17-test-frontend.md`](../../handover/2026-05-17-test-frontend.md)
- Run events / SSE replay：[`../../handover/2026-05-17-run-events-sse-replay.md`](../../handover/2026-05-17-run-events-sse-replay.md)
- Worker 并发与 LISTEN/NOTIFY：[`../../handover/2026-05-19-concurrency-and-listen-notify.md`](../../handover/2026-05-19-concurrency-and-listen-notify.md)
- Regenerate 实现记录：[`../../handover/2026-05-19-regenerate.md`](../../handover/2026-05-19-regenerate.md)
- 草稿对话与自动标题：[`2026-05-19-auto-title-and-draft-conversation-design.md`](2026-05-19-auto-title-and-draft-conversation-design.md)
- DeepSeek 思考过程：[`2026-05-21-deepseek-thinking-design.md`](2026-05-21-deepseek-thinking-design.md)
- 部署指南：[`../../deployment.md`](../../deployment.md)
