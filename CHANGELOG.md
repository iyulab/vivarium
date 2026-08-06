# Changelog

All notable changes to `@vivariumjs/runtime` are documented here.
Versioning: 0.x — minor for surface changes, patch for fixes.

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
