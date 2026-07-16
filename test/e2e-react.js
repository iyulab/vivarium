/**
 * Real-browser e2e for the react-tsx reference profile (ADR-0003/0004):
 * real React rendering TSX-authored generated code inside the closed
 * sandbox, with capability round trips and stable ids.
 *
 * Requires built assets: node tools/build-profile-assets.ts
 */
import { mountSandbox } from "../src/sandbox/host.ts";
import { CapabilityRegistry } from "../src/bridge/capabilities.ts";
import { loadReactTsxProfile } from "./react-tsx-profile.js";

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? null : String(detail) });
  const li = document.createElement("li");
  li.className = ok ? "pass" : "fail";
  li.textContent = `${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`;
  document.getElementById("results").append(li);
}

async function main() {
  const stage = document.getElementById("stage");
  const events = [];

  const registry = new CapabilityRegistry();
  registry.grant({ name: "events.emit", description: "emit a UI event to the host" }, (params) => {
    events.push(params);
    return null;
  });

  const profile = await loadReactTsxProfile();
  const handle = mountSandbox(stage, {
    registry,
    context: { title: "할 일" },
    profile,
  });

  const generatedTsx = `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";

    function Counter({ api }: { api: any }) {
      const [count, setCount] = useState(0);
      return (
        <section data-viv-id="counter">
          <h2>{api.context.title}: {count}</h2>
          <button
            onClick={() => {
              setCount(count + 1);
              api.invoke("events.emit", { type: "increment", next: count + 1 });
            }}
          >
            increment
          </button>
        </section>
      );
    }

    export default async function mount(root: HTMLElement, api: any) {
      createRoot(root).render(<Counter api={api} />);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  `;

  const startedAt = performance.now();
  await handle.render(generatedTsx);
  const renderMs = Math.round(performance.now() - startedAt);
  record("TSX generated code renders through real React", true, `${renderMs}ms`);
  record("generation-to-render is measured in seconds (fixed principle 5)", renderMs < 5000, `${renderMs}ms`);

  const ids = await handle.listIds();
  record(
    "React output carries stable ids (authored anchor + synthesized)",
    ids.some((e) => e.id === "counter") && ids.some((e) => e.id === "viv:@counter/button[0]"),
    JSON.stringify(ids),
  );

  // Interaction: the guest clicks its own button (host cannot reach the
  // opaque-origin DOM — by design); React state updates and a capability
  // round trip records the event host-side.
  await handle.render(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";

    function Clicker({ api }: { api: any }) {
      const [n, setN] = useState(0);
      return (
        <button onClick={() => { setN(n + 1); api.invoke("events.emit", { type: "click", n: n + 1 }); }}>
          n={n}
        </button>
      );
    }

    export default async function mount(root: HTMLElement, api: any) {
      createRoot(root).render(<Clicker api={api} />);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      root.querySelector("button").click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 50));
  record(
    "React event handler reaches the host through a capability",
    events.some((e) => e && e.type === "click" && e.n === 1),
    JSON.stringify(events),
  );

  // TSX type errors are not vivarium's job (changeset gates validate);
  // but a syntactically broken TSX must fail at transform, host-side.
  let transformFailed = false;
  try {
    await handle.render("const x: = <div>;");
  } catch (err) {
    transformFailed = true;
    record("broken TSX fails host-side at transform", true, String(err && err.message).slice(0, 80));
  }
  if (!transformFailed) record("broken TSX fails host-side at transform", false, "render resolved unexpectedly");

  handle.destroy();
  record("destroy tears down the profiled sandbox", stage.querySelector("iframe") === null);
}

main()
  .catch((err) => record("harness error", false, (err && err.stack) || err))
  .finally(() => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    window.__E2E__ = { done: true, passed, failed, results };
    const status = document.getElementById("status");
    status.textContent = failed === 0 ? `ALL PASS (${passed})` : `FAILURES: ${failed} of ${results.length}`;
    status.className = failed === 0 ? "pass" : "fail";
  });
