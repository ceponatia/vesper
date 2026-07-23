# Attribute scales — value relationships & composite body-types

Status: **draft** — parked in [deferred.plan.md](deferred.plan.md); not committed
work. Raised by the owner 2026-07-23 ("a way to tell the narrator the
relationship between attribute values — the real difference between 'wiry' /
'slim' / 'athletic' — otherwise the values are amorphous, interpreted by the LLM
in the moment").

Successor to the shipped
[finished/attribute-narrator-guidance.plan.md](finished/attribute-narrator-guidance.plan.md)
(per-value glosses). This doc is the layer **above** it: the *relationship between
sibling values*, plus a composite gestalt fill. Two facets, one foundation.

## The problem

Enum values reach the narrator with an authored per-value gloss today
(`musculature: sinewy (lean, wiry cord — no bulk)`), which already carries a lot
of implicit relationship info. Two gaps remain:

1. **No scope / neighbor calibration.** The narrator sees one value's meaning but
   not *where it sits* — is `sinewy` near the floor of the muscle range or the
   middle? Adjacent values (`sinewy` vs `toned` vs `defined`) can still blur,
   because nothing renders the boundary between them.
2. **Colloquial gestalts don't map to the axes.** The owner's own example is the
   tell: **"wiry / slim / athletic" are not three points on one scale.** The
   registry decomposed build into *orthogonal axes* (frame × musculature ×
   weight), so:
   - **wiry** ≈ `frame: slight` + `musculature: sinewy` + `weight: slim`
   - **slim** ≈ `weight: slim` (a weight-axis value alone)
   - **athletic** ≈ `musculature: toned`/`defined`

   People *think* in composite body-words; the schema stores atomic coordinates.
   That projection (a 3-D gestalt flattened onto one word) is the real source of
   amorphousness, and it's exactly why the shipped
   **orthogonality rule** exists (each gloss speaks only its own axis).

## The one hard constraint (inherited)

The shipped design **deliberately rejected shipping the whole enum scale to
read-side prompts** — "token multiplication, and a menu invites scale-talk in
prose and value drift in agents." But it **explicitly allows in-dimension ordinal
context**: *"'slimmer than lean' inside a frame gloss is fine."* So there is a
sanctioned lane for relationship info; anything here must stay inside it — bounded
(never O(scale-length) tokens), and phrased so it calibrates the narrator's
intensity without handing it a vocabulary menu to parrot.

## Prerequisite (serves both facets): mark ordered scales

Neighbor/scope logic is only meaningful on **ordered-scale** enums
(`musculature: untoned→…→powerfully_built`, `weight: underweight→…→very_heavy`,
`height`, `breasts.size`). It is nonsense on **categorical** enums
(`breasts.shape`, `buttocks.shape`, `hair.style`, `eyes.color`) — those have no
prev/next/min/max.

- Add a definition flag distinguishing the two (`scale: true` / `ordinal: true`,
  or a value-type split). The **order already lives in `allowedValues`** (many
  enums are authored ascending) — this only *declares which enums mean it*, so
  we never render bogus neighbors for a categorical set.
- Cheap, and independently useful: the forge and the eval tool both want to know
  "is this a scale?"
- Registry invariant test: a flagged scale's `allowedValues` is treated as
  ordered; a categorical enum never gets scale rendering.

## Facet A — narrator scale/neighbor guidance (read-side)

Keep rendering **only the character's one value** (as today), but enrich its line
with *derived* relationship context on ordered scales. Everything except the
per-value gloss is computed from the ordered `allowedValues` — **zero new
authoring**.

Render payload (tunable — see open questions), e.g.:

```
musculature: sinewy — lean, wiry cord, no bulk        (authored gloss)
             [low on a 7-step muscle scale; just above lightly_toned]
                    ^ scope descriptor        ^ prev/next neighbor anchor
```

- **prev/next neighbors** — the disambiguation core; directly separates
  confusable adjacent values. Highest value, free (derived).
- **scope** — render as a *positional descriptor* ("low / low-mid / high on an
  N-step scale"), **not the raw pole words** (`min:wiry … max:morbidly_obese`).
  Naming the poles is the exact "scale-talk in prose" the ruling warned about;
  a position conveys intensity without leaking vocabulary. (Owner floated
  including min/max words + counts — see open questions; recommendation is
  descriptor over pole-words, and counts to tooling not the prompt.)
- **Bounded**: at most gloss + 2 neighbors + 1 scope clause, regardless of scale
  length → O(1) tokens, not the rejected O(N) menu. Lives in the
  prompt-cache-stable attribute segment, same as the shipped glosses.
- **Authoring/eval tool** (uses the counts-between the owner asked about): flag
  ordered scales whose adjacent glosses don't measurably separate, or that are
  subdivided finer than the narrator can act on. This is where "how many values
  between" earns its keep — as a calibration signal, not prompt text.

## Facet B — composite body-type fill (write-side)

The owner's auto-fill idea: a root **"body type"** word fills the body fields.
Concern: *"there'd be a lot of combinations to map."* **You never map
combinations** — four moves collapse the explosion:

1. **Sparse patches, not full vectors.** Each gestalt sets only its 2–3 *defining*
   axes and leaves the rest alone. `athletic = {musculature: defined, weight:
   average}` — it does not pin frame, height, or hips. You map *words → a few
   nudges*, not bodies.
2. **Compose additively.** Author single words (`tall`, `athletic`, `curvy`) as
   separate sparse patches and merge (later overrides earlier). "tall athletic
   curvy" is three stacked patches, never its own entry → **O(words), not
   O(combinations)**.
3. **Seed, not lock.** Same contract as the existing `activatesGroups` /
   `defaultValue` creation-time seeds — approximate is fine, everything stays
   editable after. No need for an exhaustive or perfect map.
4. **Forge handles the tail.** Hardcode ~a dozen common gestalts as deterministic
   patches; let the LLM forge fill rarer words using the (now relationship-aware)
   glosses from Facet A. No hand-mapping the long tail.

Net: a small lexicon of single-word sparse patches + composition + forge
fallback. This *is* the "composite build-lexicon" — realized as an editable seed,
not a hardcoded combinatorial table.

## Why the two facets belong together

One foundation: **attribute vocabularies are ordered axes in a body-space.** Facet
A *reads* that structure (narrator calibration); Facet B *writes* coordinates into
it (gestalt fill). The ordered-scale flag (prerequisite) serves both, and Facet
B's patches are authored against the same relative meanings Facet A surfaces. They
can graduate separately (A is render-only and smaller; B is an authoring feature),
but they share the prerequisite and should cross-reference.

## Open questions (for the owner, at graduation)

1. **Scope form (Facet A):** positional descriptor ("low on a 7-step scale") vs
   the owner's named min/max anchors (`min:wiry … max:morbidly_obese`) vs both?
   Recommendation: descriptor, to resist pole-word leakage into prose — but this
   is an eval-able knob (try both, judge the narration).
2. **Counts-between:** confirm tooling-only (not rendered to the narrator).
3. **Neighbor phrasing:** show neighbor *words* ("above lightly_toned") or
   neighbor *meanings* ("above merely-firm")? Words are cheaper; meanings resist
   value-name parroting.
4. **Facet B scope of the hardcoded lexicon:** which gestalts are common enough to
   pin deterministically vs leave to the forge? (Needs a short authored list.)
5. **Facet B conflict resolution:** when composed patches disagree on an axis,
   last-wins by input order, or an explicit per-word priority?
6. **Does Facet B render anything to the narrator** (e.g. "reads as athletic"), or
   is it purely a write-side authoring seed? (Leaning write-side only — the
   narrator already gets the resolved per-axis values + Facet A context.)

## Not in scope

Shipping full enum lists to read-side prompts (rejected by the predecessor);
changing the orthogonality rule (Facet B *composes across* axes at author time but
does not entangle a single value's meaning); re-glossing categorical enums (they
stay bare unless individually ambiguous, per the shipped sparse rule);
non-build attribute gestalts (the mechanism generalizes, but build is the proving
ground — same "prove it in one place first" discipline as the chat lane).
