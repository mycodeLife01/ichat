import { expect, test, type Page } from "@playwright/test";

type Summary = {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  total: number;
};

type PerformanceResult = {
  scenario: string;
  environment: {
    longTaskSupported: boolean;
    eventTimingSupported: boolean;
  };
  fixture: {
    finalContentLength: number;
    source: string;
    observedRunId: number | null;
  };
  renderer: {
    samples: number;
    renderDurationMs: Summary;
    contentUpdateRenderDurationMs: Summary;
    updateToCommitMs: Summary;
  };
  longTasks: {
    durationMs: Summary;
    over100ms: number;
  };
  composer: {
    commitMs: Summary;
    eventTimingMs: Summary;
  };
  memory: {
    baselineHeapBytes: number | null;
    peakHeapBytes: number | null;
    endHeapBytes: number | null;
    peakDeltaBytes: number | null;
  };
};

async function readResult(page: Page) {
  const value = await page.getByTestId("performance-result").textContent();
  return JSON.parse(value ?? "null") as PerformanceResult;
}

async function runScenario(page: Page, buttonName: string, timeout = 30_000) {
  await page.getByRole("button", { name: buttonName }).click();
  await expect(page.getByRole("status")).toHaveAttribute("data-state", "complete", {
    timeout,
  });
  return readResult(page);
}

test("profiles long Markdown and preserves closed rich-block interaction state", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chrome",
    "Performance evidence uses the fixed desktop Chromium project.",
  );
  test.setTimeout(120_000);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/tests/visual/assistant-rendering-performance.html");
  await expect(page.getByTestId("performance-fixture")).toBeVisible();

  const results: PerformanceResult[] = [];
  for (const [buttonName, scenario, length] of [
    ["Measure static 10k", "static-10000", 10_000],
    ["Measure static 20k", "static-20000", 20_000],
    ["Measure static 50k", "static-50000", 50_000],
  ] as const) {
    const result = await runScenario(page, buttonName, 30_000);
    expect(result.scenario).toBe(scenario);
    expect(result.fixture.finalContentLength).toBe(length);
    expect(result.renderer.samples).toBeGreaterThan(0);
    results.push(result);
  }

  await page.getByRole("button", { name: "Replay sanitized real trace" }).click();
  await expect(page.getByRole("status")).toHaveAttribute("data-state", "running");
  const composer = page.getByTestId("performance-composer");
  await composer.click();
  await composer.pressSequentially("typing remains responsive", { delay: 18 });
  await expect(page.getByRole("status")).toHaveAttribute("data-state", "complete", {
    timeout: 30_000,
  });
  const realTrace = await readResult(page);
  expect(realTrace.scenario).toBe("sanitized-real-trace");
  expect(realTrace.fixture.finalContentLength).toBe(174);
  expect(realTrace.fixture.observedRunId).toBe(1487);
  expect(realTrace.environment.longTaskSupported).toBe(true);
  expect(realTrace.longTasks.over100ms).toBe(0);
  expect(realTrace.composer.commitMs.count).toBeGreaterThan(0);
  expect(realTrace.composer.commitMs.p95).toBeLessThan(50);
  expect(realTrace.composer.commitMs.max).toBeLessThan(100);
  results.push(realTrace);

  const openFence = await runScenario(page, "Replay open code fence", 45_000);
  expect(openFence.scenario).toBe("open-code-fence");
  expect(openFence.fixture.finalContentLength).toBe(20_000);
  expect(page.getByTestId("performance-markdown").locator(".katex-error")).toHaveCount(0);
  expect(page.getByTestId("performance-markdown").locator("[data-code-block]")).toHaveCount(1);
  results.push(openFence);

  const closedBlocks = await runScenario(page, "Replay closed rich blocks", 45_000);
  expect(closedBlocks.scenario).toBe("closed-rich-blocks");
  expect(closedBlocks.fixture.finalContentLength).toBe(20_000);
  results.push(closedBlocks);

  const markdown = page.getByTestId("performance-markdown");
  const codeBlock = markdown.locator("[data-code-block]").first();
  const tableBlock = markdown.locator("[data-table-block]").first();
  const codeViewport = codeBlock.locator("[data-code-viewport]");
  const tableViewport = tableBlock;
  await expect(codeBlock).toBeVisible();
  await expect(tableBlock).toBeVisible();
  await codeBlock.evaluate((element) => {
    element.setAttribute("data-identity-probe", "code");
  });
  await tableBlock.evaluate((element) => {
    element.setAttribute("data-identity-probe", "table");
  });
  const codeScrollLeft = await codeViewport.evaluate((element) => {
    element.scrollLeft = Math.min(64, element.scrollWidth - element.clientWidth);
    return element.scrollLeft;
  });
  const tableScrollLeft = await tableViewport.evaluate((element) => {
    element.scrollLeft = Math.min(64, element.scrollWidth - element.clientWidth);
    return element.scrollLeft;
  });
  expect(codeScrollLeft).toBeGreaterThan(0);
  expect(tableScrollLeft).toBeGreaterThan(0);
  await codeBlock.getByRole("button", { name: "复制代码" }).click();
  await tableBlock.getByRole("button", { name: "复制表格" }).click();
  await expect(codeBlock.getByRole("button", { name: "已复制" })).toBeVisible();
  await expect(tableBlock.getByRole("button", { name: "已复制表格" })).toBeVisible();
  await tableViewport.evaluate((element) => {
    element.scrollLeft = Math.min(64, element.scrollWidth - element.clientWidth);
  });

  const viewport = page.getByTestId("performance-viewport");
  const verticalScrollTop = await viewport.evaluate((element) => {
    element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(verticalScrollTop).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Append delta" }).click();
  await expect(markdown).toContainText("后续 delta");
  await expect(codeBlock).toHaveAttribute("data-identity-probe", "code");
  await expect(tableBlock).toHaveAttribute("data-identity-probe", "table");
  expect(await codeViewport.evaluate((element) => element.scrollLeft)).toBe(codeScrollLeft);
  expect(await tableViewport.evaluate((element) => element.scrollLeft)).toBe(tableScrollLeft);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(verticalScrollTop);
  await expect(codeBlock.getByRole("button", { name: "已复制" })).toBeVisible();
  await expect(tableBlock.getByRole("button", { name: "已复制表格" })).toBeVisible();

  expect(pageErrors).toEqual([]);
  await testInfo.attach("assistant-rendering-performance", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
});
