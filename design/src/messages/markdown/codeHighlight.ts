import {
  highlightCode,
  tags,
  type Highlighter,
  type Tag,
} from "@lezer/highlight";

export type HighlightedCodeChunk = {
  content: string;
  type: string | null;
};

type SyntaxTree = Parameters<typeof highlightCode>[1];
type SyntaxParser = { parse(source: string): SyntaxTree };
type ParserConfig = { highlighter: Highlighter; parser: SyntaxParser };

const parserPromises = new Map<string, Promise<ParserConfig | null>>();

function includesTag(received: readonly Tag[], expected: Tag) {
  return received.some((tag) => tag.set.includes(expected));
}

function includesAnyTag(received: readonly Tag[], expected: readonly Tag[]) {
  return expected.some((tag) => includesTag(received, tag));
}

const commentTags = [tags.comment, tags.lineComment, tags.blockComment, tags.docComment];
const stringTags = [
  tags.string,
  tags.docString,
  tags.character,
  tags.attributeValue,
  tags.regexp,
  tags.escape,
];
const numberTags = [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom];
const keywordTags = [
  tags.keyword,
  tags.modifier,
  tags.operatorKeyword,
  tags.controlKeyword,
  tags.definitionKeyword,
  tags.moduleKeyword,
  tags.operator,
];
const variableTags = [
  tags.variableName,
  tags.typeName,
  tags.className,
  tags.namespace,
  tags.macroName,
];

function commonTokenType(received: readonly Tag[]) {
  if (includesAnyTag(received, commentTags)) return "comment";
  if (includesAnyTag(received, stringTags)) return "string";
  if (includesAnyTag(received, numberTags)) return "number";
  if (includesAnyTag(received, keywordTags)) return "keyword";
  if (includesAnyTag(received, variableTags)) return "variable";
  if (includesAnyTag(received, [tags.annotation, tags.meta])) return "tag";
  return null;
}

const codeHighlighter: Highlighter = {
  style(received) {
    if (includesTag(received, tags.propertyName)) return null;
    return commonTokenType(received);
  },
};

const dataHighlighter: Highlighter = {
  style(received) {
    if (includesTag(received, tags.propertyName)) return null;
    return commonTokenType(received);
  },
};

const markupHighlighter: Highlighter = {
  style(received) {
    if (includesTag(received, tags.attributeName)) return "attribute";
    if (includesTag(received, tags.operator)) return "keyword";
    if (includesAnyTag(received, [tags.tagName, tags.typeName, tags.punctuation])) {
      return "tag";
    }
    return commonTokenType(received);
  },
};

const cssHighlighter: Highlighter = {
  style(received) {
    if (includesTag(received, tags.propertyName)) return null;
    if (includesTag(received, tags.className)) return "number";
    if (includesAnyTag(received, [tags.tagName, tags.typeName])) return "tag";
    return commonTokenType(received);
  },
};

async function loadParser(language: string): Promise<ParserConfig | null> {
  switch (language) {
    case "python": {
      const { parser } = await import("@lezer/python");
      return { highlighter: codeHighlighter, parser };
    }
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx": {
      const { parser } = await import("@lezer/javascript");
      const dialect =
        language === "jsx" ? "jsx" : language === "typescript" ? "ts" : "jsx ts";
      return {
        highlighter: codeHighlighter,
        parser: language === "javascript" ? parser : parser.configure({ dialect }),
      };
    }
    case "json": {
      const { parser } = await import("@lezer/json");
      return { highlighter: dataHighlighter, parser };
    }
    case "yaml": {
      const { parser } = await import("@lezer/yaml");
      return { highlighter: dataHighlighter, parser };
    }
    case "markup": {
      const [html, javascript, css] = await Promise.all([
        import("@lezer/html"),
        import("@lezer/javascript"),
        import("@lezer/css"),
      ]);
      const typescriptParser = javascript.parser.configure({ dialect: "ts" });
      const jsxParser = javascript.parser.configure({ dialect: "jsx" });
      const tsxParser = javascript.parser.configure({ dialect: "jsx ts" });
      const parser = html.parser.configure({
        wrap: html.configureNesting(
          [
            {
              tag: "script",
              attrs: (attributes) =>
                attributes.type === "text/typescript" || attributes.lang === "ts",
              parser: typescriptParser,
            },
            {
              tag: "script",
              attrs: (attributes) =>
                attributes.type === "text/babel" || attributes.type === "text/jsx",
              parser: jsxParser,
            },
            {
              tag: "script",
              attrs: (attributes) => attributes.type === "text/typescript-jsx",
              parser: tsxParser,
            },
            { tag: "script", parser: javascript.parser },
            { tag: "style", parser: css.parser },
          ],
          [{ name: "style", parser: css.parser.configure({ top: "Styles" }) }],
        ),
      });
      return { highlighter: markupHighlighter, parser };
    }
    case "css": {
      const { parser } = await import("@lezer/css");
      return { highlighter: cssHighlighter, parser };
    }
    default:
      return null;
  }
}

function parserForLanguage(language: string) {
  const existing = parserPromises.get(language);
  if (existing) return existing;
  const pending = loadParser(language);
  parserPromises.set(language, pending);
  return pending;
}

function appendChunk(
  chunks: HighlightedCodeChunk[],
  content: string,
  type: string | null,
) {
  const previous = chunks.at(-1);
  if (previous?.type === type) {
    previous.content += content;
    return;
  }
  chunks.push({ content, type });
}

function lezerChunks(
  source: string,
  parser: SyntaxParser,
  highlighter: Highlighter,
) {
  const chunks: HighlightedCodeChunk[] = [];
  highlightCode(
    source,
    parser.parse(source),
    highlighter,
    (content, type) => appendChunk(chunks, content, type || null),
    () => appendChunk(chunks, "\n", null),
  );
  return chunks;
}

function bashChunks(source: string) {
  const chunks: HighlightedCodeChunk[] = [];
  const pattern = /(^|\s)(-{1,2}[\w-]+)|\bps\b/gm;
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const matched = match[0];
    const token = match[2] ?? "ps";
    const tokenStart = match.index + matched.lastIndexOf(token);
    if (tokenStart > cursor) appendChunk(chunks, source.slice(cursor, tokenStart), null);
    appendChunk(chunks, token, token === "ps" ? "number" : "attribute");
    cursor = tokenStart + token.length;
  }

  if (cursor < source.length) appendChunk(chunks, source.slice(cursor), null);
  return chunks;
}

const sqlKeywords = new Set(
  (
    "ADD ALL ALTER AND ANY AS ASC BETWEEN BY CASE CHECK COLUMN CONSTRAINT " +
    "CREATE DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXISTS FOREIGN " +
    "FROM FULL GROUP HAVING IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE " +
    "LIMIT NOT NULL ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE " +
    "THEN TOP UNION UNIQUE UPDATE VALUES VIEW WHEN WHERE WITH"
  ).split(" "),
);
const sqlFunctions = new Set(
  "AVG COALESCE COUNT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOWER MAX MIN NOW ROUND SUM UPPER".split(
    " ",
  ),
);

function sqlChunks(source: string) {
  const chunks: HighlightedCodeChunk[] = [];
  const pattern =
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w$]*\b|::|<>|!=|<=|>=|[-+*/%=<>]/g;
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    const start = match.index;
    if (start > cursor) appendChunk(chunks, source.slice(cursor, start), null);

    let type: string | null = null;
    const upper = token.toUpperCase();
    if (token.startsWith("--") || token.startsWith("/*")) type = "comment";
    else if (token.startsWith("'")) type = "string";
    else if (/^\d/.test(token) || upper === "TRUE" || upper === "FALSE") type = "number";
    else if (upper === "NULL") type = "number";
    else if (sqlKeywords.has(upper) || sqlFunctions.has(upper)) type = "keyword";
    else if (/^(?:::|<>|!=|<=|>=|[-+*/%=<>])$/.test(token)) type = "keyword";

    appendChunk(chunks, token, type);
    cursor = start + token.length;
  }

  if (cursor < source.length) appendChunk(chunks, source.slice(cursor), null);
  return chunks;
}

async function prismChunks(source: string, language: string) {
  const { normalizeTokens, Prism } = await import("prism-react-renderer");
  const grammar = Prism.languages[language];
  if (!grammar) return null;

  const chunks: HighlightedCodeChunk[] = [];
  const lines = normalizeTokens(Prism.tokenize(source, grammar));
  lines.forEach((line, lineIndex) => {
    line.forEach((token) => {
      appendChunk(chunks, token.empty ? "" : token.content, token.types.join(" "));
    });
    if (lineIndex < lines.length - 1) appendChunk(chunks, "\n", null);
  });
  return chunks;
}

export async function highlightSource(source: string, language: string) {
  if (language === "plain") return null;
  if (language === "bash") return bashChunks(source);
  if (language === "sql") return sqlChunks(source);

  const lezer = await parserForLanguage(language);
  return lezer
    ? lezerChunks(source, lezer.parser, lezer.highlighter)
    : await prismChunks(source, language);
}
