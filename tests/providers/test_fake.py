import pytest
from _pytest.monkeypatch import MonkeyPatch

from app.providers import Finish, ProviderError, ProviderMessage, TextDelta
from tests.providers.fake import FakeProvider, RaiseError, Sleep


async def test_fake_provider_yields_scripted_chunks() -> None:
    provider = FakeProvider(
        script=[
            TextDelta(text="Hello"),
            TextDelta(text=" world"),
            Finish(finish_reason="stop"),
        ]
    )

    chunks = []
    async for chunk in provider.stream(
        model="fake-model",
        messages=[ProviderMessage(role="user", content="hi")],
    ):
        chunks.append(chunk)

    assert chunks == [
        TextDelta(text="Hello"),
        TextDelta(text=" world"),
        Finish(finish_reason="stop"),
    ]


async def test_fake_provider_raises_when_script_says_to() -> None:
    provider = FakeProvider(
        script=[RaiseError(code="boom", message="bad")],
    )

    with pytest.raises(ProviderError) as exc_info:
        async for _ in provider.stream(
            model="fake-model",
            messages=[ProviderMessage(role="user", content="hi")],
        ):
            pass

    assert exc_info.value.code == "boom"


async def test_fake_provider_sleep_step_is_awaited(monkeypatch: MonkeyPatch) -> None:
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr("tests.providers.fake.asyncio.sleep", fake_sleep)

    provider = FakeProvider(
        script=[Sleep(seconds=0.5), Finish(finish_reason="stop")],
    )

    async for _ in provider.stream(
        model="fake-model",
        messages=[ProviderMessage(role="user", content="hi")],
    ):
        pass

    assert sleeps == [0.5]
