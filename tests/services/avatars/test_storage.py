import re

from app.core.config import get_settings
from app.services.avatars.storage import public_avatar_url, public_object_key, temporary_object_key


def test_avatar_object_keys_are_random_and_identity_free() -> None:
    temporary = temporary_object_key()
    public = public_object_key()

    assert re.fullmatch(r"avatar-uploads/[0-9a-f-]{36}\.webp", temporary)
    assert re.fullmatch(r"avatars/[0-9a-f-]{36}\.webp", public)
    for identity in ("42", "alice", "alice@example.com", "photo.png"):
        assert identity not in temporary
        assert identity not in public


def test_public_avatar_url_uses_configured_base() -> None:
    settings = get_settings().model_copy(
        update={"avatar_public_base_url": "https://assets.example.com/"}
    )
    assert (
        public_avatar_url(settings, "avatars/value.webp")
        == "https://assets.example.com/avatars/value.webp"
    )
    assert public_avatar_url(settings, None) is None
