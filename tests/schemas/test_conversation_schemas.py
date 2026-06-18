from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.conversations import (
    ConversationCreateRequest,
    ConversationDetailResponse,
    ConversationRenameRequest,
    ConversationResponse,
    MessageCreateRequest,
    MessageResponse,
    RunResponse,
    SendMessageResponse,
)


def test_conversation_create_request_trims_blank_title_to_none() -> None:
    request = ConversationCreateRequest(title="   ")

    assert request.title is None


def test_conversation_create_request_trims_non_empty_title() -> None:
    request = ConversationCreateRequest(title="  Project chat  ")

    assert request.title == "Project chat"


def test_conversation_rename_request_rejects_blank_title() -> None:
    with pytest.raises(ValidationError):
        ConversationRenameRequest(title="   ")


def test_message_create_request_preserves_non_blank_content() -> None:
    request = MessageCreateRequest(content="  hello\n")

    assert request.content == "  hello\n"


def test_message_create_request_rejects_blank_content() -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(content=" \n\t ")


def test_conversation_detail_response_contains_visible_messages() -> None:
    now = datetime.now(UTC)
    conversation_id = uuid4()
    run_id = uuid4()
    message_id = uuid4()
    conversation = ConversationResponse(
        id=conversation_id,
        title="Project chat",
        activated_at=now,
        created_at=now,
        updated_at=now,
    )
    message = MessageResponse(
        id=message_id,
        conversation_id=conversation_id,
        run_id=run_id,
        role="user",
        content="Hello",
        position=1,
        created_at=now,
    )
    detail = ConversationDetailResponse(
        **conversation.model_dump(),
        messages=[message],
    )

    assert detail.id == conversation_id
    assert detail.activated_at == now
    assert detail.messages == [message]


def test_conversation_response_allows_null_activated_at() -> None:
    now = datetime.now(UTC)
    response = ConversationResponse(
        id=uuid4(),
        title=None,
        activated_at=None,
        created_at=now,
        updated_at=now,
    )

    assert response.activated_at is None


def test_send_message_response_contains_message_and_run() -> None:
    now = datetime.now(UTC)
    conversation_id = uuid4()
    run_id = uuid4()
    message_id = uuid4()
    message = MessageResponse(
        id=message_id,
        conversation_id=conversation_id,
        run_id=run_id,
        role="user",
        content="Hello",
        position=1,
        created_at=now,
    )
    run = RunResponse(
        id=run_id,
        conversation_id=conversation_id,
        user_message_id=message_id,
        status="queued",
        provider_name="deepseek",
        provider_model="deepseek-chat",
        created_at=now,
    )
    response = SendMessageResponse(message=message, run=run)

    assert response.message.id == message_id
    assert response.run.status == "queued"
