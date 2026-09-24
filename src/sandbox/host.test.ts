import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSandbox, SANDBOX_ATTRIBUTE } from "./host.ts";
import type { SandboxContainerElement, SandboxIframeElement } from "./host.ts";
import { CapabilityRegistry } from "../bridge/capabilities.ts";
import { RpcError, ENDPOINT_CLOSED } from "../bridge/protocol.ts";
import type { MessageEventLike } from "../bridge/transport.ts";

/**
 * Minimal fake DOM: enough structure for mountSandbox to create and wire an
 * iframe. Real iframe/browser behavior is covered by the e2e harness
 * (test/e2e.html driven through the dev server).
 */
function makeFakeDom() {
  const listeners = new Set<(event: MessageEventLike) => void>();
  const sent: unknown[] = [];

  const contentWindow = {
    postMessage(message: unknown) {
      sent.push(message);
    },
  };

  const attributes = new Map<string, string>();
  let removed = false;
  const iframe: SandboxIframeElement & { removedFlag(): boolean } = {
    setAttribute: (name, value) => void attributes.set(name, value),
    remove: () => {
      removed = true;
    },
    contentWindow,
    removedFlag: () => removed,
  };

  const appended: unknown[] = [];
  const container: SandboxContainerElement = {
    ownerDocument: {
      createElement: (tag: string) => {
        assert.equal(tag, "iframe");
        return iframe;
      },
      defaultView: {
        addEventListener: (_type, listener) => void listeners.add(listener),
        removeEventListener: (_type, listener) => void listeners.delete(listener),
      },
    },
    appendChild: (node) => void appended.push(node),
  };

  const emit = (data: unknown, source: unknown = contentWindow) => {
    for (const listener of [...listeners]) listener({ data, source });
  };

  return { container, iframe, attributes, appended, sent, emit, listenerCount: () => listeners.size };
}

test("mountSandbox creates a fail-closed iframe: sandbox=allow-scripts, srcdoc bootstrap", () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry() });
  assert.equal(dom.attributes.get("sandbox"), SANDBOX_ATTRIBUTE);
  assert.ok(dom.attributes.get("srcdoc")?.includes("vivarium-root"));
  assert.deepEqual(dom.appended, [dom.iframe]);
  handle.destroy();
});

test("messages from foreign sources are ignored; guest initialize resolves readiness", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, {
    registry: new CapabilityRegistry(),
    context: { greeting: "hi" },
  });

  let ready = false;
  void handle.whenReady().then(() => {
    ready = true;
  });

  // A message not originating from the iframe's contentWindow must be dropped.
  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } }, { attacker: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ready, false);
  assert.equal(dom.sent.length, 0, "foreign traffic must produce no replies");

  // The genuine guest handshake succeeds (request + confirmation notification).
  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ready, false, "ready only after the guest confirms receipt");
  dom.emit({ jsonrpc: "2.0", method: "vivarium/initialized" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ready, true);
  const reply = dom.sent[0] as { result: { context: unknown } };
  assert.deepEqual(reply.result.context, { greeting: "hi" });

  handle.destroy();
});

test("profile transform runs host-side before the render request is sent", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, {
    registry: new CapabilityRegistry(),
    profile: {
      name: "test-profile",
      transform: (code) => code.replace("__PLACEHOLDER__", "transformed"),
    },
  });

  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } });
  dom.emit({ jsonrpc: "2.0", method: "vivarium/initialized" });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const renderDone = handle.render("export default () => '__PLACEHOLDER__'");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renderRequest = dom.sent.find(
    (m) => (m as { method?: string }).method === "vivarium/render",
  ) as { id: number; params: { code: string } };
  assert.ok(renderRequest, "render request must be sent");
  assert.ok(renderRequest.params.code.includes("transformed"));
  assert.ok(!renderRequest.params.code.includes("__PLACEHOLDER__"));

  dom.emit({ jsonrpc: "2.0", id: renderRequest.id, result: { ok: true } });
  await renderDone;
  handle.destroy();
});

test("a throwing profile transform rejects render without sending anything", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, {
    registry: new CapabilityRegistry(),
    profile: {
      name: "test-profile",
      transform: () => {
        throw new Error("syntax error in generated TSX");
      },
    },
  });
  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } });
  dom.emit({ jsonrpc: "2.0", method: "vivarium/initialized" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const sentBefore = dom.sent.length;
  await assert.rejects(handle.render("bad"), /syntax error in generated TSX/);
  assert.equal(dom.sent.length, sentBefore, "no render request may leave the host");
  handle.destroy();
});

test("destroy closes the bridge, removes the iframe, and detaches listeners", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry() });
  assert.equal(dom.listenerCount(), 1);
  handle.destroy();
  assert.equal(dom.iframe.removedFlag(), true);
  assert.equal(dom.listenerCount(), 0);
  await assert.rejects(handle.render("export default () => {}"), /destroyed/);
  await assert.rejects(handle.requestUnmount(), /destroyed/);
});

test("every entry point on a destroyed handle reports the closed channel", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry() });
  handle.destroy();

  // The whole surface, not the two that happened to be tested: a caller
  // racing teardown may be in any of these calls, and a code that appears
  // on some of them is one the caller still cannot rely on.
  const calls: [string, () => Promise<unknown>][] = [
    ["render", () => handle.render("export default () => {}")],
    ["requestUnmount", () => handle.requestUnmount()],
    ["listIds", () => handle.listIds()],
    ["describeElements", () => handle.describeElements(["x"])],
    ["setSelectionMode", () => handle.setSelectionMode(true)],
    ["createEditContext", () => handle.createEditContext([])],
  ];

  for (const [name, call] of calls) {
    await assert.rejects(
      call(),
      (err: unknown) =>
        err instanceof RpcError && err.code === ENDPOINT_CLOSED && /destroyed/.test(err.message),
      `${name}() must reject with ENDPOINT_CLOSED`,
    );
  }
});

test("faults the guest reports after mount reach onFault listeners until they unsubscribe", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry() });
  const seen: unknown[] = [];
  const unsubscribe = handle.onFault((fault) => seen.push(fault));

  const fault = { kind: "unhandledrejection", message: "capability not granted: nope", stack: null };
  dom.emit({ jsonrpc: "2.0", method: "vivarium/fault", params: fault });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, [fault]);
  assert.equal(dom.sent.length, 0, "a fault is a notification — nothing is answered");

  unsubscribe();
  dom.emit({ jsonrpc: "2.0", method: "vivarium/fault", params: { ...fault, message: "again" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(seen.length, 1);
  handle.destroy();
});

test("emit waits for the handshake, then sends a granted event as an evt: notification", async () => {
  const dom = makeFakeDom();
  const registry = new CapabilityRegistry();
  registry.grantEvent({ name: "files.arrived", description: "a file was added" });
  const handle = mountSandbox(dom.container, { registry });

  const emitted = handle.emit("files.arrived", { name: "a.m4a" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(dom.sent.length, 0, "nothing is sent before the guest is ready");

  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } });
  dom.emit({ jsonrpc: "2.0", method: "vivarium/initialized" });
  await emitted;
  const event = dom.sent.find((m) => (m as { method?: string }).method === "evt:files.arrived");
  assert.deepEqual(event, { jsonrpc: "2.0", method: "evt:files.arrived", params: { payload: { name: "a.m4a" } } });

  await assert.rejects(handle.emit("files.gone"), /not granted/);
  handle.destroy();
  await assert.rejects(handle.emit("files.arrived"), (err: unknown) => err instanceof RpcError && err.code === ENDPOINT_CLOSED);
});

test("createEditContext asks the guest once, and passes its answer through unchanged", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry() });
  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } });
  dom.emit({ jsonrpc: "2.0", method: "vivarium/initialized" });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const pending = handle.createEditContext(["ref:7"]);
  await new Promise((resolve) => setTimeout(resolve, 5));

  // One request, not two. The selection and its surroundings have to describe the
  // same DOM — asking separately leaves room for a render in between, and the
  // context would then pair a selection with a screen it no longer lives in.
  const inspectCalls = dom.sent.filter((m) =>
    String((m as { method?: string }).method ?? "").startsWith("vivarium/inspect."),
  ) as Array<{ id: number; method: string; params: { refs: string[] } }>;
  assert.equal(inspectCalls.length, 1);
  assert.equal(inspectCalls[0].method, "vivarium/inspect.context");
  assert.deepEqual(inspectCalls[0].params.refs, ["ref:7"]);

  dom.emit({
    jsonrpc: "2.0",
    id: inspectCalls[0].id,
    result: {
      selection: [{ id: "b", ref: "ref:7", tag: "button", text: "Save", attributes: {}, name: "Save" }],
      screen: [
        { id: "form", tag: "form", relation: "ancestor", role: null },
        { id: "b", tag: "button", relation: "selected", role: "button" },
      ],
      names: { form: "Edit profile", b: "Save" },
    },
  });

  const ctx = await pending;
  assert.equal(ctx.editContextVersion, "0.2");
  assert.deepEqual(ctx.screen.elements.map((e) => [e.id, e.relation, e.role]), [
    ["form", "ancestor", null],
    ["b", "selected", "button"],
  ]);
  // A neighbour's name is screen-derived, so it lands under `untrusted` with the
  // rest of the screen's words rather than beside the structure.
  assert.deepEqual(ctx.untrusted.form, { text: null, attributes: {}, name: "Edit profile" });
  assert.equal(ctx.untrusted.b.name, "Save");
  assert.equal(ctx.untrusted.b.text, "Save");
  handle.destroy();
});

// ── watchdog ──────────────────────────────────────────────────────────────
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function handshake(dom: ReturnType<typeof makeFakeDom>) {
  dom.emit({ jsonrpc: "2.0", id: 1, method: "vivarium/initialize", params: { protocolVersion: "0.1" } });
  await tick(1);
  dom.emit({ jsonrpc: "2.0", method: "vivarium/initialized" });
  await tick(1);
}

const pings = (dom: ReturnType<typeof makeFakeDom>) =>
  dom.sent.filter((m) => (m as { method?: string }).method === "vivarium/ping") as Array<{ id: number }>;

test("watchdog: a guest that stops answering gets an unresponsive fault, then the sandbox is destroyed", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry(), watchdog: { unresponsiveMs: 40 } });
  const faults: Array<{ kind: string; closedWhenSeen: boolean }> = [];
  handle.onFault((f) => {
    // At delivery the handle is still live: the listener learns why first.
    faults.push({ kind: f.kind, closedWhenSeen: dom.iframe.removedFlag() });
  });
  await tick(60);
  assert.equal(pings(dom).length, 0, "no probing before the handshake");
  await handshake(dom);
  await tick(80);
  assert.deepEqual(faults, [{ kind: "unresponsive", closedWhenSeen: false }]);
  assert.equal(dom.iframe.removedFlag(), true);
  assert.equal(pings(dom).length, 1, "one ping in flight at a time");
  await assert.rejects(handle.listIds(), (e: unknown) => e instanceof RpcError && e.code === ENDPOINT_CLOSED);
});

test("watchdog: a guest that keeps answering is never condemned", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry(), watchdog: { unresponsiveMs: 40 } });
  const faults: string[] = [];
  handle.onFault((f) => faults.push(f.kind));
  await handshake(dom);
  const answered = new Set<number>();
  const until = Date.now() + 200;
  while (Date.now() < until) {
    for (const p of pings(dom)) if (!answered.has(p.id)) {
      answered.add(p.id);
      dom.emit({ jsonrpc: "2.0", id: p.id, result: null });
    }
    await tick(5);
  }
  assert.deepEqual(faults, []);
  assert.ok(answered.size >= 3, `expected repeated probing, saw ${answered.size}`);
  handle.destroy();
});

test("watchdog: a late answer counts — one missed check alone does not fire", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry(), watchdog: { unresponsiveMs: 60 } });
  const faults: string[] = [];
  handle.onFault((f) => faults.push(f.kind));
  await handshake(dom);
  await tick(45); // past the first check (30ms), before the second (60ms)
  dom.emit({ jsonrpc: "2.0", id: pings(dom)[0].id, result: null });
  await tick(40);
  assert.deepEqual(faults, []);
  assert.equal(dom.iframe.removedFlag(), false);
  handle.destroy();
});

test("watchdog: destroy stops the probing", async () => {
  const dom = makeFakeDom();
  const handle = mountSandbox(dom.container, { registry: new CapabilityRegistry(), watchdog: { unresponsiveMs: 20 } });
  const faults: string[] = [];
  handle.onFault((f) => faults.push(f.kind));
  await handshake(dom);
  handle.destroy();
  const sentAtDestroy = dom.sent.length;
  await tick(80);
  assert.deepEqual(faults, []);
  assert.equal(dom.sent.length, sentAtDestroy);
});
