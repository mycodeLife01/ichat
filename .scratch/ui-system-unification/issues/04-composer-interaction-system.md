# 统一 Composer 及其内部交互状态

Type: refactor

Status: completed

Blocked by: 01

## What to build

将 Composer 作为核心输入表面迁移到独立的 composer 圆角和共享交互原语，并统一内部输入框、联网搜索、思考等级菜单、发送和停止控件的中性状态。用户应能清楚区分可用、选中、生成中、正在停止和不可用状态，而不会把普通选中误读成成功。

发送、停止、IME、自动增高和思考等级等既有行为必须保持不变。

## Acceptance criteria

- [x] Composer 外层使用确认的 composer 角色，内部 pill、icon control、普通控件和 popover item 使用各自较低层级的语义圆角。
- [x] 联网搜索选中态改为中性 selected 角色，不再使用组件内硬编码蓝色或 success/danger 色。
- [x] 思考等级菜单使用共享 popover 与 item 规则，当前选择、hover、focus 和 disabled 状态可明确区分。
- [x] textarea 和相关控件覆盖适用的 default、hover、focus-visible、active、disabled、loading、error、success 状态，并保持固定边框宽度和几何尺寸。
- [x] 发送、停止和正在停止状态同时通过图标、标签或可访问名称表达，disabled 状态具有原生行为、视觉降权和不可用光标。
- [x] 移动端主要触控入口的有效目标不小于 44×44 CSS px，且不依赖 hover 才能发现。
- [x] Composer 及其菜单不包含 UI 用十六进制/rgba、任意阴影或无名圆角值。
- [x] 测试继续覆盖 Enter、Shift+Enter、IME、发送、停止、联网搜索和思考等级，并从用户行为与可访问语义验证状态而非具体 utility。
- [x] 不改变 Run 生命周期、发送/取消 API、输入文案意图或响应式布局结构。
- [x] 前端测试、lint、typecheck 和 production build 全部通过。

## Comments

- 2026-07-23：Composer 迁移到 `composerSurface`、`popoverSurface`、`neutralMenuItem`、`iconControl` 等共享原语；联网搜索选中态收敛为中性 selected（固定 1px 边框，几何不漂移）；思考等级菜单统一 popover/item 规则；发送/停止统一为 pill 主操作，停止中以 aria-busy 表达；触控入口采用 36px 视觉目标加 4px bleed，有效目标达 44×44 CSS px；新增 IME 组合、aria-busy、aria-pressed、aria-expanded 断言。经双轴代码审查后补齐 pill 的 active 按压反馈并移除超出确认稿的 trigger 打开态填充。前端 380 项测试、lint、typecheck、production build 全部通过。
