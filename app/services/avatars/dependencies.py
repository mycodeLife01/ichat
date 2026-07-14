from functools import lru_cache

from app.core.config import get_settings
from app.services.avatars.storage import R2AvatarStorage


@lru_cache
def get_avatar_api_storage() -> R2AvatarStorage:
    return R2AvatarStorage(get_settings(), worker=False)
