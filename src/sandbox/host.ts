/**
 * Sandbox host — creates the sandboxed iframe and wires it to a HostBridge.
 *
 * Fixed principle 1: the sandbox boundary is absolute. The iframe carries
 * exactly `sandbox="allow-scripts"` (opaque origin — no same-origin access,
 * no forms, no popups, no top navigation), and no option exists to widen it.
 * The only channel in or out is the capability bridge.
 *
 * DOM access is typed structurally so the module loads under plain Node for
 * unit tests; real-browser behavior is covered by the e2e harness.
 */

import { createPostMessageTransport } from "../bridge/transport.ts";
import type { MessageEventLike } from "../bridge/transport.ts";
import { createHostBridge } from "../bridge/lifecycle.ts";
import type { HostBridge, UnmountResult } from "../bridge/lifecycle.ts";
import type { CapabilityRegistry } from "../bridge/capabilities.ts";
import { createBootstrapHtml } from "./bootstrap.ts";
import { buildEditContext } from "../inspect/edit-context.ts";
import type { EditContext, ElementDescriptor } from "../inspect/edit-context.ts";

export const METHOD_RENDER = "vivarium/render";
export const METHOD_INSPECT_IDS = "vivarium/inspect.ids";
export const METHOD_INSPECT_DESCRIBE = "vivarium/inspect.describe";
export const METHOD_SELECTION_SET = "vivarium/selection.set";
export const NOTIFICATION_SELECTION_CHANGED = "vivarium/selection.changed";

export interface ElementIdEntry {
  id: string;
  tag: string;
}

export const SANDBOX_ATTRIBUTE = "allow-scripts";

/** Minimal structural DOM types (no dependency on lib.dom). */
export interface SandboxIframeElement {
  setAttribute(name: string, value: string): void;
  remove(): void;
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface SandboxContainerElement {
  ownerDocument: {
    createElement(tag: string): unknown;
    defaultView: {
      addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
      removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
    } | null;
  };
  appendChild(node: unknown): void;
}

/**
 * Execution profile (ADR-0004): what "the generated code's world" contains.
 * The runtime core stays profile-neutral; a profile is plain data — module
 * sources embedded into the sandbox and a host-side source transform.
 */
export interface SandboxProfile {
  /** Profile identifier, e.g. "react-tsx@0". Surfaced for audit/debugging. */
  name: string;
  /** Source language of generated code (e.g. "tsx"). Reported in the edit context. Default "js". */
  language?: string;
  /** Bare specifier → ES module source, resolved inside the sandbox via an embedded import map. */
  modules?: Record<string, string>;
  /** Host-side source-to-source transform applied before render (e.g. TSX → JS). */
  transform?(code: string): string;
}

export interface SandboxOptions {
  registry: CapabilityRegistry;
  /** Opaque host context handed to the generated UI at initialize. */
  context?: unknown;
  /** Execution profile for generated code. Omitted: plain-JS modules only. */
  profile?: SandboxProfile;
  /** Timeout for host→guest requests (render, unmount). Default 10s. */
  requestTimeoutMs?: number;
}

export interface SandboxHandle {
  iframe: SandboxIframeElement;
  bridge: HostBridge;
  /** Resolves when the guest completes the initialize handshake. */
  whenReady(): Promise<void>;
  /** Render generated code (an ES module default-exporting mount(root, api)). */
  render(code: string): Promise<void>;
  /** Ask the guest to unmount, collecting any state it wants persisted. */
  requestUnmount(): Promise<UnmountResult>;
  /** Enumerate the stable ids of every element currently rendered. */
  listIds(): Promise<ElementIdEntry[]>;
  /** Describe elements by stable id (tag + screen-derived text/attributes). */
  describeElements(ids: string[]): Promise<ElementDescriptor[]>;
  /** Toggle click-to-select inside the sandbox. */
  setSelectionMode(enabled: boolean): Promise<void>;
  /** Subscribe to selections made inside the sandbox. Returns unsubscribe. */
  onSelectionChanged(listener: (element: ElementDescriptor) => void): () => void;
  /**
   * Assemble the versioned edit context (public contract, fixed principle 4)
   * for the given selected ids: structural selection + full screen id list +
   * backing source, with screen-derived content separated as untrusted data.
   */
  createEditContext(selectedIds: string[]): Promise<EditContext>;
  /** Tear down bridge and iframe. The handle is unusable afterwards. */
  destroy(): void;
}

/**
 * Create a sandboxed iframe inside `container` and connect it to a host
 * bridge exposing exactly the capabilities in `options.registry`.
 */
export function mountSandbox(container: SandboxContainerElement, options: SandboxOptions): SandboxHandle {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error("container document has no window");

  const iframe = doc.createElement("iframe") as SandboxIframeElement;
  // Fail-closed: allow-scripts only. Everything else stays denied.
  iframe.setAttribute("sandbox", SANDBOX_ATTRIBUTE);
  iframe.setAttribute("srcdoc", createBootstrapHtml({ modules: options.profile?.modules }));
  container.appendChild(iframe);

  const transport = createPostMessageTransport(
    {
      postMessage(message: unknown) {
        // The sandbox has an opaque origin, so "*" is the only expressible
        // target; authenticity comes from the direct contentWindow reference.
        iframe.contentWindow?.postMessage(message, "*");
      },
    },
    view,
    { expectedSource: iframe.contentWindow },
  );

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const bridge = createHostBridge(transport, {
    registry: options.registry,
    context: options.context,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    onInitialized: () => readyResolve?.(),
  });

  let destroyed = false;
  let lastSource: { language: string; code: string } | null = null;
  const selectionListeners = new Set<(element: ElementDescriptor) => void>();

  bridge.endpoint.expose(NOTIFICATION_SELECTION_CHANGED, (params) => {
    for (const listener of [...selectionListeners]) listener(params as ElementDescriptor);
  });

  return {
    iframe,
    bridge,
    whenReady: () => ready,
    async render(code: string): Promise<void> {
      if (destroyed) throw new Error("sandbox is destroyed");
      const transform = options.profile?.transform;
      // Transform host-side and before awaiting readiness, so profile
      // source errors surface immediately (ADR-0004).
      const finalCode = transform ? transform(code) : code;
      await ready;
      await bridge.endpoint.request(METHOD_RENDER, { code: finalCode });
      // Recorded only after a successful render: the edit context must
      // describe the source actually backing the screen.
      lastSource = { language: options.profile?.language ?? "js", code };
    },
    async requestUnmount(): Promise<UnmountResult> {
      if (destroyed) throw new Error("sandbox is destroyed");
      await ready;
      return bridge.requestUnmount();
    },
    async listIds(): Promise<ElementIdEntry[]> {
      if (destroyed) throw new Error("sandbox is destroyed");
      await ready;
      return (await bridge.endpoint.request(METHOD_INSPECT_IDS)) as ElementIdEntry[];
    },
    async describeElements(ids: string[]): Promise<ElementDescriptor[]> {
      if (destroyed) throw new Error("sandbox is destroyed");
      await ready;
      return (await bridge.endpoint.request(METHOD_INSPECT_DESCRIBE, { ids })) as ElementDescriptor[];
    },
    async setSelectionMode(enabled: boolean): Promise<void> {
      if (destroyed) throw new Error("sandbox is destroyed");
      await ready;
      await bridge.endpoint.request(METHOD_SELECTION_SET, { enabled });
    },
    onSelectionChanged(listener: (element: ElementDescriptor) => void): () => void {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    async createEditContext(selectedIds: string[]): Promise<EditContext> {
      if (destroyed) throw new Error("sandbox is destroyed");
      await ready;
      const [descriptors, allIds] = await Promise.all([
        bridge.endpoint.request(METHOD_INSPECT_DESCRIBE, { ids: selectedIds }) as Promise<ElementDescriptor[]>,
        bridge.endpoint.request(METHOD_INSPECT_IDS) as Promise<ElementIdEntry[]>,
      ]);
      return buildEditContext({
        profile: options.profile?.name ?? null,
        selection: descriptors,
        screenElementIds: allIds.map((entry) => entry.id),
        source: lastSource,
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      bridge.close();
      iframe.remove();
    },
  };
}
