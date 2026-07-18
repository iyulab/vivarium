# Changelog

All notable changes to `@vivariumjs/runtime` are documented here.
Versioning: 0.x — minor for surface changes, patch for fixes.

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
