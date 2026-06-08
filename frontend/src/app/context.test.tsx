import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { initialState } from "./store";
import {
  ActionsContext,
  StateContext,
  useAppActions,
  useAppState,
  type AppActions,
} from "./context";

function StateProbe() {
  const state = useAppState();
  return <span>bootstrapped:{String(state.auth.bootstrapped)}</span>;
}

describe("useAppState", () => {
  it("throws outside the provider", () => {
    expect(() => renderHook(() => useAppState())).toThrow(/AppProvider/);
  });

  it("returns the provided state", () => {
    render(
      <StateContext.Provider value={initialState}>
        <StateProbe />
      </StateContext.Provider>,
    );
    expect(screen.getByText("bootstrapped:false")).toBeInTheDocument();
  });
});

describe("useAppActions", () => {
  it("throws outside the provider", () => {
    expect(() => renderHook(() => useAppActions())).toThrow(/AppProvider/);
  });

  it("returns the provided actions", () => {
    const actions: AppActions = {
      dispatch: vi.fn(),
      services: {
        authApi: {} as AppActions["services"]["authApi"],
        conversationApi: {} as AppActions["services"]["conversationApi"],
      },
      streamAbort: { register: vi.fn(), abort: vi.fn() },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    );
    const { result } = renderHook(() => useAppActions(), { wrapper });
    expect(result.current).toBe(actions);
  });
});
