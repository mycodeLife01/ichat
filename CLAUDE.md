# iChat

iChat is an AI chat service with a FastAPI API, a standalone LLM worker, PostgreSQL as business state and the run queue, Celery email and media workers, and a standalone React SPA.

## Always-on rules

### Language

- Use Chinese for Claude Code interactions unless the user or task requires another language.
- Write project documentation under `docs/` in Chinese. Keep `AGENTS.md` and `docs/README.md` in English.
- Use English for code comments, docstrings, user-facing error messages, and application-level hints.

### Workspace

- Work directly on the current branch and workspace.
- Use a git worktree only when the user explicitly requests one; this rule overrides external workflows and skills.
- Use `pnpm` for the frontend and keep `pnpm-lock.yaml` as its only package-manager lockfile.

### Git

- Prefix branch names with a change type or scope such as `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, or `test/`; prefer this style over author or agent prefixes.
- Use Conventional Commits, for example `fix(frontend): replace share loading text with icon`.

## Workflow

### 1. Define

- Inspect the relevant entry points and existing implementation before editing.
- For any non-trivial implementation, review, architecture, or deployment work, start at `docs/README.md` and read every document selected by its matching situation.
- For frontend work, read `docs/architecture/frontend.md`, then use `docs/README.md` to select every additional feature-specific design, handover, and deployment document.
- When exploring a new code area, changing domain terminology, or proposing a decision that may affect an ADR, follow `docs/agents/domain.md`.
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

## Task tracking

When triaging work or creating, reading, updating, or selecting `.scratch/` PRDs and tickets, follow `docs/agents/issue-tracker.md`.
