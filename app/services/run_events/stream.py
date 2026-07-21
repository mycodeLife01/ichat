import json
from collections.abc import Awaitable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, cast

from redis.asyncio import Redis
from redis.exceptions import ResponseError

from app.core.config import Settings
from app.schemas.runs import RunEventResponse, RunEventType
from app.services.runs.events import RunEvent

TERMINAL_EVENT_TYPES = frozenset({"run_succeeded", "run_failed", "run_cancelled"})

_XADD_WITH_ORPHAN_TTL_LUA = """
local existed = redis.call('EXISTS', KEYS[1])
local entry_id = redis.call(
  'XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], ARGV[2],
  'seq', ARGV[3], 'type', ARGV[4], 'payload', ARGV[5], 'created_at', ARGV[6]
)
if existed == 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[7])
end
return entry_id
"""


def run_event_stream_key(run_id: int) -> str:
    return f"run:{run_id}:events"


class RedisRunEventStream:
    def __init__(
        self,
        *,
        redis: Redis,
        maxlen: int,
        ttl_seconds: int,
        orphan_ttl_seconds: int,
    ) -> None:
        if maxlen < 1:
            raise ValueError("maxlen must be at least 1")
        if ttl_seconds < 1 or orphan_ttl_seconds < 1:
            raise ValueError("stream TTLs must be at least 1 second")
        self._redis = redis
        self._maxlen = maxlen
        self._ttl_seconds = ttl_seconds
        self._orphan_ttl_seconds = orphan_ttl_seconds

    @classmethod
    def from_settings(
        cls,
        settings: Settings,
        *,
        socket_timeout: float = 0.2,
    ) -> "RedisRunEventStream":
        redis: Redis = Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=0.2,
            socket_timeout=socket_timeout,
            retry_on_timeout=False,
        )
        return cls(
            redis=redis,
            maxlen=settings.run_stream_maxlen,
            ttl_seconds=settings.run_stream_ttl_seconds,
            orphan_ttl_seconds=settings.run_stream_orphan_ttl_seconds,
        )

    async def append(
        self,
        run_id: int,
        event: RunEvent,
        *,
        created_at: datetime | None = None,
        terminal: bool | None = None,
    ) -> None:
        key = run_event_stream_key(run_id)
        moment = created_at or datetime.now(UTC)
        entry_id = f"{event.seq}-0"
        payload = json.dumps(event.payload, ensure_ascii=False, separators=(",", ":"))
        try:
            await cast(
                Awaitable[Any],
                self._redis.eval(
                    _XADD_WITH_ORPHAN_TTL_LUA,
                    1,
                    key,
                    str(self._maxlen),
                    entry_id,
                    str(event.seq),
                    event.type,
                    payload,
                    moment.isoformat(),
                    str(self._orphan_ttl_seconds),
                ),
            )
        except ResponseError as exc:
            if "equal or smaller" not in str(exc):
                raise
            existing = await self._redis.xrange(key, min=entry_id, max=entry_id, count=1)
            if not existing:
                raise
        is_terminal = terminal if terminal is not None else event.type in TERMINAL_EVENT_TYPES
        if is_terminal:
            await self._redis.expire(key, self._ttl_seconds)

    async def list_after(self, run_id: int, *, after_seq: int) -> list[RunEventResponse]:
        rows = await self._redis.xrange(
            run_event_stream_key(run_id),
            min=f"({after_seq}-0",
            max="+",
        )
        return _decode_rows(rows)

    async def read_after(
        self,
        run_id: int,
        *,
        after_seq: int,
        block_milliseconds: int,
    ) -> list[RunEventResponse]:
        result = await self._redis.xread(
            {run_event_stream_key(run_id): f"{after_seq}-0"},
            count=256,
            block=block_milliseconds,
        )
        if not result:
            return []
        return _decode_rows(result[0][1])

    async def latest_seq(self, run_id: int) -> int:
        rows = await self._redis.xrevrange(run_event_stream_key(run_id), count=1)
        if not rows:
            return 0
        fields = rows[0][1]
        return int(_field(fields, "seq"))

    async def close(self) -> None:
        await self._redis.aclose()


StreamFields = Mapping[str | bytes, str | bytes]
StreamRows = Sequence[tuple[str | bytes, StreamFields]]


def _decode_rows(rows: StreamRows) -> list[RunEventResponse]:
    events: list[RunEventResponse] = []
    for _, fields in rows:
        raw_payload = json.loads(_field(fields, "payload"))
        if not isinstance(raw_payload, dict):
            raise ValueError("Redis run event payload must be an object")
        events.append(
            RunEventResponse(
                seq=int(_field(fields, "seq")),
                type=cast(RunEventType, _field(fields, "type")),
                payload=cast(dict[str, Any], raw_payload),
                created_at=datetime.fromisoformat(_field(fields, "created_at")),
            )
        )
    return events


def _field(fields: StreamFields, name: str) -> str:
    value = fields.get(name)
    if value is None:
        value = fields.get(name.encode())
    if value is None:
        raise ValueError(f"Redis run event is missing {name}")
    return value.decode() if isinstance(value, bytes) else value
