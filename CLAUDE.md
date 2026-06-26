# Project

iChat — AI chat service: FastAPI backend integrated with DeepSeek API (real-time SSE streaming), plus a standalone React SPA frontend.

---

# Conventions

> Always-on rules. Kept near the top of this file so they are never lost to context truncation.

## User Interactions

**Must** use Chinese for user interactions in claude sessions unless required in other ways.

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

## Git

Branch names must start with a change type/scope segment such as `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, or `test/`. Prefer this project style over author or agent prefixes such as `codex/`. Examples: `fix/share-toast-loading-icon`, `feat/conversation-sharing`, `docs/git-workflow-rules`.

Commit messages must follow the Conventional Commits specification, for example `fix(frontend): replace share loading text with icon` or `docs: add git workflow constraints`.

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

---

# Reference

## Architecture

Backend is a three-service architecture orchestrated via Docker Compose:

- **API** (FastAPI + Uvicorn) — thin routing layer, receives requests, writes messages and Runs to database
- **Worker** (standalone process) — polls PostgreSQL queue, claims Runs, calls DeepSeek streaming API, persists events
- **PostgreSQL** — sole state store, also serves as task queue (`FOR UPDATE SKIP LOCKED`)

Email verification (added 2026-06) adds an independent async email stack alongside the above; the LLM worker is unaffected:

- **Redis** — Celery broker + short-TTL auth cooldown / IP rate-limit keys (never holds business state)
- **celery-worker** — sends queued emails from the `email_outbox` table (claim/lease/retry/dead), uses an independent sync (psycopg) engine
- **celery-beat** — single-instance scheduler for the periodic `email_outbox` sweep only

See [the email verification handover](docs/handover/2026-06-26-email-verification.md) for details.

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

# Documentation

The `docs/` directory holds authoritative project documentation (written in Chinese). Consult it **before** writing code when the task touches anything non-trivial — handover docs and specs explain *why* decisions were made and capture verification commands you should re-run.

The full, up-to-date documentation index — "which file to read for which situation" plus a per-directory guide — lives in **[`docs/README.md`](docs/README.md)**. Read it when you need to locate the authoritative doc for a topic (architecture, a specific feature's handover, design rationale, deployment, SSE/run internals, etc.).
