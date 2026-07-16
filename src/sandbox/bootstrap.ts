/**
 * Guest bootstrap — the HTML document loaded into the sandboxed iframe.
 *
 * The bootstrap must be fully self-contained (the sandbox has an opaque
 * origin and no network capability, so it cannot load anything external),
 * which is why the guest runtime is embedded as a plain-JS template string
 * rather than importing the TypeScript bridge modules. The host-side bridge
 * remains the reference implementation; this runtime is its minimal guest
 * counterpart and is exercised end-to-end by the browser test harness.
 *
 * Note: an about:srcdoc iframe inherits the *embedding page's* CSP. Hosts
 * with a restrictive `script-src` (no blob:) will block generated-module
 * import; this is a documented integration requirement, not a sandbox leak.
 */

import { BRIDGE_PROTOCOL_VERSION } from "../bridge/protocol.ts";

/** Root element id inside the sandbox document where generated UI mounts. */
export const SANDBOX_ROOT_ID = "vivarium-root";

const GUEST_RUNTIME = `
const pending = new Map();
const handlers = new Map();
let nextId = 1;
let initResult = null;
let unmountProvider = null;

function post(message) {
  window.parent.postMessage(message, "*");
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    post(message);
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

  if (typeof msg.method === "string") {
    const handler = handlers.get(msg.method);
    if ("id" in msg) {
      if (!handler) {
        post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params))
        .then(
          (result) => post({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result }),
          (err) => post({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String((err && err.message) || err) } }),
        );
    } else if (handler) {
      Promise.resolve().then(() => handler(msg.params)).catch(() => {});
    }
    return;
  }

  if ("result" in msg || "error" in msg) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if ("result" in msg) entry.resolve(msg.result);
    else entry.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }));
  }
});

handlers.set("vivarium/unmount", async () => {
  const state = unmountProvider ? await unmountProvider() : undefined;
  return state === undefined ? {} : { state };
});

handlers.set("vivarium/render", async (params) => {
  if (!initResult) throw new Error("render before initialize completed");
  if (!params || typeof params.code !== "string") throw new Error("render requires { code: string }");
  const root = document.getElementById("__ROOT_ID__");
  const url = URL.createObjectURL(new Blob([params.code], { type: "text/javascript" }));
  let module;
  try {
    module = await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (typeof module.default !== "function") {
    throw new Error("generated module must default-export mount(root, api)");
  }
  unmountProvider = null;
  root.replaceChildren();
  const api = {
    context: initResult.context,
    capabilities: initResult.capabilities,
    invoke: (name, invokeParams) => request("cap:" + name, invokeParams),
    onUnmount: (provider) => { unmountProvider = provider; },
  };
  await module.default(root, api);
  return { ok: true };
});

initResult = await request("vivarium/initialize", { protocolVersion: "__PROTOCOL_VERSION__" });
`;

/**
 * Build the srcdoc HTML for the sandbox iframe. Self-contained: inline
 * module script only, no external references.
 */
export function createBootstrapHtml(): string {
  const runtime = GUEST_RUNTIME
    .replaceAll("__ROOT_ID__", SANDBOX_ROOT_ID)
    .replaceAll("__PROTOCOL_VERSION__", BRIDGE_PROTOCOL_VERSION);
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style></head>',
    `<body><div id="${SANDBOX_ROOT_ID}"></div>`,
    '<script type="module">' + runtime + "</script>",
    "</body></html>",
  ].join("\n");
}
