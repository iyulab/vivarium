import { test } from "node:test";
import assert from "node:assert/strict";
import { createBootstrapHtml, SANDBOX_ROOT_ID } from "./bootstrap.ts";
import { BRIDGE_PROTOCOL_VERSION } from "../bridge/protocol.ts";

test("bootstrap html is self-contained (no external references)", () => {
  const html = createBootstrapHtml();
  assert.ok(!/\bsrc\s*=/.test(html), "must not reference external scripts");
  assert.ok(!/\bhref\s*=/.test(html), "must not reference external resources");
  assert.ok(!/https?:\/\//.test(html), "must not contain absolute URLs");
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
  assert.ok(html.includes("event.source !== window.parent"), "must filter message sources");
});
