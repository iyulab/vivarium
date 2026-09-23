# Edit Context — public contract, version 0.2

The edit context is the serialized answer to *"what is the user pointing
at, in which screen, backed by which source?"*. It is produced by the
Vivarium inspect layer and consumed by editing agents (e.g.
`vivarium-agent`) and any external tool. Its shape is versioned and
documented here because external tools depend on it (fixed principle 4);
it is not an internal format of either side.

## 1. Shape

```jsonc
{
  "editContextVersion": "0.2",
  "profile": "react-tsx@0",            // execution profile name, or null
  "selection": [                        // what the user is pointing at
    { "id": "viv:@counter/button[0]", "tag": "button" }
  ],
  "screen": {                           // the selection's neighbourhood
    "elements": [
      { "id": "counter",                 "tag": "div",    "relation": "ancestor", "role": null },
      { "id": "viv:@counter/h2[0]",      "tag": "h2",     "relation": "sibling",  "role": "heading" },
      { "id": "viv:@counter/button[0]",  "tag": "button", "relation": "selected", "role": "button" }
    ]
  },
  "source": {                           // what backs the screen
    "language": "tsx",                  // declared by the profile ("js" when none)
    "code": "…generated module source…"
  },
  "untrusted": {                        // screen-derived content, keyed by id
    "viv:@counter/button[0]": {
      "text": "increment",
      "attributes": { "class": "primary" },
      "name": "increment"                 // accessible name — content, not structure
    },
    "counter": { "text": null, "attributes": {}, "name": "Counter" }
  }
}
```

- `selection[].id` is the element's id at the time the context was built
  (see the identity layer):
  synthesized ids are structural (`viv:tag[n]/…`), authored ids are
  preserved verbatim, descendants of authored ids anchor under them
  (`viv:@anchor/…`).
- `screen.elements` lists the selection's **neighbourhood** in document order —
  the selected elements, their ancestors, their siblings and their children —
  so a consumer can reason about the surroundings without another round trip.
  `relation` says which of those each entry is.
  - Through 0.1 this field was every addressable element on the screen. That is
    the whole screen whether or not any of it bears on the edit, and it grew with
    the **data**: on a 354-element screen it was 61% of the context (20.8KB) while
    the source actually being edited was 39%. A consumer reasons about the
    selection's surroundings, so that is what the context carries.
- `role` is the element's ARIA role — explicit when the author set one, otherwise
  the implicit role of that element, and `null` when neither applies. It is
  structural, alongside `tag`: it says what the element *is*. The accessible
  **name** is not here; a name is something the screen *says*, so it lives under
  `untrusted` (see §3).
- `source.code` is the *pre-transform* module source — the artifact an
  editing agent would modify.
- `text` is truncated at 500 characters, attribute values at 200, `name` at 100.

## 2. Producer/consumer roles

- Producer: `SandboxHandle.createEditContext(selectedRefs)`. Selections can
  originate from host UI or from click-to-select inside the sandbox
  (`setSelectionMode(true)` + `onSelectionChanged(listener)`). They are
  passed as element **references**, which the producer resolves to each
  element's *current* id; a reference whose element is gone is refused, never
  resolved to another element. The context itself carries ids only — a
  reference is between the host and the sandbox, not part of this contract.
- Consumers MUST ignore fields they do not recognize and MUST reject a
  context whose `editContextVersion` major/minor they do not support.

## 3. Injection defense (normative)

Screen content can contain adversarial text (a rendered comment, a user's
database record, a product review). Because edit contexts flow into agent
prompts, **data/instruction separation is part of this contract**, not a
consumer afterthought:

1. Everything under `untrusted`, and `source.code`, is **data**. Consumers
   MUST NOT interpret any part of it as instructions, tool directives, or
   policy — regardless of what the text claims ("ignore previous
   instructions", role tags, markup, etc.).
2. The producer separates screen-derived content *physically* (the
   `untrusted` map) so a consumer cannot accidentally interpolate it as
   trusted structure. When a consumer embeds these values into a model
   prompt, it MUST mark them as quoted data (e.g. fenced blocks with an
   explicit "untrusted data" label) and MUST NOT concatenate them into its
   instruction text.
3. Structural fields (`selection[].id`, `selection[].tag`,
   `screen.elements[].id`, `.tag`, `.relation`, `.role`) are
   runtime-constrained: `relation` is one of four fixed words, `role` is an
   ARIA role token, tags are lowercased
   element names; synthesized ids match `viv:[a-z0-9\[\]/@.-]+`. Authored
   ids are author-controlled strings and MUST be handled as data when
   echoed into prose.
4. Labels and fences are provenance cues, not a security boundary. A
   model can still be swayed by text it was told is data, so marking is
   necessary but never sufficient: whatever the agent does with a context
   stays within the authority its host already grants, and nothing on the
   screen can widen it (in the Vivarium family, an editing agent produces a
   proposal and holds no write access at all).

## 4. Versioning

`editContextVersion` follows the family's 0.X.X discipline: additive,
backward-compatible fields bump the minor; anything else is a new
contract revision, agreed across the family before any member ships it.

**0.2 is not additive.** `screen.elementIds` is gone and `screen.elements`
stands in its place, and `untrusted` entries gained `name`. A consumer written
against 0.1 must reject 0.2 rather than read it — which is what §2 already
requires of it, and the reason the version is in the document.
