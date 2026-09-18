/**
 * Check the classic build against the package root it is built from.
 *
 * Two claims, both of which a consumer relies on without being able to see:
 * the file runs as a classic script (no `import`/`export` left, no module
 * syntax — it is parsed as a Script, not a Module), and the global it assigns
 * carries exactly the root entry's runtime exports — no more (nothing leaks
 * from /internal), no fewer (a value added to the root reaches both builds).
 *
 * Runs after `npm run build`. Usage: node tools/verify-iife.ts
 */

import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script, createContext } from "node:vm";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const source = await readFile(join(root, "dist", "vivarium.iife.js"), "utf8");

// Parsing as a Script is the check: `import`/`export` would be a SyntaxError.
const script = new Script(source, { filename: "vivarium.iife.js" });
const context = createContext({});
script.runInContext(context);
const global = (context as { Vivarium?: Record<string, unknown> }).Vivarium;
if (!global || typeof global !== "object") {
  console.error("FAIL iife — the script did not assign a global `Vivarium`");
  process.exit(1);
}

const esm = await import(pathToFileURL(join(root, "dist", "index.js")).href);
const want = Object.keys(esm).sort();
const got = Object.keys(global).sort();
const missing = want.filter((k) => !got.includes(k));
const extra = got.filter((k) => !want.includes(k));
if (missing.length || extra.length) {
  console.error(`FAIL iife — global differs from the package root: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`);
  process.exit(1);
}
console.log(`PASS iife — classic script, global Vivarium carries the root's ${want.length} exports`);
