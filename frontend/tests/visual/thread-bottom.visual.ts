import { expect, test } from "@playwright/test";

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
    backgroundColor: "rgba(252, 252, 252, 0.8)",
    backdropFilter: "none",
    pointerEvents: "none",
  });
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
    scaleX: 1,
    translateY: 0,
  });
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

  const selectVisibleText = async (locator: import("@playwright/test").Locator) => {
    await locator.evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error("Reply quote fixture text is missing");
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  };
  const quoteAction = page.getByRole("button", { name: "询问Piko" });
  const quoteText = page.getByText(/这段较长的回复引用用于验证第 1 部分/);
  await quoteText.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const timing: { pointerUpAt: number | null; visibleAt: number | null } = {
      pointerUpAt: null,
      visibleAt: null,
    };
    (window as typeof window & { __replyQuoteTiming?: typeof timing }).__replyQuoteTiming = timing;
    document.addEventListener(
      "pointerup",
      () => {
        timing.pointerUpAt = performance.now();
      },
      { once: true },
    );
    const observer = new MutationObserver(() => {
      if (!document.querySelector("[data-reply-quote-action]")) return;
      timing.visibleAt = performance.now();
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const quoteBounds = await quoteText.boundingBox();
  if (!quoteBounds) throw new Error("Reply quote fixture bounds are missing");
  const selectionY = quoteBounds.y + Math.min(10, quoteBounds.height / 2);
  await page.mouse.move(quoteBounds.x + 4, selectionY);
  await page.mouse.down();
  await page.mouse.move(quoteBounds.x + quoteBounds.width - 4, selectionY, { steps: 8 });
  await expect(quoteAction).toBeHidden();
  await page.mouse.up();
  await expect(quoteAction).toBeVisible({ timeout: 1_000 });
  const selectionTiming = await page.evaluate(() => {
    const timing = (
      window as typeof window & {
        __replyQuoteTiming?: { pointerUpAt: number | null; visibleAt: number | null };
      }
    ).__replyQuoteTiming;
    return {
      pointerUpAt: timing?.pointerUpAt ?? null,
      visibleAt: timing?.visibleAt ?? null,
      delay:
        timing?.pointerUpAt != null && timing.visibleAt != null
          ? timing.visibleAt - timing.pointerUpAt
          : null,
    };
  });
  expect(selectionTiming.pointerUpAt).not.toBeNull();
  expect(selectionTiming.visibleAt).not.toBeNull();
  expect(selectionTiming.delay ?? 0).toBeGreaterThanOrEqual(80);
  expect(selectionTiming.delay ?? Infinity).toBeLessThan(1_000);
  await testInfo.attach("reply-quote-selection-timing", {
    body: JSON.stringify(selectionTiming, null, 2),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  await expect(quoteAction).toBeHidden();
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await selectVisibleText(quoteText);
  await expect(quoteAction).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(quoteAction).toBeHidden();
  await selectVisibleText(quoteText);
  await expect(quoteAction).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(quoteAction).toBeHidden();
  await selectVisibleText(quoteText);
  await expect(quoteAction).toBeVisible();
  await thread.evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await expect(quoteAction).toBeHidden();
  await selectVisibleText(quoteText);
  await expect(quoteAction).toBeVisible();
  const selectionGeometry = await page.evaluate(() => {
    const selection = window.getSelection();
    const selectionRect = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
    const actionElement = document.querySelector<HTMLElement>("[data-reply-quote-action]");
    const actionRect = actionElement?.getBoundingClientRect();
    const actionStyle = actionElement ? getComputedStyle(actionElement) : null;
    const actionHitStyle = actionElement ? getComputedStyle(actionElement, "::before") : null;
    return {
      selection: selectionRect && {
        top: selectionRect.top,
        right: selectionRect.right,
        bottom: selectionRect.bottom,
        left: selectionRect.left,
        width: selectionRect.width,
        height: selectionRect.height,
      },
      action: actionRect && {
        top: actionRect.top,
        right: actionRect.right,
        bottom: actionRect.bottom,
        left: actionRect.left,
        width: actionRect.width,
        height: actionRect.height,
      },
      actionStyle: actionStyle && {
        backgroundColor: actionStyle.backgroundColor,
        borderRadius: actionStyle.borderRadius,
        borderTopWidth: actionStyle.borderTopWidth,
        boxShadow: actionStyle.boxShadow,
        color: actionStyle.color,
        fontSize: actionStyle.fontSize,
        fontWeight: actionStyle.fontWeight,
        lineHeight: actionStyle.lineHeight,
        paddingLeft: actionStyle.paddingLeft,
        paddingRight: actionStyle.paddingRight,
        transform: actionStyle.transform,
      },
      actionHitStyle: actionHitStyle && {
        content: actionHitStyle.content,
        height: actionHitStyle.height,
        minWidth: actionHitStyle.minWidth,
      },
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  expect(selectionGeometry.selection).not.toBeNull();
  expect(selectionGeometry.action).not.toBeNull();
  expect(selectionGeometry.action?.left ?? -1).toBeGreaterThanOrEqual(4);
  expect(selectionGeometry.action?.right ?? Infinity).toBeLessThanOrEqual(
    selectionGeometry.viewport.width - 4,
  );
  expect(selectionGeometry.action?.height).toBeCloseTo(36, 1);
  expect(selectionGeometry.actionStyle).toMatchObject({
    backgroundColor: "rgb(255, 255, 255)",
    borderRadius: "12px",
    borderTopWidth: "0px",
    color: "rgb(13, 13, 13)",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "20px",
    paddingLeft: "12px",
    paddingRight: "12px",
    transform: "none",
  });
  expect(selectionGeometry.actionStyle?.boxShadow).toContain(
    "rgba(0, 0, 0, 0.08) 0px 8px 12px 0px",
  );
  expect(selectionGeometry.actionStyle?.boxShadow).toContain(
    "rgba(0, 0, 0, 0.62) 0px 0px 1px 0px",
  );
  expect(selectionGeometry.actionHitStyle).toMatchObject({
    content: '""',
    height: "44px",
    minWidth: "44px",
  });
  if ((selectionGeometry.selection?.top ?? 0) >= 44) {
    expect(selectionGeometry.action?.bottom).toBeCloseTo(
      (selectionGeometry.selection?.top ?? 0) - 4,
      1,
    );
    expect(selectionGeometry.action?.left).toBeCloseTo(
      Math.max(4, (selectionGeometry.selection?.left ?? 0) - 4),
      1,
    );
  }
  await quoteAction.hover();
  await expect(quoteAction).toHaveCSS("background-color", "rgb(249, 249, 249)");
  await testInfo.attach("reply-quote-selection-geometry", {
    body: JSON.stringify(selectionGeometry, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("reply-quote-selection", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.screenshot({ path: testInfo.outputPath("reply-quote-selection.png") });

  await quoteAction.click();
  const composerQuote = composer.getByLabel("回复引用");
  await expect(composerQuote).toContainText("这段较长的回复引用用于验证第 1 部分");
  await expect(page.getByRole("textbox")).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  const composerQuoteGeometry = await composer.evaluate((root) => {
    const region = root.querySelector<HTMLElement>("[data-reply-quote-region]");
    const body = root.querySelector<HTMLElement>("[data-composer-body]");
    const quote = root.querySelector<HTMLElement>('[aria-label="回复引用"]');
    const quoteText = quote?.querySelector<HTMLElement>("blockquote");
    const quoteIcon = quote?.querySelector<SVGElement>('[data-icon="reply-arrow"]');
    const close = quote?.querySelector<HTMLButtonElement>('[aria-label="取消引用"]');
    const closeIcon = close?.querySelector<SVGElement>("svg");
    const rect = (element: Element | null | undefined) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return { height: bounds.height, width: bounds.width };
    };
    return {
      root: rect(root),
      region: region && {
        ...rect(region),
        backgroundColor: getComputedStyle(region).backgroundColor,
      },
      body: body && {
        ...rect(body),
        backgroundColor: getComputedStyle(body).backgroundColor,
      },
      quote: quote && {
        ...rect(quote),
        color: getComputedStyle(quote).color,
        fontSize: getComputedStyle(quote).fontSize,
        gap: getComputedStyle(quote).gap,
        lineHeight: getComputedStyle(quote).lineHeight,
      },
      quoteText: quoteText && {
        ...rect(quoteText),
        webkitLineClamp: getComputedStyle(quoteText).webkitLineClamp,
      },
      quoteIcon: quoteIcon && rect(quoteIcon),
      close: close && rect(close),
      closeIcon: closeIcon && {
        ...rect(closeIcon),
        fill: closeIcon.getAttribute("fill"),
        stroke: closeIcon.getAttribute("stroke"),
        viewBox: closeIcon.getAttribute("viewBox"),
      },
    };
  });
  expect(composerQuoteGeometry.region).toMatchObject({
    backgroundColor: "rgb(249, 249, 249)",
  });
  expect(composerQuoteGeometry.body).toMatchObject({
    backgroundColor: "rgb(255, 255, 255)",
  });
  expect(composerQuoteGeometry.region?.width).toBeCloseTo(
    (composerQuoteGeometry.root?.width ?? Number.NaN) - 2,
    1,
  );
  expect(composerQuoteGeometry.body?.width).toBeCloseTo(
    (composerQuoteGeometry.root?.width ?? Number.NaN) - 2,
    1,
  );
  expect(composerQuoteGeometry.quote).toMatchObject({
    color: "rgb(93, 93, 93)",
    fontSize: "14px",
    gap: "6px",
    lineHeight: "20px",
  });
  expect(composerQuoteGeometry.quote?.height).toBeCloseTo(84, 1);
  expect(composerQuoteGeometry.quoteText?.height).toBeCloseTo(76, 1);
  expect(composerQuoteGeometry.quoteText?.webkitLineClamp).toBe("3");
  expect(composerQuoteGeometry.quoteIcon).toEqual({ height: 20, width: 20 });
  expect(composerQuoteGeometry.close).toEqual({ height: 36, width: 36 });
  expect(composerQuoteGeometry.closeIcon).toEqual({
    fill: "currentColor",
    height: 20,
    stroke: null,
    viewBox: "0 0 20 20",
    width: 20,
  });
  await testInfo.attach("reply-quote-composer", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.screenshot({ path: testInfo.outputPath("reply-quote-composer.png") });

  await page.getByRole("textbox").fill("这句话为什么成立？");
  await page.getByRole("button", { name: "发送" }).click();
  const sentTurn = page.locator(".msg.user").last();
  const sentQuote = sentTurn.locator("button:has(blockquote)");
  await expect(sentQuote).toContainText(
    "这段较长的回复引用用于验证第 1 部分",
  );
  await expect(sentTurn).toContainText("这句话为什么成立？");
  const sentGeometry = await sentTurn.evaluate((turn) => {
    const quote = turn.querySelector<HTMLElement>("button:has(blockquote)");
    const quoteText = quote?.querySelector<HTMLElement>("blockquote");
    const quoteIcon = quote?.querySelector<SVGElement>('[data-icon="reply-arrow"]');
    const bubble = turn.querySelector<HTMLElement>(".bg-user-message");
    const turnRect = turn.getBoundingClientRect();
    const quoteRect = quote?.getBoundingClientRect();
    const quoteTextRect = quoteText?.getBoundingClientRect();
    const quoteIconRect = quoteIcon?.getBoundingClientRect();
    const bubbleRect = bubble?.getBoundingClientRect();
    const quoteStyle = quote ? getComputedStyle(quote) : null;
    const quoteTextStyle = quoteText ? getComputedStyle(quoteText) : null;
    return {
      turn: { left: turnRect.left, right: turnRect.right, width: turnRect.width },
      quote: quoteRect && {
        top: quoteRect.top,
        right: quoteRect.right,
        bottom: quoteRect.bottom,
        left: quoteRect.left,
        width: quoteRect.width,
        height: quoteRect.height,
      },
      quoteStyle: quoteStyle && {
        color: quoteStyle.color,
        fontSize: quoteStyle.fontSize,
        fontWeight: quoteStyle.fontWeight,
        gap: quoteStyle.gap,
        lineHeight: quoteStyle.lineHeight,
        marginBottom: quoteStyle.marginBottom,
        marginLeft: quoteStyle.marginLeft,
        marginRight: quoteStyle.marginRight,
        marginTop: quoteStyle.marginTop,
      },
      quoteText: quoteTextRect && quoteTextStyle && {
        height: quoteTextRect.height,
        overflow: quoteTextStyle.overflow,
        overflowWrap: quoteTextStyle.overflowWrap,
        textAlign: quoteTextStyle.textAlign,
        webkitBoxOrient: quoteTextStyle.webkitBoxOrient,
        webkitLineClamp: quoteTextStyle.webkitLineClamp,
        whiteSpace: quoteTextStyle.whiteSpace,
      },
      quoteIcon: quoteIconRect && {
        fill: quoteIcon?.getAttribute("fill"),
        height: quoteIconRect.height,
        stroke: quoteIcon?.getAttribute("stroke"),
        viewBox: quoteIcon?.getAttribute("viewBox"),
        width: quoteIconRect.width,
      },
      bubble: bubbleRect && {
        top: bubbleRect.top,
        right: bubbleRect.right,
        bottom: bubbleRect.bottom,
        left: bubbleRect.left,
        width: bubbleRect.width,
        height: bubbleRect.height,
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
    };
  });
  expect(sentGeometry.quote?.bottom ?? Infinity).toBeLessThanOrEqual(
    sentGeometry.bubble?.top ?? -Infinity,
  );
  expect(sentGeometry.quote?.right).toBeCloseTo(sentGeometry.turn.right - 8, 1);
  expect(sentGeometry.quote?.width).toBeCloseTo(sentGeometry.turn.width - 16, 1);
  expect(sentGeometry.quote?.height).toBeCloseTo(60, 1);
  expect(sentGeometry.quoteText?.height).toBeCloseTo(60, 1);
  expect(sentGeometry.quoteStyle).toMatchObject({
    color: "rgb(143, 143, 143)",
    fontSize: "14px",
    fontWeight: "400",
    gap: "6px",
    lineHeight: "20px",
    marginBottom: "4px",
    marginLeft: "8px",
    marginRight: "8px",
    marginTop: "4px",
  });
  expect(sentGeometry.quoteText).toMatchObject({
    overflow: "hidden",
    overflowWrap: "break-word",
    textAlign: "center",
    webkitBoxOrient: "vertical",
    webkitLineClamp: "3",
    whiteSpace: "normal",
  });
  expect(sentGeometry.quoteIcon).toEqual({
    fill: "currentColor",
    height: 20,
    stroke: null,
    viewBox: "0 0 20 20",
    width: 20,
  });
  await sentQuote.hover();
  await expect(sentQuote).toHaveCSS("color", "rgb(13, 13, 13)");
  expect(sentGeometry.document.scrollWidth).toBeLessThanOrEqual(
    sentGeometry.document.clientWidth,
  );
  await testInfo.attach("reply-quote-sent-geometry", {
    body: JSON.stringify(sentGeometry, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("reply-quote-sent", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.screenshot({ path: testInfo.outputPath("reply-quote-sent.png") });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  const routeBeforeReveal = page.url();
  const sourceTarget = quoteText.locator(
    'xpath=ancestor-or-self::*[@data-reply-quote-start][1]',
  );
  await sentQuote.click();
  await expect(sourceTarget).toHaveCSS(
    "background-color",
    "rgba(255, 235, 140, 0.6)",
    { timeout: 2_000 },
  );
  await expect(sentQuote).toBeFocused();
  expect(page.url()).toBe(routeBeforeReveal);
  await testInfo.attach("reply-quote-source-highlight", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
