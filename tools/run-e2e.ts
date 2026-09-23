/**
 * Runs the real-browser e2e harnesses and exits non-zero if any assertion
 * fails. The harnesses already judge themselves and leave the verdict on
 * `window.__E2E__`; this is the driver that opens them and reads it, so the
 * same run happens by hand and in CI.
 *
 *   test/e2e.html        sandbox core            (served — imports src/*.ts)
 *   test/e2e-react.html  react-tsx profile       (served — needs test/assets)
 *   test/e2e-file.html   classic build, file://  (opened from disk — needs dist)
 *
 * The browser is whichever Chrome, Edge, or Chromium is installed:
 * playwright-core downloads nothing.
 *
 * Usage: npm run build && node tools/build-profile-assets.ts && node tools/run-e2e.ts
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const PAGE_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;

const PREREQUISITES = [
  { path: "dist/vivarium.iife.js", fix: "npm run build" },
  { path: "test/assets/react-runtime.js", fix: "node tools/build-profile-assets.ts" },
];
const missing = PREREQUISITES.filter((p) => !existsSync(join(root, p.path)));
if (missing.length > 0) {
  for (const m of missing) console.error(`run-e2e: ${m.path} is missing — run \`${m.fix}\` first`);
  process.exit(2);
}

/** A port nothing holds right now, so a leftover dev server is never the one judged. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", () => ok()));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("could not allocate a port");
  return address.port;
}

async function waitUntilAnswering(url: string, server: ChildProcess) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dev server exited before answering (code ${server.exitCode})`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`dev server did not answer ${url} within ${READY_TIMEOUT_MS / 1000}s`);
}

async function launch(): Promise<Browser> {
  const failures: string[] = [];
  for (const channel of ["chrome", "msedge", "chromium"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      failures.push(`${channel}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error("no browser to drive — install Chrome, Edge, or Chromium.\n" + failures.map((f) => `  ${f}`).join("\n"));
}

interface E2EResult { name: string; ok: boolean; detail: string | null }

/**
 * Open one harness and read its verdict.
 *
 * Uncaught page errors are printed but not counted. These harnesses throw on
 * purpose inside the sandbox — a listener that explodes, a timer that throws a
 * string, a late error after mount — to check that each fault reaches the host;
 * whether it did is an assertion of the harness's own. A harness that itself
 * breaks records that as a failed assertion (`harness error`), so nothing a
 * page throws goes unjudged.
 */
async function judge(browser: Browser, label: string, url: string): Promise<number> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  try {
    await page.goto(url);
    await page.waitForFunction(() => (window as any).__E2E__?.done === true, null, { timeout: PAGE_TIMEOUT_MS });
    const { results } = (await page.evaluate(() => (window as any).__E2E__)) as { results: E2EResult[] };
    console.log(`\n# ${label}`);
    for (const r of results) console.log(`${r.ok ? "ok" : "not ok"} - ${r.name}${r.ok || r.detail === null ? "" : ` — ${r.detail}`}`);
    for (const e of pageErrors) console.log(`# page error (judged by the harness, not counted here): ${e}`);
    const failedAssertions = results.filter((r) => !r.ok).length;
    console.log(`# ${label}: ${results.length - failedAssertions}/${results.length} passed`);
    return failedAssertions;
  } finally {
    await page.close();
  }
}

const port = await freePort();
const server = spawn(process.execPath, [join(root, "tools", "dev-server.ts"), String(port)], { cwd: root, stdio: "ignore" });
const stopServer = () => {
  if (server.exitCode !== null || server.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
  else server.kill();
};

let failed = 0;
let browser: Browser | null = null;
try {
  const base = `http://localhost:${port}`;
  await waitUntilAnswering(`${base}/test/e2e.html`, server);
  browser = await launch();
  failed += await judge(browser, "e2e.html (sandbox core)", `${base}/test/e2e.html`);
  failed += await judge(browser, "e2e-react.html (react-tsx profile)", `${base}/test/e2e-react.html`);
  failed += await judge(browser, "e2e-file.html (classic build, file://)", pathToFileURL(join(root, "test", "e2e-file.html")).href);
} catch (error) {
  console.error(`\nrun-e2e: ${(error as Error).message}`);
  failed = Math.max(failed, 1);
} finally {
  await browser?.close();
  stopServer();
}

console.log(`\nrun-e2e: ${failed === 0 ? "all harnesses passed" : `${failed} failure(s)`}`);
process.exit(failed === 0 ? 0 : 1);
