import sys
from typing import TextIO

from loguru import logger as logger

__all__ = ["configure_logging", "logger"]


def configure_logging(level: str, sink: TextIO | None = None) -> None:
    logger.remove()
    logger.add(
        sink or sys.stdout,
        level=level.upper(),
        serialize=True,
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )
