/**
 * Build browser ESM assets for the react-tsx reference profile (ADR-0004).
 * Dev harness only — the runtime core has no dependency on any of this.
 *
 * Outputs (test/assets/, gitignored):
 * - react-runtime.js  react + react-dom/client in one ESM bundle (single
 *                     react instance; exposed via wrapper modules in the
 *                     profile import map)
 * - sucrase.js        in-browser TSX→JS transformer (host-side transform)
 *
 * Usage: node tools/build-profile-assets.ts
 */

import { mkdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const outDir = join(root, "test", "assets");
await mkdir(outDir, { recursive: true });

const common = {
  bundle: true,
  format: "esm" as const,
  platform: "browser" as const,
  minify: true,
  logLevel: "warning" as const,
  define: { "process.env.NODE_ENV": '"production"' },
};

// react/react-dom ship as CJS. Bundling them separately with `react` marked
// external breaks (ESM output cannot service a CJS require), and duplicate
// react instances break hooks — so both go into ONE bundle (single
// instance), and the profile exposes `react` / `react-dom/client` as thin
// re-export wrapper modules over it (see test/react-tsx-profile.js).
const RUNTIME_BUNDLE = `
import pkg from "react";
import client from "react-dom/client";
export const React = pkg;
export const ReactDOMClient = client;
`;

await build({
  ...common,
  stdin: { contents: RUNTIME_BUNDLE, resolveDir: root },
  outfile: join(outDir, "react-runtime.js"),
});

await build({
  ...common,
  stdin: { contents: 'export { transform } from "sucrase";', resolveDir: root },
  outfile: join(outDir, "sucrase.js"),
});

console.log(`profile assets built in ${outDir}`);
