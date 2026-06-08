# 2026-06-08 前端会话列表与详情交接文档

## 本次完成

按 `docs/superpowers/plans/2026-06-08-frontend-conversation-list-and-detail.md` 完整实现：在已有单根 reducer + 双 Context + 认证门架构之上，把登录后的临时占位页（`AuthedPlaceholder`）替换为**真实聊天工作台**。用户登录后进入侧栏 + 顶栏 + 消息区 + Composer 的完整外壳，可浏览会话列表、只读阅读会话详情（Markdown + 思考过程）、新建/重命名/删除会话，刷新后恢复上次选择。

本次只做**会话列表 + 只读详情 + 会话管理**。Composer 呈现但**发送禁用**；不含发送/SSE 流式、编辑/重新生成、Toast/BottomSheet（这些留待后续步骤，组件结构已预留接入位）。

实施采用 TDD：每个任务先写失败测试（RED），再实现最小通过代码（GREEN），随后提交，共 18 个任务、17 个功能提交（`d344b1f`..`ce64800`），外加 2 个交互修复提交（`01b895c`、`c6213ed`）。前端测试从 62 增至 **115 全绿**（31 个测试文件）。

视觉与交互严格复现 `chatapp_demo`（已从 git 移除但仍在工作区），样式直接移植自 `chatapp_demo/styles.css`。

## 主要改动

### 状态层（切片做实）

- `src/conversations/state.ts`：`conversationIndexReducer` 做实 6 个 action（listLoading/listLoaded/listError/selected/renamed/removed）；`conversationDetailReducer` 做实 4 个 action（detailLoading/detailLoaded/detailForbidden/detailReset），并在 `renamed` 时同步当前详情标题。
- `src/ui/state.ts`（新增）：把 `ui` 切片从 `store.ts` 迁出并扩展。`UiState` = `{ mobileSidebarOpen, sidebarCollapsed, confirmDialog }`；新增 toggleMobileSidebar/setMobileSidebar/toggleSidebarCollapsed/openConfirm/closeConfirm。
- `src/app/store.ts`：`AppAction` 联合纳入 `ConversationIndexAction | ConversationDetailAction | UiAction`；删除内联 `UiState`/`uiReducer`，改用 `ui/state.ts`。`ComposerState` 与内联 `composerReducer` 保持不动。

### 副作用编排与持久化

- `src/conversations/selectionStore.ts`（新增）：`localStorage` 持久化当前选择的会话 id（key `ichat.selectedConversationId`），含损坏值清理。
- `src/conversations/useConversationLoader.ts`（替换占位）：做实 `loadList / selectConversation / newConversation / renameConversation / deleteConversation`。封装"选择即加载详情并持久化"、"403/404 静默清理回空白态"、"删除后回退到下一个或空白"等编排。

### 服务装配

- `src/api/conversations.ts`：导出 `ConversationApi` 类型（`ReturnType<typeof createConversationApi>`）。
- `src/app/context.ts`：`Services` 增加 `conversationApi`。
- `src/app/AppProvider.tsx`：真实分支用 `createConversationApi(client)` 装配。
- `src/test/appHarness.tsx`：新增 `createFakeConversationApi`；`createFakeServices` 接受第二参数注入 fake conversationApi。

### 样式

- `src/styles/tokens.css`（新增）：把 demo 的 `:root` 与原 Tweaks 注入项固化为全局设计 token。
- `src/styles/chat.css`（新增）：聊天外壳样式，**逐段移植自 `chatapp_demo/styles.css`**（滚动条/重置、app shell/sidebar/main/空白态/消息/thinking/markdown/composer/按钮、移动端、确认框）。
- `src/styles/global.css`：引入 tokens，清理无引用的占位样式（`.app-shell`/`.app-card` 等）。
- `src/auth/AuthScreen.css`：删除重复的 token 声明块，复用全局 `:root` token（`.auth-brand .wordmark` 覆盖保留）。

### 展示组件（均带同名测试）

- `src/ui/icons.tsx`：lucide-react 图标映射（语义名 → 组件）。
- `src/ui/Wordmark.tsx`：文字标识。
- `src/messages/Markdown.tsx`：`react-markdown` + `remark-gfm` + `rehype-sanitize` 安全渲染。
- `src/messages/ThinkingBlock.tsx`：reasoning 折叠区（`streaming` 入参已预留给后续流式）。
- `src/messages/Message.tsx`：单条消息（用户气泡 / 助手正文 + 思考 / 复制 / 编辑·重新生成按钮禁用）。
- `src/messages/MessageThread.tsx`：消息列表。
- `src/ui/Composer.tsx`：输入框（发送禁用、Enter 不发送，键盘/IME 结构预留）。
- `src/ui/ConfirmDialog.tsx`：确认对话框。
- `src/conversations/Topbar.tsx`：顶栏标题（标题/新对话/骨架三态）。
- `src/conversations/Sidebar.tsx`：品牌行、新建、按日期分组、行内重命名、行下拉菜单（重命名/删除）、空列表占位、账号/退出、移动抽屉 + 遮罩。

### 工作台外壳与入口

- `src/app/AppShell.tsx`（新增）：装配 `useConversationLoader` + 各组件。启动 effect 先加载列表，再恢复 `selectionStore` 选择或回空白态；`Cmd/Ctrl+N` 新建；`useIsMobile` 响应式；删除确认走 `ui.confirmDialog`。
- `src/app/App.tsx`：已登录分支改用 `<AppShell />`。
- 删除 `src/app/AuthedPlaceholder.tsx`（被 AppShell 取代）。

## 关键文件

- `frontend/src/conversations/useConversationLoader.ts`：UI 与会话 API 之间唯一的编排入口，返回 `items/selectedId/listStatus/detail/detailStatus` + 五个动作。选择失败时统一进 `forbidden`，仅 403/404 才清理选择与持久化。
- `frontend/src/app/AppShell.tsx`：工作台总装配。bootstrap effect 故意空依赖（仅挂载时跑一次），已 `eslint-disable react-hooks/exhaustive-deps`。`showWelcome = selectedId == null || messages.length === 0`。
- `frontend/src/conversations/Sidebar.tsx`：按 `updated_at` 分「今天/昨天/更早」三组；行下拉菜单用 `.history-menu`（内联定位）+ `.sheet-item` 条目；删除经 `onRequestDelete` 回调，实际确认框由 AppShell 管 `ui.confirmDialog`。
- `frontend/src/styles/chat.css`：所有外壳类名沿用 demo，便于与 `chatapp_demo` 比对回归。
- `frontend/src/conversations/selectionStore.ts`：选择持久化的事实源，`useConversationLoader` 与 `AppShell` 共同维护其与 reducer 选择态的一致。

## 设计决策

### 样式集中到单个 chat.css（对 spec 的偏差）

spec 原列「每组件一份 CSS」。本计划改为把共享外壳样式集中到单个 `styles/chat.css`（demo 本身即单文件样式），认证页保留独立 `AuthScreen.css`。减少重复与回归面，类名与 demo 一一对应。

### 选择持久化与事实源

- `selectionStore`（localStorage）是「上次选择」的事实源；reducer 的 `conversationIndex.selectedId` 是渲染镜像。
- `selectConversation` 成功才 `save`；`newConversation` 与 403/404 失效都 `clear`，保证刷新恢复时不会指向已删除/无权会话。

### 403/404 静默清理

`selectConversation` 捕获错误统一 dispatch `detailForbidden`；只有 `ApiError` 且 status 为 403/404 时才进一步清空选择并 `selectionStore.clear()`，回到空白欢迎态——避免刷新后停在一个已失效的会话上。其它错误仅置 forbidden（简化态，后续可细化为错误重试）。

### Markdown 安全渲染

刻意不启用 `rehype-raw`：`react-markdown` 默认忽略原始 HTML，`rehype-sanitize` 作为第二道防线。两者叠加确保历史消息里的危险 HTML（如 `<img onerror>`）不会被渲染。

### 发送禁用的形态

Composer 发送按钮始终 `disabled`，`onKeyDown` 拦截 Enter（含 `isComposing` 判断）但不触发任何发送。装饰按钮（附件/模式/语音）为静态占位。键盘/IME 结构保留，便于后续步骤直接接 SSE 提交。

## 计划外必要改动 / 修复

### 1. Message 复制测试的 clipboard mock 顺序（Task 11）

计划给的测试在 `userEvent.setup()` 之前用 `Object.assign(navigator, { clipboard })` 注入 spy，但 user-event v14 的 `setup()` 会安装自己的（不可写）clipboard stub，导致 spy 永不被调用、`Object.assign` 也无法覆盖。改为在 `setup()` 之后 `vi.spyOn(navigator.clipboard, "writeText")`，保留测试原意。组件本身无需改动。

### 2. 侧栏行下拉菜单样式缺失（修复，`01b895c`）

行下拉菜单条目用 `.sheet-item` 类，但移植 `chat.css` 时刻意排除了所有 `.sheet-*`（计划把 BottomSheet 留到后续步骤）。结果菜单条目无 flex 布局/间距/hover/红色删除态。补回 `.sheet-item`（`:hover`/`.destructive`/`:disabled`）规则，并把 Sidebar 内联菜单样式（`transition`、条目 `border-radius`）对齐 demo。

### 3. hover 揭示菜单按钮导致行抖动（修复，`c6213ed`）

普通行的三点 `.menu-btn` 仅在 hover 时 `display: none → inline-flex`，而该按钮高 22px、略高于标题行盒（line-height 1.6 ≈ 21.6px），揭示时使行高增加亚像素，按 DPI/缩放四舍五入偶发 1px 抖动，把下方各行往下推（active 行常驻该按钮，故表现"有时"）。给 `.history-row` 设 `line-height: 22px`，使行盒高度不再依赖按钮是否显示，彻底消除抖动且保留 demo 外观。

## 验证结果

```bash
cd frontend
pnpm exec vitest run    # 115 个测试全部通过（31 个测试文件）
pnpm run typecheck      # 通过
pnpm run lint           # 通过
pnpm run build          # 通过，产物输出到 frontend/dist/
```

测试矩阵（本次新增）：conversationIndex/Detail reducer（加载/错误/选择/重命名/删除/forbidden/reset/重命名同步）、uiReducer（移动抽屉/折叠/确认框/reset）、selectionStore（空/读写/清理/损坏值）、useConversationLoader（加载列表/选择持久化/404 清理/新建重置/重命名/删除回退）、icons/Wordmark、Markdown（GFM/拒绝危险 HTML）、ThinkingBlock（折叠/展开）、Message（用户气泡/助手 markdown+思考/复制/禁用按钮）、MessageThread、Composer（占位符/发送禁用/输入/Enter 不提交）、ConfirmDialog（确认/取消）、Topbar（标题三态）、Sidebar（分组/空占位/重命名/删除/退出）、AppShell（挂载加载列表/选择加载详情/空白欢迎态）、App 认证门（未登录→认证页 / 恢复 session→工作台欢迎态 / 退出→回认证页）。

未做计划的「Step 5 本地跨域 smoke」（需同时起前后端手动验证），属可选。

## 当前边界

已完成：

- 登录后进入真实聊天工作台（取代 `AuthedPlaceholder`），视觉与 `chatapp_demo` 一致。
- 列表加载 + 按日期分组 + 选择详情（只读 Markdown + 思考）+ 新建空白态 + 重命名 + 删除（确认框）+ 刷新恢复 + 403/404 静默清理。
- 退出/身份失效清空列表、详情、选择持久化并回认证页（复用既有 `app/reset`）。

未完成，留给后续任务：

- **发送 + SSE 流式**：接 Composer 提交 → 创建 Run → `useRunStream` 流式渲染（`after_seq` 重放、delta 拼接、status pill、draftId、取消、终态），打通 `ThinkingBlock` 的 `streaming` 模式。
- **编辑 / 重新生成**：放开 Message 的「编辑并重发」「重新生成」禁用态，接对应 API。
- **Toast / BottomSheet**：移动端底部操作面板与提示，对应 demo 的 `.sheet-*` / `.toast`（样式尚未移植，仅补了菜单复用的 `.sheet-item`）。
- **自动标题 pending 态**：`conversationIndex.pendingTitleIds` 已锁类型，Topbar/Sidebar 的标题骨架结构已就位，待自动总结标题接入后驱动。

## 注意事项

- `chatapp_demo/` 已从 git 移除（commit `77d0984`）但仍存在于工作区，作为视觉/样式的对照来源；移植 `chat.css` 时若需复查请直接看该目录。
- 样式类名全部沿用 demo，改样式请优先在 `chat.css` 内对照 demo 修改，避免改动组件结构造成回归。
- 测试中始终通过 `createFakeServices(authApi, conversationApi)` 注入 fake，不触达真实 HTTP；`renderWithApp`/`makeWrapper` 已封装 services 注入。
- `AppShell` 的 bootstrap effect 刻意空依赖只跑一次；若改动其内部依赖请勿移除 eslint-disable 之外再引入闭包陈旧问题。
- 运行/构建需注入 `VITE_API_BASE_URL`（如 `http://127.0.0.1:8000/api/v1`），且后端 `CORS_ALLOWED_ORIGINS` 需含前端 dev 源（`http://localhost:5173`）。

## 关联文档

- 本次对应计划：`docs/superpowers/plans/2026-06-08-frontend-conversation-list-and-detail.md`
- 对应 spec：`docs/superpowers/specs/2026-06-08-frontend-conversation-list-and-detail-design.md`
- 前序状态层与认证交接：`docs/handover/frontend/2026-06-06-frontend-state-and-auth.md`
- 重构总设计：`docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`
