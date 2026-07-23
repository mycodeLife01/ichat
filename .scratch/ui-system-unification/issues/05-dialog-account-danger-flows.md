# 统一 Dialog、账户卡片与危险确认流程

Type: refactor

Status: ready-for-agent

Blocked by: 01, 02

## What to build

统一 ConfirmDialog、账户管理面板和头像裁剪等独立操作面的 dialog/card 层级，并把账户事实、表单失败、提醒和危险动作映射到共享状态系统。用户应能区分“邮箱已验证”这类持续成功、“邮箱未验证”这类提醒、字段失败和最终不可逆确认。

昵称、头像、重发验证邮件、改密和发起注销等现有账户能力继续使用原有业务编排。

## Acceptance criteria

- [ ] ConfirmDialog、账户面板和头像裁剪使用统一的 dialog/card、遮罩、边框和阴影角色，不再各自声明无名圆角、rgba 遮罩或任意阴影。
- [ ] Dialog 具有正确的 dialog/alertdialog 语义、标题关联、焦点进入与关闭路径；取消无副作用，确认仍执行原有动作。
- [ ] 普通按钮与取消按钮保持中性；危险入口默认只使用红色文字/图标和浅红交互表面；只有最终不可逆确认按钮使用 solid danger。
- [ ] “邮箱已验证”等持续事实使用 success 行内状态；“邮箱未验证”等待处理事实使用 warning；两者均包含图标和文案。
- [ ] 昵称、改密、注销及头像相关字段失败就近显示，输入框使用错误边框、`aria-invalid` 和关联错误文案，而不是只改变颜色。
- [ ] 昵称、头像和验证邮件等短暂成功，以及相应失败路径，使用 ticket 02 定义的正确 Toast tone。
- [ ] disabled 和 loading 控件保留可理解的标签或进度图标，防止重复提交且不改变几何尺寸。
- [ ] 头像裁剪及账户界面不再包含组件级 UI 硬编码颜色、inline danger style 或重复 arbitrary radius。
- [ ] 组件测试通过真实用户流程覆盖账户状态、字段错误、危险确认、取消和 Toast tone，不依赖具体 Tailwind utility。
- [ ] 账户 API、软停用语义、头像处理流程和路由保持不变；前端测试、lint、typecheck 和 production build 全部通过。

## Comments

