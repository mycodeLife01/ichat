# Backend Frontend Decoupling And CORS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop FastAPI from serving the `frontend/` directory and add configurable CORS so the standalone React app (Cloudflare Pages / local `:5173`) can call the API cross-origin.

**Architecture:** Add a `CORS_ALLOWED_ORIGINS` setting (comma-separated string parsed into a list via a property, avoiding pydantic-settings JSON list parsing), wire Starlette's `CORSMiddleware` inside `create_app` as the outermost middleware, and delete the root `StaticFiles` mount. Backend stays API-only; the SSE endpoints keep using `fetch` + `Authorization` so no streaming behavior changes.

**Tech Stack:** Python 3.12, FastAPI / Starlette, pydantic-settings v2, pytest, `fastapi.testclient.TestClient`.

---

## Scope

In scope: `app/core/config.py`, `.env.example`, `app/main.py`, and their tests under `tests/`.

Explicitly out of scope (these belong to spec step 12 — `2026-05-24-frontend-react-rebuild-design.md`, and must NOT be touched in this plan):

- Nginx config (`deploy/nginx.conf`), `compose.prod.yml`, `docs/deployment.md`.
- GitHub Actions workflows (`.github/workflows/*`). `CORS_ALLOWED_ORIGINS` has a safe default (`""`), so CI needs no new required env var.
- Any frontend code, React reducers, hooks, or UI.

## File Structure

- Modify `app/core/config.py`: add `cors_allowed_origins: str = ""` field and a `cors_allowed_origins_list` property that splits the comma-separated value into a stripped, non-empty list.
- Modify `.env.example`: add `CORS_ALLOWED_ORIGINS` with local dev origins.
- Modify `app/main.py`: drop the `pathlib.Path` and `StaticFiles` imports, add `CORSMiddleware`, register CORS as the last (outermost) middleware in `create_app`, and delete the module-level root mount block.
- Modify `tests/core/test_config.py`: add tests for the parsing property and default, and extend the `.env.example` shape test.
- Modify `tests/api/test_app.py`: add tests asserting the root path no longer serves frontend HTML and that CORS headers behave per allowed/disallowed origin.

---

## Task 1: Add CORS Setting And Config Tests

**Files:**
- Modify: `app/core/config.py`
- Modify: `.env.example`
- Test: `tests/core/test_config.py`

- [ ] **Step 1: Write the failing config tests**

Append to `tests/core/test_config.py`:

```python
def test_cors_allowed_origins_parses_comma_separated_list() -> None:
    settings = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=False,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
        cors_allowed_origins="http://localhost:5173, http://127.0.0.1:5173 ,",
    )

    assert settings.cors_allowed_origins_list == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_allowed_origins_defaults_to_empty_list() -> None:
    settings = Settings(
        database_url="postgresql+asyncpg://user:pass@localhost:5432/db",
        jwt_secret="secret",
        jwt_access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=2_592_000,
        deepseek_api_key="key",
        deepseek_base_url="https://deepseek.example",
        deepseek_model="deepseek-test",
        deepseek_thinking_enabled=False,
        default_system_prompt="Be helpful.",
        run_lease_seconds=60,
        worker_poll_interval_seconds=2,
        worker_heartbeat_interval_seconds=10,
        summary_provider_name="deepseek",
        summary_model="deepseek-summary",
        log_level="info",
    )

    assert settings.cors_allowed_origins_list == []
```

- [ ] **Step 2: Run the config tests to verify RED**

Run:

```bash
uv run pytest tests/core/test_config.py::test_cors_allowed_origins_parses_comma_separated_list tests/core/test_config.py::test_cors_allowed_origins_defaults_to_empty_list -v
```

Expected: FAIL with `AttributeError: 'Settings' object has no attribute 'cors_allowed_origins_list'` (the `cors_allowed_origins` kwarg is silently ignored because `model_config` uses `extra="ignore"`, and the property does not exist yet).

- [ ] **Step 3: Add the setting field and parsing property**

In `app/core/config.py`, add the field right after the `log_level: str` line (currently line 33), so the field block ends with:

```python
    auto_title_max_chars: int = 32
    auto_title_max_output_tokens: int = 40
    log_level: str
    cors_allowed_origins: str = ""
```

Then add this property to the `Settings` class, immediately after the existing `normalize_reasoning_effort` validator method and before the closing of the class (i.e., before the module-level `@lru_cache` / `get_settings`):

```python
    @property
    def cors_allowed_origins_list(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.cors_allowed_origins.split(",")
            if origin.strip()
        ]
```

- [ ] **Step 4: Run the config tests to verify GREEN**

Run:

```bash
uv run pytest tests/core/test_config.py::test_cors_allowed_origins_parses_comma_separated_list tests/core/test_config.py::test_cors_allowed_origins_defaults_to_empty_list -v
```

Expected: PASS.

- [ ] **Step 5: Add the env var to `.env.example`**

In `.env.example`, add a new line after `LOG_LEVEL=INFO` (currently the last line, 36):

```bash
LOG_LEVEL=INFO
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

- [ ] **Step 6: Extend the `.env.example` shape test**

In `tests/core/test_config.py`, inside `test_env_example_values_match_settings_shape`, add one assertion immediately after the existing final assertion `assert settings.log_level == env_value(example_values, "LOG_LEVEL")`:

```python
    assert settings.log_level == env_value(example_values, "LOG_LEVEL")
    assert settings.cors_allowed_origins_list == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
```

- [ ] **Step 7: Run the full config test file to verify GREEN**

Run:

```bash
uv run pytest tests/core/test_config.py -v
```

Expected: PASS (all existing tests plus the three new/extended assertions).

- [ ] **Step 8: Commit**

```bash
git add app/core/config.py .env.example tests/core/test_config.py
git commit -m "feat(api): add cors_allowed_origins setting"
```

Expected: commit succeeds with the new setting, env example, and config tests.

## Task 2: Remove Static Mount And Add CORS Middleware

**Files:**
- Modify: `app/main.py`
- Test: `tests/api/test_app.py`

- [ ] **Step 1: Write the failing app tests**

In `tests/api/test_app.py`, update the imports at the top of the file. Replace the current import block:

```python
from uuid import UUID

from fastapi import status
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.core.errors import AppError
from app.main import create_app
from app.schemas.responses import SuccessResponse
```

with:

```python
from uuid import UUID

from fastapi import status
from fastapi.testclient import TestClient
from pydantic import BaseModel
from pytest import MonkeyPatch

from app.core.config import get_settings
from app.core.errors import AppError
from app.main import create_app
from app.schemas.responses import SuccessResponse
```

Then append these tests to the end of `tests/api/test_app.py`:

```python
def test_root_path_does_not_serve_frontend() -> None:
    client = TestClient(create_app(database_ready_check=ready))

    response = client.get("/")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "text/html" not in response.headers.get("content-type", "")


def test_cors_allows_configured_origin(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(database_ready_check=ready))

        response = client.get("/healthz", headers={"Origin": "http://localhost:5173"})

        assert response.status_code == status.HTTP_200_OK
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    finally:
        get_settings.cache_clear()


def test_cors_preflight_allows_methods(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(database_ready_check=ready))

        response = client.options(
            "/api/v1/conversations",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
        allow_methods = response.headers["access-control-allow-methods"]
        assert "POST" in allow_methods
        assert "PATCH" in allow_methods
        assert "DELETE" in allow_methods
    finally:
        get_settings.cache_clear()


def test_cors_omits_headers_for_unknown_origin(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app(database_ready_check=ready))

        response = client.get("/healthz", headers={"Origin": "https://evil.example"})

        assert response.status_code == status.HTTP_200_OK
        assert "access-control-allow-origin" not in response.headers
    finally:
        get_settings.cache_clear()
```

- [ ] **Step 2: Run the app tests to verify RED**

Run:

```bash
uv run pytest tests/api/test_app.py -v
```

Expected: FAIL. `test_root_path_does_not_serve_frontend` fails because the root mount currently serves frontend (returns 200 / HTML), and the three CORS tests fail because no `access-control-allow-origin` header is produced (and the preflight `access-control-allow-methods` lookup raises `KeyError`).

- [ ] **Step 3: Update `app/main.py` imports**

Replace the current import block (lines 1-17):

```python
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.auth import router as auth_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.runs import router as runs_router
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging, logger
from app.db.session import check_database_ready
from app.services.run_events.subscription import RunEventSubscriptionManager
```

with (drop `pathlib.Path` and `StaticFiles`, add `CORSMiddleware`):

```python
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.auth import router as auth_router
from app.api.v1.conversations import router as conversations_router
from app.api.v1.runs import router as runs_router
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging, logger
from app.db.session import check_database_ready
from app.services.run_events.subscription import RunEventSubscriptionManager
```

- [ ] **Step 4: Register CORS middleware and return the app**

In `app/main.py`, replace the `readyz` route + `return app` tail of `create_app`:

```python
    @app.get("/readyz")
    async def readyz() -> dict[str, str]:
        if not await readiness_check():
            raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, "Database is not ready")
        return {"status": "ok"}

    return app
```

with (add CORS as the last/outermost middleware so it handles preflight before routing):

```python
    @app.get("/readyz")
    async def readyz() -> dict[str, str]:
        if not await readiness_check():
            raise AppError(status.HTTP_503_SERVICE_UNAVAILABLE, "Database is not ready")
        return {"status": "ok"}

    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_allowed_origins_list,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept"],
    )

    return app
```

- [ ] **Step 5: Delete the root static mount**

In `app/main.py`, remove the module-level block at the end of the file:

```python
app = create_app()

frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
```

so the file ends with just:

```python
app = create_app()
```

- [ ] **Step 6: Run the app tests to verify GREEN**

Run:

```bash
uv run pytest tests/api/test_app.py -v
```

Expected: PASS (all existing tests plus the four new tests).

- [ ] **Step 7: Commit**

```bash
git add app/main.py tests/api/test_app.py
git commit -m "feat(api): drop frontend static mount and enable cors"
```

Expected: commit succeeds with API-only app and CORS middleware.

## Task 3: Full Backend Verification

**Files:** none changed.

- [ ] **Step 1: Run targeted tests, lint, and type check**

Run:

```bash
uv run pytest tests/api/test_app.py tests/core/test_config.py -v
uv run ruff check app tests
uv run mypy app
```

Expected: all pass. `ruff` confirms no unused imports remain in `app/main.py` (the removed `Path` / `StaticFiles`), and `mypy` confirms `cors_allowed_origins_list` types as `list[str]` for `allow_origins`.

- [ ] **Step 2: Run the broader suite if PostgreSQL is available**

If a database is running (`docker compose up -d postgres`), confirm nothing regressed:

```bash
uv run pytest --tb=short -q
```

Expected: PASS. If no database is available locally, the targeted run in Step 1 is sufficient — the changed code paths (`config`, `main` app construction) do not require a database because `TestClient` is used without a lifespan context.

- [ ] **Step 3: Review the diff**

```bash
git status --short
git diff --stat HEAD~2
```

Expected: only `app/core/config.py`, `.env.example`, `app/main.py`, `tests/core/test_config.py`, `tests/api/test_app.py` are touched. `uiux_v1.html` remains untracked and is not included.

## Self-Review

- **Spec coverage** (`2026-05-24-frontend-react-rebuild-design.md`, "后端部署改动"):
  - New `CORS_ALLOWED_ORIGINS` env var with local dev origins → Task 1.
  - Allow `Authorization`, `Content-Type`, `Accept` headers and `GET/POST/PATCH/DELETE/OPTIONS` methods → Task 2 Step 4.
  - Delete root `StaticFiles` mount, keep `/healthz`, `/readyz`, `/api/v1/*` → Task 2 Step 5 (existing health/readiness/envelope tests in `test_app.py` continue to pass).
  - Backend test asserts root no longer returns frontend HTML → `test_root_path_does_not_serve_frontend`.
  - SSE keeps `fetch` + `Authorization` (unchanged) → no SSE code touched; CORS preflight covers cross-origin streaming requests.
  - Nginx / Cloudflare / CI / deployment docs are deliberately deferred to spec step 12 (noted in Scope).
- **Placeholder scan:** No `TBD`/`TODO`/"add validation" placeholders. Every code step shows exact content and exact insertion points.
- **Type consistency:** The field is `cors_allowed_origins: str` and the property is `cors_allowed_origins_list -> list[str]`; both names are used identically across `config.py`, `main.py` (`app_settings.cors_allowed_origins_list`), and all tests. Middleware methods/headers lists match the spec exactly.
