# ChatGPT 侧边栏 UI 对齐交接

## 当前状态

本轮桌面侧边栏、侧边栏与正文滚动条、聊天区背景色的对齐已经完成并提交。实现以提交 `b6114ef`（`fix(frontend): align sidebar with ChatGPT UI`）为准，当前分支为 `fix/sidebar-scrollbar`。

范围严格限定为 UI：保留 iChat 现有信息架构，没有加入 ChatGPT 的搜索、资料库、项目、已安排、插件、更多或已置顶等产品区域。移动端抽屉继续使用原有 280px 宽度，桌面折叠栏继续保持 52px。

## 参考资料

- 前端架构与验证约束：`docs/architecture/frontend.md`
- 侧边栏折叠栏和聊天操作既有设计：`docs/handover/frontend/2026-08-14-sidebar-rail-and-chat-actions.md`
- 本轮完整实现与测试变更：提交 `b6114ef`
- 主要实现入口：
  - `frontend/src/conversations/Sidebar.tsx`
  - `frontend/src/conversations/UserMenu.tsx`
  - `frontend/src/app/AppShell.tsx`
  - `frontend/src/styles/global.css`

## 已验证结果

- 真实 Chrome 中桌面侧边栏宽 260px，折叠栏宽 52px。
- 侧边栏滚动容器从页面顶部开始；头部和新建对话入口保持 sticky。
- 侧边栏和聊天区背景均为 `rgb(252, 252, 252)`。
- 侧边栏使用原生滚动条，正文保留原生滚动条与 `stable both-edges`；页面无横向溢出。
- Chrome 控制台无 warning 或 error；浏览器验证结束时已释放所使用的标签页。
- 最新针对测试：50 项通过。
- `pnpm run lint`、`pnpm run typecheck`、`pnpm run build` 均通过；构建仍有既有的大分块提示。
- 本轮较早阶段完整测试为 74 个文件、634 项通过；最终背景色调整后重新运行了针对测试、静态检查和生产构建。

## 工作区注意事项

创建本交接文档前，工作区已有与本轮 UI 提交无关的 `AGENTS.md`、`CLAUDE.md` 和 `.scratch/chatgpt-typography/` 改动。不要还原、覆盖或顺带提交这些内容。

## 后续建议

当前需求没有遗留实现项。若继续做 ChatGPT 像素级对齐，应重新连接用户已打开的 ChatGPT 与本地 iChat 标签页，以实际计算样式和截图为准；不要根据历史截图推测当前 ChatGPT UI。

## Suggested skills

- `frontend-design`：继续进行视觉、间距、字体或布局对齐时使用，保持参考优先并限制改动范围。
- `chrome:control-chrome`：复用用户登录状态，对 ChatGPT 与本地页面做真实浏览器测量、截图和交互验证。
