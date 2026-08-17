import { expect, test } from "@playwright/test";

function expectComputedSrgb(
  actual: string | undefined,
  expected: readonly [red: number, green: number, blue: number, alpha: number],
) {
  expect(actual).toBeDefined();
  const channels = actual?.match(/\d*\.?\d+/g)?.map(Number);
  expect(channels).toHaveLength(4);
  const normalized = actual?.startsWith("color(srgb")
    ? channels
    : channels?.map((channel, index) => (index < 3 ? channel / 255 : channel));

  expected.forEach((channel, index) => {
    expect(normalized?.[index]).toBeCloseTo(channel, 5);
  });
}

test("extends the thread behind the sticky Composer and mirrors the return control", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.goto("/tests/visual/thread-bottom.html");

  const thread = page.locator(".thread-region");
  const composer = page.getByTestId("composer");
  const markdown = page.locator(".assistant-markdown").last();
  const button = page.locator(".scroll-to-bottom-button");

  await expect(markdown).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(button).toHaveAttribute("data-visible", "false");

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const footerElement = document.querySelector(".thread-bottom-container");
    const footerStyle = footerElement ? getComputedStyle(footerElement) : null;
    const fadeStyle = footerElement ? getComputedStyle(footerElement, "::after") : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      thread: rect(".thread-region"),
      footer: rect(".thread-bottom-container"),
      composer: rect('[data-testid="composer"]'),
      markdown: rect(".assistant-markdown"),
      footerPosition: footerStyle?.position,
      fade: fadeStyle
        ? {
            content: fadeStyle.content,
            backgroundColor: fadeStyle.backgroundColor,
            backdropFilter: fadeStyle.backdropFilter,
            maskImage: fadeStyle.maskImage,
            pointerEvents: fadeStyle.pointerEvents,
          }
        : null,
    };
  });

  await testInfo.attach("thread-bottom-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });

  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth);
  expect(geometry.thread?.height).toBeCloseTo(geometry.viewport.height, 1);
  expect(geometry.footerPosition).toBe("sticky");
  expect(geometry.footer?.bottom).toBeCloseTo(geometry.viewport.height, 1);
  expect(geometry.fade).toMatchObject({
    content: '""',
    backdropFilter: "none",
    pointerEvents: "none",
  });
  expectComputedSrgb(geometry.fade?.backgroundColor, [252 / 255, 252 / 255, 252 / 255, 0.8]);
  expect(geometry.fade?.maskImage).toContain("32px");
  expect(geometry.composer?.x).toBeCloseTo(geometry.markdown?.x ?? Number.NaN, 1);
  expect(geometry.composer?.right).toBeCloseTo(geometry.markdown?.right ?? Number.NaN, 1);

  if (geometry.viewport.width > 760) {
    expect(geometry.composer?.width).toBeCloseTo(768, 1);
    expect(geometry.markdown?.width).toBeCloseTo(768, 1);
  } else {
    expect(geometry.footer?.width).toBeCloseTo(geometry.viewport.width, 1);
    expect(geometry.composer?.x).toBeCloseTo(16, 1);
    expect(geometry.composer?.right).toBeCloseTo(geometry.viewport.width - 16, 1);
  }

  const parkFromBottom = async (distance: number) => {
    await thread.evaluate((element, targetDistance) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - targetDistance;
      element.dispatchEvent(new Event("scroll"));
    }, distance);
  };

  await parkFromBottom(130);
  await expect(button).toHaveAttribute("data-visible", "false");

  await parkFromBottom(137);
  await expect(button).toHaveAttribute("data-visible", "true");
  await expect(button).toHaveAttribute("aria-label", "滚动到底部");
  await expect(button).toHaveCSS("opacity", "1", { timeout: 1_000 });

  const visibleControl = await page.evaluate(() => {
    const control = document.querySelector(".scroll-to-bottom-button");
    const composerSurface = document.querySelector('[data-testid="composer"]');
    const body = document.querySelector(".assistant-markdown");
    if (!control || !composerSurface || !body) return null;
    const controlRect = control.getBoundingClientRect();
    const composerRect = composerSurface.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const style = getComputedStyle(control);
    const matrix = new DOMMatrix(style.transform);
    return {
      width: controlRect.width,
      height: controlRect.height,
      gapToComposer: composerRect.top - controlRect.bottom,
      bodyBottom: bodyRect.bottom,
      composerTop: composerRect.top,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      backdropFilter: style.backdropFilter,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      scaleX: matrix.a,
      translateY: matrix.f,
      transitionDuration: style.transitionDuration,
      transitionDelay: style.transitionDelay,
    };
  });

  expect(visibleControl).not.toBeNull();
  expect(visibleControl?.width).toBeCloseTo(34, 1);
  expect(visibleControl?.height).toBeCloseTo(34, 1);
  expect(visibleControl?.gapToComposer).toBeCloseTo(24, 1);
  expect(visibleControl?.bodyBottom ?? 0).toBeGreaterThan(visibleControl?.composerTop ?? 0);
  expect(visibleControl).toMatchObject({
    opacity: "1",
    pointerEvents: "auto",
    backdropFilter: "blur(2px)",
    backgroundColor: "rgba(255, 255, 255, 0.65)",
    borderColor: "rgba(0, 0, 0, 0.15)",
  });
  expect(visibleControl?.scaleX).toBeCloseTo(1, 5);
  expect(visibleControl?.translateY).toBeCloseTo(0, 5);
  expect(visibleControl?.transitionDuration).toContain("0.3s");
  expect(visibleControl?.transitionDelay).toContain("0.3s");

  await button.click();
  await expect(button).toHaveAttribute("data-visible", "false");
  await expect
    .poll(() =>
      thread.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(1);
  await expect(button).toHaveCSS("opacity", "0");

  const hiddenControl = await button.evaluate((control) => {
    const style = getComputedStyle(control);
    const matrix = new DOMMatrix(style.transform);
    return {
      pointerEvents: style.pointerEvents,
      scaleX: matrix.a,
      translateY: matrix.f,
      transitionDuration: style.transitionDuration,
      transitionDelay: style.transitionDelay,
    };
  });
  expect(hiddenControl).toMatchObject({
    pointerEvents: "none",
    scaleX: 0.5,
    translateY: 8,
  });
  expect(hiddenControl.transitionDuration).toContain("0.1s");
  expect(hiddenControl.transitionDelay).toContain("0s");

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await button.evaluate((control) => getComputedStyle(control).transitionDuration)).toBe(
    "0s",
  );
});
