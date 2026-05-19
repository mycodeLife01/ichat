# Auto Title And Draft Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 conversation 默认作为草稿隐藏，首次 AI 成功回复时激活，并在 worker 端 best-effort 自动生成标题。

**Architecture:** `conversations.activated_at` 是草稿/可见的唯一持久化判定；API 列表只返回已激活 conversation，详情仍允许 owner 打开草稿。Worker 在 `mark_run_succeeded + materialize_assistant_message` 同一事务中激活 conversation，随后另开事务调用 provider 非流式 `summarize()` 写入标题，失败只记录日志。

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 async, Alembic, PostgreSQL, httpx, pytest, vanilla JS, localStorage, SSE.

---

## Assumptions

- 按项目约定直接在当前分支开发，不创建 git worktree。
- 标题生成遵循 spec：在 run 成功事务提交后执行，不阻塞 `run_succeeded` 持久化和 SSE 终止事件。前端在成功后立即刷新列表和详情；若标题生成尚未完成或失败，仍显示既有占位“新对话”。
- `summary_model` 是必填配置；`.env.example` 提供 `deepseek-chat` 作为本地默认值。
- 不新增 SSE event type，不做草稿 GC，不重试标题生成。

## File Structure

- Create `alembic/versions/20260519_0002_add_conversation_activation.py`: 添加 `conversations.activated_at`，回填旧数据，支持 downgrade。
- Modify `app/models/conversation.py`: ORM `Conversation` 增加 `activated_at`。
- Modify `app/schemas/conversations.py`: `ConversationResponse` 增加 `activated_at: datetime | None`。
- Modify `app/api/v1/conversations.py`: conversation response routes 不再排除 `None` 字段，让 `activated_at: null` 可见。
- Modify `app/core/config.py` and `.env.example`: 增加自动标题相关配置。
- Modify `tests/conftest.py`, `tests/db/test_session.py`, `.github/workflows/ci.yml`: 为必填 `SUMMARY_MODEL` 补测试和 CI 环境变量。
- Modify `app/services/conversations/service.py`: 列表过滤草稿，增加 `ensure_conversation_activated()`，在 `materialize_assistant_message()` 内激活。
- Modify `app/services/conversations/__init__.py`: 导出 `ensure_conversation_activated()`。
- Modify `app/providers/types.py`: `Provider` ABC 增加非流式 `summarize()`。
- Modify `app/providers/deepseek.py`: 实现 DeepSeek 非流式 summary 调用。
- Modify `tests/providers/fake.py`: `FakeProvider` 实现 `summarize()`，默认返回 `"Fake Title"`。
- Create `app/worker/title.py`: worker-only 自动标题读取、后处理、provider 调用、写回逻辑。
- Modify `app/worker/executor.py`: Finish 分支成功提交后调用 `maybe_generate_title()`。
- Modify `frontend/state.js`: 增加 `draftConversationId` 与 selected/draft localStorage 持久化 helper。
- Modify `frontend/auth.js`: 登出和 refresh 失败时清理 selected/draft storage。
- Modify `frontend/views/chat.js`: 新建草稿不进侧栏；启动恢复 selectedId；run succeeded 后刷新列表/详情并清理 draft 标记。
- Modify tests under `tests/` and `frontend/views/chat.test.js`: 覆盖 schema、migration、service、provider、worker、API、frontend source behavior。

---

### Task 1: Data Model, Migration, Schema, Config

**Files:**
- Create: `alembic/versions/20260519_0002_add_conversation_activation.py`
- Modify: `app/models/conversation.py`
- Modify: `app/schemas/conversations.py`
- Modify: `app/core/config.py`
- Modify: `.env.example`
- Test: `tests/db/test_alembic.py`
- Test: `tests/schemas/test_conversation_schemas.py`
- Test: `tests/core/test_config.py`
- Test: `tests/db/test_session.py`
- Test support: `tests/conftest.py`
- CI: `.github/workflows/ci.yml`

- [ ] **Step 1: Write failing migration, schema, and config tests**

Update `tests/db/test_alembic.py` so it allows the new migration and asserts the exact file exists:

```python
from pathlib import Path


def test_alembic_runtime_files_exist() -> None:
    assert Path("alembic.ini").is_file()
    assert Path("alembic/env.py").is_file()
    assert Path("alembic/versions").is_dir()


def test_core_schema_migrations_exist() -> None:
    migrations = [
        path
        for path in Path("alembic/versions").glob("*.py")
        if path.name != "__init__.py"
    ]

    assert len(migrations) >= 2
    assert Path(
        "alembic/versions/20260519_0002_add_conversation_activation.py"
    ).is_file()
```

Update `tests/schemas/test_conversation_schemas.py::test_conversation_detail_response_contains_visible_messages` to require the new field:

```python
def test_conversation_detail_response_contains_visible_messages() -> None:
    now = datetime.now(UTC)
    conversation = ConversationResponse(
        id=1,
        title="Project chat",
        activated_at=now,
        created_at=now,
        updated_at=now,
    )
    message = MessageResponse(
        id=10,
        conversation_id=1,
        run_id=20,
        role="user",
        content="Hello",
        position=1,
        created_at=now,
    )
    detail = ConversationDetailResponse(
        **conversation.model_dump(),
        messages=[message],
    )

    assert detail.id == 1
    assert detail.activated_at == now
    assert detail.messages == [message]
```

Add this schema test for draft responses:

```python
def test_conversation_response_allows_null_activated_at() -> None:
    now = datetime.now(UTC)
    response = ConversationResponse(
        id=1,
        title=None,
        activated_at=None,
        created_at=now,
        updated_at=now,
    )

    assert response.activated_at is None
```

Update `tests/core/test_config.py`:

```python
ENV_KEYS = [
    "DATABASE_URL",
    "JWT_SECRET",
    "JWT_ACCESS_TOKEN_TTL_SECONDS",
    "REFRESH_TOKEN_TTL_SECONDS",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "DEEPSEEK_THINKING_ENABLED",
    "DEFAULT_SYSTEM_PROMPT",
    "RUN_LEASE_SECONDS",
    "WORKER_POLL_INTERVAL_SECONDS",
    "WORKER_HEARTBEAT_INTERVAL_SECONDS",
    "SUMMARY_MODEL",
    "LOG_LEVEL",
]
```

Add these environment values and assertions inside `test_settings_parse_environment_values`:

```python
monkeypatch.setenv("AUTO_TITLE_ENABLED", "false")
monkeypatch.setenv("SUMMARY_PROVIDER_NAME", "deepseek")
monkeypatch.setenv("SUMMARY_MODEL", "deepseek-summary")
monkeypatch.setenv("AUTO_TITLE_MAX_CHARS", "24")
monkeypatch.setenv("AUTO_TITLE_MAX_OUTPUT_TOKENS", "36")
```

```python
assert settings.auto_title_enabled is False
assert settings.summary_provider_name == "deepseek"
assert settings.summary_model == "deepseek-summary"
assert settings.auto_title_max_chars == 24
assert settings.auto_title_max_output_tokens == 36
```

Add these assertions inside `test_env_example_values_match_settings_shape`:

```python
assert settings.auto_title_enabled is True
assert settings.summary_provider_name == env_value(example_values, "SUMMARY_PROVIDER_NAME")
assert settings.summary_model == env_value(example_values, "SUMMARY_MODEL")
assert settings.auto_title_max_chars == int(env_value(example_values, "AUTO_TITLE_MAX_CHARS"))
assert settings.auto_title_max_output_tokens == int(
    env_value(example_values, "AUTO_TITLE_MAX_OUTPUT_TOKENS")
)
```

Add required constructor fields in `test_settings_can_be_constructed_directly`:

```python
settings = Settings(
    database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
    jwt_secret="secret",
    jwt_access_token_ttl_seconds=900,
    refresh_token_ttl_seconds=2_592_000,
    deepseek_api_key="key",
    deepseek_base_url="https://deepseek.example",
    deepseek_model="deepseek-test",
    deepseek_thinking_enabled=False,
    default_system_prompt="Be helpful.",
    run_lease_seconds=60,
    worker_poll_interval_seconds=2,
    worker_heartbeat_interval_seconds=10,
    summary_model="deepseek-summary",
    log_level="info",
)
```

Update `tests/conftest.py`:

```python
environ.setdefault("SUMMARY_MODEL", "deepseek-test")
```

Add this environment value inside `tests/db/test_session.py::test_get_session_factory_is_cached`:

```python
monkeypatch.setenv("SUMMARY_MODEL", "deepseek-test")
```

Add this environment value to `.github/workflows/ci.yml` under the existing DeepSeek env block:

```yaml
      SUMMARY_MODEL: deepseek-test
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
uv run pytest tests/db/test_alembic.py tests/db/test_session.py tests/schemas/test_conversation_schemas.py tests/core/test_config.py -v
```

Expected: fail because the migration file, model field, schema field, and Settings fields do not exist yet.

- [ ] **Step 3: Add Alembic migration**

Create `alembic/versions/20260519_0002_add_conversation_activation.py`:

```python
"""add conversation activation timestamp

Revision ID: 20260519_0002
Revises: 20260516_0001
Create Date: 2026-05-19
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "20260519_0002"
down_revision: str | None = "20260516_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE conversations SET activated_at = created_at WHERE activated_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("conversations", "activated_at")
```

- [ ] **Step 4: Add ORM and response schema fields**

In `app/models/conversation.py`, add the column after `deleted_at`:

```python
activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

In `app/schemas/conversations.py`, replace `ConversationResponse` with:

```python
class ConversationResponse(BaseModel):
    id: int
    title: str | None
    activated_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

- [ ] **Step 5: Add auto-title Settings fields**

In `app/core/config.py`, add these fields after `sse_fallback_interval_seconds`:

```python
auto_title_enabled: bool = True
summary_provider_name: str = "deepseek"
summary_model: str
auto_title_max_chars: int = 32
auto_title_max_output_tokens: int = 40
```

In `.env.example`, add these keys after `SSE_FALLBACK_INTERVAL_SECONDS=5.0`:

```text
AUTO_TITLE_ENABLED=true
SUMMARY_PROVIDER_NAME=deepseek
SUMMARY_MODEL=deepseek-chat
AUTO_TITLE_MAX_CHARS=32
AUTO_TITLE_MAX_OUTPUT_TOKENS=40
```

- [ ] **Step 6: Run focused tests and confirm they pass**

Run:

```bash
uv run pytest tests/db/test_alembic.py tests/db/test_session.py tests/schemas/test_conversation_schemas.py tests/core/test_config.py -v
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add alembic/versions/20260519_0002_add_conversation_activation.py app/models/conversation.py app/schemas/conversations.py app/core/config.py .env.example tests/db/test_alembic.py tests/db/test_session.py tests/schemas/test_conversation_schemas.py tests/core/test_config.py tests/conftest.py .github/workflows/ci.yml
git commit -m "feat: add conversation activation schema"
```

---

### Task 2: Draft Visibility And Activation

**Files:**
- Modify: `app/services/conversations/service.py`
- Modify: `app/services/conversations/__init__.py`
- Test: `tests/services/conversations/test_service.py`
- Test: `tests/services/conversations/test_materialize.py`

- [ ] **Step 1: Write failing service tests for list filtering and draft detail access**

Update imports in `tests/services/conversations/test_service.py`:

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    ensure_conversation_activated,
    get_conversation_detail,
    list_conversations,
    rename_conversation,
    submit_user_message,
)
```

Replace `test_create_and_list_conversations_for_owner` with:

```python
async def test_list_conversations_hides_drafts_and_returns_activated_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        other_user = await create_user(session, "bob")

        draft = await create_conversation(session, user=user, title=None)
        activated = await create_conversation(session, user=user, title="Project chat")
        await create_conversation(session, user=other_user, title="Other chat")
        await ensure_conversation_activated(session, conversation_id=activated.id)
        await session.commit()

        conversations = await list_conversations(session, user=user)

    assert [conversation.id for conversation in conversations] == [activated.id]
    assert conversations[0].title == "Project chat"
    assert conversations[0].activated_at is not None
    assert draft.activated_at is None
```

Add this test:

```python
async def test_get_conversation_detail_allows_owner_to_open_draft(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        user = await create_user(session, "alice")
        draft = await create_conversation(session, user=user, title=None)
        await session.commit()

        detail = await get_conversation_detail(session, user=user, conversation_id=draft.id)

    assert detail.id == draft.id
    assert detail.activated_at is None
    assert detail.messages == []
```

In tests that seed already-visible conversations and then rely on `list_conversations`, call `ensure_conversation_activated()` before `session.commit()`. Do not add activation requirements to detail, rename, delete, send, edit, or regenerate paths.

- [ ] **Step 2: Write failing activation tests**

Update imports in `tests/services/conversations/test_materialize.py`:

```python
from app.services.conversations import (
    ensure_conversation_activated,
    materialize_assistant_message,
)
```

Add:

```python
async def test_ensure_conversation_activated_sets_timestamp_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        run = await make_run(session)
        conversation_id = run.conversation_id
        await session.commit()

    async with session_factory() as session:
        await ensure_conversation_activated(session, conversation_id=conversation_id)
        await session.commit()

    async with session_factory() as session:
        conversation = await session.get(Conversation, conversation_id)
        assert conversation is not None
        first_activated_at = conversation.activated_at
        assert first_activated_at is not None

    async with session_factory() as session:
        await ensure_conversation_activated(session, conversation_id=conversation_id)
        await session.commit()

    async with session_factory() as session:
        conversation = await session.get(Conversation, conversation_id)
        assert conversation is not None
        assert conversation.activated_at == first_activated_at
```

Add an activation assertion to `test_materialize_assistant_message_appends_assistant_with_run_link`:

```python
conversation = await session.get(Conversation, conversation_id)
assert conversation is not None
assert conversation.activated_at is not None
```

- [ ] **Step 3: Run focused tests and confirm they fail**

Run:

```bash
uv run pytest tests/services/conversations/test_service.py tests/services/conversations/test_materialize.py -v
```

Expected: fail because list filtering and activation helper are not implemented.

- [ ] **Step 4: Implement list filtering and activation helper**

In `app/services/conversations/service.py`, update `list_conversations()` where-clause:

```python
.where(
    Conversation.user_id == user.id,
    Conversation.deleted_at.is_(None),
    Conversation.activated_at.is_not(None),
)
```

Add this helper before `materialize_assistant_message()`:

```python
async def ensure_conversation_activated(
    session: AsyncSession,
    *,
    conversation_id: int,
) -> None:
    await session.execute(
        update(Conversation)
        .where(
            Conversation.id == conversation_id,
            Conversation.activated_at.is_(None),
        )
        .values(
            activated_at=func.now(),
            updated_at=func.now(),
        )
    )
```

Update `materialize_assistant_message()` after the assistant message flush:

```python
    session.add(message)
    await session.flush()

    await ensure_conversation_activated(session, conversation_id=run.conversation_id)

    conversation = await session.get(Conversation, run.conversation_id)
    if conversation is not None:
        conversation.updated_at = await get_database_now(session)
        await session.flush()
    return message
```

- [ ] **Step 5: Export the helper**

In `app/services/conversations/__init__.py`, import and export `ensure_conversation_activated`:

```python
from app.services.conversations.service import (
    create_conversation,
    delete_conversation,
    edit_user_message_and_regenerate,
    ensure_conversation_activated,
    get_conversation_detail,
    list_conversations,
    materialize_assistant_message,
    regenerate_from_message,
    rename_conversation,
    submit_user_message,
)
```

```python
__all__ = [
    "create_conversation",
    "delete_conversation",
    "edit_user_message_and_regenerate",
    "ensure_conversation_activated",
    "get_conversation_detail",
    "list_conversations",
    "materialize_assistant_message",
    "regenerate_from_message",
    "rename_conversation",
    "submit_user_message",
]
```

- [ ] **Step 6: Run focused tests and confirm they pass**

Run:

```bash
uv run pytest tests/services/conversations/test_service.py tests/services/conversations/test_materialize.py -v
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/services/conversations/service.py app/services/conversations/__init__.py tests/services/conversations/test_service.py tests/services/conversations/test_materialize.py
git commit -m "feat: activate conversations on first assistant message"
```

---

### Task 3: Conversation API Contract

**Files:**
- Modify: `app/api/v1/conversations.py`
- Test: `tests/api/test_conversations.py`

- [ ] **Step 1: Write failing API tests for draft list behavior**

Update `tests/api/test_conversations.py::test_conversation_crud_flow` expectations:

```python
assert create_response.status_code == status.HTTP_201_CREATED
created = create_response.json()["data"]
assert created["title"] == "Project chat"
assert created["activated_at"] is None
assert set(created) == {"id", "title", "activated_at", "created_at", "updated_at"}
assert list_response.status_code == status.HTTP_200_OK
assert list_response.json()["data"] == []
```

Add this test after `test_conversation_crud_flow`:

```python
async def test_rename_draft_does_not_make_it_visible(client: AsyncClient) -> None:
    alice = await register_user(
        client,
        username="alice-draft-rename-api",
        email=f"alice-draft-rename@{TEST_EMAIL_DOMAIN}",
    )
    headers = auth_headers(alice)

    create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
    conversation_id = create_response.json()["data"]["id"]
    rename_response = await client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "Draft title"},
        headers=headers,
    )
    list_response = await client.get("/api/v1/conversations", headers=headers)
    detail_response = await client.get(f"/api/v1/conversations/{conversation_id}", headers=headers)

    assert rename_response.status_code == status.HTTP_200_OK
    assert rename_response.json()["data"]["title"] == "Draft title"
    assert rename_response.json()["data"]["activated_at"] is None
    assert list_response.status_code == status.HTTP_200_OK
    assert list_response.json()["data"] == []
    assert detail_response.status_code == status.HTTP_200_OK
    assert detail_response.json()["data"]["title"] == "Draft title"
    assert detail_response.json()["data"]["activated_at"] is None
```

Update `seed_completed_turn()` to create visible historical conversations:

```python
conversation = Conversation(user_id=user.id, title="seeded", activated_at=datetime.now(UTC))
```

- [ ] **Step 2: Run API tests and confirm they fail**

Run:

```bash
uv run pytest tests/api/test_conversations.py -v
```

Expected: fail because `activated_at` is omitted from `None` responses or list behavior still includes drafts.

- [ ] **Step 3: Return `activated_at: null` for conversation responses**

In `app/api/v1/conversations.py`, remove `response_model_exclude_none=True` from these conversation routes:

```python
@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=SuccessResponse[ConversationResponse],
)
```

```python
@router.get(
    "",
    response_model=SuccessResponse[list[ConversationResponse]],
)
```

```python
@router.get(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationDetailResponse],
)
```

```python
@router.patch(
    "/{conversation_id}",
    response_model=SuccessResponse[ConversationResponse],
)
```

Leave command and send-message routes unchanged unless a test proves they need explicit `None` fields.

- [ ] **Step 4: Run API tests and confirm they pass**

Run:

```bash
uv run pytest tests/api/test_conversations.py -v
```

Expected: all conversation API tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/conversations.py tests/api/test_conversations.py
git commit -m "feat: expose draft activation state in conversation api"
```

---

### Task 4: Provider Summarize Interface

**Files:**
- Modify: `app/providers/types.py`
- Modify: `app/providers/deepseek.py`
- Modify: `tests/providers/fake.py`
- Test: `tests/providers/test_deepseek_adapter.py`
- Test: `tests/providers/test_fake.py`
- Test: `tests/worker/test_executor.py`
- Test: `tests/worker/test_concurrency.py`

- [ ] **Step 1: Write failing provider tests**

Add to `tests/providers/test_fake.py`:

```python
async def test_fake_provider_summarize_returns_configured_title() -> None:
    provider = FakeProvider(script=[], summarize_result="A concise title")

    result = await provider.summarize(
        model="fake-summary",
        messages=[ProviderMessage(role="user", content="hi")],
        max_output_tokens=40,
    )

    assert result == "A concise title"


async def test_fake_provider_summarize_can_raise_provider_error() -> None:
    provider = FakeProvider(
        script=[],
        summarize_result=ProviderError(code="summary_failed", message="boom"),
    )

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="fake-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "summary_failed"
```

Add to `tests/providers/test_deepseek_adapter.py`:

```python
async def test_deepseek_provider_summarize_returns_message_content() -> None:
    captured_payload: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_payload.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "Project Plan"}}]},
        )

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    title = await provider.summarize(
        model="deepseek-summary",
        messages=[ProviderMessage(role="user", content="summarize this")],
        max_output_tokens=40,
    )

    assert title == "Project Plan"
    assert captured_payload["model"] == "deepseek-summary"
    assert captured_payload["stream"] is False
    assert captured_payload["thinking"] == {"type": "disabled"}
    assert captured_payload["max_tokens"] == 40
    assert captured_payload["temperature"] == 0.3


async def test_deepseek_provider_summarize_raises_on_empty_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "   "}}]})

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="deepseek-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "deepseek_summarize_empty"


async def test_deepseek_provider_summarize_raises_on_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="deepseek-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "deepseek_summarize_http_error"
    assert "429" in exc_info.value.message


async def test_deepseek_provider_summarize_raises_on_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down", request=request)

    provider = DeepSeekProvider(settings=make_settings(), transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderError) as exc_info:
        await provider.summarize(
            model="deepseek-summary",
            messages=[ProviderMessage(role="user", content="hi")],
            max_output_tokens=40,
        )

    assert exc_info.value.code == "deepseek_summarize_transport_error"
```

- [ ] **Step 2: Run provider tests and confirm they fail**

Run:

```bash
uv run pytest tests/providers/test_fake.py tests/providers/test_deepseek_adapter.py -v
```

Expected: fail because `Provider.summarize()` and implementations do not exist.

- [ ] **Step 3: Extend the Provider ABC**

In `app/providers/types.py`, add this abstract method to `Provider`:

```python
    @abstractmethod
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        raise NotImplementedError
```

- [ ] **Step 4: Update FakeProvider**

In `tests/providers/fake.py`, change `FakeProvider.__init__` and add `summarize()`:

```python
class FakeProvider(Provider):
    def __init__(
        self,
        *,
        script: Sequence[ScriptItem],
        name: str = "fake",
        summarize_result: str | ProviderError = "Fake Title",
    ) -> None:
        self._script = list(script)
        self._name = name
        self._summarize_result = summarize_result

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

    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        if isinstance(self._summarize_result, ProviderError):
            raise self._summarize_result
        return self._summarize_result
```

- [ ] **Step 5: Implement DeepSeek summarize**

In `app/providers/deepseek.py`, add this method to `DeepSeekProvider`:

```python
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        payload = {
            "model": model,
            "stream": False,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "thinking": {"type": "disabled"},
            "max_tokens": max_output_tokens,
            "temperature": 0.3,
        }
        headers = {
            "Authorization": f"Bearer {self._settings.deepseek_api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        client_kwargs: dict[str, Any] = {
            "base_url": self._settings.deepseek_base_url,
            "timeout": httpx.Timeout(15.0, connect=5.0),
        }
        if self._transport is not None:
            client_kwargs["transport"] = self._transport

        async with httpx.AsyncClient(**client_kwargs) as client:
            try:
                response = await client.post(
                    "/chat/completions",
                    json=payload,
                    headers=headers,
                )
                if response.status_code >= 400:
                    raise ProviderError(
                        code="deepseek_summarize_http_error",
                        message=f"DeepSeek summarize returned {response.status_code}: {response.text[:500]}",
                    )
                data = response.json()
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content.strip():
                    raise ProviderError(
                        code="deepseek_summarize_empty",
                        message="DeepSeek summarize returned empty content",
                    )
                return content
            except ProviderError:
                raise
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise ProviderError(
                    code="deepseek_summarize_empty",
                    message="DeepSeek summarize response did not contain message content",
                ) from exc
            except httpx.HTTPError as exc:
                raise ProviderError(
                    code="deepseek_summarize_transport_error",
                    message=str(exc),
                ) from exc
```

- [ ] **Step 6: Update custom Provider classes in worker tests**

At the top of `tests/worker/test_executor.py`, add:

```python
class SummarizeMixin:
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        return "Fake Title"
```

Update nested provider classes to inherit `SummarizeMixin` before `Provider`:

```python
class FlakyProvider(SummarizeMixin, Provider):
```

```python
class AlwaysFailProvider(SummarizeMixin, Provider):
```

```python
class BlockingProvider(SummarizeMixin, Provider):
```

```python
class ErrorAfterCancellationProvider(SummarizeMixin, Provider):
```

Add the same mixin to `tests/worker/test_concurrency.py` after imports:

```python
class SummarizeMixin:
    async def summarize(
        self,
        *,
        model: str,
        messages: list[ProviderMessage],
        max_output_tokens: int,
    ) -> str:
        return "Fake Title"
```

Update both local concurrency providers:

```python
class SlowProvider(SummarizeMixin, Provider):
```

- [ ] **Step 7: Run provider and worker tests**

Run:

```bash
uv run pytest tests/providers/test_fake.py tests/providers/test_deepseek_adapter.py tests/worker/test_executor.py tests/worker/test_concurrency.py -v
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/providers/types.py app/providers/deepseek.py tests/providers/fake.py tests/providers/test_fake.py tests/providers/test_deepseek_adapter.py tests/worker/test_executor.py tests/worker/test_concurrency.py
git commit -m "feat: add provider summarize support"
```

---

### Task 5: Auto Title Worker Helper

**Files:**
- Create: `app/worker/title.py`
- Test: `tests/worker/test_auto_title.py`

- [ ] **Step 1: Write failing title helper tests**

Create `tests/worker/test_auto_title.py`:

```python
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.models.conversation import Conversation, Message
from app.models.run import Run, RunEvent
from app.models.user import User
from app.providers import Provider, ProviderError
from app.worker.executor import ProviderResolver
from app.worker.title import maybe_generate_title, normalize_generated_title
from tests.providers.fake import FakeProvider

TEST_DATABASE_URL = os.environ.get(
    "AUTO_TITLE_TEST_DATABASE_URL",
    "postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat",
)
TEST_EMAIL_DOMAIN = "auto-title-test.example.com"


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
    return get_settings().model_copy(
        update={
            "auto_title_enabled": True,
            "summary_provider_name": "fake",
            "summary_model": "fake-summary",
            "auto_title_max_chars": 32,
            "auto_title_max_output_tokens": 40,
        }
    )


def make_resolver(provider: Provider) -> ProviderResolver:
    def resolve(name: str, *, settings: Settings) -> Provider:
        assert name == "fake"
        return provider

    return resolve


async def seed_succeeded_turn(
    session: AsyncSession,
    *,
    title: str | None,
    succeeded_runs: int = 1,
) -> int:
    suffix = uuid4().hex
    user = User(
        username=f"title-{suffix}",
        email=f"title-{suffix}@{TEST_EMAIL_DOMAIN}",
        password_hash="hash",
        email_verified=False,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    conversation = Conversation(
        user_id=user.id,
        title=title,
        activated_at=datetime.now(UTC),
    )
    session.add(conversation)
    await session.flush()

    first_run_id = 0
    for index in range(succeeded_runs):
        user_message = Message(
            conversation_id=conversation.id,
            role="user",
            content=f"User asks question {index}",
            position=index * 2 + 1,
        )
        session.add(user_message)
        await session.flush()

        run = Run(
            conversation_id=conversation.id,
            user_message_id=user_message.id,
            status="succeeded",
            provider_name="fake",
            provider_model="fake-model",
        )
        session.add(run)
        await session.flush()
        user_message.run_id = run.id

        assistant_message = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content=f"Assistant answer {index}",
            position=index * 2 + 2,
        )
        session.add(assistant_message)
        await session.flush()
        if index == 0:
            first_run_id = run.id

    return first_run_id


def test_normalize_generated_title_strips_wrappers_prefix_whitespace_and_truncates() -> None:
    title = normalize_generated_title(
        "  《标题：  Project\\nPlan For iChat Backend》  ",
        max_chars=12,
    )

    assert title == "Project Plan"


def test_normalize_generated_title_returns_none_for_blank() -> None:
    assert normalize_generated_title("   ", max_chars=32) is None


async def test_maybe_generate_title_writes_first_success_title(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title=None)
        await session.commit()

    provider = FakeProvider(script=[], summarize_result=' "标题：  Travel\\nPlan  " ')
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title == "Travel Plan"


async def test_maybe_generate_title_does_not_overwrite_manual_title(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title="Manual title")
        await session.commit()

    provider = FakeProvider(script=[], summarize_result="Generated title")
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title == "Manual title"


async def test_maybe_generate_title_skips_when_succeeded_count_is_not_one(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title=None, succeeded_runs=2)
        await session.commit()

    provider = FakeProvider(script=[], summarize_result="Generated title")
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title is None


async def test_maybe_generate_title_swallows_provider_error(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
) -> None:
    async with session_factory() as session:
        run_id = await seed_succeeded_turn(session, title=None)
        await session.commit()

    provider = FakeProvider(
        script=[],
        summarize_result=ProviderError(code="summary_failed", message="boom"),
    )
    await maybe_generate_title(
        session_factory=session_factory,
        run_id=run_id,
        settings=settings,
        resolve_provider=make_resolver(provider),
    )

    async with session_factory() as session:
        run = await session.get(Run, run_id)
        assert run is not None
        conversation = await session.get(Conversation, run.conversation_id)
        assert conversation is not None
        assert conversation.title is None
```

- [ ] **Step 2: Run title helper tests and confirm they fail**

Run:

```bash
uv run pytest tests/worker/test_auto_title.py -v
```

Expected: fail because `app.worker.title` does not exist.

- [ ] **Step 3: Implement auto title helper**

Create `app/worker/title.py`:

```python
import asyncio
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
    except asyncio.TimeoutError as exc:
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
        if conversation is None or conversation.deleted_at is not None or conversation.title is not None:
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
```

- [ ] **Step 4: Run title helper tests**

Run:

```bash
uv run pytest tests/worker/test_auto_title.py -v
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/worker/title.py tests/worker/test_auto_title.py
git commit -m "feat: add auto title worker helper"
```

---

### Task 6: Executor Integration

**Files:**
- Modify: `app/worker/executor.py`
- Test: `tests/worker/test_executor.py`
- Test: `tests/worker/test_executor_batching.py`

- [ ] **Step 1: Write failing executor integration assertions**

Update `queue_run()` in `tests/worker/test_executor.py`:

```python
async def queue_run(
    session: AsyncSession,
    provider_name: str = "fake",
    conversation_title: str | None = "Chat",
) -> int:
```

Inside `queue_run()`, create the conversation with the configurable title:

```python
conversation = Conversation(user_id=user.id, title=conversation_title)
```

In `test_execute_run_streams_deltas_marks_succeeded_and_materializes_message`, create a draft with no manual title:

```python
run_id = await queue_run(session, conversation_title=None)
```

Add assertions after loading messages:

```python
conversation = await session.get(Conversation, run.conversation_id)
assert conversation is not None
assert conversation.activated_at is not None
assert conversation.title == "Fake Title"
```

Add this cancellation assertion in `test_execute_run_marks_cancelled_when_status_flips_during_stream`:

```python
conversation = await session.get(Conversation, run.conversation_id)
assert conversation is not None
assert conversation.activated_at is None
```

- [ ] **Step 2: Run executor tests and confirm they fail**

Run:

```bash
uv run pytest tests/worker/test_executor.py tests/worker/test_executor_batching.py -v
```

Expected: fail because executor does not call `maybe_generate_title()` yet.

- [ ] **Step 3: Call title generation after the success commit**

In `app/worker/executor.py`, import:

```python
from app.worker.title import maybe_generate_title
```

Replace the `Finish` branch success transaction with this structure:

```python
            elif isinstance(chunk, Finish):
                if pending and not await flush_pending():
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
                full_text = "".join(text_parts)
                async with session_factory() as session:
                    changed = await mark_run_succeeded(
                        session,
                        run_id=run_id,
                        usage=chunk.usage,
                        provider_request_id=chunk.provider_request_id,
                    )
                    if changed:
                        await materialize_assistant_message(
                            session,
                            run_id=run_id,
                            content=full_text,
                        )
                    await session.commit()
                if not changed:
                    return _StreamOutcome(
                        status="cancelled",
                        before_first_delta=not first_flush_done,
                        delta_persisted=first_flush_done,
                    )
                await maybe_generate_title(
                    session_factory=session_factory,
                    run_id=run_id,
                    settings=settings,
                    resolve_provider=resolve_provider,
                )
                return _StreamOutcome(
                    status="succeeded",
                    before_first_delta=not first_flush_done,
                    delta_persisted=first_flush_done,
                )
```

Thread `settings` and `resolve_provider` into `_run_provider_stream_until_done_or_cancelled()` and `_run_provider_stream()`:

```python
outcome = await _run_provider_stream_until_done_or_cancelled(
    session_factory=session_factory,
    run_id=run_id,
    provider=provider,
    provider_model=provider_model,
    messages=messages,
    cancel_event=cancel_event,
    batch_window_seconds=settings.worker_delta_batch_window_ms / 1000.0,
    batch_max_chars=settings.worker_delta_batch_max_chars,
    settings=settings,
    resolve_provider=resolve_provider,
)
```

Add parameters to both function signatures:

```python
    settings: Settings,
    resolve_provider: ProviderResolver,
```

Pass them from `_run_provider_stream_until_done_or_cancelled()` into `_run_provider_stream()`.

- [ ] **Step 4: Run executor tests**

Run:

```bash
uv run pytest tests/worker/test_executor.py tests/worker/test_executor_batching.py -v
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/worker/executor.py tests/worker/test_executor.py
git commit -m "feat: generate title after successful run"
```

---

### Task 7: Frontend Draft State And Refresh

**Files:**
- Modify: `frontend/state.js`
- Modify: `frontend/auth.js`
- Modify: `frontend/views/chat.js`
- Test: `frontend/views/chat.test.js`

- [ ] **Step 1: Write failing source-level frontend tests**

Update the file reads at the top of `frontend/views/chat.test.js`:

```javascript
const chatSource = readFileSync(new URL("./chat.js", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../state.js", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../auth.js", import.meta.url), "utf8");
const loginSource = readFileSync(new URL("./login.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
```

Add tests:

```javascript
test("keeps newly created draft conversations out of the sidebar list", () => {
  assert.match(chatSource, /draftConversationId:\s*conv\.id/);
  assert.doesNotMatch(chatSource, /conversations:\s*\[conv,\s*\.\.\.getState\(\)\.conversations\]/);
});

test("persists selected and draft conversation ids in localStorage", () => {
  assert.match(stateSource, /ichat\.selectedId/);
  assert.match(stateSource, /ichat\.draftConversationId/);
  assert.match(stateSource, /readStoredConversationIds/);
  assert.match(stateSource, /clearStoredConversationSelection/);
});

test("restores the selected draft conversation when chat view starts", () => {
  assert.match(chatSource, /readStoredConversationIds/);
  assert.match(chatSource, /void selectConversation\(persistedSelected\)/);
});

test("refreshes conversation list and clears draft marker after a successful run", () => {
  assert.match(chatSource, /if \(terminalKind === "succeeded"\)[\s\S]*await loadConversations\(\)/);
  assert.match(chatSource, /draftConversationId === conversationId/);
  assert.match(chatSource, /draftConversationId:\s*null/);
});

test("clears persisted conversation selection on logout", () => {
  assert.match(authSource, /clearStoredConversationSelection/);
  assert.match(authSource, /save\(null\)/);
});
```

- [ ] **Step 2: Run frontend tests and confirm they fail**

Run:

```bash
node --test frontend/views/chat.test.js
```

Expected: fail because draft state persistence and refresh logic do not exist.

- [ ] **Step 3: Add selected/draft persistence helpers**

Replace `frontend/state.js` with:

```javascript
const listeners = new Set();
const SELECTED_KEY = "ichat.selectedId";
const DRAFT_KEY = "ichat.draftConversationId";

const state = {
  conversations: [],            // ConversationResponse[]
  selectedId: null,             // number | null
  draftConversationId: null,    // number | null
  detail: null,                 // ConversationDetailResponse | null（选中 conversation 的完整消息）
  activeRun: null,              // { runId, status, controller, draftText, assistantPlaceholderId } | null
  sidebarOpen: false,           // mobile conversation drawer state
};

export function getState() { return state; }

export function setState(patch) {
  Object.assign(state, patch);
  if (Object.prototype.hasOwnProperty.call(patch, "selectedId")) {
    persistNumber(SELECTED_KEY, patch.selectedId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "draftConversationId")) {
    persistNumber(DRAFT_KEY, patch.draftConversationId);
  }
  for (const l of listeners) l(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readStoredConversationIds() {
  return {
    selectedId: readNumber(SELECTED_KEY),
    draftConversationId: readNumber(DRAFT_KEY),
  };
}

export function clearStoredConversationSelection() {
  const store = storage();
  if (!store) return;
  store.removeItem(SELECTED_KEY);
  store.removeItem(DRAFT_KEY);
}

function persistNumber(key, value) {
  const store = storage();
  if (!store) return;
  if (typeof value === "number" && Number.isFinite(value)) {
    store.setItem(key, String(value));
  } else {
    store.removeItem(key);
  }
}

function readNumber(key) {
  const store = storage();
  if (!store) return null;
  const value = Number(store.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function storage() {
  return globalThis.localStorage ?? null;
}
```

- [ ] **Step 4: Clear persisted selection during logout and auth expiry**

In `frontend/auth.js`, import:

```javascript
import { clearStoredConversationSelection } from "./state.js";
```

Update `logout()`:

```javascript
export async function logout() {
  const state = current;
  current = null;
  save(null);
  clearStoredConversationSelection();
  if (state?.refreshToken) {
    try { await authApi.logout(state.refreshToken); } catch {}
  }
}
```

Update refresh failure handling:

```javascript
    } catch (refreshErr) {
      current = null;
      save(null);
      clearStoredConversationSelection();
      throw refreshErr;
    }
```

- [ ] **Step 5: Restore selected draft on chat view startup**

In `frontend/views/chat.js`, update imports:

```javascript
import {
  clearStoredConversationSelection,
  getState,
  readStoredConversationIds,
  setState,
  subscribe,
} from "../state.js";
```

Replace `renderChatView()`:

```javascript
export function renderChatView(container, { onLoggedOut }) {
  const { selectedId: persistedSelected, draftConversationId: persistedDraft } =
    readStoredConversationIds();
  if (persistedSelected) {
    setState({
      selectedId: persistedSelected,
      draftConversationId: persistedDraft,
      detail: null,
    });
  }
  container.replaceChildren(buildShell({ onLoggedOut }));
  const unsubscribe = subscribe(() => { rerenderSidebar(); rerenderMain(); });
  container._chatUnsubscribe = unsubscribe;
  void loadConversations();
  if (persistedSelected) {
    void selectConversation(persistedSelected);
  }
}
```

- [ ] **Step 6: Keep new drafts out of the sidebar**

Replace `createEmptyConversation()`:

```javascript
async function createEmptyConversation() {
  const conv = await withAuth((t) => api.conversations.create(t, null));
  setState({
    selectedId: conv.id,
    draftConversationId: conv.id,
    detail: Object.assign({}, conv, { messages: [] }),
  });
  return conv;
}
```

Update `selectConversation()` to clear the draft marker when the selected conversation is already activated:

```javascript
async function selectConversation(id) {
  setState({ selectedId: id, detail: null });
  try {
    const detail = await withAuth((t) => api.conversations.detail(t, id));
    if (getState().selectedId !== id) return;
    const patch = { detail };
    if (detail.activated_at && getState().draftConversationId === id) {
      patch.draftConversationId = null;
    }
    setState(patch);
    await maybeResumeRun(detail);
  } catch (err) {
    toast(errorMessage(err, "加载对话失败"), "error");
  }
}
```

- [ ] **Step 7: Refresh list/detail after successful runs**

In `attachRunStream()` final success branch, replace the `terminalKind === "succeeded"` block:

```javascript
    if (terminalKind === "succeeded") {
      await loadConversations();
      try {
        const detail = await withAuth((t) => api.conversations.detail(t, conversationId));
        if (getState().selectedId === conversationId) {
          const patch = { detail };
          if (getState().draftConversationId === conversationId) {
            patch.draftConversationId = null;
          }
          setState(patch);
        } else if (getState().draftConversationId === conversationId) {
          setState({ draftConversationId: null });
        }
      } catch {
        markAssistantTerminal(placeholderId, "succeeded");
      }
```

Update `deleteConversation()` setState patch:

```javascript
    setState({
      conversations: getState().conversations.filter((c) => c.id !== conv.id),
      selectedId: selectedId === conv.id ? null : selectedId,
      draftConversationId: selectedId === conv.id ? null : getState().draftConversationId,
      detail: selectedId === conv.id ? null : getState().detail,
    });
```

- [ ] **Step 8: Run frontend tests**

Run:

```bash
node --test frontend/views/chat.test.js
```

Expected: all frontend source tests pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/state.js frontend/auth.js frontend/views/chat.js frontend/views/chat.test.js
git commit -m "feat: keep new conversations as drafts in frontend"
```

---

### Task 8: Integration Verification And Documentation

**Files:**
- Modify: `docs/handover/2026-05-20-auto-title-and-draft-conversation.md`

- [ ] **Step 1: Run backend focused tests**

Run:

```bash
uv run pytest tests/db/test_alembic.py tests/db/test_session.py tests/core/test_config.py tests/schemas/test_conversation_schemas.py tests/services/conversations/test_service.py tests/services/conversations/test_materialize.py tests/providers/test_fake.py tests/providers/test_deepseek_adapter.py tests/worker/test_auto_title.py tests/worker/test_executor.py tests/worker/test_executor_batching.py tests/worker/test_concurrency.py tests/api/test_conversations.py -v
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full test and quality suite**

Run:

```bash
uv run pytest
uv run ruff check app tests
uv run mypy app
node --test frontend/views/chat.test.js
docker compose config
```

Expected:
- pytest passes against local PostgreSQL.
- ruff prints `All checks passed`.
- mypy prints `Success: no issues found`.
- node test exits successfully.
- compose config renders without missing environment variable errors.

- [ ] **Step 3: Run migration smoke locally**

Run:

```bash
DATABASE_URL=postgresql+asyncpg://ichat:ichat_password@localhost:5432/ichat uv run alembic upgrade head
```

Expected: Alembic upgrades through `20260519_0002`; existing conversations get `activated_at = created_at`.

- [ ] **Step 4: Create handover document**

Create `docs/handover/2026-05-20-auto-title-and-draft-conversation.md` with these sections:

```markdown
# 2026-05-20 草稿对话与自动标题交接

## 本次完成

- 新增 `conversations.activated_at` 并回填旧数据。
- Conversation 列表只返回已激活对话，详情/rename/delete/send/regenerate 仍允许 owner 操作草稿。
- Worker 成功物化 assistant message 时同事务激活 conversation。
- Provider ABC 和 DeepSeek adapter 支持非流式 `summarize()`。
- Worker 在 run 成功提交后 best-effort 生成标题，失败只记录日志。
- 前端新建对话不进入侧栏，selected/draft id 写入 localStorage，run 成功后刷新列表和详情。

## 关键文件

- `alembic/versions/20260519_0002_add_conversation_activation.py`
- `app/services/conversations/service.py`
- `app/worker/title.py`
- `app/worker/executor.py`
- `app/providers/types.py`
- `app/providers/deepseek.py`
- `frontend/state.js`
- `frontend/views/chat.js`

## 行为说明

- `POST /api/v1/conversations` 返回 `activated_at: null`。
- `GET /api/v1/conversations` 过滤 `activated_at IS NOT NULL`。
- `GET /api/v1/conversations/{id}` 不过滤 `activated_at`。
- cancel/failed run 不激活 conversation。
- 标题生成只在首个 succeeded run 且 `title IS NULL` 时尝试一次。

## 验证

记录 Task 8 Step 2 的实际命令输出摘要。

## 注意事项

- 标题生成在 run 成功事务提交后执行，不新增 SSE title event。
- 如果标题生成失败或前端刷新早于标题写回，UI 保持“新对话”占位。
- 不做草稿 GC。
```

- [ ] **Step 5: Commit**

```bash
git add docs/handover/2026-05-20-auto-title-and-draft-conversation.md
git commit -m "docs: hand over draft conversation auto title feature"
```

---

## Self-Review

- Spec coverage:
  - Draft persistence and activation: Tasks 1, 2, 3, 6, 7.
  - Existing data backfill: Task 1.
  - Provider summarize and DeepSeek behavior: Task 4.
  - Worker post-commit title generation: Tasks 5 and 6.
  - Frontend draft invisibility, localStorage restore, success refresh: Task 7.
  - Verification matrix: Task 8.
- Placeholder scan: the plan contains concrete files, functions, commands, and expected outcomes for each implementation step.
- Type consistency:
  - `activated_at` is `datetime | None` in ORM and schema.
  - `Provider.summarize()` returns `str` and accepts `model`, `messages`, `max_output_tokens`.
  - Worker title helper accepts `resolve_provider` with the same call shape as `execute_run()`.
  - Frontend state uses `draftConversationId` consistently.
