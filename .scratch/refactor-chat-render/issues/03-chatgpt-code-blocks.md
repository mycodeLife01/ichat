# 实现 ChatGPT 风格代码块

Type: feature

Status: ready-for-agent

Blocked by: 02

## What to build

把当前“纯 `<pre>` + 右上角绝对定位复制按钮”替换为 ChatGPT 风格代码 surface：圆角卡片、独立 header、语言 label、复制反馈、语法着色和源码区域横向滚动。实现位于 Markdown 模块内部，调用方不新增 code-specific props。

## Implementation notes

- 新建 Markdown 私有实现 `markdown/CodeBlock.tsx`、`codeLanguage.ts` 和共享 `copyText.ts`；`Markdown.tsx` 只注册 ReactMarkdown renderer。
- 从 fenced code 的 `language-*` class 读取语言，去除 ReactMarkdown 带入的末尾换行，但不能改变源码内部空白。
- 使用 `prism-react-renderer` 输出 React token nodes，以项目 token 定义浅色主题；不使用 `dangerouslySetInnerHTML`。
- 语言 label 归一化至少覆盖 fixture 中的 plaintext、HTML/markup、CSS、JavaScript/JSX、TypeScript/TSX、JSON、Bash/shell、Python、Java、C/C++、C#、Go、Rust、SQL、YAML 和 Markdown。
- 未知/缺失 grammar 时显示原始 label 或“代码”，正文降级 plaintext；不能 throw 或显示错误栈。
- header 内复制按钮必须复制原始源码。Clipboard resolve 后才进入成功态；reject/缺失时保留可重试状态并给出可访问失败反馈。
- 代码长行只能在源码 viewport 横向滚动，不能撑宽正文列；header 不被横向滚走。
- 流式未闭合 fence 允许先显示同一 surface；不能因为语言或 tokenization 暂未稳定而反复卸载整个助手 turn。
- 不实现代码执行、行号、编辑、搜索或假的“运行”按钮。

## Acceptance criteria

- [ ] 有语言和无语言 fenced code 都显示稳定的 ChatGPT 风格卡片，header/正文/圆角/背景/边框与参考一致。
- [ ] 支持语言显示规范 label 与语法色；未知语言安全降级 plaintext。
- [ ] copy 成功、失败、重复点击、unmount timer 清理均有测试；失败时不显示“已复制”。
- [ ] 代码中的 HTML、脚本、citation marker 和 math delimiter 只作为代码文本显示。
- [ ] 200+ 字符单行只滚动代码 viewport，390px 页面不产生水平 overflow。
- [ ] 未闭合 fence 的 prefix render 不抛错，闭合后平滑进入最终高亮。
- [ ] 记录新增 dependency 的 production JS/CSS build delta；没有无意引入完整编辑器或全部语言 bundle。
- [ ] 现有 Markdown、citation、math 和 reasoning 测试保持通过。

## Verification

```bash
cd frontend
pnpm exec vitest run src/messages/Markdown.test.tsx src/messages/Citation.test.tsx
pnpm run test:visual
pnpm run typecheck
pnpm run lint
pnpm run build
```

真实 Chrome 额外检查：语言 header、选择文本、横向滚动、复制成功/失败、流式未闭合 fence 和多代码块长回复。

## Comments

- 2026-08-15：目标是视觉/交互复刻，不复制 ChatGPT 的只读 CodeMirror 实现；静态高亮不需要引入编辑器状态和 DOM。
