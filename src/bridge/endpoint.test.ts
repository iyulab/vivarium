import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransportPair } from "./transport.ts";
import { RpcEndpoint } from "./endpoint.ts";
import { RpcError, METHOD_NOT_FOUND, INTERNAL_ERROR, INVALID_PARAMS, ENDPOINT_CLOSED } from "./protocol.ts";

function pair(): [RpcEndpoint, RpcEndpoint] {
  const [a, b] = createTransportPair();
  return [new RpcEndpoint(a), new RpcEndpoint(b)];
}

test("request/response round trip", async () => {
  const [host, guest] = pair();
  host.expose("echo", (params) => params);
  const result = await guest.request("echo", { hello: "world" });
  assert.deepEqual(result, { hello: "world" });
});

test("async handlers are awaited", async () => {
  const [host, guest] = pair();
  host.expose("later", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "done";
  });
  assert.equal(await guest.request("later"), "done");
});

test("unknown method fails closed with METHOD_NOT_FOUND", async () => {
  const [, guest] = pair();
  await assert.rejects(
    guest.request("never.exposed"),
    (err: unknown) => err instanceof RpcError && err.code === METHOD_NOT_FOUND,
  );
});

test("unexposed method stops existing", async () => {
  const [host, guest] = pair();
  host.expose("temp", () => 1);
  assert.equal(await guest.request("temp"), 1);
  host.unexpose("temp");
  await assert.rejects(
    guest.request("temp"),
    (err: unknown) => err instanceof RpcError && err.code === METHOD_NOT_FOUND,
  );
});

test("handler throwing RpcError propagates code and data", async () => {
  const [host, guest] = pair();
  host.expose("strict", () => {
    throw new RpcError(INVALID_PARAMS, "bad params", { field: "x" });
  });
  await assert.rejects(guest.request("strict"), (err: unknown) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.code, INVALID_PARAMS);
    assert.equal(err.message, "bad params");
    assert.deepEqual(err.data, { field: "x" });
    return true;
  });
});

test("handler throwing plain Error maps to INTERNAL_ERROR", async () => {
  const [host, guest] = pair();
  host.expose("boom", () => {
    throw new Error("kaput");
  });
  await assert.rejects(
    guest.request("boom"),
    (err: unknown) => err instanceof RpcError && err.code === INTERNAL_ERROR && err.message === "kaput",
  );
});

test("notifications dispatch without reply; unknown ones are dropped", async () => {
  const [host, guest] = pair();
  const seen: unknown[] = [];
  host.expose("log", (params) => {
    seen.push(params);
  });
  guest.notify("log", { n: 1 });
  guest.notify("nonexistent", { n: 2 });
  guest.notify("log", { n: 3 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, [{ n: 1 }, { n: 3 }]);
});

test("malformed inbound message triggers INVALID_REQUEST error reply when id is present", async () => {
  const [rawA, rawB] = createTransportPair();
  new RpcEndpoint(rawA); // endpoint under test, receives garbage
  const replies: unknown[] = [];
  rawB.onMessage((msg) => replies.push(msg));
  rawB.send({ jsonrpc: "2.0", id: 9, method: 42 }); // method not a string
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(replies.length, 1);
  const reply = replies[0] as { id: unknown; error: { code: number } };
  assert.equal(reply.id, 9);
  assert.equal(reply.error.code, -32600);
});

test("non-serializable payloads are rejected at the boundary", async () => {
  const [host, guest] = pair();
  host.expose("noop", () => null);
  await assert.rejects(guest.request("noop", { fn: () => 1 }), /could not be cloned/);
});

test("request timeout rejects and clears pending state", async () => {
  const [rawA] = createTransportPair(); // peer never answers
  const endpoint = new RpcEndpoint(rawA, { requestTimeoutMs: 20 });
  await assert.rejects(
    endpoint.request("void"),
    (err: unknown) => err instanceof RpcError && /timed out/.test(err.message),
  );
});

test("close rejects in-flight requests and blocks further use", async () => {
  const [rawA] = createTransportPair();
  const endpoint = new RpcEndpoint(rawA);
  const inFlight = endpoint.request("hang");
  endpoint.close();
  await assert.rejects(
    inFlight,
    (err: unknown) => err instanceof RpcError && err.code === ENDPOINT_CLOSED,
  );
  await assert.rejects(
    endpoint.request("more"),
    (err: unknown) => err instanceof RpcError && err.code === ENDPOINT_CLOSED,
  );
  assert.throws(() => endpoint.notify("more"));
});

test("exposedMethods enumerates the dispatch surface", () => {
  const [rawA] = createTransportPair();
  const endpoint = new RpcEndpoint(rawA);
  endpoint.expose("a", () => 1);
  endpoint.expose("b", () => 2);
  assert.deepEqual(endpoint.exposedMethods().sort(), ["a", "b"]);
});

test("concurrent requests correlate by id", async () => {
  const [host, guest] = pair();
  host.expose("delayed", async (params) => {
    const { value, ms } = params as { value: number; ms: number };
    await new Promise((resolve) => setTimeout(resolve, ms));
    return value;
  });
  const [first, second] = await Promise.all([
    guest.request("delayed", { value: 1, ms: 15 }),
    guest.request("delayed", { value: 2, ms: 1 }),
  ]);
  assert.equal(first, 1);
  assert.equal(second, 2);
});
