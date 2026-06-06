import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { AppProvider } from "../app/AppProvider";
import type { AuthApi, Services } from "../app/context";
import { authTokenResponse } from "./apiFixtures";

export function createFakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: async () => authTokenResponse,
    login: async () => authTokenResponse,
    refresh: async () => authTokenResponse,
    logout: async () => ({ status: "ok" }),
    ...overrides,
  };
}

export function createFakeServices(authApi: Partial<AuthApi> = {}): Services {
  return { authApi: createFakeAuthApi(authApi) };
}

export function makeWrapper(services: Services) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AppProvider services={services}>{children}</AppProvider>;
  };
}

export function renderWithApp(
  ui: ReactElement,
  services: Services,
  options?: RenderOptions,
): RenderResult {
  return render(<AppProvider services={services}>{ui}</AppProvider>, options);
}
