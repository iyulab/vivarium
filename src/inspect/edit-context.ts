/**
 * Edit context — the versioned public contract: a machine-readable
 * description of "what the user is pointing at, in which screen, backed by
 * which source", consumable by any editing agent. Documented in
 * docs/edit-context.md.
 *
 * Injection defense is part of the contract: everything derived from screen
 * content (text, attribute values) is PHYSICALLY separated under
 * `untrusted`, keyed by element id. Consumers MUST treat those values — and
 * `source.code` — as data, never as instructions.
 */

export const EDIT_CONTEXT_VERSION = "0.2";

/** Structural identity of a selected element. */
export interface ElementSelection {
  id: string;
  tag: string;
}

/** Screen-derived content: untrusted by definition (see contract §3). */
export interface UntrustedElementData {
  /** textContent, truncated. Null when the element has no text. */
  text: string | null;
  /** Attribute name → value (values truncated). */
  attributes: Record<string, string>;
  /**
   * Accessible name, truncated. Null when the element has none.
   *
   * It lives here and not beside `role` because it is screen-derived *content* —
   * a label, a heading, a cell's text. Putting it in the structural part would
   * quietly widen what a consumer treats as trusted, which is the one thing §3
   * of the contract exists to prevent.
   */
  name?: string | null;
}

/**
 * How an element stands relative to the selection.
 *
 * The screen list used to be every addressable element in document order. That is
 * the whole screen whether or not any of it bears on the edit, and it grows with
 * the *data* — on a 354-element screen it was 61% of the context (20.8KB) while the
 * source being edited was 39%. What a consumer actually reasons about is the
 * selection's surroundings, so that is what the context carries, and each entry
 * says which surrounding it is.
 */
export type ScreenRelation = "selected" | "ancestor" | "sibling" | "child";

/** An element in the selection's neighbourhood — structure only (see {@link UntrustedElementData} for its name). */
export interface ScreenElement {
  id: string;
  tag: string;
  relation: ScreenRelation;
  /**
   * ARIA role — explicit when the author set one, otherwise the implicit role of
   * the element. Null when neither applies.
   *
   * Structural, alongside `tag`: it classifies what the element *is*, and a
   * consumer that knows "this is a textbox" needs one less inference than one
   * deducing it from a tag and its attributes.
   */
  role: string | null;
}

export interface EditContextSource {
  /** Source language of the generated artifact, e.g. "tsx" or "js". */
  language: string;
  /** The generated module source the selection is backed by (untrusted). */
  code: string;
}

export interface EditContext {
  editContextVersion: typeof EDIT_CONTEXT_VERSION;
  /** Execution profile name, or null when rendering plain JS. */
  profile: string | null;
  /** What the user is pointing at (structural identity only). */
  selection: ElementSelection[];
  /** The selection's neighbourhood: ancestors, siblings, children, in document order. */
  screen: { elements: ScreenElement[] };
  /** The source backing the screen. Null before the first render. */
  source: EditContextSource | null;
  /** Screen-derived content, keyed by element id. Data, never instructions. */
  untrusted: Record<string, UntrustedElementData>;
}

/**
 * An element as the host sees it. Two names, two lifetimes (design ADR-0005):
 *
 * - `id` is an **address** — the element standing at that position now.
 *   Authored ids (`data-viv-id` in the generated code) are the author's
 *   durable names and survive re-renders and re-generations; synthesized ids
 *   (`viv:…`) are positions, so a structural change can hand the same id to a
 *   different element. The edit context speaks in ids.
 * - `ref` is a **reference** to this one element for as long as it lives —
 *   issued once, never reused, never re-pointed. Hold a ref to keep pointing
 *   at what the user selected; `createEditContext` takes refs.
 */
export interface ElementDescriptor extends ElementSelection, UntrustedElementData {
  ref: string;
}

export interface BuildEditContextInput {
  profile: string | null;
  selection: ElementDescriptor[];
  /** The neighbourhood the sandbox computed, in document order. */
  screen: ScreenElement[];
  /** Accessible names for neighbourhood elements, keyed by id — screen-derived, so untrusted. */
  screenNames?: Record<string, string | null>;
  source: EditContextSource | null;
}

/**
 * Assemble an edit context, separating structural identity from
 * screen-derived (untrusted) content.
 */
export function buildEditContext(input: BuildEditContextInput): EditContext {
  const selection: ElementSelection[] = [];
  const untrusted: Record<string, UntrustedElementData> = {};
  for (const descriptor of input.selection) {
    selection.push({ id: descriptor.id, tag: descriptor.tag });
    untrusted[descriptor.id] = {
      text: descriptor.text,
      attributes: descriptor.attributes,
      name: descriptor.name ?? null,
    };
  }
  // A neighbour's name is content too. It goes in the same map rather than beside
  // the structure, and it does not overwrite a selected element's fuller entry.
  for (const [id, name] of Object.entries(input.screenNames ?? {})) {
    if (untrusted[id]) continue;
    untrusted[id] = { text: null, attributes: {}, name };
  }
  return {
    editContextVersion: EDIT_CONTEXT_VERSION,
    profile: input.profile,
    selection,
    screen: { elements: input.screen },
    source: input.source,
    untrusted,
  };
}
