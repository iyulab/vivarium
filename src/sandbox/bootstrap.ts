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

import {
  BRIDGE_PROTOCOL_VERSION,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  GENERATED_CODE_FAULT,
  STALE_ELEMENT_REFERENCE,
} from "../bridge/protocol.ts";
import { createIdentityRuntime } from "../identity/stable-id.ts";

/** Root element id inside the sandbox document where generated UI mounts. */
export const SANDBOX_ROOT_ID = "vivarium-root";

/**
 * Sandbox document CSP. `default-src 'none'` closes every network path
 * (connect/img/font/media/frame all collapse to none); scripts are limited
 * to the inline bootstrap and blob:-imported generated modules; inline
 * styles are allowed because generated UI legitimately styles itself.
 * This is the policy when nothing is opted in; {@link sandboxCsp} derives
 * every other one (ADR-0004 — fail-closed: no allowance before there is a need).
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'";

/**
 * Sources a host may let the generated UI display: bytes that already live
 * inside the sandbox — `data:` URLs and blob: URLs the guest made itself.
 * Neither can reach anything outside the opaque-origin frame, so opting in
 * keeps the bridge the only way bytes get in. There is no scheme list on
 * purpose: nothing here can open `http:`, `https:` or `file:`.
 */
export interface InlineSources {
  /** `img-src data: blob:` — `<img>`, `<picture>`, CSS images, `<canvas>` sources. */
  images?: boolean;
  /** `media-src data: blob:` — `<audio>`, `<video>`, `<track>`. */
  media?: boolean;
}

export interface SandboxCspOptions {
  /** A profile embeds modules as data: URLs, so script-src must accept data:. */
  modules?: boolean;
  inlineSources?: InlineSources;
}

/** Derive the sandbox document CSP. Each allowance appears only when asked for. */
export function sandboxCsp(options: SandboxCspOptions = {}): string {
  const directives = [
    "default-src 'none'",
    options.modules ? "script-src 'unsafe-inline' blob: data:" : "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
  ];
  if (options.inlineSources?.images) directives.push("img-src data: blob:");
  if (options.inlineSources?.media) directives.push("media-src data: blob:");
  return directives.join("; ");
}

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

const GUEST_RUNTIME = String.raw`
const pending = new Map();
const handlers = new Map();
let nextId = 1;
let initResult = null;
let unmountProvider = null;
/** event name → Set of the current module's handlers (cleared on render/unmount). */
const eventHandlers = new Map();

/**
 * A failure the guest classified itself. Mirrors the host endpoint's rule
 * (bridge/endpoint.ts): a classified failure travels with its own code,
 * everything else is the runtime's own fault and stays INTERNAL_ERROR.
 *
 * The rule keys on the class, not on a "code" property, and that is the
 * point: DOM exceptions carry an unrelated legacy numeric "code", and a
 * peer error that bubbles through a handler is the peer's verdict on some
 * other request, not this guest's verdict on this one. Neither may be
 * mistaken for a classification made here.
 */
class RpcFailure extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    this.data = data;
  }
}

function invalidParams(message) {
  return new RpcFailure(__INVALID_PARAMS__, message);
}

/**
 * The generated code failed on its own terms — it would not load, does not
 * export what the contract requires, or threw while mounting. Scoped to the
 * render path deliberately: a code that means "everything the guest runs"
 * would be the same catch-all __INTERNAL_ERROR__ already is, under a nicer
 * name. The original failure travels in the message; the guest does not
 * forward a foreign error code, for the reason RpcFailure documents above.
 */
function generatedCodeFault(what, err) {
  const detail = err === undefined ? "" : ": " + String((err && err.message) || err);
  return new RpcFailure(__GENERATED_CODE_FAULT__, what + detail);
}

function toErrorShape(err) {
  if (err instanceof RpcFailure) {
    return err.data === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, data: err.data };
  }
  return { code: __INTERNAL_ERROR__, message: String((err && err.message) || err) };
}

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
          (err) => post({ jsonrpc: "2.0", id: msg.id, error: toErrorShape(err) }),
        );
    } else if (msg.method.startsWith("evt:")) {
      dispatchEvent(msg.method.slice(4), msg.params);
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

/**
 * Host events reach the current module's api.on handlers. Each handler runs
 * in its own microtask and nothing here catches it: a throw or a rejected
 * promise from a handler is the generated code failing after mount, so it
 * must surface as a fault — swallowing it (as a notification's runtime
 * handler may) would hide exactly what onFault exists to show.
 */
function dispatchEvent(name, params) {
  const set = eventHandlers.get(name);
  if (!set) return;
  const payload = params && "payload" in params ? params.payload : null;
  for (const listener of [...set]) queueMicrotask(() => listener(payload));
}

// Liveness probe for the host's watchdog: answering at all is the whole
// answer — a guest whose event loop is stuck cannot.
handlers.set("vivarium/ping", () => null);

handlers.set("vivarium/unmount", async () => {
  eventHandlers.clear();
  const state = unmountProvider ? await unmountProvider() : undefined;
  return state === undefined ? {} : { state };
});

const { installStableIdentity } = (__IDENTITY_RUNTIME_FACTORY__)();
let identityMaintainer = null;

handlers.set("vivarium/render", async (params) => {
  if (!initResult) throw invalidParams("render before initialize completed");
  if (!params || typeof params.code !== "string") throw invalidParams("render requires { code: string }");
  const root = document.getElementById("__ROOT_ID__");
  const url = URL.createObjectURL(new Blob([params.code], { type: "text/javascript" }));
  let module;
  try {
    module = await import(url);
  } catch (err) {
    throw generatedCodeFault("generated module failed to load", err);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (typeof module.default !== "function") {
    throw generatedCodeFault("generated module must default-export mount(root, api)");
  }
  unmountProvider = null;
  // The previous module's subscriptions end with it — otherwise its handlers
  // keep firing into a screen that is no longer theirs.
  eventHandlers.clear();
  if (identityMaintainer) identityMaintainer.disconnect();
  root.replaceChildren();
  forgetDetachedReferences();
  // Identity maintenance starts BEFORE mount runs, so elements are
  // addressable as soon as they appear — including interactions that
  // happen while mount is still in flight.
  identityMaintainer = installStableIdentity(root);
  const api = {
    context: initResult.context,
    capabilities: initResult.capabilities,
    invoke: (name, invokeParams) => request("cap:" + name, invokeParams),
    events: initResult.events || [],
    on: (name, listener) => {
      // Fail-closed, and at the call: an ungranted event does not exist, so
      // subscribing to one is a mistake the author should see now rather
      // than a handler that silently never fires.
      if (!(initResult.events || []).some((e) => e.name === name)) {
        throw new Error("event not granted: " + name);
      }
      if (typeof listener !== "function") throw new TypeError("api.on requires a handler function");
      let set = eventHandlers.get(name);
      if (!set) { set = new Set(); eventHandlers.set(name, set); }
      set.add(listener);
      return () => { set.delete(listener); };
    },
    onUnmount: (provider) => { unmountProvider = provider; },
  };
  try {
    await module.default(root, api);
  } catch (err) {
    throw generatedCodeFault("generated module threw while mounting", err);
  }
  identityMaintainer.refresh();
  return { ok: true };
});

/**
 * Element references (design ADR-0005). An id is an address — the element
 * standing at a position now — and a structural change hands the same id to
 * a different element. A reference names one element for as long as it
 * lives: issued once per element, never reused, never re-pointed. The host
 * holds references for "the thing the user pointed at"; the guest resolves
 * them to the element's current id, or refuses when the element is gone.
 *
 * Only weak links to elements are kept, and every inspection (and every
 * render) first drops the entries of elements no longer on screen — a screen
 * that keeps adding and removing rows without re-rendering must not grow the
 * table forever. A dropped reference still resolves to "stale" rather than
 * "unknown": the counter says it was issued.
 */
const referenceOf = new WeakMap();
const elementOf = new Map();
let referenceCount = 0;

function referenceFor(el) {
  let ref = referenceOf.get(el);
  if (!ref) {
    referenceCount += 1;
    ref = "ref:" + referenceCount;
    referenceOf.set(el, ref);
    elementOf.set(ref, new WeakRef(el));
  }
  return ref;
}

function forgetDetachedReferences() {
  for (const [ref, weak] of elementOf) {
    const el = weak.deref();
    if (!el || !el.isConnected) elementOf.delete(ref);
  }
}

handlers.set("vivarium/inspect.ids", () => {
  const root = document.getElementById("__ROOT_ID__");
  if (identityMaintainer) identityMaintainer.refresh();
  forgetDetachedReferences();
  const out = [];
  for (const el of root.querySelectorAll("[data-viv-id]")) {
    out.push({ id: el.getAttribute("data-viv-id"), tag: el.tagName.toLowerCase(), ref: referenceFor(el) });
  }
  return out;
});

/**
 * ARIA role: explicit when the author set one, otherwise the implicit role the
 * element carries by virtue of being that element.
 *
 * The implicit table is deliberately short. It covers the elements a generated
 * screen is built from, and answers null rather than guessing for anything else —
 * a wrong role is worse than no role, because a consumer acts on it.
 */
const IMPLICIT_ROLE = {
  a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading", img: "img", input: "textbox",
  li: "listitem", nav: "navigation", ol: "list", option: "option", p: "paragraph",
  progress: "progressbar", section: "region", select: "combobox", table: "table",
  tbody: "rowgroup", td: "cell", textarea: "textbox", th: "columnheader",
  thead: "rowgroup", tr: "row", ul: "list",
};

function roleOf(el) {
  const explicit = el.getAttribute("role");
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const tag = el.tagName.toLowerCase();
  // An <a> without href is not a link, and an <input type=checkbox> is not a textbox.
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return type === "hidden" ? null : "textbox";
  }
  return IMPLICIT_ROLE[tag] ?? null;
}

/**
 * Accessible name, the cheap and honest way: an explicit label if the author gave
 * one, otherwise the element's own short text. Not a full accname computation —
 * this deliberately stops where it would start guessing.
 */
function accessibleName(el) {
  const label = el.getAttribute("aria-label");
  if (label && label.trim().length > 0) return label.trim().slice(0, 100);
  const alt = el.getAttribute("alt");
  if (alt && alt.trim().length > 0) return alt.trim().slice(0, 100);
  const raw = el.textContent;
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 100) : null;
}

/**
 * The neighbourhood of a selection: the elements a consumer reasons about when it
 * reasons about the edit. Ancestors say where the selection sits, siblings what it
 * sits among, children what it contains. Everything else on the screen is the rest
 * of the screen, and carrying it made the context grow with the row count.
 */
function neighbourhoodOf(root, selected) {
  const relation = new Map(); // element → relation, first (strongest) wins
  const mark = (el, rel) => {
    if (!el || el === root || !root.contains(el)) return;
    if (!el.hasAttribute || !el.hasAttribute("data-viv-id")) return;
    if (!relation.has(el)) relation.set(el, rel);
  };
  for (const el of selected) mark(el, "selected");
  for (const el of selected) {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) mark(p, "ancestor");
    const parent = el.parentElement;
    if (parent) for (const sib of parent.children) if (sib !== el) mark(sib, "sibling");
    for (const child of el.children) mark(child, "child");
  }
  // Document order, so a consumer reads the neighbourhood the way the screen reads.
  const out = [];
  for (const el of root.querySelectorAll("[data-viv-id]")) {
    const rel = relation.get(el);
    if (rel) out.push({ id: el.getAttribute("data-viv-id"), tag: el.tagName.toLowerCase(), relation: rel, role: roleOf(el) });
  }
  return out;
}

/**
 * Everything createEditContext needs, in one round trip: the selection resolved
 * from refs, and the neighbourhood around it. One call because the two answers
 * must describe the same DOM — asking twice invites a render in between, and then
 * the neighbourhood belongs to a screen the selection no longer lives in.
 */
handlers.set("vivarium/inspect.context", (params) => {
  if (!params || !Array.isArray(params.refs)) throw invalidParams("context requires { refs: string[] }");
  const root = document.getElementById("__ROOT_ID__");
  if (identityMaintainer) identityMaintainer.refresh();
  forgetDetachedReferences();
  const selected = [];
  const stale = [];
  for (const ref of params.refs) {
    const match = typeof ref === "string" ? /^ref:([1-9][0-9]*)$/.exec(ref) : null;
    if (!match || Number(match[1]) > referenceCount) {
      throw invalidParams("not an element reference this sandbox issued: " + JSON.stringify(ref));
    }
    const weak = elementOf.get(ref);
    const el = weak && weak.deref();
    if (el && el.isConnected && root.contains(el)) selected.push(el);
    else stale.push(ref);
  }
  // Same refusal as resolve, for the same reason: a reference whose element is gone
  // is never quietly re-pointed at another one, and never quietly dropped.
  if (stale.length > 0) {
    throw new RpcFailure(
      __STALE_ELEMENT_REFERENCE__,
      "stale element reference — the element is no longer on screen: " + stale.join(", "),
      { refs: stale },
    );
  }
  const screen = neighbourhoodOf(root, selected);
  const names = {};
  for (const entry of screen) {
    const el = root.querySelector('[data-viv-id="' + CSS.escape(entry.id) + '"]');
    if (el) names[entry.id] = accessibleName(el);
  }
  return {
    selection: selected.map(describeElement),
    screen,
    names,
  };
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
  return {
    id: el.getAttribute("data-viv-id"), ref: referenceFor(el), tag: el.tagName.toLowerCase(),
    text, attributes, name: accessibleName(el),
  };
}

handlers.set("vivarium/inspect.describe", (params) => {
  if (!params || !Array.isArray(params.ids)) throw invalidParams("describe requires { ids: string[] }");
  const root = document.getElementById("__ROOT_ID__");
  if (identityMaintainer) identityMaintainer.refresh();
  // An address lookup: one answer per id asked, in order, and null where
  // nothing stands at that address now. Dropping the misses would hand back
  // a shorter list with nothing to say which ids went missing.
  const byId = new Map();
  for (const el of root.querySelectorAll("[data-viv-id]")) {
    const id = el.getAttribute("data-viv-id");
    if (!byId.has(id)) byId.set(id, el);
  }
  return params.ids.map((id) => {
    const el = byId.get(id);
    return el ? describeElement(el) : null;
  });
});

handlers.set("vivarium/inspect.resolve", (params) => {
  if (!params || !Array.isArray(params.refs)) throw invalidParams("resolve requires { refs: string[] }");
  const root = document.getElementById("__ROOT_ID__");
  if (identityMaintainer) identityMaintainer.refresh();
  forgetDetachedReferences();
  const out = [];
  const stale = [];
  for (const ref of params.refs) {
    const match = typeof ref === "string" ? /^ref:([1-9][0-9]*)$/.exec(ref) : null;
    if (!match || Number(match[1]) > referenceCount) {
      throw invalidParams("not an element reference this sandbox issued: " + JSON.stringify(ref));
    }
    const weak = elementOf.get(ref);
    const el = weak && weak.deref();
    if (el && el.isConnected && root.contains(el)) out.push(describeElement(el));
    else stale.push(ref);
  }
  if (stale.length > 0) {
    throw new RpcFailure(
      __STALE_ELEMENT_REFERENCE__,
      "stale element reference — the element is no longer on screen: " + stale.join(", "),
      { refs: stale },
    );
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

/**
 * Faults the generated code raises after mount — a throwing event listener or
 * timer, a promise nobody handled. render() only covers the way up; from then
 * on the code runs in a document the host cannot reach, so without this the
 * host has no way to learn that a screen which rendered is broken. Reported
 * as a notification (nothing to answer), and never for a mount-time throw:
 * that one is already render()'s rejection.
 *
 * The text is authored by the generated code — untrusted data, capped like
 * describeElement's, never interpreted here.
 */
function capText(value, limit) {
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}

function reportFault(kind, thrown, fallbackMessage) {
  const hasMessage = thrown && typeof thrown.message === "string";
  const message = hasMessage
    ? thrown.message
    : thrown !== undefined && thrown !== null ? String(thrown) : fallbackMessage;
  const stack = thrown && typeof thrown.stack === "string" ? capText(thrown.stack, 4000) : null;
  post({
    jsonrpc: "2.0",
    method: "vivarium/fault",
    params: { kind, message: capText(message || kind, 1000), stack },
  });
}

window.addEventListener("error", (event) => {
  reportFault("error", event.error, event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportFault("unhandledrejection", event.reason, "");
});

initResult = await request("vivarium/initialize", { protocolVersion: "__PROTOCOL_VERSION__" });
post({ jsonrpc: "2.0", method: "vivarium/initialized" });
`;

export interface BootstrapOptions {
  /** Profile modules to embed: bare specifier → ES module source (ADR-0004). */
  modules?: Record<string, string>;
  /** In-sandbox sources the generated UI may display (see {@link InlineSources}). */
  inlineSources?: InlineSources;
}

/**
 * Build the srcdoc HTML for the sandbox iframe. Self-contained: inline
 * scripts and embedded data: modules only, no external references.
 */
export function createBootstrapHtml(options: BootstrapOptions = {}): string {
  const runtime = GUEST_RUNTIME
    .replaceAll("__ROOT_ID__", SANDBOX_ROOT_ID)
    .replaceAll("__PROTOCOL_VERSION__", BRIDGE_PROTOCOL_VERSION)
    // Error codes come from the protocol module rather than being written
    // into the template, so the two ends of the bridge cannot drift apart.
    .replaceAll("__INVALID_PARAMS__", String(INVALID_PARAMS))
    .replaceAll("__INTERNAL_ERROR__", String(INTERNAL_ERROR))
    .replaceAll("__GENERATED_CODE_FAULT__", String(GENERATED_CODE_FAULT))
    .replaceAll("__STALE_ELEMENT_REFERENCE__", String(STALE_ELEMENT_REFERENCE))
    // Identity layer is injected from its real module (see the INJECTION
    // CONTRACT note in identity/stable-id.ts) instead of being duplicated.
    .replace("__IDENTITY_RUNTIME_FACTORY__", createIdentityRuntime.toString());
  const modules = options.modules ?? {};
  const hasModules = Object.keys(modules).length > 0;
  const csp = sandboxCsp({ modules: hasModules, inlineSources: options.inlineSources });
  return [
    "<!doctype html>",
    "<html><head>",
    '<meta charset="utf-8">',
    // The iframe sandbox attribute isolates the origin but does NOT block
    // network egress; this document CSP does (README: the bridge is the only
    // channel). Fail-closed: only the inline bootstrap, blob-imported
    // generated modules, and embedded profile modules may run; no fetch/XHR,
    // no external resources — at most in-sandbox images and media when opted in.
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
