# AIChat Backend MVP Design

Date: 2026-05-16

## Goal

Build the first production-usable backend for an AIChat platform similar to ChatGPT. The MVP supports username/email password authentication, conversation management, linear chat, DeepSeek-backed LLM generation, durable streaming output, explicit cancellation, and replayable stream events.

The central product rule is:

> An HTTP connection observes a run; it does not own the run lifecycle.

If a client disconnects from the stream, the backend continues generation by default. The client can reconnect and replay persisted output events. A run changes lifecycle only through backend state transitions such as success, failure, explicit cancel, or regenerate.

## Scope

In scope for the first version:

- User registration and login with username/email plus password.
- JWT access tokens plus persisted refresh tokens.
- Conversation create, list, detail, rename, and soft delete.
- Linear conversation messages with user and assistant roles.
- Sending a user message creates a queued LLM run.
- DeepSeek as the only provider in MVP, called through its OpenAI-compatible streaming API with `httpx`.
- Provider abstraction that allows additional providers later.
- Text delta event persistence with monotonic `seq` per run.
- SSE stream replay using `after_seq` query cursor only.
- Explicit run cancellation.
- Regenerate from any user message by archiving later messages and creating a new run.
- PostgreSQL-backed run queue with independent worker process.
- Worker lease/heartbeat and timeout recovery.
- Structured logs with request, user, run, and conversation correlation.
- Core unit tests and API integration tests with fake provider streams.

Out of scope for the first version:

- Frontend application.
- Email sending and email verification flow, though verification structures are reserved.
- Password reset.
- Billing, quota, and payment.
- Redis, Celery, LangChain, LangGraph, LiteLLM, OpenTelemetry, and Prometheus.
- Conversation branches as first-class product objects.
- Native EventSource support and `Last-Event-ID`.
- Model/provider management API.

## Technology

- Python 3.12.
- FastAPI.
- PostgreSQL.
- SQLAlchemy 2.0 async with asyncpg.
- Alembic.
- uv.
- httpx for DeepSeek HTTP streaming.
- pytest for tests.
- Docker Compose for local and small production deployment.

The deployment shape is:

- `api`: FastAPI service.
- `worker`: independent async worker process.
- `postgres`: durable state store and run queue.

## Architecture

The API service handles authentication, conversation and message APIs, run creation, cancellation, regeneration, and SSE event reads. It never calls DeepSeek directly in request handlers.

The worker process claims queued runs from PostgreSQL, holds execution ownership through a lease and heartbeat, builds provider context, calls DeepSeek streaming API, parses provider SSE chunks, normalizes text deltas, and persists run events.

PostgreSQL is the source of truth for users, sessions, conversations, messages, runs, and run events. It also backs the queue through run status, lease fields, and row-level claiming.

The queue mechanism is PostgreSQL row claiming with transactional updates and `FOR UPDATE SKIP LOCKED` or equivalent SQLAlchemy-supported locking. Redis or a dedicated task system is intentionally deferred.

## Authentication

Users can register and log in with username/email plus password. Passwords are stored only as secure password hashes.

Login returns:

- A short-lived JWT access token.
- A long-lived refresh token persisted in PostgreSQL.

Refresh tokens can be revoked for logout. Access tokens are used for REST APIs and SSE streams through `Authorization: Bearer <token>`.

The user model includes `email_verified`, defaulting to false. The MVP does not send verification emails. The schema includes an email verification token table reserved for a later verification flow so that future email verification does not require reshaping the auth model.

Password reset is not included in the MVP.

## Conversations And Messages

Conversations are first-class resources owned by a user. The MVP supports:

- `POST /api/v1/conversations`
- `GET /api/v1/conversations`
- `GET /api/v1/conversations/{conversation_id}`
- `PATCH /api/v1/conversations/{conversation_id}`
- `DELETE /api/v1/conversations/{conversation_id}`

`POST /api/v1/conversations` creates an empty conversation for a new chat window. `PATCH` supports renaming. `DELETE` soft-deletes the conversation. A soft-deleted conversation is hidden from normal list/detail APIs and cannot receive new messages. Existing messages, runs, and events remain in the database for audit and debugging.

The conversation model is a linear mainline. Messages are ordered within a conversation and have a role of `user` or `assistant`. The MVP does not support conversation-level system prompts. Context building uses a global default system prompt from configuration.

Sending a message uses:

- `POST /api/v1/conversations/{conversation_id}/messages`

This endpoint writes the user message and creates a queued run in the same transaction. It returns the user message id and run id.

Each conversation allows at most one active run at a time. Active states are `queued`, `started`, `streaming`, and `cancelling`.

## Regenerate

Regenerate is supported from any visible user message:

- `POST /api/v1/messages/{message_id}/regenerate`

The target message must be a user message owned by the current user.

Regenerate semantics:

1. Find the target user message.
2. Cancel any active run later in the same conversation.
3. Soft-archive every message after the target message.
4. Create a new queued run using conversation context up to and including the target message.

To the product, messages after the target appear cleared. To the backend, those messages remain available for audit and debugging through archived metadata.

The MVP does not expose full conversation branches. Archived messages are not part of normal visible context.

## Run State Machine

Runs use provider-agnostic public states:

- `queued`
- `started`
- `streaming`
- `succeeded`
- `failed`
- `cancelling`
- `cancelled`

Terminal states are `succeeded`, `failed`, and `cancelled`.

Expected transitions:

- `queued -> started -> streaming -> succeeded`
- `queued -> cancelling -> cancelled`
- `started -> failed`
- `streaming -> failed`
- `started -> cancelling -> cancelled`
- `streaming -> cancelling -> cancelled`

Runs record timestamps such as created, started, first streamed, completed, failed, cancelled, and updated. Runs also record provider name, provider model, provider request id when available, error code/message, usage metadata, lease owner, lease expiry, and heartbeat time.

The worker claims queued runs by transactionally moving them to `started` and setting lease fields. During execution it renews the lease. If a worker crashes or is restarted, a recovery loop marks expired active runs as `failed` with an interruption reason and preserves any partial run events.

## Run Events And Replay

Every text delta produced by the provider is normalized into a run event. Each event has a monotonically increasing `seq` within its run.

Run event examples include:

- `text_delta`
- `run_started`
- `run_succeeded`
- `run_failed`
- `run_cancelled`

Only text delta event replay is required for the user-visible stream, but terminal events are useful for clients and debugging.

The final assistant message is materialized from accumulated deltas only when the run succeeds. If a run fails or is cancelled after partial output, partial run events remain persisted, but no assistant message is materialized for that partial output. Clients can display partial output from run events together with the terminal run status.

## SSE API

Clients stream run events with:

- `GET /api/v1/runs/{run_id}/events?after_seq=0`

Authentication uses the normal access token:

- `Authorization: Bearer <access_token>`

The MVP supports only the `after_seq` query cursor. It does not support `Last-Event-ID`.

The stream endpoint:

1. Authorizes the user against the run's conversation.
2. Sends stored events where `seq > after_seq`.
3. Tails new persisted events.
4. Ends after a terminal run event is observed.

The SSE endpoint does not call DeepSeek and does not own run execution. It reads PostgreSQL only.

## Cancellation

Cancellation uses:

- `POST /api/v1/runs/{run_id}/cancel`

If the run is active and belongs to the current user, the API marks it `cancelling`. The worker checks cancellation between provider chunks and during heartbeat work. When cancellation is observed, the worker closes the provider stream, writes a terminal cancellation event, and marks the run `cancelled`.

If a queued run is cancelled before a worker claims it, it moves directly to `cancelled`.

Cancellation is idempotent for terminal runs and active runs already in `cancelling`.

## DeepSeek Provider

The MVP uses DeepSeek only, but business logic depends on a provider interface rather than DeepSeek-specific classes.

The DeepSeek provider implementation:

- Uses `httpx` directly.
- Calls DeepSeek's OpenAI-compatible `/chat/completions` streaming API.
- Sends `stream: true`.
- Parses provider SSE `data:` lines.
- Extracts assistant text deltas.
- Maps provider finish and error metadata into normalized run events and run fields.

The MVP does not use the OpenAI Python SDK for DeepSeek. This preserves direct control of streaming, cancellation, retry, timeout handling, and event persistence.

DeepSeek thinking/reasoning support is a provider-level configuration capability. It is disabled by default in the MVP. Default user-visible output includes only assistant text.

Provider configuration comes from environment/config:

- API key.
- Base URL.
- Model name.
- Timeout settings.
- Thinking/reasoning enabled flag.
- Default generation parameters.

There is no provider/model management API in the MVP.

## Context Building

The worker does not assemble provider messages inline. It calls a context builder.

The MVP context builder:

- Starts with a global default system prompt from configuration.
- Reads visible, non-archived messages in conversation order.
- Includes context up to the run's target user message.
- Applies a simple recent-history truncation strategy based on configurable token or character budget.

The design keeps context strategy isolated so later versions can add summarization, provider-specific budgets, or richer prompt policies without rewriting worker execution.

## Failure Handling

API errors are structured with stable error codes and human-readable messages.

Provider failure behavior:

- If DeepSeek fails before any text delta is persisted, the worker retries once.
- If any text delta has already been persisted, the worker does not retry automatically.
- Partial events remain persisted.
- The run is marked `failed` with error code and message.

Context building failure, database failure, lease loss, and unexpected worker exceptions are mapped to `failed` when possible.

Worker interruption behavior:

- Active runs have lease expiry and heartbeat metadata.
- Recovery logic marks expired active runs failed.
- No attempt is made to resume a provider HTTP stream.
- No attempt is made to replay already-produced deltas back into a new provider call automatically.

This avoids creating duplicate or semantically inconsistent assistant output.

## Usage And Observability

When DeepSeek returns token usage or comparable metadata, the worker stores it on the run. Usage is for observability and future billing support only. The MVP has no quota or billing logic.

Logs are structured and include correlation fields where available:

- request id
- user id
- conversation id
- run id
- provider
- provider request id

Metrics and tracing are deferred.

## Deployment

The MVP is deployed with Docker Compose:

- `api`
- `worker`
- `postgres`

Configuration is environment-driven. Required values include:

- PostgreSQL DSN.
- JWT secret and token TTLs.
- Refresh token TTL.
- DeepSeek API key.
- DeepSeek base URL.
- DeepSeek model.
- Global default system prompt.
- DeepSeek thinking/reasoning flag.
- Run lease duration.
- Worker poll interval.
- Worker heartbeat interval.
- Log level.

Alembic migrations manage database schema.

## Testing

Default automated tests do not call real DeepSeek.

Unit tests cover:

- Password hashing and token logic.
- Refresh token persistence and revocation.
- Context builder truncation.
- DeepSeek SSE parser.
- Run state transitions.
- Cancellation state transitions.
- Regenerate archive rules.

API integration tests cover:

- Registration and login.
- Token refresh and logout.
- Conversation create/list/detail/rename/delete.
- Sending a message and creating a queued run.
- SSE replay from `after_seq`.
- Run cancellation.
- Regenerate from an arbitrary user message.
- Authorization boundaries between users.

Worker tests use a fake provider stream to simulate:

- Successful text deltas.
- Failure before first delta and retry success.
- Failure after partial delta.
- Cancellation during streaming.
- Lease timeout recovery behavior.

A manual DeepSeek smoke command is included for local verification with real credentials, but it is not part of default automated tests.

## Implementation Notes

The project should be structured around clear boundaries:

- `api`: route handlers and request/response schemas.
- `auth`: password, JWT, refresh token behavior.
- `db`: SQLAlchemy models, sessions, migrations.
- `conversations`: conversation and message services.
- `runs`: run state machine, queue claiming, events, cancellation.
- `providers`: provider interface and DeepSeek adapter.
- `context`: provider message assembly.
- `worker`: polling, lease, execution loop, recovery.
- `core`: config, logging, error types.

The implementation should keep route handlers thin. Business rules such as "one active run per conversation", "regenerate archives later messages", and "SSE reads only persisted events" belong in services that can be tested without HTTP.

## Open Decisions Closed In This Spec

- Use PostgreSQL-backed run queue rather than in-process background tasks or Redis/Celery.
- Use `httpx` direct streaming for DeepSeek rather than the OpenAI Python SDK.
- Use `after_seq` query cursor only for replay.
- Use fetch-based SSE with Authorization header.
- Use global system prompt only in MVP.
- Use soft delete for conversations and soft archive for messages removed by regenerate.
- Allow one active run per conversation.
- Retry provider failure only before the first persisted delta.
