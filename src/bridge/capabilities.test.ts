import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry, bindCapabilities, isValidCapabilityName } from "./capabilities.ts";
import { RpcEndpoint } from "./endpoint.ts";
import { createTransportPair } from "./transport.ts";
import { RpcError, METHOD_NOT_FOUND } from "./protocol.ts";

test("capability names are validated", () => {
  assert.ok(isValidCapabilityName("data.query"));
  assert.ok(isValidCapabilityName("events.emit"));
  assert.ok(isValidCapabilityName("log"));
  assert.ok(!isValidCapabilityName(""));
  assert.ok(!isValidCapabilityName("Data.Query"));
  assert.ok(!isValidCapabilityName("data..query"));
  assert.ok(!isValidCapabilityName(".data"));
  assert.ok(!isValidCapabilityName("data.query."));
  assert.ok(!isValidCapabilityName("data query"));
  assert.ok(!isValidCapabilityName("cap:data.query"));
});

test("grant validates names and rejects duplicates", () => {
  const registry = new CapabilityRegistry();
  registry.grant({ name: "data.query", description: "read rows" }, () => []);
  assert.throws(() => registry.grant({ name: "data.query", description: "again" }, () => []), /already granted/);
  assert.throws(() => registry.grant({ name: "BAD NAME", description: "x" }, () => 1), /invalid capability name/);
});

test("list enumerates exactly the granted surface", () => {
  const registry = new CapabilityRegistry();
  registry.grant({ name: "data.query", description: "read rows" }, () => []);
  registry.grant({ name: "events.emit", description: "emit UI events" }, () => null);
  assert.deepEqual(
    registry.list().map((d) => d.name).sort(),
    ["data.query", "events.emit"],
  );
  registry.revoke("events.emit");
  assert.deepEqual(registry.list().map((d) => d.name), ["data.query"]);
  assert.ok(!registry.has("events.emit"));
});

test("bound capabilities are invocable as cap:<name>; unbound do not exist", async () => {
  const registry = new CapabilityRegistry();
  registry.grant({ name: "math.double", description: "double a number" }, (params) => {
    const { value } = params as { value: number };
    return value * 2;
  });

  const [rawHost, rawGuest] = createTransportPair();
  const host = new RpcEndpoint(rawHost);
  const guest = new RpcEndpoint(rawGuest);
  const unbind = bindCapabilities(host, registry);

  assert.equal(await guest.request("cap:math.double", { value: 21 }), 42);
  await assert.rejects(
    guest.request("cap:never.granted"),
    (err: unknown) => err instanceof RpcError && err.code === METHOD_NOT_FOUND,
  );

  unbind();
  await assert.rejects(
    guest.request("cap:math.double", { value: 1 }),
    (err: unknown) => err instanceof RpcError && err.code === METHOD_NOT_FOUND,
  );
});

test("events are granted, listed and revoked apart from capabilities", () => {
  const registry = new CapabilityRegistry();
  registry.grant({ name: "audio.position", description: "ask for the position" }, () => 0);
  registry.grantEvent({ name: "audio.position", description: "told of the position" });
  assert.deepEqual(registry.list().map((c) => c.name), ["audio.position"]);
  assert.deepEqual(registry.listEvents(), [{ name: "audio.position", description: "told of the position" }]);
  assert.equal(registry.hasEvent("audio.position"), true);
  assert.throws(() => registry.grantEvent({ name: "audio.position", description: "again" }), /already granted/);
  assert.throws(() => registry.grantEvent({ name: "Bad Name", description: "x" }), /invalid event name/);
  assert.equal(registry.revokeEvent("audio.position"), true);
  assert.equal(registry.hasEvent("audio.position"), false);
  assert.equal(registry.has("audio.position"), true, "revoking the event leaves the capability");
});
