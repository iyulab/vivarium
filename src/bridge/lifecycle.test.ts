import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransportPair } from "./transport.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import { createHostBridge, createGuestBridge } from "./lifecycle.ts";
import {
  BRIDGE_PROTOCOL_VERSION,
  RpcError,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  CAPABILITY_DENIED,
} from "./protocol.ts";

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

test("granted events reach the guest's handlers with their payload; the list travels at initialize", async () => {
  const [hostSide, guestSide] = createTransportPair();
  const registry = makeRegistry();
  registry.grantEvent({ name: "audio.position", description: "playback position in seconds" });
  const host = createHostBridge(hostSide, { registry });
  const guest = createGuestBridge(guestSide);
  const result = await guest.initialize();
  assert.deepEqual(result.events.map((e) => e.name), ["audio.position"]);

  const seen: unknown[] = [];
  const stop = guest.on("audio.position", (payload) => seen.push(payload));
  host.emit("audio.position", { t: 12.5 });
  host.emit("audio.position", 3);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(seen, [{ t: 12.5 }, 3]);

  stop();
  host.emit("audio.position", { t: 13 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(seen.length, 2, "unsubscribed handlers hear nothing");
});

test("emitting an ungranted event is a caller error — it does not exist in either direction", async () => {
  const [hostSide, guestSide] = createTransportPair();
  const host = createHostBridge(hostSide, { registry: makeRegistry() });
  createGuestBridge(guestSide);
  assert.throws(
    () => host.emit("audio.position", 1),
    (err: unknown) => err instanceof RpcError && err.code === INVALID_PARAMS && /not granted/.test(err.message),
  );
});

test("a granted capability refuses one call with CAPABILITY_DENIED — distinct from an ungranted one", async () => {
  const [hostSide, guestSide] = createTransportPair();
  const registry = new CapabilityRegistry();
  registry.grant({ name: "orders.cancel", description: "cancel an owned order" }, (params) => {
    const { id } = params as { id: string };
    if (!id.startsWith("mine-")) throw new RpcError(CAPABILITY_DENIED, `order ${id} is not yours to cancel`);
    return { cancelled: id };
  });
  createHostBridge(hostSide, { registry });
  const guest = createGuestBridge(guestSide);
  await guest.initialize();

  assert.deepEqual(await guest.invoke("orders.cancel", { id: "mine-1" }), { cancelled: "mine-1" });
  await assert.rejects(
    guest.invoke("orders.cancel", { id: "theirs-9" }),
    (err: unknown) => err instanceof RpcError && err.code === CAPABILITY_DENIED && /not yours/.test(err.message),
  );
  await assert.rejects(
    guest.invoke("orders.delete", { id: "mine-1" }),
    (err: unknown) => err instanceof RpcError && err.code === METHOD_NOT_FOUND,
  );
});
