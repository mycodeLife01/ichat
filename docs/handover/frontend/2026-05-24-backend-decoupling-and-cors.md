# 2026-05-24 后端前端解耦与 CORS 交接文档

## 本次完成

按 `docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md` 的实施顺序，完成第 3 步：让 FastAPI 不再服务 `frontend/` 静态资源，并新增可配置 CORS，使独立部署的 React 应用（Cloudflare Pages / 本地 `:5173`）能够跨域调用 API。

本步骤属于前端 React 重构计划中的**后端改动**，因此交接文档随前端重构系列归档在 `docs/handover/frontend/`，但实际代码改动全部在 `app/` 与 `tests/`。本次不涉及 React reducer、hooks、UI，也不改 Nginx、compose、部署文档或 CI（这些属于设计文档第 12 步，本次未触碰）。

实施采用 TDD：每个改动先写失败测试（RED），再实现最小通过代码（GREEN），随后提交，共 2 个功能提交 + 1 个计划文档提交。

执行计划见 `docs/superpowers/plans/2026-05-24-backend-frontend-decoupling-cors.md`。

## 主要改动

- 新增 CORS 配置项：`app/core/config.py` 增加 `cors_allowed_origins: str = ""` 字段与 `cors_allowed_origins_list` 属性（按逗号拆分、去空白、过滤空项）。
- 新增环境变量样例：`.env.example` 增加 `CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`。
- 移除前端静态挂载：删除 `app/main.py` 末尾的 `app.mount("/", StaticFiles(...))` 块，以及随之失效的 `from pathlib import Path`、`from fastapi.staticfiles import StaticFiles` 导入。
- 新增 CORS 中间件：`app/main.py` 在 `create_app` 内以 `app.add_middleware(CORSMiddleware, ...)` 注册，置于最后（最外层）。
- 新增/扩展测试：
  - `tests/core/test_config.py`：CORS 逗号列表解析、默认空列表、`.env.example` 形状断言扩展。
  - `tests/api/test_app.py`：根路径不再返回前端 HTML、允许 origin 命中、预检放行方法、未知 origin 不带 CORS 头。

## 关键文件

- `app/core/config.py`：`cors_allowed_origins` 字段与 `cors_allowed_origins_list` 属性，作为 CORS 允许来源的唯一来源。
- `app/main.py`：`create_app` 现在只暴露 API（`/healthz`、`/readyz`、`/api/v1/*`），并在最外层挂 `CORSMiddleware`；模块级 `app = create_app()` 不再附加任何静态挂载。
- `.env.example`：`CORS_ALLOWED_ORIGINS` 本地开发默认值。
- `tests/api/test_app.py`：根路径与 CORS 行为断言。
- `tests/core/test_config.py`：CORS 配置解析与 `.env.example` 形状校验。

## 设计决策

### CORS 来源用字符串 + 属性，而非 `list[str]`

- `cors_allowed_origins` 声明为 `str`，再用 `cors_allowed_origins_list` 属性拆分。
- 原因：pydantic-settings v2 对 `list[str]` 类型的环境变量默认按 JSON 解析，普通逗号分隔串（`a,b`）会解析失败。用字符串字段 + 属性拆分可彻底规避该坑，也与现有配置全是标量的风格一致。
- 默认值为 `""`（空 = 不放行任何来源，安全默认）。这样 `conftest.py` 和现有直接构造 `Settings(...)` 的测试都无需改动；CORS 来源完全由环境变量/`.env` 注入。

### CORS 中间件作为最外层

- 在 `create_app` 内**最后**调用 `add_middleware`，Starlette 会把最后注册的中间件放在最外层，确保预检 `OPTIONS` 在进入路由前就被 CORS 处理。
- `allow_methods=["GET","POST","PATCH","DELETE","OPTIONS"]`，`allow_headers=["Authorization","Content-Type","Accept"]`，与设计文档「后端部署改动」一致。
- 未开启 `allow_credentials`：认证走 `Authorization: Bearer` header（localStorage token），不依赖 cookie，故不需要 credentials。

### 移除静态挂载

- 后端转为纯 API 服务，根路径不再返回 `index.html`。生产前端由 Cloudflare Pages 托管，本地由 Vite dev server 提供。
- `/healthz`、`/readyz`、`/api/v1/*` 行为不变，现有相关测试继续通过。

## 验证结果

```bash
uv run pytest tests/api/test_app.py tests/core/test_config.py -q   # 21 passed
uv run ruff check app tests                                        # All checks passed
uv run mypy app                                                    # Success: no issues found in 48 source files
```

测试覆盖：CORS 逗号列表解析与默认空列表、`.env.example` 形状、根路径不再服务前端 HTML、CORS 允许/预检/拒绝行为。`ruff` 同时确认 `app/main.py` 中移除后无遗留未用导入。

未运行完整 DB 依赖测试套件：本机 Docker / PostgreSQL 未启动。本次改动路径（config 解析、app 构造）不触达数据库——`tests/api/test_app.py` 用 `TestClient` 且不进入 lifespan，因此无需数据库即可验证。如需全量验证，启动 `docker compose up -d postgres` 后运行 `uv run pytest --tb=short -q`。

## 当前边界

已完成：

- 后端为纯 API 服务，根路径不再返回前端 HTML。
- 可配置 CORS 就绪，允许设计文档约定的方法与请求头，并经测试覆盖。

未完成，留给后续任务：

- Nginx `api.feslia.com` 子域配置、`compose.prod.yml`、`docs/deployment.md`、CI workflow 改造（设计文档第 12 步）。
- React reducer、核心 hooks（`useAuthSession`、`useConversationLoader`、`useRunStream` 等）。
- 真实认证页、聊天 UI、会话/run/SSE replay/停止生成/标题 pending/编辑重新生成等业务迁移（设计文档第 4–13 步）。

## 注意事项

- 实现过程中修正了一处测试缺陷：根路径测试最初用新建的 `create_app()` 实例，会假性通过——因为静态挂载只加在模块级 `app` 单例上，而非每次 `create_app()` 返回的实例。已改为导入并测试模块级 `app` 单例，才真正构成 RED→GREEN。后续涉及「模块级 app vs `create_app()`」差异的断言需注意这一点。
- 默认 `CORS_ALLOWED_ORIGINS=""` 时不会下发任何 CORS 头。**生产环境必须显式注入** `CORS_ALLOWED_ORIGINS`（含 `https://feslia.com`）；本地开发需含 `http://localhost:5173`、`http://127.0.0.1:5173`。
- SSE endpoint 仍走 `fetch` + `Authorization` header，未改用原生 `EventSource`，跨域由本次 CORS 预检覆盖；SSE 相关代码本次未改动。
- `uiux_v1.html` 仍是仓库根目录未跟踪文件，本次未修改。
