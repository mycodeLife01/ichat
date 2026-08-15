# 前端架构

本文是 `frontend/` 当前架构、模块边界和实现不变量的权威入口。历史 spec 与 handover
用于解释某项设计为何形成，不用于替代当前架构说明。处理前端任务时，先阅读本文，再在
`docs/README.md` 中读取所有同时命中的功能、部署或后端契约文档；一个任务可能命中多行。

## 运行与部署边界

- 前端是独立的 React + TypeScript + Vite SPA，由 Cloudflare Pages 托管；FastAPI 只提供
  API，不挂载或服务前端静态资源。
- 浏览器通过 `VITE_API_BASE_URL` 跨域访问 `/api/v1`。该变量在构建时注入且必须存在；
  域名、CORS 和 Pages 配置以 `docs/deployment.md` 为准。
- SSE 使用 `fetch` + `ReadableStream`，因为请求需要 `Authorization` header；不要改用
  原生 `EventSource`。
- 服务端是会话、消息、Run 和文件状态的事实源。localStorage 只保存认证会话、用户偏好、
  当前选择和未发送附件草稿等浏览器恢复信息，不能替代服务端业务状态。

## 模块边界

| 边界 | 职责与约束 |
|---|---|
| `src/app/` | 应用装配、路由门、根 reducer/Context 和跨域 UI 编排。`AppProvider` 组装可注入服务；`AppShell` 是登录后工作台的 composition root，不承载 HTTP 协议或新的领域状态机。 |
| `src/api/` | DTO、统一响应 envelope、`ApiError`、401 refresh/retry、端点封装和 SSE 解码。保持 React 无关；组件和业务 hook 不直接拼 URL 或解析 wire payload。 |
| `src/auth/` | token/session 持久化、认证编排和公开认证页面。tokenStore 是 token 事实源，reducer 状态是渲染镜像。 |
| `src/conversations/` | 会话索引、当前详情、提交前状态以及发送、编辑、重新生成、标题轮询等副作用编排。 |
| `src/runs/` | 临时 Run 状态、单流消费、取消和进入会话时的恢复。它不拥有服务端已物化消息。 |
| `src/files/` | 未发送附件的浏览器状态、直传、轮询和草稿恢复。持久上传状态仍由服务端拥有。 |
| `src/messages/` | 已物化消息、临时流式回复、Markdown、来源和分享快照的展示。 |
| `src/ui/` | 可复用展示组件、交互原语及纯 UI 状态；业务副作用留在功能 hook。 |
| `src/styles/global.css` | Tailwind CSS v4 的 `@theme`、全局基础规则以及无法由 utility 表达的白名单 CSS。 |
| `src/test/` | 跨测试共享的 provider harness、API fixtures 和可控 stream helpers；业务测试与源文件同目录。 |

新增行为时先确定唯一归属：通信与 wire contract 进 `api`，可复现状态转移进 reducer，副作用
序列进功能 hook，跨功能装配才进 `AppProvider` 或 `AppShell`，纯展示留在组件。

## 状态与副作用

- `rootReducer` 组合认证、会话索引、会话详情、提交中状态、active Run、composer 和 UI 切片。
  reducer 保持纯函数，只保存可序列化状态。
- `AppProvider` 中的 `stateRef` 会在 dispatch 时同步推进，供 SSE、导航和其他异步回调读取最新
  状态。涉及跨 render 竞态时使用该镜像，不能依赖陈旧闭包猜测当前会话或 Run。
- `AbortController` 不进入 reducer。`useRunStream` 持有实际 controller，并通过 `streamAbort`
  注册，使 logout 或认证失效可以在不了解流实现的情况下中止它。
- 页面生命周期内的展示状态可以留在组件；跨组件、参与业务守卫或需要统一 reset 的状态进入
  reducer；需要刷新恢复的偏好或草稿通过各自 store 写入 localStorage。
- logout、refresh 失败或身份切换必须中止当前 stream、清理上一身份的附件草稿并执行全局
  `app/reset`，防止私有状态跨身份泄漏。

## 工作台外壳与会话操作

- 聊天页没有 header。会话级操作（分享、删除）以浮动层置于正文滚动区右上角，容器必须
  `pointer-events-none`、控件单独开启点击，否则会吃掉正文滚动；浮动层位于验证提醒 banner
  之下，不能覆盖它。空白新会话下隐藏会话级操作。
- 桌面端侧栏有两种形态：展开列表与收起后的 52px rail（展开入口、新建对话、最近若干会话、
  账号头像）。两种形态由同一个 `<aside>` 的宽度切换，不通过挂载/卸载实现，以保留过渡。
  移动端始终是抽屉，其打开与新建对话入口来自聊天页浮动层。
- rail 内的浮层（最近会话、账号菜单）必须 portal 到 `document.body` 并在打开时按触发器
  rect 定位：rail 自身有 overflow 边界，就地渲染会被裁剪。
- 会话行操作（分享 / 重命名 / 删除）在展开列表、rail 浮层和移动端 sheet 之间共用同一份
  渲染与守卫，只切换容器形态。
- 分享有两条入口且语义不同：聊天页浮动分享是一步操作——复用已生效链接、否则新建永久链接，
  然后复制并提示；侧栏行的分享保留完整对话框（过期时间与撤销）。服务端每个会话最多一个
  生效链接，任何新入口都必须先复用再创建，不能靠 409 兜底。

## 路由与认证

- `/share/:token`、`/verify-email`、`/reset-password` 和
  `/confirm-account-deletion` 位于认证门之外，匿名访问不能等待或依赖登录恢复。
- 登录后的空白新会话使用 `/`，已有会话使用 `/c/:publicId`。URL 是深链入口，reducer 中的
  `selectedId` 是渲染状态；两者由 `AppShell` 双向同步。
- `AppShell` 在 `/` 与 `/c/:publicId` 之间保持同一实例，避免路由切换重新执行 bootstrap。
  无效、已删除或无权访问的 public id 应清理选择并回到空白新会话。
- 公开分享读取显式禁用认证 header 和 401 refresh；不得把当前登录用户的 token 带到匿名
  snapshot 请求。

## API 与认证会话

- JSON 成功响应统一读取 `{"data": ...}`；非 2xx 和网络错误统一转换为 `ApiError`。功能层
  根据稳定的 status/code 决定恢复路径，不直接依赖任意后端 detail 文本。
- `ApiClient` 对受保护请求最多执行一次 401 refresh + retry，并对并发 refresh 去重。
  refresh 失败必须清空 token、触发 auth-expired reset，并把错误标记为身份失效。
- API endpoint factory 在 `AppProvider` 中围绕同一个 `ApiClient` 组装，通过 `Services` 注入
  hook；测试使用 fake services，不访问真实网络。
- capability（模型、联网搜索、文件上传）来自 `/capabilities`。前端只根据服务端声明展示入口
  和构造请求，不按 provider 名称或本地配置推测能力。

## 会话与 Run 生命周期

### 提交与流式

1. 提交开始先进入 `pendingSubmission`，表示尚未获得 Run id 的 HTTP 阶段；此时不能提供 Stop。
2. 新会话使用原子 `createWithMessage`，已有会话使用 `sendMessage`。服务端返回真实 user message
   与 Run 后，前端再建立 `activeRun` 并开始流式消费。
3. `useRunStream` 是唯一 stream owner；同一时间最多消费一条流，新 start 会中止旧 consumer。
4. SSE 按 `after_seq` 续读。事件 dispatch 前必须确认 run id 仍是当前 active Run，防止迟到事件
   写入另一会话。
5. `conversationDetail.messages` 始终保持服务端已物化消息；正文、思考和工具状态流式草稿只存在
   于 `activeRun`，由临时 `StreamingMessage` 展示。

### 终态与恢复

- `run_succeeded` 后重新拉取会话详情与第一页索引，以服务端物化消息替换临时回复，然后清理
  active Run。标题尚未写回时仅标记 pending，由独立轮询刷新。
- `run_failed` 与 `run_cancelled` 保留已接收的 partial 正文和终态提示；刷新恢复时再以服务端
  draft 重建，不伪造 assistant message。
- cancel 只发送取消请求并等待 SSE terminal；本地流继续消费。取消请求失败时回退 stopping
  状态，让用户可以重试。
- 进入会话时，若最后一个 user message 的 Run 尚无物化 assistant message，恢复逻辑读取
  `/runs/{id}/state`，用服务端 draft 和 `latest_seq` 重建 active Run，并从该 cursor 续流。
- 编辑并重新生成或重新生成会在服务端归档线程分支；成功创建新 Run 后必须重拉 detail 获取
  权威截断结果，再复用普通 Run 流程，不能在客户端自行裁剪消息。

## 附件与模型能力

- 上传流程为：创建 upload session → 浏览器直传对象存储 → ETag confirm → 批量轮询服务端处理
  状态。浏览器断开的 PUT 不能靠 localStorage 恢复，只能重新选择文件；已有 upload id 可以恢复
  状态轮询。
- 未发送草稿按“用户 + 会话（或新会话）”隔离，保存文字、upload id、顺序和服务端状态；不得
  持久化 `File`、对象 URL、临时读 URL 或文件字节。切换身份时必须清除其他用户草稿。
- 发送前所有附件必须达到可发送终态；请求只携带有序 file id。附件状态、配额和可读性由服务端
  判定，前端校验只是即时反馈，不能成为授权边界。
- 图片输入只在所选模型明确声明 `supports_image_input` 时可用。会话的 `image_context` 是服务端
  派生投影；前端必须遵守 `vision_required` / `legacy_upgrade_required`，不得从模型名称或历史
  附件自行推断。
- preview/download URL 按需向服务端申请并视为短期能力。公开分享页与聊天页共用同一套附件布局
  组件（`messages/MessageAttachments.tsx`），并可用快照中的不透明 `ref` 换取短时 preview/download
  URL；快照本身仍不包含 file id、对象 key 或任何内部标识，缺少 `ref` 的历史快照必须保持不可读，
  详见 ADR `0011-grant-attachment-reads-to-public-shares.md`。

文件、图片或视觉模型任务还必须读取 `docs/README.md` 对应的统一文件上传 handover、视觉
handover 与 ADR；本文只描述前端如何消费这些契约。

## 展示与样式

- 助手 final（`Message`）、streaming（`StreamingMessage`）和 public share（`SharePage`）
  共同调用 `messages/Markdown.tsx`；这是外部 Interface。代码、表格和链接分别由私有的
  `messages/markdown/CodeBlock.tsx`、`TableBlock.tsx`、`MarkdownLink.tsx` 渲染，不在三个
  入口复制 parser 或 rich-surface 实现。
- Markdown pipeline 固定为 math delimiter normalize → streaming clamp → remark GFM/math →
  rehype sanitize → KaTeX → citation → React element renderer。不启用原始 HTML；renderer 只
  消费 sanitize 后的 parsed node，不恢复被移除的危险 href，也不使用
  `dangerouslySetInnerHTML`。代码和表格复制只读取各自 parsed surface。
- 助手内容列使用独立 token `--assistant-content-width: 768px`，不改页面级
  `--reading-width`。final、streaming 和 share 的正文、来源、附件与动作共享该列；share
  外壳需要 `calc(var(--assistant-content-width) + 64px)` 为两侧 `px-8` 留出准确 gutter。
  项目根字号是 15px，不能用 `4rem` 代替这里的 64px。
- Composer 外框复用 `--assistant-content-width`，与 live assistant 正文保持相同左右边界；
  live `MessageThread` 桌面外壳同样按该 token 加两侧 32px gutter。移动断点下，只有位于
  `.thread-region` 的消息外壳可以用 viewport 宽度补偿传统滚动条占宽，确保正文与 Composer
  都保持 16px 双侧 gutter；share 与独立 fixture 继续服从各自 containing block。
- live thread 的 Composer 属于 `.thread-region` 内的 sticky 底部层，而不是滚动区外的兄弟节点；
  消息正文因此可以延伸到控件下方。底部层与 ChatGPT 一样使用 32px 渐变 mask 和 80% canvas，
  不添加 backdrop blur；离底距离超过 136px 时由 `useStickToBottom` 显示“滚动到底部”控件，
  该按钮自身保留参考中的 2px backdrop blur。
  点击后恢复 pinned 状态并平滑返回最新消息。该控件必须支持键盘、`prefers-reduced-motion`
  和用户反向滚动中断，不得用单纯的“接近底部”判断覆盖用户阅读意图。
- Tailwind v4 使用 CSS-first 配置。设计 token 和动画放在 `@theme`；共享 utility 组合放在
  `src/ui/classes.ts`；只有 Markdown 产物、伪元素、滚动条、复杂背景等能力保留手写 CSS。
- 部分语义 class 同时是测试或运行时钩子，样式迁移时先搜索消费者，不能把“无样式”误判为
  “无用途”。
- 桌面与移动端尽量共享动作与业务守卫，只切换容器形态。移动端可以进一步压缩标签密度
  （例如 composer 不显示占位语、模型药丸只显示思考强度），但不得因此隐藏唯一的操作入口：
  当被裁剪的标签是该控件仅剩的可见内容时，必须回退到可用标签。涉及响应式、动画或设计
  token 的改动需要按风险补充真实浏览器视觉检查。

## 验证

前端完成标准以 `.github/workflows/ci.yml` 和 `frontend/package.json` 为事实源。通常在
`frontend/` 下执行：

```bash
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
```

- API、SSE、reducer、store 和 hook 变更应有对应单元测试。
- 组件交互使用 Testing Library；通过 `AppProvider` 的 service seam 和 `src/test/` helper
  覆盖跨层流程，不复制一套测试专用状态机。
- 路由恢复、SSE 重连/取消、文件直传、跨域、响应式或视觉变更需要与风险相称的浏览器 smoke；
  仅有 jsdom 测试不能证明这些浏览器边界成立。
- 助手渲染视觉入口为 `tests/visual/assistant-rendering.html`。Windows Chromium、浅色、DPR 1
  下固定 `1440 × 900` 与 `390 × 844` 两张全页 golden；只有人工批准明确视觉变化后才可用
  `--update-snapshots` 更新。其他平台仍运行语义、交互和几何断言，但不假定字体栅格逐像素一致。
  `assistant-rendering-performance.html` 是独立数值证据页，不进入 golden；Playwright 串行执行，
  避免 syntax highlighting 与性能采样互相争用 CPU。
- live thread 底部布局的浏览器入口为 `tests/visual/thread-bottom.html`，在桌面与移动项目中验证
  sticky/fade/mask、按钮 blur、Composer 与正文对齐、136px 显示阈值、入退场动效、一键到底、无页面水平
  overflow 和 reduced-motion；这些行为依赖真实滚动与 CSS 几何，不能只用 jsdom 验证。
- 文档或代码声称任务完成前，相关测试、lint、类型检查和构建必须通过；无法执行的检查要明确
  记录缺口、风险与待运行命令。
