"""Load conversation history from the store as agent-kernel messages.

This is the business/persistence half of context assembly (the orchestration
half is ``app/services/agents/context.py``, which is DB-free): it reads the
visible history, projects succeeded runs' transcripts for the target route,
and yields a flat ``list[Message]`` in conversation order. The worker feeds
this to ``app.services.agents.build_chat_agent``.
"""

from collections.abc import Mapping
from typing import Literal, cast
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.messages import (
    AttachmentNoticeBlock,
    ContentBlock,
    DocumentBlock,
    ImageBlock,
    Message,
    Role,
    TextBlock,
    user_text,
)
from app.models.conversation import Message as MessageRow
from app.models.run import Run
from app.services.runs.transcript import load_transcript

_ReplayMode = Literal["full", "portable", "input"]
_RouteAffinity = tuple[str, str, str, str]


async def load_conversation_history(
    session: AsyncSession,
    *,
    run_id: int,
) -> list[Message]:
    """Return the visible history up to the run's target user message as neutral
    ``Message``s in order (user turns interleaved with replayed transcripts)."""
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    target = await session.get(MessageRow, run.user_message_id)
    if target is None:
        raise LookupError(f"Target user message {run.user_message_id} not found")

    history_rows = (
        await session.scalars(
            select(MessageRow)
            .where(
                MessageRow.conversation_id == run.conversation_id,
                MessageRow.archived_at.is_(None),
                MessageRow.position <= target.position,
            )
            .order_by(MessageRow.position.asc())
        )
    ).all()

    replay_modes = await _resolve_replay_modes(
        session,
        history_rows=list(history_rows),
        target_run=run,
        target_user_message_id=target.id,
    )
    return await _build_history(
        session,
        history_rows=list(history_rows),
        target_user_message_id=target.id,
        target_run_id=run.id,
        replay_modes=replay_modes,
    )


async def _build_history(
    session: AsyncSession,
    *,
    history_rows: list[MessageRow],
    target_user_message_id: int,
    target_run_id: int | None = None,
    replay_modes: Mapping[int, _ReplayMode] | None = None,
) -> list[Message]:
    messages: list[Message] = []
    skipped_message_ids: set[int] = set()
    messages_by_run: dict[int, list[MessageRow]] = {}
    for row in history_rows:
        if row.run_id is not None:
            messages_by_run.setdefault(row.run_id, []).append(row)

    for row in history_rows:
        if row.id in skipped_message_ids:
            continue
        if row.role != "user":
            messages.append(
                Message(role=_normalize_role(row.role), blocks=[TextBlock(row.content)])
            )
            continue

        replay_run_id = target_run_id if row.id == target_user_message_id else row.run_id
        transcript = (
            await _load_run_transcript_for_history(
                session,
                run_id=replay_run_id,
                mode=(replay_modes or {}).get(replay_run_id, "input"),
            )
            if replay_run_id is not None
            else []
        )
        # New transcripts are self-contained and start with the exact user
        # input blocks (including attachment extracts). Legacy transcripts
        # start at the assistant output, so retain the message-row fallback.
        if transcript and transcript[0].role == "user":
            messages.extend(transcript)
        else:
            messages.append(user_text(row.content))
            if row.id != target_user_message_id and transcript:
                messages.extend(transcript)
        if row.id != target_user_message_id and row.run_id is not None:
            if transcript:
                # A completed transcript already contains the provider output.
                # Skip its materialized assistant rows so new self-contained
                # transcripts do not replay the same answer twice.
                skipped_message_ids.update(
                    message.id
                    for message in messages_by_run.get(row.run_id, [])
                    if message.id != row.id and message.role == "assistant"
                )
    return messages


async def _load_run_transcript_for_history(
    session: AsyncSession,
    *,
    run_id: int | None,
    mode: _ReplayMode,
) -> list[Message]:
    if run_id is None:
        return []
    run = await session.get(Run, run_id)
    if run is None:
        return []
    transcript = await load_transcript(session, run_id=run_id)
    if run.status == "succeeded" and mode == "full":
        return _copy_messages(transcript)
    if run.status == "succeeded" and mode == "portable":
        return _portable_turn(transcript)
    # New runs persist their exact user input before execution. Preserve that
    # attachment snapshot for the target run and after failed/cancelled
    # attempts, while never replaying partial provider output. Legacy
    # transcripts start with assistant/tool output and therefore still fall
    # back to the message row alone.
    return _exact_user_input(transcript)


async def _resolve_replay_modes(
    session: AsyncSession,
    *,
    history_rows: list[MessageRow],
    target_run: Run,
    target_user_message_id: int,
) -> dict[int, _ReplayMode]:
    prior_run_ids: list[int] = []
    seen: set[int] = set()
    for row in history_rows:
        if (
            row.role != "user"
            or row.id == target_user_message_id
            or row.run_id is None
            or row.run_id in seen
        ):
            continue
        seen.add(row.run_id)
        prior_run_ids.append(row.run_id)

    runs = (
        await session.scalars(select(Run).where(Run.id.in_(prior_run_ids)))
    ).all()
    runs_by_id = {run.id: run for run in runs}
    target_affinity = _route_affinity(target_run)
    full_replay_ids: set[int] = set()
    if target_affinity is not None:
        for prior_run_id in reversed(prior_run_ids):
            prior_run = runs_by_id.get(prior_run_id)
            if prior_run is None or prior_run.status != "succeeded":
                continue
            if _route_affinity(prior_run) != target_affinity:
                break
            full_replay_ids.add(prior_run_id)

    modes: dict[int, _ReplayMode] = {target_run.id: "input"}
    for prior_run_id in prior_run_ids:
        prior_run = runs_by_id.get(prior_run_id)
        if prior_run is None or prior_run.status != "succeeded":
            modes[prior_run_id] = "input"
        elif prior_run_id in full_replay_ids:
            modes[prior_run_id] = "full"
        else:
            modes[prior_run_id] = "portable"
    return modes


def _route_affinity(run: Run) -> _RouteAffinity | None:
    snapshot = run.model_config_snapshot
    if not isinstance(snapshot, Mapping):
        return None
    version = snapshot.get("version")
    if isinstance(version, bool) or version not in (1, 2):
        return None
    adapter = snapshot.get("adapter")
    upstream = snapshot.get("upstream")
    base_url = snapshot.get("base_url")
    provider_model = snapshot.get("provider_model")
    if not all(
        isinstance(value, str) and value
        for value in (adapter, upstream, base_url, provider_model)
    ):
        return None
    assert isinstance(adapter, str)
    assert isinstance(upstream, str)
    assert isinstance(base_url, str)
    assert isinstance(provider_model, str)
    if adapter != run.provider_name or provider_model != run.provider_model:
        return None
    normalized_base_url = _normalize_base_url(base_url)
    if normalized_base_url is None:
        return None
    return (adapter, upstream, normalized_base_url, provider_model)


def _normalize_base_url(value: str) -> str | None:
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return None
    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 80 if scheme == "http" else 443
    netloc = host if port in (None, default_port) else f"{host}:{port}"
    path = parsed.path.rstrip("/")
    return urlunsplit((scheme, netloc, path, "", ""))


def _portable_turn(transcript: list[Message]) -> list[Message]:
    projected = _exact_user_input(transcript)
    final_assistant = next(
        (message for message in reversed(transcript) if message.role == "assistant"),
        None,
    )
    if final_assistant is None:
        return projected
    text_blocks: list[ContentBlock] = [
        TextBlock(block.text)
        for block in final_assistant.blocks
        if isinstance(block, TextBlock) and block.text
    ]
    if text_blocks:
        projected.append(Message(role="assistant", blocks=text_blocks))
    return projected


def _exact_user_input(transcript: list[Message]) -> list[Message]:
    if not transcript or transcript[0].role != "user":
        return []
    blocks = [
        block
        for block in transcript[0].blocks
        if isinstance(
            block,
            (TextBlock, DocumentBlock, ImageBlock, AttachmentNoticeBlock),
        )
    ]
    return [Message(role="user", blocks=list(blocks))] if blocks else []


def _copy_messages(messages: list[Message]) -> list[Message]:
    return [Message(role=message.role, blocks=list(message.blocks)) for message in messages]


def _normalize_role(role: str) -> Role:
    if role in ("user", "assistant", "system"):
        return cast(Role, role)
    raise ValueError(f"Unsupported message role: {role}")
