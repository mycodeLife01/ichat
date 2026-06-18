# Documentation Map

> Agent-facing navigation index for `docs/`. Moved out of `CLAUDE.md` to keep that
> file focused on always-on rules. Consult this **before** writing code when the task
> touches anything non-trivial — handover docs and specs explain *why* decisions were
> made and capture verification commands that you should re-run.
>
> Documentation content is written in Chinese (per project convention). This index
> stays in English because it is agent-facing.

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
| Editing the assistant's system prompt or how prompts are assembled/injected | `docs/handover/2026-06-17-system-prompt-management.md` |
| Touching SSE replay, run state, or run events | `docs/handover/2026-05-17-run-events-sse-replay.md` + `docs/handover/2026-05-17-provider-and-worker.md` |

## Directory guide

### `docs/architecture/`

Authoritative architectural rules.

- `overview.md` — runtime architecture: service topology, end-to-end data flow, run state machine, persistence model, concurrency model, LISTEN/NOTIFY channels, cross-module data-flow invariants.
- `module-boundaries.md` — module responsibilities for `app/api`, `app/core`, `app/db`, `app/models`, `app/schemas`, `app/services/*`, the top-level capability modules (`app/providers`, `app/context`, `app/prompts`, `app/search`, `app/tools`), `app/worker`, and forbidden cross-module dependencies.

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
- `2026-06-11-web-search-tool.md` — web search tool (Tavily adapter, query planner, worker tools agent loop, tool-call SSE events, source metadata). Note: the rule-based query planner / pre-search was removed 2026-06-17 — tool calls are now model-driven.
- `2026-06-17-system-prompt-management.md` — system prompt module (`app/prompts/`), injection/composition order, optional env override, faithful `system_prompt_snapshot` written at execution time
- `2026-06-18-public-id-hardening.md` — opaque `public_id` (UUID) replaces sequential ids on the API surface for conversations/messages/runs (bigint PK kept internally); React Router added with `/c/:publicId` deep linking. Phase 1 of the public_id + sharing design.

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
- `2026-06-11-web-search-tool-design.md` — web search tool design (tool schema, query planner, agent loop budget, source dedup, evidence compression). Note: the rule-based query planner / pre-search it specifies was removed 2026-06-17 (now model-driven); `system_prompt_snapshot` semantics also superseded — see `docs/handover/2026-06-17-system-prompt-management.md`.
- `2026-06-18-public-id-and-conversation-sharing-design.md` — opaque `public_id` (dual-key, keep bigint PK) to drop sequential IDs from the API surface, plus conversation sharing via a separate `share_links` token + read-only snapshot. Includes scope/format/sharing-semantics open decisions.
- other dated specs — per-feature designs (auto-title, regenerate, thinking mode, frontend sub-steps)

### `docs/superpowers/plans/`

Historical implementation checklists, one per past sprint. **Not active reference.** Consult only when reconstructing how a past implementation was sequenced. For "what was built", prefer the matching handover doc.

### `docs/deployment.md`

Production deployment runbook — Linux server setup, Docker Compose, Nginx reverse proxy, Cloudflare SSL/TLS, Cloudflare Pages frontend hosting, environment variables.
