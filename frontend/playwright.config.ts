import { defineConfig } from "@playwright/test";

const visualFixtureUrl = "http://127.0.0.1:4176/tests/visual/assistant-rendering.html";

export default defineConfig({
  testDir: "./tests/visual",
  testMatch: "**/*.visual.ts",
  outputDir: "./output/playwright/results",
  fullyParallel: false,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4176",
    colorScheme: "light",
    contextOptions: {
      reducedMotion: "reduce",
    },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-chrome",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4176 --strictPort",
    url: visualFixtureUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
