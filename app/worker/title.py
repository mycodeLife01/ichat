from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.logging import logger
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.providers import Provider, ProviderError, ProviderMessage

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


class ProviderResolverProtocol(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider:
        raise NotImplementedError


@dataclass(frozen=True)
class TitleInputs:
    conversation_id: int
    user_content: str
    assistant_content: str


async def maybe_generate_title(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    settings: Settings,
    resolve_provider: ProviderResolverProtocol,
) -> None:
    if not settings.auto_title_enabled:
        return

    conversation_id: int | None = None
    try:
        inputs = await _load_title_inputs(session_factory=session_factory, run_id=run_id)
        if inputs is None:
            return
        conversation_id = inputs.conversation_id
        provider = resolve_provider(settings.summary_provider_name, settings=settings)
        raw_title = await provider.summarize(
            model=settings.summary_model,
            messages=[
                ProviderMessage(role="system", content=TITLE_SYSTEM_PROMPT),
                ProviderMessage(
                    role="user",
                    content=(
                        "用户首条消息：\n"
                        f"{inputs.user_content}\n\n"
                        "助手首条回复：\n"
                        f"{inputs.assistant_content}"
                    ),
                ),
            ],
            max_output_tokens=settings.auto_title_max_output_tokens,
        )
        title = normalize_generated_title(raw_title, max_chars=settings.auto_title_max_chars)
        if title is None:
            return
        async with session_factory() as session:
            await session.execute(
                update(Conversation)
                .where(
                    Conversation.id == inputs.conversation_id,
                    Conversation.title.is_(None),
                )
                .values(title=title, updated_at=func.now())
            )
            await session.commit()
    except ProviderError as exc:
        _log_title_failure(
            run_id=run_id,
            conversation_id=conversation_id,
            code=exc.code,
            message=exc.message,
        )
    except TimeoutError as exc:
        _log_title_failure(
            run_id=run_id,
            conversation_id=conversation_id,
            code="summary_timeout",
            message=str(exc),
        )
    except Exception as exc:
        _log_title_failure(
            run_id=run_id,
            conversation_id=conversation_id,
            code=exc.__class__.__name__,
            message=str(exc),
        )


async def _load_title_inputs(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
) -> TitleInputs | None:
    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            return None

        conversation = await session.get(Conversation, run.conversation_id)
        if (
            conversation is None
            or conversation.deleted_at is not None
            or conversation.title is not None
        ):
            return None

        succeeded_count = await session.scalar(
            select(func.count())
            .select_from(Run)
            .where(
                Run.conversation_id == run.conversation_id,
                Run.status == "succeeded",
            )
        )
        if succeeded_count != 1:
            return None

        first_user = await session.scalar(
            select(Message)
            .where(
                Message.conversation_id == run.conversation_id,
                Message.archived_at.is_(None),
                Message.role == "user",
            )
            .order_by(Message.position.asc())
            .limit(1)
        )
        if first_user is None:
            return None

        assistant = await session.scalar(
            select(Message)
            .where(
                Message.run_id == run_id,
                Message.archived_at.is_(None),
                Message.role == "assistant",
            )
            .order_by(Message.position.asc())
            .limit(1)
        )
        if assistant is None or not assistant.content.strip():
            return None

        return TitleInputs(
            conversation_id=run.conversation_id,
            user_content=first_user.content,
            assistant_content=assistant.content,
        )


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


def _log_title_failure(
    *,
    run_id: int,
    conversation_id: int | None,
    code: str,
    message: str,
) -> None:
    logger.bind(
        run_id=run_id,
        conversation_id=conversation_id,
        code=code,
        message=message,
    ).warning("Auto title generation failed")
