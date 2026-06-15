const STORAGE_KEY = "ichat.webSearchEnabled";

let capabilityEnabled = false;

export const webSearchPreferenceStore = {
  read(): boolean {
    return localStorage.getItem(STORAGE_KEY) === "true";
  },
  save(enabled: boolean): void {
    localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  },
  setCapability(enabled: boolean): void {
    capabilityEnabled = enabled;
  },
  capabilityEnabled(): boolean {
    return capabilityEnabled;
  },
  requestEnabled(): boolean {
    return capabilityEnabled && this.read();
  },
};
