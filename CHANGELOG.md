# Changelog

All notable changes to `@vivariumjs/runtime` are documented here.
Versioning: 0.x — minor for surface changes, patch for fixes.

## 0.7.0 — 2026-09-24

### Added
- `CapabilityRegistry.onChange(listener)` — follow grants and revokes; returns an
  unsubscribe function. Exported type `CapabilityChange`.

### Fixed
- `registry.revoke(name)` now takes effect on a bridge that is already up. Before,
  the host bridge copied the granted handlers at construction, so after a revoke the
  registry reported the capability as gone while the generated UI could still call it.
  The next call is now `METHOD_NOT_FOUND`, the same as a capability that was never
  granted. A `grant` made after mount becomes invocable on the live bridge too.
  Closing the host bridge stops it following the registry.
- Element names no longer lose the letter `s`. The accessible name reported by
  `describeElements` and carried in the edit context (`untrusted[id].name`) had
  every `s` removed, because the name's whitespace pattern lost its escape on the
  way into the sandbox (`"Open orders"` came back as `"Open order "`). Whitespace
  runs still collapse to one space.

### Changed
- README: a quickstart example (the one example inside the package), a section on how
  Vivarium relates to MCP Apps, and corrected claims — the curated primitive surface is
  listed as undecided rather than built, and the React + TSX reference profile is said to
  be built from the repository, not shipped in the package.
- Type comments point at published documentation URLs instead of files the package does
  not contain.

## 0.6.0 — 2026-09-23

### Changed
- **Edit context 0.2 — `screen` carries the selection's neighbourhood, not the whole screen.**
  `screen.elementIds` (every addressable element, in document order) is replaced by
  `screen.elements`: the selected elements, their ancestors, siblings and children, each
  entry saying which it is (`relation`) and what ARIA role it carries (`role`, explicit or
  implicit, `null` rather than a guess). The old field grew with the data rather than the
  code — measured on a 354-element screen it was 61% of the context at 20.8KB while the
  source being edited was 39%; it is now 452 bytes and 3%, and the source is 94%.
- **`untrusted` entries carry the element's accessible name.** A name is screen-derived
  content, so it sits with the rest of the screen's words under the injection-defense
  boundary (contract section 3) rather than beside the structure.
- `createEditContext` asks the guest once instead of twice. The selection and its
  surroundings have to describe the same DOM; two calls left room for a render in between.

> **This is not an additive minor.** A consumer written against edit context 0.1 must reject
> 0.2 rather than read it. `@vivariumjs/agent` 0.3.0 is the updated consumer.

## 0.5.0 — 2026-09-20

> Minor, additive for hosts. The only removal is on `/internal`, which carries no compatibility promise.

### Added
- **`SandboxOptions.inlineSources: { images?, media? }`** — let generated UI display images and/or audio/video from `data:`
  URLs and blob: URLs it builds inside the sandbox, typically from bytes a granted capability returned. Adds
  `img-src data: blob:` / `media-src data: blob:` to the sandbox CSP. No option opens a network source, and the default
  is unchanged: without it, no image or media source loads at all. `InlineSources` type exported.

### Changed
- `/internal`: the sandbox CSP is derived by `sandboxCsp({ modules, inlineSources })`. `SANDBOX_CSP_WITH_MODULES` is
  removed (use `sandboxCsp({ modules: true })`); `SANDBOX_CSP` remains the default policy.

### Docs
- getting-started "Pictures and media: bytes over the bridge" — serving image bytes through a capability, building a
  blob URL in the sandbox, and what each switch opens.
- getting-started "Without a bundler, or from `file://`" — constraints of a host page opened from disk: data and generated
  code arrive as classic scripts, writes stay in capability handlers, failures and permission prompts belong in host UI.

## 0.4.0 — 2026-09-19

> Minor, **breaking for hosts** that pass ids to `createEditContext` or expect
> `describeElements` to drop misses: see Changed. The edit context contract (0.1) is unchanged.

### Changed
- **Elements have two names now: an id (an address) and a reference (the element).** `listIds()` entries, `describeElements()`
  results and `onSelectionChanged` descriptors carry `ref` — issued once per element, never reused, never re-pointed.
- **`createEditContext()` takes references, not ids.** It follows each element to the id it carries now, and rejects with the new
  `STALE_ELEMENT_REFERENCE` (-32003, `data.refs` lists which) when an element is gone — removed, or replaced by a later `render()` —
  instead of describing whatever took its place. Passing an id where a reference belongs is `INVALID_PARAMS`.
- **`describeElements()` answers once per id, in order, with `null` where nothing carries that id** — a missing id was silently
  dropped, leaving a shorter list with no way to tell which one went missing.

### Added
- `STALE_ELEMENT_REFERENCE` error code (exported from the package root and the classic build).

### Docs
- README states the two lifetimes precisely: authored ids are durable across re-renders and re-generations, synthesized ids name a
  position in the current render. getting-started "IDs are addresses, references are elements" · error table row · edit-context
  contract §2 (references resolve to current ids; the context still carries ids only) and §3.4 (labels are provenance cues, not a
  security boundary).

### CI
- **Publish workflow** is rerun-safe and its registry check is conclusive: the publish step skips a version that is
  already live, the verification retries with `--prefer-online` (the registry's metadata cache otherwise re-serves the
  first 404 for its five-minute lifetime) over a ~10-minute window, and an exhausted window fails with the reason.

## 0.3.0 — 2026-09-18

> Published as `@vivariumjs/runtime@0.3.0`, tag `v0.3.0`.
> Minor: the host handle, the capability registry and the generated code's `api` all
> gain members. Nothing existing changes shape.

### Added
- **Faults after mount reach the host.** A screen can render and still be broken —
  a click handler that throws, a timer that throws, a capability call nobody awaited.
  None of these reject `render()`, and the host could not see them at all: they
  happen inside an opaque-origin document it cannot reach. `SandboxHandle.onFault`
  now delivers them as `SandboxFault { kind: "error" | "unhandledrejection", message,
  stack }`, with the text length-capped and documented as untrusted data authored by
  the generated code. A throw during mount stays `render()`'s `GENERATED_CODE_FAULT`
  rejection and is not reported twice. Together with `listIds()` and
  `describeElements()` this completes a headless check: render, interact, read ids,
  text and faults.
- **A single-file classic build for pages that cannot load modules.** A page opened
  from `file://` has an opaque origin and module scripts are fetched with CORS, so the
  ESM entry never loads there — import map or not. `dist/vivarium.iife.js` is the
  package root bundled into one classic script that assigns the global `Vivarium`,
  resolvable as `@vivariumjs/runtime/vivarium.iife.js` and named in the
  `unpkg`/`jsdelivr` fields. CI checks that it parses as a classic script and carries
  exactly the root's exports.
- **The host can push events into the sandbox.** The bridge ran one way for
  application traffic: generated code could ask (`api.invoke`), but a screen that
  had to follow host state — a media element's position, a file that just arrived —
  could only poll. `registry.grantEvent({ name, description })` grants an event,
  `SandboxHandle.emit(name, payload)` delivers it, and the generated code subscribes
  with `api.on(name, handler)` (returns unsubscribe) and enumerates grants with
  `api.events`. The capability discipline holds in the other direction: an ungranted
  name does not exist — `emit` rejects with `INVALID_PARAMS`, `api.on` throws at the
  call — and `registry.listEvents()` completes the audit list. A new render ends the
  previous module's subscriptions; a handler that throws arrives through `onFault`.
  `InitializeResult` gains `events`.

### Fixed
- **`CAPABILITY_DENIED` says what it is for.** The constant was public and documented as
  "a capability invocation was refused — grant it", the same advice as
  `METHOD_NOT_FOUND`, yet the runtime never raised it. It is the host's word: a granted
  capability refusing one call throws `new RpcError(CAPABILITY_DENIED, reason)` from its
  handler, and the generated code's `api.invoke` rejects with it. An ungranted
  capability stays `METHOD_NOT_FOUND` — there was nothing to refuse. The error-code
  table no longer lists it among the codes a host receives, and a section shows the
  handler side.

## 0.2.0 — 2026-08-06

> Published as `@vivariumjs/runtime@0.2.0`, tag `v0.2.0`.
> Minor rather than patch: this release widens the public surface and moves
> two cases between published error codes.

### Added
- **A failure in the supplied code is no longer reported as the runtime's.** Generated
  code that will not load, does not default-export `mount(root, api)`, or throws while
  mounting used to arrive as `-32602` (invalid params) or `-32603` (internal error).
  Both are wrong, and in opposite directions: the values handed over were well formed —
  the code arrived as the string it had to be, and only executing it revealed the
  fault — while the runtime itself was fine. A caller reading either code looks in the
  wrong place, and the second is a report nothing can be done with. These now report
  `GENERATED_CODE_FAULT` (`-32002`), taken from the range the bridge already reserves
  for its own codes. The classification is scoped to the render path: a failure
  elsewhere in generated code — an `onUnmount` provider that throws — still reports
  `-32603`, because a code meaning "anything the guest runs" would be the same
  catch-all under a better name.

  **Behavior change on published error codes.** A consumer branching on `-32602` to
  catch a missing default export, or on `-32603` to catch a mounting failure, will
  stop matching them; both are now `-32002`.

- **The package admits what it throws.** `RpcError` and the codes it carries were
  reachable only through `@vivariumjs/runtime/internal`, which promises no stability —
  so handling a rejection meant importing from an unstable surface or hardcoding a
  bare number. `RpcError`, `CAPABILITY_DENIED`, `ENDPOINT_CLOSED`,
  `GENERATED_CODE_FAULT`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, and `INTERNAL_ERROR`
  are now exported from the root entry. Transport-level codes stay behind the internal
  entry — they are answered to the peer and are never a verdict on what the caller
  asked for.

### Fixed
- **A rejected call now says whose call was wrong.** Every failure inside the sandbox
  was reported as `-32603` (internal error), including the ones the runtime raises
  precisely because the request was malformed — a missing `code` parameter, a
  `describe` without its `ids`, generated source that is not a module default-exporting
  `mount(root, api)`. A caller reading that code has no way to tell "my input" from
  "the runtime broke", so the only remaining signal was the message text. Those four
  checks now report `-32602` (invalid params), the code the bridge's own handshake has
  always used for the same class of failure. Failures the runtime did not classify —
  including generated code that throws while it runs — still report `-32603`, and that
  distinction is what makes the new one worth reading.

  **Behavior change on a published error code.** A consumer branching on `-32603` to
  catch malformed requests will stop matching them; the fix is to branch on `-32602`,
  or on both while migrating.

- **Every call on a destroyed sandbox reports the same closed channel.** The six
  `SandboxHandle` methods each threw a bare `Error` carrying no code, while the
  endpoint underneath reported `-32001` for the very same condition — so whether a
  caller racing teardown could branch on a code depended on which side won the race.
  All six now reject with that code. The message is unchanged.

- **Documentation shipped with the package points at the repository.** The README's
  relative links resolved to paths the published tarball does not carry (`files` is
  `dist` only), so on the package page they led nowhere. `docs/` gains a section
  stating the codes a caller can meet and what each one means for them.

## 0.1.0

- **Public surface repartition.** The package root now exports exactly the
  documented consumer contract: `mountSandbox`, `CapabilityRegistry`,
  `EDIT_CONTEXT_VERSION`, plus the types reachable from their signatures
  (`SandboxOptions`, `SandboxHandle`, `SandboxProfile`, `EditContext`,
  `ElementDescriptor`, `CapabilityGrant`, …).
- **New `@vivariumjs/runtime/internal` subpath.** Protocol plumbing that
  the root previously exported (JSON-RPC constants/factories, transports,
  `RpcEndpoint`, lifecycle bridges, bootstrap HTML, host method names,
  stable-identity runtime, `buildEditContext`) moved here, with no
  stability promise. If you relied on any of these from the root, switch
  the import to `@vivariumjs/runtime/internal` and open an issue so the
  symbol can be considered for deliberate promotion.
- No runtime behavior changes.

## 0.0.1

- Initial npm release: sandboxed iframe runtime (fail-closed CSP),
  capability bridge (JSON-RPC 2.0 over postMessage), stable element
  identity, edit-context contract v0.1, pluggable execution profiles.
