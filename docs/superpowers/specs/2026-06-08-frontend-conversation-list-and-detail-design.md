# 前端会话列表与详情设计

日期：2026-06-08

## 目标

承接 `2026-05-24-frontend-react-rebuild-design.md` 的实施顺序，落地其中第 6–7 步：

- 第 6 步：聊天外壳（侧栏、顶栏、移动抽屉、空白欢迎态、Composer 骨架）。
- 第 7 步：接入会话列表、会话详情、选择持久化与刷新恢复（非流式部分）。

当前登录后只渲染 `AuthedPlaceholder`（用户名 + 退出），没有任何聊天外壳。本设计第一次让登录用户进入真实工作台：左侧看到自己的历史会话列表，点击可加载并只读阅读该会话的消息，能新建、重命名、删除会话，刷新后恢复上次选择——但**还不能发送消息**（发送与 SSE 是下一步）。

实现阶段必须严格复现 `chatapp_demo/`（即各 spec 中的 `uiux_v1`）的组件样式与交互：`Sidebar`、`Topbar`、`Message`、`ThinkingBlock`、`Composer`、`ConfirmDialog`、`Wordmark` 的视觉语言、布局结构、交互密度都以 demo 为验收基准。

## 已确认决策

| 决策点 | 选择 |
|--------|------|
| 外壳范围 | 含完整外壳骨架：侧栏 + 顶栏 + 移动抽屉 + 主阅读区 + 空白欢迎态 |
| 会话管理 | 纳入重命名（就地输入）与删除（带轻量 `ConfirmDialog`） |
| 刷新恢复 | 仅非流式恢复：读 `selectedConversationId` → 加载详情 → 回填已持久化消息；`403/404` 静默清理回空白态。进行中 run 的 SSE 接管留到 step 8/9 |
| 消息渲染 | 含 Markdown + 思考过程，**只读**；复制可用；编辑/重新生成按钮渲染但禁用（真实逻辑留 step 10） |
| Composer | 按 demo 复现视觉与空白欢迎态布局，但**发送禁用**（发送/SSE 留 step 8） |
| 视觉基准 | 严格复现 `chatapp_demo` 的组件样式与交互 |
| 新建对话 | 纯本地空白态，不创建服务端会话行；真实会话行在首次发送后才出现（step 8） |
| 组件组织 | 按 rebuild spec 目录表 feature-colocated（`conversations/`、`messages/`、`ui/`），CSS 与组件同目录 |
| 列表更新策略 | 重命名/删除先调 API，再以响应/成功为准更新状态（非乐观更新） |
| 设计 token | 从 `.auth-shell` 作用域抽到 `:root` 的共享 `styles/tokens.css`，全局引入 |

## 范围

### 本步包含

- 抽出共享设计 token 到 `styles/tokens.css`，全局引入；从 demo `styles.css` 移植外壳/侧栏/消息/Markdown/对话框/Composer 样式。
- `conversationIndex` / `conversationDetail` 两个切片做实 feature actions。
- `ui` 切片新增 `confirmDialog` 状态（删除确认用）。
- `Services` 新增 `conversationApi`，在 `AppProvider` 装配。
- 新增 `selectionStore`（localStorage）持久化当前选择，启动恢复。
- 做实 `useConversationLoader`：列表加载、选择加载详情、启动恢复、`403/404` 清理。
- 聊天外壳组件：`AppShell`（替换 `AuthedPlaceholder`）、`Sidebar`、`Topbar`、`MessageThread`、`Message`、`ThinkingBlock`、`Markdown`、`Composer`（禁用发送）、`ConfirmDialog`、`Wordmark`、`icons`。
- 新增依赖：`react-markdown`、`remark-gfm`、`rehype-sanitize`、`lucide-react`。
- 上述全部用 Vitest + Testing Library + MSW 覆盖。

### 本步不包含（留给后续步骤）

- 发送消息、创建 Run、SSE 流式（step 8）。
- 进行中 run 的刷新恢复 / `after_seq` 接管（step 8/9）。
- 停止生成、失败/取消 partial 内容（step 9）。
- 标题 pending 轮询、编辑并重新生成、重新生成回答（step 10）。
- 全局 Toast、移动端消息操作 BottomSheet（step 11）。
- 后端、Nginx、CI/CD、部署文档。

### 计划内的临时偏差（与「严格复现」的取舍）

两处偏差源于后续步骤尚未就绪，必须在本步临时让步，已与需求方确认接受：

1. **编辑 / 重新生成按钮渲染但禁用。** 其真实逻辑依赖 step 8/10。本步按 demo 渲染操作行以保持视觉完整，但 `编辑并重发` / `重新生成` 处于禁用态，title 提示「即将接入」。复制按钮正常可用。step 10 接入后解除禁用。
2. **移动端消息操作显示内联复制，而非 demo 的 BottomSheet。** `BottomSheet` 与 `Toast` 属 step 11。本步移动端消息操作行直接展示可点的复制入口；完整底部操作面板与 toast 反馈在 step 11 落地。

> 说明：删除后的「已删除」提示、复制后的「已复制」提示在 demo 中用 toast。本步 toast 系统未引入，复制执行剪贴板写入但不弹提示，删除直接移除行 + 回退选择。视觉反馈在 step 11 补齐。

## 背景与依赖

本步直接消费已就绪的层，不重复实现：

- 状态容器（`docs/handover/frontend/2026-06-06-frontend-state-and-auth.md`）：单根 `rootReducer` + State/Dispatch 双 Context（`src/app/store.ts`、`src/app/context.ts`）、`AppProvider` 装配单例 `ApiClient`、全局 `app/reset`、启动恢复 session。
- 通信层（`docs/handover/frontend/2026-05-24-frontend-communication-foundation.md`）：`conversationApi`（`src/api/conversations.ts`，已实现 `list/create/detail/rename/remove/...` 并可注入 client）、`ApiClient`（envelope 解析、401 单次 refresh/retry、`onAuthExpired`）、`ApiError` 与中文映射、类型定义（`src/api/types.ts`）。
- 占位切片与占位 hook（步骤 4-5 留下）：`conversationIndex/Detail` 仅处理 RESET；`useConversationLoader` 抛未实现——本步替换。

后端会话契约（来自 `app/api/v1/conversations.py`、`app/services/conversations/service.py`）：

| 端点 | 行为 | 关键语义 |
|------|------|----------|
| `GET /conversations` | 列表 | **只返回 `activated_at IS NOT NULL` 且未删除**，按 `updated_at DESC, id DESC` 排序。草稿不在列表中 |
| `GET /conversations/{id}` | 详情 | 返回会话 + 按 `position ASC` 的未归档消息；不属于当前用户或不存在 → 404 |
| `PATCH /conversations/{id}` | 重命名 | body `{title}`；返回更新后的 `ConversationResponse`（含新 `updated_at`） |
| `DELETE /conversations/{id}` | 删除 | 软删除；返回 `{status}` |

类型（`src/api/types.ts`，已存在）：

- `ConversationResponse = { id, title: string|null, activated_at, created_at, updated_at }`
- `MessageResponse = { id, conversation_id, run_id, role: "user"|"assistant", content, reasoning: string|null, position, created_at }`
- `ConversationDetailResponse = ConversationResponse & { messages: MessageResponse[] }`

## 状态架构

沿用步骤 4-5 的单根 reducer + 双 Context + 领域 hook 窄 API 面。本步把两个占位切片做实，并扩展 `ui` 切片。

### conversationIndex 切片

```ts
type ConversationIndexState = {
  items: ConversationResponse[];
  selectedId: number | null;   // null = 新建/空白态
  draftId: number | null;      // 预留，step 8 真正赋值
  pendingTitleIds: number[];   // 预留，step 10 填充
  status: "idle" | "loading" | "error";
};
```

actions：

```ts
type ConversationIndexAction =
  | { type: "conversations/listLoading" }
  | { type: "conversations/listLoaded"; items: ConversationResponse[] }
  | { type: "conversations/listError" }
  | { type: "conversations/selected"; id: number | null }   // null = 新建空白
  | { type: "conversations/renamed"; conversation: ConversationResponse }
  | { type: "conversations/removed"; id: number };
```

转移要点：

- `selected` 设 `selectedId`；`id=null` 表示进入新建空白态（不触详情请求，由 hook 配合 `detailReset`）。
- `renamed` 用响应替换 `items` 中对应项（含新 `title`/`updated_at`），不重排（保持当前视觉稳定；重排只在列表重新加载时按后端顺序）。
- `removed` 从 `items` 过滤掉该 id。若删除的是 `selectedId`，selectedId 的回退由 hook 决定（见「删除」）。
- 新建（`selected` 传 null）不向 `items` 添加任何行——草稿不进列表，符合后端语义。

### conversationDetail 切片

```ts
type ConversationDetailState = {
  conversation: ConversationResponse | null;
  messages: MessageResponse[];
  status: "idle" | "loading" | "ready" | "forbidden";
};
```

actions：

```ts
type ConversationDetailAction =
  | { type: "conversations/detailLoading" }
  | { type: "conversations/detailLoaded"; conversation: ConversationResponse; messages: MessageResponse[] }
  | { type: "conversations/detailForbidden" }   // 403/404：失效选择
  | { type: "conversations/detailReset" };       // 回空白态（新建）
```

转移要点：

- `detailLoaded` 置 `status="ready"`，回填 `conversation` 与 `messages`。
- `detailForbidden` 置 `status="forbidden"` 并清空 `conversation/messages`；hook 随后清理 `selectedId` 与持久化选择。
- `detailReset` 回到 `initial`（新建空白态：无 conversation、无 messages、`status="idle"`）。

### ui 切片扩展

```ts
type ConfirmDialogState = {
  kind: "deleteConversation";
  conversationId: number;
};

type UiState = {
  mobileSidebarOpen: boolean;       // 已存在
  sidebarCollapsed: boolean;        // 桌面侧栏收起（demo 的 sidebarOpen 取反）
  confirmDialog: ConfirmDialogState | null;
};
```

actions：`ui/toggleMobileSidebar`、`ui/setMobileSidebar`、`ui/toggleSidebarCollapsed`、`ui/openConfirm`、`ui/closeConfirm`。

> Toast 与 BottomSheet 状态本步不加（step 11）。`composer` 切片维持现状（`input` / `isComposing`）；本步 Composer 可本地输入但发送禁用，是否经 reducer 由实现决定，最小化即可。

### 全局 RESET

`app/reset` 仍由退出登录与 `onAuthExpired` 触发，把全部切片清回初始值。本步两个做实切片必须在 RESET 时回 initial（已有占位逻辑保留）；`ui` 新字段也回 initial。RESET 时同步清理 `selectionStore`（见持久化）。

## 选择持久化（selectionStore）

仿照 `tokenStore` 新增 `src/conversations/selectionStore.ts`：

```ts
selectionStore.read(): number | null     // 读 selectedConversationId
selectionStore.save(id: number): void
selectionStore.clear(): void
```

- 仅持久化 `selectedConversationId`（数字）。`draftConversationId` 的持久化随发送（step 8）落地，本步不写。
- 损坏值（非数字）自动清理，返回 `null`。
- 写入时机：选择真实会话成功加载详情后。新建空白态（null）时 `clear`。
- 读取时机：启动恢复一次。
- `403/404` 与全局 RESET 时 `clear`。

## hook：useConversationLoader

替换占位实现，作为会话数据的唯一副作用编排入口。它消费 `useAppState`/`useAppActions`（含新增的 `conversationApi`），向 UI 暴露窄 API。

暴露（建议）：

```ts
{
  items, selectedId, detail, detailStatus, listStatus,
  selectConversation(id: number),
  newConversation(),
  renameConversation(id, title),
  deleteConversation(id),
}
```

编排（hook 负责副作用，reducer 不发请求）：

### 登录后加载列表

`AppShell` 挂载（已认证）时加载一次列表：

```
dispatch listLoading
try items = conversationApi.list()
    dispatch listLoaded(items)
catch dispatch listError
```

`onAuthExpired` 已由 client 统一处理（reset）；列表的 401 走 client 的 refresh/retry，无需 hook 特判。

### 选择会话

```
selectConversation(id):
  dispatch selected(id)
  dispatch detailLoading
  try { conversation, messages } = conversationApi.detail(id)
       dispatch detailLoaded(conversation, messages)
       selectionStore.save(id)
  catch e:
       if e is 403/404 -> dispatch detailForbidden; dispatch selected(null); selectionStore.clear()
       else -> 详情错误态（复用 detailForbidden 或保留上次；本步用 forbidden 简化并提示中文）
  移动端选择后关闭抽屉（dispatch setMobileSidebar(false)）
```

### 新建对话

```
newConversation():
  dispatch selected(null)
  dispatch detailReset()
  selectionStore.clear()
  composer 清空；移动端关闭抽屉
```

不调用任何 API；进入空白欢迎态。

### 重命名

```
renameConversation(id, title):
  trimmed = title.trim()
  if trimmed === "" -> 不提交（保持原标题，退出重命名）
  conv = conversationApi.rename(id, trimmed)
  dispatch renamed(conv)
  if id === selectedId 且详情已加载 -> 同步详情 conversation（topbar 标题）
```

### 删除

```
deleteConversation(id):  // 由 ConfirmDialog 确认后调用
  conversationApi.remove(id)
  dispatch removed(id)
  if id === selectedId:
      next = items 中删除后的第一项
      if next -> selectConversation(next.id)
      else -> newConversation()
  dispatch closeConfirm
```

### 启动恢复（非流式）

`AppShell` 挂载时，在加载列表之后：

```
storedId = selectionStore.read()
if storedId != null:
    selectConversation(storedId)   // 内部已处理 403/404 -> 清理回空白
else:
    newConversation()              // 空白欢迎态
```

- 不查找进行中 run、不调用 `runApi.state`、不建立 SSE——这些是 step 8/9。即使被恢复会话有进行中 run，本步只展示服务端已持久化的消息，输入区保持发送禁用。
- 会话 `403/404`：静默清理失效选择，回空白态，不显示生硬资源错误（符合 UI/UX spec「对话不可访问」）。

## 组件设计

全部以 `chatapp_demo/components.jsx` + `styles.css` 为复现基准。demo 中由 Tweaks 驱动的可变项，本步取 demo 默认值并固化（不引入 Tweaks 面板）：`thinkingMode="block"`、`thinkingDefaultOpen=false`、`assistantLayout="plain"`、`composerLayout="bottom"`，圆角/密度等取 `TWEAK_DEFAULTS` 的值作为静态 CSS 常量。

### 目录与文件

| 文件 | 职责 |
|------|------|
| `src/styles/tokens.css` | 从 demo `styles.css` `:root` 抽出的设计 token（颜色、字体、半径、密度、reading-width、sidebar-width 等），全局引入 |
| `src/styles/global.css` | 既有；改为引入 tokens，移除无用的 `.app-shell`/`.app-card` 占位样式（属本步产生的孤儿，清理） |
| `src/app/AppShell.tsx` | 替换 `AuthedPlaceholder`：装配 `useConversationLoader`、移动检测、侧栏收起，组合 Sidebar + 主列（Topbar + 线程 + Composer） |
| `src/app/AppShell.css` | 外壳布局样式（`.app`、`.main`、`.thread-region`、`.composer-area`、空白态过渡） |
| `src/conversations/Sidebar.tsx` + `.css` | 品牌行、新建对话、按日期分组历史、行内重命名、行菜单（重命名/删除）、账号区/退出、移动抽屉 + 遮罩 |
| `src/conversations/Topbar.tsx` + `.css` | 当前标题 / 「新对话」/ 标题 skeleton；移动端打开抽屉 + 新建入口；桌面端展开侧栏 |
| `src/messages/MessageThread.tsx` | 渲染 `messages` 列表（空白态由 AppShell 处理）；阅读列最大宽度对齐 |
| `src/messages/Message.tsx` + `.css` | 用户气泡（靠右）/ 助手正文（靠左）；操作行（复制可用、编辑/重新生成禁用）；状态 pill（结构就绪，本步无 run 不触发） |
| `src/messages/ThinkingBlock.tsx` | reasoning 折叠区（block 模式）：默认收起、可展开；历史消息无流式 pulse |
| `src/messages/Markdown.tsx` + `markdown.css` | `react-markdown` + `remark-gfm` + `rehype-sanitize`，套用 demo `.md` 样式 |
| `src/ui/ConfirmDialog.tsx` + `.css` | 复现 demo ConfirmDialog（标题/正文/取消/确认，destructive 变体） |
| `src/ui/Composer.tsx` + `.css` | 复现 Composer 视觉；textarea 自增高、Enter/Shift+Enter/IME 处理保留，但**发送按钮禁用且 onSend 为 no-op**（本步） |
| `src/ui/Wordmark.tsx` | 文字标识 |
| `src/ui/icons.tsx` | `lucide-react` 图标映射（More/Pen/Trash/Plus/PanelLeft/LogOut/Menu/Chevron/Copy/Pencil/Refresh/ArrowUp/Mic/Stop/X 等） |

> `AuthedPlaceholder.tsx` 删除（被 `AppShell` 取代）；`App.tsx` 把已登录分支由 `AuthedPlaceholder` 改为 `AppShell`。

### Sidebar

复现 `chatapp_demo` Sidebar：

- 顶部品牌行：`Wordmark` + 桌面端「收起侧栏」按钮（`PanelLeft`）。
- 「新建对话」按钮（`Plus` + 文案 + 桌面 `⌘N` 提示）；点击 → `newConversation()`，移动端关闭抽屉。`⌘/Ctrl+N` 快捷键同样触发新建。
- 历史按 `updated_at` 分组为「今天 / 昨天 / 更早」（复用 demo 的分组逻辑，基于本地时区 `toDateString`）。
- 历史行：标题省略号；hover/active 显示「更多」菜单按钮；菜单含「重命名」「删除对话」。
- 行内重命名：进入即选中文本，`Enter` 提交、`Esc` 取消、`blur` 提交；提交调 `renameConversation`。
- 删除：菜单点「删除对话」→ `dispatch openConfirm({kind:"deleteConversation", conversationId})`；`ConfirmDialog` 确认后 `deleteConversation`。
- 空列表占位文案：「还没有已保存的对话。开始一次对话后会自动出现在这里。」
- 账号区：头像（用户名首字母）+ 邮箱 + 退出按钮（`LogOut`）→ `logout()`。
- 移动端：抽屉 + 遮罩（`.scrim`），`mobileSidebarOpen` 驱动；选择/新建后关闭。

> demo 用 `window.dispatchEvent` 自定义事件做侧栏 toggle / 新建。React 版改为通过 `useAppActions` dispatch（`ui/toggleSidebarCollapsed`）和 hook 回调，不用全局事件。

### Topbar

- 桌面端侧栏收起时显示展开按钮；移动端显示打开抽屉按钮 + 新建按钮。
- 标题：有标题显示标题；`title` 为空显示「新对话」（muted）；`pendingTitleIds` 命中显示 skeleton（本步不会触发，结构就绪）。

### Message / ThinkingBlock / Markdown

- 用户消息：浅色气泡靠右，`white-space: pre-wrap`，原样文本。
- 助手消息：靠左正文（`assistantLayout="plain"`），`Markdown` 渲染 `content`。
- 思考过程：`reasoning` 存在时在正文上方渲染 `ThinkingBlock`（block 模式，默认收起，可点击展开）。历史消息无 `streaming`，不显示 pulse/「思考中…」，显示「已思考」。
- Markdown 安全：`rehype-sanitize` 白名单；代码块、表格、引用、链接等套 demo `.md` 样式。
- 操作行：桌面 hover/focus 显示；复制（`navigator.clipboard.writeText`）可用；编辑并重发 / 重新生成渲染但 `disabled`，title「即将接入」。移动端显示内联复制（见偏差 2）。
- 状态 pill（已停止/生成失败）结构按 demo 就位，但本步无 run、不会出现；保留以便 step 9 复用。

### Composer

- 复现 demo Composer：自增高 textarea、左右工具按钮（附件/模型模式/语音为静态装饰，与 demo 一致）、发送按钮。
- `placeholder` 用 demo 的「有问题，尽管问」。
- 本步 **发送禁用**：发送按钮始终 disabled（或点击 no-op），不创建消息/run。Enter/Shift+Enter/IME 的键盘处理保留以便 step 8 直接接上，但 Enter 在本步不触发发送。
- 空白欢迎态：`showWelcome = selectedId==null 或 当前会话无消息` 时，主区展示欢迎标题「我们先从哪里开始呢？」+ Composer 居中（复现 demo 的 `welcome-section` / `spacer-below` 过渡）。

## 样式迁移

1. 新建 `src/styles/tokens.css`，把 demo `styles.css` 的 `:root` 变量整体移入（去掉 Tweaks 注入的动态项，改为固定默认值：`--reading-width:820px`、`--composer-radius:18px`、`--send-radius:18px`、`--history-radius:6px`、`--user-bubble-radius:10px`、`--msg-gap:32px`（loose）等，取 `TWEAK_DEFAULTS`）。
2. `global.css` 引入 tokens；移除无用的 `.app-shell`/`.app-card`。
3. `AuthScreen.css` 去掉重复声明的 token 块，改用全局 token（认证页视觉不变）。
4. 按组件就近拆分移植 demo 的外壳/侧栏/消息/Markdown/对话框/Composer/移动端样式到各 `.css`，类名沿用 demo（`.sidebar`、`.history-row`、`.msg`、`.thinking`、`.composer` 等）以减少认知负担与回归风险。

## 测试策略

Vitest + Testing Library + MSW；HTTP 经注入 client 的 fake `conversationApi`（沿用 `src/test/appHarness.tsx` 的 services 注入模式，新增 `conversationApi` fake）。

| 测试对象 | 用例 |
|----------|------|
| `rootReducer`（index） | listLoading/Loaded/Error；selected(id/null)；renamed 替换对应项；removed 过滤；`app/reset` 清回 initial |
| `rootReducer`（detail） | detailLoading/Loaded/Forbidden/Reset；reset 回 initial |
| `rootReducer`（ui） | openConfirm/closeConfirm；toggle 移动/收起；reset 清空 |
| `selectionStore` | save/read/clear；损坏值返回 null 并清理 |
| `useConversationLoader` | 挂载加载列表；select→detail 成功回填 + selectionStore.save；select 403/404→forbidden + selected(null) + clear；new→reset + clear；rename 调 API + dispatch renamed；delete 调 API + removed + 回退选择/新建；启动恢复（有/无 storedId） |
| `Sidebar` | 分组渲染（今天/昨天/更早）；空列表占位；行内重命名 Enter/Esc/blur；菜单→删除→ConfirmDialog→确认调 onDelete；新建/选择移动端关抽屉；退出调 logout |
| `Topbar` | 有标题/空标题(新对话)/skeleton 三态；移动与桌面按钮分支 |
| `Message` / `Markdown` | 用户气泡原样文本；助手 Markdown（GFM 列表/代码块/链接）渲染；`rehype-sanitize` 拦截危险 HTML；复制调用 clipboard；编辑/重新生成 disabled |
| `ThinkingBlock` | 有 reasoning 渲染、默认收起、点击展开；无 reasoning 不渲染 |
| `Composer` | 发送按钮 disabled；输入可编辑；Enter 不触发发送（本步） |
| `ConfirmDialog` | 渲染标题/正文；取消/确认回调；destructive 变体 |
| `App` 认证门 | 已登录渲染 `AppShell`（取代 AuthedPlaceholder） |

MSW 用于需要真实 client 路径的集成型测试；多数 hook/组件测试用注入 fake services。

## 验收标准

- `frontend` 下 `pnpm run lint`、`pnpm run typecheck`、`pnpm exec vitest run`、`pnpm run build` 全部通过。
- 登录后进入聊天工作台（取代占位页）：桌面常驻侧栏、移动抽屉、主阅读区、空白欢迎态、Composer 骨架，视觉与 `chatapp_demo` 一致。
- 侧栏展示当前用户的已激活会话列表，按日期分组、按 `updated_at` 倒序。
- 点击会话加载详情并只读渲染消息：用户气泡、助手 Markdown 正文、思考过程折叠区。
- 新建对话进入空白欢迎态，不创建服务端会话行、不向列表加行。
- 重命名（就地输入）与删除（ConfirmDialog 确认）可用并正确更新列表/详情；删除当前会话后回退到下一项或空白态。
- 刷新页面后恢复上次选择并加载详情；失效会话（403/404）静默清理回空白态。
- Composer 发送禁用，不产生消息或 run。
- 退出登录 / 身份失效清空列表、详情、选择持久化并回到认证页。
- 用户可见文案统一中文。
- 后续步骤所需的状态结构（pendingTitleIds、status pill、draftId、Composer 键盘处理）已就位，便于 step 8–11 接续。

## 已知后续问题（不在本步解决）

- **发送与 SSE 流式**：step 8。Composer 发送、创建 Run、`events?after_seq` 流式渲染。
- **进行中 run 的刷新恢复**：step 8/9。`runApi.state` + `after_seq` 接管、partial 内容、停止/失败/取消终态。
- **标题 pending 与编辑/重新生成**：step 10。`pendingTitleIds` 轮询填充、编辑并重发、重新生成回答解除禁用。
- **全局 Toast / 移动 BottomSheet**：step 11。复制/删除反馈、移动端消息操作面板。
- **流式重渲染收敛**：step 8 token delta 阶段处理（双 Context 已预留空间）。

## 关联文档

- 重构总设计：[`2026-05-24-frontend-react-rebuild-design.md`](2026-05-24-frontend-react-rebuild-design.md)
- 状态层与认证页设计：[`2026-05-24-frontend-state-reducer-and-auth-design.md`](2026-05-24-frontend-state-reducer-and-auth-design.md)
- UI/UX 蓝图：[`2026-05-23-frontend-ui-ux-redesign-design.md`](2026-05-23-frontend-ui-ux-redesign-design.md)
- 状态与认证交接：[`../../handover/frontend/2026-06-06-frontend-state-and-auth.md`](../../handover/frontend/2026-06-06-frontend-state-and-auth.md)
- 通信基础层交接：[`../../handover/frontend/2026-05-24-frontend-communication-foundation.md`](../../handover/frontend/2026-05-24-frontend-communication-foundation.md)
- 会话模块（后端）：[`../../handover/2026-05-17-conversation-module.md`](../../handover/2026-05-17-conversation-module.md)
- 草稿对话与自动标题：[`2026-05-19-auto-title-and-draft-conversation-design.md`](2026-05-19-auto-title-and-draft-conversation-design.md)
- 模块边界：[`../../architecture/module-boundaries.md`](../../architecture/module-boundaries.md)
