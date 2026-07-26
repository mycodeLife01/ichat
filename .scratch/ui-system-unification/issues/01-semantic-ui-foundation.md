# 建立语义设计系统基础与行内状态原语

Type: refactor

Status: completed

Blocked by: None

## What to build

建立本次 UI 统一所需的语义设计基础，使后续组件只需要表达“组件角色”和“状态语义”，不再自行选择具体圆角、颜色、遮罩或阴影。交付内容包括完整的语义圆角层级、中性表面与文字层级、状态色家族、危险动作角色、共享交互样式原语，以及可复用的行内状态提示。

这是后续业务迁移的 prefactor ticket：应先扩充并验证新原语，同时保持现有页面功能和视觉行为可用；业务组件的大规模迁移由后续 ticket 完成。

## Acceptance criteria

- [x] 主题提供 `detail`、`control`、`item`、`popover`、`card`、`dialog`、`composer`、`pill` 八个语义圆角角色，并符合 PRD 中确认的基准值和父子层级规则。
- [x] 中性主题角色覆盖 canvas、sidebar、surface、sunken、hover、selected、边框、主次文字、accent 及其前景色；hover 与 selected 是两个独立角色。
- [x] `neutral`、`success`、`error`、`warning` tone 均拥有可消费的 foreground、soft surface 和 border 角色；danger 与 error 共用红色家族，并另有最终确认使用的 solid action 角色。
- [x] 遮罩、popover/dialog 阴影和 focus ring 所需值集中在主题层，业务组件不需要重新声明颜色或阴影数值。
- [x] 共享交互原语明确覆盖适用的 default、hover、focus-visible、active、disabled、loading、error、success 状态；不适用状态在契约或测试中明确记录。
- [x] 行内状态组件支持四种 tone，同时使用图标与文案表达语义；neutral/success/warning 使用 status，error 使用 alert。
- [x] focus-visible 至少提供 2px 可见焦点环，且 hover 样式只在支持 hover 的指针环境启用。
- [x] 既有语义类名继续只作为测试或运行时钩子，不重新承担视觉样式职责。
- [x] 组件测试验证状态组件的 tone、图标和可访问性角色；生产构建证明新增 success/warning 等语义 utility 实际生成。
- [x] 前端测试、lint、typecheck 和 production build 全部通过。

## Comments

- 2026-07-23：新增语义主题 token、共享交互状态契约和 `InlineStatus`；前端 366 项测试、lint、typecheck、production build 全部通过。
