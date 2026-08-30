const STORAGE_KEY = "ichat.model-management-access-key";

export const modelAdminAccessKeyStore = {
  read(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },

  save(accessKey: string): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, accessKey);
    } catch {
      // The console remains usable in memory when storage is unavailable.
    }
  },

  clear(): void {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Locking still clears React state when storage is unavailable.
    }
  },
};
