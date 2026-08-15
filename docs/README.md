# Documentation Map

> Agent-facing navigation index for `docs/`. Moved out of `CLAUDE.md` to keep that
> file focused on always-on rules. Consult this **before** writing code when the task
> touches anything non-trivial — handover docs and specs explain *why* decisions were
> made and capture verification commands that you should re-run.
>
> Documentation content is written in Chinese (per project convention). This index
> stays in English because it is agent-facing.

## When to consult docs/

A task may match multiple rows. Treat the situation column as triggers and read every matching row.

| Situation | Read this first |
|-----------|-----------------|
| Understanding overall runtime architecture, data flow, service topology | `docs/architecture/overview.md` |
| Refactoring, crossing module boundaries, or reviewing structural changes | `docs/architecture/module-boundaries.md` |
| Adding a background task, or deciding whether it belongs in the async runtime or Celery | `docs/architecture/background-tasks.md` |
| Implementing/modifying an existing feature | The newest matching `docs/handover/*.md` for that topic |
| Working on the frontend (React SPA) | `docs/architecture/frontend.md`, then every other matching feature/deployment row in this table |
| Refactoring assistant-response rendering, Markdown, reasoning surfaces, or rich message content | `docs/handover/frontend/2026-08-15-assistant-rendering-visual-fixture.md` + `docs/handover/frontend/2026-08-15-chatgpt-ai-response-rendering.md` + `.scratch/refactor-chat-render/PRD.md` + `docs/architecture/frontend.md`; also read the matching streaming/search handovers below |
| Need design rationale (e.g., "why PostgreSQL queue, not Redis?") | `docs/superpowers/specs/` |
| Deploying or debugging CI/CD | `docs/deployment.md` + `docs/handover/2026-05-18-cicd-and-domain-deployment.md` |
| Frontend deployment / CORS issues | `docs/handover/frontend/2026-05-24-backend-decoupling-and-cors.md` + `docs/deployment.md` |
| Verifying provider integration behavior | `docs/handover/2026-05-17-deepseek-smoke.md` |
| Editing the assistant's system prompt or how prompts are assembled/injected | `docs/handover/2026-06-17-system-prompt-management.md` |
| Touching SSE replay, run state, or run events | `docs/handover/2026-05-17-run-events-sse-replay.md` + `docs/handover/2026-05-17-provider-and-worker.md` |
| Email verification, auth emails, Celery/Redis, outbox, IP rate limiting | `docs/handover/2026-06-26-email-verification.md` + `docs/superpowers/specs/2026-06-21-email-verification-design.md` |
| Password reset, change password, account deletion (soft deactivation) | `docs/handover/2026-07-13-password-reset-account-deletion.md` + `docs/adr/2026-07-13-account-deletion-soft-deactivation.md` |
| File upload, message attachments, file lifecycle, R2/ClamAV rollout | `docs/handover/2026-08-13-clamav-startup-readiness.md` + `docs/handover/2026-08-09-file-upload-performance.md` + `docs/handover/2026-08-01-unified-file-upload.md` + `docs/architecture/module-boundaries.md` + `docs/architecture/background-tasks.md` |
| Public share pages, share snapshots, anonymous attachment reads | `docs/handover/2026-08-14-share-attachment-parity.md` + ADR `0011-grant-attachment-reads-to-public-shares.md` + `docs/handover/2026-06-18-conversation-sharing.md` |
| GPT image understanding, vision-model constraints, safe preview delivery | `docs/handover/2026-08-03-gpt-vision-input.md` + `.scratch/gpt-vision-input/PRD.md` + ADRs `0006`–`0009` |
| Sent-image placement, local preview handoff, or attachment frame stability | `docs/handover/2026-08-09-sent-image-placement-stability.md` + `docs/architecture/frontend.md` + `docs/handover/2026-08-03-gpt-vision-input.md` |
| Sidebar rail / collapsed navigation, chat-page floating actions, one-click share copy | `docs/handover/frontend/2026-08-14-sidebar-rail-and-chat-actions.md` + `docs/architecture/frontend.md` |
| Avatar upload, Cloudflare R2, media worker, CDN purge | `docs/handover/2026-08-01-unified-file-upload.md`; read `docs/handover/2026-07-14-r2-avatar-upload.md` only for the legacy expand path retained before ticket 15 contract |

## Directory guide

### `docs/architecture/`

Authoritative architectural rules.

- `overview.md` — runtime architecture: service topology, end-to-end data flow, run/file state machines, persistence model, concurrency model, LISTEN/NOTIFY channels, cross-module data-flow invariants.
- `frontend.md` — current React SPA boundaries: state/effect ownership, API/auth, routing, SSE/Run recovery, attachments/model capabilities, styling, and verification invariants.
- `module-boundaries.md` — module responsibilities for `app/api`, `app/core`, `app/db`, `app/models`, `app/schemas`, `app/services/*` (including `app/services/files` and the agent orchestration layer `app/services/agents`), the provider-neutral agent kernel `app/agent`, `app/search`, `app/worker`, and forbidden cross-module dependencies.
- `background-tasks.md` — the background-task convention (transactional state row + wakeup signal + idempotent claim), the async-runtime-vs-Celery ownership test, file/media Celery ownership, why streaming runs stay out of Celery, and the three questions every task table must answer.

### `docs/adr/`

Architecture decision records (`YYYY-MM-DD-topic.md`). Read the ones touching your area before proposing changes; conflicts with an ADR must be raised explicitly, never silently overridden (see `docs/agents/domain.md`).

- `2026-07-13-account-deletion-soft-deactivation.md` — account deletion = soft deactivation (`is_active=false` + full credential revocation), data retained; physical erasure (cooling-off period + periodic job) deferred to a later iteration.
- `0002-unify-file-assets-and-avatar-uploads.md` — the later decision that replaces the former avatar-only-files boundary; implementation and the still-deferred legacy-avatar contract are recorded in `handover/2026-08-01-unified-file-upload.md`.
- `0010-use-adaptive-multipart-and-server-side-promotion.md` — adaptive multipart transport, PG-owned upload lifecycle, R2 server-side original promotion, and PG-only derived document text for new uploads.
- `0011-grant-attachment-reads-to-public-shares.md` — public shares now exchange an opaque snapshot `ref` for short-lived preview/download URLs (superseding the placeholder-only boundary), with the threat model and the guards that bound it.

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
- `2026-06-17-system-prompt-management.md` — system prompt module (`app/prompts/`), injection/composition order, optional env override, faithful `system_prompt_snapshot` written at execution time. Note: the prompt module moved to `app/services/agents/prompts.py` in the 2026-07-20 agent-runtime re-layering (issue 04b); `app/prompts/` no longer exists.
- `2026-06-18-public-id-hardening.md` — opaque `public_id` (UUID) replaces sequential ids on the API surface for conversations/messages/runs (bigint PK kept internally); React Router added with `/c/:publicId` deep linking. Phase 1 of the public_id + sharing design.
- `2026-06-18-conversation-sharing.md` — conversation sharing (Phase 2): `share_links` table (bigint, token-keyed), created-time JSONB snapshot, anonymous `GET /api/v1/share/{token}` read + owner-only create/list/revoke management, at-most-one-active-link-per-conversation (409 on conflict; revoked/expired kept for audit, hidden from listing), public `/share/:token` read-only page, share dialog, CF Pages `_redirects` SPA fallback.
- `2026-06-26-email-verification.md` — email verification + auth-email infra: `auth_tokens`/`email_outbox` tables, Redis cooldown + IP sliding-window rate limiting, Postmark/console/fake providers, Celery worker/beat outbox delivery (claim/lease/retry/dead/sweep), `GET /auth/me` + `POST /auth/verify-email` + `POST /auth/resend-verification-email`, nginx Cloudflare realip + firewall ops checklist.
- `2026-07-13-password-reset-account-deletion.md` — password reset / change-password / account deletion (five new auth endpoints), purpose-generalized token service, cross-invalidation matrix, anti-enumeration constant responses, per-endpoint rate-limit & Redis failure modes, soft-deactivation semantics + ops recovery notes.
- `2026-07-14-r2-avatar-upload.md` — browser-cropped avatar direct upload to private R2, media queue validation/transcoding, public CDN URL, replacement/deletion compensation, account-deletion exception, Cloudflare setup/smoke/rollback.
- `2026-08-01-unified-file-upload.md` — foundational unified files domain for message attachments and new avatars: data model/state machine, format and parser security, transcript/privacy behavior, retention/quota/account rules, queues/credential topology, feature flag, R2/ClamAV smoke, rollout and rollback. Read the 2026-08-09 performance handover for the current transport and storage-write path; ticket 15 contract remains gated on production verification.
- `2026-08-03-gpt-vision-input.md` — GPT 图片输入实现、独立 preview bucket/五凭证矩阵、维护窗口、backfill 门禁、真实资源 smoke、可观测性与回滚手册；生产白名单默认保持为空。
- `2026-08-09-sent-image-placement-stability.md` — stable sent-image placement from composer to user message: local Blob ownership transfer, frame reservation, single-node pixel stability, discarded transition attempts, verification results, and the pending real-Chrome smoke.
- `2026-08-09-file-upload-performance.md` — measured upload phase baseline and the adaptive multipart, server-side promotion, fresh-client, worker recycling, telemetry, rollout, and real-R2 verification changes.
- `2026-08-13-clamav-startup-readiness.md` — ClamAV startup refresh ordering, signature-aware readiness, the persisted-database race, and local/production verification.
- `2026-07-17-agent-runtime-refactor-issue01-02.md` — session handoff for agent-runtime-refactor tickets 01–02: kernel/legacy coexist strategy, the three architecture-purity rulings (DB-free kernel context, tool-agnostic ToolResult, flat message lists), env pitfalls, and next steps (tickets 03/04).

### `docs/handover/frontend/`

Historical frontend rebuild handovers. Read `docs/architecture/frontend.md` first for the current architecture, then use the matching handover for implementation rationale and feature-specific verification:

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
- `2026-08-14-sidebar-rail-and-chat-actions.md` — collapsed sidebar becomes a 52px rail (new chat / recent 10 / account), the chat header is removed in favor of floating share + three-dot actions, and chat-page sharing copies a permanent link without a dialog
- `2026-08-15-chatgpt-ai-response-rendering.md` — observed ChatGPT assistant-response rendering, the current iChat pipeline, a gap matrix, and the handoff into `.scratch/refactor-chat-render/`; the PRD owns the confirmed implementation scope
- `2026-08-15-assistant-rendering-visual-fixture.md` — ticket 01's isolated visual fixture, the point-in-time ChatGPT reference boundary, diagnostic screenshot semantics, and the constraints carried into ticket 02

### `docs/goals/`

Goal documents for goal-driven development runs (success criteria + verification). Paired with same-dated handover docs.

### `docs/superpowers/specs/`

Pre-implementation design specs. Consult for product/design rationale.

- `2026-05-16-ai-chat-backend-mvp-design.md` — overall MVP scope, architecture, technical decisions
- `2026-05-17-run-cancellation-design.md` — cancellation design details and HTTP semantics
- `2026-05-24-frontend-react-rebuild-design.md` — historical master plan for the React rebuild; use `docs/architecture/frontend.md` for the current structure and invariants
- `2026-06-11-web-search-tool-design.md` — web search tool design (tool schema, query planner, agent loop budget, source dedup, evidence compression). Note: the rule-based query planner / pre-search it specifies was removed 2026-06-17 (now model-driven); `system_prompt_snapshot` semantics also superseded — see `docs/handover/2026-06-17-system-prompt-management.md`.
- `2026-06-18-public-id-and-conversation-sharing-design.md` — opaque `public_id` (dual-key, keep bigint PK) to drop sequential IDs from the API surface, plus conversation sharing via a separate `share_links` token + read-only snapshot. Includes scope/format/sharing-semantics open decisions.
- other dated specs — per-feature designs (auto-title, regenerate, thinking mode, frontend sub-steps)

### `docs/superpowers/plans/`

Historical implementation checklists, one per past sprint. **Not active reference.** Consult only when reconstructing how a past implementation was sequenced. For "what was built", prefer the matching handover doc.

### `docs/deployment.md`

Production deployment runbook — Linux server setup, Docker Compose, Nginx reverse proxy, Cloudflare SSL/TLS, Cloudflare Pages frontend hosting, environment variables. File-upload-specific R2/ClamAV smoke and rollout gates are in `handover/2026-08-01-unified-file-upload.md`.
