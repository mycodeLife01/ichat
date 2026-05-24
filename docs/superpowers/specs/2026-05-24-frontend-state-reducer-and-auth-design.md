# 前端状态层与认证页设计

日期：2026-05-24

## 目标

承接 `2026-05-24-frontend-react-rebuild-design.md` 的实施顺序，落地其中两步：

- 第 4 步：建立 React 状态 reducer 与核心 hooks 架构。
- 第 5 步：实现认证页（登录/注册），接入真实认证 API。

本设计在已完成的通信基础层（`frontend/src/api/*`、`frontend/src/auth/tokenStore.ts`，见 `docs/handover/frontend/2026-05-24-frontend-communication-foundation.md`）之上，建立 React 状态容器、全局 reset 编排和认证流程，使应用第一次拥有「未登录看认证页、登录后进入受保护视图」的完整闭环。

## 已确认决策

| 决策点 | 选择 |
|--------|------|
| reducer 实现范围 | 现在锁定整棵状态树的**类型与架构**；只**做实 auth 切片**；conversation/run/composer/ui 切片留类型占位 + 统一 RESET；`useConversationLoader`/`useRunStream` 本步只留签名占位 |
| 状态容器形态 | 单根 reducer + State/Dispatch 拆分两个 Context + 领域 hook 提供窄 API 面（方案 A） |
| ApiClient 装配 | App 自建**单例 `ApiClient`**，`onAuthExpired` 接到全局 RESET + abort 进行中 stream；注入给各 domain API |
| token 事实源 | 请求用 token 以 `tokenStore` 为事实源；reducer 的 auth 切片是渲染镜像，在 login/register/logout/restore/expire 几个编排点同步 |
| 认证页跨表单错误 | 本步在认证卡内用**表单级错误条**展示；全局 Toast 留到第 11 步 |
| 登录成功后落点 | 渲染**最小「已登录占位」**（用户名 + 退出按钮），第 6 步替换为真正聊天 shell |
| 注册字段 | `username` + `email` + `password`，**不加二次确认密码**（对齐后端） |
| 视觉基准 | 认证入口以 `uiux_v1` 已确认设计为准，仅做生产化（真实校验、真实 API、提交态、中文错误） |

## 范围

### 本步包含

- `app/` 下建立 `rootReducer`、`AppState`、`initialState`、全局 `RESET` action。
- `AppProvider`：装配 `useReducer`、单例 `ApiClient`、State/Dispatch 两个 Context、启动时从 `tokenStore` 恢复会话。
- 上下文读取/派发 hook：`useAppState`、`useAppDispatch`、`useServices`。
- auth 切片（类型/初始值/reducer/actions）做实。
- `useAuthSession`：登录、注册、退出、提交态、身份失效编排做实。
- auth 专属中文错误映射。
- `AuthScreen`：登录/注册单卡片、客户端校验、提交态、模式切换、回车提交、错误展示。
- 认证门（未登录 → `AuthScreen`，已登录 → 最小占位）。
- 上述全部用 Vitest + Testing Library + MSW 覆盖。

### 本步不包含（留给后续步骤）

- conversation/run/composer/ui 切片的 action 转移逻辑（第 7–11 步各自的 spec）。
- `useConversationLoader`、`useRunStream` 的实现（仅留签名占位）。
- 真正的聊天 shell、侧栏、移动抽屉、composer、消息列表（第 6 步起）。
- 全局 Toast 系统、确认框、底部 sheet（第 11 步）。
- 流式高频更新导致的重渲染收敛（第 8 步处理，见「已知后续问题」）。
- 后端、Nginx、CI/CD、部署文档（第 3 步已做后端解耦，第 12 步做其余）。

## 背景与依赖

本步直接消费已就绪的通信层，不重复实现：

- `ApiClient`（`src/api/client.ts`）：统一 envelope 解析、`Authorization` 注入、**401 单次 refresh/retry**、`refresh` 失败时清空 `tokenStore` 并调用构造参数 `onAuthExpired`，抛出 `isAuthExpired: true` 的 `ApiError`。构造参数支持注入 `fetchImpl`、`tokenStore`、`onAuthExpired`。
- `createAuthApi(client?)`（`src/api/auth.ts`）：`register`/`login`/`refresh`/`logout`，可注入自定义 client；conversation/run API 同样支持注入。
- `tokenStore`（`src/auth/tokenStore.ts`）：`AuthSession` 结构、`createAuthSession(response, now?)`（按 `expires_in` 计算 `expiresAt`）、localStorage 持久化、损坏 JSON 自动清理。
- `ApiError` 与中文映射（`src/api/errors.ts`）：`getDefaultErrorMessage(status)` 已覆盖 401/403/404/409/422/5xx 的中文兜底；`toApiError` 把 abort/网络错误转中文。

后端认证契约（来自 `app/api/v1/auth.py`、`app/schemas/auth.py`、`app/services/auth/service.py`）：

| 端点 | 请求体 | 成功 | 失败 |
|------|--------|------|------|
| `POST /auth/register` | `username`(1–50)、`email`、`password`(8–128) | 201 + `AuthTokenResponse` | 409 `Username is already registered` / 409 `Email is already registered` / 422 校验 |
| `POST /auth/login` | `identifier`(用户名或邮箱)、`password` | 200 + `AuthTokenResponse` | 401 凭据无效 |
| `POST /auth/logout` | `refresh_token` | 200 + `CommandStatusResponse` | — |

`AuthTokenResponse` = `{ user: {id,username,email,email_verified}, access_token, refresh_token, token_type, expires_in }`。

## 状态架构

### 容器形态（方案 A）

- 一个 `rootReducer` 由各 slice reducer 组合而成，`useReducer` 放在 `AppProvider`。
- **State 与 Dispatch 分两个 Context**：只 dispatch 的组件不因 state 变化重渲染。
- 领域 hook（`useAuthSession` 等）在其上提供窄 API 面：组件只依赖自己用到的字段与动作，不直接碰整棵 state。注意：纯 Context 下 state 消费者仍会在任意 state 变化时重渲染，真正的重渲染收敛是第 8 步流式阶段的事（见「已知后续问题」）。
- 符合设计文档「reducer 负责状态转移、不直接发请求」「hooks 负责副作用编排」「API/SSE 模块不依赖 React」的分层原则。

不采用多领域 Context（跨 slice 协调如统一 RESET、active-run 互斥要跨 context 编排，样板多，与单 reducer 语义不符），也不采用单 Context 同放 state+dispatch（任何 state 变化都全量重渲染，流式必返工）。

### 状态树

```ts
type AppState = {
  auth: AuthState;                       // 做实
  conversationIndex: ConversationIndexState; // 占位
  conversationDetail: ConversationDetailState;// 占位
  activeRun: ActiveRunState;             // 占位
  composer: ComposerState;               // 占位
  ui: UiState;                           // 占位
};
```

做实的 auth 切片：

```ts
type AuthState = {
  session: AuthSession | null;   // 渲染镜像；token 事实源在 tokenStore
  status: "idle" | "submitting"; // 登录/注册提交态
  bootstrapped: boolean;         // 启动时是否已读过 tokenStore
};
```

占位切片只定义类型与初始值，本步仅处理 `RESET`（其余 action 留给第 7–11 步）。类型按设计文档「状态模型」落：

```ts
type ConversationIndexState = {
  items: ConversationResponse[];
  selectedId: number | null;
  draftId: number | null;
  pendingTitleIds: number[];
  status: "idle" | "loading" | "error";
};

type ConversationDetailState = {
  conversation: ConversationResponse | null;
  messages: MessageResponse[];
  status: "idle" | "loading" | "ready" | "forbidden";
};

type ActiveRunState = {
  runId: number;
  conversationId: number;
  latestSeq: number;
  draftText: string;
  draftReasoning: string;
  status: RunStatus;
  cancelRequested: boolean;
} | null;

type ComposerState = { input: string; isComposing: boolean };

type UiState = {
  mobileSidebarOpen: boolean;
  messageActionSheetMessageId: number | null;
  confirmDialog: ConfirmDialogState | null;
};
```

> **AbortController 不进 reducer。** 设计文档把 `AbortController` 列在 ActiveRun 概念字段里，但它不可序列化、属于副作用句柄。本步明确：reducer 只存 `cancelRequested` 等可序列化状态；`AbortController` 由第 8 步的 `useRunStream` 用 ref 持有。

### 全局 RESET

- `app/reset` 由两处触发：用户主动退出登录、`onAuthExpired`（refresh 失败）。
- 每个 slice reducer 都必须把自身清回初始值——这是占位切片本步唯一处理的 action。
- 例外：`auth` 切片 RESET 后 `session=null`、`status="idle"`、`bootstrapped=true`（已确认检查过 token，应直接展示认证页而非启动闪屏）。

## 模块与文件

| 文件 | 职责 | 本步状态 |
|------|------|----------|
| `src/app/store.ts` | `AppState`、`initialState`、各 slice action 类型、`rootReducer` | 新建 |
| `src/app/AppProvider.tsx` | `useReducer` + 单例 `ApiClient` 装配 + 两个 Context + 启动恢复 | 新建 |
| `src/app/contextHooks.ts` | `useAppState`、`useAppDispatch`、`useServices` | 新建 |
| `src/app/AuthedPlaceholder.tsx` | 临时已登录占位（用户名 + 退出），第 6 步替换 | 新建（临时） |
| `src/app/App.tsx` | 认证门：`bootstrapped` 守卫 + 未登录/已登录分支 | 改写 |
| `src/auth/state.ts` | auth 切片类型/初始值/reducer/actions | 新建 |
| `src/auth/useAuthSession.ts` | 登录/注册/退出/提交态/身份失效编排 | 新建 |
| `src/auth/authErrorMessages.ts` | auth 专属中文错误映射 | 新建 |
| `src/auth/AuthScreen.tsx` | 认证页主组件（+ 必要的就近表单子组件） | 新建 |
| `src/conversations/state.ts` | ConversationIndex/Detail 类型 + 初始值 + RESET | 新建（占位） |
| `src/runs/state.ts` | ActiveRun 类型 + 初始值 + RESET | 新建（占位） |
| `src/runs/useRunStream.ts`、`src/conversations/useConversationLoader.ts` | 核心 hook 签名占位（抛 `not implemented` 或返回空壳） | 新建（占位） |
| `src/main.tsx` | 用 `<AppProvider>` 包裹 `<App/>` | 改写 |

> ComposerState / UiState 暂置于 `src/app/store.ts`；待第 6/11 步有明确归属模块时再迁移，本步不为占位 slice 过度建目录。

## AppProvider 装配

这是本步最关键的接线，整个应用依赖一个配置好的 client。

```tsx
function AppProvider({ children, client: injectedClient }: Props) {
  const [state, dispatch] = useReducer(rootReducer, initialState);

  // onAuthExpired 需要 dispatch / abort，但它们只在组件树内存在 —— 用 ref 转发当前值
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const abortActiveStreamRef = useRef<() => void>(() => {}); // 第 8 步 useRunStream 注册

  const client = useMemo(
    () =>
      injectedClient ??
      new ApiClient({
        onAuthExpired: () => {
          abortActiveStreamRef.current();
          dispatchRef.current({ type: "app/reset" });
        },
      }),
    [injectedClient],
  );

  const services = useMemo(
    () => ({ authApi: createAuthApi(client) /* conversationApi/runApi 第 7+ 步接入 */ }),
    [client],
  );

  // 启动恢复：读 tokenStore 一次
  useEffect(() => {
    dispatch({ type: "auth/restored", session: tokenStore.read() });
  }, []);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={{ dispatch, services, abortActiveStreamRef }}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}
```

要点：
- **单例 client**：不使用 `getDefaultApiClient()`（它不带 `onAuthExpired`）。app 自建并注入给各 domain API。
- **ref 转发**：`onAuthExpired` 在 client 构造时只闭包一次，通过 ref 读到当前 `dispatch` 与 stream abort，避免 client 随每次渲染重建。
- **可注入**：`AppProvider` 支持注入 client，测试用注入了 `fetchImpl` 的 client，不依赖 `VITE_API_BASE_URL`。
- **abort seam**：`abortActiveStreamRef` 本步默认 no-op；`useRunStream`（第 8 步）通过 `useServices()` 注册真实 abort。身份失效时先 abort 再 reset，与设计文档「auth failure 统一 reset 并 abort active stream」一致。

## auth 切片与 useAuthSession

### actions

```ts
type AuthAction =
  | { type: "auth/restored"; session: AuthSession | null } // bootstrapped=true
  | { type: "auth/submitStarted" }                          // status="submitting"
  | { type: "auth/loggedIn"; session: AuthSession }         // session=..., status="idle"
  | { type: "auth/submitFailed" };                          // status="idle"
// 退出登录 / 身份失效统一走全局 { type: "app/reset" }
```

### useAuthSession

暴露：`{ session, user, isAuthenticated, isSubmitting, bootstrapped, login, register, logout }`。

编排（hook 负责副作用，reducer 不发请求）：

```ts
async function login(body: LoginRequest) {
  dispatch({ type: "auth/submitStarted" });
  try {
    const tokens = await services.authApi.login(body);
    const session = createAuthSession(tokens);
    tokenStore.save(session);                       // 事实源
    dispatch({ type: "auth/loggedIn", session });   // 渲染镜像
  } catch (error) {
    dispatch({ type: "auth/submitFailed" });
    throw mapAuthError(error, "login");             // 交给 AuthScreen 展示
  }
}
// register 同形（mode="register"）

async function logout() {
  const refreshToken = tokenStore.getRefreshToken();
  if (refreshToken) {
    await services.authApi.logout(refreshToken).catch(() => {}); // best-effort
  }
  abortActiveStreamRef.current();
  tokenStore.clear();
  dispatch({ type: "app/reset" });
}
```

- 登录/注册成功后 `tokenStore` 与 reducer 双写，保持「请求用 token」与「渲染镜像」一致。
- 退出登录即便 `logout` 接口失败也继续本地清理（abort + clear + reset），不让用户卡在已登录态。
- `onAuthExpired`（refresh 失败）由 client 触发 → `AppProvider` 已接到 abort + reset；`useAuthSession` 不重复处理。

## 认证页 AuthScreen（第 5 步）

### 结构与视觉

- 单卡片，登录/注册两种模式，卡内切换（不跳路由）。
- 视觉与布局以 `uiux_v1` 认证入口为基准；本步只做生产化，不重新设计。
- 文案全中文。placeholder、按钮、错误均中文。

### 字段与校验

| 模式 | 字段 | 客户端校验 |
|------|------|-----------|
| 登录 | `identifier`、`password` | 均必填；密码长度 8–128 |
| 注册 | `username`、`email`、`password` | 均必填；用户名 1–50；邮箱格式；密码 8–128 |

- 客户端校验在提交前执行，**字段错误就近展示**（字段下方）。
- 提交时再次以服务端结果为准映射错误。

### 提交态与交互

- 提交中主按钮禁用并显示「登录中…」/「注册中…」（来自 `isSubmitting`）。
- `Enter` 提交表单；提交中防重复提交。
- 切换登录/注册时清空字段错误与表单级错误条。

### 错误展示

- **字段级错误**：必填、邮箱格式、密码长度、注册 409 命中的用户名/邮箱字段，展示在对应字段下方。
- **表单级错误条**（卡内顶部/按钮上方）：登录 401、网络错误、其它非字段错误。
- 本步不引入全局 Toast；设计文档「跨表单错误用 toast」由第 11 步全局 Toast 落地，本步用表单级错误条满足认证场景。

### 认证门与落点

```tsx
function App() {
  const { bootstrapped, isAuthenticated } = useAuthSession();
  if (!bootstrapped) return null;            // 启动恢复未完成（同步 effect，几乎瞬时）
  return isAuthenticated ? <AuthedPlaceholder /> : <AuthScreen />;
}
```

- `AuthedPlaceholder`：临时组件，显示当前用户名 + 「退出登录」按钮（调 `logout`）。明确标注待第 6 步替换为聊天 shell。

## 中文错误映射

新增 `mapAuthError(error: unknown, mode: "login" | "register"): AuthErrorView`，不直接暴露后端英文 `detail`：

```ts
type AuthErrorView = {
  fieldErrors?: Partial<Record<"username" | "email" | "identifier" | "password", string>>;
  formMessage?: string;
};
```

映射规则：

| 情况 | 处理 |
|------|------|
| 登录 401 | `formMessage = "用户名或密码错误"` |
| 注册 409 + `detail` 含 `Username` | `fieldErrors.username = "该用户名已被注册"` |
| 注册 409 + `detail` 含 `Email` | `fieldErrors.email = "该邮箱已被注册"` |
| 422 | `formMessage = "提交内容不符合要求，请检查后重试"`（客户端校验已拦大部分） |
| `ApiError.isAbort` | 忽略（不展示） |
| 其它 `ApiError` | `formMessage = error.message`（已是中文兜底） |
| 非 `ApiError` | 先 `toApiError` 再取中文 message |

## 测试策略

Vitest + Testing Library + MSW；HTTP 经注入了 `fetchImpl` 的 client，不依赖环境变量（沿用通信层测试约定）。

| 测试对象 | 用例 |
|----------|------|
| `rootReducer` | `auth/restored`(有/无 session) 置 bootstrapped；`submitStarted`→submitting；`loggedIn` 置 session+idle；`submitFailed`→idle；`app/reset` 把**全部切片**清回初始值且 auth.bootstrapped=true |
| `useAuthSession` | 登录成功：authApi 调用、tokenStore.save、dispatch loggedIn；登录失败：submitFailed + 抛映射错误；注册 409 → 字段错误；logout：调 authApi.logout + clear + abort + reset；onAuthExpired（模拟 refresh 失败）→ reset + abort |
| `mapAuthError` | 401/409(username)/409(email)/422/abort/网络 各分支 |
| `AppProvider` | 启动从 tokenStore 恢复；构造单例 client 且 onAuthExpired 接 reset+abort（注入 client 断言回调行为） |
| `AuthScreen` | 字段校验（必填/邮箱/密码长度/用户名长度）、提交态禁用与文案、Enter 提交、模式切换清错、字段级与表单级错误展示 |
| `App` 认证门 | 未登录渲染 AuthScreen；已登录渲染 AuthedPlaceholder；bootstrapped 守卫 |

## 验收标准

- `frontend` 下 `pnpm run lint`、`pnpm run typecheck`、`pnpm exec vitest run`、`pnpm run build` 全部通过。
- 未登录时渲染认证页；注册或登录成功后进入「已登录占位」，刷新页面（重读 tokenStore）保持登录态。
- 登录失败显示「用户名或密码错误」；注册重复用户名/邮箱在对应字段下方报中文错误。
- 提交中按钮禁用并显示「登录中…/注册中…」，不可重复提交。
- 退出登录清空私有状态并回到认证页；模拟 refresh 失败（onAuthExpired）同样回到认证页且 abort 占位 stream（本步为 no-op，断言被调用）。
- reducer 全局 RESET 清空全部切片，整棵状态树类型锁定。
- `useConversationLoader`/`useRunStream` 留有签名占位，conversation/run/composer/ui 切片类型就绪、仅处理 RESET。
- 用户可见文案统一中文。

## 已知后续问题（不在本步解决）

- **流式重渲染收敛**：单 State Context 下，第 8 步的 token delta 会让全部 state 消费者重渲染。届时把 active-run draft 收窄到局部 context/ref 处理，本步架构（State/Dispatch 拆分 + 领域 hook 窄 API 面）已为此预留空间。
- **占位切片逻辑**：conversation/run/composer/ui 的 action 转移在第 7–11 步各自 spec 落地。
- **全局 Toast/确认框/底部 sheet**：第 11 步。

## 关联文档

- 重构总设计：[`2026-05-24-frontend-react-rebuild-design.md`](2026-05-24-frontend-react-rebuild-design.md)
- UI/UX 蓝图：[`2026-05-23-frontend-ui-ux-redesign-design.md`](2026-05-23-frontend-ui-ux-redesign-design.md)
- 通信基础层交接：[`../../handover/frontend/2026-05-24-frontend-communication-foundation.md`](../../handover/frontend/2026-05-24-frontend-communication-foundation.md)
- 后端解耦与 CORS 交接：[`../../handover/frontend/2026-05-24-backend-decoupling-and-cors.md`](../../handover/frontend/2026-05-24-backend-decoupling-and-cors.md)
- 模块边界：[`../../architecture/module-boundaries.md`](../../architecture/module-boundaries.md)
