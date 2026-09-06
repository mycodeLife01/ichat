import { ApiError } from "../api/errors";
import type { Scene } from "../scenarios/registry";
export function createOutcomes(scene: Scene) {
  const failed = new Set<string>();
  let released = false;
  return {
    release() {
      released = true;
    },
    async run<T>(
      operation: string,
      value: T | (() => T),
      options?: { initial?: boolean },
    ) {
      while (scene.outcome === "loading" && !released)
        await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (
        scene.outcome === "error" &&
        !options?.initial &&
        !failed.has(operation)
      ) {
        failed.add(operation);
        throw new ApiError({ status: operation === "login" ? 401 : 503 });
      }
      return typeof value === "function" ? (value as () => T)() : value;
    },
  };
}
