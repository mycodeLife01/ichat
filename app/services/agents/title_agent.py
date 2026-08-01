from collections.abc import Callable
from dataclasses import dataclass

from app.agent import Message, Provider, system_text, user_text
from app.core.config import Settings
from app.services.agents.registry import resolve_provider as default_resolve_provider

TITLE_SYSTEM_PROMPT = (
    "你是 iChat 的对话标题生成器。请根据用户首条消息和助手首条回复，"
    "生成一个简短标题。标题语言跟随用户消息。只输出标题文本，不要引号、"
    "不要句末标点、不要添加“标题：”前缀。中文不超过 16 个汉字，英文不超过 32 个字符。"
)

WRAPPER_PAIRS = (
    ('"', '"'),
    ("'", "'"),
    ("`", "`"),
    ("“", "”"),
    ("‘", "’"),
    ("《", "》"),
)

PREFIXES = ("标题:", "标题：", "Title:", "Title：")

ProviderResolver = Callable[..., Provider]


@dataclass(frozen=True)
class TitleAgent:
    provider: Provider
    model: str
    max_output_tokens: int
    max_chars: int

    def generate(
        self,
        *,
        user_content: str,
        assistant_content: str,
        attachment_metadata: str | None = None,
    ) -> str | None:
        raw_title = self.provider.generate(
            model=self.model,
            messages=_title_messages(
                user_content=user_content,
                assistant_content=assistant_content,
                attachment_metadata=attachment_metadata,
            ),
            max_output_tokens=self.max_output_tokens,
        )
        return normalize_generated_title(raw_title, max_chars=self.max_chars)


def build_title_agent(
    *,
    settings: Settings,
    resolve_provider: ProviderResolver = default_resolve_provider,
) -> TitleAgent:
    provider = resolve_provider(settings.summary_provider_name, settings=settings)
    return TitleAgent(
        provider=provider,
        model=settings.summary_model,
        max_output_tokens=settings.auto_title_max_output_tokens,
        max_chars=settings.auto_title_max_chars,
    )


def _title_messages(
    *,
    user_content: str,
    assistant_content: str,
    attachment_metadata: str | None = None,
) -> list[Message]:
    return [
        system_text(TITLE_SYSTEM_PROMPT),
        user_text(
            "用户首条消息：\n"
            f"{user_content}\n\n"
            "附件元数据（仅文件名、格式和大小；不含正文）：\n"
            f"{attachment_metadata or '无'}\n\n"
            "助手首条回复：\n"
            f"{assistant_content}"
        ),
    ]


def normalize_generated_title(raw_title: str, *, max_chars: int) -> str | None:
    title = " ".join(raw_title.strip().split())
    title = _strip_wrapping_pair(title)
    title = _strip_known_prefix(title)
    title = _strip_wrapping_pair(title.strip())
    if not title:
        return None
    return title[:max_chars]


def _strip_wrapping_pair(value: str) -> str:
    stripped = value.strip()
    for left, right in WRAPPER_PAIRS:
        if stripped.startswith(left) and stripped.endswith(right) and len(stripped) >= 2:
            return stripped[len(left) : len(stripped) - len(right)].strip()
    return stripped


def _strip_known_prefix(value: str) -> str:
    stripped = value.strip()
    lowered = stripped.lower()
    for prefix in PREFIXES:
        if lowered.startswith(prefix.lower()):
            return stripped[len(prefix) :].strip()
    return stripped
