"""Celery application for asynchronous email delivery.

Independent of the LLM ``app.worker`` process. Result backend is disabled:
task outcomes are persisted to ``email_outbox``, never read back via Celery.
"""

from celery import Celery
from celery.signals import beat_init, worker_process_init

from app.core.config import get_settings
from app.core.logging import configure_logging

_settings = get_settings()

celery_app = Celery(
    "ichat",
    broker=_settings.celery_broker_url,
    include=[
        "app.tasks.email_tasks",
        "app.tasks.llm_tasks",
        "app.tasks.media_tasks",
        "app.tasks.file_tasks",
        "app.tasks.anime_tasks",
    ],
)

_ANIME_QUEUE = {"queue": "anime"}
# Only scheduled when enabled: without the opt-in anime-worker nothing
# consumes the anime queue, and beat messages would pile up in Redis.
ANIME_BEAT_SCHEDULE = {
    "dispatch-anime-feeds": {
        "task": "app.tasks.anime_tasks.dispatch_due_feeds",
        "schedule": 60.0,
        "options": _ANIME_QUEUE,
    },
    "poll-running-anime-downloads": {
        "task": "app.tasks.anime_tasks.poll_running_downloads",
        "schedule": 60.0,
        "options": _ANIME_QUEUE,
    },
    "maintain-anime-downloads": {
        "task": "app.tasks.anime_tasks.maintain_downloads",
        "schedule": 300.0,
        "options": _ANIME_QUEUE,
    },
    "anime-health-check": {
        "task": "app.tasks.anime_tasks.health_check",
        "schedule": 21600.0,
        "options": _ANIME_QUEUE,
    },
}

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_backend=_settings.celery_result_backend or None,
    task_ignore_result=True,
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        "sweep-email-outbox": {
            "task": "app.tasks.email_tasks.sweep_email_outbox",
            "schedule": float(_settings.email_outbox_sweep_interval_seconds),
        },
        "sweep-conversation-title-jobs": {
            "task": "app.tasks.llm_tasks.sweep_conversation_title_jobs",
            "schedule": 60.0,
        },
        "maintain-avatars": {
            "task": "app.tasks.media_tasks.maintain_avatars",
            "schedule": float(_settings.avatar_maintenance_interval_seconds),
            "options": {"queue": "media"},
        },
        "maintain-files": {
            "task": "app.tasks.file_tasks.maintain_files",
            "schedule": float(_settings.files_maintenance_interval_seconds),
            "options": {"queue": "files"},
        },
        **(ANIME_BEAT_SCHEDULE if _settings.anime_enabled else {}),
    },
    task_routes={
        "app.tasks.media_tasks.*": {"queue": "media"},
        "app.tasks.file_tasks.*": {"queue": "files"},
        "app.tasks.anime_tasks.*": _ANIME_QUEUE,
    },
)


@worker_process_init.connect  # type: ignore[untyped-decorator]
def configure_worker_logging(**_: object) -> None:
    configure_logging(_settings.log_level)


@beat_init.connect  # type: ignore[untyped-decorator]
def configure_beat_logging(**_: object) -> None:
    configure_logging(_settings.log_level)
