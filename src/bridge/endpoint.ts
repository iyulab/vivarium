/**
 * RpcEndpoint — one end of the capability bridge.
 *
 * Symmetric: both host and sandbox sides are endpoints. An endpoint can
 * expose methods (dispatch incoming requests) and issue requests to its
 * peer. Dispatch is fail-closed: a method that was never exposed does not
 * exist (METHOD_NOT_FOUND), and malformed messages are rejected without
 * interpretation.
 */

import type { Transport } from "./transport.ts";
import type { RpcId, RpcRequest, RpcNotification, RpcResponse, RpcErrorResponse } from "./protocol.ts";
import {
  classifyMessage,
  makeRequest,
  makeNotification,
  makeSuccess,
  makeError,
  RpcError,
  METHOD_NOT_FOUND,
  INVALID_REQUEST,
  INTERNAL_ERROR,
  ENDPOINT_CLOSED,
} from "./protocol.ts";

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

export interface RpcEndpointOptions {
  /** Milliseconds before an outgoing request rejects. Default: no timeout. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RpcEndpoint {
  private transport: Transport;
  private methods = new Map<string, MethodHandler>();
  private pending = new Map<RpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private requestTimeoutMs: number | null;

  constructor(transport: Transport, options: RpcEndpointOptions = {}) {
    this.transport = transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? null;
    transport.onMessage((message) => {
      void this.dispatch(message);
    });
  }

  /** Expose a method to the peer. Re-exposing a name replaces the handler. */
  expose(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Remove an exposed method. Subsequent calls fail with METHOD_NOT_FOUND. */
  unexpose(method: string): void {
    this.methods.delete(method);
  }

  /** Names of every method this endpoint exposes (audit surface). */
  exposedMethods(): string[] {
    return [...this.methods.keys()];
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new RpcError(ENDPOINT_CLOSED, "endpoint is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (this.requestTimeoutMs !== null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(INTERNAL_ERROR, `request "${method}" timed out after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs);
      }
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send(makeRequest(id, method, params));
      } catch (cause) {
        this.pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        reject(cause);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new RpcError(ENDPOINT_CLOSED, "endpoint is closed");
    this.transport.send(makeNotification(method, params));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(new RpcError(ENDPOINT_CLOSED, "endpoint closed before response"));
    }
    this.pending.clear();
    this.transport.close();
  }

  private async dispatch(message: unknown): Promise<void> {
    if (this.closed) return;
    const kind = classifyMessage(message);

    if (kind === null) {
      // Fail-closed: never interpret malformed traffic. Respond with a
      // protocol error only when the sender clearly expected a reply.
      const maybeId = (message as { id?: unknown } | null | undefined)?.id;
      const id = typeof maybeId === "string" || typeof maybeId === "number" ? maybeId : null;
      this.safeSend(makeError(id, INVALID_REQUEST, "malformed JSON-RPC 2.0 message"));
      return;
    }

    if (kind === "request") {
      await this.handleRequest(message as RpcRequest);
      return;
    }
    if (kind === "notification") {
      const { method, params } = message as RpcNotification;
      const handler = this.methods.get(method);
      if (!handler) return; // fail-closed: unknown notifications are dropped
      try {
        await handler(params);
      } catch {
        // Notifications have no reply channel; swallowing is per JSON-RPC 2.0.
      }
      return;
    }

    // success | error → correlate with a pending request
    const response = message as RpcResponse;
    if (response.id === null) return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    if ("result" in response) {
      entry.resolve(response.result);
    } else {
      const { code, message: msg, data } = (response as RpcErrorResponse).error;
      entry.reject(new RpcError(code, msg, data));
    }
  }

  private async handleRequest(request: RpcRequest): Promise<void> {
    const handler = this.methods.get(request.method);
    if (!handler) {
      this.safeSend(makeError(request.id, METHOD_NOT_FOUND, `method not found: ${request.method}`));
      return;
    }
    try {
      const result = await handler(request.params);
      this.safeSend(makeSuccess(request.id, result));
    } catch (cause) {
      if (cause instanceof RpcError) {
        this.safeSend(makeError(request.id, cause.code, cause.message, cause.data));
      } else {
        const msg = cause instanceof Error ? cause.message : String(cause);
        this.safeSend(makeError(request.id, INTERNAL_ERROR, msg));
      }
    }
  }

  private safeSend(message: unknown): void {
    if (this.closed) return;
    try {
      this.transport.send(message);
    } catch {
      // Transport failure while replying: nothing further to do fail-closed.
    }
  }
}
