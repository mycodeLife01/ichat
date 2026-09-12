import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
const root = resolve(import.meta.dirname, "..");
const errors = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      errors.push(`Symlink in source: ${path}`);
      continue;
    }
    if (entry.isDirectory()) await walk(path);
    else if (/\.(tsx?|css)$/.test(path)) {
      const text = await readFile(path, "utf8");
      for (const match of text.matchAll(
        /(?:from\s*|import\s*\(|import\s*|@import\s*)["']([^"']+)["']/g,
      )) {
        const target = match[1];
        if (
          target.includes("frontend") ||
          target.includes("/api/client") ||
          target.includes("tokenStore")
        )
          errors.push(`${relative(root, path)} imports ${target}`);
        if (target.startsWith(".")) {
          const absolute = resolve(dirname(path), target);
          if (!absolute.startsWith(root + "/"))
            errors.push(`Import escapes Design: ${path}`);
        }
      }
      if (/\b(?:fetch|XMLHttpRequest|EventSource|WebSocket)\s*\(/.test(text))
        errors.push(`Network transport in ${path}`);
      if (
        /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(["']ichat\./.test(
          text,
        )
      )
        errors.push(`Production storage in ${path}`);
    }
  }
}
await walk(resolve(root, "src"));
if ((await realpath(resolve(root, "src"))) !== resolve(root, "src"))
  errors.push("Source root is a symlink");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Design source isolation: passed");
