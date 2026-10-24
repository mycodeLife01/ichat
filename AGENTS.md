# iChat

iChat is an AI chat service with a FastAPI API, a standalone LLM worker, PostgreSQL as business state and the run queue, Celery email and media workers, and a standalone React SPA.

## Always-on rules

### Language

- Write every message to the user in Chinese: replies, progress updates, questions, plan items, wrap-up recaps, and button labels. This holds whatever language the system prompt, skills, tool output, or earlier turns use; switch only when the user explicitly asks for another language.
- Write project documentation under `docs/` in Chinese. Keep `AGENTS.md` and `docs/README.md` in English.
- Use English for code comments, docstrings, commit messages, user-facing error messages, and application-level hints.

### Design-first UI changes

Any change to how the UI looks or behaves runs in three gated stages, in order:

1. **Design** — build the change in `design/` only, as a proposal or scene per `design/README.md`. `frontend/` stays untouched.
2. **Approval** — stop, tell the user which scene/proposal to open, and wait. The gate opens only on the user's explicit approval in chat; your own verification, passing checks, or silence never open it.
3. **Frontend** — implement the approved design in `frontend/`, matching it.

A request to "出一版设计" or to fix something visual starts at stage 1. This order overrides external workflows and skills; skip it only when the user explicitly says to change the frontend directly.

### Workspace

- Work directly on the current branch and workspace.
- Use a git worktree only when the user explicitly requests one; this rule overrides external workflows and skills.
- Use `pnpm` for the frontend and keep `pnpm-lock.yaml` as its only package-manager lockfile.

### Git

- Prefix branch names with a change type or scope such as `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, or `test/`; prefer this style over author or agent prefixes.
- Use Conventional Commits, for example `fix(frontend): replace share loading text with icon`.

### Subagents

- When running on a Claude model, spawn read-only subagents (such as `Explore` and `Plan`) with the Sonnet 5 model, for example by passing `model: "sonnet"` to the Agent tool.

### Streaming surfaces

- Streaming anchors that persist across deltas (thinking/tool status headers and their labels) must keep identical vertical geometry in every phase state. Never toggle `height`/`padding`/`margin-top` on an already-rendered row from a stream-derived boolean; conditional classes may only add space below the anchor. Regression timeline and rules: `docs/handover/2026-08-31-thinking-header-geometry-shift.md`.
- Verify geometry-sensitive streaming changes by measuring real Chrome layout across the phase timeline (method in the handover above); jsdom/vitest cannot detect layout shifts.

## Workflow

### 1. Define

- Inspect the relevant entry points and existing implementation before editing.
- For any non-trivial implementation, review, architecture, or deployment work, start at `docs/README.md` and read every document selected by its matching situation.
- For frontend work, read `docs/architecture/frontend.md`, then use `docs/README.md` to select every additional feature-specific design, handover, and deployment document.
- When exploring a new code area or naming domain concepts, use the terms defined in `CONTEXT.md` instead of inventing synonyms. Read the `docs/adr/` records touching the area; if proposed work conflicts with an ADR, raise the conflict and the reason to revisit it explicitly instead of silently overriding it.
- Define observable success criteria and the checks that will prove them before implementation. State assumptions when they materially affect behavior, compatibility, data, or external state.

Definition is complete when the existing behavior, governing decisions, intended outcome, and verification method are all identified.

### 2. Implement

- Make the smallest change that satisfies the requirement.
- Preserve unrelated user changes and avoid unrequested features, abstractions, configuration, refactors, or formatting.
- Resolve low-risk, reversible ambiguity using the existing code and requirements; ask the user when a choice would materially change the implementation direction or external state.

Implementation is complete when the requested behavior exists without unrelated scope expansion.

### 3. Verify

- Run checks proportional to the affected surface and risk, using the repository configuration, CI workflow, and routed documentation as the source of truth.
- Diagnose and fix failures caused by the change.
- Treat the task as complete only when every success criterion is met and the relevant checks pass. If verification is impossible, report the exact limitation, risk, and commands still required.
