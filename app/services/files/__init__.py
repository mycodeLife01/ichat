"""Public parsing vocabulary for the files domain.

Lifecycle, storage, scanner, and persistence helpers remain internal so callers
cannot bypass the files service's authorization and output-manifest rules.
"""

from app.services.files.formats import FileFormat, FormatPolicy, policy_for_filename
from app.services.files.parsers import (
    DirectFileParser,
    FakeFileParser,
    RestrictedFileParser,
    parse_file,
)
from app.services.files.protocols import FileDerivative, FileProcessingError, ProcessedFile

__all__ = [
    "DirectFileParser",
    "FileDerivative",
    "FileFormat",
    "FileProcessingError",
    "FakeFileParser",
    "FormatPolicy",
    "ProcessedFile",
    "RestrictedFileParser",
    "parse_file",
    "policy_for_filename",
]
