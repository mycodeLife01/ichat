import { expect, test, type Locator } from "@playwright/test";

const uiFontStack = [
  "-apple-system-body",
  "ui-sans-serif",
  "-apple-system",
  "system-ui",
  "Segoe UI",
  "Helvetica",
  "Apple Color Emoji",
  "Arial",
  "sans-serif",
  "Segoe UI Emoji",
  "Segoe UI Symbol",
].join(", ");

const brandFontStack = [
  "Inter",
  "-apple-system",
  "BlinkMacSystemFont",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Source Han Sans CN",
  "sans-serif",
].join(", ");
const computedBrandFontStack = brandFontStack.replace("BlinkMacSystemFont", "system-ui");
const codeFontStack =
  "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace";

function normalizeFontFamily(value: string) {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim();
}

function expectPx(value: string | undefined, expected: number) {
  expect(Number.parseFloat(value ?? "NaN")).toBeCloseTo(expected, 2);
}

function expectSameBox(
  actual: { width: number; height: number } | undefined,
  expected: { width: number; height: number } | undefined,
) {
  expect(actual).toBeDefined();
  expect(expected).toBeDefined();
  expect(actual?.width).toBeCloseTo(expected?.width ?? Number.NaN, 3);
  expect(actual?.height).toBeCloseTo(expected?.height ?? Number.NaN, 3);
}

type TypographySignature = {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: string;
  letterSpacing: string;
  color: string;
  whiteSpace: string;
  overflowWrap: string;
  wordBreak: string;
  textOverflow: string;
  overflowX: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  box: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
};

async function typographySignature(locator: Locator): Promise<TypographySignature> {
  return locator.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    const style = getComputedStyle(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak,
      textOverflow: style.textOverflow,
      overflowX: style.overflowX,
      clientWidth: htmlElement.clientWidth,
      clientHeight: htmlElement.clientHeight,
      scrollWidth: htmlElement.scrollWidth,
      scrollHeight: htmlElement.scrollHeight,
      box: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    };
  });
}

function expectUiTypography(
  signature: TypographySignature,
  expected: {
    size: number;
    lineHeight: number;
    weight: string;
    color: string;
  },
) {
  expect(normalizeFontFamily(signature.fontFamily)).toBe(uiFontStack);
  expectPx(signature.fontSize, expected.size);
  expectPx(signature.lineHeight, expected.lineHeight);
  expect(signature.fontWeight).toBe(expected.weight);
  expect(signature.letterSpacing).toBe("normal");
  expect(signature.color).toBe(expected.color);
}

function expectHorizontalViewportFit(signature: TypographySignature, viewportWidth: number) {
  expect(signature.box.left).toBeGreaterThanOrEqual(-0.5);
  expect(signature.box.right).toBeLessThanOrEqual(viewportWidth + 0.5);
}

function expectViewportFit(
  signature: TypographySignature,
  viewport: { width: number; height: number },
) {
  expectHorizontalViewportFit(signature, viewport.width);
  expect(signature.box.top).toBeGreaterThanOrEqual(-0.5);
  expect(signature.box.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
}

type ContrastEvidence = {
  foreground: string;
  background: string;
  ratio: number;
};

function rgbChannels(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  expect(channels, `Expected an RGB color, received ${value}`).toHaveLength(3);
  return channels as [number, number, number];
}

function relativeLuminance(value: string) {
  return rgbChannels(value)
    .map((channel) => channel / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (luminance, channel, index) =>
        luminance + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
}

async function contrastEvidence(locator: Locator): Promise<ContrastEvidence> {
  const colors = await locator.evaluate((element) => {
    const foreground = getComputedStyle(element).color;
    let current: Element | null = element;
    let background = "rgb(255, 255, 255)";
    while (current) {
      const candidate = getComputedStyle(current).backgroundColor;
      if (candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
        background = candidate;
        break;
      }
      current = current.parentElement;
    }
    return { foreground, background };
  });
  const foreground = relativeLuminance(colors.foreground);
  const background = relativeLuminance(colors.background);
  const ratio =
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05);
  return { ...colors, ratio };
}

async function expectDocumentHasNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

test("freezes brand wordmarks and the already-aligned typography surfaces", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/visual/typography-system.html");

  const fixture = page.getByTestId("typography-system-fixture");
  await expect(fixture).toBeVisible();
  await expect(page.getByTestId("typography-character-samples")).toContainText(
    "SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
  );
  await expect(page.getByTestId("collapsed-rail").locator(".wordmark")).toHaveCount(0);

  const tokenContract = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const variable = (name: string) => rootStyle.getPropertyValue(name).trim();
    return {
      fonts: {
        ui: variable("--font-ui"),
        brand: variable("--font-sans"),
        code: variable("--font-code"),
        mono: variable("--font-mono"),
        serif: variable("--font-serif"),
      },
      colors: {
        primary: variable("--color-type-primary"),
        secondary: variable("--color-type-secondary"),
        tertiary: variable("--color-type-tertiary"),
        disabled: variable("--color-type-disabled"),
        userMessage: variable("--color-type-user-message"),
      },
      metrics: {
        ui: [variable("--text-ui"), variable("--text-ui--line-height")],
        meta: [variable("--text-meta"), variable("--text-meta--line-height")],
        surfaceTitle: [
          variable("--text-surface-title"),
          variable("--text-surface-title--line-height"),
        ],
        composer: [variable("--text-composer"), variable("--text-composer--line-height")],
        userMessage: [
          variable("--text-user-message"),
          variable("--text-user-message--line-height"),
        ],
        assistant: [
          variable("--text-assistant"),
          variable("--text-assistant--line-height"),
        ],
        reasoning: [
          variable("--text-reasoning"),
          variable("--text-reasoning--line-height"),
        ],
      },
      rootBaseline: {
        fontFamily: bodyStyle.fontFamily,
        fontSize: bodyStyle.fontSize,
        lineHeight: bodyStyle.lineHeight,
      },
      rootSensitiveUtilities: {
        spacing: variable("--spacing"),
        textLg: variable("--text-lg"),
        textLgLineHeight: variable("--text-lg--line-height"),
        radiusXl: variable("--radius-xl"),
      },
    };
  });

  expect(normalizeFontFamily(tokenContract.fonts.ui)).toBe(uiFontStack);
  expect(normalizeFontFamily(tokenContract.fonts.brand)).toBe(brandFontStack);
  expect(normalizeFontFamily(tokenContract.fonts.code)).toBe(codeFontStack);
  expect(tokenContract.fonts.mono).toContain("JetBrains Mono");
  expect(tokenContract.fonts.serif).toContain("Source Han Serif SC");
  expect(tokenContract.colors).toEqual({
    primary: "#0d0d0d",
    secondary: "#5d5d5d",
    tertiary: "#8f8f8f",
    disabled: "#b4b4b4",
    userMessage: "#0c274a",
  });
  expect(tokenContract.metrics).toEqual({
    ui: ["14px", "20px"],
    meta: ["12px", "16px"],
    surfaceTitle: ["18px", "28px"],
    composer: ["16px", "26px"],
    userMessage: ["16px", "24px"],
    assistant: ["16px", "26px"],
    reasoning: ["16px", "24px"],
  });
  expect(normalizeFontFamily(tokenContract.rootBaseline.fontFamily)).toBe(uiFontStack);
  expect(tokenContract.rootBaseline.fontSize).toBe("16px");
  expect(tokenContract.rootBaseline.lineHeight).toBe("24px");
  expect(tokenContract.rootSensitiveUtilities).toEqual({
    spacing: "4px",
    textLg: "16.875px",
    textLgLineHeight: "26.25px",
    radiusXl: "11.25px",
  });

  const brandSignatures = await page.locator("[data-brand-variant]").evaluateAll((cards) =>
    cards.map((card) => {
      const node = card.querySelector<HTMLElement>("[data-brand-node]");
      const wordmark = node?.querySelector<HTMLElement>(".wordmark") ?? node;
      if (!wordmark) {
        return { id: card.getAttribute("data-brand-variant"), visibleWordmark: false };
      }
      const style = getComputedStyle(wordmark);
      const rect = wordmark.getBoundingClientRect();
      return {
        id: card.getAttribute("data-brand-variant"),
        visibleWordmark: true,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        transform: style.transform,
        color: style.color,
        opacity: style.opacity,
        box: { width: rect.width, height: rect.height },
      };
    }),
  );

  await testInfo.attach("typography-brand-baseline", {
    body: JSON.stringify(brandSignatures, null, 2),
    contentType: "application/json",
  });

  const byId = new Map(brandSignatures.map((signature) => [signature.id, signature]));
  const standard18 = byId.get("wordmark-18");
  const standard20 = byId.get("wordmark-20");
  const sidebarDesktop = byId.get("sidebar-desktop-expanded");
  const authTitle = byId.get("auth-screen-title");

  expect(standard18?.visibleWordmark).toBe(true);
  expect(standard20?.visibleWordmark).toBe(true);
  expect(sidebarDesktop?.visibleWordmark).toBe(true);
  expect(authTitle?.visibleWordmark).toBe(true);
  expect(byId.get("sidebar-desktop-collapsed")?.visibleWordmark).toBe(false);

  expect(standard18?.fontFamily).toContain("Inter");
  expect(standard20?.fontFamily).toBe(standard18?.fontFamily);
  expect(authTitle?.fontFamily).toBe(standard18?.fontFamily);
  expect(normalizeFontFamily(sidebarDesktop?.fontFamily ?? "")).toBe(uiFontStack);
  expect(sidebarDesktop?.color).toBe("rgb(13, 13, 13)");
  expect(standard18?.color).toBe("rgb(26, 26, 25)");
  expect(authTitle?.color).toBe("rgb(26, 26, 25)");

  expectPx(standard18?.fontSize, 18);
  expectPx(standard20?.fontSize, 20);
  expectPx(sidebarDesktop?.fontSize, 18);
  expectPx(authTitle?.fontSize, 22);
  expectPx(standard18?.lineHeight, 28.8);
  expectPx(standard20?.lineHeight, 32);
  expectPx(sidebarDesktop?.lineHeight, 24);
  expectPx(authTitle?.lineHeight, 35.2);
  expect(standard18?.fontWeight).toBe("600");
  expect(standard20?.fontWeight).toBe("600");
  expect(sidebarDesktop?.fontWeight).toBe("600");
  expect(authTitle?.fontWeight).toBe("600");
  expectPx(standard18?.letterSpacing, -0.45);
  expectPx(standard20?.letterSpacing, -0.5);
  expectPx(sidebarDesktop?.letterSpacing, -0.27);
  expectPx(authTitle?.letterSpacing, -0.44);
  expect(standard18?.transform).toBe("matrix(1.04, 0, 0, 0.9, 0, 0)");
  expect(standard20?.transform).toBe("matrix(1.04, 0, 0, 0.9, 0, 0)");
  expect(sidebarDesktop?.transform).toBe("matrix(1.04, 0, 0, 0.9, 0, 0)");
  expect(authTitle?.transform).toBe("none");
  expect(standard18?.opacity).toBe("1");
  expect(standard20?.opacity).toBe("1");
  expect(sidebarDesktop?.opacity).toBe("1");

  if (process.platform === "darwin") {
    expect(standard18?.box?.width).toBeCloseTo(43.81, 1);
    expect(standard18?.box?.height).toBeCloseTo(25.92, 1);
    expect(standard20?.box?.width).toBeCloseTo(47.97, 1);
    expect(standard20?.box?.height).toBeCloseTo(28.8, 1);
    expect(sidebarDesktop?.box?.width).toBeCloseTo(44.75, 1);
    expect(sidebarDesktop?.box?.height).toBeCloseTo(21.6, 1);
    expect(authTitle?.box?.width).toBeCloseTo(51.03, 1);
    expect(authTitle?.box?.height).toBeCloseTo(35.19, 1);
  }

  for (const id of ["share-desktop", "verify-email", "reset-password", "confirm-account-deletion"]) {
    const signature = byId.get(id);
    expect(signature?.fontFamily).toBe(standard18?.fontFamily);
    expect(signature?.fontSize).toBe(standard18?.fontSize);
    expect(signature?.lineHeight).toBe(standard18?.lineHeight);
    expect(signature?.letterSpacing).toBe(standard18?.letterSpacing);
    expect(signature?.transform).toBe(standard18?.transform);
    expect(signature?.color).toBe(standard18?.color);
    expectSameBox(signature?.box, standard18?.box);
  }
  for (const id of ["sidebar-mobile", "share-mobile"]) {
    const signature = byId.get(id);
    expect(signature?.fontFamily).toBe(standard20?.fontFamily);
    expect(signature?.fontSize).toBe(standard20?.fontSize);
    expect(signature?.lineHeight).toBe(standard20?.lineHeight);
    expect(signature?.letterSpacing).toBe(standard20?.letterSpacing);
    expect(signature?.transform).toBe(standard20?.transform);
    expect(signature?.color).toBe(standard20?.color);
    expectSameBox(signature?.box, standard20?.box);
  }

  const roleSignatures = await page.locator("[data-type-role]").evaluateAll((cards) =>
    cards.map((card) => {
      const sample = card.querySelector<HTMLElement>("p");
      if (!sample) return null;
      const style = getComputedStyle(sample);
      return {
        id: card.getAttribute("data-type-role"),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        color: style.color,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        wordBreak: style.wordBreak,
        textOverflow: style.textOverflow,
      };
    }),
  );
  const roles = new Map(roleSignatures.flatMap((role) => (role ? [[role.id, role]] : [])));
  const expectRole = (
    id: string,
    expected: { size: string; lineHeight: string; weight: string; color: string },
  ) => {
    const role = roles.get(id);
    expect(role).toBeDefined();
    expect(normalizeFontFamily(role?.fontFamily ?? "")).toBe(uiFontStack);
    expect(role).toMatchObject({
      fontSize: expected.size,
      lineHeight: expected.lineHeight,
      fontWeight: expected.weight,
      letterSpacing: "normal",
      color: expected.color,
    });
  };

  expectRole("uiText", {
    size: "14px",
    lineHeight: "20px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("uiLabel", {
    size: "14px",
    lineHeight: "20px",
    weight: "500",
    color: "rgb(13, 13, 13)",
  });
  expectRole("metaText", {
    size: "12px",
    lineHeight: "16px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expectRole("surfaceTitle", {
    size: "18px",
    lineHeight: "28px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("controlText", {
    size: "14px",
    lineHeight: "20px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("formLabel", {
    size: "14px",
    lineHeight: "20px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("formValue", {
    size: "14px",
    lineHeight: "20px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("formHelp", {
    size: "12px",
    lineHeight: "16px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expect(roles.get("formHelp")?.overflowWrap).toBe("break-word");
  expectRole("composerText", {
    size: "16px",
    lineHeight: "26px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expect(roles.get("composerText")?.whiteSpace).toBe("break-spaces");
  expectRole("composerPlaceholder", {
    size: "16px",
    lineHeight: "26px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expect(roles.get("composerPlaceholder")?.whiteSpace).toBe("nowrap");
  expect(roles.get("composerPlaceholder")?.textOverflow).toBe("ellipsis");
  expectRole("composerMode", {
    size: "16px",
    lineHeight: "26px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expectRole("composerMenuItem", {
    size: "14px",
    lineHeight: "20px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("userMessageText", {
    size: "16px",
    lineHeight: "24px",
    weight: "400",
    color: "rgb(12, 39, 74)",
  });
  expect(roles.get("userMessageText")?.whiteSpace).toBe("pre-wrap");
  expect(roles.get("userMessageText")?.overflowWrap).toBe("anywhere");
  expectRole("assistantText", {
    size: "16px",
    lineHeight: "26px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("reasoningCollapsed", {
    size: "16px",
    lineHeight: "24px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expectRole("reasoningText", {
    size: "16px",
    lineHeight: "24px",
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectRole("attachmentTitle", {
    size: "14px",
    lineHeight: "20px",
    weight: "500",
    color: "rgb(13, 13, 13)",
  });
  expect(roles.get("attachmentTitle")?.whiteSpace).toBe("nowrap");
  expect(roles.get("attachmentTitle")?.textOverflow).toBe("ellipsis");
  expectRole("attachmentMeta", {
    size: "12px",
    lineHeight: "16px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expectRole("sourceTitle", {
    size: "14px",
    lineHeight: "20px",
    weight: "500",
    color: "rgb(13, 13, 13)",
  });
  expectRole("sourceMeta", {
    size: "12px",
    lineHeight: "16px",
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expectRole("semanticStatus", {
    size: "14px",
    lineHeight: "20px",
    weight: "400",
    color: "rgb(57, 115, 74)",
  });

  const aligned = await page.evaluate(() => {
    const signature = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        color: style.color,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        textOverflow: style.textOverflow,
        box: { width: rect.width, height: rect.height },
      };
    };
    return {
      viewport: {
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        devicePixelRatio: window.devicePixelRatio,
      },
      sidebarLabel: signature('[data-testid="sidebar-group-label"]'),
      sidebarRow: signature('[data-testid="sidebar-row-text"]'),
      assistant: signature('[data-testid="assistant-typography-baseline"] .assistant-markdown'),
    };
  });

  await testInfo.attach("typography-aligned-baseline", {
    body: JSON.stringify(aligned, null, 2),
    contentType: "application/json",
  });

  expect(aligned.viewport.scrollWidth).toBe(aligned.viewport.width);
  expect(aligned.viewport.devicePixelRatio).toBe(1);
  expect(normalizeFontFamily(aligned.sidebarLabel?.fontFamily ?? "")).toBe(uiFontStack);
  expect(normalizeFontFamily(aligned.sidebarRow?.fontFamily ?? "")).toBe(uiFontStack);
  expect(normalizeFontFamily(aligned.assistant?.fontFamily ?? "")).toBe(uiFontStack);
  expectPx(aligned.sidebarLabel?.fontSize, 14);
  expectPx(aligned.sidebarLabel?.lineHeight, 20);
  expect(aligned.sidebarLabel?.fontWeight).toBe("500");
  expect(aligned.sidebarLabel?.color).toBe("rgb(143, 143, 143)");
  expect(aligned.sidebarLabel?.whiteSpace).toBe("nowrap");
  expect(aligned.sidebarLabel?.textOverflow).toBe("ellipsis");
  expectPx(aligned.sidebarRow?.fontSize, 14);
  expectPx(aligned.sidebarRow?.lineHeight, 20);
  expect(aligned.sidebarRow?.fontWeight).toBe("400");
  expect(aligned.sidebarRow?.color).toBe("rgb(13, 13, 13)");
  expect(aligned.sidebarRow?.whiteSpace).toBe("nowrap");
  expect(aligned.sidebarRow?.textOverflow).toBe("ellipsis");
  expectPx(aligned.assistant?.fontSize, 16);
  expectPx(aligned.assistant?.lineHeight, 26);
  expect(aligned.assistant?.fontWeight).toBe("400");
  expect(aligned.assistant?.color).toBe("rgb(13, 13, 13)");
  expect(aligned.assistant?.overflowWrap).toBe("break-word");

  const markdown = page
    .getByTestId("assistant-typography-baseline")
    .locator(".assistant-markdown");
  await expect(markdown.locator("[data-code-block]")).toBeVisible();
  const markdownRoles = {
    markdownH1: await typographySignature(markdown.locator("h1")),
    markdownH2: await typographySignature(markdown.locator("h2")),
    markdownH3: await typographySignature(markdown.locator("h3")),
    markdownH4: await typographySignature(markdown.locator("h4")),
    markdownH5: await typographySignature(markdown.locator("h5")),
    markdownH6: await typographySignature(markdown.locator("h6")),
    markdownList: await typographySignature(markdown.locator("ul").first()),
    markdownQuote: await typographySignature(markdown.locator("blockquote")),
    markdownLink: await typographySignature(
      markdown.getByRole("link", { name: "长链接" }),
    ),
    inlineCode: await typographySignature(markdown.locator("p code")),
    codeToolbar: await typographySignature(markdown.locator(".code-block-language")),
    codeText: await typographySignature(markdown.locator("[data-code-block] pre")),
    tableHead: await typographySignature(markdown.locator("th").first()),
    tableText: await typographySignature(markdown.locator("td").first()),
  };
  const matrixRoleCoverage = [
    ...roles.keys(),
    ...Object.keys(markdownRoles).filter((role) => role !== "markdownLink"),
  ].sort();
  expect(matrixRoleCoverage).toEqual(
    [
      "uiText",
      "uiLabel",
      "metaText",
      "surfaceTitle",
      "controlText",
      "formLabel",
      "formValue",
      "formHelp",
      "composerText",
      "composerPlaceholder",
      "composerMode",
      "composerMenuItem",
      "userMessageText",
      "assistantText",
      "reasoningCollapsed",
      "reasoningText",
      "markdownH1",
      "markdownH2",
      "markdownH3",
      "markdownH4",
      "markdownH5",
      "markdownH6",
      "markdownList",
      "markdownQuote",
      "tableText",
      "tableHead",
      "inlineCode",
      "codeToolbar",
      "codeText",
      "attachmentTitle",
      "attachmentMeta",
      "sourceTitle",
      "sourceMeta",
      "semanticStatus",
    ].sort(),
  );

  expectUiTypography(markdownRoles.markdownH1, {
    size: 24,
    lineHeight: 32,
    weight: "600",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownH2, {
    size: 20,
    lineHeight: 28,
    weight: "600",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownH3, {
    size: 18,
    lineHeight: 28,
    weight: "600",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownH4, {
    size: 16,
    lineHeight: 24,
    weight: "600",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownH5, {
    size: 16,
    lineHeight: 26,
    weight: "600",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownH6, {
    size: 16,
    lineHeight: 26,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownList, {
    size: 16,
    lineHeight: 26,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownQuote, {
    size: 16,
    lineHeight: 24,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.markdownLink, {
    size: 16,
    lineHeight: 26,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expect(normalizeFontFamily(markdownRoles.inlineCode.fontFamily)).toBe(codeFontStack);
  expectPx(markdownRoles.inlineCode.fontSize, 14);
  expectPx(markdownRoles.inlineCode.lineHeight, 26);
  expect(markdownRoles.inlineCode.fontWeight).toBe("500");
  expect(markdownRoles.inlineCode.letterSpacing).toBe("normal");
  expectUiTypography(markdownRoles.codeToolbar, {
    size: 14,
    lineHeight: 20,
    weight: "500",
    color: "rgb(13, 13, 13)",
  });
  expect(normalizeFontFamily(markdownRoles.codeText.fontFamily)).toBe(codeFontStack);
  expectPx(markdownRoles.codeText.fontSize, 14);
  expectPx(markdownRoles.codeText.lineHeight, 20);
  expect(markdownRoles.codeText.fontWeight).toBe("400");
  expect(markdownRoles.codeText.letterSpacing).toBe("normal");
  expect(markdownRoles.codeText.whiteSpace).toBe("pre");
  expectUiTypography(markdownRoles.tableHead, {
    size: 14,
    lineHeight: 16,
    weight: "600",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(markdownRoles.tableText, {
    size: 14,
    lineHeight: 24,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });

  const characterSamples = await page.locator("[data-character-sample]").evaluateAll(
    (samples) =>
      samples.map((sample) => {
        const element = sample as HTMLElement;
        return {
          kind: element.dataset.characterSample,
          text: element.textContent,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowWrap: getComputedStyle(element).overflowWrap,
        };
      }),
  );
  expect(characterSamples.map((sample) => sample.kind)).toEqual([
    "mixed",
    "long-word",
    "long-url",
  ]);
  expect(characterSamples[0]?.text).toContain("简体中文 English 1234567890");
  expect(characterSamples[0]?.text).toContain("😀 🤖 🚀");
  for (const sample of characterSamples) {
    expect(sample.overflowWrap).toBe("anywhere");
    expect(sample.scrollWidth).toBeLessThanOrEqual(sample.clientWidth + 1);
  }

  await testInfo.attach("typography-reference-matrix-roles", {
    body: JSON.stringify(
      { matrixRoleCoverage, roles: roleSignatures, markdown: markdownRoles, characterSamples },
      null,
      2,
    ),
    contentType: "application/json",
  });

  const screenshotPath = testInfo.outputPath("typography-system.png");
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach("typography-system-diagnostic", {
    path: screenshotPath,
    contentType: "image/png",
  });

  // Central computed-style allowlist for the only non-UI font families:
  // iChat brand text, assistant source code, and third-party KaTeX content.
  await page.goto("/tests/visual/assistant-rendering.html");
  const finalMessage = page.getByTestId("final-message");
  await expect(finalMessage).toBeVisible();
  const familyExceptions = await finalMessage.evaluate((element) => {
    const family = (selector: string) => {
      const node = element.querySelector<HTMLElement>(selector);
      return node ? getComputedStyle(node).fontFamily : null;
    };
    return {
      inlineCode: family(".assistant-markdown p code"),
      blockCode: family("[data-code-block] pre"),
      codeToolbar: family(".code-block-language"),
      katex: family(".katex"),
    };
  });
  expect(normalizeFontFamily(familyExceptions.inlineCode ?? "")).toBe(codeFontStack);
  expect(normalizeFontFamily(familyExceptions.blockCode ?? "")).toBe(codeFontStack);
  expect(normalizeFontFamily(familyExceptions.codeToolbar ?? "")).toBe(uiFontStack);
  expect(familyExceptions.katex).toContain("KaTeX_Main");
});

test("meets primary contrast and preserves non-color status cues", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chrome",
    "The contrast and status audit runs once in the desktop Chromium project.",
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tests/visual/typography-system.html");

  const primarySamples = {
    uiText: page.locator('[data-type-role="uiText"] p'),
    surfaceTitle: page.locator('[data-type-role="surfaceTitle"] p'),
    sidebarRow: page.getByTestId("sidebar-row-text"),
    assistantText: page
      .getByTestId("assistant-typography-baseline")
      .locator(".assistant-markdown > p")
      .first(),
    userMessageText: page.getByTestId("chat-user-message").getByText(fixtureLongUserText, {
      exact: true,
    }),
  };
  const contrast: Record<string, ContrastEvidence> = {};
  for (const [name, locator] of Object.entries(primarySamples)) {
    contrast[name] = await contrastEvidence(locator);
    expect(contrast[name]?.ratio).toBeGreaterThanOrEqual(4.5);
  }

  await page.goto("/tests/visual/typography-system.html?surface=states");
  const stateEvidence = [];
  for (const state of [
    { tone: "error", role: "alert", label: "Error" },
    { tone: "warning", role: "status", label: "Warning" },
    { tone: "success", role: "status", label: "Success" },
  ] as const) {
    const status = page
      .locator(`[data-tone="${state.tone}"][role="${state.role}"]`)
      .filter({ has: page.locator(`[data-status-icon="${state.tone}"]`) });
    await expect(status).toHaveCount(1);
    await expect(status).toContainText(state.label);
    const icon = status.locator(`[data-status-icon="${state.tone}"]`);
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    stateEvidence.push({
      tone: state.tone,
      role: await status.getAttribute("role"),
      text: await status.textContent(),
      icon: await icon.getAttribute("data-status-icon"),
    });
  }

  const toast = page.locator('[data-tone="warning"][role="status"]')
    .filter({ has: page.locator('[data-toast-icon="warning"]') });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Warning");
  await expect(toast.locator('[data-toast-icon="warning"]')).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  await page.goto("/tests/visual/typography-system.html");
  await expect(
    page.getByTestId("chat-failed-attachment").getByText(fixtureFailedAttachmentStatus, {
      exact: true,
    }),
  ).toContainText("上传失败");

  await testInfo.attach("typography-contrast-and-status-evidence", {
    body: JSON.stringify({ contrast, statuses: stateEvidence }, null, 2),
    contentType: "application/json",
  });
});

test("preserves reflow, focus, errors and reachability at 200% zoom", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  test.skip(
    testInfo.project.name !== "desktop-chrome",
    "The 200% browser-scale audit runs once in the desktop Chromium project.",
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 400,
    deviceScaleFactor: 1,
    mobile: false,
    scale: 2,
    screenWidth: 1280,
    screenHeight: 800,
  });

  try {
    await page.goto("/tests/visual/typography-system.html?surface=auth");
    await expect(page.locator(".auth-brand-title")).toHaveText("iChat");
    const zoomMetrics = await page.evaluate(() => ({
      cssViewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height },
      devicePixelRatio,
      visualViewport: {
        width: visualViewport?.width ?? null,
        height: visualViewport?.height ?? null,
        scale: visualViewport?.scale ?? null,
      },
    }));
    expect(zoomMetrics).toEqual({
      cssViewport: { width: 640, height: 400 },
      screen: { width: 1280, height: 800 },
      devicePixelRatio: 1,
      visualViewport: { width: 640, height: 400, scale: 1 },
    });

    const registerTab = page.getByRole("tab", { name: "注册" });
    await registerTab.focus();
    await registerTab.press("Enter");
    await expect(registerTab).toHaveAttribute("aria-selected", "true");
    const username = page.getByLabel("用户名");
    for (let index = 0; index < 12; index += 1) {
      if (await username.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(username).toBeFocused();
    const focusStyle = await username.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
      };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expectPx(focusStyle.outlineWidth, 2);

    const submit = page.locator('button[type="submit"]');
    await submit.focus();
    await submit.press("Enter");
    const usernameError = page.getByText("请输入 1–50 个字符的用户名", { exact: true });
    await expect(usernameError).toBeVisible();
    const describedBy = await username.getAttribute("aria-describedby");
    expect(describedBy).toContain("auth-username-error");
    await expect(page.locator(`#${describedBy}`)).toHaveText(
      "请输入 1–50 个字符的用户名",
    );
    const usernameErrorText = await usernameError.textContent();
    await expectDocumentHasNoHorizontalOverflow(page);

    const authControls = page.locator(
      'button:visible, input:visible, a[href]:visible',
    );
    const authControlCount = await authControls.count();
    for (let index = 0; index < authControlCount; index += 1) {
      const control = authControls.nth(index);
      await control.evaluate((element) =>
        element.scrollIntoView({ block: "center", inline: "nearest" }),
      );
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(-0.5);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(640.5);
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(-0.5);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(400.5);
    }

    const zoomScreenshotPath = testInfo.outputPath("typography-zoom-200-auth.png");
    const zoomScreenshot = await page.screenshot({
      path: zoomScreenshotPath,
      animations: "disabled",
      caret: "hide",
    });
    expect(zoomScreenshot.readUInt32BE(16)).toBe(1280);
    expect(zoomScreenshot.readUInt32BE(20)).toBe(800);
    await testInfo.attach("typography-zoom-200-auth", {
      path: zoomScreenshotPath,
      contentType: "image/png",
    });

    await page.goto("/tests/visual/typography-system.html?surface=states");
    const states = page.getByTestId("secondary-states-fixture");
    await expect(states).toBeVisible();
    await expectDocumentHasNoHorizontalOverflow(page);
    for (const status of [
      page.getByRole("alert"),
      page
        .getByText("Warning：附件仍在解析，完成前请勿关闭页面。", { exact: true })
        .locator("xpath=.."),
      page.getByText("Success：更改已保存。", { exact: true }).locator("xpath=.."),
    ]) {
      await status.evaluate((element) =>
        element.scrollIntoView({ block: "center", inline: "nearest" }),
      );
      const signature = await typographySignature(status);
      expectHorizontalViewportFit(signature, 640);
      expect(signature.scrollWidth).toBeLessThanOrEqual(signature.clientWidth + 1);
      expect(signature.scrollHeight).toBeLessThanOrEqual(signature.clientHeight + 1);
    }

    const statesScreenshotPath = testInfo.outputPath("typography-zoom-200-states.png");
    const statesScreenshot = await page.screenshot({
      path: statesScreenshotPath,
      animations: "disabled",
      caret: "hide",
    });
    expect(statesScreenshot.readUInt32BE(16)).toBe(1280);
    expect(statesScreenshot.readUInt32BE(20)).toBe(800);
    await testInfo.attach("typography-zoom-200-states", {
      path: statesScreenshotPath,
      contentType: "image/png",
    });
    await testInfo.attach("typography-zoom-200-evidence", {
      body: JSON.stringify(
        {
          requestedScale: 2,
          physicalViewport: { width: 1280, height: 800 },
          ...zoomMetrics,
          focusStyle,
          error: {
            text: usernameErrorText,
            describedBy,
          },
          authControlCount,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
});

const chatCoreViewports = [320, 375, 390, 414, 768, 1280] as const;
const fixtureModelLabel =
  "gpt-5.6-typography-verification-with-a-long-model-name";
const fixtureAttachmentName =
  "2026-Q4-typography-Supercalifragilisticexpialidocious-report.pdf";
const fixtureFailedAttachmentName =
  "failed-typography-document-with-a-very-long-name.pdf";
const fixtureFailedAttachmentStatus =
  "上传失败：请检查网络后重试；this deliberately long status wraps instead of shrinking.";
const fixtureSourceTitle =
  "ChatGPT typography reference with a naturally wrapping source title";
const fixtureLongUserText = Array.from(
  { length: 18 },
  (_, index) =>
    `${index + 1}. 用户消息 中文 English 123456 🤖 ` +
    "SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
).join("\n");

for (const width of chatCoreViewports) {
  test(`migrates chat-core typography without overflow at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chrome",
      "The explicit viewport matrix runs once from the desktop project.",
    );

    const viewport = {
      width,
      height: width === 1280 ? 800 : width <= 414 ? 844 : 900,
    };
    const isMobile = width <= 760;
    await page.setViewportSize(viewport);
    await page.goto("/tests/visual/typography-system.html");

    const chatCore = page.getByTestId("chat-core-typography");
    await expect(chatCore).toBeVisible();
    await expect(chatCore).toHaveAttribute("data-mobile", isMobile ? "true" : "false");
    if (width === 1280) {
      const retainedRadius = await page.locator('[class~="rounded-xl"]').first().evaluate(
        (element) => getComputedStyle(element).borderRadius,
      );
      expectPx(retainedRadius, 11.25);
    }

    const composer = page.getByTestId("chat-composer");
    const textarea = composer.getByRole("textbox");
    expect(await textarea.evaluate((element) => element.style.maxHeight)).toBe(
      "max(30svh, 75px)",
    );
    const textareaStyle = await typographySignature(textarea);
    expectUiTypography(textareaStyle, {
      size: 16,
      lineHeight: 26,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    expect(textareaStyle.whiteSpace).toBe("break-spaces");
    expect(textareaStyle.overflowWrap).toBe("break-word");
    expect(textareaStyle.wordBreak).toBe("normal");

    const placeholderStyle = await textarea.evaluate((element) => {
      const style = getComputedStyle(element, "::placeholder");
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        color: style.color,
        opacity: style.opacity,
      };
    });
    expect(normalizeFontFamily(placeholderStyle.fontFamily)).toBe(uiFontStack);
    expectPx(placeholderStyle.fontSize, 16);
    expectPx(placeholderStyle.lineHeight, 26);
    expect(placeholderStyle.fontWeight).toBe("400");
    expect(placeholderStyle.color).toBe("rgb(143, 143, 143)");
    expect(placeholderStyle.opacity).toBe("1");

    const pickerTrigger = composer.getByRole("button", {
      name: /^模型与思考强度/,
    });
    await expect(pickerTrigger).toHaveAccessibleName(
      `模型与思考强度：${fixtureModelLabel} 极致`,
    );
    const pickerTriggerStyle = await typographySignature(pickerTrigger);
    expectUiTypography(pickerTriggerStyle, {
      size: 16,
      lineHeight: 26,
      weight: "400",
      color: "rgb(143, 143, 143)",
    });
    expectHorizontalViewportFit(pickerTriggerStyle, viewport.width);

    await composer.getByRole("button", { name: "添加文件等" }).click();
    const toolsMenu = page.getByRole("menu", { name: "添加和工具" });
    await expect(toolsMenu).toBeVisible();
    expectViewportFit(await typographySignature(toolsMenu), viewport);
    const uploadItem = toolsMenu.getByRole("menuitem", { name: /添加照片和文件/ });
    expectUiTypography(await typographySignature(uploadItem), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    expectUiTypography(
      await typographySignature(uploadItem.getByText("从电脑上传", { exact: true })),
      {
        size: 14,
        lineHeight: 20,
        weight: "400",
        color: "rgb(143, 143, 143)",
      },
    );
    await page.keyboard.press("Escape");
    await expect(toolsMenu).toHaveCount(0);

    await pickerTrigger.click();
    const pickerMenu = page.getByRole("menu", {
      name: "模型与思考强度",
      exact: true,
    });
    await expect(pickerMenu).toBeVisible();
    expectViewportFit(await typographySignature(pickerMenu), viewport);
    const modelRow = pickerMenu.getByRole("menuitem", { name: /^模型/ });
    expectUiTypography(await typographySignature(modelRow), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    const modelValue = modelRow.getByText(fixtureModelLabel, { exact: true });
    expectUiTypography(await typographySignature(modelValue), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(143, 143, 143)",
    });
    await modelRow.click();
    const modelMenu = page.getByRole("menu", { name: "模型", exact: true });
    await expect(modelMenu).toBeVisible();
    expectViewportFit(await typographySignature(modelMenu), viewport);
    const longModelOption = modelMenu.getByRole("menuitemradio", {
      name: fixtureModelLabel,
    });
    await expect(longModelOption).toBeVisible();
    const longModelText = longModelOption.getByText(fixtureModelLabel, { exact: true });
    const longModelStyle = await typographySignature(longModelText);
    expectUiTypography(longModelStyle, {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    expect(longModelStyle.scrollWidth).toBeGreaterThan(longModelStyle.clientWidth);
    expect(longModelStyle.textOverflow).toBe("ellipsis");
    await page.keyboard.press("Escape");
    await expect(pickerMenu).toHaveCount(0);

    const userSurface = page.getByTestId("chat-user-message");
    const userContent = userSurface.getByText(fixtureLongUserText, { exact: true });
    const userBubble = userContent.locator("xpath=../..");
    const userStyle = await typographySignature(userContent);
    expectUiTypography(userStyle, {
      size: 16,
      lineHeight: 24,
      weight: "400",
      color: "rgb(12, 39, 74)",
    });
    expect(userStyle.whiteSpace).toBe("pre-wrap");
    expect(userStyle.overflowWrap).toBe("anywhere");
    expect(userStyle.wordBreak).toBe("normal");
    expectHorizontalViewportFit(await typographySignature(userBubble), viewport.width);
    await expect(userSurface.getByRole("button", { name: "展开" })).toBeVisible();

    if (isMobile) {
      await userBubble.dispatchEvent("touchstart");
      await page.waitForTimeout(475);
      await userBubble.dispatchEvent("touchend");
      const mobileEditAction = page.getByRole("button", { name: "编辑并重发" });
      await expect(mobileEditAction).toBeVisible();
      expectUiTypography(await typographySignature(mobileEditAction), {
        size: 14,
        lineHeight: 20,
        weight: "400",
        color: "rgb(13, 13, 13)",
      });
      await mobileEditAction.click();
    } else {
      await userSurface.locator(".msg.user").hover();
      await userSurface.getByRole("button", { name: "编辑并重发" }).click();
    }

    const editor = userSurface.getByTestId("message-editor").getByRole("textbox");
    await expect(editor).toBeVisible();
    const editorStyle = await typographySignature(editor);
    expectUiTypography(editorStyle, {
      size: 16,
      lineHeight: 24,
      weight: "400",
      color: "rgb(12, 39, 74)",
    });
    expect(editorStyle.whiteSpace).toBe("pre-wrap");
    expect(editorStyle.overflowWrap).toBe("anywhere");
    await userSurface.getByRole("button", { name: "取消" }).click();

    const expandButton = userSurface.getByRole("button", { name: "展开" });
    await expandButton.click();
    await expect(userSurface.getByRole("button", { name: "收起" })).toBeVisible();
    const expandedUserStyle = await typographySignature(
      userSurface.getByText(fixtureLongUserText, { exact: true }),
    );
    expectUiTypography(expandedUserStyle, {
      size: 16,
      lineHeight: 24,
      weight: "400",
      color: "rgb(12, 39, 74)",
    });
    expect(expandedUserStyle.scrollHeight).toBeLessThanOrEqual(
      expandedUserStyle.clientHeight + 1,
    );

    const thinkingSurface = page.getByTestId("chat-thinking-block");
    const thinkingLabel = thinkingSurface.locator(".thinking-label");
    expectUiTypography(await typographySignature(thinkingLabel), {
      size: 16,
      lineHeight: 24,
      weight: "400",
      color: "rgb(143, 143, 143)",
    });
    await thinkingSurface.getByRole("button", { name: /已思考/ }).click();
    const thinkingBody = thinkingSurface.locator(".thinking-body");
    await expect(thinkingBody).toBeVisible();
    const thinkingBodyStyle = await typographySignature(thinkingBody);
    expectUiTypography(thinkingBodyStyle, {
      size: 16,
      lineHeight: 24,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    expect(thinkingBodyStyle.scrollWidth).toBeLessThanOrEqual(
      thinkingBodyStyle.clientWidth + 1,
    );

    const assistantSurface = page.getByTestId("chat-assistant-message");
    const assistantMarkdown = assistantSurface.locator(".assistant-markdown").first();
    expectUiTypography(await typographySignature(assistantMarkdown), {
      size: 16,
      lineHeight: 26,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });

    const messageAction = assistantSurface.locator(".msg-actions > div").first();
    await messageAction.getByRole("button", { name: "复制" }).hover();
    const messageActionHint = messageAction.locator(":scope > span");
    await expect(messageActionHint).toBeVisible();
    expectUiTypography(await typographySignature(messageActionHint), {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(251, 251, 250)",
    });

    const citationChip = assistantSurface.getByRole("button", {
      name: "查看 2 个引用来源",
    });
    const citationChipStyle = await typographySignature(citationChip);
    expectUiTypography(citationChipStyle, {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(143, 143, 143)",
    });
    expect(citationChipStyle.whiteSpace).toBe("nowrap");
    if (isMobile) await citationChip.click();
    else await citationChip.hover();
    const citationCard = page.locator(".citation-card");
    await expect(citationCard).toBeVisible();
    expectHorizontalViewportFit(await typographySignature(citationCard), viewport.width);
    expectUiTypography(
      await typographySignature(
        citationCard.getByText(fixtureSourceTitle, { exact: true }),
      ),
      {
        size: 14,
        lineHeight: 20,
        weight: "500",
        color: "rgb(13, 13, 13)",
      },
    );
    if (isMobile) await citationChip.click();
    else await thinkingSurface.hover();
    await expect(citationCard).toHaveCount(0);

    const attachmentTitle = assistantSurface.getByText(fixtureAttachmentName, {
      exact: true,
    });
    const attachmentTitleStyle = await typographySignature(attachmentTitle);
    expectUiTypography(attachmentTitleStyle, {
      size: 14,
      lineHeight: 20,
      weight: "500",
      color: "rgb(13, 13, 13)",
    });
    expect(attachmentTitleStyle.whiteSpace).toBe("nowrap");
    expect(attachmentTitleStyle.textOverflow).toBe("ellipsis");
    expectUiTypography(
      await typographySignature(assistantSurface.getByText("PDF", { exact: true })),
      {
        size: 12,
        lineHeight: 16,
        weight: "400",
        color: "rgb(143, 143, 143)",
      },
    );

    const failedAttachment = page.getByTestId("chat-failed-attachment");
    const failedAttachmentStatus = failedAttachment.getByText(
      fixtureFailedAttachmentStatus,
      { exact: true },
    );
    expectUiTypography(await typographySignature(failedAttachmentStatus), {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(166, 64, 43)",
    });
    const failedAttachmentGroup = failedAttachment.getByRole("group", {
      name: fixtureFailedAttachmentName,
    });
    expectHorizontalViewportFit(
      await typographySignature(failedAttachmentGroup),
      viewport.width,
    );
    const failedAttachmentBox = await failedAttachmentGroup
      .locator(":scope > div")
      .first()
      .boundingBox();
    expect(failedAttachmentBox?.height).toBeGreaterThan(60);

    const toolLabel = page.getByTestId("chat-tool-running").locator(".thinking-label");
    const toolLabelStyle = await typographySignature(toolLabel);
    expect(normalizeFontFamily(toolLabelStyle.fontFamily)).toBe(uiFontStack);
    expectPx(toolLabelStyle.fontSize, 16);
    expectPx(toolLabelStyle.lineHeight, 24);
    expect(toolLabelStyle.fontWeight).toBe("400");
    expect(toolLabelStyle.color).toBe("rgba(0, 0, 0, 0)");
    const toolLabelPaint = await toolLabel.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundImage: style.backgroundImage,
        textFillColor: style.getPropertyValue("-webkit-text-fill-color"),
      };
    });
    expect(toolLabelPaint.backgroundImage).toContain("rgb(143, 143, 143)");
    expect(toolLabelPaint.textFillColor).toBe("rgba(0, 0, 0, 0)");
    const failedRunAlert = page.getByTestId("chat-run-failed").getByRole("alert");
    expectUiTypography(await typographySignature(failedRunAlert), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(166, 64, 43)",
    });
    const cancelledRun = page.getByTestId("chat-run-cancelled");
    await expect(cancelledRun.getByRole("alert")).toHaveCount(0);
    await expect(cancelledRun.getByRole("status")).toHaveCount(0);
    expectUiTypography(
      await typographySignature(cancelledRun.locator(".assistant-markdown")),
      {
        size: 16,
        lineHeight: 26,
        weight: "400",
        color: "rgb(13, 13, 13)",
      },
    );

    await assistantSurface.getByRole("button", { name: "查看 2 个来源" }).click();
    const sourcesPanel = page.locator("aside.sources-panel.open");
    await expect(sourcesPanel).toBeVisible();
    await expect
      .poll(async () => (await typographySignature(sourcesPanel)).box.right)
      .toBeLessThanOrEqual(viewport.width + 0.5);
    expectHorizontalViewportFit(await typographySignature(sourcesPanel), viewport.width);
    expectUiTypography(
      await typographySignature(
        sourcesPanel.getByText(fixtureSourceTitle, { exact: true }),
      ),
      {
        size: 14,
        lineHeight: 20,
        weight: "500",
        color: "rgb(13, 13, 13)",
      },
    );
    expectUiTypography(
      await typographySignature(sourcesPanel.getByText("example.com", { exact: true })),
      {
        size: 12,
        lineHeight: 16,
        weight: "400",
        color: "rgb(143, 143, 143)",
      },
    );
    await sourcesPanel.getByRole("button", { name: "关闭来源" }).click();
    await expect(page.locator("aside.sources-panel.open")).toHaveCount(0);

    const viewportState = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootFontSize: getComputedStyle(document.body).fontSize,
      rootLineHeight: getComputedStyle(document.body).lineHeight,
    }));
    expect(viewportState).toEqual({
      clientWidth: viewport.width,
      scrollWidth: viewport.width,
      rootFontSize: "16px",
      rootLineHeight: "24px",
    });

    await testInfo.attach(`chat-core-${width}px-computed`, {
      body: JSON.stringify(
        {
          viewport,
          composer: textareaStyle,
          picker: pickerTriggerStyle,
          userReadonly: userStyle,
          userEditor: editorStyle,
          userExpanded: expandedUserStyle,
          thinkingLabel: await typographySignature(thinkingLabel),
          thinkingBody: thinkingBodyStyle,
          citation: citationChipStyle,
          attachment: attachmentTitleStyle,
          runFailed: await typographySignature(failedRunAlert),
          viewportState,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });

    const screenshotPath = testInfo.outputPath(`chat-core-${width}px.png`);
    await chatCore.screenshot({
      path: screenshotPath,
      animations: "disabled",
      caret: "hide",
    });
    await testInfo.attach(`chat-core-${width}px`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}

const secondaryViewports = [320, 375, 390, 414, 768, 1280] as const;
const secondaryLongConversation =
  "中英文超长会话标题 Typography SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity";
const secondaryName = "中英文 Typography Reviewer With A Long Display Name";
const secondaryEmail =
  "typography-verification-with-a-long-address@example-organization.test";

for (const width of secondaryViewports) {
  test(`keeps Sidebar, UserMenu and BottomSheet typography aligned at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chrome",
      "The explicit secondary-surface viewport matrix runs once from the desktop project.",
    );

    const viewport = {
      width,
      height: width === 1280 ? 800 : width <= 414 ? 844 : 900,
    };
    const isMobile = width <= 760;
    await page.setViewportSize(viewport);
    await page.goto("/tests/visual/typography-system.html?surface=sidebar");

    const fixture = page.getByTestId("secondary-sidebar-fixture");
    await expect(fixture).toBeVisible();
    await expect(fixture).toHaveAttribute("data-mobile", isMobile ? "true" : "false");

    const groupLabel = page.getByText("聊天", { exact: true });
    expectUiTypography(await typographySignature(groupLabel), {
      size: 14,
      lineHeight: 20,
      weight: "500",
      color: "rgb(143, 143, 143)",
    });

    const row = page.locator(".history-row").filter({ hasText: secondaryLongConversation }).first();
    const rowStyle = await typographySignature(row);
    expectUiTypography(rowStyle, {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    expect(rowStyle.box.height).toBeGreaterThanOrEqual(isMobile ? 44 : 36);
    const rowText = await typographySignature(
      page.getByText(secondaryLongConversation, { exact: true }),
    );
    expect(rowText.textOverflow).toBe("ellipsis");
    expect(rowText.scrollWidth).toBeGreaterThan(rowText.clientWidth);

    const newConversation = page.getByRole("button", { name: "新建对话" }).first();
    expectUiTypography(await typographySignature(newConversation), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    const newConversationBox = await newConversation.boundingBox();
    expect(newConversationBox?.height).toBeGreaterThanOrEqual(isMobile ? 44 : 36);

    if (!isMobile) await row.hover();
    await row.getByRole("button", { name: "更多" }).click();
    const conversationActions = isMobile
      ? page.getByRole("dialog", { name: "会话操作" })
      : page.getByRole("menu", { name: "会话操作" });
    await expect(conversationActions).toBeVisible();
    if (isMobile) {
      await conversationActions.evaluate((element) => {
        element.getAnimations().forEach((animation) => animation.finish());
      });
    }
    expectViewportFit(await typographySignature(conversationActions), viewport);
    const shareAction = conversationActions.getByRole(
      isMobile ? "button" : "menuitem",
      { name: "分享" },
    );
    expectUiTypography(await typographySignature(shareAction), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    const shareActionBox = await shareAction.boundingBox();
    expect(shareActionBox?.height).toBeGreaterThanOrEqual(isMobile ? 44 : 36);
    await page.keyboard.press("Escape");
    await expect(conversationActions).toHaveCount(0);

    const personalTrigger = page.getByRole("button", { name: "打开个人中心" });
    const triggerAvatarStyle = await typographySignature(
      personalTrigger.locator("span.rounded-full").first(),
    );
    expect(normalizeFontFamily(triggerAvatarStyle.fontFamily)).toBe(uiFontStack);
    expectPx(triggerAvatarStyle.fontSize, 12);
    expectPx(triggerAvatarStyle.lineHeight, 16);
    expect(triggerAvatarStyle.fontWeight).toBe("600");
    await personalTrigger.click();
    const personalSurface = isMobile
      ? page.getByRole("dialog", { name: "个人中心" })
      : page.getByRole("menu", { name: "个人中心" });
    await expect(personalSurface).toBeVisible();
    if (isMobile) {
      await personalSurface.evaluate((element) => {
        element.getAnimations().forEach((animation) => animation.finish());
      });
    }
    expectViewportFit(await typographySignature(personalSurface), viewport);
    expectUiTypography(
      await typographySignature(personalSurface.getByText(secondaryName, { exact: true })),
      {
        size: 14,
        lineHeight: 20,
        weight: "500",
        color: "rgb(13, 13, 13)",
      },
    );
    expectUiTypography(
      await typographySignature(personalSurface.getByText(secondaryEmail, { exact: true })),
      {
        size: 12,
        lineHeight: 16,
        weight: "400",
        color: "rgb(143, 143, 143)",
      },
    );
    const accountAction = personalSurface.getByRole(
      isMobile ? "button" : "menuitem",
      { name: "账号" },
    );
    expectUiTypography(await typographySignature(accountAction), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });

    await expectDocumentHasNoHorizontalOverflow(page);
    const screenshotPath = testInfo.outputPath(`secondary-navigation-${width}px.png`);
    await page.screenshot({
      path: screenshotPath,
      animations: "disabled",
      caret: "hide",
    });
    await testInfo.attach(`secondary-navigation-${width}px`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });

  test(`keeps form and semantic status text readable at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chrome",
      "The explicit secondary-surface viewport matrix runs once from the desktop project.",
    );

    const viewport = {
      width,
      height: width === 1280 ? 800 : width <= 414 ? 844 : 900,
    };
    await page.setViewportSize(viewport);
    await page.goto("/tests/visual/typography-system.html?surface=states");

    const fixture = page.getByTestId("secondary-states-fixture");
    await expect(fixture).toBeVisible();
    const bannerCopy = page.getByText("Verify your email to keep your account secure.", {
      exact: true,
    });
    await expect(bannerCopy).toBeVisible();
    expectUiTypography(await typographySignature(bannerCopy.locator("xpath=..")), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(93, 93, 93)",
    });
    expectUiTypography(await typographySignature(page.getByText(secondaryEmail, { exact: true })), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(143, 143, 143)",
    });
    expectUiTypography(
      await typographySignature(
        page.getByRole("button", { name: "Send verification email" }),
      ),
      {
        size: 14,
        lineHeight: 20,
        weight: "500",
        color: "rgb(13, 13, 13)",
      },
    );

    expectUiTypography(
      await typographySignature(page.getByRole("heading", { name: "表单与状态文字" })),
      {
        size: 18,
        lineHeight: 28,
        weight: "400",
        color: "rgb(13, 13, 13)",
      },
    );
    expectUiTypography(
      await typographySignature(page.getByText("中英文表单标签", { exact: true })),
      {
        size: 14,
        lineHeight: 20,
        weight: "400",
        color: "rgb(13, 13, 13)",
      },
    );

    const placeholderInput = page.getByPlaceholder(
      "Placeholder 中文 English 需要保持 tertiary 语义",
    );
    expectUiTypography(await typographySignature(placeholderInput), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    });
    const placeholderStyle = await placeholderInput.evaluate((element) => {
      const style = getComputedStyle(element, "::placeholder");
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        color: style.color,
        opacity: style.opacity,
      };
    });
    expect(normalizeFontFamily(placeholderStyle.fontFamily)).toBe(uiFontStack);
    expectPx(placeholderStyle.fontSize, 14);
    expect(placeholderStyle.fontWeight).toBe("400");
    expect(placeholderStyle.color).toBe("rgb(143, 143, 143)");
    expect(placeholderStyle.opacity).toBe("1");

    const disabledInput = page.getByLabel("Disabled control");
    expectUiTypography(await typographySignature(disabledInput), {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(180, 180, 180)",
    });

    const errorStatus = page.getByRole("alert");
    expectUiTypography(await typographySignature(errorStatus), {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(166, 64, 43)",
    });
    const warningStatus = page
      .getByText("Warning：附件仍在解析，完成前请勿关闭页面。", { exact: true })
      .locator("xpath=..");
    expectUiTypography(await typographySignature(warningStatus), {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(128, 91, 18)",
    });
    const successStatus = page
      .getByText("Success：更改已保存。", { exact: true })
      .locator("xpath=..");
    expectUiTypography(await typographySignature(successStatus), {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(57, 115, 74)",
    });

    const toast = page.locator(".toast");
    await expect(toast).toBeVisible();
    const toastStyle = await typographySignature(toast);
    expectUiTypography(toastStyle, {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(128, 91, 18)",
    });
    expectHorizontalViewportFit(toastStyle, viewport.width);
    expect(toastStyle.scrollWidth).toBeLessThanOrEqual(toastStyle.clientWidth + 1);

    await expectDocumentHasNoHorizontalOverflow(page);
    const screenshotPath = testInfo.outputPath(`secondary-states-${width}px.png`);
    await page.screenshot({
      path: screenshotPath,
      animations: "disabled",
      caret: "hide",
    });
    await testInfo.attach(`secondary-states-${width}px`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}

test("covers secondary dialogs, account, auth and lifecycle surfaces", async ({
  page,
}, testInfo) => {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  const expectSurfaceFits = async (surface: Locator) => {
    const signature = await typographySignature(surface);
    expectHorizontalViewportFit(signature, viewport?.width ?? 0);
    expect(signature.scrollWidth).toBeLessThanOrEqual(signature.clientWidth + 1);
  };
  const capture = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled", caret: "hide" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };

  await page.goto("/tests/visual/typography-system.html?surface=auth");
  const authBrand = page.locator("main .auth-brand-title").first();
  await expect(authBrand).toHaveText("iChat");
  const authBrandStyle = await typographySignature(authBrand);
  expect(normalizeFontFamily(authBrandStyle.fontFamily)).toBe(computedBrandFontStack);
  expectPx(authBrandStyle.fontSize, 22);
  expectPx(authBrandStyle.lineHeight, 35.2);
  expect(authBrandStyle.fontWeight).toBe("600");
  expectUiTypography(
    await typographySignature(page.getByText("用户名或邮箱", { exact: true })),
    {
      size: 14,
      lineHeight: 20,
      weight: "400",
      color: "rgb(13, 13, 13)",
    },
  );
  await page.getByRole("tab", { name: "注册" }).click();
  const nicknameInput = page.getByPlaceholder("默认与用户名相同");
  expectUiTypography(await typographySignature(nicknameInput), {
    size: 14,
    lineHeight: 20,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  const nicknamePlaceholder = await nicknameInput.evaluate((element) => {
    const style = getComputedStyle(element, "::placeholder");
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: style.fontWeight,
      color: style.color,
      opacity: style.opacity,
    };
  });
  expect(normalizeFontFamily(nicknamePlaceholder.fontFamily)).toBe(uiFontStack);
  expectPx(nicknamePlaceholder.fontSize, 14);
  expect(nicknamePlaceholder.fontWeight).toBe("400");
  expect(nicknamePlaceholder.color).toBe("rgb(143, 143, 143)");
  expect(nicknamePlaceholder.opacity).toBe("1");
  await page.locator('button[type="submit"]').click();
  expectUiTypography(
    await typographySignature(page.getByText("请输入 1–50 个字符的用户名", { exact: true })),
    {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(166, 64, 43)",
    },
  );
  await expectSurfaceFits(page.locator("main section").first());
  await expectDocumentHasNoHorizontalOverflow(page);
  await capture("secondary-auth");

  await page.goto("/tests/visual/typography-system.html?surface=account");
  const accountDialog = page.getByRole("dialog", { name: "账号" });
  await expect(accountDialog).toBeVisible();
  expectUiTypography(
    await typographySignature(accountDialog.getByRole("heading", { name: "账号" })),
    {
      size: 18,
      lineHeight: 28,
      weight: "400",
      color: "rgb(13, 13, 13)",
    },
  );
  expectUiTypography(
    await typographySignature(accountDialog.getByText("管理公开资料、邮箱与账号安全。")),
    {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(143, 143, 143)",
    },
  );
  const accountAvatarStyle = await typographySignature(
    accountDialog.getByRole("button", { name: "选择头像" }).locator("span.rounded-full"),
  );
  expect(normalizeFontFamily(accountAvatarStyle.fontFamily)).toBe(uiFontStack);
  expectPx(accountAvatarStyle.fontSize, 16.875);
  expectPx(accountAvatarStyle.lineHeight, 26.25);
  expect(accountAvatarStyle.fontWeight).toBe("600");
  const disabledSave = accountDialog.getByRole("button", { name: "保存" });
  await expect(disabledSave).toBeDisabled();
  expectUiTypography(await typographySignature(disabledSave), {
    size: 14,
    lineHeight: 20,
    weight: "500",
    color: "rgb(180, 180, 180)",
  });
  await accountDialog.getByRole("button", { name: "修改密码" }).click();
  expectUiTypography(
    await typographySignature(accountDialog.getByRole("heading", { name: "修改密码" })),
    {
      size: 18,
      lineHeight: 28,
      weight: "400",
      color: "rgb(13, 13, 13)",
    },
  );
  const newPassword = accountDialog.getByPlaceholder("新密码（8–128 位）");
  expectUiTypography(await typographySignature(newPassword), {
    size: 14,
    lineHeight: 20,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  await expectSurfaceFits(accountDialog);
  await expectDocumentHasNoHorizontalOverflow(page);
  await capture("secondary-account");

  await page.goto("/tests/visual/typography-system.html?surface=share-dialog");
  const shareDialog = page.getByRole("dialog", { name: "分享对话" });
  await expect(shareDialog).toBeVisible();
  expectUiTypography(
    await typographySignature(shareDialog.getByRole("heading", { name: "分享对话" })),
    {
      size: 18,
      lineHeight: 28,
      weight: "400",
      color: "rgb(13, 13, 13)",
    },
  );
  expectUiTypography(
    await typographySignature(
      shareDialog.getByText(/创建一个只读链接，任何人都可查看此刻的会话快照/),
    ),
    {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(143, 143, 143)",
    },
  );
  const attachmentWarning = shareDialog.getByText("本对话中的附件将对访问者可见");
  expectUiTypography(await typographySignature(attachmentWarning), {
    size: 12,
    lineHeight: 16,
    weight: "400",
    color: "rgb(128, 91, 18)",
  });
  const createShare = await shareDialog.getByRole("button", { name: "创建链接" });
  expectUiTypography(await typographySignature(createShare), {
    size: 14,
    lineHeight: 20,
    weight: "500",
    color: "rgb(251, 251, 250)",
  });
  await expectSurfaceFits(shareDialog);
  await expectDocumentHasNoHorizontalOverflow(page);
  await capture("secondary-share-dialog");

  await page.goto("/tests/visual/typography-system.html?surface=confirm");
  const confirmDialog = page.getByRole("alertdialog", {
    name: "确认这项 Typography 操作",
  });
  await expect(confirmDialog).toBeVisible();
  expectUiTypography(
    await typographySignature(
      confirmDialog.getByRole("heading", { name: "确认这项 Typography 操作" }),
    ),
    {
      size: 18,
      lineHeight: 28,
      weight: "400",
      color: "rgb(13, 13, 13)",
    },
  );
  const confirmBody = confirmDialog.getByText(/Supercalifragilisticexpialidocious/);
  const confirmBodyStyle = await typographySignature(confirmBody);
  expectUiTypography(confirmBodyStyle, {
    size: 12,
    lineHeight: 16,
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expect(confirmBodyStyle.scrollWidth).toBeLessThanOrEqual(confirmBodyStyle.clientWidth + 1);
  await expectSurfaceFits(confirmDialog);
  await expectDocumentHasNoHorizontalOverflow(page);

  await page.goto("/tests/visual/typography-system.html?surface=shares");
  const sharesDialog = page.getByRole("dialog", { name: "我的分享" });
  await expect(sharesDialog).toBeVisible();
  const shareTitle = await page.getByText(
    "中英文分享标题 Typography SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
    { exact: true },
  );
  const shareTitleStyle = await typographySignature(shareTitle);
  expectUiTypography(shareTitleStyle, {
    size: 14,
    lineHeight: 20,
    weight: "500",
    color: "rgb(13, 13, 13)",
  });
  expect(shareTitleStyle.textOverflow).toBe("ellipsis");
  expect(shareTitleStyle.scrollWidth).toBeGreaterThan(shareTitleStyle.clientWidth);
  expectUiTypography(
    await typographySignature(sharesDialog.getByText(/到期/)),
    {
      size: 12,
      lineHeight: 16,
      weight: "400",
      color: "rgb(143, 143, 143)",
    },
  );
  await expectSurfaceFits(sharesDialog);
  await expectDocumentHasNoHorizontalOverflow(page);

  await page.goto("/tests/visual/typography-system.html?surface=cropper");
  const cropDialog = page.getByRole("dialog", { name: "裁剪头像" });
  await expect(cropDialog).toBeVisible();
  expectUiTypography(
    await typographySignature(cropDialog.getByRole("heading", { name: "裁剪头像" })),
    {
      size: 18,
      lineHeight: 28,
      weight: "400",
      color: "rgb(13, 13, 13)",
    },
  );
  expectUiTypography(await typographySignature(cropDialog.getByText("缩放", { exact: true })), {
    size: 14,
    lineHeight: 20,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(
    await typographySignature(cropDialog.getByRole("button", { name: "确认并上传" })),
    {
      size: 14,
      lineHeight: 20,
      weight: "500",
      color: "rgb(251, 251, 250)",
    },
  );
  await expectSurfaceFits(cropDialog);
  await expectDocumentHasNoHorizontalOverflow(page);
  await capture("secondary-cropper");

  await page.goto("/tests/visual/typography-system.html?surface=lifecycle");
  const lifecycleTitle = page.getByRole("heading", { name: "设置新密码" });
  await expect(lifecycleTitle).toBeVisible();
  expectUiTypography(await typographySignature(lifecycleTitle), {
    size: 18,
    lineHeight: 28,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expectUiTypography(await typographySignature(page.getByText("新密码", { exact: true })), {
    size: 14,
    lineHeight: 20,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  const lifecycleBrand = page.locator(".wordmark");
  const lifecycleBrandStyle = await typographySignature(lifecycleBrand);
  expect(normalizeFontFamily(lifecycleBrandStyle.fontFamily)).toBe(computedBrandFontStack);
  expectPx(lifecycleBrandStyle.fontSize, 18);
  expectPx(lifecycleBrandStyle.lineHeight, 28.8);
  await expectDocumentHasNoHorizontalOverflow(page);

  await page.goto("/tests/visual/typography-system.html?surface=share-page");
  const publicShareTitle = page.getByRole("heading", {
    name:
      "公开分享标题 中文 English SupercalifragilisticexpialidociousWithoutAnySoftBreakOpportunity",
  });
  await expect(publicShareTitle).toBeVisible();
  const publicShareTitleStyle = await typographySignature(publicShareTitle);
  expectUiTypography(publicShareTitleStyle, {
    size: 18,
    lineHeight: 28,
    weight: "400",
    color: "rgb(13, 13, 13)",
  });
  expect(publicShareTitleStyle.scrollWidth).toBeLessThanOrEqual(
    publicShareTitleStyle.clientWidth + 1,
  );
  expectUiTypography(await typographySignature(page.getByText("只读分享", { exact: true })), {
    size: 12,
    lineHeight: 16,
    weight: "400",
    color: "rgb(143, 143, 143)",
  });
  expectUiTypography(
    await typographySignature(page.getByRole("link", { name: "登录 iChat" })),
    {
      size: 14,
      lineHeight: 20,
      weight: "500",
      color: "rgb(13, 13, 13)",
    },
  );
  await expectDocumentHasNoHorizontalOverflow(page);
  await capture("secondary-share-page");
});
