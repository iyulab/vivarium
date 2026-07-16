import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSandbox, SANDBOX_ATTRIBUTE } from "./host.ts";
import type { SandboxContainerElement, SandboxIframeElement } from "./host.ts";
import { CapabilityRegistry } from "../bridge/capabilities.ts";
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
