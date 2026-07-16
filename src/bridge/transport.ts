/**
 * Transport abstraction for the capability bridge.
 *
 * The bridge protocol (JSON-RPC 2.0) is transport-agnostic; postMessage is
 * the production transport (vivarium ADR-0002), and an in-memory pair exists
 * for tests. The in-memory pair deliberately round-trips every message
 * through structuredClone so that non-serializable payloads fail in tests
 * exactly as they would across a real iframe boundary.
 */

export interface Transport {
  send(message: unknown): void;
  /** Register the single receiver. Replaces any previous receiver. */
  onMessage(receive: (message: unknown) => void): void;
  close(): void;
}

interface QueueingEnd {
  peer: InMemoryTransport | null;
  deliver(message: unknown): void;
}

class InMemoryTransport implements Transport, QueueingEnd {
  peer: InMemoryTransport | null = null;
  private receive: ((message: unknown) => void) | null = null;
  private queue: unknown[] = [];
  private closed = false;

  send(message: unknown): void {
    if (this.closed) throw new Error("transport is closed");
    // Enforce the serializability invariant of the bridge (ADR-0002).
    const cloned = structuredClone(message);
    this.peer?.deliver(cloned);
  }

  deliver(message: unknown): void {
    if (this.closed) return;
    if (this.receive) {
      // Deliver asynchronously to mirror postMessage semantics.
      queueMicrotask(() => {
        if (!this.closed) this.receive?.(message);
      });
    } else {
      this.queue.push(message);
    }
  }

  onMessage(receive: (message: unknown) => void): void {
    this.receive = receive;
    if (this.queue.length > 0) {
      const pending = this.queue;
      this.queue = [];
      queueMicrotask(() => {
        for (const message of pending) {
          if (this.closed) return;
          this.receive?.(message);
        }
      });
    }
  }

  close(): void {
    this.closed = true;
    this.receive = null;
    this.queue = [];
  }
}

/** Create a connected pair of in-memory transports (for tests and harnesses). */
export function createTransportPair(): [Transport, Transport] {
  const a = new InMemoryTransport();
  const b = new InMemoryTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * Minimal structural types for postMessage endpoints, so this module carries
 * no dependency on DOM lib types (it must load under plain Node for tests).
 */
export interface PostMessageTarget {
  postMessage(message: unknown, targetOrigin?: string): void;
}

export interface MessageEventLike {
  data: unknown;
  source?: unknown;
}

export interface PostMessageSource {
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

export interface PostMessageTransportOptions {
  /** Value passed as postMessage targetOrigin. Defaults to "*", which is correct for opaque-origin sandboxes (their origin is unmatchable). */
  targetOrigin?: string;
  /** When set, only events whose `source` strictly equals this value are accepted (e.g. iframe.contentWindow on the host side). */
  expectedSource?: unknown;
}

/**
 * Wrap a postMessage target/source pair (e.g. iframe.contentWindow + window)
 * as a bridge Transport.
 */
export function createPostMessageTransport(
  target: PostMessageTarget,
  source: PostMessageSource,
  options: PostMessageTransportOptions = {},
): Transport {
  const targetOrigin = options.targetOrigin ?? "*";
  let listener: ((event: MessageEventLike) => void) | null = null;
  let closed = false;

  return {
    send(message: unknown): void {
      if (closed) throw new Error("transport is closed");
      target.postMessage(message, targetOrigin);
    },
    onMessage(receive: (message: unknown) => void): void {
      if (listener) source.removeEventListener("message", listener);
      listener = (event: MessageEventLike) => {
        if (options.expectedSource !== undefined && event.source !== options.expectedSource) return;
        receive(event.data);
      };
      source.addEventListener("message", listener);
    },
    close(): void {
      closed = true;
      if (listener) {
        source.removeEventListener("message", listener);
        listener = null;
      }
    },
  };
}
