# Getting started — embedding Vivarium in your app

This guide takes a host application from `npm install` to a working embed:
a sandboxed canvas that renders AI-generated UI, exposes exactly the
capabilities you grant, and turns user selections into [edit
contexts](edit-context.md) any editing agent can consume.

Every `ts` code block below is extracted and compile-verified against the
published package shape by `tools/verify-docs-examples.ts` (wired into CI),
so the examples cannot silently drift from the API.

## Install

```sh
npm install @vivariumjs/runtime
```

The package is browser-side and dependency-free. It ships built ESM with
type declarations; any bundler (or an import map) that resolves bare
specifiers will do.

## 1. Grant capabilities, then mount

A sandbox is created inside a container element you own. Everything the
generated code may do is a **capability** you grant on a registry — nothing
is ambient. Grant before mounting: the capability set is bound when the
sandbox initializes, and grants made afterwards are not exposed to an
already-mounted sandbox.

```ts
import { mountSandbox, CapabilityRegistry } from "@vivariumjs/runtime";

const registry = new CapabilityRegistry();

// The audit surface: whatever you grant here is the complete list of
// things generated code can do. `registry.list()` enumerates it.
registry.grant(
  { name: "orders.list", description: "read-only list of open orders" },
  async () => [
    { id: "A-1041", status: "shipped" },
    { id: "A-1042", status: "packing" },
  ],
);

const container = document.getElementById("canvas") as HTMLElement;
const sandbox = mountSandbox(container, {
  registry,
  // Opaque host context handed to the generated UI at initialize.
  context: { app: "my-host", locale: "en" },
});
await sandbox.whenReady();
```

The sandbox is a hard boundary: an iframe with an opaque origin
(`sandbox="allow-scripts"` exactly, no option widens it) and a
`default-src 'none'` document CSP, so the generated code has no network and
no host access. The bridge — JSON-RPC 2.0 over `postMessage` — is the only
channel, and it carries only the capabilities you granted above.

## 2. Render generated code

Generated code is an ES module that default-exports `mount(root, api)`.
Hand its source to `render`; it appears in seconds — no build step.

```ts
const generatedCode = `
  export default async function mount(root, api) {
    const orders = await api.invoke("orders.list");
    const heading = document.createElement("h2");
    heading.textContent = "Open orders (" + api.context.app + ")";
    const list = document.createElement("ul");
    for (const order of orders) {
      const item = document.createElement("li");
      item.textContent = order.id + " — " + order.status;
      list.append(item);
    }
    root.append(heading, list);
  }
`;
await sandbox.render(generatedCode);
```

Inside the sandbox, `api` is small and fixed:

| Member | What it is |
| --- | --- |
| `api.context` | The opaque `context` you passed to `mountSandbox` |
| `api.capabilities` | The granted capability descriptors, enumerable |
| `api.invoke(name, params?)` | Call a granted capability (`orders.list` above) |
| `api.onUnmount(provider)` | Register state to hand back when the host unmounts |

Calling a capability that was never granted rejects: the method simply does
not exist on the bridge (`METHOD_NOT_FOUND`) — the generated code cannot
escalate.

## 3. Inspect: selections become edit contexts

Every rendered element carries a stable ID (synthesized if the code didn't
provide one), so users can point at things and agents can act on the
pointing. Enable click-to-select and turn selections into a versioned
[edit context](edit-context.md):

```ts
await sandbox.setSelectionMode(true);

const unsubscribe = sandbox.onSelectionChanged(async (element) => {
  const editContext = await sandbox.createEditContext([element.id]);
  // Hand this to your editing agent — e.g. the input of @vivariumjs/agent.
  console.log(editContext.editContextVersion, editContext.selection);
});
```

The edit context separates screen-derived content into an `untrusted` map —
treat it as data, never as instructions (see the [contract
§3](edit-context.md) for the consumer obligations).

You can also enumerate and describe elements without a user selection:

```ts
const ids = await sandbox.listIds();
const described = await sandbox.describeElements(ids.map((entry) => entry.id));
```

## 4. Unmount and teardown

Ask the generated UI to unmount (collecting any state it registered via
`api.onUnmount`), then destroy the handle:

```ts
const { state } = await sandbox.requestUnmount();
unsubscribe();
sandbox.destroy(); // removes the iframe; the handle is unusable afterwards
```

## 5. Reading a failure

Rejections from the bridge carry a JSON-RPC `code`, so a host can tell what
happened without matching on the message text:

```ts
async function renderAndReport(code: string): Promise<string> {
  try {
    await sandbox.render(code);
    return "rendered";
  } catch (err) {
    switch ((err as { code?: number }).code) {
      case -32602: // invalid params — the request was rejected as given
        return "the generated code was rejected; regenerate it";
      case -32001: // endpoint closed — this sandbox is gone
        return "the sandbox was torn down; mount a new one";
      default: // internal error — the runtime or the generated code failed
        return `render failed: ${String(err)}`;
    }
  }
}
```

| Code | Meaning | Who can act |
| --- | --- | --- |
| `-32601` | The method does not exist — e.g. invoking a capability that was never granted | Host: grant it, or stop calling it |
| `-32602` | The request was rejected as given — malformed params, or generated code that is not a module default-exporting `mount(root, api)` | Caller: send something else |
| `-32001` | The handle was destroyed, or its endpoint closed | Caller: mount a new sandbox |
| `-32603` | Everything else — the runtime, or the generated code failing while it runs | Report it; the message is the detail |

The distinction that matters is `-32602` against `-32603`: the first says the
call was wrong, the second says it was not. Named constants for these codes
live behind `@vivariumjs/runtime/internal`, which carries no stability
promise — reading the numeric `code` off the rejection needs no import.

## Execution profiles (TSX and friends)

By default the sandbox runs plain-JS ES modules, like the example above.
An **execution profile** widens the generated code's world — it is plain
data, not configuration: bare-specifier module sources embedded into the
sandbox via an import map, plus an optional host-side source transform.

```ts
import type { SandboxProfile } from "@vivariumjs/runtime";

const jsonProfile: SandboxProfile = {
  name: "with-utils@0",
  modules: {
    // Generated code can now `import { fmt } from "utils"`.
    utils: "export const fmt = (n) => n.toLocaleString();",
  },
};
```

Pass it as `mountSandbox(container, { registry, profile })`. The reference
React + TSX profile (real React via an import map, TSX transformed by
Sucrase on the host side) lives in this repository — see
`test/react-tsx-profile.js` and `tools/build-profile-assets.ts` for how it
is assembled from npm-installed sources. Profiles are versioned data the
host supplies; the runtime core stays profile-neutral.

## Public surface and `/internal`

The package root exports exactly the consumer contract this guide uses —
`mountSandbox`, `CapabilityRegistry`, `EDIT_CONTEXT_VERSION`, and the types
reachable from their signatures. That is the surface this package promises
compatibility for.

Protocol plumbing (JSON-RPC message shapes, transports, `RpcEndpoint`,
lifecycle bridges, bootstrap HTML, the stable-identity runtime) is
available from `@vivariumjs/runtime/internal` for advanced integrations,
with **no stability promise** — those symbols may change in any 0.x
release. If you find yourself depending on one, please open an issue so it
can be promoted to the root entry deliberately.

## Host integration notes

- **Keep the container inside the viewport.** Chromium throttles
  `requestAnimationFrame` in offscreen iframes; a `mount` that awaits an
  animation frame will hang (and the render request will time out) if the
  sandbox scrolls out of view.
- **Requests time out.** Host→sandbox requests (`render`, `requestUnmount`)
  default to 10 s; tune with `mountSandbox(..., { requestTimeoutMs })`.
- **One registry per sandbox.** Grants are bound at initialize. To change
  the capability surface, destroy and re-mount.
- **The bridge is the data layer's door.** Vivarium does not know what a
  schema is — wire your backend into capability handlers and keep the
  sandbox ignorant of everything else.

## Running the checks yourself

`npm test` runs the unit suite under plain Node. The behaviour that only a
real browser can show — the sandboxed iframe's opaque origin, the document
CSP closing the network, identity maintenance across live re-renders, and the
error codes a rejection carries back across the bridge — lives in harnesses
you serve and open:

```
node tools/dev-server.ts 8787          # strips types so the browser can import src/*.ts
# then open http://localhost:8787/test/e2e.html          (sandbox core)
#      and  http://localhost:8787/test/e2e-react.html    (react-tsx profile)
```

Each page reports pass/fail per assertion and leaves the same results on
`window.__E2E__` for a driver to read, so the harnesses can be run by hand or
from an automation script. They are not part of CI, which is why the pages
report rather than exit — a green CI run is not a claim that these passed.

## Where to go next

- [Edit context contract](edit-context.md) — the versioned shape your
  editing tools consume.
- [`@vivariumjs/agent`](https://github.com/iyulab/vivarium-agent) — a
  harness that turns edit context + natural language into verified
  changesets (never applies them).
- [`vivarium-changeset`](https://github.com/iyulab/vivarium-changeset) —
  the contract those changesets follow.
