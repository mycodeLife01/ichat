# Frontend React Step 1 Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old vanilla frontend entry with a minimal Vite React TypeScript app and a working automated test scaffold.

**Architecture:** This step creates only the frontend build and test foundation. It does not migrate API/auth/SSE behavior yet; it prepares directories and tooling so later steps can add typed API modules, reducers, hooks, and UI components under stable boundaries.

**Tech Stack:** Vite, React, TypeScript, Vitest, Testing Library, jest-dom, jsdom, MSW, ESLint.

---

## File Structure

- Create `frontend/package.json` for npm scripts and dependencies.
- Create `frontend/package-lock.json` through `npm install`.
- Replace `frontend/index.html` with the Vite SPA shell.
- Create `frontend/vite.config.ts` with React plugin and Vitest jsdom setup.
- Create `frontend/tsconfig.json`, `frontend/tsconfig.app.json`, and `frontend/tsconfig.node.json`.
- Create `frontend/eslint.config.js` for flat ESLint config.
- Create `frontend/src/main.tsx`, `frontend/src/app/App.tsx`, `frontend/src/styles/global.css`, and `frontend/src/test/setup.ts`.
- Create empty module boundary directories under `frontend/src/`: `api`, `auth`, `conversations`, `runs`, `messages`, `ui`, `test`.
- Create `frontend/src/app/App.test.tsx` as the first smoke component test.
- Modify `.gitignore` to ignore frontend build artifacts and dependencies.
- Delete old vanilla frontend files under `frontend/` so Vitest does not pick up source-level legacy tests.

## Task 1: Create Tooling And RED Test

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.app.json`
- Create: `frontend/tsconfig.node.json`
- Create: `frontend/eslint.config.js`
- Create: `frontend/src/app/App.test.tsx`
- Create: `frontend/src/test/setup.ts`
- Modify: `.gitignore`
- Delete: `frontend/app.js`, `frontend/api.js`, `frontend/auth.js`, `frontend/sse.js`, `frontend/state.js`, `frontend/styles.css`, `frontend/ui.js`, `frontend/views/chat.js`, `frontend/views/chat.test.js`, `frontend/views/login.js`

- [ ] **Step 1: Add npm, TypeScript, Vitest, and ESLint configuration**

Add scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest"
  }
}
```

- [ ] **Step 2: Add a failing component smoke test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the React rebuild shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "iChat" })).toBeInTheDocument();
    expect(screen.getByText("React rebuild scaffold is ready.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Install dependencies**

Run:

```bash
npm install
```

Expected: `frontend/package-lock.json` is generated.

- [ ] **Step 4: Run the test and confirm RED**

Run:

```bash
npm run test -- --run
```

Expected: fails because `frontend/src/app/App.tsx` does not exist yet.

## Task 2: Add Minimal React App And Verify

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/app/App.tsx`
- Create: `frontend/src/styles/global.css`
- Create: `.gitkeep` files for empty module directories under `frontend/src/`

- [ ] **Step 1: Add minimal App implementation**

```tsx
export function App() {
  return (
    <main className="app-shell" aria-label="iChat React application">
      <section className="app-card">
        <p className="app-eyebrow">Frontend rebuild</p>
        <h1>iChat</h1>
        <p>React rebuild scaffold is ready.</p>
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Add Vite entry**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 3: Run focused frontend verification**

Run:

```bash
npm run test -- --run
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0.

## Self-Review

- Spec coverage: covers implementation order item 1 only, not API/auth/SSE/backend/CORS/UI migration.
- Placeholder scan: no `TBD`, `TODO`, or deferred implementation text in code steps.
- Type consistency: `App` is exported from `frontend/src/app/App.tsx` and imported by both `main.tsx` and `App.test.tsx`.
