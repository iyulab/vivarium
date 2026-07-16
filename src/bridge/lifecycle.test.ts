import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransportPair } from "./transport.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import { createHostBridge, createGuestBridge } from "./lifecycle.ts";
import { BRIDGE_PROTOCOL_VERSION, RpcError, INVALID_PARAMS, METHOD_NOT_FOUND } from "./protocol.ts";

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.grant({ name: "data.query", description: "read rows" }, (params) => {
    const { table } = params as { table: string };
    return [{ table, row: 1 }];
  });
  registry.grant({ name: "events.emit", description: "emit a UI event" }, () => null);
  return registry;
}

test("initialize handshake delivers version, context, and capability list", async () => {
  const [hostSide, guestSide] = createTransportPair();
  let handshaken: string | null = null;
  const host = createHostBridge(hostSide, {
    context: { user: "dana", theme: "dark" },
    registry: makeRegistry(),
    onInitialized: (params) => {
      handshaken = params.protocolVersion;
    },
  });
  const guest = createGuestBridge(guestSide);

  assert.equal(host.initialized(), false);
  const result = await guest.initialize();
  assert.equal(host.initialized(), true);
  assert.equal(handshaken, BRIDGE_PROTOCOL_VERSION);
  assert.equal(result.protocolVersion, BRIDGE_PROTOCOL_VERSION);
  assert.deepEqual(result.context, { user: "dana", theme: "dark" });
  assert.deepEqual(
    result.capabilities.map((c) => c.name).sort(),
    ["data.query", "events.emit"],
  );
});

test("initialize rejects malformed params", async () => {
  const [hostSide, guestSide] = createTransportPair();
  createHostBridge(hostSide, { registry: new CapabilityRegistry() });
  const guest = createGuestBridge(guestSide);
  await assert.rejects(
    guest.endpoint.request("vivarium/initialize", {}),
    (err: unknown) => err instanceof RpcError && err.code === INVALID_PARAMS,
  );
});

test("guest invokes granted capabilities; ungranted fail closed", async () => {
  const [hostSide, guestSide] = createTransportPair();
  createHostBridge(hostSide, { registry: makeRegistry() });
  const guest = createGuestBridge(guestSide);
  await guest.initialize();

  const rows = await guest.invoke("data.query", { table: "todos" });
  assert.deepEqual(rows, [{ table: "todos", row: 1 }]);

  await assert.rejects(
    guest.invoke("fs.read", { path: "/etc/passwd" }),
    (err: unknown) => err instanceof RpcError && err.code === METHOD_NOT_FOUND,
  );
});

test("unmount hands guest state back to the host", async () => {
  const [hostSide, guestSide] = createTransportPair();
  const host = createHostBridge(hostSide, { registry: new CapabilityRegistry() });
  createGuestBridge(guestSide, {
    onUnmount: () => ({ scroll: 120, draft: "hello" }),
  });
  const { state } = await host.requestUnmount();
  assert.deepEqual(state, { scroll: 120, draft: "hello" });
});

test("unmount without a guest handler yields empty state", async () => {
  const [hostSide, guestSide] = createTransportPair();
  const host = createHostBridge(hostSide, { registry: new CapabilityRegistry() });
  createGuestBridge(guestSide);
  const result = await host.requestUnmount();
  assert.deepEqual(result, {});
});

test("host context defaults to null and capability list may be empty", async () => {
  const [hostSide, guestSide] = createTransportPair();
  createHostBridge(hostSide, { registry: new CapabilityRegistry() });
  const guest = createGuestBridge(guestSide);
  const result = await guest.initialize();
  assert.equal(result.context, null);
  assert.deepEqual(result.capabilities, []);
});
