import logging

from app.core.logging import SearchAccessFilter


def test_search_access_log_redacts_query_and_cursor():
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        '%s - "%s %s HTTP/%s" %s',
        ("local", "GET", "/api/v1/conversations/search?q=secret&cursor=private", "1.1", 200),
        None,
    )
    assert SearchAccessFilter().filter(record)
    assert "secret" not in record.getMessage() and "private" not in record.getMessage()
    assert "/api/v1/conversations/search" in record.getMessage()
