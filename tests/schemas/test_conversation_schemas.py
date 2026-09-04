from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.conversations import (
    ConversationCreateRequest,
    ConversationCreateWithMessageRequest,
    ConversationCreateWithMessageResponse,
    ConversationDetailResponse,
    ConversationRenameRequest,
    ConversationResponse,
    MessageCreateRequest,
    MessageEditAndRegenerateRequest,
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


def test_message_create_request_accepts_attachment_only() -> None:
    attachment_id = uuid4()

    request = MessageCreateRequest(content="", attachment_ids=[attachment_id])

    assert request.content == ""
    assert request.attachment_ids == [attachment_id]


def test_message_create_request_accepts_reply_quote_only_and_normalizes_excerpt() -> None:
    source_id = uuid4()

    request = MessageCreateRequest(
        content="",
        reply_quote={
            "source_message_id": source_id,
            "excerpt": "  first\r\n  second  ",
            "source_anchor": {"version": 1, "start": 3, "end": 27},
        },
    )

    assert request.reply_quote is not None
    assert request.reply_quote.source_message_id == source_id
    assert request.reply_quote.excerpt == "first\n  second"
    assert request.reply_quote.source_anchor is not None
    assert request.reply_quote.source_anchor.model_dump() == {
        "version": 1,
        "start": 3,
        "end": 27,
    }


@pytest.mark.parametrize(
    "source_anchor",
    [
        {"version": 2, "start": 3, "end": 27},
        {"version": 1, "start": -1, "end": 27},
        {"version": 1, "start": 27, "end": 27},
        {"version": 1, "start": 28, "end": 27},
        {"version": 1, "start": 3, "end": 27, "unexpected": True},
    ],
)
def test_message_create_request_rejects_invalid_reply_quote_anchor(
    source_anchor: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(
            content="question",
            reply_quote={
                "source_message_id": uuid4(),
                "excerpt": "quoted",
                "source_anchor": source_anchor,
            },
        )


def test_message_create_request_keeps_legacy_reply_quote_without_anchor() -> None:
    request = MessageCreateRequest(
        content="question",
        reply_quote={"source_message_id": uuid4(), "excerpt": "quoted"},
    )

    assert request.reply_quote is not None
    assert request.reply_quote.source_anchor is None


@pytest.mark.parametrize("excerpt", ["   ", "x" * 4001])
def test_message_create_request_rejects_invalid_reply_quote_excerpt(excerpt: str) -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(
            content="",
            reply_quote={"source_message_id": uuid4(), "excerpt": excerpt},
        )


def test_message_create_request_rejects_reply_quote_without_source() -> None:
    with pytest.raises(ValidationError):
        MessageCreateRequest(content="", reply_quote={"excerpt": "quoted"})


def test_new_conversation_request_rejects_reply_quote() -> None:
    with pytest.raises(ValidationError):
        ConversationCreateWithMessageRequest(
            content="hello",
            reply_quote={"source_message_id": uuid4(), "excerpt": "quoted"},
        )


def test_edit_request_allows_empty_content_and_rejects_reply_quote() -> None:
    request = MessageEditAndRegenerateRequest(content="")
    assert request.content == ""

    with pytest.raises(ValidationError):
        MessageEditAndRegenerateRequest(
            content="",
            reply_quote={"source_message_id": uuid4(), "excerpt": "quoted"},
        )


def test_conversation_create_with_message_request_normalizes_fields() -> None:
    request = ConversationCreateWithMessageRequest(
        title="  Project chat  ",
        content="  hello\n",
        thinking_enabled=True,
    )

    assert request.title == "Project chat"
    assert request.content == "  hello\n"
    assert request.thinking_enabled is True


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


def test_message_response_preserves_reply_quote_when_source_is_missing() -> None:
    now = datetime.now(UTC)
    response = MessageResponse(
        id=uuid4(),
        conversation_id=uuid4(),
        run_id=None,
        role="user",
        content="",
        reply_quote={
            "source_message_id": None,
            "excerpt": "quoted",
            "source_anchor": {"version": 1, "start": 10, "end": 20},
        },
        position=3,
        created_at=now,
    )

    assert response.reply_quote is not None
    assert response.reply_quote.source_message_id is None
    assert response.reply_quote.excerpt == "quoted"
    assert response.reply_quote.source_anchor is not None
    assert response.reply_quote.source_anchor.start == 10


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

    create_response = ConversationCreateWithMessageResponse(
        conversation=ConversationResponse(
            id=conversation_id,
            title=None,
            activated_at=None,
            created_at=now,
            updated_at=now,
        ),
        message=message,
        run=run,
    )
    assert create_response.conversation.id == conversation_id
