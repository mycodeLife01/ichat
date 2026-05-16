import io
import json

from app.core.logging import configure_logging, logger


def test_loguru_logging_serializes_bound_request_id() -> None:
    sink = io.StringIO()
    configure_logging("INFO", sink=sink)

    logger.bind(request_id="req-123").info("hello")

    payload = json.loads(sink.getvalue())
    assert payload["record"]["message"] == "hello"
    assert payload["record"]["extra"]["request_id"] == "req-123"
