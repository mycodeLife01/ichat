import logging
import sys
from typing import TextIO

from loguru import logger as logger

__all__ = ["configure_logging", "logger"]


class SearchAccessFilter(logging.Filter):
    """Do not persist private search queries or cursors in HTTP access logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) == 5:
            client, method, path, version, code = record.args
            if str(path).split("?", 1)[0].rstrip("/") == "/api/v1/conversations/search":
                record.args = (client, method, "/api/v1/conversations/search", version, code)
        return True


def configure_logging(level: str, sink: TextIO | None = None) -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, SearchAccessFilter) for item in access.filters):
        access.addFilter(SearchAccessFilter())
    logger.remove()
    logger.add(
        sink or sys.stdout,
        level=level.upper(),
        serialize=True,
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )
