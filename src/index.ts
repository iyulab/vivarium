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

export {
  CAPABILITY_METHOD_PREFIX,
  CapabilityRegistry,
  bindCapabilities,
  isValidCapabilityName,
} from "./bridge/capabilities.ts";
export type { CapabilityDescriptor, CapabilityGrant } from "./bridge/capabilities.ts";

export {
  METHOD_INITIALIZE,
  METHOD_UNMOUNT,
  createHostBridge,
  createGuestBridge,
} from "./bridge/lifecycle.ts";

export { createBootstrapHtml, SANDBOX_ROOT_ID, SANDBOX_CSP } from "./sandbox/bootstrap.ts";
export { mountSandbox, METHOD_RENDER, METHOD_INSPECT_IDS, SANDBOX_ATTRIBUTE } from "./sandbox/host.ts";
export type {
  SandboxOptions,
  SandboxHandle,
  SandboxIframeElement,
  SandboxContainerElement,
  ElementIdEntry,
} from "./sandbox/host.ts";

export {
  STABLE_ID_ATTRIBUTE,
  SYNTHESIZED_ID_PREFIX,
  createIdentityRuntime,
  assignStableIds,
  installStableIdentity,
} from "./identity/stable-id.ts";
export type { IdentifiableElement, IdentityMaintainer, IdentityRuntime } from "./identity/stable-id.ts";
export type {
  InitializeParams,
  InitializeResult,
  UnmountResult,
  HostBridge,
  HostBridgeOptions,
  GuestBridge,
  GuestBridgeOptions,
} from "./bridge/lifecycle.ts";
