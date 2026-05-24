import { getDefaultApiClient, type ApiClient } from "./client";
import type { AuthTokenResponse, CommandStatusResponse } from "./types";

export type RegisterRequest = {
  username: string;
  email: string;
  password: string;
};

export type LoginRequest = {
  identifier: string;
  password: string;
};

export function createAuthApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    register(body: RegisterRequest): Promise<AuthTokenResponse> {
      return resolveClient().request<AuthTokenResponse>("/auth/register", {
        method: "POST",
        body,
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    login(body: LoginRequest): Promise<AuthTokenResponse> {
      return resolveClient().request<AuthTokenResponse>("/auth/login", {
        method: "POST",
        body,
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    refresh(refreshToken: string): Promise<AuthTokenResponse> {
      return resolveClient().request<AuthTokenResponse>("/auth/refresh", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      });
    },
    logout(refreshToken: string): Promise<CommandStatusResponse> {
      return resolveClient().request<CommandStatusResponse>("/auth/logout", {
        method: "POST",
        body: { refresh_token: refreshToken },
        auth: false,
        retryOnUnauthorized: false,
      });
    },
  };
}

export const authApi = createAuthApi();
