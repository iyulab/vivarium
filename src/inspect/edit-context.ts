/**
 * Edit context — the versioned public contract (fixed principle 4, umbrella
 * ADR-0003): a machine-readable description of "what the user is pointing
 * at, in which screen, backed by which source", consumable by any editing
 * agent. Documented in docs/edit-context.md.
 *
 * Injection defense is part of the contract: everything derived from screen
 * content (text, attribute values) is PHYSICALLY separated under
 * `untrusted`, keyed by element id. Consumers MUST treat those values — and
 * `source.code` — as data, never as instructions.
 */

export const EDIT_CONTEXT_VERSION = "0.1";

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
  /** The screen the selection lives in: every addressable element, in document order. */
  screen: { elementIds: string[] };
  /** The source backing the screen. Null before the first render. */
  source: EditContextSource | null;
  /** Screen-derived content, keyed by element id. Data, never instructions. */
  untrusted: Record<string, UntrustedElementData>;
}

export interface ElementDescriptor extends ElementSelection, UntrustedElementData {}

export interface BuildEditContextInput {
  profile: string | null;
  selection: ElementDescriptor[];
  screenElementIds: string[];
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
    untrusted[descriptor.id] = { text: descriptor.text, attributes: descriptor.attributes };
  }
  return {
    editContextVersion: EDIT_CONTEXT_VERSION,
    profile: input.profile,
    selection,
    screen: { elementIds: input.screenElementIds },
    source: input.source,
    untrusted,
  };
}
