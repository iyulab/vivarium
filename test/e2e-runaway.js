/**
 * Real-browser e2e: what a runaway generated module does to the host.
 *
 * The sandbox isolates by origin (`sandbox="allow-scripts"`, opaque origin),
 * which is a security boundary — not a scheduling one. Whether a guest that
 * never yields also stalls the host page depends on whether the engine runs
 * the sandboxed frame in its own process, and that differs between engines.
 * This harness measures it instead of assuming it: the guest runs a bounded
 * busy loop after mounting, and the host counts its own timer ticks meanwhile.
 *
 * The loop is bounded (BUSY_MS) so an engine that shares the thread comes
 * back rather than hanging the run.
 *
 * Results land in window.__E2E__ like the other harnesses; an assertion may
 * carry `todo` — a known gap with no fix yet, reported but not counted.
 */
import { mountSandbox } from "../src/sandbox/host.ts";
import { CapabilityRegistry } from "../src/bridge/capabilities.ts";

const BUSY_MS = 3000;
const TICK_MS = 50;
/** A host that keeps running sees gaps near TICK_MS; one that stalls sees ~BUSY_MS. */
const STALL_MS = 1000;

const results = [];
const observations = {};

function record(name, ok, detail, todo) {
  results.push({ name, ok, detail: detail === undefined ? null : String(detail), todo: todo ?? null });
  const li = document.createElement("li");
  li.className = ok ? "pass" : "fail";
  li.textContent = `${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}${todo ? ` (TODO: ${todo})` : ""}`;
  document.getElementById("results").append(li);
}

async function main() {
  const stage = document.getElementById("stage");
  const registry = new CapabilityRegistry();
  let started = null;
  registry.grant({ name: "busy.started", description: "the guest is about to spin (e2e)" }, () => {
    started = performance.now();
    return null;
  });

  const handle = mountSandbox(stage, { registry, context: {} });
  await handle.whenReady();
  await handle.render(`
    export default function mount(root, api) {
      setTimeout(async () => {
        await api.invoke("busy.started", {});
        const end = performance.now() + ${BUSY_MS};
        while (performance.now() < end) {}
      }, 100);
    }
  `);

  const ticks = [];
  const timer = setInterval(() => ticks.push(performance.now()), TICK_MS);
  await new Promise((r) => setTimeout(r, 200 + BUSY_MS + 1000));
  clearInterval(timer);

  let maxGap = 0;
  for (let i = 1; i < ticks.length; i++) maxGap = Math.max(maxGap, ticks[i] - ticks[i - 1]);
  const expected = Math.floor((200 + BUSY_MS + 1000) / TICK_MS);
  Object.assign(observations, {
    userAgent: navigator.userAgent,
    busyMs: BUSY_MS,
    ticks: ticks.length,
    expectedTicks: expected,
    maxGapMs: Math.round(maxGap),
    guestStarted: started !== null,
  });

  record("the guest's busy loop actually ran", started !== null);
  record(
    `the host keeps running while the guest spins (max timer gap < ${STALL_MS}ms)`,
    maxGap < STALL_MS,
    `max gap ${Math.round(maxGap)}ms, ${ticks.length}/${expected} ticks`,
    // The driver passes ?todo=<reason> for an engine known to run the
    // sandboxed frame on the host's thread: there the stall is the measured,
    // unmitigated behaviour — reported, not counted. Elsewhere it is a regression.
    new URLSearchParams(location.search).get("todo") ?? undefined,
  );

  // The guest has yielded again; the bridge must still answer.
  const answered = await handle.requestUnmount().then(() => true, (err) => String(err && err.message || err));
  record("the guest answers the host again once it has stopped spinning", answered === true, answered === true ? undefined : answered);
  handle.destroy();
}

main()
  .catch((err) => record("harness error", false, err && err.stack || err))
  .finally(() => {
    const failed = results.filter((r) => !r.ok && !r.todo).length;
    document.getElementById("status").textContent = failed === 0 ? "ALL PASS" : `${failed} FAILED`;
    window.__E2E__ = { done: true, passed: results.length - failed, failed, results, observations };
  });
