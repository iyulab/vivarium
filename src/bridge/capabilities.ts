/**
 * Capability registry — the host's explicit grant surface.
 *
 * Fixed principle 2: capabilities are explicit and enumerable. A capability
 * is surfaced to the sandbox as the JSON-RPC method `cap:<name>`, so "the
 * complete list of what this generated UI can do" is exactly the registry's
 * contents. Nothing is ambient; an unregistered capability does not exist
 * (METHOD_NOT_FOUND at the endpoint, fail-closed).
 */

import type { RpcEndpoint, MethodHandler } from "./endpoint.ts";

export const CAPABILITY_METHOD_PREFIX = "cap:";

/**
 * Events travel the other way: the host emits, the sandbox listens. An event
 * is delivered as the JSON-RPC notification `evt:<name>`, and only a granted
 * name can be emitted or subscribed to — so the registry enumerates what the
 * generated UI can *hear* exactly as it enumerates what it can *do*.
 */
export const EVENT_METHOD_PREFIX = "evt:";

export interface CapabilityDescriptor {
  /** Namespaced capability name, e.g. "data.query" or "events.emit". */
  name: string;
  /** Human/agent-readable summary of what invoking this does. */
  description: string;
}

/** A host→sandbox event the generated UI may subscribe to. */
export interface EventDescriptor {
  /** Namespaced event name, e.g. "audio.position". Same grammar as capabilities. */
  name: string;
  /** Human/agent-readable summary of when it fires and what it carries. */
  description: string;
}

export interface CapabilityGrant {
  descriptor: CapabilityDescriptor;
  handler: MethodHandler;
}

/** A change to the granted capability set, as seen by a live bridge. */
export type CapabilityChange =
  | { kind: "grant"; name: string; handler: MethodHandler }
  | { kind: "revoke"; name: string };

const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

export function isValidCapabilityName(name: string): boolean {
  return CAPABILITY_NAME_PATTERN.test(name);
}

export class CapabilityRegistry {
  private grants = new Map<string, CapabilityGrant>();
  private events = new Map<string, EventDescriptor>();
  private listeners = new Set<(change: CapabilityChange) => void>();

  grant(descriptor: CapabilityDescriptor, handler: MethodHandler): void {
    if (!isValidCapabilityName(descriptor.name)) {
      throw new Error(
        `invalid capability name "${descriptor.name}" (expected dot-separated lowercase segments)`,
      );
    }
    if (this.grants.has(descriptor.name)) {
      throw new Error(`capability already granted: ${descriptor.name}`);
    }
    this.grants.set(descriptor.name, { descriptor, handler });
    this.notify({ kind: "grant", name: descriptor.name, handler });
  }

  /**
   * Withdraw a grant. Takes effect on every bridge already bound to this
   * registry, not only on bridges created afterwards: the next call from the
   * generated UI is METHOD_NOT_FOUND, exactly as if it had never been granted.
   */
  revoke(name: string): boolean {
    const removed = this.grants.delete(name);
    if (removed) this.notify({ kind: "revoke", name });
    return removed;
  }

  /**
   * Follow changes to the granted set. This is how a live bridge keeps its
   * exposed methods equal to the registry. Returns an unsubscribe function.
   */
  onChange(listener: (change: CapabilityChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(change: CapabilityChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  has(name: string): boolean {
    return this.grants.has(name);
  }

  /** The audit surface: every capability this host grants, enumerated. */
  list(): CapabilityDescriptor[] {
    return [...this.grants.values()].map((grant) => grant.descriptor);
  }

  getHandler(name: string): MethodHandler | undefined {
    return this.grants.get(name)?.handler;
  }

  /**
   * Grant an event the host may emit and the generated UI may subscribe to.
   * Events and capabilities are separate namespaces: "audio.position" can be
   * both a capability (ask for it) and an event (be told of it).
   */
  grantEvent(descriptor: EventDescriptor): void {
    if (!isValidCapabilityName(descriptor.name)) {
      throw new Error(
        `invalid event name "${descriptor.name}" (expected dot-separated lowercase segments)`,
      );
    }
    if (this.events.has(descriptor.name)) {
      throw new Error(`event already granted: ${descriptor.name}`);
    }
    this.events.set(descriptor.name, descriptor);
  }

  revokeEvent(name: string): boolean {
    return this.events.delete(name);
  }

  hasEvent(name: string): boolean {
    return this.events.has(name);
  }

  /** The other half of the audit surface: every event the generated UI can hear. */
  listEvents(): EventDescriptor[] {
    return [...this.events.values()];
  }
}

/**
 * Expose every granted capability on an endpoint as `cap:<name>` methods, and
 * keep them in step with the registry: a later grant is exposed and a revoke
 * is unexposed, so the endpoint never offers more (or less) than the registry
 * lists. Returns an unbind function that stops following and removes exactly
 * what is bound.
 */
export function bindCapabilities(endpoint: RpcEndpoint, registry: CapabilityRegistry): () => void {
  const bound = new Set<string>();
  const expose = (name: string, handler: MethodHandler): void => {
    const method = CAPABILITY_METHOD_PREFIX + name;
    endpoint.expose(method, handler);
    bound.add(method);
  };
  for (const descriptor of registry.list()) {
    const handler = registry.getHandler(descriptor.name);
    if (handler) expose(descriptor.name, handler);
  }
  const unsubscribe = registry.onChange((change) => {
    if (change.kind === "grant") {
      expose(change.name, change.handler);
    } else {
      const method = CAPABILITY_METHOD_PREFIX + change.name;
      endpoint.unexpose(method);
      bound.delete(method);
    }
  });
  return () => {
    unsubscribe();
    for (const method of bound) endpoint.unexpose(method);
    bound.clear();
  };
}
