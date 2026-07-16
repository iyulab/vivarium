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

  handle.destroy();
  record("destroy removes the iframe", stage.querySelector("iframe") === null);
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
