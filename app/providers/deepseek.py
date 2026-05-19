from collections.abc import AsyncIterator
from typing import Any

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
            "thinking": {
                "type": "enabled" if self._settings.deepseek_thinking_enabled else "disabled"
            },
        }
        headers = {
            "Authorization": f"Bearer {self._settings.deepseek_api_key}",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }

        client_kwargs: dict[str, Any] = {
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
                        message=(
                            f"DeepSeek summarize returned {response.status_code}: "
                            f"{response.text[:500]}"
                        ),
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
