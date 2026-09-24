/**
 * Runs the real-browser e2e harnesses and exits non-zero if any assertion
 * fails. The harnesses already judge themselves and leave the verdict on
 * `window.__E2E__`; this is the driver that opens them and reads it, so the
 * same run happens by hand and in CI.
 *
 *   test/e2e.html        sandbox core            (served — imports src/*.ts)
 *   test/e2e-react.html  react-tsx profile       (served — needs test/assets)
 *   test/e2e-file.html   classic build, file://  (opened from disk — needs dist)
 *   test/e2e-runaway.html  a guest that never yields: does the host stall?
 *
 * Every harness runs in two engines, because the sandbox's isolation is the
 * engine's: Chromium (whichever Chrome, Edge, or Chromium is installed) and
 * Firefox (an installed Firefox, driven over WebDriver BiDi — `FIREFOX_PATH`
 * points at one elsewhere). playwright-core downloads nothing. A missing
 * Firefox is reported and skipped; `--require-firefox` makes it a failure, so
 * CI cannot turn green by quietly running one engine.
 *
 * Firefox runs a sandboxed srcdoc frame on the host page's thread, so a guest
 * that spins stalls the host there — and the watchdog with it. That is
 * measured, not assumed, and reported as a known gap (TODO) on Firefox only;
 * on Chromium the same assertions are regressions.
 *
 * Usage: npm run build && node tools/build-profile-assets.ts && node tools/run-e2e.ts [--require-firefox]
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, type Browser } from "playwright-core";

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

async function launchChromium(): Promise<Browser> {
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

/** An installed Firefox over WebDriver BiDi, or the reasons none could be launched. */
async function launchFirefox(): Promise<Browser | string[]> {
  const failures: string[] = [];
  const candidates: Array<{ label: string; executablePath?: string }> = [];
  if (process.env.FIREFOX_PATH) candidates.push({ label: `FIREFOX_PATH`, executablePath: process.env.FIREFOX_PATH });
  candidates.push({ label: "moz-firefox (default install location)" });
  if (process.platform === "linux") candidates.push({ label: "/usr/bin/firefox", executablePath: "/usr/bin/firefox" });
  for (const c of candidates) {
    try {
      return await firefox.launch({ channel: "moz-firefox", executablePath: c.executablePath, headless: true });
    } catch (e) {
      failures.push(`${c.label}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return failures;
}

interface E2EResult { name: string; ok: boolean; detail: string | null; todo?: string | null }

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
    for (const r of results) {
      const detail = r.detail === null || (r.ok && !r.todo) ? "" : ` — ${r.detail}`;
      const todo = r.todo ? ` # TODO ${r.todo}${r.ok ? " (passing now — the marker can go)" : ""}` : "";
      console.log(`${r.ok ? "ok" : "not ok"} - ${r.name}${detail}${todo}`);
    }
    for (const e of pageErrors) console.log(`# page error (judged by the harness, not counted here): ${e}`);
    // A failing assertion marked TODO is a known gap: reported, not counted.
    const failedAssertions = results.filter((r) => !r.ok && !r.todo).length;
    const known = results.filter((r) => !r.ok && r.todo).length;
    console.log(`# ${label}: ${results.length - failedAssertions - known}/${results.length} passed${known ? `, ${known} known gap(s)` : ""}`);
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

const requireFirefox = process.argv.includes("--require-firefox");
const FIREFOX_STALL = "Firefox runs the sandboxed frame on the host's thread, so while the guest spins neither the host nor its watchdog can run";

let failed = 0;
const browsers: Browser[] = [];
try {
  const base = `http://localhost:${port}`;
  await waitUntilAnswering(`${base}/test/e2e.html`, server);
  const fileUrl = pathToFileURL(join(root, "test", "e2e-file.html")).href;
  const harnesses = (engine: string, runawayTodo?: string): Array<[string, string]> => [
    [`${engine} · e2e.html (sandbox core)`, `${base}/test/e2e.html`],
    [`${engine} · e2e-react.html (react-tsx profile)`, `${base}/test/e2e-react.html`],
    [`${engine} · e2e-file.html (classic build, file://)`, fileUrl],
    [
      `${engine} · e2e-runaway.html (a guest that never yields)`,
      `${base}/test/e2e-runaway.html${runawayTodo ? `?todo=${encodeURIComponent(runawayTodo)}` : ""}`,
    ],
  ];

  const chrome = await launchChromium();
  browsers.push(chrome);
  for (const [label, url] of harnesses("chromium")) failed += await judge(chrome, label, url);

  const ff = await launchFirefox();
  if (Array.isArray(ff)) {
    const reason = "no Firefox to drive — install Firefox or set FIREFOX_PATH\n" + ff.map((f) => `  ${f}`).join("\n");
    if (requireFirefox) throw new Error(reason);
    console.log(`\n# firefox: skipped — ${reason}`);
  } else {
    browsers.push(ff);
    for (const [label, url] of harnesses("firefox", FIREFOX_STALL)) failed += await judge(ff, label, url);
  }
} catch (error) {
  console.error(`\nrun-e2e: ${(error as Error).message}`);
  failed = Math.max(failed, 1);
} finally {
  for (const b of browsers) await b.close();
  stopServer();
}

console.log(`\nrun-e2e: ${failed === 0 ? "all harnesses passed" : `${failed} failure(s)`}`);
process.exit(failed === 0 ? 0 : 1);
