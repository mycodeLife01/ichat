import pytest

from app.providers.types import (
    Finish,
    ProviderError,
    ProviderMessage,
    TextDelta,
)


def test_provider_message_holds_role_and_content() -> None:
    message = ProviderMessage(role="user", content="Hello")

    assert message.role == "user"
    assert message.content == "Hello"


def test_text_delta_holds_text() -> None:
    delta = TextDelta(text="abc")

    assert delta.text == "abc"


def test_finish_holds_metadata() -> None:
    finish = Finish(
        finish_reason="stop",
        usage={"prompt_tokens": 3},
        provider_request_id="req-1",
    )

    assert finish.finish_reason == "stop"
    assert finish.usage == {"prompt_tokens": 3}
    assert finish.provider_request_id == "req-1"


def test_provider_error_carries_code_and_message() -> None:
    error = ProviderError(code="upstream_5xx", message="boom")

    assert error.code == "upstream_5xx"
    assert error.message == "boom"
    assert str(error) == "boom"


def test_reasoning_delta_is_a_frozen_value() -> None:
    from app.providers import ReasoningDelta

    a = ReasoningDelta(text="step 1")
    b = ReasoningDelta(text="step 1")
    assert a == b
    assert a.text == "step 1"
    with pytest.raises(AttributeError):
        a.text = "mutated"  # frozen dataclass


def test_default_count_tokens_is_conservative_estimate() -> None:
    from app.providers import Provider

    class MinimalProvider(Provider):
        @property
        def name(self) -> str:
            return "minimal"

        def stream(self, *, model, messages):  # type: ignore[no-untyped-def]
            raise NotImplementedError

        async def summarize(self, *, model, messages, max_output_tokens):  # type: ignore[no-untyped-def]
            raise NotImplementedError

    provider = MinimalProvider()
    # 10 English chars at 0.5 tokens/char
    assert provider.count_tokens("a" * 10) == 5
    # 10 CJK chars at 1.0 token/char
    assert provider.count_tokens("\u4e2d" * 10) == 10
    # Mixed, rounded up
    assert provider.count_tokens("abc\u4e2d") == 3  # ceil(3*0.5 + 1*1.0)
    assert provider.count_tokens("") == 0
