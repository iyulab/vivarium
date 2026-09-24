# Vivarium

> Sandboxed runtime for AI-generated UI — render generated code safely, with stable element identity and inspection built in.

**Status: published on npm — [`@vivariumjs/runtime`](https://www.npmjs.com/package/@vivariumjs/runtime), 0.x** (pre-1.0: minor versions may change the surface — see the [changelog](https://github.com/iyulab/vivarium/blob/main/CHANGELOG.md)). This document is the project's anchor: it fixes purpose, scope, and the small set of principles that implementation must honor. The sandbox core, capability bridge, stable identity layer, execution profiles, and the [edit context contract](https://github.com/iyulab/vivarium/blob/main/docs/edit-context.md) are implemented and covered by unit + real-browser e2e tests.

**To embed it in your app, start with the [getting-started guide](https://github.com/iyulab/vivarium/blob/main/docs/getting-started.md)** (`npm install @vivariumjs/runtime`).
The shortest path, for a browser page with a `#canvas` element:

```ts
import { mountSandbox, CapabilityRegistry } from "@vivariumjs/runtime";

const registry = new CapabilityRegistry();
registry.grant({ name: "greeting.get", description: "a line of text" }, () => "Hello");

const sandbox = mountSandbox(document.getElementById("canvas") as HTMLElement, { registry });
await sandbox.whenReady();
await sandbox.render(`
  export default async function mount(root, api) {
    root.textContent = await api.invoke("greeting.get");
  }
`);
```

**Supported Node**: the package declares `engines.node >= 20`, and CI runs a fresh
consumer install on that floor every build — the floor is executed, not just claimed.
It is a *supported* floor, not a recommendation: Node 20 reached end-of-life on
2026-04-30, so an actively supported release line is the better choice for new work.

---

## Why

AI can now write UI code on demand. What it cannot do is be *trusted* — and neither can the code it writes. Today there are two ways to run AI-generated UI, and both are wrong:

1. **Invent a declarative DSL** and interpret it. Safe, but it caps expressiveness at whatever the DSL anticipated. Every real-world app eventually needs the escape hatch the DSL doesn't have.
2. **Run the generated code as-is.** Fully expressive, but the generated code inherits the privileges of its host — data access, network, DOM — with no boundary between "what the AI wrote" and "what the platform allows."

Vivarium takes the third path: **generated code runs with full expressiveness inside a hard isolation boundary, against a capability surface the host explicitly grants.** The code is real code. The boundary is real too.

A second, equally important problem: once generated UI is on screen, humans point at it. "Make *this* textbox bigger." For an agent to act on that, every rendered element must be *addressable* — stably identified, mappable back to its source, and serializable as context for the next edit. Inspection is not a devtool bolted on later; it is half the reason this runtime exists.

## What Vivarium is

- **An execution sandbox.** Generated UI code runs in an isolated realm. It cannot reach the host page, host storage, or the network except through the bridge the host installs.
- **A capability bridge.** The only channel between sandbox and host. The host decides what the generated code may do and hear: which data APIs it can call, which events it can emit, which host events it can subscribe to. Nothing is ambient.
- **Execution profiles.** Which libraries generated code may import, and how its source is transformed before it runs, is data the host supplies — an embedded import map plus a source transform. What generated code can compose is therefore enumerable, not whatever a CDN happens to serve.
- **An identity and inspection layer.** Every rendered element is addressable, under two names with two honest lifetimes. Its **ID** is an address: an ID the generated code authored (`data-viv-id`) is durable across re-renders and re-generations, while a synthesized one names a position in the current render. Its **reference** names that one element for as long as it lives and is never re-pointed — when the element is gone, the runtime refuses the reference instead of describing whatever took its place. Users can select elements; selections serialize into an **edit context** — a machine-readable description of "what the user is pointing at, in which screen, backed by which source" — consumable by any editing agent.
- **A no-build path from generation to pixels.** Generated code renders without an offline compile/bundle/deploy cycle. Changes appear in seconds, not pipelines.

## What Vivarium is not

- **Not a page-builder GUI.** There is no drag-and-drop editor here. Vivarium renders and inspects; authoring is someone else's job (a human, or an agent such as `vivarium-agent`).
- **Not an agent.** Vivarium never calls a model. It produces edit contexts and consumes code; what happens between the two is out of scope.
- **Not a data layer.** Vivarium does not know what a schema is. Data arrives through the capability bridge from whatever backend the host wires in.
- **Not a design system.** Profiles define *capability*, not *appearance*. Theming and visual identity belong to the host.

## Fixed principles

These are the anchors. An implementation that violates one of these is not Vivarium.

1. **The sandbox boundary is absolute.** No configuration flag may grant generated code direct host access. If the bridge doesn't expose it, it doesn't exist.
2. **Capabilities are explicit and enumerable.** The host grants; the sandbox requests; nothing is ambient. An agent (or auditor) can list everything a piece of generated UI is able to do.
3. **Every element is addressable.** Stable identity is mandatory, not optional. Code without identity annotations is still runnable, but the runtime synthesizes and maintains IDs regardless.
4. **The edit context is a public contract.** Its shape is versioned and documented, because external tools (agents, editors, tests) depend on it.
5. **Generation-to-render is measured in seconds.** Any design that reintroduces an offline build step between "the agent wrote code" and "the user sees it" is a regression.

## Decided in v0

- Isolation: a sandboxed iframe (opaque origin, `allow-scripts` only) with a
  `default-src 'none'` document CSP — network egress is closed; the bridge is
  the only channel. A host may let generated UI display images or media from
  `data:`/blob: URLs it builds inside the sandbox (`inlineSources`); no option
  opens a network source.
- Bridge: JSON-RPC 2.0 over postMessage; capabilities surface as enumerable
  `cap:<name>` methods granted by the host, and host events travel the other
  way as `evt:<name>` notifications — granted by name, subscribed to by name.
- Generated code: ES modules, default-exporting `mount(root, api)`. Execution
  profiles are pluggable data (embedded module import map + host-side source
  transform); the reference profile is React + TSX via Sucrase. It is built
  from this repository ([`test/react-tsx-profile.js`](https://github.com/iyulab/vivarium/blob/main/test/react-tsx-profile.js),
  [`tools/build-profile-assets.ts`](https://github.com/iyulab/vivarium/blob/main/tools/build-profile-assets.ts))
  and is not part of the npm package; without a profile, generated code is a
  plain ES module working on the DOM.
- Identity: deterministic structural ids (`viv:tag[n]/…`), authored
  `data-viv-id` preserved with descendants anchored under it; per-element
  references (`ref:<n>`, never reused) for holding a selection.
- Edit context: versioned public contract — see [docs/edit-context.md](https://github.com/iyulab/vivarium/blob/main/docs/edit-context.md).

### Host integration note

Keep the sandbox container inside the viewport. Chromium throttles
`requestAnimationFrame` in offscreen iframes, so an artifact whose `mount`
awaits an animation frame will hang (and the render request will time out)
if the host page lets the sandbox scroll out of view.

## Deliberately undecided

- Whether and how third-party component whitelisting works
- A curated primitive surface (inputs, lists, layout, data views) above the
  profiles — versioned and enumerable, so agents can be taught exactly what
  exists. Not built: today generated code composes the DOM or a profile's library.
- State handover across re-renders (the unmount path exists; re-render does not yet offer the outgoing module a save opportunity)

## Relationship to MCP Apps

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), the Model Context Protocol's UI
extension, and Vivarium share an isolation and transport shape: generated UI runs in a sandboxed
iframe and talks to its host over JSON-RPC on `postMessage`, starting with an initialize handshake.
They answer different questions. MCP Apps delivers a server's UI into a conversation host.
Vivarium makes every element of a generated screen addressable, turns what the user points at into
an edit context, and lets the change travel as a reviewable changeset.

Vivarium does not implement MCP Apps, and no MCP host is needed to use it. Connecting the two is
adapter work on the consuming side. One difference decides what such an adapter can carry: an MCP
App view may declare the network origins it needs (`_meta.ui.csp`), while Vivarium's sandbox opens
no network source under any option. A view that depends on the network cannot run unchanged inside
it; its data has to arrive through granted capabilities instead.

## Relationship to the Vivarium family

A running instance of the family — propose, preview, approve, apply, roll back — is
browsable as a gallery of archived runs: [vivarium-gallery](https://github.com/iyulab/vivarium-gallery)
([live](https://iyulab.github.io/vivarium-gallery/)). Each exhibit keeps the final artifacts, the
turn ledger and the rollback record of an actual run, so the claims above can be checked
rather than taken on faith.


Vivarium is the family's namesake and its only browser-side member. It depends on **nothing** except, where changesets are exchanged, the [`vivarium-changeset`](https://github.com/iyulab/vivarium-changeset) contract. It is consumed by hosts directly, and its edit context is the input format of [`vivarium-agent`](https://github.com/iyulab/vivarium-agent).

Standalone use is a first-class scenario: *"embed safely-sandboxed, AI-generated UI in an existing product"* requires this repo and nothing else.

## License

MIT. The runtime is and will remain free, fully functional, and offline-capable — no accounts, no feature gates.