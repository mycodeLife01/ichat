class CeleryAvatarTaskPublisher:
    def publish(self, upload_id: str) -> None:
        from app.tasks.media_tasks import process_avatar_upload

        process_avatar_upload.apply_async(args=[upload_id], queue="media")


def get_avatar_task_publisher() -> CeleryAvatarTaskPublisher:
    return CeleryAvatarTaskPublisher()
