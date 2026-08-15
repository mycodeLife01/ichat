# 一级标题 Heading 1

## 二级标题 Heading 2

### 三级标题 Heading 3

#### 四级标题 Heading 4

##### 五级标题 Heading 5

###### 六级标题 Heading 6

这是一段用于视觉回归的正文，包含 **粗体**、*斜体*、***粗斜体***、~~删除线~~、`inline_code()`、数字 123456、中英文 mixed text 与 emoji 🤖✨。正文引用固定的脱敏来源[1]。

第二段用于检查段落节奏、长行换行与 readable width。The quick brown fox jumps over the lazy dog while 中文字符继续自然换行。

---

## 链接与长内容

- 普通外链：[OpenAI](https://openai.com/)
- 相对链接：[站内帮助](/help/visual-fixture)
- 长链接：<https://example.com/api/v1/generated/content/very/very/very/very/very/very/long/path?token=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789>
- 超长单词：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

> 这是一段引用，内部包含 **粗体**、*斜体* 与 `quoted_code`。
>
> > 第二层引用用于检查嵌套缩进。

## 列表与任务

- Frontend
  - React
  - TypeScript
- Backend
  - FastAPI
    - PostgreSQL

1. 第一项
2. 第二项
   1. 嵌套有序项
   2. 另一个嵌套项

- [x] 已完成 fixture
- [ ] 待完成视觉对齐
- [ ] 保持 reasoning 逻辑不变

## 无语言代码

```
plain text keeps spacing
and does not execute anything
```

## Python

```python
from dataclasses import dataclass

@dataclass
class Result:
    ok: bool
    message: str

print(Result(ok=True, message="你好，iChat"))
```

## TypeScript

```typescript
type Message = {
  role: "assistant";
  content: string;
};

const render = (message: Message): string => message.content;
```

## Bash

```bash
pnpm run lint
pnpm run typecheck
pnpm exec vitest run
```

## JSON

```json
{
  "status": "ready",
  "surfaces": ["markdown", "math", "citation", "table"]
}
```

## HTML

```html
<!doctype html>
<html lang="zh-CN">
  <body>
    <main style="font-family: system-ui; padding: 24px">
      <h1>HTML preview</h1>
      <p>静态内容在隔离的 iframe 中渲染。</p>
    </main>
  </body>
</html>
```

## 未知语言与长代码行

```not-a-language
unknown_language_falls_back_without_breaking_the_message = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789"
```

## 宽表格

| Surface | Desktop target | Mobile target | Overflow owner | Copy | Notes |
| --- | ---: | ---: | --- | --- | --- |
| Paragraph | 16px / 26px | measured, not guessed | page | no | 中文与 English 混排 |
| Code block | language aware | own scroller | code surface | yes | very_long_unbroken_identifier_abcdefghijklmnopqrstuvwxyz0123456789 |
| Table | intrinsic columns | own scroller | table surface | yes | 宽列不能撑破页面 |

### 独立表格复制状态

| Scenario | Fixture value |
| --- | --- |
| Clipboard rejection | copy-failure-fixture |

## 数学与引用

行内公式：\(E = mc^2\)，块级公式：

\[
\int_0^1 x^2\,dx = \frac{1}{3}
\]

代码、数学与 citation 必须彼此隔离：`[1]`、\(x_1\) 与正文来源[1]。
