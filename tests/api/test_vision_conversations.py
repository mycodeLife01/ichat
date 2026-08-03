"""HTTP seam contracts for vision-dependent conversation commands."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.messages import AttachmentNoticeBlock, ImageBlock
from app.core.config import get_settings
from app.models.conversation import Conversation, Message
from app.models.files import (
    FileAsset,
    FileModelInputKind,
    FileObject,
    FileObjectRole,
    FilePurpose,
    FileStorageLocation,
    MessageAttachment,
)
from app.models.run import Run, RunProviderMessage
from app.models.user import User
from app.services.runs.transcript import serialize_blocks
from tests.api.test_conversations import auth_headers, register_user, seed_completed_turn

# The conversation API module owns the real PostgreSQL + ASGI fixtures.  Loading
# it as a plugin keeps this module on the same database lifecycle rather than
# introducing a second set of test-only application wiring.
pytest_plugins = ("tests.api.test_conversations",)


TEST_EMAIL_DOMAIN = "conversation-api-test.example.com"


@pytest.fixture()
def vision_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Expose one deterministic DeepSeek + GPT vision catalog to the API."""

    values = {
        "DEEPSEEK_MODELS": "deepseek-v4-flash",
        "OPENAI_API_KEY": "sk-test",
        "OPENAI_MODELS": "gpt-5-mini",
        "OPENAI_VISION_MODELS": "gpt-5-mini",
        "OPENAI_IMAGE_TOKEN_RESERVE": "8192",
        "FILES_R2_ENDPOINT_URL": "https://r2.test.invalid",
        "FILES_STAGING_BUCKET": "staging-test",
        "FILES_CANONICAL_BUCKET": "canonical-test",
        "FILES_PREVIEW_BUCKET": "preview-test",
        "FILES_PREVIEW_API_ACCESS_KEY_ID": "preview-api",
        "FILES_PREVIEW_API_SECRET_ACCESS_KEY": "preview-secret",
        "FILE_UPLOAD_ENABLED": "false",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()

async def _create_bound_image_turn(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_email: str,
    legacy: bool,
    position: int = 1,
    provider_name: str | None = None,
    provider_model: str | None = None,
) -> dict[str, Any]:
    """Persist a completed image turn with either an image or legacy notice."""

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == user_email))
        assert user is not None
        now = datetime.now(UTC)
        conversation = await session.scalar(
            select(Conversation).where(Conversation.user_id == user.id).order_by(Conversation.id)
        )
        if conversation is None:
            conversation = Conversation(
                user_id=user.id,
                title="vision test",
                activated_at=now,
                updated_at=now,
            )
            session.add(conversation)
            await session.flush()

        message = Message(
            conversation_id=conversation.id,
            role="user",
            content="Describe this image",
            position=position,
        )
        session.add(message)
        await session.flush()
        run = Run(
            conversation_id=conversation.id,
            user_message_id=message.id,
            status="succeeded",
            provider_name=provider_name or ("deepseek" if legacy else "openai"),
            provider_model=provider_model or ("deepseek-v4-flash" if legacy else "gpt-5-mini"),
        )
        session.add(run)
        await session.flush()
        message.run_id = run.id

        asset = FileAsset(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename=f"photo-{position}.png",
            media_type="image/png",
            size_bytes=64,
            sha256="a" * 64,
            extractor_version="image-v1",
            summary_metadata={"width": 640, "height": 480},
            model_input_kind=FileModelInputKind.IMAGE,
            bound_at=now,
            source_message_id=message.id,
        )
        session.add(asset)
        await session.flush()
        preview = FileObject(
            file_id=asset.id,
            role=FileObjectRole.PREVIEW,
            storage_location=FileStorageLocation.MODEL_PREVIEW_PRIVATE,
            object_key=f"preview/{asset.public_id}",
            media_type="image/webp",
            size_bytes=32,
            sha256="b" * 64,
        )
        session.add(preview)
        session.add(
            MessageAttachment(
                message_id=message.id,
                file_id=asset.id,
                position=0,
                name=asset.original_filename,
                media_type=asset.media_type,
                size_bytes=asset.size_bytes,
            )
        )
        block = (
            AttachmentNoticeBlock(
                file_id=str(asset.public_id),
                filename=asset.original_filename,
                media_type=asset.media_type,
            )
            if legacy
            else ImageBlock(
                file_id=str(asset.public_id),
                filename=asset.original_filename,
                media_type="image/webp",
                sha256="b" * 64,
                width=640,
                height=480,
                processor_version="image-v1",
            )
        )
        session.add(
            RunProviderMessage(
                run_id=run.id,
                seq=1,
                message_id=message.id,
                role="user",
                blocks=serialize_blocks([block]),
                estimated_tokens=1,
            )
        )
        assistant = Message(
            conversation_id=conversation.id,
            run_id=run.id,
            role="assistant",
            content="A completed answer",
            position=position + 1,
        )
        session.add(assistant)
        await session.commit()
        return {
            "conversation_id": conversation.public_id,
            "user_message_id": message.public_id,
            "assistant_message_id": assistant.public_id,
            "conversation_db_id": conversation.id,
            "user_message_db_id": message.id,
            "assistant_message_db_id": assistant.id,
            "run_db_id": run.id,
            "run_public_id": run.public_id,
            "asset_db_id": asset.id,
            "asset_public_id": asset.public_id,
        }


async def _create_plain_turn(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_email: str,
) -> dict[str, Any]:
    return await seed_completed_turn(session_factory, user_email=user_email)


async def _create_unbound_image_asset(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    user_email: str,
) -> dict[str, Any]:
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == user_email))
        assert user is not None
        asset = FileAsset(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="new-image.png",
            media_type="image/png",
            size_bytes=64,
            sha256="a" * 64,
            extractor_version="image-v1",
            summary_metadata={"width": 640, "height": 480},
            model_input_kind=FileModelInputKind.IMAGE,
            unbound_expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        session.add(asset)
        await session.flush()
        session.add(
            FileObject(
                file_id=asset.id,
                role=FileObjectRole.PREVIEW,
                storage_location=FileStorageLocation.MODEL_PREVIEW_PRIVATE,
                object_key=f"preview/{asset.public_id}",
                media_type="image/webp",
                size_bytes=32,
                sha256="b" * 64,
            )
        )
        await session.commit()
        return {"db_id": asset.id, "public_id": asset.public_id}


async def _count_for_conversation(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    conversation_id: int,
) -> tuple[int, int, int, int]:
    async with session_factory() as session:
        messages = list(
            (
                await session.scalars(
                    select(Message).where(Message.conversation_id == conversation_id)
                )
            ).all()
        )
        return (
            len(messages),
            len(
                list(
                    (
                        await session.scalars(
                            select(Run).where(Run.conversation_id == conversation_id)
                        )
                    ).all()
                )
            ),
            len(
                list(
                    (
                        await session.scalars(
                            select(MessageAttachment)
                            .join(Message, Message.id == MessageAttachment.message_id)
                            .where(Message.conversation_id == conversation_id)
                        )
                    ).all()
                )
            ),
            sum(message.archived_at is not None for message in messages),
        )


def _assert_machine_error(response: Any, *, status_code: int, code: str) -> None:
    assert response.status_code == status_code, response.text
    body = response.json()
    assert body["code"] == code
    assert isinstance(body["detail"], str)


async def test_with_message_vision_model_persists_image_snapshot(
    vision_environment: None,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    username = "alice-first-vision"
    email = f"{username}@{TEST_EMAIL_DOMAIN}"
    token = await register_user(client, username=username, email=email)
    headers = auth_headers(token)
    asset = await _create_unbound_image_asset(session_factory, user_email=email)

    response = await client.post(
        "/api/v1/conversations/with-message",
        json={
            "title": "Vision chat",
            "content": "What is in this image?",
            "attachment_ids": [str(asset["public_id"])],
            "model": "gpt-5-mini",
        },
        headers=headers,
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body = response.json()["data"]
    assert body["run"]["provider_name"] == "openai"
    assert body["run"]["provider_model"] == "gpt-5-mini"
    assert body["message"]["attachments"][0]["name"] == "new-image.png"
    assert body["image_context"]["state"] == "vision_required"
    assert body["image_context"]["recommended_model"] == "gpt-5-mini"
    assert body["image_context"].get("legacy_message_id") is None
    async with session_factory() as session:
        stored_asset = await session.get(FileAsset, asset["db_id"])
        assert stored_asset is not None and stored_asset.bound_at is not None
        message = await session.scalar(
            select(Message).where(Message.public_id == UUID(body["message"]["id"]))
        )
        assert message is not None
        run = await session.scalar(select(Run).where(Run.public_id == UUID(body["run"]["id"])))
        assert run is not None and run.provider_name == "openai"
        transcript = await session.scalar(
            select(RunProviderMessage).where(
                RunProviderMessage.run_id == run.id,
                RunProviderMessage.message_id == message.id,
            )
        )
        assert transcript is not None and transcript.blocks is not None
        assert transcript.blocks[1]["type"] == "image"


@pytest.mark.parametrize("entry", ["with-message", "send", "edit"])
async def test_image_on_nonvision_model_is_rejected_before_any_mutation(
    entry: Literal["with-message", "send", "edit"],
    vision_environment: None,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    username = f"alice-image-reject-{entry}"
    email = f"{username}@{TEST_EMAIL_DOMAIN}"
    token = await register_user(client, username=username, email=email)
    headers = auth_headers(token)

    if entry == "with-message":
        conversation_id: str | None = None
    else:
        create_response = await client.post("/api/v1/conversations", json={}, headers=headers)
        assert create_response.status_code == status.HTTP_201_CREATED
        conversation_id = create_response.json()["data"]["id"]

    if entry == "edit":
        seeded = await _create_plain_turn(session_factory, user_email=email)
        conversation_id = seeded["conversation_id"]
        target_message_id = seeded["user_message_id"]

    async with session_factory() as session:
        from app.models.user import User

        user = await session.scalar(select(User).where(User.email == email))
        assert user is not None
        now = datetime.now(UTC)
        asset = FileAsset(
            user_id=user.id,
            purpose=FilePurpose.MESSAGE_ATTACHMENT,
            original_filename="new-image.png",
            media_type="image/png",
            size_bytes=64,
            model_input_kind=FileModelInputKind.IMAGE,
            unbound_expires_at=now + timedelta(hours=1),
        )
        session.add(asset)
        await session.commit()
        asset_public_id = asset.public_id

    path = "/api/v1/conversations/with-message"
    if entry == "send":
        path = f"/api/v1/conversations/{conversation_id}/messages"
    elif entry == "edit":
        path = (
            f"/api/v1/conversations/{conversation_id}/messages/{target_message_id}/"
            "edit-and-regenerate"
        )
    payload = {"content": "What is in this image?", "attachment_ids": [str(asset_public_id)]}
    if entry != "with-message":
        payload["model"] = "deepseek-v4-flash"
    else:
        payload["model"] = "deepseek-v4-flash"
        payload["title"] = "Vision rejection"
    response = await client.post(path, json=payload, headers=headers)

    _assert_machine_error(
        response,
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        code="IMAGE_INPUT_NOT_SUPPORTED",
    )
    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == email))
        assert user is not None
        stored_asset = await session.scalar(
            select(FileAsset).where(FileAsset.public_id == asset_public_id)
        )
        assert stored_asset is not None
        assert stored_asset.bound_at is None
        assert (
            await session.scalar(
                select(MessageAttachment.id).where(MessageAttachment.file_id == stored_asset.id)
            )
        ) is None
        if entry == "with-message":
            assert (
                await session.scalar(select(Conversation.id).where(Conversation.user_id == user.id))
                is None
            )
        else:
            conversation = await session.scalar(
                select(Conversation).where(Conversation.public_id == UUID(str(conversation_id)))
            )
            assert conversation is not None
            expected = (2, 1, 0, 0) if entry == "edit" else (0, 0, 0, 0)
            messages = list(
                (
                    await session.scalars(
                        select(Message).where(Message.conversation_id == conversation.id)
                    )
                ).all()
            )
            runs = list(
                (
                    await session.scalars(
                        select(Run).where(Run.conversation_id == conversation.id)
                    )
                ).all()
            )
            attachments = list(
                (
                    await session.scalars(
                        select(MessageAttachment)
                        .join(Message, Message.id == MessageAttachment.message_id)
                        .where(Message.conversation_id == conversation.id)
                    )
                ).all()
            )
            assert (
                len(messages),
                len(runs),
                len(attachments),
                sum(message.archived_at is not None for message in messages),
            ) == expected


@pytest.mark.parametrize("entry", ["send", "edit", "regenerate"])
async def test_existing_vision_context_rejects_deepseek_without_mutation(
    entry: Literal["send", "edit", "regenerate"],
    vision_environment: None,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    username = f"alice-vision-required-{entry}"
    email = f"{username}@{TEST_EMAIL_DOMAIN}"
    token = await register_user(client, username=username, email=email)
    headers = auth_headers(token)
    seeded = await _create_bound_image_turn(session_factory, user_email=email, legacy=False)
    if entry == "send":
        path = f"/api/v1/conversations/{seeded['conversation_id']}/messages"
        payload: dict[str, Any] = {"content": "Follow up", "model": "deepseek-v4-flash"}
    elif entry == "edit":
        path = (
            f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
            f"{seeded['user_message_id']}/edit-and-regenerate"
        )
        payload = {"content": "Rewrite", "model": "deepseek-v4-flash"}
    else:
        path = (
            f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
            f"{seeded['assistant_message_id']}/regenerate"
        )
        payload = {"model": "deepseek-v4-flash"}
    before = await _count_for_conversation(
        session_factory, conversation_id=seeded["conversation_db_id"]
    )
    response = await client.post(path, json=payload, headers=headers)
    _assert_machine_error(
        response,
        status_code=status.HTTP_409_CONFLICT,
        code="VISION_MODEL_REQUIRED",
    )
    assert await _count_for_conversation(
        session_factory, conversation_id=seeded["conversation_db_id"]
    ) == before
    async with session_factory() as session:
        asset = await session.get(FileAsset, seeded["asset_db_id"])
        assert asset is not None and asset.bound_at is not None


@pytest.mark.parametrize("entry", ["send", "edit", "regenerate"])
async def test_gpt_selection_rejects_legacy_context_at_earliest_anchor(
    entry: Literal["send", "edit", "regenerate"],
    vision_environment: None,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    username = f"alice-legacy-reject-{entry}"
    email = f"{username}@{TEST_EMAIL_DOMAIN}"
    token = await register_user(client, username=username, email=email)
    headers = auth_headers(token)
    first = await _create_bound_image_turn(
        session_factory, user_email=email, legacy=True, position=1
    )
    second = await _create_bound_image_turn(
        session_factory, user_email=email, legacy=True, position=3
    )
    if entry == "send":
        path = f"/api/v1/conversations/{first['conversation_id']}/messages"
        payload: dict[str, Any] = {"content": "Follow up", "model": "gpt-5-mini"}
    elif entry == "edit":
        path = (
            f"/api/v1/conversations/{first['conversation_id']}/messages/"
            f"{second['user_message_id']}/edit-and-regenerate"
        )
        payload = {"content": "Rewrite", "model": "gpt-5-mini"}
    else:
        path = (
            f"/api/v1/conversations/{first['conversation_id']}/messages/"
            f"{second['assistant_message_id']}/regenerate"
        )
        payload = {"model": "gpt-5-mini"}
    before = await _count_for_conversation(
        session_factory, conversation_id=first["conversation_db_id"]
    )
    response = await client.post(path, json=payload, headers=headers)
    _assert_machine_error(
        response,
        status_code=status.HTTP_409_CONFLICT,
        code="LEGACY_IMAGE_CONTEXT",
    )
    assert response.json()["legacy_message_id"] == str(first["user_message_id"])
    assert await _count_for_conversation(
        session_factory, conversation_id=first["conversation_db_id"]
    ) == before


async def test_edit_removes_last_vision_image_and_switches_to_deepseek(
    vision_environment: None,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    username = "alice-remove-last-image"
    email = f"{username}@{TEST_EMAIL_DOMAIN}"
    token = await register_user(client, username=username, email=email)
    headers = auth_headers(token)
    seeded = await _create_bound_image_turn(session_factory, user_email=email, legacy=False)

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['user_message_id']}/edit-and-regenerate",
        json={
            "content": "No image now",
            "attachment_ids": [],
            "model": "deepseek-v4-flash",
        },
        headers=headers,
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body = response.json()["data"]
    assert body["run"]["provider_name"] == "deepseek"
    assert body["run"]["provider_model"] == "deepseek-v4-flash"
    assert body["message"]["attachments"] == []
    assert body["image_context"]["state"] == "none"
    async with session_factory() as session:
        asset = await session.get(FileAsset, seeded["asset_db_id"])
        assert asset is not None and asset.detached_at is not None
        new_message = await session.scalar(
            select(Message).where(Message.public_id == UUID(body["message"]["id"]))
        )
        assert new_message is not None and new_message.archived_at is None
        old_message = await session.get(Message, seeded["user_message_db_id"])
        old_assistant = await session.get(Message, seeded["assistant_message_db_id"])
        assert old_message is not None and old_message.archived_at is not None
        assert old_assistant is not None and old_assistant.archived_at is not None


@pytest.mark.parametrize("terminal_status", ["failed", "cancelled"])
async def test_legacy_regenerate_commits_image_snapshot_and_never_rolls_back(
    terminal_status: Literal["failed", "cancelled"],
    vision_environment: None,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    username = f"alice-legacy-upgrade-{terminal_status}"
    email = f"{username}@{TEST_EMAIL_DOMAIN}"
    token = await register_user(client, username=username, email=email)
    headers = auth_headers(token)
    seeded = await _create_bound_image_turn(session_factory, user_email=email, legacy=True)

    response = await client.post(
        f"/api/v1/conversations/{seeded['conversation_id']}/messages/"
        f"{seeded['assistant_message_id']}/regenerate",
        json={"model": "gpt-5-mini"},
        headers=headers,
    )
    assert response.status_code == status.HTTP_201_CREATED, response.text
    body = response.json()["data"]
    assert body["message"]["id"] == str(seeded["user_message_id"])
    assert body["message"]["run_id"] == body["run"]["id"]
    assert body["image_context"]["state"] == "vision_required"
    new_run_public_id = UUID(body["run"]["id"])

    async with session_factory() as session:
        message = await session.get(Message, seeded["user_message_db_id"])
        assert message is not None
        new_run = await session.scalar(select(Run).where(Run.public_id == new_run_public_id))
        assert new_run is not None and message.run_id == new_run.id
        transcript = await session.scalar(
            select(RunProviderMessage).where(
                RunProviderMessage.run_id == new_run.id,
                RunProviderMessage.message_id == message.id,
            )
        )
        assert transcript is not None
        assert transcript.blocks is not None
        assert any(block["type"] == "image" for block in transcript.blocks)
        old_assistant = await session.get(Message, seeded["assistant_message_db_id"])
        assert old_assistant is not None and old_assistant.archived_at is not None
        new_run.status = terminal_status
        await session.commit()

    detail = await client.get(
        f"/api/v1/conversations/{seeded['conversation_id']}", headers=headers
    )
    assert detail.status_code == status.HTTP_200_OK
    detail_data = detail.json()["data"]
    current_user_message = next(
        message
        for message in detail_data["messages"]
        if message["id"] == str(seeded["user_message_id"])
    )
    assert current_user_message["run_id"] == body["run"]["id"]
    assert detail_data["image_context"]["state"] == "vision_required"
