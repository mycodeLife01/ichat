"""Compatibility imports for callers not yet moved to ``services.files``.

The expand phase keeps this module path so operational scripts do not break,
but avatar lifecycle state is now owned by the unified files domain.
"""

from app.services.files.avatar import deactivate_user_avatar, take_down_user_avatar

__all__ = ["deactivate_user_avatar", "take_down_user_avatar"]
