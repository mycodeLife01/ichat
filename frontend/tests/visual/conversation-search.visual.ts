import { expect, test, type Page } from "@playwright/test";

async function openSearch(page: Page) {
  if (
    await page
      .getByRole("button", { name: "打开历史", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "打开历史", exact: true }).click();
  await page.getByRole("button", { name: "搜索对话", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "搜索历史对话" }),
  ).toBeVisible();
}

test("search placement, neutral states, paging and exact navigation", async ({
  page,
}, info) => {
  await page.goto("/tests/visual/conversation-search.html");
  await openSearch(page);
  const dialog = page.getByRole("dialog", { name: "搜索历史对话" });
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  if (info.project.name === "desktop-chrome") {
    expect(box!.width).toBe(720);
    expect(box!.x + box!.width / 2).toBeCloseTo(viewport.width / 2, 0);
    expect(box!.y + box!.height / 2).toBeCloseTo(viewport.height / 2 - 46, 0);
  } else {
    expect(box!.height).toBe(viewport.height);
    expect(box!.width).toBe(viewport.width);
  }
  expect(
    await page
      .locator(".search-backdrop")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  const input = page.getByRole("combobox", { name: "搜索历史对话" });
  await input.fill("无结果");
  await expect(page.getByText("未找到相关对话", { exact: true })).toBeVisible();
  const centered = await page
    .locator(".search-results [role=status]")
    .boundingBox();
  const results = await page.locator(".search-results").boundingBox();
  expect(centered!.y + centered!.height / 2).toBeCloseTo(
    results!.y + results!.height / 2,
    0,
  );
  await input.fill("失败");
  await expect(
    page.getByText("搜索失败，请重试", { exact: true }),
  ).toBeVisible();
  expect(
    await page.locator(".search-results").locator("[role=alert]").count(),
  ).toBe(0);
  await input.fill("重点");
  await expect(page.locator("[data-search-row]")).toHaveCount(30);
  await page.screenshot({
    path: `output/playwright/search-${info.project.name}.png`,
  });
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator("[data-search-row]")).toHaveCount(60);
  await input.focus();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const registry = (
          CSS as unknown as { highlights: Map<string, Set<Range>> }
        ).highlights;
        return [...(registry.get("conversation-search-hit") ?? [])]
          .map((r) => r.toString())
          .join("");
      }),
    )
    .toBe("重点");
  const target = page.locator("[data-search-message-id=assistant-target]");
  await expect(target).toBeVisible();
  await page.screenshot({
    path: `output/playwright/search-target-${info.project.name}.png`,
  });
});

test("rail entry, keyboard close and stale-result error toast", async ({
  page,
}, info) => {
  await page.goto("/tests/visual/conversation-search.html");
  if (info.project.name === "desktop-chrome") {
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "搜索对话", exact: true }),
    ).toBeVisible();
  }
  await openSearch(page);
  await page.getByRole("combobox").fill("失效");
  await expect(page.locator("[data-search-row]").first()).toBeVisible();
  await page.locator("[data-search-row]").first().click();
  await expect(
    page.getByText("无法打开这段对话，请重新搜索后再试。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "搜索历史对话" }),
  ).toBeVisible();
  await page.getByRole("combobox").press("Escape");
  await expect(page.getByRole("dialog", { name: "搜索历史对话" })).toHaveCount(
    0,
  );
});

test("cross-node highlight holds then fades and stream deltas do not pull the viewport", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/tests/visual/conversation-search.html");
  await openSearch(page);
  await page.getByRole("combobox").fill("重点内容和跨节点");
  await page.evaluate(() => {
    const frames: { time: number; active: boolean; alpha: number }[] = [];
    Object.assign(window, { searchHighlightFrames: frames });
    const start = performance.now();
    const capture = () => {
      const active = (
        CSS as unknown as { highlights: Map<string, unknown> }
      ).highlights.has("conversation-search-hit");
      frames.push({
        time: performance.now(),
        active,
        alpha: Number(
          document.documentElement.style.getPropertyValue("--search-hit-alpha"),
        ),
      });
      if (performance.now() - start < 6500) requestAnimationFrame(capture);
    };
    requestAnimationFrame(capture);
  });
  await page.locator("[data-search-row]").first().click();
  const highlighted = () =>
    page.evaluate(() =>
      [
        ...((
          CSS as unknown as { highlights: Map<string, Set<Range>> }
        ).highlights.get("conversation-search-hit") ?? []),
      ]
        .map((r) => r.toString())
        .join(""),
    );
  await expect.poll(highlighted).toBe("重点内容和跨节点");
  const before = await page
    .locator(".thread-region")
    .evaluate((el) => el.scrollTop);
  await page.evaluate(() =>
    (window as unknown as { pushSearchStream: () => void }).pushSearchStream(),
  );
  await page.waitForTimeout(1000);
  expect(
    await page.locator(".thread-region").evaluate((el) => el.scrollTop),
  ).toBeCloseTo(before, 0);
  await expect.poll(highlighted).toBe("");
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          searchHighlightFrames: {
            time: number;
            active: boolean;
            alpha: number;
          }[];
        }
      ).searchHighlightFrames,
  );
  const active = frames.filter((frame) => frame.active);
  expect(active.length).toBeGreaterThan(20);
  expect(active.at(-1)!.time - active[0].time).toBeGreaterThan(2700);
  expect(active.at(-1)!.time - active[0].time).toBeLessThan(3250);
  expect(active.some((frame) => frame.alpha > 0 && frame.alpha < 0.6)).toBe(
    true,
  );
});

test("quote hit expands the sent snapshot and marks only the matched text", async ({
  page,
}) => {
  await page.goto("/tests/visual/conversation-search.html");
  await openSearch(page);
  await page.getByRole("combobox").fill("引用哨兵");
  await page.locator("[data-search-row]").first().click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [
          ...((
            CSS as unknown as { highlights: Map<string, Set<Range>> }
          ).highlights.get("conversation-search-hit") ?? []),
        ]
          .map((r) => r.toString())
          .join(""),
      ),
    )
    .toBe("引用哨兵");
  const quote = page.locator(
    '[data-search-message-id="quote-target"][data-search-field="reply_quote"]',
  );
  expect(
    await quote.evaluate((el) => getComputedStyle(el).webkitLineClamp),
  ).toBe("none");
});
