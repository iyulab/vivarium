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

export interface CapabilityDescriptor {
  /** Namespaced capability name, e.g. "data.query" or "events.emit". */
  name: string;
  /** Human/agent-readable summary of what invoking this does. */
  description: string;
}

export interface CapabilityGrant {
  descriptor: CapabilityDescriptor;
  handler: MethodHandler;
}

const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

export function isValidCapabilityName(name: string): boolean {
  return CAPABILITY_NAME_PATTERN.test(name);
}

export class CapabilityRegistry {
  private grants = new Map<string, CapabilityGrant>();

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
  }

  revoke(name: string): boolean {
    return this.grants.delete(name);
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
}

/**
 * Expose every granted capability on an endpoint as `cap:<name>` methods.
 * Returns an unbind function that removes exactly what was bound.
 */
export function bindCapabilities(endpoint: RpcEndpoint, registry: CapabilityRegistry): () => void {
  const bound: string[] = [];
  for (const descriptor of registry.list()) {
    const method = CAPABILITY_METHOD_PREFIX + descriptor.name;
    const handler = registry.getHandler(descriptor.name);
    if (!handler) continue;
    endpoint.expose(method, handler);
    bound.push(method);
  }
  return () => {
    for (const method of bound) endpoint.unexpose(method);
  };
}
