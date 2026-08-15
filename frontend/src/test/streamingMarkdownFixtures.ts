export type StreamingMarkdownFixture = {
  id: string;
  label: string;
  prefixes: readonly string[];
  completedSelector?: string;
  completedText: string;
};

export const completedPrefixText = "已完成正文。";

function cumulativePrefixes(...fragments: string[]) {
  return [
    "",
    completedPrefixText,
    ...fragments.map((fragment) => `${completedPrefixText}\n\n${fragment}`),
  ];
}

export const streamingMarkdownFixtures: readonly StreamingMarkdownFixture[] = [
  {
    id: "emphasis",
    label: "斜体 emphasis",
    prefixes: cumulativePrefixes("*", "*斜体", "*斜体*"),
    completedSelector: "em",
    completedText: "斜体",
  },
  {
    id: "strong",
    label: "粗体 emphasis",
    prefixes: cumulativePrefixes("**", "**粗体", "**粗体**"),
    completedSelector: "strong",
    completedText: "粗体",
  },
  {
    id: "strikethrough",
    label: "删除线",
    prefixes: cumulativePrefixes("~~", "~~删除", "~~删除~~"),
    completedSelector: "del",
    completedText: "删除",
  },
  {
    id: "link",
    label: "链接",
    prefixes: cumulativePrefixes(
      "[",
      "[链接",
      "[链接](",
      "[链接](https://example.com/stream",
      "[链接](https://example.com/stream)",
    ),
    completedSelector: 'a[href="https://example.com/stream"]',
    completedText: "链接",
  },
  {
    id: "fence",
    label: "代码 fence",
    prefixes: cumulativePrefixes(
      "```",
      "```bash",
      "```bash\n",
      "```bash\necho $$",
      "```bash\necho $$\nstill code",
      "```bash\necho $$\nstill code\n```",
    ),
    completedSelector: "[data-code-viewport]",
    completedText: "echo $$ still code",
  },
  {
    id: "unordered-list",
    label: "无序嵌套列表",
    prefixes: cumulativePrefixes(
      "-",
      "- 第一项",
      "- 第一项\n  -",
      "- 第一项\n  - 嵌套项",
    ),
    completedSelector: "ul ul",
    completedText: "嵌套项",
  },
  {
    id: "ordered-list",
    label: "有序嵌套列表",
    prefixes: cumulativePrefixes(
      "1.",
      "1. 第一项",
      "1. 第一项\n   1.",
      "1. 第一项\n   1. 嵌套项",
    ),
    completedSelector: "ol ol",
    completedText: "嵌套项",
  },
  {
    id: "table",
    label: "表格",
    prefixes: cumulativePrefixes(
      "| Surface | State |",
      "| Surface | State |\n|",
      "| Surface | State |\n| --- | --- |",
      "| Surface | State |\n| --- | --- |\n| Markdown |",
      "| Surface | State |\n| --- | --- |\n| Markdown | streaming |",
    ),
    completedSelector: "[data-table-block]",
    completedText: "Markdown",
  },
  {
    id: "inline-math",
    label: "反斜杠行内数学",
    prefixes: cumulativePrefixes("\\(", "\\(E = mc^2", "\\(E = mc^2\\)"),
    completedSelector: ".katex:not(.katex-display .katex)",
    completedText: "E=mc2",
  },
  {
    id: "bracket-display-math",
    label: "反斜杠块级数学",
    prefixes: cumulativePrefixes("\\[", "\\[x^2 + y^2", "\\[x^2 + y^2\\]"),
    completedSelector: ".katex-display",
    completedText: "x2+y2",
  },
  {
    id: "dollar-display-math",
    label: "双美元块级数学",
    prefixes: cumulativePrefixes("$$", "$$\nx^2 + y^2", "$$\nx^2 + y^2\n$$"),
    completedSelector: ".katex-display",
    completedText: "x2+y2",
  },
  {
    id: "citation",
    label: "引用标记与普通方括号",
    prefixes: cumulativePrefixes("[", "[1", "[1]", "[1] 与 [普通文本]"),
    completedText: "[1] 与 [普通文本]",
  },
  {
    id: "blockquote-prose",
    label: "引用与中英文长段落",
    prefixes: cumulativePrefixes(
      ">",
      "> 引用正文",
      "> 引用正文\n\n中文段落",
      "> 引用正文\n\n中文段落与 English prose 保持可见。",
    ),
    completedSelector: ".assistant-markdown",
    completedText: "中文段落与 English prose 保持可见。",
  },
  {
    id: "raw-html",
    label: "危险 raw HTML",
    prefixes: cumulativePrefixes(
      "<",
      "<img",
      '<img src="x" onerror="alert(1)">',
    ),
    completedText: completedPrefixText,
  },
];
