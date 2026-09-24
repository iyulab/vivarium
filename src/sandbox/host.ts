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

import { RpcError, ENDPOINT_CLOSED } from "../bridge/protocol.ts";
import { createPostMessageTransport } from "../bridge/transport.ts";
import type { MessageEventLike } from "../bridge/transport.ts";
import { createHostBridge } from "../bridge/lifecycle.ts";
import type { HostBridge, UnmountResult } from "../bridge/lifecycle.ts";
import type { CapabilityRegistry } from "../bridge/capabilities.ts";
import { createBootstrapHtml } from "./bootstrap.ts";
import type { InlineSources } from "./bootstrap.ts";
import { buildEditContext } from "../inspect/edit-context.ts";
import type { EditContext, ElementDescriptor, ScreenElement } from "../inspect/edit-context.ts";

export const METHOD_RENDER = "vivarium/render";
export const METHOD_INSPECT_IDS = "vivarium/inspect.ids";
export const METHOD_INSPECT_CONTEXT = "vivarium/inspect.context";
export const METHOD_INSPECT_DESCRIBE = "vivarium/inspect.describe";
export const METHOD_INSPECT_RESOLVE = "vivarium/inspect.resolve";
export const METHOD_SELECTION_SET = "vivarium/selection.set";
export const NOTIFICATION_SELECTION_CHANGED = "vivarium/selection.changed";
export const NOTIFICATION_FAULT = "vivarium/fault";
export const METHOD_PING = "vivarium/ping";

/**
 * A fault the generated code raised after it mounted: an exception thrown
 * from an event listener or timer (`"error"`), or a rejected promise nobody
 * handled (`"unhandledrejection"`). A screen can render and still be broken;
 * this is how the host finds out.
 *
 * For those two kinds, `message` and `stack` are authored by the generated
 * code — treat them as untrusted data, the same as an edit context's
 * `untrusted` map (display them, feed them to a model as fenced data, never
 * interpret them). Both are length-capped. `stack` is `null` when the thrown
 * value carried none.
 *
 * `"unresponsive"` is the runtime's own: the watchdog (see
 * {@link SandboxOptions.watchdog}) found the generated code no longer
 * answering, and the sandbox has been destroyed. Its `message` is written by
 * the runtime; `stack` is `null`. It is delivered only when the watchdog is
 * enabled.
 */
export interface SandboxFault {
  kind: "error" | "unhandledrejection" | "unresponsive";
  message: string;
  stack: string | null;
}

export interface ElementIdEntry {
  /** Address: whatever element stands at this position now (see {@link ElementDescriptor}). */
  id: string;
  tag: string;
  /** Reference to this element for as long as it lives (see {@link ElementDescriptor}). */
  ref: string;
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
  /**
   * Let the generated UI display images and/or audio/video from `data:` and
   * blob: URLs it builds itself — typically from bytes a granted capability
   * returned. Only in-sandbox sources: the network stays closed. Omitted:
   * no image or media source loads at all.
   */
  inlineSources?: InlineSources;
  /** Timeout for host→guest requests (render, unmount). Default 10s. */
  requestTimeoutMs?: number;
  /**
   * Watch for generated code that stops answering — an endless loop, a
   * synchronous computation that never yields. Once the handshake completes the
   * host probes the sandbox; when it has gone `unresponsiveMs` without an
   * answer, every `onFault` listener receives an `"unresponsive"` fault and the
   * sandbox is destroyed (the handle then rejects like any destroyed handle).
   * Mounting a fresh sandbox is the host's call: whatever the generated UI held
   * in memory is gone either way.
   *
   * A late answer counts as an answer, so a host that was itself busy for a
   * moment does not condemn a guest that is fine.
   *
   * This helps only where the engine runs the sandboxed frame apart from the
   * host page. Firefox runs it on the host's own thread: while the generated
   * code spins, the host — and this watchdog — cannot run either, so it
   * detects nothing until the code yields on its own.
   *
   * Omitted: no watchdog.
   */
  watchdog?: { unresponsiveMs?: number };
}

/**
 * A live sandbox. Every operation below needs the bridge, so once the handle
 * is destroyed they all reject the same way — an `RpcError` carrying
 * `ENDPOINT_CLOSED`, the code the endpoint itself reports once closed. One
 * condition, one code: a caller racing teardown branches once, and never has
 * to read the message to find out what happened.
 */
export interface SandboxHandle {
  iframe: SandboxIframeElement;
  bridge: HostBridge;
  /** Resolves when the guest completes the initialize handshake. */
  whenReady(): Promise<void>;
  /** Render generated code (an ES module default-exporting mount(root, api)). */
  render(code: string): Promise<void>;
  /** Ask the guest to unmount, collecting any state it wants persisted. */
  requestUnmount(): Promise<UnmountResult>;
  /** Enumerate every element currently rendered: its id, tag, and reference. */
  listIds(): Promise<ElementIdEntry[]>;
  /**
   * Describe what stands at each id now (tag + screen-derived text/attributes).
   * One answer per id, in order; `null` where no element carries that id. An
   * id is an address, so this never fails for a missing one — it says so.
   */
  describeElements(ids: string[]): Promise<Array<ElementDescriptor | null>>;
  /** Toggle click-to-select inside the sandbox. */
  setSelectionMode(enabled: boolean): Promise<void>;
  /**
   * Deliver a granted event to the generated UI (see
   * `CapabilityRegistry.grantEvent`); its `api.on(name, handler)` handlers
   * receive `payload`. Waits for the handshake like every other call, then is
   * fire-and-forget — nothing is answered, and an event nobody subscribed to
   * is delivered to nobody. Rejects with `INVALID_PARAMS` for an ungranted
   * name. A handler that throws is reported through `onFault`.
   */
  emit(event: string, payload?: unknown): Promise<void>;
  /** Subscribe to selections made inside the sandbox. Returns unsubscribe. */
  onSelectionChanged(listener: (element: ElementDescriptor) => void): () => void;
  /**
   * Subscribe to faults the generated code raises after mounting (see
   * {@link SandboxFault}). Returns unsubscribe. A throw during mount is not
   * reported here — `render()` rejects with `GENERATED_CODE_FAULT` for it.
   * Subscribe before `render()` to see everything the render produced.
   */
  onFault(listener: (fault: SandboxFault) => void): () => void;
  /**
   * Assemble the versioned edit context (public contract, fixed principle 4)
   * for the selected elements, given by **reference** (`ElementDescriptor.ref`
   * from `onSelectionChanged`, `listIds` or `describeElements`): structural
   * selection + full screen id list + backing source, with screen-derived
   * content separated as untrusted data.
   *
   * A reference follows its element, so an element that moved since it was
   * selected is described under the id it carries now. An element that is gone
   * — removed, or replaced by a later `render()` — rejects the whole call with
   * `STALE_ELEMENT_REFERENCE` (`data.refs` lists which): the runtime will not
   * describe whatever took its place. A string this sandbox never issued as a
   * reference (an id, say) is `INVALID_PARAMS`.
   */
  createEditContext(selectedRefs: string[]): Promise<EditContext>;
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
  iframe.setAttribute("srcdoc", createBootstrapHtml({ modules: options.profile?.modules, inlineSources: options.inlineSources }));
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
  let stopWatchdog: (() => void) | null = null;
  let lastSource: { language: string; code: string } | null = null;
  const selectionListeners = new Set<(element: ElementDescriptor) => void>();
  const faultListeners = new Set<(fault: SandboxFault) => void>();

  bridge.endpoint.expose(NOTIFICATION_SELECTION_CHANGED, (params) => {
    for (const listener of [...selectionListeners]) listener(params as ElementDescriptor);
  });
  bridge.endpoint.expose(NOTIFICATION_FAULT, (params) => {
    for (const listener of [...faultListeners]) listener(params as SandboxFault);
  });

  const handle: SandboxHandle = {
    iframe,
    bridge,
    whenReady: () => ready,
    async render(code: string): Promise<void> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
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
    async emit(event: string, payload?: unknown): Promise<void> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
      await ready;
      bridge.emit(event, payload);
    },
    async requestUnmount(): Promise<UnmountResult> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
      await ready;
      return bridge.requestUnmount();
    },
    async listIds(): Promise<ElementIdEntry[]> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
      await ready;
      return (await bridge.endpoint.request(METHOD_INSPECT_IDS)) as ElementIdEntry[];
    },
    async describeElements(ids: string[]): Promise<Array<ElementDescriptor | null>> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
      await ready;
      return (await bridge.endpoint.request(METHOD_INSPECT_DESCRIBE, { ids })) as Array<ElementDescriptor | null>;
    },
    async setSelectionMode(enabled: boolean): Promise<void> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
      await ready;
      await bridge.endpoint.request(METHOD_SELECTION_SET, { enabled });
    },
    onSelectionChanged(listener: (element: ElementDescriptor) => void): () => void {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    onFault(listener: (fault: SandboxFault) => void): () => void {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    async createEditContext(selectedRefs: string[]): Promise<EditContext> {
      if (destroyed) throw new RpcError(ENDPOINT_CLOSED, "sandbox is destroyed");
      await ready;
      // One request, not two. The selection and the neighbourhood have to describe
      // the same DOM; asking separately leaves room for a render in between, and
      // then the surroundings belong to a screen the selection no longer lives in.
      const answer = (await bridge.endpoint.request(METHOD_INSPECT_CONTEXT, { refs: selectedRefs })) as {
        selection: ElementDescriptor[];
        screen: ScreenElement[];
        names: Record<string, string | null>;
      };
      return buildEditContext({
        profile: options.profile?.name ?? null,
        selection: answer.selection,
        screen: answer.screen,
        screenNames: answer.names,
        source: lastSource,
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopWatchdog?.();
      bridge.close();
      iframe.remove();
    },
  };

  if (options.watchdog) {
    const unresponsiveMs = options.watchdog.unresponsiveMs ?? DEFAULT_UNRESPONSIVE_MS;
    void ready.then(() => {
      if (destroyed) return;
      stopWatchdog = startWatchdog(
        () => bridge.endpoint.request(METHOD_PING),
        unresponsiveMs,
        () => {
          const fault: SandboxFault = {
            kind: "unresponsive",
            message: `the generated UI did not answer for ${unresponsiveMs}ms`,
            stack: null,
          };
          // Listeners learn why before every call starts rejecting ENDPOINT_CLOSED.
          for (const listener of [...faultListeners]) listener(fault);
          handle.destroy();
        },
      );
    });
  }

  return handle;
}

const DEFAULT_UNRESPONSIVE_MS = 5_000;

/**
 * Probe with one ping in flight at a time, checking twice per `unresponsiveMs`.
 * A check that finds the ping still unanswered is a miss; two in a row fire.
 * Any answer — however late — resets the count, so a host that was blocked
 * itself (its timers and the guest's reply queued together) needs two more
 * checks before it can conclude anything.
 */
function startWatchdog(
  ping: () => Promise<unknown>,
  unresponsiveMs: number,
  onUnresponsive: () => void,
): () => void {
  let outstanding = false;
  let misses = 0;
  const send = () => {
    outstanding = true;
    ping().then(
      () => {
        outstanding = false;
        misses = 0;
      },
      // A rejection is not an answer: the ping stays outstanding and the next
      // checks count it. (Once the sandbox is destroyed the watchdog is stopped.)
      () => {},
    );
  };
  const timer = setInterval(() => {
    if (!outstanding) {
      send();
      return;
    }
    misses += 1;
    if (misses >= 2) {
      clearInterval(timer);
      onUnresponsive();
    }
  }, Math.max(1, Math.floor(unresponsiveMs / 2)));
  send();
  return () => clearInterval(timer);
}
