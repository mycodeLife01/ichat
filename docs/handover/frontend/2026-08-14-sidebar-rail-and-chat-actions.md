# 2026-08-14 侧栏 mini rail / 聊天页无 header 浮动操作 交接文档

## 继续完善：ChatGPT 式收起动效与 rail 图标

- 桌面侧栏改为「固定宽度 280px 内容画布 + 可变宽度裁切外壳」。收起时只有 `<aside>` 的右边界从
  280px 推进到 52px，完整面板、会话行和底部账号触发器不改变自身坐标；rail 控件层在同一外壳内
  以 150ms 阶跃透明度切换。宽度过渡为 220ms，并为 `prefers-reduced-motion` 禁用空间动画。
- 完整面板在收起后继续挂载，但用 `inert` 与 `aria-hidden` 退出交互和可访问性树。rail 最近会话浮层
  仍是唯一会生成行操作 portal 的交互源，避免隐藏面板与浮层为同一会话重复创建菜单。
- 桌面展开态和 rail 共用同一个账号触发器。触发器固定为 52px 高、头像固定在左侧 8px；真实 Chrome
  测得展开与收起前后头像均为 `x=8, y=833, 32×32`，DOM 节点也保持不变。
- `Icons.Chats` 从 Lucide `MessageCircle` 换为 ChatGPT 20px 单气泡路径，保持 `currentColor` 与现有
  hover/focus 状态。
- 新增组件回归用例，验证完整面板保持挂载但不可交互、账号触发器跨状态保持同一节点，以及新的
  最近会话 SVG 存在。前端现为 67 个测试文件、530 个测试全绿。

## 本次完成

把登录后工作台的导航与会话操作从「顶栏 + 可收起侧栏」改为「mini rail + 正文浮动操作」，目标是给正文信息流让出整块高度，并把分享做成零弹窗的一步操作：

1. **侧栏收起态改为 mini rail（仅桌面）**：外壳从 280px 收缩到 52px，内部完整面板保持 280px
   固定布局并由外壳从右侧裁切；rail 自上而下为 展开侧栏 / 新建对话 / 最近聊天，底部为固定锚点
   的账号头像。本次不做搜索入口。
2. **最近聊天浮层**：列最近 10 条会话，行内操作仍是 分享 / 重命名 / 删除（与展开态 item 完全一致，代码同一份）。
3. **删除聊天页 header**：`conversations/Topbar.tsx` 及其测试整体移除，标题不再在聊天页展示（仍可从侧栏读取）。
4. **正文右上浮动操作**：桌面端 分享 + three-dot（仅「删除」）；移动端左上 打开历史、右上 新建对话 + three-dot（分享 / 删除）。
5. **快捷分享**：点击分享不再打开 `ShareDialog`。已有生效链接则复用，否则新建**永久**链接，随后写入剪贴板并提示「公开链接已复制到剪贴板」。侧栏 item 的分享仍走原对话框（保留过期时间选择与撤销）。

前端测试从 520 增至 530 全绿（67 个测试文件，新增 `ThreadActions.test.tsx`）。

## 主要改动

### 新增

- `conversations/ThreadActions.tsx`：聊天页浮动操作层。外层 `absolute inset-x-0 top-0` + `pointer-events-none`，每个按钮单独 `pointer-events-auto`，因此浮层不吃正文滚动；按钮用 `bg-bg/85 + backdrop-blur-[2px]` 保证压在正文上仍可读。`hasConversation=false`（空白新对话）时隐藏分享与 three-dot，只保留移动端导航按钮。three-dot 菜单在外部 pointerdown 与 Escape 时关闭，`hasConversation` 变 false 时强制关闭。
- `conversations/useQuickShare.ts`：`shareApi.list` → 有生效链接取其 token，否则 `create(id, null, hasAttachments ? true : undefined)`；再写剪贴板。失败分三类文案：`创建分享失败` / `复制失败` / 成功 `公开链接已复制到剪贴板`。`navigator.clipboard` 缺失按失败处理，避免「提示已复制但没复制」。
- `conversations/ThreadActions.test.tsx`：桌面/移动两套控件、空白新对话、Escape 关闭。

### 删除

- `conversations/Topbar.tsx`、`conversations/Topbar.test.tsx`。原「展开侧栏」按钮迁到 rail 顶部，「打开历史 / 新建对话」迁到移动端浮动层，标题不再有承载位置。

### 侧栏

- `conversations/Sidebar.tsx`：
  - 收起态类名从 `collapsed w-0` 改为 `collapsed w-[var(--sidebar-rail-width)]`，`border-r` 提到共用分支；
    同一个 `<aside>` 只过渡 `width`，采用 220ms `cubic-bezier(0.4, 0, 0.2, 1)`，并通过
    `motion-reduce:transition-none` 尊重减少动态效果偏好。
  - 桌面完整面板始终保持 `w-[var(--sidebar-width)]` 且左侧坐标不变。`railCollapsed` 时由外层
    `overflow-hidden` 从右侧裁切，同时给完整面板内容设置 `inert` 与 `aria-hidden`；rail 作为绝对定位层
    以 150ms 阶跃透明度切入。移动端仍使用原抽屉实现，不受影响。
  - `recent` 状态 + `recentTriggerRef` 驱动最近聊天浮层，`createPortal` 到 `document.body`（rail 有 `overflow-hidden`，就地渲染会被裁剪），位置在 open 时从触发器 rect 计算并做视口夹取，与既有行菜单同一套做法。浮层容器 `onClick` 阻断冒泡，因此点重命名/更多不会被「文档点击关闭」误关；选中会话则显式关闭。
  - `renderRow(c, { onSelected, renderDesktopMenu })` 增加容器选项：rail 浮层中选中后关闭浮层；
    被裁切的完整面板继续保留行 DOM，但不再为同一 `menu` 状态重复创建 desktop portal。
  - `renderUserMenu(compact, railPinned)` 抽出，桌面展开态与 rail 共用同一个 `UserMenu` 实例和触发器。
- `conversations/UserMenu.tsx`：新增 `railPinned`。桌面账号触发器固定为 280×52px，头像固定在左侧 8px；
  收起时仅由侧栏外壳裁掉右侧文字，触发器及头像不重新布局。compact 模式下弹出菜单仍使用固定 260px
  宽度。菜单内容、账号 / 我的分享 / 退出流程完全未变。

### 装配与样式

- `app/AppShell.tsx`：移除 `Topbar`；`VerifyEmailBanner` 之后新增一层 `relative flex min-h-0 flex-[1_1_0%] flex-col` 包裹 `ThreadActions` + `.thread-region`（浮动层需要定位父级，且必须在 banner 之下，否则会压住 banner）。`.thread-region` 由 `flex-[1_1_0%]` 改为 `flex-1` 并加 `max-[760px]:pt-8`，避免移动端首条消息被浮动按钮遮住。分享/删除回调都以 `selectedId` 为准，`null` 时直接返回。
- `styles/global.css`：新增布局变量 `--sidebar-rail-width: 52px`。
- `ui/icons.tsx`：`Chats` 改为 ChatGPT 风格 20×20 单气泡自绘 SVG，使用 `currentColor` 继承现有状态；
  新建对话沿用既有 `NewChat` 自绘 SVG。

## 验证

在 `frontend/` 下执行，全部通过：

```bash
pnpm run lint
pnpm run typecheck
pnpm exec vitest run     # 67 files / 530 tests
pnpm run build
```

同时执行 Impeccable UI 机械检测，结果为 `[]`（无发现）。生产构建只有项目既有的单包体积大于
500kB 提示，不影响构建成功。

真实 Chrome（1920×945）验证结果：

- `<aside>` 宽度由 280px 过渡到 52px，完整面板内部坐标不变；
- 账号触发器在两种状态均为 `x=0, y=823, 280×52`，头像均为 `x=8, y=833, 32×32`；
- 最近聊天 SVG 路径正确，浮层定位为 `x=52, y=82, 260×404`；
- 展开、收起、最近聊天浮层交互后浏览器控制台无错误。

新增/更新的用例：

- `conversations/Sidebar.test.tsx`：收起态 rail 三个入口 + 头像存在；完整历史列表保持挂载但进入
  `inert` / `aria-hidden`；账号触发器跨展开/收起保持同一 DOM 节点；最近聊天浮层只列 10 条、
  行操作仍为 分享 / 重命名 / 删除、选中后关闭；最近聊天自绘 SVG 存在。
- `conversations/ThreadActions.test.tsx`：见上。
- `app/AppShell.test.tsx`：分享无生效链接时以 `(id, null, undefined)` 新建并复制、有生效链接时不再调用 `create`、three-dot 删除经确认框调用 `remove`。

## 已知缺口

- rail ↔ 展开已在 1920×945 的真实 Chrome 中完成宽度、头像锚点、最近会话浮层与控制台错误 smoke；
  窄桌面宽度下浮动按钮与正文右边缘的重叠、移动端 `env(safe-area-inset)` 与 44px 触达仍待补做。
- `bg-bg/85` 已确认出现在构建产物 CSS 中（Tailwind v4 的透明度修饰符对 `@theme` 变量色有效），但压在图片/代码块上的实际观感未经真机确认。
- 聊天页不再展示会话标题，如后续需要标题（例如长会话辨识），需要另设承载位置，而不是把 header 加回来。
