export type ResolvedCodeLanguage = {
  label: string;
  highlighterLanguage: string;
};

const languages: Record<string, ResolvedCodeLanguage> = {
  plain: { label: "Plaintext", highlighterLanguage: "plain" },
  plaintext: { label: "Plaintext", highlighterLanguage: "plain" },
  text: { label: "Plaintext", highlighterLanguage: "plain" },
  txt: { label: "Plaintext", highlighterLanguage: "plain" },
  html: { label: "HTML", highlighterLanguage: "markup" },
  htm: { label: "HTML", highlighterLanguage: "markup" },
  markup: { label: "HTML", highlighterLanguage: "markup" },
  xml: { label: "XML", highlighterLanguage: "markup" },
  svg: { label: "XML", highlighterLanguage: "markup" },
  css: { label: "CSS", highlighterLanguage: "css" },
  javascript: { label: "JavaScript", highlighterLanguage: "javascript" },
  js: { label: "JavaScript", highlighterLanguage: "javascript" },
  mjs: { label: "JavaScript", highlighterLanguage: "javascript" },
  cjs: { label: "JavaScript", highlighterLanguage: "javascript" },
  jsx: { label: "JSX", highlighterLanguage: "jsx" },
  typescript: { label: "TypeScript", highlighterLanguage: "typescript" },
  ts: { label: "TypeScript", highlighterLanguage: "typescript" },
  tsx: { label: "TSX", highlighterLanguage: "tsx" },
  json: { label: "JSON", highlighterLanguage: "json" },
  jsonc: { label: "JSON", highlighterLanguage: "json" },
  bash: { label: "Bash", highlighterLanguage: "bash" },
  sh: { label: "Bash", highlighterLanguage: "bash" },
  shell: { label: "Bash", highlighterLanguage: "bash" },
  zsh: { label: "Bash", highlighterLanguage: "bash" },
  python: { label: "Python", highlighterLanguage: "python" },
  py: { label: "Python", highlighterLanguage: "python" },
  java: { label: "Java", highlighterLanguage: "java" },
  c: { label: "C", highlighterLanguage: "c" },
  cpp: { label: "C++", highlighterLanguage: "cpp" },
  "c++": { label: "C++", highlighterLanguage: "cpp" },
  cc: { label: "C++", highlighterLanguage: "cpp" },
  cxx: { label: "C++", highlighterLanguage: "cpp" },
  csharp: { label: "C#", highlighterLanguage: "csharp" },
  cs: { label: "C#", highlighterLanguage: "csharp" },
  "c#": { label: "C#", highlighterLanguage: "csharp" },
  go: { label: "Go", highlighterLanguage: "go" },
  golang: { label: "Go", highlighterLanguage: "go" },
  rust: { label: "Rust", highlighterLanguage: "rust" },
  rs: { label: "Rust", highlighterLanguage: "rust" },
  sql: { label: "SQL", highlighterLanguage: "sql" },
  yaml: { label: "YAML", highlighterLanguage: "yaml" },
  yml: { label: "YAML", highlighterLanguage: "yaml" },
  markdown: { label: "Markdown", highlighterLanguage: "markdown" },
  md: { label: "Markdown", highlighterLanguage: "markdown" },
};

export function resolveCodeLanguage(className?: string): ResolvedCodeLanguage {
  const rawLanguage = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];

  if (!rawLanguage) return { label: "代码", highlighterLanguage: "plain" };

  return (
    languages[rawLanguage.toLowerCase()] ?? {
      label: rawLanguage,
      highlighterLanguage: "plain",
    }
  );
}
