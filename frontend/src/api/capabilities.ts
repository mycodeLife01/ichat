import { getDefaultApiClient, type ApiClient } from "./client";
import type { CapabilitiesResponse } from "./types";

export function createCapabilitiesApi(client?: Pick<ApiClient, "request">) {
  const resolveClient = () => client ?? getDefaultApiClient();

  return {
    get(): Promise<CapabilitiesResponse> {
      return resolveClient().request<CapabilitiesResponse>("/capabilities");
    },
  };
}

export type CapabilitiesApi = ReturnType<typeof createCapabilitiesApi>;

export const capabilitiesApi = createCapabilitiesApi();
