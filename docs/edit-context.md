# Edit Context — public contract, version 0.1

The edit context is the serialized answer to *"what is the user pointing
at, in which screen, backed by which source?"*. It is produced by the
Vivarium inspect layer and consumed by editing agents (e.g.
`vivarium-agent`) and any external tool. Its shape is versioned and
documented here because external tools depend on it (fixed principle 4);
it is not an internal format of either side.

## 1. Shape

```jsonc
{
  "editContextVersion": "0.1",
  "profile": "react-tsx@0",            // execution profile name, or null
  "selection": [                        // what the user is pointing at
    { "id": "viv:@counter/button[0]", "tag": "button" }
  ],
  "screen": {                           // the screen the selection lives in
    "elementIds": ["counter", "viv:@counter/h2[0]", "viv:@counter/button[0]"]
  },
  "source": {                           // what backs the screen
    "language": "tsx",                  // declared by the profile ("js" when none)
    "code": "…generated module source…"
  },
  "untrusted": {                        // screen-derived content, keyed by id
    "viv:@counter/button[0]": {
      "text": "increment",
      "attributes": { "class": "primary" }
    }
  }
}
```

- `selection[].id` is a stable element id (see the identity layer):
  synthesized ids are structural (`viv:tag[n]/…`), authored ids are
  preserved verbatim, descendants of authored ids anchor under them
  (`viv:@anchor/…`).
- `screen.elementIds` lists every addressable element in document order,
  so a consumer can reason about the selection's surroundings without
  another round trip.
- `source.code` is the *pre-transform* module source — the artifact an
  editing agent would modify.
- `text` is truncated at 500 characters, attribute values at 200.

## 2. Producer/consumer roles

- Producer: `SandboxHandle.createEditContext(selectedIds)`. Selections can
  originate from host UI or from click-to-select inside the sandbox
  (`setSelectionMode(true)` + `onSelectionChanged(listener)`).
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
   `screen.elementIds`) are runtime-constrained: tags are lowercased
   element names; synthesized ids match `viv:[a-z0-9\[\]/@.-]+`. Authored
   ids are author-controlled strings and MUST be handled as data when
   echoed into prose.

## 4. Versioning

`editContextVersion` follows the family's 0.X.X discipline: additive,
backward-compatible fields bump the minor; anything else is a new
contract revision agreed at the umbrella level first.
