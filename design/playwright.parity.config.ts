import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/parity",
  workers: 1,
  timeout: 45000,
  outputDir: "./output/parity",
  reporter: [["list"], ["json", { outputFile: "output/parity-report.json" }]],
  use: {
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 5182 --strictPort",
      url: "http://127.0.0.1:5182",
      reuseExistingServer: false,
    },
    {
      command:
        "pnpm --dir ../frontend exec vite --host 127.0.0.1 --port 5183 --strictPort",
      url: "http://127.0.0.1:5183",
      env: { VITE_API_BASE_URL: "/api/v1" },
      reuseExistingServer: false,
    },
  ],
});
