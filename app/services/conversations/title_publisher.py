from typing import Protocol


class TitleTaskPublisher(Protocol):
    def publish(self, run_id: int) -> None: ...


class CeleryTitleTaskPublisher:
    def publish(self, run_id: int) -> None:
        from app.tasks.llm_tasks import generate_conversation_title

        generate_conversation_title.apply_async(args=[run_id])


def get_title_task_publisher() -> TitleTaskPublisher:
    return CeleryTitleTaskPublisher()
