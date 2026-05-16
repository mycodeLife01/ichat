from typing import Annotated

from fastapi import Depends, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.db.session import get_session
from app.models.user import User
from app.services.auth.tokens import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    session: Annotated[AsyncSession, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> User:
    if credentials is None:
        raise AppError(status.HTTP_401_UNAUTHORIZED, "Authentication required")

    claims = decode_access_token(credentials.credentials, secret=settings.jwt_secret)
    user = await session.get(User, claims.user_id)
    if user is None or not user.is_active:
        raise AppError(status.HTTP_401_UNAUTHORIZED, "Invalid access token")
    return user
