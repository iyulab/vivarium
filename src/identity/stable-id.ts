/**
 * Stable element identity (fixed principle 3): every rendered element is
 * addressable. Authored `data-viv-id` values are never touched; everything
 * else gets a deterministic, structure-derived id that survives re-renders
 * of the same output (position identity). Descendants of an authored id are
 * anchored under it (`viv:@anchor/…`), so annotated regions keep stable
 * child ids even when the region moves within the document.
 *
 * INJECTION CONTRACT: the whole runtime lives inside one self-contained
 * factory (`createIdentityRuntime`) that references nothing outside its own
 * body. The sandbox bootstrap embeds `factory.toString()` and calls it —
 * this stays correct even when a consumer's bundler/minifier renames
 * module-scope bindings, because all internal references are renamed
 * consistently within the factory body.
 */

export const STABLE_ID_ATTRIBUTE = "data-viv-id";
export const SYNTHESIZED_ID_PREFIX = "viv:";

/** Minimal structural element surface (works for DOM and test fakes). */
export interface IdentifiableElement {
  tagName: string;
  children: ArrayLike<IdentifiableElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface IdentityMaintainer {
  /** Stop observing. Ids already assigned remain in place. */
  disconnect(): void;
  /** Force a synchronous reassignment pass; returns current ids. */
  refresh(): string[];
}

interface MutationObserverLike {
  observe(target: unknown, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
}

export interface IdentityRuntime {
  /**
   * Walk the element tree under `root` and ensure every element carries a
   * stable id. Returns the ids in document order. Idempotent: a second pass
   * over an unchanged tree writes nothing and returns the same list.
   */
  assignStableIds(root: IdentifiableElement): string[];
  /**
   * Assign ids now and keep them maintained as the subtree mutates
   * (re-renders, dynamic inserts). Observes childList only — attribute
   * writes made by the assignment pass itself never re-trigger it.
   */
  installStableIdentity(
    root: IdentifiableElement,
    MutationObserverCtor?: new (callback: () => void) => MutationObserverLike,
  ): IdentityMaintainer;
}

export function createIdentityRuntime(): IdentityRuntime {
  const ATTR = "data-viv-id";
  const PREFIX = "viv:";

  function assignStableIds(root: IdentifiableElement): string[] {
    const ids: string[] = [];

    function walk(element: IdentifiableElement, prefix: string): void {
      const counters: Record<string, number> = {};
      const children = element.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const tag = String(child.tagName).toLowerCase();
        const index = counters[tag] || 0;
        counters[tag] = index + 1;
        const path = (prefix ? prefix + "/" : "") + tag + "[" + index + "]";

        const existing = child.getAttribute(ATTR);
        let id;
        let childPrefix;
        if (existing && existing.indexOf(PREFIX) !== 0) {
          // Authored id: preserved verbatim; descendants anchor under it.
          id = existing;
          childPrefix = "@" + existing;
        } else {
          id = PREFIX + path;
          if (existing !== id) child.setAttribute(ATTR, id);
          childPrefix = path;
        }
        ids.push(id);
        walk(child, childPrefix);
      }
    }

    walk(root, "");
    return ids;
  }

  function installStableIdentity(
    root: IdentifiableElement,
    MutationObserverCtor?: new (callback: () => void) => MutationObserverLike,
  ): IdentityMaintainer {
    const Ctor =
      MutationObserverCtor ||
      (typeof MutationObserver !== "undefined" ? (MutationObserver as never) : null);
    assignStableIds(root);
    if (!Ctor) {
      return { disconnect() {}, refresh: () => assignStableIds(root) };
    }
    let scheduled = false;
    const observer = new Ctor(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        assignStableIds(root);
      });
    });
    observer.observe(root, { childList: true, subtree: true });
    return {
      disconnect: () => observer.disconnect(),
      refresh: () => assignStableIds(root),
    };
  }

  return { assignStableIds, installStableIdentity };
}

const runtime = createIdentityRuntime();

export const assignStableIds = runtime.assignStableIds;
export const installStableIdentity = runtime.installStableIdentity;
