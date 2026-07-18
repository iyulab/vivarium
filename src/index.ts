/**
 * @vivariumjs/runtime — public consumer surface.
 *
 * This entry is the documented consumer contract (docs/getting-started.md,
 * docs/edit-context.md): mount a sandbox, grant capabilities, receive edit
 * contexts. Values here are the API this package promises compatibility for;
 * the exported types are the closure reachable from those values' signatures.
 *
 * Protocol plumbing (JSON-RPC message shapes, transports, endpoints,
 * lifecycle bridges, bootstrap HTML, stable-identity runtime) lives behind
 * "@vivariumjs/runtime/internal" — see src/internal.ts. It carries no
 * stability promise; symbols are promoted here only on demonstrated
 * consumer demand (demand-driven growth).
 */

export { mountSandbox } from "./sandbox/host.ts";
export type {
  SandboxOptions,
  SandboxProfile,
  SandboxHandle,
  SandboxIframeElement,
  SandboxContainerElement,
  ElementIdEntry,
} from "./sandbox/host.ts";

export { CapabilityRegistry } from "./bridge/capabilities.ts";
export type { CapabilityDescriptor, CapabilityGrant } from "./bridge/capabilities.ts";

export { EDIT_CONTEXT_VERSION } from "./inspect/edit-context.ts";
export type {
  EditContext,
  EditContextSource,
  ElementSelection,
  ElementDescriptor,
  UntrustedElementData,
} from "./inspect/edit-context.ts";

// Types reachable from SandboxHandle / SandboxContainerElement signatures.
export type { HostBridge, UnmountResult } from "./bridge/lifecycle.ts";
export type { MessageEventLike } from "./bridge/transport.ts";
