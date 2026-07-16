/**
 * Bridge lifecycle — the initialize/unmount handshake (vivarium ADR-0002).
 *
 * Shape borrowed from MCP Apps: the guest (sandboxed UI) requests
 * `vivarium/initialize`; the host answers with the protocol version, host
 * context, and the enumerated capability list. Before teardown the host
 * requests `vivarium/unmount`, giving the guest one chance to hand back
 * state to persist. Borrowed shape, not MCP spec dependence.
 */

import type { Transport } from "./transport.ts";
import { RpcEndpoint } from "./endpoint.ts";
import type { RpcEndpointOptions } from "./endpoint.ts";
import { CapabilityRegistry, bindCapabilities, CAPABILITY_METHOD_PREFIX } from "./capabilities.ts";
import type { CapabilityDescriptor } from "./capabilities.ts";
import { BRIDGE_PROTOCOL_VERSION, RpcError, INVALID_PARAMS } from "./protocol.ts";

export const METHOD_INITIALIZE = "vivarium/initialize";
export const METHOD_INITIALIZED = "vivarium/initialized";
export const METHOD_UNMOUNT = "vivarium/unmount";

export interface InitializeParams {
  /** Protocol version the guest bootstrap speaks. */
  protocolVersion: string;
}

export interface InitializeResult {
  protocolVersion: string;
  /** Host-provided context for the generated UI (opaque to the bridge). */
  context: unknown;
  /** Everything the guest is allowed to do — the audit list. */
  capabilities: CapabilityDescriptor[];
}

export interface UnmountResult {
  /** Guest state the host may persist and hand back on a later mount. */
  state?: unknown;
}

export interface HostBridgeOptions extends RpcEndpointOptions {
  /** Opaque context delivered to the guest at initialize. */
  context?: unknown;
  registry: CapabilityRegistry;
  /** Called when the guest completes the initialize handshake. */
  onInitialized?(params: InitializeParams): void;
}

export interface HostBridge {
  endpoint: RpcEndpoint;
  /** Whether the guest has completed the initialize handshake. */
  initialized(): boolean;
  /** Ask the guest to unmount; resolves with any state it wants persisted. */
  requestUnmount(): Promise<UnmountResult>;
  close(): void;
}

export function createHostBridge(transport: Transport, options: HostBridgeOptions): HostBridge {
  const endpoint = new RpcEndpoint(transport, options);
  let initialized = false;
  let handshake: InitializeParams | null = null;

  endpoint.expose(METHOD_INITIALIZE, (params) => {
    const shaped = params as Partial<InitializeParams> | undefined;
    if (typeof shaped?.protocolVersion !== "string") {
      throw new RpcError(INVALID_PARAMS, "initialize requires { protocolVersion: string }");
    }
    handshake = { protocolVersion: shaped.protocolVersion };
    const result: InitializeResult = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      context: options.context ?? null,
      capabilities: options.registry.list(),
    };
    return result;
  });

  // The handshake completes only when the guest confirms it received the
  // initialize result (MCP shape). Marking readiness at the request instead
  // would let the host race a render request ahead of its own initialize
  // response.
  endpoint.expose(METHOD_INITIALIZED, () => {
    if (!handshake) throw new RpcError(INVALID_PARAMS, "initialized before initialize");
    initialized = true;
    options.onInitialized?.(handshake);
  });

  bindCapabilities(endpoint, options.registry);

  return {
    endpoint,
    initialized: () => initialized,
    async requestUnmount(): Promise<UnmountResult> {
      const result = await endpoint.request(METHOD_UNMOUNT);
      if (result === null || result === undefined) return {};
      return result as UnmountResult;
    },
    close: () => endpoint.close(),
  };
}

export interface GuestBridgeOptions extends RpcEndpointOptions {
  /** Invoked when the host requests unmount; the return value is persisted. */
  onUnmount?(): unknown | Promise<unknown>;
}

export interface GuestBridge {
  endpoint: RpcEndpoint;
  /** Perform the initialize handshake; resolves with context + capabilities. */
  initialize(): Promise<InitializeResult>;
  /** Invoke a granted capability by name (without the `cap:` prefix). */
  invoke(capability: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export function createGuestBridge(transport: Transport, options: GuestBridgeOptions = {}): GuestBridge {
  const endpoint = new RpcEndpoint(transport, options);

  endpoint.expose(METHOD_UNMOUNT, async () => {
    const state = await options.onUnmount?.();
    const result: UnmountResult = state === undefined ? {} : { state };
    return result;
  });

  return {
    endpoint,
    async initialize(): Promise<InitializeResult> {
      const params: InitializeParams = { protocolVersion: BRIDGE_PROTOCOL_VERSION };
      const result = (await endpoint.request(METHOD_INITIALIZE, params)) as InitializeResult;
      endpoint.notify(METHOD_INITIALIZED);
      return result;
    },
    invoke(capability: string, params?: unknown): Promise<unknown> {
      return endpoint.request(CAPABILITY_METHOD_PREFIX + capability, params);
    },
    close: () => endpoint.close(),
  };
}
