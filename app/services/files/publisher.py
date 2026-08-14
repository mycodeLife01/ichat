class CeleryFileTaskPublisher:
    def publish(self, upload_id: str) -> None:
        from app.tasks.file_tasks import process_file_upload

        process_file_upload.apply_async(args=[upload_id], queue="files")


def get_file_task_publisher() -> CeleryFileTaskPublisher:
    return CeleryFileTaskPublisher()
