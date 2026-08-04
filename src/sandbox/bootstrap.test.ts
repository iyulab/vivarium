import { test } from "node:test";
import assert from "node:assert/strict";
import { createBootstrapHtml, SANDBOX_ROOT_ID, SANDBOX_CSP, SANDBOX_CSP_WITH_MODULES } from "./bootstrap.ts";
import { BRIDGE_PROTOCOL_VERSION, INVALID_PARAMS, INTERNAL_ERROR } from "../bridge/protocol.ts";

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
  assert.ok(html.includes("vivarium/inspect.describe"));
  assert.ok(html.includes("vivarium/selection.set"));
  assert.ok(html.includes("vivarium/selection.changed"));
  assert.ok(html.includes("event.source !== window.parent"), "must filter message sources");
});

test("guest error codes are taken from the protocol module, not written into the template", () => {
  const html = createBootstrapHtml();

  assert.ok(!html.includes("__INVALID_PARAMS__"), "placeholders must be substituted");
  assert.ok(!html.includes("__INTERNAL_ERROR__"), "placeholders must be substituted");
  assert.ok(
    html.includes(`new RpcFailure(${INVALID_PARAMS}, message)`),
    "classified guest failures carry the protocol module's INVALID_PARAMS",
  );
  assert.ok(
    html.includes(`return { code: ${INTERNAL_ERROR}, message:`),
    "unclassified guest failures fall back to the protocol module's INTERNAL_ERROR",
  );
});

test("guest replies classify by failure type, never by a code the failure happens to carry", () => {
  const html = createBootstrapHtml();

  // The reply path must not decide the code itself — that is how every
  // handler failure came to be reported as INTERNAL_ERROR.
  assert.ok(
    html.includes("error: toErrorShape(err)"),
    "the reply path delegates classification",
  );
  assert.ok(
    !/error: \{ code: -\d+, message: String\(/.test(html),
    "no reply may hard-code the code of an arbitrary failure",
  );
  // Keying on a `code` property would admit foreign failures: DOM
  // exceptions carry an unrelated legacy numeric `code`.
  assert.ok(
    html.includes("if (err instanceof RpcFailure)"),
    "classification keys on the guest's own failure type",
  );
});

test("every guest parameter check reports a caller error, not a runtime error", () => {
  const html = createBootstrapHtml();

  // The guest validates its parameters in four places; each one is a
  // verdict about the caller's input, and reporting any of them as an
  // internal error tells the caller to go looking in the wrong place.
  for (const guard of [
    "render before initialize completed",
    "render requires { code: string }",
    "generated module must default-export mount(root, api)",
    "describe requires { ids: string[] }",
  ]) {
    assert.ok(html.includes(`invalidParams("${guard}")`), `"${guard}" must be a caller error`);
  }
  assert.ok(!/throw new Error\(/.test(html), "no guest failure is left unclassified by omission");
});

test("profile modules embed as a data: import map ahead of the runtime, widening CSP only then", () => {
  const source = 'export const greet = (name) => "안녕, " + name;';
  const html = createBootstrapHtml({ modules: { "demo-lib": source } });

  assert.ok(html.includes(SANDBOX_CSP_WITH_MODULES), "CSP gains data: only with modules");
  assert.ok(html.includes('<script type="importmap">'));
  const importMapIndex = html.indexOf('type="importmap"');
  const moduleIndex = html.indexOf('type="module"');
  assert.ok(importMapIndex < moduleIndex, "import map must precede the module script");

  const encoded = html.match(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(encoded, "module embedded as base64 data: URL");
  assert.equal(Buffer.from(encoded[1], "base64").toString("utf8"), source, "utf-8 round trip");
});

test("import map JSON cannot break out of its script element", () => {
  const html = createBootstrapHtml({ modules: { "x": "</script><script>alert(1)</script>" } });
  const importMap = html.slice(html.indexOf('<script type="importmap">'), html.indexOf("</head>"));
  assert.ok(!importMap.includes("alert(1)"), "sources are base64-encoded, never inlined raw");
});

test("without profile modules there is no import map and no data: allowance", () => {
  const html = createBootstrapHtml();
  assert.ok(!html.includes("importmap"));
  assert.ok(html.includes(SANDBOX_CSP));
  assert.ok(!html.includes("script-src 'unsafe-inline' blob: data:"));
});

test("identity runtime is injected as one self-contained factory", () => {
  const html = createBootstrapHtml();
  assert.ok(!html.includes("__IDENTITY_RUNTIME_FACTORY__"), "factory placeholder must be substituted");
  assert.ok(html.includes("const { installStableIdentity } = (function"), "injected factory is invoked");
  assert.ok(html.includes("installStableIdentity"), "runtime installs identity maintenance");
});
