/**
 * @vivariumjs/runtime/internal — protocol plumbing, NO stability promise.
 *
 * Everything here is implementation surface the runtime uses to build the
 * public contract (see src/index.ts): JSON-RPC 2.0 message shapes and
 * factories, transports, the RPC endpoint, capability binding, the
 * host/guest lifecycle bridges, sandbox bootstrap HTML, host method names,
 * the stable-identity runtime, and the edit-context builder.
 *
 * It exists as an escape hatch for advanced integrations (e.g. custom
 * profile tooling or host shells that speak the bridge protocol directly).
 * Anything a consumer comes to rely on here should be reported upstream so
 * it can be promoted to the root entry deliberately — until then these
 * symbols may change or disappear in any 0.x release.
 */

export {
  JSONRPC_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  CAPABILITY_DENIED,
  ENDPOINT_CLOSED,
  RpcError,
  classifyMessage,
  makeRequest,
  makeNotification,
  makeSuccess,
  makeError,
} from "./bridge/protocol.ts";
export type {
  RpcId,
  RpcRequest,
  RpcNotification,
  RpcErrorShape,
  RpcSuccessResponse,
  RpcErrorResponse,
  RpcResponse,
  RpcMessage,
  MessageKind,
} from "./bridge/protocol.ts";

export { createTransportPair, createPostMessageTransport } from "./bridge/transport.ts";
export type {
  Transport,
  PostMessageTarget,
  PostMessageSource,
  MessageEventLike,
  PostMessageTransportOptions,
} from "./bridge/transport.ts";

export { RpcEndpoint } from "./bridge/endpoint.ts";
export type { MethodHandler, RpcEndpointOptions } from "./bridge/endpoint.ts";

export { CAPABILITY_METHOD_PREFIX, bindCapabilities, isValidCapabilityName } from "./bridge/capabilities.ts";

export {
  METHOD_INITIALIZE,
  METHOD_INITIALIZED,
  METHOD_UNMOUNT,
  createHostBridge,
  createGuestBridge,
} from "./bridge/lifecycle.ts";
export type {
  InitializeParams,
  InitializeResult,
  UnmountResult,
  HostBridge,
  HostBridgeOptions,
  GuestBridge,
  GuestBridgeOptions,
} from "./bridge/lifecycle.ts";

export {
  createBootstrapHtml,
  SANDBOX_ROOT_ID,
  SANDBOX_CSP,
  SANDBOX_CSP_WITH_MODULES,
} from "./sandbox/bootstrap.ts";
export type { BootstrapOptions } from "./sandbox/bootstrap.ts";

export {
  METHOD_RENDER,
  METHOD_INSPECT_IDS,
  METHOD_INSPECT_DESCRIBE,
  METHOD_SELECTION_SET,
  NOTIFICATION_SELECTION_CHANGED,
  SANDBOX_ATTRIBUTE,
} from "./sandbox/host.ts";

export { buildEditContext } from "./inspect/edit-context.ts";
export type { BuildEditContextInput } from "./inspect/edit-context.ts";

export {
  STABLE_ID_ATTRIBUTE,
  SYNTHESIZED_ID_PREFIX,
  createIdentityRuntime,
  assignStableIds,
  installStableIdentity,
} from "./identity/stable-id.ts";
export type { IdentifiableElement, IdentityMaintainer, IdentityRuntime } from "./identity/stable-id.ts";
