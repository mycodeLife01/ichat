"""Celery application for asynchronous email delivery.

Independent of the LLM ``app.worker`` process. Result backend is disabled:
task outcomes are persisted to ``email_outbox``, never read back via Celery.
"""

from celery import Celery

from app.core.config import get_settings

_settings = get_settings()

celery_app = Celery(
    "ichat",
    broker=_settings.celery_broker_url,
    include=["app.tasks.email_tasks"],
)

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
    },
)
