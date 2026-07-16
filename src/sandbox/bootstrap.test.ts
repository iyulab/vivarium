import { test } from "node:test";
import assert from "node:assert/strict";
import { createBootstrapHtml, SANDBOX_ROOT_ID, SANDBOX_CSP } from "./bootstrap.ts";
import { BRIDGE_PROTOCOL_VERSION } from "../bridge/protocol.ts";

test("bootstrap html is self-contained (no external references)", () => {
  const html = createBootstrapHtml();
  assert.ok(!/\bsrc\s*=/.test(html), "must not reference external scripts");
  assert.ok(!/\bhref\s*=/.test(html), "must not reference external resources");
  assert.ok(!/https?:\/\//.test(html), "must not contain absolute URLs");
});

test("bootstrap html closes the network with a default-src 'none' CSP", () => {
  const html = createBootstrapHtml();
  assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
  assert.ok(html.includes(SANDBOX_CSP));
  assert.ok(SANDBOX_CSP.startsWith("default-src 'none'"), "network must be fail-closed");
  const cspIndex = html.indexOf("Content-Security-Policy");
  const scriptIndex = html.indexOf("<script");
  assert.ok(cspIndex < scriptIndex, "CSP must be declared before any script");
});

test("bootstrap html carries the mount root and inline module runtime", () => {
  const html = createBootstrapHtml();
  assert.ok(html.includes(`id="${SANDBOX_ROOT_ID}"`));
  assert.ok(html.includes('<script type="module">'));
  assert.ok(!html.includes("__ROOT_ID__"), "placeholders must be substituted");
  assert.ok(!html.includes("__PROTOCOL_VERSION__"), "placeholders must be substituted");
  assert.ok(html.includes(`protocolVersion: "${BRIDGE_PROTOCOL_VERSION}"`));
});

test("guest runtime speaks the lifecycle methods and only trusts the parent", () => {
  const html = createBootstrapHtml();
  assert.ok(html.includes("vivarium/initialize"));
  assert.ok(html.includes("vivarium/render"));
  assert.ok(html.includes("vivarium/unmount"));
  assert.ok(html.includes("vivarium/inspect.ids"));
  assert.ok(html.includes("event.source !== window.parent"), "must filter message sources");
});

test("identity runtime is injected as one self-contained factory", () => {
  const html = createBootstrapHtml();
  assert.ok(!html.includes("__IDENTITY_RUNTIME_FACTORY__"), "factory placeholder must be substituted");
  assert.ok(html.includes("const { installStableIdentity } = (function"), "injected factory is invoked");
  assert.ok(html.includes("installStableIdentity"), "runtime installs identity maintenance");
});
