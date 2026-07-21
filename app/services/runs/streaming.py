import asyncio
from collections.abc import AsyncIterator
from typing import Protocol, SupportsInt, cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.models.run import RunDraft
from app.schemas.runs import RunEventResponse
from app.services.runs.drafts import get_run_draft
from app.services.runs.service import (
    TERMINAL_EVENT_TYPES,
    RunEventReader,
    list_run_events_after,
    run_has_terminal_event,
)

_REDIS_BLOCK_MILLISECONDS = 3_000


class BlockingRunEventReader(RunEventReader, Protocol):
    async def read_after(
        self,
        run_id: int,
        *,
        after_seq: int,
        block_milliseconds: int,
    ) -> list[RunEventResponse]: ...


async def iter_run_events(
    session: AsyncSession,
    *,
    run_id: int,
    after_seq: int,
    event_stream: BlockingRunEventReader | None,
) -> AsyncIterator[RunEventResponse]:
    cursor = after_seq
    sent_text = ""
    sent_reasoning = ""
    checkpoint_baseline_known = after_seq == 0
    redis_failure_logged = False
    first_iteration = True

    while True:
        if first_iteration:
            persisted = await list_run_events_after(session, run_id=run_id, after_seq=cursor)
            streamed, redis_available, redis_failure_logged = await _replay_redis(
                event_stream,
                run_id=run_id,
                after_seq=cursor,
                failure_logged=redis_failure_logged,
            )
            first_iteration = False
        elif event_stream is not None:
            try:
                streamed = await event_stream.read_after(
                    run_id,
                    after_seq=cursor,
                    block_milliseconds=_REDIS_BLOCK_MILLISECONDS,
                )
            except Exception as exc:
                if not redis_failure_logged:
                    logger.bind(run_id=run_id, error=str(exc)).warning(
                        "Redis SSE tail failed; using PostgreSQL checkpoint fallback"
                    )
                    redis_failure_logged = True
                streamed = []
                redis_available = False
            else:
                redis_available = True
                redis_failure_logged = False
            if streamed:
                for event in sorted(streamed, key=lambda item: item.seq):
                    if event.seq <= cursor:
                        continue
                    cursor = event.seq
                    sent_text, sent_reasoning = _accumulate_snapshot(
                        event,
                        sent_text=sent_text,
                        sent_reasoning=sent_reasoning,
                        enabled=checkpoint_baseline_known,
                    )
                    yield event
                    if event.type in TERMINAL_EVENT_TYPES:
                        return
                continue
            persisted = await list_run_events_after(session, run_id=run_id, after_seq=cursor)
        else:
            redis_available = False
            streamed = []
            persisted = await list_run_events_after(session, run_id=run_id, after_seq=cursor)

        draft = await get_run_draft(session, run_id=run_id)
        checkpoint_events: list[RunEventResponse] = []
        if draft is not None and draft.seq > cursor:
            covered_seqs = {event.seq for event in streamed}
            checkpoint_events = [
                event
                for event in _draft_events_after(draft.events, after_seq=cursor, draft=draft)
                if event.seq not in covered_seqs
            ]
            if not checkpoint_events and checkpoint_baseline_known:
                reasoning_delta = _snapshot_suffix(draft.reasoning, sent_reasoning)
                text_delta = _snapshot_suffix(draft.text, sent_text)
                if reasoning_delta:
                    checkpoint_events.append(
                        RunEventResponse(
                            seq=draft.seq,
                            type="reasoning_delta",
                            payload={"text": reasoning_delta},
                            created_at=draft.updated_at,
                        )
                    )
                if text_delta:
                    checkpoint_events.append(
                        RunEventResponse(
                            seq=draft.seq,
                            type="text_delta",
                            payload={"text": text_delta},
                            created_at=draft.updated_at,
                        )
                    )
            sent_text = draft.text
            sent_reasoning = draft.reasoning
            checkpoint_baseline_known = True
        elif draft is not None and draft.seq == cursor and not checkpoint_baseline_known:
            sent_text = draft.text
            sent_reasoning = draft.reasoning
            checkpoint_baseline_known = True

        merged = {event.seq: [event] for event in streamed}
        for event in checkpoint_events:
            merged.setdefault(event.seq, []).append(event)
        for event in persisted:
            merged[event.seq] = [event]

        for seq in sorted(merged):
            for event in merged[seq]:
                if event.seq < cursor:
                    continue
                cursor = max(cursor, event.seq)
                sent_text, sent_reasoning = _accumulate_snapshot(
                    event,
                    sent_text=sent_text,
                    sent_reasoning=sent_reasoning,
                    enabled=checkpoint_baseline_known and event not in checkpoint_events,
                )
                yield event
                if event.type in TERMINAL_EVENT_TYPES:
                    return

        if draft is not None and draft.seq > cursor:
            cursor = draft.seq

        if await run_has_terminal_event(session, run_id=run_id):
            return

        await session.rollback()
        if not redis_available:
            await asyncio.sleep(1.0)


async def _replay_redis(
    event_stream: BlockingRunEventReader | None,
    *,
    run_id: int,
    after_seq: int,
    failure_logged: bool,
) -> tuple[list[RunEventResponse], bool, bool]:
    if event_stream is None:
        return [], False, failure_logged
    try:
        events = await event_stream.list_after(run_id, after_seq=after_seq)
    except Exception as exc:
        if not failure_logged:
            logger.bind(run_id=run_id, error=str(exc)).warning(
                "Redis SSE replay failed; using PostgreSQL checkpoint fallback"
            )
        return [], False, True
    return events, True, False


def _accumulate_snapshot(
    event: RunEventResponse,
    *,
    sent_text: str,
    sent_reasoning: str,
    enabled: bool,
) -> tuple[str, str]:
    if not enabled:
        return sent_text, sent_reasoning
    text = event.payload.get("text")
    if event.type == "text_delta" and isinstance(text, str):
        sent_text += text
    elif event.type == "reasoning_delta" and isinstance(text, str):
        sent_reasoning += text
    return sent_text, sent_reasoning


def _draft_events_after(
    raw_events: list[dict[str, object]],
    *,
    after_seq: int,
    draft: RunDraft,
) -> list[RunEventResponse]:
    events: list[RunEventResponse] = []
    for raw in raw_events:
        try:
            seq = int(cast(SupportsInt, raw["seq"]))
            event_type = str(raw["type"])
            payload = raw["payload"]
        except (KeyError, TypeError, ValueError):
            continue
        if seq <= after_seq or not isinstance(payload, dict):
            continue
        events.append(
            RunEventResponse.model_validate(
                {
                    "seq": seq,
                    "type": event_type,
                    "payload": payload,
                    "created_at": draft.updated_at,
                }
            )
        )
    return events


def _snapshot_suffix(snapshot: str, sent: str) -> str:
    if snapshot.startswith(sent):
        return snapshot[len(sent) :]
    return snapshot
