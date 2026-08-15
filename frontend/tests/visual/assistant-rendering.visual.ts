import { expect, test } from "@playwright/test";

// The `.visual.ts` suffix keeps this browser test outside Vitest discovery.

test("loads every assistant-rendering surface and writes diagnostic artifacts", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/visual/assistant-rendering.html");

  const fixture = page.getByTestId("assistant-rendering-fixture");
  const finalMessage = page.getByTestId("final-message");
  await expect(fixture).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 1, name: /一级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 2, name: /二级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 3, name: /三级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 4, name: /四级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 5, name: /五级标题/ })).toBeVisible();
  await expect(finalMessage.getByRole("heading", { level: 6, name: /六级标题/ })).toBeVisible();
  await expect(finalMessage.locator("blockquote").first()).toBeVisible();
  await expect(finalMessage.locator("del")).toBeVisible();
  const taskCheckboxes = finalMessage.locator('input[type="checkbox"]');
  await expect(taskCheckboxes).toHaveCount(3);
  await expect(taskCheckboxes.first()).toBeDisabled();
  await expect(taskCheckboxes.first()).toBeChecked();
  await expect(finalMessage.locator("table")).toHaveCount(2);
  await expect(finalMessage.locator("table").first()).toBeVisible();
  await expect(finalMessage.locator(".katex")).not.toHaveCount(0);
  const citations = finalMessage.getByRole("button", { name: "查看 1 个引用来源" });
  await expect(citations).toHaveCount(2);
  await expect(citations.first()).toBeVisible();
  await expect(finalMessage.locator("pre")).not.toHaveCount(0);
  const externalLink = finalMessage.getByRole("link", { name: "OpenAI" });
  await expect(externalLink).toBeVisible();
  await expect(finalMessage.getByRole("link", { name: "站内帮助" })).toBeVisible();
  await expect(externalLink).toHaveAttribute(
    "target",
    "_new",
  );
  await expect(externalLink).toHaveAttribute(
    "rel",
    "noopener",
  );
  await expect(externalLink.locator(".external-link-icon svg")).toBeVisible();
  await expect(finalMessage.getByRole("link", { name: "站内帮助" })).not.toHaveAttribute(
    "target",
  );

  const entryParity = page.getByTestId("entry-parity");
  const entryMarkdown = entryParity.locator("[data-render-entry] .assistant-markdown");
  await expect(entryMarkdown).toHaveCount(3);
  await expect(
    entryParity.locator('[data-render-entry="share"] .assistant-markdown'),
  ).toBeVisible();

  const entrySignatures = await entryMarkdown.evaluateAll((elements) =>
    elements.map((root) => ({
      semanticNodes: Array.from(
        root.querySelectorAll(
          "h1,h2,h3,h4,h5,h6,p,blockquote,pre,table,thead,tbody,tr,th,td",
        ),
      ).map((element) => ({
        tag: element.tagName,
        text: element.textContent,
      })),
      codeLanguage: root.querySelector("[data-code-block]")?.getAttribute("data-language"),
      tableRows: root.querySelectorAll("table tr").length,
    })),
  );
  expect(entrySignatures[1]).toEqual(entrySignatures[0]);
  expect(entrySignatures[2]).toEqual(entrySignatures[0]);

  const entryGeometry = await entryMarkdown.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        color: style.color,
        overflowWrap: style.overflowWrap,
      };
    }),
  );
  await testInfo.attach("assistant-rendering-entry-geometry", {
    body: JSON.stringify(entryGeometry, null, 2),
    contentType: "application/json",
  });
  for (const geometry of entryGeometry.slice(1)) {
    expect(
      Math.abs(geometry.width - entryGeometry[0].width),
      `Entry widths: ${entryGeometry.map((entry) => entry.width).join(", ")}`,
    ).toBeLessThanOrEqual(1);
    expect(geometry).toMatchObject({
      fontFamily: entryGeometry[0].fontFamily,
      fontSize: entryGeometry[0].fontSize,
      lineHeight: entryGeometry[0].lineHeight,
      color: entryGeometry[0].color,
      overflowWrap: entryGeometry[0].overflowWrap,
    });
  }

  const failedPartial = page.getByTestId("run-state-failed");
  const cancelledPartial = page.getByTestId("run-state-cancelled");
  const recoveredPartial = page.getByTestId("run-state-recovered");
  await expect(failedPartial.locator(".assistant-markdown")).toContainText("可恢复 partial");
  await expect(failedPartial.getByRole("alert")).toContainText("生成失败");
  await expect(cancelledPartial.locator(".assistant-markdown")).toContainText("可恢复 partial");
  await expect(cancelledPartial.getByRole("alert")).toHaveCount(0);
  await expect(recoveredPartial.locator(".assistant-markdown")).toContainText("可恢复 partial");
  await expect(recoveredPartial.getByRole("alert")).toHaveCount(0);

  await page.context().route("https://openai.com/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>External fixture</title>",
    });
  });
  const fixtureUrl = page.url();
  const popupPromise = page.waitForEvent("popup");
  await externalLink.click();
  const externalPage = await popupPromise;
  await externalPage.waitForLoadState();
  expect(page.url()).toBe(fixtureUrl);
  expect(externalPage.url()).toBe("https://openai.com/");
  await externalPage.close();

  const prefixes = page.locator("[data-streaming-prefix]");
  await expect(prefixes).toHaveCount(14);
  for (const prefix of await prefixes.all()) {
    await expect(prefix.locator(".md")).toBeVisible();
  }

  const collapsedThinking = page.locator(
    '[data-thinking-state="collapsed"] [role="button"]',
  );
  await expect(collapsedThinking).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.locator('[data-thinking-state="expanded"] [role="button"]'),
  ).toHaveAttribute("aria-expanded", "true");
  await collapsedThinking.click();
  await expect(collapsedThinking).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.locator('[data-thinking-state="collapsed"]').getByText(/reasoning fixture/),
  ).toBeVisible();
  await collapsedThinking.click();
  await expect(collapsedThinking).toHaveAttribute("aria-expanded", "false");

  const successfulCopy = page.locator('[data-copy-scenario="success"]');
  await successfulCopy.getByRole("button", { name: "复制代码" }).click();
  await expect(successfulCopy.locator(".fixture-status")).toHaveAttribute("data-state", "success");
  await expect(successfulCopy.getByRole("button", { name: "已复制" })).toBeVisible();

  const failedCopy = page.locator('[data-copy-scenario="failure"]');
  await failedCopy.getByRole("button", { name: "复制代码" }).click();
  await expect(failedCopy.locator(".fixture-status")).toHaveAttribute("data-state", "failure");
  await expect(failedCopy.getByRole("button", { name: "复制代码" })).toBeVisible();
  await expect(failedCopy.getByRole("status").filter({ hasText: "Copy failed" })).toBeAttached();

  const codeBlocks = finalMessage.locator("[data-code-block]");
  await expect(codeBlocks).toHaveCount(7);
  const plainCode = codeBlocks.filter({ has: page.locator(".code-block-plain-actions") });
  await expect(plainCode).toHaveCount(1);
  await expect(plainCode.locator(".code-block-header")).toHaveCount(0);
  await expect(plainCode.getByRole("button", { name: "复制代码" })).toBeVisible();
  const pythonCode = codeBlocks.filter({
    has: page.locator(".code-block-language", { hasText: "Python" }),
  });
  const pythonRun = pythonCode.getByRole("button", { name: "运行代码" });
  await expect(pythonRun).toBeVisible();
  await expect(pythonRun).toHaveAttribute("aria-disabled", "true");
  const pythonToolbarGeometry = await pythonCode.evaluate((element) => {
    const actions = element.querySelector(".code-block-actions")!.getBoundingClientRect();
    const copy = element.querySelector(".code-block-copy")!.getBoundingClientRect();
    const run = element.querySelector(".code-block-run")!.getBoundingClientRect();
    return {
      actions: { width: actions.width, height: actions.height },
      copy: { width: copy.width, height: copy.height },
      run: { width: run.width, height: run.height },
    };
  });
  expect(pythonToolbarGeometry.actions.width).toBe(124);
  expect(pythonToolbarGeometry.actions.height).toBe(36);
  expect(pythonToolbarGeometry.copy).toEqual({ width: 36, height: 36 });
  expect(pythonToolbarGeometry.run.width).toBe(78);
  expect(pythonToolbarGeometry.run.height).toBe(36);

  const htmlCode = codeBlocks.filter({
    has: page.locator(".code-block-language", { hasText: "HTML" }),
  });
  const htmlViewToggle = htmlCode.getByRole("group", { name: "代码块视图切换" });
  const htmlCodeButton = htmlViewToggle.getByRole("button", { name: "代码" });
  const htmlPreviewButton = htmlViewToggle.getByRole("button", { name: "预览" });
  await expect(htmlCode).toHaveAttribute("data-code-view", "code");
  await expect(htmlCodeButton).toHaveAttribute("aria-pressed", "true");
  await expect(htmlPreviewButton).toHaveAttribute("aria-pressed", "false");
  await htmlPreviewButton.click();
  await expect(htmlCode).toHaveAttribute("data-code-view", "preview");
  await expect(htmlPreviewButton).toHaveAttribute("aria-pressed", "true");
  const htmlIframe = htmlCode.locator("iframe");
  await expect(htmlIframe).toHaveAttribute("sandbox", "");
  await expect(htmlIframe).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(htmlCode.getByRole("button", { name: "全屏" })).toBeVisible();
  const htmlPreviewGeometry = await htmlCode.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const rootStyle = getComputedStyle(element);
    const header = element.querySelector(".code-block-header")!.getBoundingClientRect();
    const actions = element.querySelector(".code-block-actions")!.getBoundingClientRect();
    const toggle = element.querySelector(".code-block-view-toggle")!.getBoundingClientRect();
    const previewElement = element.querySelector<HTMLElement>(".code-block-preview")!;
    const preview = previewElement.getBoundingClientRect();
    const previewStyle = getComputedStyle(previewElement);
    const iframe = element.querySelector("iframe")!.getBoundingClientRect();
    return {
      root: { width: root.width, height: root.height },
      rootBorder: Number.parseFloat(rootStyle.borderTopWidth),
      header: { width: header.width, height: header.height },
      actions: { width: actions.width, height: actions.height },
      toggle: { width: toggle.width, height: toggle.height },
      preview: { width: preview.width, height: preview.height },
      previewBorder: Number.parseFloat(previewStyle.borderTopWidth),
      iframe: { width: iframe.width, height: iframe.height },
    };
  });
  expect(htmlPreviewGeometry.header.height).toBe(48);
  expect(htmlPreviewGeometry.actions).toEqual({ width: 112, height: 36 });
  expect(htmlPreviewGeometry.toggle).toEqual({ width: 74, height: 36 });
  expect(htmlPreviewGeometry.preview.width / htmlPreviewGeometry.preview.height).toBeCloseTo(
    16 / 9,
    3,
  );
  expect(htmlPreviewGeometry.root.height).toBeCloseTo(
    htmlPreviewGeometry.header.height +
      htmlPreviewGeometry.preview.height +
      htmlPreviewGeometry.rootBorder * 2,
    2,
  );
  expect(htmlPreviewGeometry.preview.width - htmlPreviewGeometry.iframe.width).toBeCloseTo(
    htmlPreviewGeometry.previewBorder * 2,
    2,
  );
  await htmlCodeButton.click();
  await expect(htmlCode).toHaveAttribute("data-code-view", "code");
  await expect(htmlCode.locator("iframe")).toHaveCount(0);

  const typeScriptCode = codeBlocks.filter({
    has: page.locator(".code-block-language", { hasText: "TypeScript" }),
  });
  await expect(typeScriptCode.locator(".token.keyword").filter({ hasText: "type" })).toHaveText(
    "type",
  );
  const unknownCode = codeBlocks.filter({
    has: page.locator(".code-block-language", { hasText: "not-a-language" }),
  });
  await expect(unknownCode.locator(".token.keyword")).toHaveCount(0);

  const unfinishedFence = page.locator('[data-streaming-prefix="fence"]');
  await expect(unfinishedFence.locator("[data-code-block]")).toBeVisible();
  await expect(unfinishedFence.locator(".code-block-language")).toHaveText("Bash");
  await expect(unfinishedFence.locator("[data-code-viewport]")).toContainText("echo $$");

  const longCodeViewport = unknownCode.locator("[data-code-viewport]");
  const longCodeOverflow = await longCodeViewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(longCodeOverflow.scrollWidth).toBeGreaterThan(longCodeOverflow.clientWidth);

  const copyButtonX = (await unknownCode.getByRole("button", { name: "复制代码" }).boundingBox())?.x;
  await longCodeViewport.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect((await unknownCode.getByRole("button", { name: "复制代码" }).boundingBox())?.x).toBe(
    copyButtonX,
  );
  await longCodeViewport.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await unknownCode.getByRole("button", { name: "复制代码" }).focus();
  await page.keyboard.press("Tab");
  await expect(longCodeViewport).toBeFocused();
  expect(
    await longCodeViewport.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");

  const selectedSource = await typeScriptCode.locator("pre").evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const text = selection?.toString() ?? "";
    selection?.removeAllRanges();
    return text;
  });
  expect(selectedSource).toContain('role: "assistant"');

  const tableBlocks = finalMessage.locator("[data-table-block]");
  await expect(tableBlocks).toHaveCount(2);
  const tableBlock = tableBlocks.first();
  const failureTableBlock = tableBlocks.last();
  const tableViewport = tableBlock;
  const failureTableViewport = failureTableBlock;
  await expect(tableViewport).toHaveRole("region");
  await expect(tableViewport).toHaveAccessibleName("表格（可横向滚动）");
  await expect(tableViewport).toHaveAttribute("tabindex", "0");
  const tableOverflow = await tableViewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(tableOverflow.overflowX).toBe("auto");
  expect(tableOverflow.scrollWidth).toBeGreaterThan(tableOverflow.clientWidth);

  const tableCopyButton = tableBlock.getByRole("button", { name: "复制表格" });
  const tableCopyButtonX = (await tableCopyButton.boundingBox())?.x;
  await tableViewport.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const tableScrollLeft = await tableViewport.evaluate((element) => element.scrollLeft);
  expect((await tableCopyButton.boundingBox())?.x).toBeCloseTo(
    (tableCopyButtonX ?? 0) - tableScrollLeft,
    1,
  );
  expect(await failureTableViewport.evaluate((element) => element.scrollLeft)).toBe(0);
  await tableViewport.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await tableViewport.focus();
  await expect(tableViewport).toBeFocused();
  expect(
    await tableViewport.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Tab");
  await expect(tableCopyButton).toBeFocused();
  await tableCopyButton.hover();
  expect(
    await tableCopyButton.evaluate((element) => getComputedStyle(element).cursor),
  ).toBe("pointer");
  await tableCopyButton.click();
  await expect(tableBlock.getByRole("button", { name: "已复制表格" })).toBeVisible();
  await expect(
    failureTableBlock.getByRole("button", { name: "复制表格" }),
  ).toBeVisible();
  await failureTableBlock.hover();
  await failureTableBlock.getByRole("button", { name: "复制表格" }).click();
  await expect(failureTableBlock.getByRole("button", { name: "复制表格" })).toBeVisible();
  await expect(
    failureTableBlock.getByRole("status").filter({ hasText: "Copy failed" }),
  ).toBeAttached();

  const geometry = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        width: rect.width,
        height: rect.height,
        minWidth: style.minWidth,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderLeftWidth: style.borderLeftWidth,
        borderTopWidth: style.borderTopWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderRadius: style.borderRadius,
        borderCollapse: style.borderCollapse,
        borderSpacing: style.borderSpacing,
        marginTop: style.marginTop,
        marginRight: style.marginRight,
        marginBottom: style.marginBottom,
        marginLeft: style.marginLeft,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        overflowX: style.overflowX,
        overflowWrap: style.overflowWrap,
        position: style.position,
        verticalAlign: style.verticalAlign,
        cursor: style.cursor,
        whiteSpace: style.whiteSpace,
        wordBreak: style.wordBreak,
      };
    };

    const rootStyle = getComputedStyle(document.documentElement);

    return {
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        prefersLight: window.matchMedia("(prefers-color-scheme: light)").matches,
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      tokens: {
        readingWidth: rootStyle.getPropertyValue("--reading-width").trim(),
        assistantContentWidth: rootStyle
          .getPropertyValue("--assistant-content-width")
          .trim(),
      },
      thread: rectOf('[data-testid="final-message"] .thread-inner'),
      assistantContent: rectOf('[data-testid="final-message"] .assistant-content'),
      markdown: rectOf('[data-testid="final-message"] .assistant-markdown'),
      h1: rectOf('[data-testid="final-message"] .assistant-markdown h1'),
      h2: rectOf('[data-testid="final-message"] .assistant-markdown h2'),
      h3: rectOf('[data-testid="final-message"] .assistant-markdown h3'),
      h4: rectOf('[data-testid="final-message"] .assistant-markdown h4'),
      h5: rectOf('[data-testid="final-message"] .assistant-markdown h5'),
      h6: rectOf('[data-testid="final-message"] .assistant-markdown h6'),
      paragraph: rectOf('[data-testid="final-message"] .assistant-markdown > p'),
      inlineCode: rectOf('[data-testid="final-message"] .assistant-markdown p code'),
      blockquote: rectOf('[data-testid="final-message"] .assistant-markdown blockquote'),
      list: rectOf(
        '[data-testid="final-message"] .assistant-markdown ul:not(.contains-task-list)',
      ),
      nestedList: rectOf(
        '[data-testid="final-message"] .assistant-markdown li > ul',
      ),
      taskCheckbox: rectOf(
        '[data-testid="final-message"] .assistant-markdown input[type="checkbox"]',
      ),
      externalLink: rectOf(
        '[data-testid="final-message"] .assistant-markdown a[href="https://openai.com/"]',
      ),
      rule: rectOf('[data-testid="final-message"] .assistant-markdown hr'),
      codeSurface: rectOf('[data-testid="final-message"] [data-code-block]'),
      codeHeader: rectOf('[data-testid="final-message"] .code-block-header'),
      codeCopyButton: rectOf(
        '[data-testid="final-message"] .code-block-header .code-block-copy',
      ),
      codeViewport: rectOf('[data-testid="final-message"] [data-code-viewport]'),
      code: rectOf('[data-testid="final-message"] [data-code-block] pre'),
      codeKeyword: rectOf(
        '[data-testid="final-message"] [data-language="typescript"] .token.keyword',
      ),
      tableSurface: rectOf('[data-testid="final-message"] [data-table-block]'),
      tableHeader: rectOf('[data-testid="final-message"] .table-block-header'),
      tableCopyButton: rectOf(
        '[data-testid="final-message"] .table-block-header button',
      ),
      tableViewport: rectOf('[data-testid="final-message"] [data-table-viewport]'),
      table: rectOf('[data-testid="final-message"] [data-table-block] table'),
      tableHeadCell: rectOf('[data-testid="final-message"] [data-table-block] th'),
      tableLastHeadCell: rectOf(
        '[data-testid="final-message"] [data-table-block] th:last-child',
      ),
      tableCell: rectOf('[data-testid="final-message"] [data-table-block] td'),
      tableLastCell: rectOf(
        '[data-testid="final-message"] [data-table-block] td:last-child',
      ),
    };
  });

  const expectPx = (value: number | string | undefined, expected: number) => {
    const actual = typeof value === "number" ? value : Number.parseFloat(value ?? "NaN");
    expect(actual).toBeCloseTo(expected, 1);
  };

  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.document.clientWidth);
  expect(geometry.tokens.readingWidth).toBe("820px");
  expect(geometry.tokens.assistantContentWidth).toBe("768px");
  expect(geometry.markdown?.width ?? 0).toBeGreaterThan(0);
  expect(geometry.markdown?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    geometry.viewport.width,
  );
  expectPx(geometry.markdown?.fontSize, 16);
  expectPx(geometry.markdown?.lineHeight, 26);
  expect(geometry.markdown?.fontWeight).toBe("400");
  expect(geometry.markdown?.color).toBe("rgb(13, 13, 13)");
  expect(geometry.markdown?.overflowWrap).toBe("break-word");
  expect(geometry.markdown?.wordBreak).toBe("normal");

  expectPx(geometry.h1?.fontSize, 24);
  expectPx(geometry.h1?.lineHeight, 32);
  expect(geometry.h1?.fontWeight).toBe("600");
  expectPx(geometry.h1?.marginBottom, 8);
  expectPx(geometry.h2?.fontSize, 20);
  expectPx(geometry.h2?.lineHeight, 28);
  expect(geometry.h2?.fontWeight).toBe("600");
  expectPx(geometry.h2?.marginTop, 16);
  expectPx(geometry.h2?.marginBottom, 4);
  expectPx(geometry.h3?.fontSize, 18);
  expectPx(geometry.h3?.lineHeight, 28);
  expect(geometry.h3?.fontWeight).toBe("600");
  expectPx(geometry.h3?.marginTop, 16);
  expectPx(geometry.h3?.marginBottom, 4);
  expectPx(geometry.h4?.fontSize, 16);
  expectPx(geometry.h4?.lineHeight, 24);
  expect(geometry.h4?.fontWeight).toBe("600");
  expectPx(geometry.h4?.marginTop, 16);
  expectPx(geometry.h5?.fontSize, 16);
  expectPx(geometry.h5?.lineHeight, 26);
  expect(geometry.h5?.fontWeight).toBe("600");
  expectPx(geometry.h5?.marginTop, 0);
  expectPx(geometry.h6?.fontSize, 16);
  expectPx(geometry.h6?.lineHeight, 26);
  expect(geometry.h6?.fontWeight).toBe("400");
  expectPx(geometry.h6?.marginTop, 0);

  expectPx(geometry.paragraph?.fontSize, 16);
  expectPx(geometry.paragraph?.lineHeight, 26);
  expectPx(geometry.paragraph?.marginBottom, 4);
  expectPx(geometry.inlineCode?.fontSize, 14);
  expectPx(geometry.inlineCode?.lineHeight, 26);
  expect(geometry.inlineCode?.fontWeight).toBe("500");
  expect(geometry.inlineCode?.backgroundColor).toBe("rgb(236, 236, 236)");
  expectPx(geometry.inlineCode?.borderTopWidth, 0);
  expectPx(geometry.inlineCode?.borderRadius, 4);
  expectPx(geometry.inlineCode?.paddingTop, 2.4);
  expectPx(geometry.inlineCode?.paddingRight, 4.8);

  expectPx(geometry.blockquote?.lineHeight, 24);
  expectPx(geometry.blockquote?.marginLeft, 0);
  expectPx(geometry.blockquote?.marginRight, 0);
  expectPx(geometry.blockquote?.paddingTop, 8);
  expectPx(geometry.blockquote?.paddingRight, 0);
  expectPx(geometry.blockquote?.paddingBottom, 8);
  expectPx(geometry.blockquote?.paddingLeft, 24);
  expectPx(geometry.list?.paddingLeft, 26);
  expectPx(geometry.nestedList?.paddingLeft, 26);
  expectPx(geometry.taskCheckbox?.width, 16);
  expectPx(geometry.taskCheckbox?.height, 16);
  expectPx(geometry.taskCheckbox?.marginRight, 0);
  expectPx(geometry.taskCheckbox?.marginBottom, 0);
  expectPx(geometry.taskCheckbox?.marginLeft, 0);
  expect(geometry.taskCheckbox?.verticalAlign).toBe("middle");
  expect(geometry.taskCheckbox?.cursor).toBe("default");
  expect(geometry.externalLink?.overflowWrap).toBe("break-word");
  expect(geometry.externalLink?.wordBreak).toBe("normal");
  expectPx(geometry.rule?.marginTop, 28);
  expectPx(geometry.rule?.marginBottom, 28);

  expect(geometry.codeSurface?.backgroundColor).toBe("rgb(243, 243, 243)");
  expectPx(geometry.codeSurface?.borderRadius, 24);
  expectPx(geometry.codeSurface?.borderTopWidth, 1);
  expect(geometry.codeHeader?.position).toBe("sticky");
  expectPx(geometry.codeHeader?.height, 48);
  expectPx(geometry.codeCopyButton?.width, 36);
  expectPx(geometry.codeCopyButton?.height, 36);
  expect(geometry.codeViewport?.overflowX).toBe("auto");
  expectPx(geometry.code?.fontSize, 14);
  expectPx(geometry.code?.lineHeight, 20);
  expectPx(geometry.code?.paddingTop, 0);
  expectPx(geometry.code?.paddingBottom, 12);
  expectPx(geometry.code?.paddingRight, geometry.viewport.width > 760 ? 16 : 12);
  expectPx(geometry.code?.paddingLeft, geometry.viewport.width > 760 ? 20 : 16);
  expect(geometry.code?.whiteSpace).toBe("pre");
  expect(geometry.code?.wordBreak).toBe("normal");
  expect(geometry.codeKeyword?.color).not.toBe(geometry.code?.color);

  expect(geometry.tableSurface?.minWidth).toBe("0px");
  expect(geometry.tableSurface?.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expectPx(geometry.tableSurface?.borderRadius, 0);
  expectPx(geometry.tableSurface?.marginTop, 0);
  expectPx(geometry.tableSurface?.marginBottom, 0);
  expect(geometry.tableHeader?.position).toBe("absolute");
  expectPx(geometry.tableHeader?.width, 28);
  expectPx(geometry.tableHeader?.height, 32);
  expectPx(geometry.tableCopyButton?.width, 28);
  expectPx(geometry.tableCopyButton?.height, 28);
  expectPx(geometry.tableCopyButton?.borderRadius, 4);
  expect(geometry.tableViewport?.overflowX).toBe("auto");
  expect((geometry.table?.width ?? 0)).toBeGreaterThan(geometry.tableViewport?.width ?? 0);
  expect(geometry.table?.borderCollapse).toBe("separate");
  expect(geometry.table?.borderSpacing).toBe("0px");
  expect(geometry.table?.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expectPx(geometry.table?.borderRadius, 0);
  expectPx(geometry.table?.fontSize, 14);
  expectPx(geometry.table?.lineHeight, 24);
  expectPx(geometry.tableHeadCell?.fontSize, 14);
  expectPx(geometry.tableHeadCell?.lineHeight, 16);
  expect(geometry.tableHeadCell?.fontWeight).toBe("600");
  expectPx(geometry.tableHeadCell?.paddingTop, 8);
  expectPx(geometry.tableHeadCell?.paddingRight, 24);
  expectPx(geometry.tableHeadCell?.paddingBottom, 8);
  expectPx(geometry.tableHeadCell?.paddingLeft, 0);
  expectPx(geometry.tableHeadCell?.borderBottomWidth, 1);
  expect(geometry.tableHeadCell?.verticalAlign).toBe("bottom");
  expectPx(geometry.tableLastHeadCell?.paddingRight, 40);
  expectPx(geometry.tableLastHeadCell?.paddingLeft, 8);
  expectPx(geometry.tableCell?.fontSize, 14);
  expectPx(geometry.tableCell?.lineHeight, 24);
  expect(geometry.tableCell?.fontWeight).toBe("400");
  expectPx(geometry.tableCell?.paddingTop, 10);
  expectPx(geometry.tableCell?.paddingRight, 24);
  expectPx(geometry.tableCell?.paddingBottom, 10);
  expectPx(geometry.tableCell?.paddingLeft, 0);
  expectPx(geometry.tableCell?.borderBottomWidth, 1);
  expect(geometry.tableCell?.verticalAlign).toBe("baseline");
  expectPx(geometry.tableLastCell?.paddingRight, 0);
  expectPx(geometry.tableLastCell?.paddingLeft, 8);

  if (geometry.viewport.width > 760) {
    expectPx(geometry.assistantContent?.width, 768);
    expectPx(geometry.markdown?.width, 768);
  } else {
    expect(geometry.assistantContent?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      geometry.viewport.width - 32,
    );
  }
  expect(geometry.viewport.devicePixelRatio).toBe(1);
  expect(geometry.viewport.prefersLight).toBe(true);

  await testInfo.attach("assistant-rendering-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });

  // Freeze the approved baseline in the steady state. Copy feedback is tested
  // above, but its timeout must not become part of the screenshot contract.
  await expect(
    successfulCopy.getByRole("button", { name: "复制代码" }),
  ).toBeVisible({ timeout: 3_000 });
  await expect(tableBlock.getByRole("button", { name: "复制表格" })).toBeVisible({
    timeout: 3_000,
  });
  await tableViewport.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await failureTableViewport.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.mouse.move(0, 0);
  await page.locator(".fixture-header").click();
  await page.evaluate(() => window.scrollTo(0, 0));

  // The approved reference environment is Windows Chromium at 100% scaling.
  // Other platforms still exercise every semantic, interaction, and geometry
  // assertion without pretending their font rasterization is pixel-identical.
  if (process.platform === "win32") {
    await expect(page).toHaveScreenshot("assistant-rendering-golden.png", {
      fullPage: true,
      animations: "disabled",
      caret: "hide",
    });
  }

  const screenshotPath = testInfo.outputPath("assistant-rendering.png");
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("assistant-rendering-diagnostic", {
    path: screenshotPath,
    contentType: "image/png",
  });

  for (const [name, locator] of [
    ["assistant-rendering-entry-parity", entryParity],
    ["assistant-rendering-run-states", page.getByTestId("run-states")],
  ] as const) {
    const path = testInfo.outputPath(`${name}.png`);
    await locator.screenshot({
      path,
      animations: "disabled",
      caret: "hide",
    });
    await testInfo.attach(name, {
      path,
      contentType: "image/png",
    });
  }
});
