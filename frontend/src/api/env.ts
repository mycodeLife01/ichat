export function normalizeApiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new Error("VITE_API_BASE_URL is required");
  }

  return trimmed.replace(/\/+$/, "");
}

export function resolveApiBaseUrl(value: string | undefined, pageOrigin: string): string {
  const normalized = normalizeApiBaseUrl(value);
  if (!normalized.startsWith("/")) return normalized;
  return `${pageOrigin.replace(/\/+$/, "")}${normalized}`;
}

export function getApiBaseUrl(): string {
  return resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, window.location.origin);
}
