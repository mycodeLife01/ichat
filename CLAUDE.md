# Project

iChat — AI chat service: FastAPI backend integrated with DeepSeek API (real-time SSE streaming), plus a standalone React SPA frontend.

## Tech Stack

- **Backend**: Python 3.12 / FastAPI / PostgreSQL 16 (asyncpg) / SQLAlchemy 2.0 async / Alembic / JWT + Argon2 / httpx / loguru / Docker / Nginx / uv
- **Frontend**: React 19 / TypeScript / Vite / Tailwind CSS v4 / Vitest + Testing Library + MSW / pnpm

## Architecture

Backend is a three-service architecture orchestrated via Docker Compose:

- **API** (FastAPI + Uvicorn) — thin routing layer, receives requests, writes messages and Runs to database
- **Worker** (standalone process) — polls PostgreSQL queue, claims Runs, calls DeepSeek streaming API, persists events
- **PostgreSQL** — sole state store, also serves as task queue (`FOR UPDATE SKIP LOCKED`)

The frontend is a **separate SPA** (`frontend/`), no longer served by FastAPI. It is deployed on Cloudflare Pages (`https://chat.feslia.com`) and calls the API cross-origin (`https://feslia.com/api/v1`); allowed origins are controlled by the `CORS_ALLOWED_ORIGINS` env var. Local dev runs on the Vite dev server (`:5173`).

Key mechanisms:
- SSE event stream supports `after_seq` cursor replay; clients can reconnect without data loss
- Worker lease + heartbeat for fault tolerance; orphaned runs auto-recovered on lease expiry
- Provider abstraction layer (`app/providers/`) decouples LLM calls

See [module boundaries](docs/architecture/module-boundaries.md) for details.

## Source Layout

```
app/
├── api/v1/        # Routes: auth/, conversations/, runs/
├── services/      # Business logic: auth/, conversations/, runs/
├── models/        # ORM models: user, conversation, message, run, run_event
├── schemas/       # Pydantic request/response models
├── providers/     # LLM provider interface and DeepSeek adapter
├── context/       # Context assembly (system prompt + message history truncation)
├── worker/        # Background worker process
├── core/          # Config (config.py), logging, error definitions
├── db/            # Database connection and session management
└── main.py        # Application entry point

frontend/          # React SPA (Vite + TypeScript + Tailwind v4), deployed on Cloudflare Pages
├── src/api/       #   API client, SSE parsing, error types
├── src/app/       #   App shell, provider, reducer store
├── src/auth/      #   Auth screen and session handling
├── src/conversations/ # Sidebar list, detail loading
├── src/runs/      #   Run stream hook, recovery, cancel
├── src/messages/  #   Message thread rendering
├── src/ui/        #   Shared components (Toast, BottomSheet, Composer...)
└── src/styles/    #   global.css (Tailwind @theme + whitelisted custom rules)

tests/             # Mirrors app/ directory structure (backend; frontend tests co-located in src/)
alembic/           # Database migrations
deploy/            # Nginx config, SSL certificates
```

## Key Files

| Purpose | File |
|---------|------|
| App config | `app/core/config.py` (Pydantic Settings, env var definitions) |
| Env var template | `.env.example` |
| DB models | `app/models/user.py`, `conversation.py`, `run.py` |
| Run state machine | `app/services/runs/lifecycle.py` |
| Worker main loop | `app/worker/main.py` |
| DeepSeek adapter | `app/providers/deepseek.py` |
| Production deploy | `compose.prod.yml` + `deploy/nginx.conf` |
| CI/CD | `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` |
| MVP design spec | `docs/superpowers/specs/2026-05-16-ai-chat-backend-mvp-design.md` |
| Frontend rebuild design spec | `docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md` |
| Frontend app shell / wiring | `frontend/src/app/AppShell.tsx` |
| Frontend reducer store | `frontend/src/app/store.ts` |
| Frontend API client + SSE | `frontend/src/api/client.ts`, `frontend/src/api/sse.ts` |

## Dev Commands

Backend:

```bash
docker compose up -d                  # Start all services
docker compose exec api alembic upgrade head  # Run DB migrations
uv sync --all-groups                  # Install all dependencies (incl. dev)
pytest                                # Run tests
ruff check app tests                  # Lint
mypy app                             # Type check
```

Frontend (run inside `frontend/`, package manager is **pnpm** — never commit an npm lockfile):

```bash
pnpm install                          # Install dependencies
pnpm dev                              # Vite dev server on :5173
pnpm exec vitest run                  # Run tests
pnpm run lint                         # ESLint
pnpm run typecheck                    # tsc
pnpm run build                        # Production build (tsc -b && vite build)
```

## Deployment

- **Backend**: `compose.prod.yml` with images on GHCR. Push to `main` triggers GitHub Actions to build and deploy automatically.
- **Frontend**: Cloudflare Pages, connected to this repo. Production branch `main`, root directory `frontend`, build command `pnpm build`, output `dist`, build-time env `VITE_API_BASE_URL`. Non-`main` branches get preview deployments automatically. New frontend/preview domains must be added to the backend's `CORS_ALLOWED_ORIGINS` (server `.env`), then `docker compose -f compose.prod.yml up -d --force-recreate api` (a plain restart does not reload env).

See [deployment guide](docs/deployment.md) for details.

---

# Documentation Map

The `docs/` directory holds authoritative project documentation. Consult it **before** writing code when the task touches anything non-trivial — handover docs and specs explain *why* decisions were made and capture verification commands that you should re-run.

> Documentation content is written in Chinese (per project convention). This `CLAUDE.md` file is the exception — it stays in English because it is agent-facing instructions.

## When to consult docs/

| Situation | Read this first |
|-----------|-----------------|
| Understanding overall runtime architecture, data flow, service topology | `docs/architecture/overview.md` |
| Refactoring, crossing module boundaries, or reviewing structural changes | `docs/architecture/module-boundaries.md` |
| Implementing/modifying an existing feature | The newest matching `docs/handover/*.md` for that topic |
| Working on the frontend (React SPA) | The newest matching `docs/handover/frontend/*.md` + `docs/superpowers/specs/2026-05-24-frontend-react-rebuild-design.md` |
| Need design rationale (e.g., "why PostgreSQL queue, not Redis?") | `docs/superpowers/specs/` |
| Deploying or debugging CI/CD | `docs/deployment.md` + `docs/handover/2026-05-18-cicd-and-domain-deployment.md` |
| Frontend deployment / CORS issues | `docs/handover/frontend/2026-05-24-backend-decoupling-and-cors.md` + `docs/deployment.md` |
| Verifying provider integration behavior | `docs/handover/2026-05-17-deepseek-smoke.md` |
| Touching SSE replay, run state, or run events | `docs/handover/2026-05-17-run-events-sse-replay.md` + `docs/handover/2026-05-17-provider-and-worker.md` |

## Directory guide

### `docs/architecture/`

Authoritative architectural rules.

- `overview.md` — runtime architecture: service topology, end-to-end data flow, run state machine, persistence model, concurrency model, LISTEN/NOTIFY channels, cross-module data-flow invariants.
- `module-boundaries.md` — module responsibilities for `app/api`, `app/core`, `app/db`, `app/models`, `app/schemas`, `app/services/*`, `app/worker`, and forbidden cross-module dependencies.

### `docs/handover/`

Dated implementation records (`YYYY-MM-DD-topic.md`), authoritative for "what was built and why". Each file includes verification commands (pytest, ruff, mypy, docker compose) — re-run them after your changes.

- `2026-05-16-project-foundation.md` — project scaffolding, dependencies, Docker Compose setup
- `2026-05-16-mvp-infra.md` — config loading, Loguru logging, error types, Alembic initialization
- `2026-05-16-db-models.md` — 7-table ORM schema, indexes, migration strategy
- `2026-05-17-auth-and-response-envelope.md` — JWT + refresh token flow, unified `{"data": ...}` success envelope
- `2026-05-17-conversation-module.md` — conversation CRUD, message position assignment, active-run guards
- `2026-05-17-provider-and-worker.md` — provider abstraction, run state machine, worker claim/lease/heartbeat
- `2026-05-17-run-events-sse-replay.md` — run event seq allocation, `/state` JSON endpoint, `/events` SSE replay endpoint
- `2026-05-17-run-cancellation.md` — cancellation behavior across run states (queued / streaming / terminal)
- `2026-05-17-deepseek-smoke.md` — real DeepSeek end-to-end smoke test results (happy path, replay, cancel, error recovery)
- `2026-05-17-test-frontend.md` — legacy vanilla-JS test frontend (superseded by the React rebuild, see `handover/frontend/`)
- `2026-05-18-cicd-and-domain-deployment.md` — GitHub Actions pipeline, Nginx reverse proxy, Cloudflare SSL
- `2026-05-19-concurrency-and-listen-notify.md` — delta batching, single-worker concurrency, claim/SSE LISTEN/NOTIFY, multi-worker compose, DB pool tuning
- `2026-05-19-regenerate.md` — regenerate assistant message by editting user message or from the current response
- `2026-05-20-auto-title-and-draft-conversation.md` — auto summary conversation title after first run succeeded
- `2026-06-11-per-request-thinking-options.md` — per-request thinking mode (runs.provider_options JSONB, request-body overrides, frontend Fast/High/Max dropdown)

### `docs/handover/frontend/`

Frontend rebuild handover series (React SPA, in chronological order — the newest file for a topic wins):

- `2026-05-24-react-scaffold-and-pnpm.md` — Vite + React + TypeScript scaffold, pnpm switch, old vanilla frontend removed
- `2026-05-24-frontend-communication-foundation.md` — API client, error types, SSE parsing layer
- `2026-05-24-backend-decoupling-and-cors.md` — FastAPI no longer serves static files; configurable `CORS_ALLOWED_ORIGINS` (backend change, filed under frontend series)
- `2026-06-06-frontend-state-and-auth.md` — reducer store, auth session, auth screen
- `2026-06-08-frontend-conversation-list-and-detail.md` — sidebar conversation list, detail loading
- `2026-06-09-frontend-send-and-sse-streaming.md` — send message, SSE streaming render
- `2026-06-10-frontend-edit-regenerate-and-auto-title.md` — edit/regenerate flows, auto-title pending state
- `2026-06-10-frontend-refresh-recovery.md` — refresh recovery of in-flight runs, partial restore, cancel robustness
- `2026-06-10-frontend-toast-and-bottomsheet.md` — Toast, mobile BottomSheet actions
- `2026-06-10-frontend-tailwind-v4-styles.md` — Tailwind CSS v4 migration (CSS-first `@theme`, all hand-written CSS removed, pixel-parity verified)

### `docs/goals/`

Goal documents for goal-driven development runs (success criteria + verification). Paired with same-dated handover docs.

### `docs/superpowers/specs/`

Pre-implementation design specs. Consult for product/design rationale.

- `2026-05-16-ai-chat-backend-mvp-design.md` — overall MVP scope, architecture, technical decisions
- `2026-05-17-run-cancellation-design.md` — cancellation design details and HTTP semantics
- `2026-05-24-frontend-react-rebuild-design.md` — master plan for the React frontend rebuild (step sequence, hooks design, deployment topology)
- other dated specs — per-feature designs (auto-title, regenerate, thinking mode, frontend sub-steps)

### `docs/superpowers/plans/`

Historical implementation checklists, one per past sprint. **Not active reference.** Consult only when reconstructing how a past implementation was sequenced. For "what was built", prefer the matching handover doc.

### `docs/deployment.md`

Production deployment runbook — Linux server setup, Docker Compose, Nginx reverse proxy, Cloudflare SSL/TLS, Cloudflare Pages frontend hosting, environment variables.

---

# Conventions

## Language

| Surface | Language |
|---------|----------|
| `docs/` content, project documentation | Chinese |
| Code comments and docstrings | English |
| User-facing error messages and application-level hints | English |
| `CLAUDE.md` (this file) | English — agent instructions |

## Workspace

When entering the implementation phase, develop directly on the current branch by default. Do not create or switch to a git worktree.

Use a worktree only when the user explicitly asks for one. If a generic workflow or external skill recommends using a worktree, this project rule takes precedence.

## Subagent Model Policy

When the user explicitly authorizes subagent use, choose models by task role:
- Orchestrator and reviewer subagents must use `claude-opus-4-8` with `xhigh` thinking effort level.
- Executor and worker subagents must use `claude-sonnet-4-6` with `max` thinking effort level.
- Read-only and explore subagents must use `claude-haiku-4-5-20251001` with `medium` thinking effort level.

## Development Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
