import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMessage,
  makeRequest,
  makeNotification,
  makeSuccess,
  makeError,
  INVALID_REQUEST,
} from "./protocol.ts";

test("classifyMessage recognizes each well-formed kind", () => {
  assert.equal(classifyMessage(makeRequest(1, "m")), "request");
  assert.equal(classifyMessage(makeRequest("abc", "m", { a: 1 })), "request");
  assert.equal(classifyMessage(makeNotification("m")), "notification");
  assert.equal(classifyMessage(makeSuccess(1, 42)), "success");
  assert.equal(classifyMessage(makeError(1, INVALID_REQUEST, "bad")), "error");
  assert.equal(classifyMessage(makeError(null, INVALID_REQUEST, "bad")), "error");
});

test("classifyMessage rejects malformed messages (fail-closed)", () => {
  assert.equal(classifyMessage(null), null);
  assert.equal(classifyMessage(undefined), null);
  assert.equal(classifyMessage("string"), null);
  assert.equal(classifyMessage([]), null);
  assert.equal(classifyMessage({}), null);
  assert.equal(classifyMessage({ jsonrpc: "1.0", id: 1, method: "m" }), null);
  // id must be string or finite number
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: {}, method: "m" }), null);
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: NaN, method: "m" }), null);
  // response cannot carry both result and error
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } }), null);
  // request cannot also carry result
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, method: "m", result: 1 }), null);
  // error shape must have numeric code and string message
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, error: { code: "x", message: "m" } }), null);
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: 1, error: {} }), null);
  // success with null id is invalid (null id is reserved for error responses)
  assert.equal(classifyMessage({ jsonrpc: "2.0", id: null, result: 1 }), null);
});

test("makeSuccess normalizes undefined result to null", () => {
  assert.deepEqual(makeSuccess(7, undefined), { jsonrpc: "2.0", id: 7, result: null });
});

test("params are omitted when undefined", () => {
  assert.deepEqual(makeRequest(1, "m"), { jsonrpc: "2.0", id: 1, method: "m" });
  assert.deepEqual(makeNotification("m"), { jsonrpc: "2.0", method: "m" });
});
