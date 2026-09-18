/**
 * Build the single-file classic build: dist/vivarium.iife.js.
 *
 * A page opened from `file://` has an opaque origin, and module scripts are
 * fetched with CORS — so `<script type="module">` never loads there, import
 * map or not. A classic `<script src>` does. This file is the package root
 * (src/index.ts — the public contract, nothing from /internal) bundled into
 * one script that assigns the global `Vivarium`.
 *
 * Not minified: the guest bootstrap is injected into the sandbox by
 * serializing functions (`createIdentityRuntime.toString()`), and those
 * functions must stay self-contained — a minifier that hoists a helper out
 * of one would break the sandbox at runtime, not at build time.
 *
 * Usage: node tools/build-iife.ts   (part of `npm run build`)
 */

import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "dist", "vivarium.iife.js"),
  bundle: true,
  format: "iife",
  globalName: "Vivarium",
  platform: "browser",
  target: "es2022",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});
