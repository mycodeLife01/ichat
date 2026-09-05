"""Versioned, deterministic visible-text representation for history search."""

import hashlib
import re
from collections.abc import Iterable

from markdown_it import MarkdownIt
from markdown_it.token import Token
from mdit_py_plugins.tasklists import tasklists_plugin

SEARCH_TEXT_VERSION = 1
ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz"
# Explicit ECMAScript whitespace set, shared with the browser implementation.
SPACE = re.compile(r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")
_CODE = re.compile(r"(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*?`+)")
_MATH = re.compile(r"\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\${2,}[\s\S]+?\${2,}")
_PARSER = (
    MarkdownIt("commonmark", {"html": True, "breaks": True, "strikethrough_single_tilde": True})
    .enable(["table", "strikethrough"])
    .use(tasklists_plugin)
)


def build_user_search_text(content: str) -> str:
    return SPACE.sub(" ", content).strip(" ")


def build_title_search_text(title: str | None) -> str:
    return build_user_search_text(title or "")


def normalize_query(query: str) -> str:
    return build_user_search_text(query).translate(str.maketrans(ASCII_UPPER, ASCII_LOWER))


def _visible(tokens: Iterable[Token], source_ids: frozenset[int]) -> str:
    parts: list[str] = []
    for token in tokens:
        if token.type == "inline":
            parts.append(_visible(token.children or [], source_ids))
        elif token.type == "text":

            def replace_citations(match: re.Match[str]) -> str:
                if any(int(value) in source_ids for value in re.findall(r"\[(\d+)\]", match[1])):
                    return match[2] + " "
                return match[0]

            parts.append(
                re.sub(r"(\[\d+\](?:\s*\[\d+\])*)([。.！!？?]*)", replace_citations, token.content)
            )
        elif token.type in {"code_inline", "code_block", "fence"}:
            parts.append(token.content)
            if token.type != "code_inline":
                parts.append(" ")
        elif token.type in {"softbreak", "hardbreak", "image", "html_block", "html_inline"}:
            parts.append(" ")
        elif token.block:
            parts.append(" ")
    return "".join(parts)


def build_assistant_search_text(content: str, source_ids: frozenset[int] = frozenset()) -> str:
    # Keep literal math examples in code. Math glyphs are outside the search contract.
    placeholder = "ICHATSEARCHMATHEXCLUDED"
    while placeholder in content:
        placeholder += "Q"
    segments = _CODE.split(content)
    cleaned = "".join(
        part if i % 2 else _MATH.sub(placeholder, part) for i, part in enumerate(segments)
    )
    # Preserve emphasis delimiter flanking while parsing math, then omit its visible glyphs.
    visible = _visible(_PARSER.parse(cleaned), source_ids).replace(placeholder, " ")
    return build_user_search_text(visible)


def search_text_hash(text: str) -> str:
    return hashlib.sha256(f"conversation-search:{SEARCH_TEXT_VERSION}\n{text}".encode()).hexdigest()


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def title_match_range(title: str, query: str) -> tuple[int, int] | None:
    # Map collapsed whitespace back to the original title's UTF-16 offsets.
    chars: list[str] = []
    spans: list[tuple[int, int]] = []
    offset = 0
    for char in title:
        end = offset + utf16_length(char)
        if SPACE.fullmatch(char):
            if chars and chars[-1] != " ":
                chars.append(" ")
                spans.append((offset, end))
            elif chars:
                spans[-1] = (spans[-1][0], end)
        else:
            chars.append(char.translate(str.maketrans(ASCII_UPPER, ASCII_LOWER)))
            spans.append((offset, end))
        offset = end
    index = "".join(chars).find(query)
    if index < 0 or not query:
        return None
    return spans[index][0], spans[index + len(query) - 1][1]
