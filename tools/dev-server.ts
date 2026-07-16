/**
 * Test/dev server — serves the repo with on-the-fly TypeScript type
 * stripping (node:module stripTypeScriptTypes), so the browser can import
 * `src/*.ts` modules directly. Dev harness only; not part of the runtime.
 *
 * Usage: node tools/dev-server.ts [port]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const root = normalize(join(fileURLToPath(import.meta.url), "..", ".."));
const port = Number(process.argv[2] ?? 8787);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root + sep) && path !== root) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const ext = path.slice(path.lastIndexOf("."));
    let body = await readFile(path, "utf8");
    if (ext === ".ts") {
      body = stripTypeScriptTypes(body, { mode: "strip" });
    }
    res.writeHead(200, { "content-type": contentTypes[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`vivarium dev server: http://localhost:${port}/ (root: ${root})`);
});
