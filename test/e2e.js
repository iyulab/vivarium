/**
 * Real-browser e2e for the sandbox core. Served via tools/dev-server.ts,
 * which strips types so `../src/*.ts` imports load natively.
 *
 * Results land in window.__E2E__ = { done, passed, failed, results } for a
 * driver (e.g. Playwright) to read.
 */
import { mountSandbox } from "../src/sandbox/host.ts";
import { CapabilityRegistry } from "../src/bridge/capabilities.ts";

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? null : String(detail) });
  const li = document.createElement("li");
  li.className = ok ? "pass" : "fail";
  li.textContent = `${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " — " + detail : ""}`;
  document.getElementById("results").append(li);
}

async function expectReject(promise, pattern) {
  try {
    await promise;
    return { rejected: false };
  } catch (err) {
    const message = String(err && err.message || err);
    return { rejected: true, matched: pattern.test(message), message, code: err && err.code };
  }
}

async function main() {
  const stage = document.getElementById("stage");
  const invoked = [];

  const registry = new CapabilityRegistry();
  registry.grant({ name: "data.query", description: "read demo rows" }, (params) => {
    invoked.push(params);
    return [{ id: 1, title: "hello from host" }];
  });
  const uiEvents = [];
  registry.grant({ name: "ui.event", description: "interaction telemetry (e2e)" }, (params) => {
    uiEvents.push(params);
    return null;
  });

  const handle = mountSandbox(stage, {
    registry,
    context: { user: "e2e", locale: "ko" },
  });

  // 1. handshake completes in a real sandboxed iframe
  await handle.whenReady();
  record("initialize handshake completes", true);

  // 2. sandbox attributes are what we declared (fail-closed)
  const iframeEl = stage.querySelector("iframe");
  record(
    "iframe sandbox attribute is allow-scripts only",
    iframeEl.getAttribute("sandbox") === "allow-scripts",
    iframeEl.getAttribute("sandbox"),
  );

  // 3. render generated code: DOM write + capability round trip + context
  await handle.render(`
    export default async function mount(root, api) {
      const rows = await api.invoke("data.query", { table: "todos" });
      const div = document.createElement("div");
      div.id = "generated";
      div.textContent = rows[0].title + " / " + api.context.user;
      root.append(div);
      api.onUnmount(() => ({ scroll: 42 }));
    }
  `);
  record("render resolves for well-formed generated module", true);
  record(
    "capability invoked with params",
    invoked.length === 1 && invoked[0].table === "todos",
    JSON.stringify(invoked),
  );

  // 4. ungranted capability fails closed with METHOD_NOT_FOUND
  const denied = await expectReject(
    handle.render(`
      export default async function mount(root, api) {
        await api.invoke("fs.read", { path: "/etc/passwd" });
      }
    `),
    /method not found/,
  );
  record("ungranted capability fails closed (-32601)", denied.rejected && denied.matched, denied.message);

  // 5. generated code cannot reach the host page (opaque origin)
  const escape = await expectReject(
    handle.render(`
      export default function mount() {
        return window.parent.document.title;
      }
    `),
    /cross-origin|Blocked|denied|SecurityError/i,
  );
  record("window.parent.document is blocked by opaque origin", escape.rejected && escape.matched, escape.message);

  // 6. host page saw no writes from generated code
  record("host DOM untouched by generated code", document.getElementById("generated") === null);

  // 5.5 network egress is closed by the sandbox document CSP
  const exfil = await expectReject(
    handle.render(`
      export default async function mount() {
        const response = await fetch(location.ancestorOrigins ? "http://localhost:8787/package.json" : "/package.json");
        return response.status;
      }
    `),
    /fetch|CSP|Content Security Policy|violates/i,
  );
  record("network fetch from generated code is blocked (CSP)", exfil.rejected && exfil.matched, exfil.message);

  // 6.5 stable identity: synthesis, re-render stability, authored anchoring,
  //     dynamic-insert maintenance — enumerated through vivarium/inspect.ids
  const identityCode = `
    export default function mount(root) {
      root.innerHTML = '<section data-viv-id="sidebar"><button>a</button></section>'
        + '<main><button>b</button><button>c</button></main>';
      setTimeout(() => {
        const span = document.createElement("span");
        span.textContent = "late";
        root.querySelector("main").append(span);
      }, 30);
    }
  `;
  await handle.render(identityCode);
  const firstIds = await handle.listIds();
  record(
    "synthesized ids are structural; authored id preserved and anchoring",
    JSON.stringify(firstIds.map((e) => e.id)) ===
      JSON.stringify(["sidebar", "viv:@sidebar/button[0]", "viv:main[0]", "viv:main[0]/button[0]", "viv:main[0]/button[1]"]),
    JSON.stringify(firstIds),
  );

  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterInsert = await handle.listIds();
  record(
    "dynamically inserted element receives an id via the maintainer",
    afterInsert.some((e) => e.id === "viv:main[0]/span[0]"),
    JSON.stringify(afterInsert.map((e) => e.id)),
  );

  await handle.render(identityCode);
  const secondIds = await handle.listIds();
  record(
    "re-render of the same code reproduces identical ids",
    JSON.stringify(secondIds.map((e) => e.id)) === JSON.stringify(firstIds.map((e) => e.id)),
    JSON.stringify(secondIds.map((e) => e.id)),
  );

  // 6.8 interactive generated UI: listeners registered by generated code
  //     receive events (the bootstrap's capture-phase selection listener must
  //     not swallow them), may mutate the DOM after mount, and may invoke
  //     capabilities from handlers — the bridge stays live post-mount.
  //     (Surface first exercised by a consumer in samples/dashboard-builder
  //     M6 — hover crosshair/tooltip charts; sealed here deterministically.)
  await handle.render(`
    export default function mount(root, api) {
      const btn = document.createElement("button");
      btn.textContent = "hover me";
      const label = document.createElement("output");
      label.textContent = "idle";
      btn.addEventListener("pointermove", (ev) => {
        label.textContent = "hovered@" + Math.round(ev.clientX);
        void api.invoke("ui.event", { type: "pointermove", x: Math.round(ev.clientX) });
      });
      root.append(btn, label);
      // Same-document synthetic event: proves listener registration, event
      // propagation, and handler execution inside the closed sandbox. (Real
      // trusted input cannot be synthesized from the host page across the
      // opaque origin; input delivery itself is browser behavior.)
      setTimeout(() => {
        btn.dispatchEvent(new PointerEvent("pointermove", { clientX: 77, bubbles: true }));
      }, 20);
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const outputId = (await handle.listIds()).map((e) => e.id).find((id) => id.includes("output"));
  const outputDesc = outputId ? await handle.describeElements([outputId]) : [];
  record(
    "interaction: generated listener ran and mutated the DOM after mount",
    outputDesc.length === 1 && outputDesc[0].text === "hovered@77",
    JSON.stringify(outputDesc.map((d) => d.text)),
  );
  record(
    "interaction: capability invoked from an event handler (bridge live post-mount)",
    uiEvents.length === 1 && uiEvents[0].type === "pointermove" && uiEvents[0].x === 77,
    JSON.stringify(uiEvents),
  );

  // 6.9 faults after mount reach the host. A screen can render and still be
  //     broken — a throwing listener, a throwing timer, a capability call
  //     nobody awaited. None of these reject render(); onFault is the only
  //     way the host learns of them. A mount-time throw is render()'s
  //     rejection and must not be reported twice.
  const faults = [];
  const stopFaults = handle.onFault((fault) => faults.push(fault));
  await handle.render(`
    export default function mount(root, api) {
      const btn = document.createElement("button");
      btn.textContent = "broken";
      btn.addEventListener("click", () => { throw new TypeError("listener exploded"); });
      root.append(btn);
      setTimeout(() => btn.click(), 10);
      setTimeout(() => { throw "a thrown string"; }, 20);
      setTimeout(() => { api.invoke("not.granted", {}); }, 30);
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const byKind = (kind) => faults.filter((f) => f.kind === kind);
  record(
    "fault: a throwing event listener reaches onFault with message and stack",
    byKind("error").some((f) => /listener exploded/.test(f.message) && typeof f.stack === "string"),
    JSON.stringify(faults.map((f) => [f.kind, f.message])),
  );
  record(
    "fault: a thrown non-Error value is reported by its text, stack null",
    byKind("error").some((f) => /a thrown string/.test(f.message) && f.stack === null),
    JSON.stringify(byKind("error").map((f) => [f.message, f.stack === null])),
  );
  record(
    "fault: an unawaited capability rejection reaches onFault as unhandledrejection",
    byKind("unhandledrejection").some((f) => /not\.granted|not granted/i.test(f.message)),
    JSON.stringify(byKind("unhandledrejection").map((f) => f.message)),
  );
  record("fault: exactly the three faults the code raised", faults.length === 3, String(faults.length));

  const beforeMountThrow = faults.length;
  const mountThrow = await expectReject(
    handle.render(`export default function mount() { throw new Error("boom on the way up"); }`),
    /boom on the way up/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  record(
    "fault: a mount-time throw rejects render() and is not reported again",
    mountThrow.rejected && mountThrow.code === -32002 && faults.length === beforeMountThrow,
    `code=${mountThrow.code} faultsAfter=${faults.length - beforeMountThrow}`,
  );
  const loadFail = await expectReject(handle.render("not javascript {{{ at all"), /./);
  await new Promise((resolve) => setTimeout(resolve, 100));
  record(
    "fault: code that will not load rejects render() and is not reported again",
    loadFail.rejected && faults.length === beforeMountThrow,
    `faultsAfter=${faults.length - beforeMountThrow}`,
  );
  stopFaults();

  // 7. unmount hands back guest state
  await handle.render(`
    export default function mount(root, api) {
      api.onUnmount(() => ({ scroll: 42 }));
    }
  `);
  const { state } = await handle.requestUnmount();
  record("unmount returns guest state", state && state.scroll === 42, JSON.stringify(state));

  // 8. malformed generated module reports an error instead of hanging
  const malformed = await expectReject(
    handle.render("this is not javascript {{{"),
    /./,
  );
  record("malformed generated code rejects", malformed.rejected, malformed.message);

  // 8.5 a caller error crossing the bridge is reported as a caller error.
  //     The guest validates its parameters; if those rejections arrive as
  //     INTERNAL_ERROR the caller cannot tell "my input" from "the runtime".
  const badRenderParams = await expectReject(
    handle.bridge.endpoint.request("vivarium/render", {}),
    /./,
  );
  record(
    "missing render params report INVALID_PARAMS",
    badRenderParams.code === -32602,
    `code=${badRenderParams.code} ${badRenderParams.message}`,
  );

  const badDescribeParams = await expectReject(
    handle.bridge.endpoint.request("vivarium/inspect.describe", { ids: "not-an-array" }),
    /./,
  );
  record(
    "missing describe params report INVALID_PARAMS",
    badDescribeParams.code === -32602,
    `code=${badDescribeParams.code} ${badDescribeParams.message}`,
  );

  // 8.52 the supplied code is a third party to the request. When it will
  //      not load, exports the wrong thing, or throws on the way up, the
  //      request was well formed and the runtime is fine — saying either
  //      "your params were bad" or "we broke" sends the caller elsewhere.
  const failsToLoad = await expectReject(
    handle.render("this is still not javascript {{{"),
    /./,
  );
  record(
    "generated code that will not load is the code's fault",
    failsToLoad.code === -32002,
    `code=${failsToLoad.code} ${failsToLoad.message}`,
  );

  const noDefaultExport = await expectReject(
    handle.render("export const notDefault = 1;"),
    /./,
  );
  record(
    "generated module without a default export is the code's fault",
    noDefaultExport.code === -32002,
    `code=${noDefaultExport.code} ${noDefaultExport.message}`,
  );

  // 8.55 a DOM exception carries a legacy numeric `code` of its own (this
  //      one is 5). It must not be mistaken for a JSON-RPC classification.
  await handle.render(`
    export default function mount() { document.createElement(""); }
  `).then(
    () => record("a DOM exception's own code never reaches the wire", false, "did not reject"),
    (err) => record(
      "a DOM exception's own code never reaches the wire",
      err.code === -32002,
      `code=${err.code} ${err.message}`,
    ),
  );

  // 8.6 a throw out of mount() is the supplied code failing, not the
  //     runtime — and the message carries the original text, since the
  //     classification replaces the code, never the detail.
  await handle.render(`
    export default function mount() { throw new Error("mount exploded"); }
  `).then(
    () => record("a mount throw is the generated code's fault", false, "did not reject"),
    (err) => record(
      "a mount throw is the generated code's fault",
      err.code === -32002 && /mount exploded/.test(String(err.message)),
      `code=${err.code} ${err.message}`,
    ),
  );

  // 8.65 CONTROL — the classification is scoped to the render path, so
  //      INTERNAL_ERROR must still be reachable. A code that meant
  //      "anything the guest runs" would be the old catch-all wearing a
  //      better name, and nothing here would prove otherwise. This also
  //      records the edge the scope leaves open: an unmount provider is
  //      generated code too, and it still reports as the runtime's fault.
  await handle.render(`
    export default function mount(root, api) {
      root.textContent = "ok";
      api.onUnmount(() => { throw new Error("teardown exploded"); });
    }
  `);
  const teardown = await expectReject(handle.requestUnmount(), /./);
  record(
    "a guest failure outside the render path stays INTERNAL_ERROR",
    teardown.code === -32603,
    `code=${teardown.code} ${teardown.message}`,
  );

  handle.destroy();
  record("destroy removes the iframe", stage.querySelector("iframe") === null);

  // 8.7 every entry point on a destroyed handle reports the same closed
  //     channel, so one branch covers the whole surface.
  const afterDestroy = [
    ["render", () => handle.render("export default () => {}")],
    ["requestUnmount", () => handle.requestUnmount()],
    ["listIds", () => handle.listIds()],
    ["describeElements", () => handle.describeElements(["x"])],
    ["setSelectionMode", () => handle.setSelectionMode(true)],
    ["createEditContext", () => handle.createEditContext([])],
  ];
  for (const [name, call] of afterDestroy) {
    const rejected = await expectReject(call(), /destroyed/);
    record(
      `${name}() on a destroyed handle reports ENDPOINT_CLOSED`,
      rejected.rejected && rejected.matched && rejected.code === -32001,
      `code=${rejected.code} ${rejected.message}`,
    );
  }

  // 9. execution profile (ADR-0004): embedded modules resolve bare
  //    specifiers inside the closed sandbox; transform runs host-side
  const profiled = mountSandbox(stage, {
    registry,
    context: {},
    profile: {
      name: "demo-profile@0",
      modules: {
        "demo-lib": 'export const greet = (name) => "안녕, " + name;',
      },
      transform: (code) => code.replaceAll("__NAME__", '"vivarium"'),
    },
  });
  await profiled.render(`
    import { greet } from "demo-lib";
    export default function mount(root) {
      const div = document.createElement("div");
      div.textContent = greet(__NAME__);
      root.append(div);
    }
  `);
  const profiledIds = await profiled.listIds();
  record("profile module import + host-side transform render", profiledIds.length === 1, JSON.stringify(profiledIds));

  const unknownImport = await expectReject(
    profiled.render('import { nope } from "not-embedded"; export default () => {};'),
    /not-embedded|resolve|specifier/i,
  );
  record("non-embedded specifier fails closed", unknownImport.rejected, unknownImport.message);

  profiled.destroy();
}

main()
  .catch((err) => record("harness error", false, err && err.stack || err))
  .finally(() => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    window.__E2E__ = { done: true, passed, failed, results };
    const status = document.getElementById("status");
    status.textContent = failed === 0 ? `ALL PASS (${passed})` : `FAILURES: ${failed} of ${results.length}`;
    status.className = failed === 0 ? "pass" : "fail";
  });
