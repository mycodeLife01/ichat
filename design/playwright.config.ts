import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/visual",
  workers: 1,
  timeout: 30000,
  outputDir: "./output/visual",
  reporter: [["list"], ["json", { outputFile: "output/visual-report.json" }]],
  use: {
    baseURL: "http://127.0.0.1:5182",
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
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 5182 --strictPort",
    url: "http://127.0.0.1:5182",
    reuseExistingServer: false,
  },
});
