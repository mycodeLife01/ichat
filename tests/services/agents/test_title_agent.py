from app.core.config import get_settings
from app.services.agents.title_agent import (
    TitleAgent,
    build_title_agent,
    normalize_generated_title,
)
from tests.agent.fake import FakeProvider


def test_title_agent_builds_prompt_generates_and_normalizes_title() -> None:
    settings = get_settings().model_copy(
        update={
            "summary_provider_name": "fake",
            "summary_model": "fake-summary",
            "auto_title_max_chars": 12,
            "auto_title_max_output_tokens": 40,
        }
    )
    provider = FakeProvider(script=[], generate_result=' 《标题：  Project\nPlan For iChat》 ')

    def resolve(name: str, *, settings: object) -> FakeProvider:
        assert name == "fake"
        return provider

    agent = build_title_agent(settings=settings, resolve_provider=resolve)
    title = agent.generate(
        user_content="How should I plan the backend?",
        assistant_content="Start with the run state machine.",
    )

    assert title == "Project Plan"


def test_normalize_generated_title_returns_none_for_blank() -> None:
    assert normalize_generated_title("   ", max_chars=32) is None


def test_title_agent_receives_safe_attachment_metadata_not_document_body() -> None:
    class CaptureProvider:
        def __init__(self) -> None:
            self.messages: list[object] = []

        def generate(self, **kwargs: object) -> str:
            self.messages = list(kwargs["messages"])  # type: ignore[arg-type]
            return "Attachment plan"

    provider = CaptureProvider()
    agent = TitleAgent(  # type: ignore[arg-type]
        provider=provider,
        model="fake-summary",
        max_output_tokens=40,
        max_chars=32,
    )

    title = agent.generate(
        user_content="",
        assistant_content="I found three action items.",
        attachment_metadata='[{"name":"agenda.txt","media_type":"text/plain","size_bytes":321}]',
    )

    assert title == "Attachment plan"
    prompt = provider.messages[1].text()  # type: ignore[union-attr]
    assert "agenda.txt" in prompt
    assert "I found three action items." in prompt
    assert "document body" not in prompt
