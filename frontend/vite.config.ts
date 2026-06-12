import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

function tailwindcssCompat(): Plugin[] {
  return tailwindcss().map((plugin) => {
    const transform = plugin.transform;
    if (
      transform == null ||
      typeof transform !== "object" ||
      !("handler" in transform) ||
      typeof transform.handler !== "function"
    ) {
      return plugin;
    }

    return {
      ...plugin,
      transform(code, id) {
        return transform.handler.call(this, code, id);
      },
    };
  });
}

export default defineConfig({
  plugins: [...tailwindcssCompat(), react()],
  server: {
    host: "0.0.0.0",
  },
  test: {
    css: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
