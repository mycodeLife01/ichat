import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dirname, "..");
const sourceCommit = "7d01cfa6b542f98ee67d8a54a437748a60f4c190";
const code = ts.transpileModule(
  await readFile(resolve(root, "src/scenarios/registry.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText;
const { scenes } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const parity = await readFile(
  resolve(root, "tests/parity/pages.spec.ts"),
  "utf8",
);
const parityIds = JSON.parse(
  parity.match(/const ids = (\[[\s\S]*?\]);/)[1].replace(/,\s*]/g, "]"),
);
const hashes = {};
async function walk(dir) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) await walk(path);
    else
      hashes[relative(root, path)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
}
await walk(resolve(root, "src"));
await walk(resolve(root, "public"));
for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "index.html",
  "canvas.html",
])
  hashes[file] = createHash("sha256")
    .update(await readFile(resolve(root, file)))
    .digest("hex");
const fingerprint = createHash("sha256")
  .update(JSON.stringify(hashes))
  .digest("hex");
await writeFile(
  resolve(root, "catalog/baseline.json"),
  JSON.stringify(
    {
      sourceCommit,
      designCommit: null,
      designFingerprint: fingerprint,
      designStatus: "awaiting-user-review",
      hashes,
    },
    null,
    2,
  ) + "\n",
);
const coverage = scenes.map((s) => ({
  id: s.id,
  name: s.name,
  group: s.group,
  sourceCommit,
  source: `frontend/src/${s.source}`,
  design:
    s.source === "app/AppShell.tsx"
      ? "src/canvas/ChatPage.tsx"
      : `src/${s.source}`,
  scene: s.id,
  route: s.route,
  entry: `/canvas.html?scene=${s.id}&proposal=current`,
  viewports: ["1440x900", "390x844"],
  initial: s.initial ?? "default",
  outcome: s.outcome ?? "success",
  simulation: s.note,
  implementation: "available",
  checks: {
    render: "tests/visual/scenes.spec.ts",
    paired: parityIds.includes(s.id) ? "tests/parity/pages.spec.ts" : null,
  },
  evidence: [
    "output/visual-report.json",
    ...(parityIds.includes(s.id) ? ["output/parity-report.json"] : []),
  ],
}));
await writeFile(
  resolve(root, "catalog/coverage.json"),
  JSON.stringify(
    {
      scope:
        "页面场景映射；render 不代表该页面所有交互都已配对。连续操作见 tests/visual，真实平台限制见 references/README.md。",
      scenes: coverage,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Recorded ${scenes.length} scenes; Design fingerprint ${fingerprint}`,
);
