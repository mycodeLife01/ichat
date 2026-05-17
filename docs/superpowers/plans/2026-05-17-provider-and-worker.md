# Provider 和 Worker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 provider 抽象、fake/DeepSeek provider 适配器、context builder、worker claim/lease/heartbeat/recovery 和 stream 执行 loop，让 queued run 能跑通完整生命周期。

**Architecture:** 业务层依赖 `Provider` ABC，不依赖 DeepSeek-specific 类。`app/worker/` 是独立 async 进程，从 PostgreSQL 用 `FOR UPDATE SKIP LOCKED` claim queued run，构建 context、调用 provider stream、持久化 `text_delta` 和 terminal event、心跳续租、检测 cancel、成功时物化 assistant message，并跑独立 recovery loop 把 lease 过期的 active run 标 failed。

**Tech Stack:** Python 3.12, FastAPI/SQLAlchemy 2.0 async + asyncpg, httpx, pytest-asyncio, loguru, mypy strict, ruff。

---

## 文件结构

新增：

- `app/providers/__init__.py` — 公共 API 导出。
- `app/providers/types.py` — `ProviderMessage`、`TextDelta`、`Finish`、`ProviderError`、`Provider` ABC。
- `app/providers/registry.py` — `resolve_provider(name, settings)`。
- `app/providers/deepseek.py` — `DeepSeekProvider`。
- `app/providers/deepseek_parser.py` — SSE 行解析纯函数。
- `app/context/__init__.py`、`app/context/builder.py` — `build_context()`。
- `app/services/runs/lifecycle.py` — claim、状态转换、lease、recovery。
- `app/worker/__init__.py`、`app/worker/executor.py`、`app/worker/main.py`、`app/worker/__main__.py`。
- `tests/providers/__init__.py`、`tests/providers/fake.py` — 测试用 `FakeProvider`。
- `tests/providers/test_deepseek_parser.py`、`tests/providers/test_deepseek_adapter.py`、`tests/providers/test_registry.py`。
- `tests/context/__init__.py`、`tests/context/test_builder.py`。
- `tests/services/runs/test_lifecycle.py`。
- `tests/services/conversations/test_materialize.py`。
- `tests/worker/__init__.py`、`tests/worker/test_executor.py`、`tests/worker/test_main.py`。

修改：

- `app/services/conversations/service.py` — 增加 `materialize_assistant_message()`。
- `app/services/conversations/__init__.py` — 导出新函数。
- `app/services/runs/__init__.py` — 导出 lifecycle 公共函数。
- `compose.yml` — 把 `worker` service 的 placeholder command 换成 `python -m app.worker`。

---

## Task 1: Provider 域类型和 ABC

**Files:**
- Create: `app/providers/__init__.py`
- Create: `app/providers/types.py`
- Create: `tests/providers/__init__.py`
- Create: `tests/providers/test_types.py`

- [ ] **Step 1: Write the failing test**

`tests/providers/test_types.py`:

```python
from app.providers.types import (
    Finish,
    ProviderError,
    ProviderMessage,
    TextDelta,
)


def test_provider_message_holds_role_and_content() -> None:
    message = ProviderMessage(role="user", content="Hello")

    assert message.role == "user"
    assert message.content == "Hello"


def test_text_delta_holds_text() -> None:
    delta = TextDelta(text="abc")

    assert delta.text == "abc"


def test_finish_holds_metadata() -> None:
    finish = Finish(
        finish_reason="stop",
        usage={"prompt_tokens": 3},
        provider_request_id="req-1",
    )

    assert finish.finish_reason == "stop"
    assert finish.usage == {"prompt_tokens": 3}
    assert finish.provider_request_id == "req-1"


def test_provider_error_carries_code_and_message() -> None:
    error = ProviderError(code="upstream_5xx", message="boom")

    assert error.code == "upstream_5xx"
    assert error.message == "boom"
    assert str(error) == "boom"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/providers/test_types.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.providers'`.

- [ ] **Step 3: Implement the types module**

`app/providers/types.py`:

```python
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal


ProviderRole = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class ProviderMessage:
    role: ProviderRole
    content: str


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class Finish:
    finish_reason: str
    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None


ProviderChunk = TextDelta | Finish


class ProviderError(Exception):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Provider(ABC):
    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]: ...
```

`app/providers/__init__.py`:

```python
from app.providers.types import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ProviderRole,
    TextDelta,
)

__all__ = [
    "Finish",
    "Provider",
    "ProviderChunk",
    "ProviderError",
    "ProviderMessage",
    "ProviderRole",
    "TextDelta",
]
```

`tests/providers/__init__.py`:

```python
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/providers/test_types.py -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/providers tests/providers
uv run mypy app/providers tests/providers
git add app/providers tests/providers
git commit -m "feat: add provider domain types and abc"
```

---

## Task 2: Fake Provider 测试夹具

**Files:**
- Create: `tests/providers/fake.py`
- Create: `tests/providers/test_fake.py`

- [ ] **Step 1: Write the failing test**

`tests/providers/test_fake.py`:

```python
import pytest

from app.providers import Finish, ProviderError, ProviderMessage, TextDelta
from tests.providers.fake import FakeProvider, RaiseError, Sleep


async def test_fake_provider_yields_scripted_chunks() -> None:
    provider = FakeProvider(
        script=[
            TextDelta(text="Hello"),
            TextDelta(text=" world"),
            Finish(finish_reason="stop"),
        ]
    )

    chunks = []
    async for chunk in provider.stream(
        model="fake-model",
        messages=[ProviderMessage(role="user", content="hi")],
    ):
        chunks.append(chunk)

    assert chunks == [
        TextDelta(text="Hello"),
        TextDelta(text=" world"),
        Finish(finish_reason="stop"),
    ]


async def test_fake_provider_raises_when_script_says_to() -> None:
    provider = FakeProvider(
        script=[RaiseError(code="boom", message="bad")],
    )

    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="fake-model",
            messages=[ProviderMessage(role="user", content="hi")],
        ):
            pass

    assert exc_info.value.code == "boom"


async def test_fake_provider_sleep_step_is_awaited(monkeypatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr("tests.providers.fake.asyncio.sleep", fake_sleep)

    provider = FakeProvider(
        script=[Sleep(seconds=0.5), Finish(finish_reason="stop")],
    )

    async for _ in provider.stream(
        model="fake-model",
        messages=[ProviderMessage(role="user", content="hi")],
    ):
        pass

    assert sleeps == [0.5]
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/providers/test_fake.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'tests.providers.fake'`.

- [ ] **Step 3: Implement the fake provider**

`tests/providers/fake.py`:

```python
import asyncio
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass

from app.providers import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    TextDelta,
)


@dataclass(frozen=True)
class RaiseError:
    code: str
    message: str


@dataclass(frozen=True)
class Sleep:
    seconds: float


ScriptItem = TextDelta | Finish | RaiseError | Sleep


class FakeProvider(Provider):
    def __init__(self, *, script: Sequence[ScriptItem], name: str = "fake") -> None:
        self._script = list(script)
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]:
        for item in self._script:
            if isinstance(item, RaiseError):
                raise ProviderError(code=item.code, message=item.message)
            if isinstance(item, Sleep):
                await asyncio.sleep(item.seconds)
                continue
            yield item
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/providers/test_fake.py -v
```

Expected: PASS (3 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check tests/providers
uv run mypy tests/providers
git add tests/providers/fake.py tests/providers/test_fake.py
git commit -m "test: add fake provider script harness"
```

---

## Task 3: Provider Registry

**Files:**
- Create: `app/providers/registry.py`
- Modify: `app/providers/__init__.py`
- Create: `tests/providers/test_registry.py`

- [ ] **Step 1: Write the failing test**

`tests/providers/test_registry.py`:

```python
import pytest

from app.core.config import get_settings
from app.providers import Provider
from app.providers.registry import UnknownProviderError, resolve_provider


def test_resolve_provider_returns_deepseek_for_known_name() -> None:
    provider = resolve_provider("deepseek", settings=get_settings())

    assert isinstance(provider, Provider)
    assert provider.name == "deepseek"


def test_resolve_provider_rejects_unknown_name() -> None:
    with pytest.raises(UnknownProviderError) as exc_info:
        resolve_provider("unknown-provider", settings=get_settings())

    assert "unknown-provider" in str(exc_info.value)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/providers/test_registry.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.providers.registry'`.

- [ ] **Step 3: Implement the registry with a placeholder DeepSeek stub**

The real DeepSeek implementation arrives in Task 13. For now, create a placeholder class so the registry has something concrete to return.

`app/providers/registry.py`:

```python
from app.core.config import Settings
from app.providers.deepseek import DeepSeekProvider
from app.providers.types import Provider


class UnknownProviderError(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown provider: {name}")
        self.name = name


def resolve_provider(name: str, *, settings: Settings) -> Provider:
    if name == "deepseek":
        return DeepSeekProvider(settings=settings)
    raise UnknownProviderError(name)
```

`app/providers/deepseek.py` (placeholder; replaced in Task 13):

```python
from collections.abc import AsyncIterator

from app.core.config import Settings
from app.providers.types import Provider, ProviderChunk, ProviderMessage


class DeepSeekProvider(Provider):
    def __init__(self, *, settings: Settings) -> None:
        self._settings = settings

    @property
    def name(self) -> str:
        return "deepseek"

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]:
        raise NotImplementedError("DeepSeek streaming is implemented in a later task")
        yield  # pragma: no cover  # keeps function an async generator for typing
```

`app/providers/__init__.py` (add exports):

```python
from app.providers.registry import UnknownProviderError, resolve_provider
from app.providers.types import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
    ProviderRole,
    TextDelta,
)

__all__ = [
    "Finish",
    "Provider",
    "ProviderChunk",
    "ProviderError",
    "ProviderMessage",
    "ProviderRole",
    "TextDelta",
    "UnknownProviderError",
    "resolve_provider",
]
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/providers/test_registry.py -v
```

Expected: PASS (2 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/providers tests/providers
uv run mypy app/providers tests/providers
git add app/providers tests/providers/test_registry.py
git commit -m "feat: add provider registry with deepseek placeholder"
```

---

## Task 4: Context Builder

**Files:**
- Create: `app/context/__init__.py`
- Create: `app/context/builder.py`
- Create: `tests/context/__init__.py`
- Create: `tests/context/test_builder.py`

- [ ] **Step 1: Write the failing test**

`tests/context/test_builder.py`:

```python
import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.context import build_context
from app.models.conversation import Conversation, Message
from app.models.run import Run
from app.models.user import User
from app.providers import ProviderMessage

TEST_DATABASE_URL = os.environ.get(
    "CONTEXT_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "context-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def create_user(session: AsyncSession, name: str) -> User:
    suffix = uuid4().hex
    user = User(
        username=f"{name}-{suffix}",
        email=f"{name}-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hashed-password",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def add_message(
    session: AsyncSession,
    *,
    conversation_id: int,
    role: str,
    content: str,
    position: int,
    archived: bool = False,
) -> Message:
    message = Message(
        conversation_id=conversation_id,
        role=role,
        content=content,
        position=position,
    )
    if archived:
        from datetime import UTC, datetime
        message.archived_at = datetime.now(UTC)
    session.add(message)
    await session.flush()
    return message


async def create_run_for_message(
    session: AsyncSession,
    *,
    conversation_id: int,
    user_message_id: int,
) -> Run:
    run = Run(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        status="queued",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    return run


async def test_build_context_includes_system_prompt_and_history_up_to_target(
    session_factory,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "ctx-history")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="first user",
            position=1,
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="first assistant",
            position=2,
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="second user",
            position=3,
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="future assistant (must be excluded)",
            position=4,
        )
        run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        messages = await build_context(
            session,
            run_id=run.id,
            system_prompt="Be brief.",
            budget_chars=10_000,
        )

    assert [m.role for m in messages] == ["system", "user", "assistant", "user"]
    assert [m.content for m in messages] == [
        "Be brief.",
        "first user",
        "first assistant",
        "second user",
    ]


async def test_build_context_skips_archived_messages(session_factory) -> None:
    async with session_factory() as session:
        user = await create_user(session, "ctx-archived")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="archived user",
            position=1,
            archived=True,
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="kept user",
            position=2,
        )
        run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        messages = await build_context(
            session,
            run_id=run.id,
            system_prompt="Be brief.",
            budget_chars=10_000,
        )

    assert [m.content for m in messages] == ["Be brief.", "kept user"]


async def test_build_context_truncates_oldest_history_when_over_budget(
    session_factory,
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "ctx-budget")
        conversation = Conversation(user_id=user.id, title="Chat")
        session.add(conversation)
        await session.flush()

        await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="oldest" * 50,
            position=1,
        )
        await add_message(
            session,
            conversation_id=conversation.id,
            role="assistant",
            content="middle" * 50,
            position=2,
        )
        target_user = await add_message(
            session,
            conversation_id=conversation.id,
            role="user",
            content="newest" * 5,
            position=3,
        )
        run = await create_run_for_message(
            session,
            conversation_id=conversation.id,
            user_message_id=target_user.id,
        )
        await session.commit()

        messages = await build_context(
            session,
            run_id=run.id,
            system_prompt="sys",
            budget_chars=100,
        )

    assert messages[0] == ProviderMessage(role="system", content="sys")
    assert messages[-1].content == "newest" * 5
    assert all(m.content != "oldest" * 50 for m in messages)


async def test_build_context_raises_when_run_missing(session_factory) -> None:
    async with session_factory() as session:
        with pytest.raises(LookupError):
            await build_context(
                session,
                run_id=999_999_999,
                system_prompt="sys",
                budget_chars=1000,
            )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/context/test_builder.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.context'`.

- [ ] **Step 3: Implement the context builder**

`app/context/__init__.py`:

```python
from app.context.builder import build_context

__all__ = ["build_context"]
```

`app/context/builder.py`:

```python
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message
from app.models.run import Run
from app.providers import ProviderMessage, ProviderRole


async def build_context(
    session: AsyncSession,
    *,
    run_id: int,
    system_prompt: str,
    budget_chars: int,
) -> list[ProviderMessage]:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    target = await session.get(Message, run.user_message_id)
    if target is None:
        raise LookupError(f"Target user message {run.user_message_id} not found")

    history_rows = (
        await session.scalars(
            select(Message)
            .where(
                Message.conversation_id == run.conversation_id,
                Message.archived_at.is_(None),
                Message.position <= target.position,
            )
            .order_by(Message.position.asc())
        )
    ).all()

    history: list[ProviderMessage] = [
        ProviderMessage(role=_normalize_role(row.role), content=row.content)
        for row in history_rows
    ]
    trimmed = _trim_to_budget(history, budget_chars=budget_chars)
    return [ProviderMessage(role="system", content=system_prompt), *trimmed]


def _normalize_role(role: str) -> ProviderRole:
    if role == "user":
        return "user"
    if role == "assistant":
        return "assistant"
    raise ValueError(f"Unsupported message role: {role}")


def _trim_to_budget(
    messages: list[ProviderMessage],
    *,
    budget_chars: int,
) -> list[ProviderMessage]:
    total = sum(len(m.content) for m in messages)
    while messages and total > budget_chars and len(messages) > 1:
        dropped = messages.pop(0)
        total -= len(dropped.content)
    return messages
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/context/test_builder.py -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/context tests/context
uv run mypy app/context tests/context
git add app/context tests/context
git commit -m "feat: add context builder"
```

---

## Task 5: Runs Lifecycle — Claim 和状态转换

**Files:**
- Create: `app/services/runs/lifecycle.py`
- Modify: `app/services/runs/__init__.py`
- Create: `tests/services/runs/test_lifecycle.py`

- [ ] **Step 1: Write the failing test**

`tests/services/runs/test_lifecycle.py`:

```python
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    is_cancelling,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    renew_lease,
    run_has_text_delta,
)

TEST_DATABASE_URL = os.environ.get(
    "RUN_LIFECYCLE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "run-lifecycle-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def make_run(session: AsyncSession, *, status_value: str = "queued") -> Run:
    suffix = uuid4().hex
    user = User(
        username=f"life-{suffix}",
        email=f"life-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status=status_value,
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    return run


async def test_claim_next_queued_run_moves_run_to_started_and_writes_run_started_event(
    session_factory,
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        await session.commit()
        run_id = run.id

    async with session_factory() as session:
        claimed_id = await claim_next_queued_run(
            session,
            worker_id="worker-a",
            lease_seconds=60,
        )
        await session.commit()

    assert claimed_id == run_id

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "started"
        assert updated.lease_owner == "worker-a"
        assert updated.lease_expires_at is not None
        assert updated.started_at is not None
        assert updated.heartbeat_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == ["run_started"]


async def test_claim_next_queued_run_returns_none_when_nothing_queued(session_factory) -> None:
    async with session_factory() as session:
        claimed_id = await claim_next_queued_run(
            session,
            worker_id="worker-a",
            lease_seconds=60,
        )
        await session.commit()

    assert claimed_id is None


async def test_concurrent_claims_only_one_winner(session_factory) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        await session.commit()
        run_id = run.id

    async with session_factory() as session_a, session_factory() as session_b:
        claimed_a = await claim_next_queued_run(
            session_a,
            worker_id="worker-a",
            lease_seconds=60,
        )
        claimed_b = await claim_next_queued_run(
            session_b,
            worker_id="worker-b",
            lease_seconds=60,
        )
        await session_a.commit()
        await session_b.commit()

    assert {claimed_a, claimed_b} == {run_id, None}


async def test_mark_run_streaming_sets_status_and_first_streamed_at(session_factory) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="started")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        await mark_run_streaming(session, run_id=run_id)
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "streaming"
        assert updated.first_streamed_at is not None


async def test_mark_run_succeeded_writes_terminal_event_and_clears_lease(session_factory) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run.lease_owner = "worker-a"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        await mark_run_succeeded(
            session,
            run_id=run_id,
            usage={"prompt_tokens": 5},
            provider_request_id="req-1",
        )
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "succeeded"
        assert updated.lease_owner is None
        assert updated.lease_expires_at is None
        assert updated.completed_at is not None
        assert updated.usage_metadata == {"prompt_tokens": 5}
        assert updated.provider_request_id == "req-1"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_succeeded"
        assert events[-1].payload == {"usage": {"prompt_tokens": 5}}


async def test_mark_run_failed_writes_terminal_event_and_records_error(session_factory) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run.lease_owner = "worker-a"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        await mark_run_failed(
            session,
            run_id=run_id,
            code="upstream_5xx",
            message="bad upstream",
        )
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.status == "failed"
        assert updated.error_code == "upstream_5xx"
        assert updated.error_message == "bad upstream"
        assert updated.failed_at is not None
        assert updated.lease_owner is None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_failed"
        assert events[-1].payload == {"code": "upstream_5xx", "message": "bad upstream"}


async def test_renew_lease_extends_expiry_and_heartbeat(session_factory) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run.lease_owner = "worker-a"
        run.lease_expires_at = datetime.now(UTC) + timedelta(seconds=5)
        run.heartbeat_at = datetime.now(UTC)
        run_id = run.id
        original_expiry = run.lease_expires_at
        await session.commit()

    async with session_factory() as session:
        await renew_lease(session, run_id=run_id, lease_seconds=120)
        await session.commit()

    async with session_factory() as session:
        updated = await session.get(Run, run_id)
        assert updated is not None
        assert updated.lease_expires_at is not None
        assert updated.lease_expires_at > original_expiry


async def test_is_cancelling_reflects_status(session_factory) -> None:
    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        assert await is_cancelling(session, run_id=run_id) is False
        updated = await session.get(Run, run_id)
        assert updated is not None
        updated.status = "cancelling"
        await session.commit()

    async with session_factory() as session:
        assert await is_cancelling(session, run_id=run_id) is True


async def test_run_has_text_delta_detects_persisted_deltas(session_factory) -> None:
    from app.services.runs.service import append_run_event

    async with session_factory() as session:
        run = await make_run(session, status_value="streaming")
        run_id = run.id
        await session.commit()

    async with session_factory() as session:
        assert await run_has_text_delta(session, run_id=run_id) is False
        await append_run_event(
            session,
            run_id=run_id,
            event_type="text_delta",
            payload={"text": "hi"},
        )
        await session.commit()
        assert await run_has_text_delta(session, run_id=run_id) is True
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/services/runs/test_lifecycle.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.runs.lifecycle'`.

- [ ] **Step 3: Implement the lifecycle module**

`app/services/runs/lifecycle.py`:

```python
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.run import Run, RunEvent
from app.services.runs.service import append_run_event


async def claim_next_queued_run(
    session: AsyncSession,
    *,
    worker_id: str,
    lease_seconds: int,
) -> int | None:
    run = await session.scalar(
        select(Run)
        .where(Run.status == "queued")
        .order_by(Run.created_at.asc(), Run.id.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if run is None:
        return None

    now = datetime.now(UTC)
    run.status = "started"
    run.lease_owner = worker_id
    run.lease_expires_at = now + timedelta(seconds=lease_seconds)
    run.heartbeat_at = now
    run.started_at = now
    await session.flush()
    await append_run_event(
        session,
        run_id=run.id,
        event_type="run_started",
        payload={},
    )
    return run.id


async def mark_run_streaming(session: AsyncSession, *, run_id: int) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    now = datetime.now(UTC)
    run.status = "streaming"
    if run.first_streamed_at is None:
        run.first_streamed_at = now
    await session.flush()


async def mark_run_succeeded(
    session: AsyncSession,
    *,
    run_id: int,
    usage: dict[str, Any] | None,
    provider_request_id: str | None,
) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    now = datetime.now(UTC)
    run.status = "succeeded"
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    run.usage_metadata = usage
    run.provider_request_id = provider_request_id
    await session.flush()
    await append_run_event(
        session,
        run_id=run_id,
        event_type="run_succeeded",
        payload={"usage": usage} if usage is not None else {},
    )


async def mark_run_failed(
    session: AsyncSession,
    *,
    run_id: int,
    code: str,
    message: str,
) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    now = datetime.now(UTC)
    run.status = "failed"
    run.failed_at = now
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    run.error_code = code
    run.error_message = message
    await session.flush()
    await append_run_event(
        session,
        run_id=run_id,
        event_type="run_failed",
        payload={"code": code, "message": message},
    )


async def mark_run_cancelled(session: AsyncSession, *, run_id: int) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    now = datetime.now(UTC)
    run.status = "cancelled"
    run.cancelled_at = now
    run.completed_at = now
    run.lease_owner = None
    run.lease_expires_at = None
    await session.flush()
    await append_run_event(
        session,
        run_id=run_id,
        event_type="run_cancelled",
        payload={},
    )


async def renew_lease(
    session: AsyncSession,
    *,
    run_id: int,
    lease_seconds: int,
) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")
    now = datetime.now(UTC)
    run.lease_expires_at = now + timedelta(seconds=lease_seconds)
    run.heartbeat_at = now
    await session.flush()


async def is_cancelling(session: AsyncSession, *, run_id: int) -> bool:
    status = await session.scalar(select(Run.status).where(Run.id == run_id))
    return status == "cancelling"


async def run_has_text_delta(session: AsyncSession, *, run_id: int) -> bool:
    event_id = await session.scalar(
        select(RunEvent.id)
        .where(RunEvent.run_id == run_id, RunEvent.type == "text_delta")
        .limit(1)
    )
    return event_id is not None
```

`app/services/runs/__init__.py` (add exports):

```python
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    is_cancelling,
    mark_run_cancelled,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    renew_lease,
    run_has_text_delta,
)
from app.services.runs.service import (
    RUN_NOT_FOUND_MESSAGE,
    TERMINAL_EVENT_TYPES,
    append_run_event,
    get_owned_run_state,
    get_owned_visible_run,
    list_owned_run_events_after,
    list_run_events_after,
    run_has_terminal_event,
)

__all__ = [
    "RUN_NOT_FOUND_MESSAGE",
    "TERMINAL_EVENT_TYPES",
    "append_run_event",
    "claim_next_queued_run",
    "get_owned_run_state",
    "get_owned_visible_run",
    "is_cancelling",
    "list_owned_run_events_after",
    "list_run_events_after",
    "mark_run_cancelled",
    "mark_run_failed",
    "mark_run_streaming",
    "mark_run_succeeded",
    "renew_lease",
    "run_has_terminal_event",
    "run_has_text_delta",
]
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/services/runs/test_lifecycle.py -v
```

Expected: PASS (9 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/services/runs tests/services/runs
uv run mypy app/services/runs tests/services/runs
git add app/services/runs tests/services/runs/test_lifecycle.py
git commit -m "feat: add run lifecycle service for worker"
```

---

## Task 6: Runs Lifecycle — Recovery

**Files:**
- Modify: `app/services/runs/lifecycle.py`
- Modify: `app/services/runs/__init__.py`
- Modify: `tests/services/runs/test_lifecycle.py`

- [ ] **Step 1: Write the failing test (append to test_lifecycle.py)**

Append to `tests/services/runs/test_lifecycle.py`:

```python
from app.services.runs.lifecycle import recover_expired_runs


async def test_recover_expired_runs_marks_lease_expired_runs_failed(session_factory) -> None:
    async with session_factory() as session:
        expired = await make_run(session, status_value="streaming")
        expired.lease_owner = "worker-dead"
        expired.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
        live = await make_run(session, status_value="streaming")
        live.lease_owner = "worker-live"
        live.lease_expires_at = datetime.now(UTC) + timedelta(seconds=60)
        expired_id = expired.id
        live_id = live.id
        await session.commit()

    async with session_factory() as session:
        recovered_ids = await recover_expired_runs(session)
        await session.commit()

    assert recovered_ids == [expired_id]

    async with session_factory() as session:
        expired_after = await session.get(Run, expired_id)
        live_after = await session.get(Run, live_id)
        assert expired_after is not None
        assert live_after is not None
        assert expired_after.status == "failed"
        assert expired_after.error_code == "lease_expired"
        assert live_after.status == "streaming"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == expired_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_failed"
        assert events[-1].payload == {
            "code": "lease_expired",
            "message": "worker lease expired",
        }


async def test_recover_expired_runs_skips_terminal_runs(session_factory) -> None:
    async with session_factory() as session:
        finished = await make_run(session, status_value="succeeded")
        finished.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
        finished_id = finished.id
        await session.commit()

    async with session_factory() as session:
        recovered_ids = await recover_expired_runs(session)
        await session.commit()

    assert recovered_ids == []

    async with session_factory() as session:
        still_finished = await session.get(Run, finished_id)
        assert still_finished is not None
        assert still_finished.status == "succeeded"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/services/runs/test_lifecycle.py -v -k recover
```

Expected: FAIL with `ImportError: cannot import name 'recover_expired_runs'`.

- [ ] **Step 3: Implement recovery**

Append to `app/services/runs/lifecycle.py`:

```python
ACTIVE_STATUSES_FOR_RECOVERY = ("started", "streaming", "cancelling")


async def recover_expired_runs(session: AsyncSession) -> list[int]:
    now = datetime.now(UTC)
    candidate_ids = (
        await session.scalars(
            select(Run.id)
            .where(
                Run.status.in_(ACTIVE_STATUSES_FOR_RECOVERY),
                Run.lease_expires_at.is_not(None),
                Run.lease_expires_at < now,
            )
            .with_for_update(skip_locked=True)
        )
    ).all()

    recovered: list[int] = []
    for run_id in candidate_ids:
        await mark_run_failed(
            session,
            run_id=run_id,
            code="lease_expired",
            message="worker lease expired",
        )
        recovered.append(run_id)
    return recovered
```

Update `app/services/runs/__init__.py` exports:

```python
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    is_cancelling,
    mark_run_cancelled,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    recover_expired_runs,
    renew_lease,
    run_has_text_delta,
)
```

And add `"recover_expired_runs"` to `__all__`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/services/runs/test_lifecycle.py -v
```

Expected: PASS (11 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/services/runs tests/services/runs
uv run mypy app/services/runs tests/services/runs
git add app/services/runs tests/services/runs/test_lifecycle.py
git commit -m "feat: add expired run recovery"
```

---

## Task 7: Materialize Assistant Message

**Files:**
- Modify: `app/services/conversations/service.py`
- Modify: `app/services/conversations/__init__.py`
- Create: `tests/services/conversations/test_materialize.py`

- [ ] **Step 1: Write the failing test**

`tests/services/conversations/test_materialize.py`:

```python
import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.services.conversations import materialize_assistant_message

TEST_DATABASE_URL = os.environ.get(
    "MATERIALIZE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "materialize-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def make_run(session: AsyncSession) -> Run:
    suffix = uuid4().hex
    user = User(
        username=f"mat-{suffix}",
        email=f"mat-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="streaming",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await session.flush()
    return run


async def test_materialize_assistant_message_appends_assistant_with_run_link(
    session_factory,
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        run_id = run.id
        conversation_id = run.conversation_id
        await session.commit()

    async with session_factory() as session:
        message = await materialize_assistant_message(
            session,
            run_id=run_id,
            content="Hi there",
        )
        await session.commit()
        message_id = message.id

    async with session_factory() as session:
        saved = await session.get(Message, message_id)
        assert saved is not None
        assert saved.role == "assistant"
        assert saved.content == "Hi there"
        assert saved.run_id == run_id
        assert saved.conversation_id == conversation_id
        assert saved.position == 2


async def test_materialize_assistant_message_rejects_unknown_run(session_factory) -> None:
    async with session_factory() as session:
        with pytest.raises(LookupError):
            await materialize_assistant_message(
                session,
                run_id=999_999_999,
                content="hi",
            )
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/services/conversations/test_materialize.py -v
```

Expected: FAIL with `ImportError: cannot import name 'materialize_assistant_message'`.

- [ ] **Step 3: Implement materialization**

Append to `app/services/conversations/service.py`:

```python
async def materialize_assistant_message(
    session: AsyncSession,
    *,
    run_id: int,
    content: str,
) -> Message:
    run = await session.get(Run, run_id)
    if run is None:
        raise LookupError(f"Run {run_id} not found")

    next_position = await get_next_message_position(
        session,
        conversation_id=run.conversation_id,
    )
    message = Message(
        conversation_id=run.conversation_id,
        run_id=run.id,
        role="assistant",
        content=content,
        position=next_position,
    )
    session.add(message)
    await session.flush()

    conversation = await session.get(Conversation, run.conversation_id)
    if conversation is not None:
        conversation.updated_at = await get_database_now(session)
        await session.flush()
    return message
```

Update `app/services/conversations/__init__.py`:

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    get_conversation_detail,
    list_conversations,
    materialize_assistant_message,
    rename_conversation,
    submit_user_message,
)

__all__ = [
    "create_conversation",
    "delete_conversation",
    "get_conversation_detail",
    "list_conversations",
    "materialize_assistant_message",
    "rename_conversation",
    "submit_user_message",
]
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/services/conversations/test_materialize.py -v
```

Expected: PASS (2 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/services/conversations tests/services/conversations
uv run mypy app/services/conversations tests/services/conversations
git add app/services/conversations tests/services/conversations/test_materialize.py
git commit -m "feat: materialize assistant message on run success"
```

---

## Task 8: Worker Executor — 成功路径

**Files:**
- Create: `app/worker/__init__.py`
- Create: `app/worker/executor.py`
- Create: `tests/worker/__init__.py`
- Create: `tests/worker/test_executor.py`

- [ ] **Step 1: Write the failing test**

`tests/worker/test_executor.py`:

```python
import os
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Finish, Provider, TextDelta
from app.services.runs.lifecycle import claim_next_queued_run
from app.worker.executor import execute_run
from tests.providers.fake import FakeProvider

TEST_DATABASE_URL = os.environ.get(
    "WORKER_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "worker-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


@pytest.fixture()
def settings() -> Settings:
    return get_settings()


async def queue_run(session: AsyncSession, provider_name: str = "fake") -> int:
    suffix = uuid4().hex
    user = User(
        username=f"exec-{suffix}",
        email=f"exec-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="queued",
        provider_name=provider_name,
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await session.flush()
    return run.id


def make_resolver(provider: Provider):
    def resolve(name: str, *, settings: Settings) -> Provider:
        return provider
    return resolve


async def test_execute_run_streams_deltas_marks_succeeded_and_materializes_message(
    session_factory,
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        claimed = await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()
        assert claimed == run_id

    fake = FakeProvider(
        script=[
            TextDelta(text="Hello"),
            TextDelta(text=" world"),
            Finish(
                finish_reason="stop",
                usage={"prompt_tokens": 4, "completion_tokens": 2},
                provider_request_id="req-1",
            ),
        ]
    )

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "succeeded"
        assert run.lease_owner is None
        assert run.completed_at is not None
        assert run.usage_metadata == {"prompt_tokens": 4, "completion_tokens": 2}
        assert run.provider_request_id == "req-1"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == [
            "run_started",
            "text_delta",
            "text_delta",
            "run_succeeded",
        ]
        assert events[1].payload == {"text": "Hello"}
        assert events[2].payload == {"text": " world"}

        messages = (
            await session.scalars(
                select(Message)
                .where(Message.conversation_id == run.conversation_id)
                .order_by(Message.position.asc())
            )
        ).all()
        assert [m.role for m in messages] == ["user", "assistant"]
        assert messages[1].content == "Hello world"
        assert messages[1].run_id == run_id
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.worker'`.

- [ ] **Step 3: Implement the executor (happy path only)**

`app/worker/__init__.py`:

```python
from app.worker.executor import execute_run

__all__ = ["execute_run"]
```

`app/worker/executor.py`:

```python
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.context import build_context
from app.core.config import Settings
from app.core.logging import logger
from app.models.run import Run
from app.providers import Finish, Provider, ProviderError, TextDelta
from app.services.conversations import materialize_assistant_message
from app.services.runs.lifecycle import (
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
)
from app.services.runs.service import append_run_event


class ProviderResolver(Protocol):
    def __call__(self, name: str, *, settings: Settings) -> Provider: ...


async def execute_run(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> None:
    run_logger = logger.bind(run_id=run_id, worker_id=worker_id)

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            run_logger.warning("Run vanished before execution")
            return
        try:
            messages = await build_context(
                session,
                run_id=run_id,
                system_prompt=settings.default_system_prompt,
                budget_chars=_context_budget_chars(),
            )
        except Exception as exc:
            run_logger.exception("Context build failed")
            await mark_run_failed(
                session,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
            )
            await session.commit()
            return
        provider_name = run.provider_name
        provider_model = run.provider_model
        await session.commit()

    provider = resolve_provider(provider_name, settings=settings)

    text_parts: list[str] = []
    first_delta_seen = False

    try:
        async for chunk in provider.stream(model=provider_model, messages=messages):
            if isinstance(chunk, TextDelta):
                async with session_factory() as session:
                    if not first_delta_seen:
                        await mark_run_streaming(session, run_id=run_id)
                        first_delta_seen = True
                    await append_run_event(
                        session,
                        run_id=run_id,
                        event_type="text_delta",
                        payload={"text": chunk.text},
                    )
                    await session.commit()
                text_parts.append(chunk.text)
            elif isinstance(chunk, Finish):
                full_text = "".join(text_parts)
                async with session_factory() as session:
                    await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    await materialize_assistant_message(
                        session,
                        run_id=run_id,
                        content=full_text,
                    )
                    await session.commit()
                return
    except ProviderError as exc:
        run_logger.bind(code=exc.code).warning("Provider error: %s", exc.message)
        async with session_factory() as session:
            await mark_run_failed(
                session,
                run_id=run_id,
                code=exc.code,
                message=exc.message,
            )
            await session.commit()
        return

    async with session_factory() as session:
        await mark_run_failed(
            session,
            run_id=run_id,
            code="no_finish",
            message="Provider stream ended without finish chunk",
        )
        await session.commit()


def _context_budget_chars() -> int:
    return 16_000
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: PASS (1 test).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/worker tests/worker
uv run mypy app/worker tests/worker
git add app/worker tests/worker
git commit -m "feat: add worker executor happy path"
```

---

## Task 9: Worker Executor — 失败和重试

**Files:**
- Modify: `app/worker/executor.py`
- Modify: `tests/worker/test_executor.py`

- [ ] **Step 1: Write the failing tests (append to test_executor.py)**

Add `ProviderError` to the existing `app.providers` import at the top of the file, and add `RaiseError` to the existing `tests.providers.fake` import:

```python
from app.providers import Finish, Provider, ProviderError, TextDelta
from tests.providers.fake import FakeProvider, RaiseError
```

Then append:

```python
async def test_execute_run_retries_once_when_provider_fails_before_any_delta(
    session_factory,
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    call_count = {"n": 0}

    class FlakyProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(self, *, model, messages):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise ProviderError(code="transient", message="first attempt")
            yield TextDelta(text="Recovered")
            yield Finish(finish_reason="stop")

    provider = FlakyProvider()

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    assert call_count["n"] == 2

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "succeeded"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == [
            "run_started",
            "text_delta",
            "run_succeeded",
        ]


async def test_execute_run_does_not_retry_after_persisted_delta(
    session_factory,
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    fake = FakeProvider(
        script=[
            TextDelta(text="partial"),
            RaiseError(code="upstream_5xx", message="boom mid-stream"),
        ]
    )

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "upstream_5xx"

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert [e.type for e in events] == [
            "run_started",
            "text_delta",
            "run_failed",
        ]
        assert events[1].payload == {"text": "partial"}

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        roles = [m.role for m in messages]
        assert "assistant" not in roles


async def test_execute_run_does_not_retry_after_two_pre_delta_failures(
    session_factory,
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    call_count = {"n": 0}

    class AlwaysFailProvider(Provider):
        @property
        def name(self) -> str:
            return "fake"

        async def stream(self, *, model, messages):
            call_count["n"] += 1
            raise ProviderError(code="dead", message=f"attempt {call_count['n']}")
            yield  # pragma: no cover

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=settings,
        resolve_provider=make_resolver(AlwaysFailProvider()),
    )

    assert call_count["n"] == 2

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "dead"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: the two new retry tests FAIL (no retry logic yet), happy path still PASSes.

- [ ] **Step 3: Implement retry-once logic**

Replace the body of `execute_run` in `app/worker/executor.py` with a retry-aware loop. First add the new imports at the top of the file (next to existing imports):

```python
from dataclasses import dataclass

from app.services.runs.lifecycle import (
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    run_has_text_delta,
)
```

Then replace `execute_run` and add the helper:

```python
async def execute_run(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> None:
    run_logger = logger.bind(run_id=run_id, worker_id=worker_id)

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            run_logger.warning("Run vanished before execution")
            return
        try:
            messages = await build_context(
                session,
                run_id=run_id,
                system_prompt=settings.default_system_prompt,
                budget_chars=_context_budget_chars(),
            )
        except Exception as exc:
            run_logger.exception("Context build failed")
            await mark_run_failed(
                session,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
            )
            await session.commit()
            return
        provider_name = run.provider_name
        provider_model = run.provider_model
        await session.commit()

    provider = resolve_provider(provider_name, settings=settings)

    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        outcome = await _run_provider_stream(
            session_factory=session_factory,
            run_id=run_id,
            provider=provider,
            provider_model=provider_model,
            messages=messages,
        )
        if outcome.status == "succeeded":
            return
        if outcome.status == "failed":
            allow_retry = (
                outcome.before_first_delta
                and attempt < max_attempts
                and not outcome.delta_persisted
            )
            if allow_retry:
                run_logger.bind(code=outcome.code).info("Retrying provider stream once")
                continue
            async with session_factory() as session:
                await mark_run_failed(
                    session,
                    run_id=run_id,
                    code=outcome.code or "unknown_error",
                    message=outcome.message or "",
                )
                await session.commit()
            return


@dataclass
class _StreamOutcome:
    status: str  # "succeeded" | "failed"
    before_first_delta: bool
    delta_persisted: bool
    code: str | None = None
    message: str | None = None


async def _run_provider_stream(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages,
) -> _StreamOutcome:
    text_parts: list[str] = []
    first_delta_seen = False

    try:
        async for chunk in provider.stream(model=provider_model, messages=messages):
            if isinstance(chunk, TextDelta):
                async with session_factory() as session:
                    if not first_delta_seen:
                        await mark_run_streaming(session, run_id=run_id)
                        first_delta_seen = True
                    await append_run_event(
                        session,
                        run_id=run_id,
                        event_type="text_delta",
                        payload={"text": chunk.text},
                    )
                    await session.commit()
                text_parts.append(chunk.text)
            elif isinstance(chunk, Finish):
                full_text = "".join(text_parts)
                async with session_factory() as session:
                    await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    await materialize_assistant_message(
                        session,
                        run_id=run_id,
                        content=full_text,
                    )
                    await session.commit()
                return _StreamOutcome(
                    status="succeeded",
                    before_first_delta=not first_delta_seen,
                    delta_persisted=first_delta_seen,
                )
    except ProviderError as exc:
        async with session_factory() as session:
            delta_persisted = await run_has_text_delta(session, run_id=run_id)
        return _StreamOutcome(
            status="failed",
            before_first_delta=not first_delta_seen,
            delta_persisted=delta_persisted,
            code=exc.code,
            message=exc.message,
        )

    async with session_factory() as session:
        delta_persisted = await run_has_text_delta(session, run_id=run_id)
    return _StreamOutcome(
        status="failed",
        before_first_delta=not first_delta_seen,
        delta_persisted=delta_persisted,
        code="no_finish",
        message="Provider stream ended without finish chunk",
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/worker tests/worker
uv run mypy app/worker tests/worker
git add app/worker/executor.py tests/worker/test_executor.py
git commit -m "feat: retry provider stream once before first delta"
```

---

## Task 10: Worker Executor — Heartbeat 和取消

**Files:**
- Modify: `app/worker/executor.py`
- Modify: `tests/worker/test_executor.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/worker/test_executor.py`. First add these imports at the top of the file (next to existing imports):

```python
import asyncio
from datetime import timedelta

from tests.providers.fake import Sleep
```

Then append:

```python


async def test_execute_run_marks_cancelled_when_status_flips_during_stream(
    session_factory,
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()

    fake = FakeProvider(
        script=[
            TextDelta(text="part one"),
            Sleep(seconds=0.5),
            TextDelta(text="part two"),
            Sleep(seconds=0.5),
            Finish(finish_reason="stop"),
        ]
    )

    cancel_settings = settings.model_copy(update={"worker_heartbeat_interval_seconds": 0.05})

    async def flip_to_cancelling() -> None:
        await asyncio.sleep(0.2)
        async with session_factory() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            run.status = "cancelling"
            await session.commit()

    flip_task = asyncio.create_task(flip_to_cancelling())
    try:
        await execute_run(
            session_factory=session_factory,
            run_id=run_id,
            worker_id="worker-x",
            settings=cancel_settings,
            resolve_provider=make_resolver(fake),
        )
    finally:
        await flip_task

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "cancelled"
        assert run.cancelled_at is not None

        events = (
            await session.scalars(
                select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.seq.asc())
            )
        ).all()
        assert events[-1].type == "run_cancelled"

        messages = (
            await session.scalars(
                select(Message).where(Message.conversation_id == run.conversation_id)
            )
        ).all()
        roles = [m.role for m in messages]
        assert "assistant" not in roles


async def test_execute_run_renews_lease_during_long_stream(
    session_factory,
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await queue_run(session)
        await session.commit()

    async with session_factory() as session:
        await claim_next_queued_run(
            session,
            worker_id="worker-x",
            lease_seconds=settings.run_lease_seconds,
        )
        await session.commit()
        async with session_factory() as session2:
            run = await session2.get(Run, run_id)
            assert run is not None
            original_expiry = run.lease_expires_at

    fake = FakeProvider(
        script=[
            TextDelta(text="hi"),
            Sleep(seconds=0.3),
            Finish(finish_reason="stop"),
        ]
    )
    fast_settings = settings.model_copy(update={"worker_heartbeat_interval_seconds": 0.05})

    await execute_run(
        session_factory=session_factory,
        run_id=run_id,
        worker_id="worker-x",
        settings=fast_settings,
        resolve_provider=make_resolver(fake),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        assert run.status == "succeeded"
        assert run.heartbeat_at is not None
        assert original_expiry is not None
        assert run.heartbeat_at >= original_expiry - timedelta(seconds=settings.run_lease_seconds)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/worker/test_executor.py -v -k cancel_or_renew
```

Or simply:

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: the two new tests FAIL (cancellation not detected, lease not renewed).

- [ ] **Step 3: Implement heartbeat + cancellation**

In `app/worker/executor.py`:

1. Add imports near the top:

```python
import asyncio
import contextlib

from app.services.runs.lifecycle import (
    is_cancelling,
    mark_run_cancelled,
    mark_run_failed,
    mark_run_streaming,
    mark_run_succeeded,
    renew_lease,
    run_has_text_delta,
)
```

2. Add a heartbeat coroutine:

```python
async def _heartbeat_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    lease_seconds: int,
    interval_seconds: float,
    cancel_event: asyncio.Event,
) -> None:
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            async with session_factory() as session:
                await renew_lease(session, run_id=run_id, lease_seconds=lease_seconds)
                cancelling = await is_cancelling(session, run_id=run_id)
                await session.commit()
            if cancelling:
                cancel_event.set()
                return
        except asyncio.CancelledError:
            return
```

3. Update `_run_provider_stream` to accept and honor `cancel_event`. After each chunk's persistence, check the event:

```python
async def _run_provider_stream(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    provider: Provider,
    provider_model: str,
    messages,
    cancel_event: asyncio.Event,
) -> _StreamOutcome:
    text_parts: list[str] = []
    first_delta_seen = False

    try:
        async for chunk in provider.stream(model=provider_model, messages=messages):
            if cancel_event.is_set():
                return _StreamOutcome(
                    status="cancelled",
                    before_first_delta=not first_delta_seen,
                    delta_persisted=first_delta_seen,
                )
            if isinstance(chunk, TextDelta):
                async with session_factory() as session:
                    if not first_delta_seen:
                        await mark_run_streaming(session, run_id=run_id)
                        first_delta_seen = True
                    await append_run_event(
                        session,
                        run_id=run_id,
                        event_type="text_delta",
                        payload={"text": chunk.text},
                    )
                    await session.commit()
                text_parts.append(chunk.text)
                if cancel_event.is_set():
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=False,
                        delta_persisted=True,
                    )
            elif isinstance(chunk, Finish):
                full_text = "".join(text_parts)
                async with session_factory() as session:
                    await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    await materialize_assistant_message(
                        session,
                        run_id=run_id,
                        content=full_text,
                    )
                    await session.commit()
                return _StreamOutcome(
                    status="succeeded",
                    before_first_delta=not first_delta_seen,
                    delta_persisted=first_delta_seen,
                )
    except ProviderError as exc:
        async with session_factory() as session:
            delta_persisted = await run_has_text_delta(session, run_id=run_id)
        return _StreamOutcome(
            status="failed",
            before_first_delta=not first_delta_seen,
            delta_persisted=delta_persisted,
            code=exc.code,
            message=exc.message,
        )

    async with session_factory() as session:
        delta_persisted = await run_has_text_delta(session, run_id=run_id)
    return _StreamOutcome(
        status="failed",
        before_first_delta=not first_delta_seen,
        delta_persisted=delta_persisted,
        code="no_finish",
        message="Provider stream ended without finish chunk",
    )
```

4. Extend `_StreamOutcome.status` to include `"cancelled"` (no schema change needed, just a string value).

5. Update `execute_run` to spin up the heartbeat task and finalize cancellation outcomes:

```python
async def execute_run(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    run_id: int,
    worker_id: str,
    settings: Settings,
    resolve_provider: ProviderResolver,
) -> None:
    run_logger = logger.bind(run_id=run_id, worker_id=worker_id)

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        if run is None:
            run_logger.warning("Run vanished before execution")
            return
        try:
            messages = await build_context(
                session,
                run_id=run_id,
                system_prompt=settings.default_system_prompt,
                budget_chars=_context_budget_chars(),
            )
        except Exception as exc:
            run_logger.exception("Context build failed")
            await mark_run_failed(
                session,
                run_id=run_id,
                code="context_build_error",
                message=str(exc),
            )
            await session.commit()
            return
        provider_name = run.provider_name
        provider_model = run.provider_model
        await session.commit()

    provider = resolve_provider(provider_name, settings=settings)

    cancel_event = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(
            session_factory=session_factory,
            run_id=run_id,
            lease_seconds=settings.run_lease_seconds,
            interval_seconds=settings.worker_heartbeat_interval_seconds,
            cancel_event=cancel_event,
        )
    )

    try:
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            outcome = await _run_provider_stream(
                session_factory=session_factory,
                run_id=run_id,
                provider=provider,
                provider_model=provider_model,
                messages=messages,
                cancel_event=cancel_event,
            )
            if outcome.status == "succeeded":
                return
            if outcome.status == "cancelled":
                async with session_factory() as session:
                    await mark_run_cancelled(session, run_id=run_id)
                    await session.commit()
                return
            allow_retry = (
                outcome.before_first_delta
                and attempt < max_attempts
                and not outcome.delta_persisted
                and not cancel_event.is_set()
            )
            if allow_retry:
                run_logger.bind(code=outcome.code).info("Retrying provider stream once")
                continue
            if cancel_event.is_set():
                async with session_factory() as session:
                    await mark_run_cancelled(session, run_id=run_id)
                    await session.commit()
                return
            async with session_factory() as session:
                await mark_run_failed(
                    session,
                    run_id=run_id,
                    code=outcome.code or "unknown_error",
                    message=outcome.message or "",
                )
                await session.commit()
            return
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task
```

6. Update `app/core/config.py` to make the interval fields `float` (the tests in this and the next task supply sub-second values via `Settings.model_copy(update=...)` which would otherwise mis-type):

```python
run_lease_seconds: int
worker_poll_interval_seconds: float
worker_heartbeat_interval_seconds: float
```

`.env.example` and `conftest.py` already use whole-second values; `float` accepts them with no change.

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/worker/test_executor.py -v
```

Expected: PASS (6 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/worker app/core tests/worker
uv run mypy app/worker app/core tests/worker
git add app/worker/executor.py app/core/config.py tests/worker/test_executor.py
git commit -m "feat: worker heartbeat with cancel detection"
```

---

## Task 11: Worker Main Loop 和 Recovery Scheduler

**Files:**
- Create: `app/worker/main.py`
- Create: `app/worker/__main__.py`
- Create: `tests/worker/test_main.py`

- [ ] **Step 1: Write the failing test**

`tests/worker/test_main.py`:

```python
import asyncio
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Finish, Provider, TextDelta
from app.worker.main import run_worker_loop
from tests.providers.fake import FakeProvider

TEST_DATABASE_URL = os.environ.get(
    "WORKER_MAIN_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "worker-main-test.example.com"


async def clean_test_data(session: AsyncSession) -> None:
    user_ids = select(User.id).where(User.email.like(f"%@{TEST_EMAIL_DOMAIN}")).scalar_subquery()
    conversation_ids = (
        select(Conversation.id).where(Conversation.user_id.in_(user_ids)).scalar_subquery()
    )
    run_ids = select(Run.id).where(Run.conversation_id.in_(conversation_ids)).scalar_subquery()
    await session.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    await session.execute(delete(Run).where(Run.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
    await session.execute(delete(Conversation).where(Conversation.user_id.in_(user_ids)))
    await session.execute(delete(User).where(User.id.in_(user_ids)))


@pytest.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    yield factory
    async with factory() as session:
        await clean_test_data(session)
        await session.commit()
    await engine.dispose()


async def make_queued_run(session: AsyncSession) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"main-{suffix}",
        email=f"main-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()

    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()

    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="queued",
        provider_name="fake",
        provider_model="fake-model",
    )
    session.add(run)
    await session.flush()
    message.run_id = run.id
    await session.flush()
    return run.id


async def make_lease_expired_run(session: AsyncSession) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"main-stuck-{suffix}",
        email=f"main-stuck-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    conversation = Conversation(user_id=user.id, title="Chat")
    session.add(conversation)
    await session.flush()
    message = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello",
        position=1,
    )
    session.add(message)
    await session.flush()
    run = Run(
        conversation_id=conversation.id,
        user_message_id=message.id,
        status="streaming",
        provider_name="fake",
        provider_model="fake-model",
        lease_owner="dead-worker",
        lease_expires_at=datetime.now(UTC) - timedelta(seconds=5),
    )
    session.add(run)
    await session.flush()
    return run.id


async def test_run_worker_loop_processes_queued_runs_with_fake_provider(
    session_factory,
) -> None:
    async with session_factory() as session:
        queued_id = await make_queued_run(session)
        await session.commit()

    settings = get_settings().model_copy(
        update={
            "worker_poll_interval_seconds": 0.05,
            "worker_heartbeat_interval_seconds": 0.05,
            "run_lease_seconds": 30,
        }
    )

    def resolve(name: str, *, settings: Settings) -> Provider:
        return FakeProvider(
            script=[
                TextDelta(text="Hi"),
                Finish(finish_reason="stop"),
            ]
        )

    stop_event = asyncio.Event()

    async def stop_after_succeed() -> None:
        for _ in range(60):
            await asyncio.sleep(0.1)
            async with session_factory() as session:
                run = await session.get(Run, queued_id)
                if run is not None and run.status == "succeeded":
                    stop_event.set()
                    return
        stop_event.set()

    watch_task = asyncio.create_task(stop_after_succeed())
    worker_task = asyncio.create_task(
        run_worker_loop(
            session_factory=session_factory,
            settings=settings,
            worker_id="worker-loop-test",
            resolve_provider=resolve,
            stop_event=stop_event,
            recovery_interval_seconds=0.2,
        )
    )

    try:
        await asyncio.wait_for(worker_task, timeout=10.0)
    finally:
        watch_task.cancel()

    async with session_factory() as session:
        run = await session.get(Run, queued_id)
        assert run is not None
        assert run.status == "succeeded"


async def test_run_worker_loop_recovers_lease_expired_runs(session_factory) -> None:
    async with session_factory() as session:
        stuck_id = await make_lease_expired_run(session)
        await session.commit()

    settings = get_settings().model_copy(
        update={
            "worker_poll_interval_seconds": 0.05,
            "worker_heartbeat_interval_seconds": 0.05,
            "run_lease_seconds": 30,
        }
    )

    def resolve(name: str, *, settings: Settings) -> Provider:
        return FakeProvider(script=[Finish(finish_reason="stop")])

    stop_event = asyncio.Event()

    async def stop_after_recovery() -> None:
        for _ in range(60):
            await asyncio.sleep(0.1)
            async with session_factory() as session:
                run = await session.get(Run, stuck_id)
                if run is not None and run.status == "failed":
                    stop_event.set()
                    return
        stop_event.set()

    watch_task = asyncio.create_task(stop_after_recovery())
    worker_task = asyncio.create_task(
        run_worker_loop(
            session_factory=session_factory,
            settings=settings,
            worker_id="worker-loop-test",
            resolve_provider=resolve,
            stop_event=stop_event,
            recovery_interval_seconds=0.1,
        )
    )

    try:
        await asyncio.wait_for(worker_task, timeout=10.0)
    finally:
        watch_task.cancel()

    async with session_factory() as session:
        run = await session.get(Run, stuck_id)
        assert run is not None
        assert run.status == "failed"
        assert run.error_code == "lease_expired"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/worker/test_main.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.worker.main'`.

- [ ] **Step 3: Implement the worker main loop and entry point**

`app/worker/main.py`:

```python
import asyncio
import os
import socket
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging, logger
from app.db.session import get_session_factory
from app.providers import resolve_provider as default_resolve_provider
from app.services.runs.lifecycle import (
    claim_next_queued_run,
    recover_expired_runs,
)
from app.worker.executor import ProviderResolver, execute_run

DEFAULT_RECOVERY_INTERVAL_SECONDS = 15.0


def build_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}-{uuid4().hex[:8]}"


async def run_worker_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    worker_id: str,
    resolve_provider: ProviderResolver,
    stop_event: asyncio.Event,
    recovery_interval_seconds: float = DEFAULT_RECOVERY_INTERVAL_SECONDS,
) -> None:
    worker_logger = logger.bind(worker_id=worker_id)
    recovery_task = asyncio.create_task(
        _recovery_loop(
            session_factory=session_factory,
            interval_seconds=recovery_interval_seconds,
            stop_event=stop_event,
        )
    )
    try:
        while not stop_event.is_set():
            try:
                async with session_factory() as session:
                    claimed_run_id = await claim_next_queued_run(
                        session,
                        worker_id=worker_id,
                        lease_seconds=settings.run_lease_seconds,
                    )
                    await session.commit()
            except Exception:
                worker_logger.exception("Claim failed")
                await _sleep_or_stop(settings.worker_poll_interval_seconds, stop_event)
                continue

            if claimed_run_id is None:
                await _sleep_or_stop(settings.worker_poll_interval_seconds, stop_event)
                continue

            try:
                await execute_run(
                    session_factory=session_factory,
                    run_id=claimed_run_id,
                    worker_id=worker_id,
                    settings=settings,
                    resolve_provider=resolve_provider,
                )
            except Exception:
                worker_logger.bind(run_id=claimed_run_id).exception(
                    "Executor crashed; recovery loop will handle expired lease"
                )
    finally:
        recovery_task.cancel()
        try:
            await recovery_task
        except asyncio.CancelledError:
            pass


async def _recovery_loop(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    interval_seconds: float,
    stop_event: asyncio.Event,
) -> None:
    while not stop_event.is_set():
        try:
            async with session_factory() as session:
                recovered_ids = await recover_expired_runs(session)
                await session.commit()
            for run_id in recovered_ids:
                logger.bind(run_id=run_id).warning("Recovered lease-expired run")
        except Exception:
            logger.exception("Recovery loop iteration failed")
        await _sleep_or_stop(interval_seconds, stop_event)


async def _sleep_or_stop(seconds: float, stop_event: asyncio.Event) -> None:
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        return


async def run_worker_from_settings() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    factory = get_session_factory()
    worker_id = build_worker_id()
    stop_event = asyncio.Event()

    loop = asyncio.get_running_loop()
    for signame in ("SIGINT", "SIGTERM"):
        import signal as _signal

        sig = getattr(_signal, signame, None)
        if sig is not None:
            loop.add_signal_handler(sig, stop_event.set)

    logger.bind(worker_id=worker_id).info("Worker starting")
    await run_worker_loop(
        session_factory=factory,
        settings=settings,
        worker_id=worker_id,
        resolve_provider=default_resolve_provider,
        stop_event=stop_event,
    )
    logger.bind(worker_id=worker_id).info("Worker stopped")
```

`app/worker/__main__.py`:

```python
import asyncio

from app.worker.main import run_worker_from_settings


if __name__ == "__main__":
    asyncio.run(run_worker_from_settings())
```

Update `app/worker/__init__.py`:

```python
from app.worker.executor import execute_run
from app.worker.main import build_worker_id, run_worker_from_settings, run_worker_loop

__all__ = [
    "build_worker_id",
    "execute_run",
    "run_worker_from_settings",
    "run_worker_loop",
]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/worker -v
```

Expected: PASS (all worker tests, 8 total).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/worker tests/worker
uv run mypy app/worker tests/worker
git add app/worker tests/worker/test_main.py
git commit -m "feat: worker polling loop with recovery scheduler"
```

---

## Task 12: DeepSeek SSE Parser

**Files:**
- Create: `app/providers/deepseek_parser.py`
- Create: `tests/providers/test_deepseek_parser.py`

- [ ] **Step 1: Write the failing test**

`tests/providers/test_deepseek_parser.py`:

```python
from app.providers import Finish, TextDelta
from app.providers.deepseek_parser import parse_sse_line


def test_parse_sse_line_returns_text_delta_for_content_chunk() -> None:
    line = (
        'data: {"id":"x","choices":[{"index":0,"delta":{"content":"Hello"},'
        '"finish_reason":null}]}'
    )

    result = parse_sse_line(line)

    assert result == TextDelta(text="Hello")


def test_parse_sse_line_returns_finish_when_finish_reason_present() -> None:
    line = (
        'data: {"id":"y","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":3,"completion_tokens":2}}'
    )

    result = parse_sse_line(line)

    assert isinstance(result, Finish)
    assert result.finish_reason == "stop"
    assert result.usage == {"prompt_tokens": 3, "completion_tokens": 2}


def test_parse_sse_line_returns_none_for_done_marker() -> None:
    assert parse_sse_line("data: [DONE]") is None


def test_parse_sse_line_returns_none_for_non_data_line() -> None:
    assert parse_sse_line("event: ping") is None
    assert parse_sse_line("") is None
    assert parse_sse_line(":heartbeat") is None


def test_parse_sse_line_returns_none_for_empty_delta_without_finish() -> None:
    line = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}'
    assert parse_sse_line(line) is None


def test_parse_sse_line_raises_provider_error_on_invalid_json() -> None:
    import pytest

    from app.providers import ProviderError

    with pytest.raises(ProviderError) as exc_info:
        parse_sse_line("data: {not valid")

    assert exc_info.value.code == "deepseek_invalid_json"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/providers/test_deepseek_parser.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.providers.deepseek_parser'`.

- [ ] **Step 3: Implement the parser**

`app/providers/deepseek_parser.py`:

```python
import json
from typing import Any

from app.providers.types import Finish, ProviderChunk, ProviderError, TextDelta


def parse_sse_line(line: str) -> ProviderChunk | None:
    stripped = line.strip()
    if not stripped.startswith("data:"):
        return None
    payload = stripped[len("data:") :].strip()
    if payload == "[DONE]" or payload == "":
        return None
    try:
        data: Any = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ProviderError(
            code="deepseek_invalid_json",
            message=f"Invalid JSON payload: {exc.msg}",
        ) from exc

    choices = data.get("choices") or []
    if not choices:
        return None
    first = choices[0]
    finish_reason = first.get("finish_reason")
    delta = first.get("delta") or {}
    content = delta.get("content")

    if finish_reason is not None:
        usage = data.get("usage")
        if not isinstance(usage, dict):
            usage = None
        return Finish(finish_reason=finish_reason, usage=usage, provider_request_id=None)

    if isinstance(content, str) and content != "":
        return TextDelta(text=content)
    return None
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/providers/test_deepseek_parser.py -v
```

Expected: PASS (6 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/providers tests/providers
uv run mypy app/providers tests/providers
git add app/providers/deepseek_parser.py tests/providers/test_deepseek_parser.py
git commit -m "feat: parse deepseek sse lines"
```

---

## Task 13: DeepSeek HTTP Adapter

**Files:**
- Modify: `app/providers/deepseek.py` (replace placeholder with real impl)
- Create: `tests/providers/test_deepseek_adapter.py`

- [ ] **Step 1: Write the failing test**

`tests/providers/test_deepseek_adapter.py`:

```python
import json

import httpx
import pytest

from app.core.config import get_settings
from app.providers import Finish, ProviderError, ProviderMessage, TextDelta
from app.providers.deepseek import DeepSeekProvider


def make_settings():
    return get_settings()


def sse_body(chunks: list[dict]) -> bytes:
    lines = []
    for chunk in chunks:
        lines.append(f"data: {json.dumps(chunk)}\n\n")
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


async def test_deepseek_provider_streams_text_deltas_and_finish() -> None:
    body = sse_body(
        [
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {"content": "Hello"}, "finish_reason": None}],
            },
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {"content": " world"}, "finish_reason": None}],
            },
            {
                "id": "1",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2},
            },
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path.endswith("/chat/completions")
        assert request.headers["authorization"].startswith("Bearer ")
        payload = json.loads(request.content)
        assert payload["stream"] is True
        assert payload["model"] == "deepseek-test"
        return httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/event-stream", "x-request-id": "req-77"},
        )

    transport = httpx.MockTransport(handler)
    provider = DeepSeekProvider(settings=make_settings(), transport=transport)

    chunks = []
    async for chunk in provider.stream(
        model="deepseek-test",
        messages=[ProviderMessage(role="user", content="hi")],
    ):
        chunks.append(chunk)

    assert chunks[:2] == [TextDelta(text="Hello"), TextDelta(text=" world")]
    finish = chunks[2]
    assert isinstance(finish, Finish)
    assert finish.finish_reason == "stop"
    assert finish.usage == {"prompt_tokens": 4, "completion_tokens": 2}
    assert finish.provider_request_id == "req-77"


async def test_deepseek_provider_raises_provider_error_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": "server is sad"}})

    transport = httpx.MockTransport(handler)
    provider = DeepSeekProvider(settings=make_settings(), transport=transport)

    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="deepseek-test",
            messages=[ProviderMessage(role="user", content="hi")],
        ):
            pass

    assert exc_info.value.code == "deepseek_http_error"
    assert "500" in exc_info.value.message
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/providers/test_deepseek_adapter.py -v
```

Expected: FAIL — current placeholder `DeepSeekProvider` raises `NotImplementedError`, and the constructor does not accept `transport`.

- [ ] **Step 3: Implement the DeepSeek adapter**

`app/providers/deepseek.py` (replace placeholder):

```python
from collections.abc import AsyncIterator

import httpx

from app.core.config import Settings
from app.providers.deepseek_parser import parse_sse_line
from app.providers.types import (
    Finish,
    Provider,
    ProviderChunk,
    ProviderError,
    ProviderMessage,
)


class DeepSeekProvider(Provider):
    def __init__(
        self,
        *,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport

    @property
    def name(self) -> str:
        return "deepseek"

    async def stream(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
    ) -> AsyncIterator[ProviderChunk]:
        payload = {
            "model": model,
            "stream": True,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        headers = {
            "Authorization": f"Bearer {self._settings.deepseek_api_key}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }

        client_kwargs = {
            "base_url": self._settings.deepseek_base_url,
            "timeout": httpx.Timeout(60.0, connect=10.0),
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport

        async with httpx.AsyncClient(**client_kwargs) as client:
            try:
                async with client.stream(
                    "POST",
                    "/chat/completions",
                    json=payload,
                    headers=headers,
                ) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode(errors="replace")
                        raise ProviderError(
                            code="deepseek_http_error",
                            message=f"DeepSeek returned {response.status_code}: {body[:500]}",
                        )
                    provider_request_id = response.headers.get("x-request-id")
                    async for line in response.aiter_lines():
                        chunk = parse_sse_line(line)
                        if chunk is None:
                            continue
                        if isinstance(chunk, Finish) and provider_request_id is not None:
                            chunk = Finish(
                                finish_reason=chunk.finish_reason,
                                usage=chunk.usage,
                                provider_request_id=provider_request_id,
                            )
                        yield chunk
            except httpx.HTTPError as exc:
                raise ProviderError(
                    code="deepseek_transport_error",
                    message=str(exc),
                ) from exc
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/providers/test_deepseek_adapter.py tests/providers/test_registry.py -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Lint/type-check and commit**

```bash
uv run ruff check app/providers tests/providers
uv run mypy app/providers tests/providers
git add app/providers/deepseek.py tests/providers/test_deepseek_adapter.py
git commit -m "feat: deepseek streaming http adapter"
```

---

## Task 14: 接 Docker Compose Worker 并跑全量验证

**Files:**
- Modify: `compose.yml`

- [ ] **Step 1: Update worker compose command**

Replace the placeholder command. Edit `compose.yml`:

```yaml
  worker:
    build:
      context: .
    image: ichat-worker:local
    env_file:
      - .env
    command: ["python", "-m", "app.worker"]
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 2: Verify the compose file parses**

```bash
docker compose -f compose.yml config > /dev/null
```

Expected: no output, exit code 0.

- [ ] **Step 3: Run the full test suite, lint, and type-check**

```bash
uv run pytest
uv run ruff check .
uv run mypy .
```

Expected: all tests pass (the previous tasks each verified focused suites); ruff and mypy clean.

- [ ] **Step 4: Smoke-test worker startup against the local DB**

Start postgres and the worker, watch it idle-poll for ~5 seconds, then stop.

```bash
docker compose up -d postgres
uv run alembic upgrade head
( uv run python -m app.worker & echo $! > /tmp/ichat-worker.pid )
sleep 5
kill $(cat /tmp/ichat-worker.pid) || true
docker compose down
```

Expected: worker process starts and shuts down cleanly (no traceback in stderr aside from the SIGTERM-triggered "Worker stopped" log line).

- [ ] **Step 5: Commit**

```bash
git add compose.yml
git commit -m "chore: wire compose worker to module entry"
```

---

## Verification Summary

After all tasks:

```bash
uv run pytest -v
uv run ruff check .
uv run mypy .
```

Expected outcomes:

- All existing tests still pass (auth, conversations, runs API/state/events).
- New tests pass:
  - `tests/providers/*` — types, fake, registry, deepseek parser, deepseek adapter.
  - `tests/context/test_builder.py` — context construction and trimming.
  - `tests/services/runs/test_lifecycle.py` — claim, state transitions, lease, recovery.
  - `tests/services/conversations/test_materialize.py` — assistant message materialization.
  - `tests/worker/test_executor.py` — happy path, retry-once, no-retry after delta, two-fail terminal, cancel, lease renewal.
  - `tests/worker/test_main.py` — end-to-end claim+execute, recovery loop.
- ruff and mypy clean.
- `docker compose up worker` produces a worker that polls and shuts down cleanly.

The full provider + worker stack is functional with `FakeProvider` end-to-end, and `DeepSeekProvider` is unit-tested against `httpx.MockTransport`. Manual DeepSeek smoke against real credentials is out of scope for this plan but trivial via `python -m app.worker` with a real `DEEPSEEK_API_KEY`.
