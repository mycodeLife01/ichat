export type ResolvedCodeLanguage = {
  label: string;
  highlighterLanguage: string;
  showHeader: boolean;
};

const languages: Record<string, ResolvedCodeLanguage> = {
  plain: { label: "Plaintext", highlighterLanguage: "plain", showHeader: false },
  plaintext: { label: "Plaintext", highlighterLanguage: "plain", showHeader: false },
  text: { label: "Plaintext", highlighterLanguage: "plain", showHeader: false },
  txt: { label: "Plaintext", highlighterLanguage: "plain", showHeader: false },
  diff: { label: "Diff", highlighterLanguage: "plain", showHeader: true },
  html: { label: "HTML", highlighterLanguage: "markup", showHeader: true },
  htm: { label: "HTML", highlighterLanguage: "markup", showHeader: true },
  markup: { label: "HTML", highlighterLanguage: "markup", showHeader: true },
  xml: { label: "XML", highlighterLanguage: "markup", showHeader: true },
  svg: { label: "XML", highlighterLanguage: "markup", showHeader: true },
  css: { label: "CSS", highlighterLanguage: "css", showHeader: true },
  javascript: { label: "JavaScript", highlighterLanguage: "javascript", showHeader: true },
  js: { label: "JavaScript", highlighterLanguage: "javascript", showHeader: true },
  mjs: { label: "JavaScript", highlighterLanguage: "javascript", showHeader: true },
  cjs: { label: "JavaScript", highlighterLanguage: "javascript", showHeader: true },
  jsx: { label: "JSX", highlighterLanguage: "jsx", showHeader: true },
  typescript: { label: "TypeScript", highlighterLanguage: "typescript", showHeader: true },
  ts: { label: "TypeScript", highlighterLanguage: "typescript", showHeader: true },
  tsx: { label: "TSX", highlighterLanguage: "tsx", showHeader: true },
  json: { label: "JSON", highlighterLanguage: "json", showHeader: true },
  jsonc: { label: "JSON", highlighterLanguage: "json", showHeader: true },
  bash: { label: "Bash", highlighterLanguage: "bash", showHeader: true },
  sh: { label: "Bash", highlighterLanguage: "bash", showHeader: true },
  shell: { label: "Bash", highlighterLanguage: "bash", showHeader: true },
  zsh: { label: "Bash", highlighterLanguage: "bash", showHeader: true },
  python: { label: "Python", highlighterLanguage: "python", showHeader: true },
  py: { label: "Python", highlighterLanguage: "python", showHeader: true },
  java: { label: "Java", highlighterLanguage: "java", showHeader: true },
  c: { label: "C", highlighterLanguage: "c", showHeader: true },
  cpp: { label: "C++", highlighterLanguage: "cpp", showHeader: true },
  "c++": { label: "C++", highlighterLanguage: "cpp", showHeader: true },
  cc: { label: "C++", highlighterLanguage: "cpp", showHeader: true },
  cxx: { label: "C++", highlighterLanguage: "cpp", showHeader: true },
  csharp: { label: "C#", highlighterLanguage: "csharp", showHeader: true },
  cs: { label: "C#", highlighterLanguage: "csharp", showHeader: true },
  "c#": { label: "C#", highlighterLanguage: "csharp", showHeader: true },
  go: { label: "Go", highlighterLanguage: "go", showHeader: true },
  golang: { label: "Go", highlighterLanguage: "go", showHeader: true },
  rust: { label: "Rust", highlighterLanguage: "rust", showHeader: true },
  rs: { label: "Rust", highlighterLanguage: "rust", showHeader: true },
  sql: { label: "SQL", highlighterLanguage: "sql", showHeader: true },
  yaml: { label: "YAML", highlighterLanguage: "yaml", showHeader: true },
  yml: { label: "YAML", highlighterLanguage: "yaml", showHeader: true },
  markdown: { label: "Markdown", highlighterLanguage: "markdown", showHeader: true },
  md: { label: "Markdown", highlighterLanguage: "markdown", showHeader: true },
};

export function resolveCodeLanguage(className?: string): ResolvedCodeLanguage {
  const rawLanguage = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];

  if (!rawLanguage) {
    return { label: "代码", highlighterLanguage: "plain", showHeader: false };
  }

  return (
    languages[rawLanguage.toLowerCase()] ?? {
      label: rawLanguage,
      highlighterLanguage: "plain",
      showHeader: true,
    }
  );
}
