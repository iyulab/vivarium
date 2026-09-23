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

### Without a bundler, or from `file://`

The package also ships one classic script, `dist/vivarium.iife.js`, that
assigns the global `Vivarium` — the same exports as the package root:

```html
<script src="./vivarium.iife.js"></script>
<script>
  const registry = new Vivarium.CapabilityRegistry();
  const sandbox = Vivarium.mountSandbox(document.getElementById("stage"), { registry });
</script>
```

This is the build to use when the host page is opened straight from disk.
A `file://` page has an opaque origin and module scripts are fetched with
CORS, so `<script type="module">` never loads there — an import map does not
change that. A classic script does, and the sandbox works unchanged.

To copy the file next to a page you generate, resolve it through the
package: `import.meta.resolve("@vivariumjs/runtime/vivarium.iife.js")`. CDNs
that read the `unpkg`/`jsdelivr` fields serve it as the package's default
file.

A page opened from disk has a few more constraints than a served page:

- **Data arrives as scripts, in order.** `fetch` cannot read a sibling file
  from a `file://` page, but a classic `<script src>` can: data written as
  `window.APP_DATA = {…}` is loaded that way. Plain classic scripts run in
  document order, so list the data scripts before the one that mounts. If
  you insert scripts dynamically (an optional file, say), await each
  `load` event, or its `error` event if the file may be missing, before you
  call `render`. The capability handlers then serve the data from the global.
- **Generated code arrives as a script too.** `render` takes source text,
  and a `file://` page cannot fetch that either. Ship the generated module
  inside a classic script, as a string (`window.APP_SOURCE = "export default
  …"`) or as a self-contained function whose source you render:
  `render("export default " + window.APP_MOUNT.toString())`. The function
  runs in the sandbox, not in the page. It must use nothing it closes over,
  and nothing but its `root` and `api` arguments.
- **Writes stay in the host.** If the page saves back to disk (File System
  Access), keep the directory handle and every write in capability
  handlers. The generated code only asks, for example `api.invoke("notes.save", …)`,
  and never sees a handle. Before accepting a folder the user picked, check
  that it holds the files the page came from. `entries()` on a directory
  handle is an async iterator, so walk it with `for await`.
- **Show failures in the host's own UI.** Subscribe to `onFault` before the
  first `render`, and catch a rejected `render`. A page opened from disk has
  no one watching its console, so both should reach a banner the user can
  read (§5).
- **Ask for permissions from the host's own UI.** A click inside the
  sandbox does count as user activation for the host page. HTML
  propagates activation to ancestor frames, so a picker opened from a
  capability handler that the click triggered is allowed. Still, prefer a
  button in the host's own UI for prompts like a folder picker. The user
  then knows it is the page asking, not the generated code.

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
| `api.events` | The granted event descriptors, enumerable |
| `api.on(name, handler)` | Subscribe to a granted host event; returns unsubscribe |
| `api.onUnmount(provider)` | Register state to hand back when the host unmounts |

Calling a capability that was never granted rejects: the method simply does
not exist on the bridge (`METHOD_NOT_FOUND`) — the generated code cannot
escalate.

### Pushing host state in: events

Capabilities are the generated code asking; events are the host telling.
When the screen has to follow something that lives in the host — a media
element's position, a file that just arrived, a job's progress — grant an
event and emit it, rather than having the code poll:

```ts
const playerRegistry = new CapabilityRegistry();
playerRegistry.grantEvent({
  name: "audio.position",
  description: "Playback position in seconds, pushed while playing.",
});

const player = mountSandbox(document.getElementById("player")!, {
  registry: playerRegistry,
});
await player.render(`
  export default function mount(root, api) {
    const out = document.createElement("output");
    root.append(out);
    api.on("audio.position", (payload) => {
      out.textContent = payload.t.toFixed(1) + "s";
    });
  }
`);

await player.emit("audio.position", { t: 12.5 });
```

The discipline is the capability one, turned around. Only a granted name
exists: `emit` rejects an ungranted one with `INVALID_PARAMS`, and `api.on`
throws for it at the call, so a typo is an error rather than a handler that
never fires. `registry.listEvents()` and `api.events` enumerate what the
generated UI can hear, as `list()` and `api.capabilities` enumerate what it
can do. Grant before mounting — the list travels at initialize.

Delivery is fire-and-forget: nothing is answered, and an event nobody
subscribed to reaches nobody. A new `render()` ends the previous module's
subscriptions. A handler that throws is the generated code failing after
mount, and arrives through `onFault` (§5).

### Pictures and media: bytes over the bridge

By default the sandbox loads no image and no audio or video at all — not
even a `data:` URL. The CSP that closes the network sets no `img-src` and
no `media-src`. When your data has pictures, opt in with `inlineSources`
and serve the bytes through a capability. The generated code turns them
into a URL that exists only inside the sandbox:

```ts
const photoRegistry = new CapabilityRegistry();
photoRegistry.grant(
  { name: "photo.bytes", description: "One photo's bytes, by id." },
  async (params) => {
    const { id } = params as { id: string };
    return { type: "image/jpeg", base64: await loadPhotoBase64(id) };
  },
);

const album = mountSandbox(document.getElementById("album")!, {
  registry: photoRegistry,
  inlineSources: { images: true },
});
await album.render(`
  export default async function mount(root, api) {
    const photo = await api.invoke("photo.bytes", { id: "p1" });
    const bytes = Uint8Array.from(atob(photo.base64), (c) => c.charCodeAt(0));
    const img = document.createElement("img");
    img.src = URL.createObjectURL(new Blob([bytes], { type: photo.type }));
    root.append(img);
  }
`);

declare function loadPhotoBase64(id: string): Promise<string>;
```

`inlineSources.images` adds `img-src data: blob:`, and `inlineSources.media`
adds `media-src data: blob:` for `<audio>` and `<video>`. These are the only
sources either switch opens. A `data:` URL, or a blob URL the sandbox made
itself, reaches nothing outside the frame, so the bridge stays the only way
bytes get in. An `https:` image is still refused whatever you pass, and no
option takes a source list, so no configuration can open one. For long
media you may still prefer playing it in the host and pushing its position
in with an event, as above.

## 3. Inspect: selections become edit contexts

Every rendered element is addressable, so users can point at things and
agents can act on the pointing. Enable click-to-select and turn selections
into a versioned [edit context](edit-context.md):

```ts
await sandbox.setSelectionMode(true);

const unsubscribe = sandbox.onSelectionChanged(async (element) => {
  const editContext = await sandbox.createEditContext([element.ref]);
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

### IDs are addresses, references are elements

Every element comes with two names, and they live differently:

| | `id` | `ref` |
| --- | --- | --- |
| What it names | Whatever stands at that address now | This one element |
| Survives a re-render | Authored ids (`data-viv-id`): yes. Synthesized ids (`viv:…`): only while the structure is the same | No — a render replaces every element |
| When the structure shifts | A synthesized id moves to whichever element now holds the position | Follows the element to its new id |
| When it is gone | `describeElements` answers `null` for it | `createEditContext` rejects with `STALE_ELEMENT_REFERENCE` |

Hold a **ref** for "what the user pointed at": if a list grows above the
selected row, the ref still means that row, where the old id would now mean
its neighbor. Use **ids** to talk about places — they are what the edit
context carries, and what an authored `data-viv-id` makes durable.

After `render()` every held ref is stale. The runtime cannot know which
element of the new screen "is" the old one, so it says so instead of guessing:

```ts
import { STALE_ELEMENT_REFERENCE } from "@vivariumjs/runtime";

async function contextFor(selectedRefs: string[]) {
  try {
    return await sandbox.createEditContext(selectedRefs);
  } catch (err) {
    if (err instanceof RpcError && err.code === STALE_ELEMENT_REFERENCE) {
      // data.refs lists the ones that are gone: drop them, ask the user again.
      return null;
    }
    throw err;
  }
}
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
import {
  RpcError,
  ENDPOINT_CLOSED,
  GENERATED_CODE_FAULT,
  INVALID_PARAMS,
} from "@vivariumjs/runtime";

async function renderAndReport(code: string): Promise<string> {
  try {
    await sandbox.render(code);
    return "rendered";
  } catch (err) {
    if (!(err instanceof RpcError)) throw err;
    switch (err.code) {
      case INVALID_PARAMS:
        return "the call itself was malformed; fix the request";
      case GENERATED_CODE_FAULT:
        return "the generated code failed; regenerate it";
      case ENDPOINT_CLOSED:
        return "the sandbox was torn down; mount a new one";
      default:
        return `render failed: ${err.message}`;
    }
  }
}
```

| Code | Constant | Meaning | Who can act |
| --- | --- | --- | --- |
| `-32601` | `METHOD_NOT_FOUND` | The method does not exist — e.g. invoking a capability that was never granted | Host: grant it, or stop calling it |
| `-32602` | `INVALID_PARAMS` | The request was rejected as given — malformed params | Caller: send something else |
| `-32003` | `STALE_ELEMENT_REFERENCE` | An element reference outlived its element — removed, or replaced by a later `render()`. `data.refs` lists which | Caller: drop those refs and select again |
| `-32002` | `GENERATED_CODE_FAULT` | The request was fine and the runtime is fine; the supplied code would not load, does not default-export `mount(root, api)`, or threw while mounting | Whoever produced the code: regenerate it |
| `-32001` | `ENDPOINT_CLOSED` | The handle was destroyed, or its endpoint closed | Caller: mount a new sandbox |
| `-32603` | `INTERNAL_ERROR` | Everything else — the runtime's own failure | Report it; the message is the detail |

The distinction that matters is three-way, not two. `-32602` says the call was
wrong. `-32002` says the call was right and the code you supplied was not —
which is a different party, and usually a different fix. `-32603` says neither,
and is the only one a caller can do nothing about.

`GENERATED_CODE_FAULT` covers the render path. A failure elsewhere in generated
code — an `api.onUnmount` provider that throws, say — is still reported as
`-32603`.

### Refusing one call: `CAPABILITY_DENIED`

One code in the list above never reaches the host, because the host is the one
who sends it. A granted capability can still refuse a particular call — a
permission it checks, a quota, a state it will not act in. Throw
`CAPABILITY_DENIED` from the handler and the generated code's `api.invoke`
rejects with it:

```ts
import { CAPABILITY_DENIED } from "@vivariumjs/runtime";

registry.grant(
  { name: "orders.cancel", description: "Cancel an order the user owns." },
  (params) => {
    const { id } = params as { id: string };
    if (!id.startsWith("mine-")) {
      throw new RpcError(CAPABILITY_DENIED, `order ${id} is not yours to cancel`);
    }
    return { cancelled: id };
  },
);
```

This is not the ungranted case. A capability that was never granted does not
exist, so calling one is `METHOD_NOT_FOUND` — there was nothing to refuse.
Keeping the two apart is what lets generated code tell *"not this time"* (show
the reason) from *"no such thing"* (the code is wrong). Any other exception
thrown from a handler reaches the generated code as `INTERNAL_ERROR`.

### Faults after mount

A screen can render and still be broken: a click handler that throws, a timer
that throws, a capability call nobody awaited. None of these reject
`render()` — they happen later, inside a document the host cannot reach. The
sandbox reports them instead:

```ts
import type { SandboxFault } from "@vivariumjs/runtime";

const faults: SandboxFault[] = [];
const stopFaults = sandbox.onFault((fault) => faults.push(fault));

await sandbox.render(
  "export default (root) => { root.onclick = () => { throw new Error('oops'); }; }",
);
// ...interact with the screen, then read what went wrong:
for (const fault of faults) {
  console.warn(`${fault.kind}: ${fault.message}`);
}
stopFaults();
```

`kind` is `"error"` (an exception thrown from a listener or timer) or
`"unhandledrejection"` (a promise nobody handled). A throw during mount is
**not** reported here — it is `render()`'s `GENERATED_CODE_FAULT` rejection, and
reporting it twice would count one failure as two. Subscribe before `render()`
to see everything the render led to.

`message` and `stack` are written by the generated code, so treat them the way
the edit context treats screen content: untrusted data to show or to hand a
model inside a fence, never something to interpret. Both are length-capped, and
`stack` is `null` when the thrown value had none (`throw "text"`).

Together with `listIds()` and `describeElements()` this makes a complete
headless check — render, interact, then read the ids, the text, and the faults.

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
npm run build && node tools/build-profile-assets.ts   # once: the classic build and profile assets
npm run test:e2e                                       # opens every harness in a real browser
```

`test:e2e` drives the Chrome, Edge, or Chromium already installed (it downloads
none) and exits non-zero on any failed assertion; CI runs it on every push.
To watch one page instead, serve the repository and open it:

```
node tools/dev-server.ts 8787          # strips types so the browser can import src/*.ts
# then open http://localhost:8787/test/e2e.html          (sandbox core)
#      and  http://localhost:8787/test/e2e-react.html    (react-tsx profile)
# test/e2e-file.html is opened straight from disk (file://), no server
```

Each page reports pass/fail per assertion and leaves the same results on
`window.__E2E__`, which is what the runner reads.

## Where to go next

- [Edit context contract](edit-context.md) — the versioned shape your
  editing tools consume.
- [`@vivariumjs/agent`](https://github.com/iyulab/vivarium-agent) — a
  harness that turns edit context + natural language into verified
  changesets (never applies them).
- [`vivarium-changeset`](https://github.com/iyulab/vivarium-changeset) —
  the contract those changesets follow.
