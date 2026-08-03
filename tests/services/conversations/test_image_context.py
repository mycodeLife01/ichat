from uuid import UUID

import pytest
from fastapi import status

from app.agent.messages import AttachmentNoticeBlock, ImageBlock, TextBlock
from app.core.errors import AppError
from app.services.conversations.image_context import (
    ImageContextFacts,
    MessageImageFacts,
    _message_facts,
)
from app.services.conversations.service import _validate_existing_image_context


def _facts(
    *,
    message_id: int,
    position: int,
    vision_file_ids: frozenset[str] = frozenset(),
    legacy_file_ids: frozenset[str] = frozenset(),
) -> MessageImageFacts:
    return MessageImageFacts(
        message_id=message_id,
        message_public_id=UUID(int=message_id),
        position=position,
        vision_file_ids=vision_file_ids,
        legacy_file_ids=legacy_file_ids,
    )


def test_image_context_prioritizes_vision_over_legacy() -> None:
    facts = ImageContextFacts(
        (
            _facts(
                message_id=1,
                position=1,
                legacy_file_ids=frozenset({"legacy-file"}),
            ),
            _facts(
                message_id=2,
                position=2,
                vision_file_ids=frozenset({"vision-file"}),
            ),
        )
    )

    assert facts.state == "vision_required"
    assert facts.legacy_message_id is None


def test_image_context_reports_earliest_legacy_message_and_supports_branch_cut() -> None:
    facts = ImageContextFacts(
        (
            _facts(
                message_id=1,
                position=1,
                legacy_file_ids=frozenset({"first-legacy-file"}),
            ),
            _facts(
                message_id=2,
                position=2,
                legacy_file_ids=frozenset({"second-legacy-file"}),
            ),
            _facts(
                message_id=3,
                position=3,
                vision_file_ids=frozenset({"vision-file"}),
            ),
        )
    )

    assert facts.state == "vision_required"
    legacy_only = ImageContextFacts(facts.messages[:2])
    assert legacy_only.state == "legacy_upgrade_required"
    assert legacy_only.legacy_message_id == UUID(int=1)
    assert [message.message_id for message in facts.before(3).messages] == [1, 2]


def test_with_candidate_derives_blocks_without_reordering_existing_messages() -> None:
    facts = ImageContextFacts(
        (_facts(message_id=1, position=1),)
    )
    candidate = facts.with_candidate(
        message_id=2,
        message_public_id=UUID(int=2),
        position=2,
        blocks=(
            TextBlock("caption"),
            ImageBlock(
                file_id="vision-file",
                filename="diagram.webp",
                media_type="image/webp",
                sha256="a" * 64,
                width=640,
                height=480,
                processor_version="image-v1",
            ),
        ),
    )

    assert [message.message_id for message in candidate.messages] == [1, 2]
    assert candidate.state == "vision_required"
    candidate_facts = candidate.for_message(2)
    assert candidate_facts is not None
    assert candidate_facts.vision_file_ids == frozenset({"vision-file"})


def test_legacy_notice_blocks_are_classified_by_media_type() -> None:
    facts = _message_facts(
        message_id=1,
        message_public_id=UUID(int=1),
        position=1,
        blocks=[
            AttachmentNoticeBlock(
                file_id="image-file",
                filename="photo.png",
                media_type="image/png",
            )
        ],
    )
    assert facts.legacy_file_ids == frozenset({"image-file"})

    non_image = _message_facts(
        message_id=2,
        message_public_id=UUID(int=2),
        position=2,
        blocks=[
            AttachmentNoticeBlock(
                file_id="document-file",
                filename="facts.txt",
                media_type="text/plain",
            )
        ],
    )
    assert non_image.legacy_file_ids == frozenset()


@pytest.mark.parametrize(
    ("facts", "supports_image_input", "code", "status_code"),
    [
        (
            ImageContextFacts(
                (_facts(message_id=1, position=1, vision_file_ids=frozenset({"image"})),)
            ),
            False,
            "VISION_MODEL_REQUIRED",
            status.HTTP_409_CONFLICT,
        ),
        (
            ImageContextFacts(
                (_facts(message_id=1, position=1, legacy_file_ids=frozenset({"image"})),)
            ),
            True,
            "LEGACY_IMAGE_CONTEXT",
            status.HTTP_409_CONFLICT,
        ),
    ],
)
def test_validate_existing_image_context_returns_stable_machine_error(
    facts: ImageContextFacts,
    supports_image_input: bool,
    code: str,
    status_code: int,
) -> None:
    with pytest.raises(AppError) as exc_info:
        _validate_existing_image_context(
            facts,
            supports_image_input=supports_image_input,
        )

    assert exc_info.value.status_code == status_code
    assert exc_info.value.code == code
    if code == "LEGACY_IMAGE_CONTEXT":
        assert exc_info.value.context == {"legacy_message_id": str(UUID(int=1))}


def test_validate_existing_image_context_allows_compatible_models() -> None:
    _validate_existing_image_context(
        ImageContextFacts(
            (_facts(message_id=1, position=1, vision_file_ids=frozenset({"image"})),)
        ),
        supports_image_input=True,
    )
    _validate_existing_image_context(
        ImageContextFacts(
            (_facts(message_id=1, position=1, legacy_file_ids=frozenset({"image"})),)
        ),
        supports_image_input=False,
    )
