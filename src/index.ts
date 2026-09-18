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
 *
 * One class of symbol is exempt, and it is not an exception to the rule so
 * much as a boundary on it: what the values above *throw* is part of the
 * contract they promise, not a feature grown on demand. A consumer cannot
 * handle a rejection without naming it, so leaving the error type and the
 * codes it carries behind an unstable entry does not withhold a feature —
 * it withholds the contract, and the consumer's only recourse is to import
 * from a surface that promises nothing or to hardcode a bare number.
 * Demand-driven growth governs what the package *does*; it does not govern
 * whether the package admits what it throws.
 */

export { mountSandbox } from "./sandbox/host.ts";
export type {
  SandboxOptions,
  SandboxProfile,
  SandboxHandle,
  SandboxIframeElement,
  SandboxContainerElement,
  ElementIdEntry,
  SandboxFault,
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

/**
 * What the surface above rejects with, and the codes a caller branches on.
 *
 * The list is the set of verdicts a host can act on differently, and no
 * wider: transport-level codes (PARSE_ERROR, INVALID_REQUEST) never reach a
 * caller — the endpoint answers those to the peer and they are not a verdict
 * on anything the host asked for. Exporting them would grow the list past
 * the number of cases anyone can branch on, which is the failure a short
 * vocabulary exists to avoid.
 */
export { RpcError } from "./bridge/protocol.ts";
export {
  CAPABILITY_DENIED,
  ENDPOINT_CLOSED,
  GENERATED_CODE_FAULT,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from "./bridge/protocol.ts";
