from app.tasks import anime_tasks
from app.tasks.celery_app import ANIME_BEAT_SCHEDULE, celery_app


def test_anime_tasks_route_to_anime_queue_and_schedule_is_opt_in() -> None:
    routes = celery_app.conf.task_routes
    assert routes["app.tasks.anime_tasks.*"] == {"queue": "anime"}
    # Disabled in the test environment, so beat must not schedule anime tasks.
    assert not set(ANIME_BEAT_SCHEDULE) & set(celery_app.conf.beat_schedule)
    schedule = ANIME_BEAT_SCHEDULE
    expected = {
        "dispatch-anime-feeds": ("dispatch_due_feeds", 60),
        "poll-running-anime-downloads": ("poll_running_downloads", 60),
        "maintain-anime-downloads": ("maintain_downloads", 300),
        "anime-health-check": ("health_check", 21600),
    }
    for name, (task, seconds) in expected.items():
        entry = schedule[name]
        assert entry["task"] == f"app.tasks.anime_tasks.{task}"
        assert entry["schedule"] == seconds
        assert entry["options"] == {"queue": "anime"}


def test_anime_tasks_are_noops_when_disabled() -> None:
    # The test environment leaves ANIME_ENABLED unset (false).
    assert anime_tasks.dispatch_due_feeds() == 0
    assert anime_tasks.poll_feed(1) == 0
    assert anime_tasks.submit_download("00000000-0000-0000-0000-000000000000") == "disabled"
    assert anime_tasks.maintain_downloads() is not None
