# 让全局 Toast 端到端保留通知语义

Type: refactor

Status: completed

Blocked by: 01

## What to build

把全局 Toast 从只有 message 的瞬时提示升级为端到端保留 tone 的通知系统。每个触发方必须明确声明这是普通、成功、失败还是提醒；状态层、跨组件回调和最终渲染均不得丢失该语义。

短暂成功应保持克制，以中性深色表面和 Check 图标确认动作；失败应使用错误图标、错误前景和浅红表面，并及时向辅助技术宣告。需要持续存在的字段错误、账户状态和 Run 失败继续由行内状态承载，不得被自动消失 Toast 替代。

## Acceptance criteria

- [x] Toast 状态包含单调递增 id、message 和必填 tone；所有 show action 与跨组件通知回调都要求调用方显式传入 tone，不提供掩盖遗漏的默认值。
- [x] 相同 message 和 tone 连续触发仍生成新 id、重新播放动画并重置自动消失计时；hide、卸载 cleanup 和 app reset 行为保持不变。
- [x] neutral、success、warning Toast 使用 `role="status"`，error Toast 使用 `role="alert"`。
- [x] 每种 Toast 同时显示与 tone 匹配的图标和文案，不以颜色作为唯一信息通道。
- [x] 短暂 success Toast 使用中性深色表面和 Check 图标；error Toast 使用错误 foreground、soft surface 和错误图标；warning 与普通选中态视觉语义明确分离。
- [x] 发送、重新生成、停止、会话恢复、邮箱验证、昵称、头像、分享创建/复制/撤销等现有成功与失败路径均完成 tone 分类。
- [x] Run failed 继续只在消息上下文显示持续状态，不因本次迁移增加相同含义的 Toast。
- [x] reducer、Toast 组件和高层用户流程测试验证 tone 不丢失、role 正确、图标存在及重复触发行为，不断言具体 Tailwind utility 拼接。
- [x] 原有路由、API 调用、文案意图和自动消失节奏保持不变。
- [x] 前端测试、lint、typecheck 和 production build 全部通过。

## Comments

- 2026-07-23：Toast state/action/跨组件回调已强制携带 tone，四种 tone 的图标、表面与 live-region 语义已落地；发送、Run 操作、会话恢复、邮箱、昵称、头像和分享通知均完成分类。前端 373 项测试、lint、typecheck、production build 全部通过。
