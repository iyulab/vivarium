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
import { createIdentityRuntime } from "../identity/stable-id.ts";

/** Root element id inside the sandbox document where generated UI mounts. */
export const SANDBOX_ROOT_ID = "vivarium-root";

/**
 * Sandbox document CSP. `default-src 'none'` closes every network path
 * (connect/img/font/media/frame all collapse to none); scripts are limited
 * to the inline bootstrap and blob:-imported generated modules; inline
 * styles are allowed because generated UI legitimately styles itself.
 * `data:` is added to script-src only when a profile embeds modules
 * (ADR-0004 — fail-closed: no allowance before there is a need).
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'";

export const SANDBOX_CSP_WITH_MODULES =
  "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'";

/** Node's Buffer, when present — this package compiles against DOM types only. */
declare const Buffer:
  | { from(input: string, encoding: string): { toString(encoding: string): string } }
  | undefined;

/** UTF-8 safe base64 (Node Buffer or browser TextEncoder+btoa). */
function toBase64(source: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(source, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Build the import map that resolves bare specifiers inside the sandbox to
 * embedded data: modules. JSON is defused against `</script>` breakout.
 */
function buildImportMap(modules: Record<string, string>): string {
  const imports: Record<string, string> = {};
  for (const [specifier, source] of Object.entries(modules)) {
    imports[specifier] = "data:text/javascript;base64," + toBase64(source);
  }
  return JSON.stringify({ imports }).replaceAll("<", "\\u003c");
}

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

const { installStableIdentity } = (__IDENTITY_RUNTIME_FACTORY__)();
let identityMaintainer = null;

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
  if (identityMaintainer) identityMaintainer.disconnect();
  root.replaceChildren();
  // Identity maintenance starts BEFORE mount runs, so elements are
  // addressable as soon as they appear — including interactions that
  // happen while mount is still in flight.
  identityMaintainer = installStableIdentity(root);
  const api = {
    context: initResult.context,
    capabilities: initResult.capabilities,
    invoke: (name, invokeParams) => request("cap:" + name, invokeParams),
    onUnmount: (provider) => { unmountProvider = provider; },
  };
  await module.default(root, api);
  identityMaintainer.refresh();
  return { ok: true };
});

handlers.set("vivarium/inspect.ids", () => {
  const root = document.getElementById("__ROOT_ID__");
  if (identityMaintainer) identityMaintainer.refresh();
  const out = [];
  for (const el of root.querySelectorAll("[data-viv-id]")) {
    out.push({ id: el.getAttribute("data-viv-id"), tag: el.tagName.toLowerCase() });
  }
  return out;
});

function describeElement(el) {
  const attributes = {};
  for (const attr of el.attributes) {
    if (attr.name === "data-viv-id") continue;
    attributes[attr.name] = attr.value.length > 200 ? attr.value.slice(0, 200) + "…" : attr.value;
  }
  const raw = el.textContent;
  const text = raw && raw.trim().length > 0
    ? (raw.length > 500 ? raw.slice(0, 500) + "…" : raw)
    : null;
  return { id: el.getAttribute("data-viv-id"), tag: el.tagName.toLowerCase(), text, attributes };
}

handlers.set("vivarium/inspect.describe", (params) => {
  if (!params || !Array.isArray(params.ids)) throw new Error("describe requires { ids: string[] }");
  const root = document.getElementById("__ROOT_ID__");
  if (identityMaintainer) identityMaintainer.refresh();
  const out = [];
  for (const id of params.ids) {
    for (const el of root.querySelectorAll("[data-viv-id]")) {
      if (el.getAttribute("data-viv-id") === id) {
        out.push(describeElement(el));
        break;
      }
    }
  }
  return out;
});

let selectionListener = null;

handlers.set("vivarium/selection.set", (params) => {
  const enabled = !!(params && params.enabled);
  if (enabled && !selectionListener) {
    selectionListener = (event) => {
      let el = event.target;
      while (el && el !== document.body && !(el.getAttribute && el.getAttribute("data-viv-id"))) {
        el = el.parentElement;
      }
      if (el && el.getAttribute && el.getAttribute("data-viv-id")) {
        post({ jsonrpc: "2.0", method: "vivarium/selection.changed", params: describeElement(el) });
      }
    };
    document.addEventListener("click", selectionListener, true);
  } else if (!enabled && selectionListener) {
    document.removeEventListener("click", selectionListener, true);
    selectionListener = null;
  }
  return { enabled };
});

initResult = await request("vivarium/initialize", { protocolVersion: "__PROTOCOL_VERSION__" });
post({ jsonrpc: "2.0", method: "vivarium/initialized" });
`;

export interface BootstrapOptions {
  /** Profile modules to embed: bare specifier → ES module source (ADR-0004). */
  modules?: Record<string, string>;
}

/**
 * Build the srcdoc HTML for the sandbox iframe. Self-contained: inline
 * scripts and embedded data: modules only, no external references.
 */
export function createBootstrapHtml(options: BootstrapOptions = {}): string {
  const runtime = GUEST_RUNTIME
    .replaceAll("__ROOT_ID__", SANDBOX_ROOT_ID)
    .replaceAll("__PROTOCOL_VERSION__", BRIDGE_PROTOCOL_VERSION)
    // Identity layer is injected from its real module (see the INJECTION
    // CONTRACT note in identity/stable-id.ts) instead of being duplicated.
    .replace("__IDENTITY_RUNTIME_FACTORY__", createIdentityRuntime.toString());
  const modules = options.modules ?? {};
  const hasModules = Object.keys(modules).length > 0;
  const csp = hasModules ? SANDBOX_CSP_WITH_MODULES : SANDBOX_CSP;
  return [
    "<!doctype html>",
    "<html><head>",
    '<meta charset="utf-8">',
    // The iframe sandbox attribute isolates the origin but does NOT block
    // network egress; this document CSP does (README: the bridge is the only
    // channel). Fail-closed: only the inline bootstrap, blob-imported
    // generated modules, and embedded profile modules may run; no fetch/XHR,
    // no external resources.
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<style>html,body{margin:0;height:100%}</style>",
    // The import map must precede the first module script to take effect.
    ...(hasModules ? ['<script type="importmap">' + buildImportMap(modules) + "</script>"] : []),
    "</head>",
    `<body><div id="${SANDBOX_ROOT_ID}"></div>`,
    '<script type="module">' + runtime + "</script>",
    "</body></html>",
  ].join("\n");
}
