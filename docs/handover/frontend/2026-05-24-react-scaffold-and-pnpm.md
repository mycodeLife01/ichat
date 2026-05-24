# 2026-05-24 React 脚手架与 pnpm 切换交接文档

## 本次完成

基于 `docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md` 的实施顺序，完成第 1 步：在 `frontend/` 下建立 Vite React TypeScript 工程与测试脚手架，并将前端包管理器切换为 pnpm。

本次改动只建立工程基础，不迁移真实 API、auth、SSE、业务状态或 UI 组件。后续功能迁移仍需按设计文档继续执行。

## 主要改动

- 移除旧 vanilla 前端入口与模块：`frontend/app.js`、`api.js`、`auth.js`、`sse.js`、`state.js`、`ui.js`、`styles.css`、`views/*`。
- 新增 Vite SPA 入口：`frontend/index.html`、`frontend/src/main.tsx`。
- 新增最小 React 根组件与 smoke 测试：`frontend/src/app/App.tsx`、`frontend/src/app/App.test.tsx`。
- 新增全局样式基础：`frontend/src/styles/global.css`。
- 新增测试 setup：`frontend/src/test/setup.ts`。
- 新增 TypeScript、Vite/Vitest、ESLint 配置：`tsconfig*.json`、`vite.config.ts`、`eslint.config.js`。
- 新增前端模块目录占位：`api/`、`auth/`、`conversations/`、`runs/`、`messages/`、`ui/`。
- 新增 `frontend/package.json` 与 `frontend/pnpm-lock.yaml`。
- 更新 `.gitignore`，忽略 `frontend/node_modules/`、`frontend/dist/`、`frontend/coverage/`。
- 更新 React 重构设计文档，把 Cloudflare Pages、CI、本地开发和验收命令从 npm 改为 pnpm。

## 关键文件

- `frontend/package.json`：pnpm package manager 声明、前端 scripts、React/Vite/Vitest 依赖版本。
- `frontend/pnpm-lock.yaml`：前端唯一锁文件。
- `frontend/vite.config.ts`：Vite + React plugin + Vitest jsdom 配置。
- `frontend/eslint.config.js`：ESLint flat config。
- `frontend/tsconfig.json`、`frontend/tsconfig.app.json`、`frontend/tsconfig.node.json`：TypeScript build mode 配置。
- `frontend/src/main.tsx`：React 应用入口。
- `frontend/src/app/App.tsx`：当前最小脚手架根组件。
- `frontend/src/app/App.test.tsx`：Testing Library smoke test。
- `frontend/src/test/setup.ts`：jest-dom 测试扩展入口。
- `frontend/src/styles/global.css`：临时全局基础样式。
- `docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md`：已同步 pnpm 命令与锁文件说明。
- `docs/superpowers/plans/2026-05-24-frontend-react-step-1-scaffold.md`：本阶段执行计划。

## 包管理决策

前端包管理器统一为 pnpm：

```json
"packageManager": "pnpm@10.12.1"
```

仓库前端锁文件使用 `frontend/pnpm-lock.yaml`。`frontend/package-lock.json` 已移除，后续不要再提交 npm lockfile。

常用命令：

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm run dev
pnpm run test -- --run
pnpm run typecheck
pnpm run lint
pnpm run build
```

从仓库根目录启动前端开发服务器：

```bash
pnpm --dir frontend dev
```

## 依赖版本注意点

当前 Vite 固定为 `5.4.21`，Vitest 固定为 `2.1.8`。

原因：`vitest@2.1.8` 依赖 Vite 5 类型。如果根项目使用 Vite 6，同时在 `vite.config.ts` 中配置 `test` 字段，TypeScript 会遇到两份 Vite 类型不一致的问题。将根 `vite` 对齐到 `5.4.21` 后，`vitest/config` 的 `defineConfig` 可正常通过类型检查。

当前核心版本：

```text
react 19.0.0
react-dom 19.0.0
vite 5.4.21
vitest 2.1.8
pnpm 10.12.1
```

## 验证结果

本次已用 pnpm 完成以下验证：

```bash
pnpm install --frozen-lockfile
pnpm run test -- --run
pnpm run typecheck
pnpm run lint
pnpm run build
```

结果：

- `pnpm install --frozen-lockfile`：lockfile up to date。
- `pnpm run test -- --run`：`src/app/App.test.tsx` 1 个测试通过。
- `pnpm run typecheck`：通过。
- `pnpm run lint`：通过。
- `pnpm run build`：Vite 生产构建通过，产物输出到 `frontend/dist/`。

pnpm 安装时提示 `Ignored build scripts: esbuild, msw`。当前 `pnpm run build` 已通过，说明这不是本阶段阻塞项。若后续在新环境遇到 esbuild 二进制缺失，再评估是否运行 `pnpm approve-builds`。

## 当前边界

已完成：

- 工程可以独立安装、测试、类型检查、lint 和生产构建。
- React/Vitest/Testing Library 基础链路可用。
- pnpm 已成为设计文档和前端工程的统一包管理器。

未完成，留给后续任务：

- typed API client、auth session、refresh/retry、SSE parser/stream client。
- 后端移除静态挂载与新增 CORS。
- React reducer、hooks、真实认证页和聊天 UI。
- 会话、run、SSE replay、停止生成、标题 pending、编辑/重新生成等业务迁移。
- CI workflow 实际改造。

## 注意事项

- `uiux_v1.html` 当前仍是仓库根目录未跟踪文件，本次没有修改。
- 当前 React 页面只是脚手架占位，不代表最终 UI。
- 后续前端 CI 应使用设计文档中的 pnpm 命令，不要恢复 npm。
