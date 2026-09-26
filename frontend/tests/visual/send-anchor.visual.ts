import { expect, test, type Page } from "@playwright/test";

// Real-geometry acceptance for send-anchored scrolling
// (docs/specs/2026-09-26-send-anchored-scrolling.md, section 4).

type Metrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
  userTop: number;
  userBottom: number;
  replyTop: number | null;
  footerTop: number;
  reserve: string;
};

// Anchor gap: desktop hides the previous reply's action bar; mobile clears the
// floating header controls.
const anchorGap = (page: Page) => ((page.viewportSize()?.width ?? 1440) <= 760 ? 60 : 40);

const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

const measure = async (page: Page): Promise<Metrics> => {
  await settle(page);
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>(".thread-region")!;
    const regionTop = region.getBoundingClientRect().top;
    const users = document.querySelectorAll<HTMLElement>(".thread-stage .msg.user");
    const lastUser = users[users.length - 1]!;
    const user = lastUser.getBoundingClientRect();
    const reply = lastUser.nextElementSibling;
    const footer = document.querySelector<HTMLElement>(".thread-bottom-container")!;
    const stage = document.querySelector<HTMLElement>(".thread-stage")!;
    return {
      scrollTop: region.scrollTop,
      scrollHeight: region.scrollHeight,
      clientHeight: region.clientHeight,
      maxScrollTop: region.scrollHeight - region.clientHeight,
      userTop: user.top - regionTop,
      userBottom: user.bottom - regionTop,
      replyTop: reply ? reply.getBoundingClientRect().top - regionTop : null,
      footerTop: footer.getBoundingClientRect().top - regionTop,
      reserve: stage.style.minHeight,
    };
  });
};

// Scroll offset needed to show the last real element above the Composer.
const contentMaxScrollTop = (page: Page) =>
  page.evaluate(() => {
    const region = document.querySelector<HTMLElement>(".thread-region")!;
    const inner = document.querySelector<HTMLElement>(".thread-inner")!;
    const footer = document.querySelector<HTMLElement>(".thread-bottom-container")!;
    const last = inner.lastElementChild!.getBoundingClientRect();
    const contentEnd =
      last.bottom -
      region.getBoundingClientRect().top +
      region.scrollTop +
      parseFloat(getComputedStyle(inner).paddingBottom) +
      footer.getBoundingClientRect().height;
    return Math.max(0, Math.round(contentEnd - region.clientHeight));
  });

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer").getByRole("textbox").fill(text);
  await page.getByTestId("composer").getByRole("button", { name: "发送" }).click();
};

const openFixture = async (page: Page, turns: number, paragraphs = 3) => {
  await page.goto(`/tests/visual/send-anchor.html?turns=${turns}&paragraphs=${paragraphs}`);
  await expect(page.locator(".thread-stage .msg.user").first()).toBeVisible();
  await settle(page);
};

test("lifts a new turn to the top and collapses the reserve after completion", async ({ page }) => {
  await openFixture(page, 8);

  // 6. Entering a conversation lands at the bottom without a reserve.
  const entered = await measure(page);
  expect(entered.scrollTop).toBeGreaterThan(0);
  expect(Math.abs(entered.scrollTop - entered.maxScrollTop)).toBeLessThanOrEqual(1);
  expect(entered.reserve).toBe("");

  await send(page, "新的问题");
  await expect(page.locator(".thread-stage .msg.user").last()).toContainText("新的问题");

  // 1. The new user message sits at the top gap.
  const anchored = await measure(page);
  expect(Math.abs(anchored.userTop - anchorGap(page))).toBeLessThanOrEqual(2);
  expect(anchored.reserve).not.toBe("");
  const previousActionIcons = await page.evaluate(() => {
    const users = document.querySelectorAll<HTMLElement>(".thread-stage .msg.user");
    const previous = users[users.length - 1]!.previousElementSibling!;
    const regionTop = document.querySelector(".thread-region")!.getBoundingClientRect().top;
    return [...previous.querySelectorAll("button svg")].map(
      (icon) => icon.getBoundingClientRect().bottom - regionTop,
    );
  });
  expect(previousActionIcons.length).toBeGreaterThan(0);
  if (anchorGap(page) === 40) {
    for (const bottom of previousActionIcons) expect(bottom).toBeLessThanOrEqual(0);
  }

  // 2. Streaming inside the reserve keeps scrollTop and scrollHeight constant.
  await expect(page.locator(".scroll-to-bottom-button")).toHaveAttribute("data-visible", "false");
  const samples: Metrics[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.evaluate((i) => window.sendAnchor.delta(`第 ${i + 1} 段回复内容。\n\n`), index);
    samples.push(await measure(page));
  }
  for (const sample of samples) {
    expect(sample.scrollTop).toBe(anchored.scrollTop);
    expect(sample.scrollHeight).toBe(anchored.scrollHeight);
    expect(Math.abs(sample.userTop - anchored.userTop)).toBeLessThanOrEqual(0.5);
  }

  // 3. Completion does not move the viewport.
  await page.evaluate(() => window.sendAnchor.finish());
  await expect(page.getByTestId("composer").getByRole("button", { name: "发送" })).toBeVisible();
  await page.waitForTimeout(200);
  const finished = await measure(page);
  expect(finished.scrollTop).toBe(anchored.scrollTop);
  expect(Math.abs(finished.userTop - anchored.userTop)).toBeLessThanOrEqual(0.5);

  // 4. Scrolling away and back reaches only the real content end.
  await page.locator(".thread-region").hover();
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(200);
  await page.mouse.wheel(0, 8000);
  await page.waitForTimeout(200);
  const returned = await measure(page);
  const realMax = await contentMaxScrollTop(page);
  expect(returned.reserve).toBe("");
  expect(Math.abs(returned.maxScrollTop - realMax)).toBeLessThanOrEqual(1);
  expect(Math.abs(returned.scrollTop - realMax)).toBeLessThanOrEqual(1);
});

test("keeps a short conversation at its natural position", async ({ page }) => {
  await openFixture(page, 1, 1);
  await send(page, "第一句");
  await expect(page.locator(".thread-stage .msg.user").last()).toContainText("第一句");
  const before = await measure(page);

  // 5. No lift, and any reserve stays within the visible area (no extra scroll range).
  expect(before.scrollTop).toBe(0);
  expect(before.maxScrollTop).toBe(0);
  await page.evaluate(() => window.sendAnchor.delta("简短回复。"));
  await page.evaluate(() => window.sendAnchor.finish());
  await expect(page.getByTestId("composer").getByRole("button", { name: "发送" })).toBeVisible();
  const after = await measure(page);
  expect(after.scrollTop).toBe(0);
  expect(Math.abs(after.userTop - before.userTop)).toBeLessThanOrEqual(0.5);
});

test("keeps the reply start visible below an oversized user message", async ({ page }) => {
  await openFixture(page, 8);
  const tall = Array.from({ length: 40 }, (_, index) => `很长的问题第 ${index + 1} 行`).join("\n");
  await send(page, tall);
  await expect(page.locator(".thread-stage .msg.user").last()).toContainText("很长的问题第 1 行");
  await page.evaluate(() => window.sendAnchor.delta("回复开头"));
  await page.waitForTimeout(100);

  // 7. The message bottom and the reply start stay above the Composer.
  const metrics = await measure(page);
  expect(metrics.userTop).toBeLessThanOrEqual(anchorGap(page) + 2);
  expect(metrics.userBottom).toBeLessThan(metrics.footerTop);
  expect(metrics.replyTop).not.toBeNull();
  expect(metrics.replyTop!).toBeLessThan(metrics.footerTop);
});

test("lifts with a short, clean animation when motion is allowed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFixture(page, 8);
  // Sample the new message's offset on every frame from before the send.
  const samples = page.evaluate(
    () =>
      new Promise<{ t: number; top: number; scrollTop: number; earlier: number }[]>((resolve) => {
        const region = document.querySelector<HTMLElement>(".thread-region")!;
        const out: { t: number; top: number; scrollTop: number; earlier: number }[] = [];
        const start = performance.now();
        const previous = [...document.querySelectorAll<HTMLElement>(".thread-stage .msg")].pop()!;
        const frame = (now: number) => {
          const users = [...document.querySelectorAll<HTMLElement>(".thread-stage .msg.user")];
          const user = users.find((node) => node.textContent?.includes("动画问题"));
          if (user) {
            const regionTop = region.getBoundingClientRect().top;
            out.push({
              t: now,
              top: user.getBoundingClientRect().top - regionTop,
              scrollTop: region.scrollTop,
              earlier: previous.getBoundingClientRect().top - regionTop,
            });
          }
          if (now - start < 1500) requestAnimationFrame(frame);
          else resolve(out);
        };
        requestAnimationFrame(frame);
      }),
  );
  await send(page, "动画问题");
  const frames = await samples;
  const gap = anchorGap(page);

  const first = frames[0]!;
  const moving = frames.findIndex((frame) => Math.abs(frame.top - first.top) >= 1);
  const landed = frames.findIndex((frame) => Math.abs(frame.top - gap) <= 1);
  expect(moving).toBeGreaterThanOrEqual(0);
  expect(landed).toBeGreaterThan(moving);
  const duration = frames[landed]!.t - frames[moving - 1 >= 0 ? moving - 1 : 0]!.t;
  console.log(`[${test.info().project.name}] lift ${Math.round(first.top - gap)}px in ${Math.round(duration)}ms`);
  expect(duration).toBeGreaterThanOrEqual(350);
  expect(duration).toBeLessThanOrEqual(470);

  // Monotonic travel with no overshoot, then it stays put; earlier messages
  // travel with it.
  for (let index = moving; index < frames.length; index += 1) {
    expect(frames[index]!.top).toBeLessThanOrEqual(frames[index - 1]!.top + 0.5);
    expect(frames[index]!.top).toBeGreaterThanOrEqual(gap - 1);
    expect(frames[index]!.earlier).toBeLessThanOrEqual(frames[index - 1]!.earlier + 0.5);
  }
  expect(Math.abs(frames[frames.length - 1]!.top - gap)).toBeLessThanOrEqual(1);
  // The motion is a compositor transform: scrollTop is written once, not per
  // frame, so main-thread load and pixel snapping cannot make it stutter.
  expect(new Set(frames.slice(moving).map((frame) => frame.scrollTop)).size).toBe(1);
});

test("a follow-up send without scrolling only pushes the current turn upward", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFixture(page, 8);
  await send(page, "第一问");
  await expect(page.locator(".thread-stage .msg.user").last()).toContainText("第一问");
  await page.evaluate(() => window.sendAnchor.delta("第一轮回复。"));
  await page.evaluate(() => window.sendAnchor.finish());
  await expect(page.getByTestId("composer").getByRole("button", { name: "发送" })).toBeVisible();
  await page.waitForTimeout(600);
  const before = await measure(page);

  const samples = page.evaluate(
    () =>
      new Promise<{ earlier: number; top: number | null }[]>((resolve) => {
        const region = document.querySelector<HTMLElement>(".thread-region")!;
        const out: { earlier: number; top: number | null }[] = [];
        const start = performance.now();
        const previous = [...document.querySelectorAll<HTMLElement>(".thread-stage .msg.user")].pop()!;
        const frame = (now: number) => {
          const users = [...document.querySelectorAll<HTMLElement>(".thread-stage .msg.user")];
          const user = users.find((node) => node.textContent?.includes("第二问"));
          const regionTop = region.getBoundingClientRect().top;
          out.push({
            earlier: previous.getBoundingClientRect().top - regionTop,
            top: user ? user.getBoundingClientRect().top - regionTop : null,
          });
          if (now - start < 1200) requestAnimationFrame(frame);
          else resolve(out);
        };
        requestAnimationFrame(frame);
      }),
  );
  await send(page, "第二问");
  const frames = await samples;
  console.log(
    `[${test.info().project.name}] follow-up earlier/new top`,
    frames.filter((_, index) => index % 3 === 0).map((f) => `${Math.round(f.earlier)}/${f.top === null ? "-" : Math.round(f.top)}`).join(" "),
  );

  // The view never moves back into earlier content: the previous turn only
  // travels up and off the top.
  for (let index = 1; index < frames.length; index += 1) {
    expect(frames[index]!.earlier).toBeLessThanOrEqual(frames[index - 1]!.earlier + 0.5);
  }
  expect(frames[0]!.earlier).toBeLessThanOrEqual(before.userTop + 0.5);
  const last = frames[frames.length - 1]!;
  expect(Math.abs(last.top! - anchorGap(page))).toBeLessThanOrEqual(2);
});
