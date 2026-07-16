/**
 * JSON-RPC 2.0 framing for the Vivarium capability bridge.
 *
 * The bridge is the ONLY channel between sandbox and host (fixed principle 1).
 * Every message must be serializable; anything malformed is rejected, never
 * partially interpreted (fail-closed).
 */

export const JSONRPC_VERSION = "2.0";

/** Bridge protocol version, negotiated during the initialize handshake. */
export const BRIDGE_PROTOCOL_VERSION = "0.1";

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  result: unknown;
}

export interface RpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId | null;
  error: RpcErrorShape;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** JSON-RPC 2.0 reserved error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** Vivarium bridge error codes (implementation-defined range -32000..-32099). */
export const CAPABILITY_DENIED = -32000;
export const ENDPOINT_CLOSED = -32001;

export class RpcError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Classify an incoming message. Returns the message kind, or null when the
 * value is not a well-formed JSON-RPC 2.0 message (fail-closed: callers must
 * drop or error-respond, never guess).
 */
export type MessageKind = "request" | "notification" | "success" | "error";

export function classifyMessage(value: unknown): MessageKind | null {
  if (!isPlainObject(value) || value.jsonrpc !== JSONRPC_VERSION) return null;

  if (typeof value.method === "string") {
    if ("result" in value || "error" in value) return null;
    if ("id" in value) return isValidId(value.id) ? "request" : null;
    return "notification";
  }

  if ("result" in value) {
    if ("error" in value || "method" in value) return null;
    return isValidId(value.id) ? "success" : null;
  }

  if ("error" in value) {
    const err = value.error;
    if (!isPlainObject(err) || typeof err.code !== "number" || typeof err.message !== "string") {
      return null;
    }
    return isValidId(value.id) || value.id === null ? "error" : null;
  }

  return null;
}

export function makeRequest(id: RpcId, method: string, params?: unknown): RpcRequest {
  const msg: RpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function makeNotification(method: string, params?: unknown): RpcNotification {
  const msg: RpcNotification = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

export function makeSuccess(id: RpcId, result: unknown): RpcSuccessResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result: result === undefined ? null : result };
}

export function makeError(id: RpcId | null, code: number, message: string, data?: unknown): RpcErrorResponse {
  const error: RpcErrorShape = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}
