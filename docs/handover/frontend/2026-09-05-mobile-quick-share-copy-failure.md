# 2026-09-05 移动端快捷分享复制失败

## 收尾范围

用户确认只要求生产 HTTPS 场景，局域网 HTTP 不再作为本次修复的验收目标。
保留 WebKit 延迟剪贴板写入补丁，不增加二次点击复制、不打开分享对话框、不预建公开分享。
本轮尝试的本地 HTTPS 配置、临时服务与证书已撤回；没有修改系统证书信任库。

**当前代码尚未部署，未取得真实 iPhone 在生产 HTTPS 上成功粘贴的证据，因此不声称线上已修复。**

## 已确认的失败环境

- 用户提供的页面：
  `http://192.168.1.10:5173/c/df4d3508-45e7-4444-9925-c9aff88c5f47`。
- 手机系统：iOS 18；浏览器：Chrome，具体版本未提供。
- 现象：显示「复制失败」，不是显示成功后粘贴出旧内容。
- 尚未采集真机的 iframe 状态、运行时能力快照和剪贴板异常名称。

该 origin 是非安全的局域网 HTTP，无法使用 Async Clipboard API。分享链接 token
又只能在异步请求后取得，随后执行 `execCommand("copy")` 无法可靠保留移动浏览器的
原始用户手势。此前桌面 Chrome 窄视口下选区复制成功，不能代表真实 iPhone。

生产 HTTPS 不存在这条 HTTP 能力限制，但仍需解决 WebKit 的用户手势时序要求。

## 补丁

`frontend/src/conversations/useQuickShare.ts`：

1. 查询生效链接，有则复用，否则创建永久链接；仍遵守每会话最多一个生效链接。
2. 在点击处理器首次 `await` 之前调用 `startDeferredTextCopy(urlPromise)`。
3. 链接返回后兑现 `ClipboardItem` 内的文本 Blob；只有剪贴板写入成功才显示成功 toast。
4. 写入失败或 API 不可用时尝试普通文本复制与选区复制；失败仍明确提示，不打开 `ShareDialog`。
5. 分享查询/创建失败时提示「创建分享失败」，不会复制空字符串或伪造链接。

`frontend/src/ui/clipboard.ts`：

- 用 `ClipboardItem({"text/plain": Promise<Blob>})` 同步启动
  `navigator.clipboard.write()`，避免在 WebKit 中等网络响应后才请求写入。
- 普通复制优先 `writeText()`，其次临时 textarea 选区复制；后者只是尽力尝试，不是
  HTTP 移动端的一次点击保证。临时节点清理后恢复原焦点与 DOM 选区。
- 延迟数据拒绝时也挂接拒绝处理，避免剪贴板构造或写入抛错后留下未处理的 Promise rejection。

侧栏 `ShareDialog` 和「我的分享」入口未修改。

## 验证

在 `frontend/` 下执行：

```bash
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
pnpm run build
```

回归用例覆盖：安全上下文延迟写入时序、已有链接复用、首次创建永久链接、查询/创建失败、
API 缺失、`writeText` 拒绝、所有复制路径失败及不打开对话框。

本轮全量 Vitest 为 **81 个文件、708 个测试通过**；lint、typecheck、build 通过。
生产构建仍有既有的 chunk 大于 500 kB 提示。

桌面 Chrome 在 `http://localhost:5173`（浏览器视为安全上下文）用真实 `useQuickShare`
配合每阶段延迟 650ms 的 fake share API 检查：复用分支仅查询，首次分享分支查询后创建，
两条路径均完成浏览器写入调用并显示成功。浏览器拒绝自动读取剪贴板，因此该检查未证明
系统剪贴板内容，更不能视为 iOS 生产验收。临时 fixture 和浏览器会话已清理。

桌面浏览器检查只能补充证明桌面安全上下文中的行为；本地 HTTP 移动视口、mock 的复制
返回值和成功 toast 均不能代替 iPhone 真机粘贴验收。

## 上线后复测

在 iOS 18 Chrome 打开生产 HTTPS 页面，分别测试已有生效链接和首次创建链接。
每次分享后在备忘录或另一输入框粘贴，确认值严格等于当前 origin 下的 `/share/{token}`。
已有链接应复用 token，首次创建不得出现重复创建或 409。

如果 HTTPS 仍失败，再采集 browser version、iframe/Permissions Policy、页面焦点、
`isSecureContext`、Clipboard API 能力与实际异常名称；不要再用局域网 HTTP 结果推断
生产行为。分享 token 不写入诊断日志。

## 平台依据

- [WebKit Async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/)：
  安全上下文与点击/触摸手势约束，ClipboardItem 支持延迟兑现的 Promise。
- [MDN Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)：
  浏览器能力与权限限制。
- [MDN execCommand](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)：
  已弃用的复制机制不能作为通用异步移动端兜底。
