# Fragile intimate-anatomy defaulting

Status: **analysis / proposal** (2026-06-15). Supplement to
[character-schema-audit.md](finished/character-schema-audit.md) finding **E1**. The
per-character body-config (`intimateRegions`) is seeded from `identity.gender` at
forge time — but gender is not force-filled, so a weak-signal prompt silently
yields a character with **no intimate anatomy**, the empty default being
indistinguishable from a deliberate authorial choice. For a romance-first engine
whose intimate layer is the core product, that is a costly silent failure mode.

## The mechanism

The forge seeds the body-config from the resolved gender after the attribute
section runs (`server/authoring/character-forge.ts:424-428`):

```ts
const gender = attributes.find((a) => a.id === "identity.gender")?.value;
const intimateRegions = defaultIntimateRegionsForGender(
  typeof gender === "string" ? gender : undefined);
return { profile: { attributes, intimateRegions } };
```

`defaultIntimateRegionsForGender` (`contracts/body/locations/intimate.ts:45-49`):

```ts
if (gender === "female") return ["vulva", "breasts"];
if (gender === "male")   return ["penis", "testicles"];
return [];   // androgynous / nonbinary / unspecified — the author chooses
```

## Where it breaks

`identity.gender` is flagged `identityAnchor` (inferred first —
`character-forge.ts:359`) but **not** `coreVisual` (`attributes/groups/identity.ts`
— only `apparent_age` is `coreVisual` in the identity group). The three-tier
core-visual fill (definite → plausible range → seeded pick) therefore **never
force-fills gender**. The attribute agent emits *"the ones it supports"*, so on a
prompt with no clear gender cue ("a flirtatious bartender, dry wit, knows
everyone's secrets") the model may simply omit gender.

When gender is absent, `defaultIntimateRegionsForGender(undefined)` → `[]` → the
character is realized with **no intimate anatomy at all**, with **no diagnostic**.
The intimate layer silently doesn't exist for that character until a human notices
and toggles it in the editor.

### Compounding factors

- **Edit-time staleness.** Changing gender in the editor does not re-seed
  `intimateRegions` (documented intentional — *"stored body-config is
  authoritative thereafter"*). So fixing the gender later doesn't fix the anatomy.
- **`[]` is overloaded.** Empty means both *"deliberately none"* (androgynous /
  nonbinary author choice — a valid, intended outcome) and *"we couldn't infer
  one."* Nothing distinguishes the deliberate empty from the accidental empty, so
  neither the author nor a later diagnostic can tell them apart.

## Why it matters

- The intimate body layer is the product's differentiator; a default that
  silently omits it for any character whose prompt didn't pin gender is the worst
  kind of gap — invisible, and exactly opposite the engine's intent.
- It undermines the design premise. Decision 1 says gender sets a *default* that
  is always overridable — but a default you never actually computed (because the
  signal it keys off wasn't filled) isn't a default, it's a coin flip that usually
  lands on "none."

## Solutions

Recommended: **C** (surface the ambiguity now) + **B** (save-time / edit-time
re-seed with provenance). **A** is a real option but doesn't fully solve it alone;
**D** is a design question, not a quick fix.

### C. Make the silent default loud (minimal, do now)

When the forge resolves no gender **and** `intimateRegions` ends up empty, emit a
diagnostic so the author is prompted instead of silently shipping a body-config-less
character:

```ts
if (!gender && intimateRegions.length === 0) {
  sink.push(diag("info", "forge.character.body_config.unresolved",
    "couldn't infer intimate anatomy from the concept — set it in the editor"));
}
```

Cheap, honest, matches the diagnostics convention, and turns an invisible gap into
a visible nudge. It does not change the default, only its observability — but
observability is most of the problem.

### B. Re-seed from the resolved gender at save / on gender edit (provenance-aware)

Treat the gender→regions seed as derivable rather than one-shot:

- On **save**, if `intimateRegions` was never explicitly touched by the author
  (i.e. still the seeded value), recompute it from the current resolved gender.
- In the **editor**, when gender changes and the author hasn't manually overridden
  the body-config, re-seed and mark it "auto" (vs. "overridden"), the same
  AI-vs-manual provenance pattern attributes already use. An explicit author
  toggle pins it and stops auto-reseeding.

This fixes the edit-time staleness and the "I set gender but anatomy didn't
follow" surprise, without clobbering deliberate choices.

### A. Make `identity.gender` `coreVisual` (force-fill it)

Add `coreVisual: true` to `identity.gender` so it's always filled by the
three-tier fill, removing the "gender absent" case. Caveats:

- The tier-3 seeded pick needs a sensible default. If it defaults to
  `androgynous`, `defaultIntimateRegionsForGender` still returns `[]` — so A alone
  doesn't actually populate anatomy unless the seeded gender is `female`/`male`,
  which means *forcing a binary gender* on a deliberately-ambiguous concept. That
  has its own correctness/representation cost.
- So A is worth doing for the broader benefit (gender always present for other
  consumers), but it must be paired with C/B to handle the androgynous→`[]` path
  honestly; it is not a standalone fix for E1.

### D. Decouple anatomy from gender (design question)

Gender presentation and anatomy are orthogonal, and the body-config layer was
explicitly built to express that. One could let the forge infer `intimateRegions`
from a broader signal (role, species, explicit anatomical cues) rather than gender
alone. But the current design deliberately keeps anatomy out of the model's direct
output (it's body-config seeded from gender, not model-emitted), so this is a
departure worth debating, not a quick patch. Raised as a question.

## Recommended path

1. Add the unresolved-body-config diagnostic (C) — immediate honesty.
2. Make the gender→regions seed provenance-aware and re-seedable at save / on
   gender edit (B).
3. Consider `coreVisual` on gender (A) for its broader benefits, knowing it needs
   C/B alongside.
4. Update `docs/authoring.md` (forge seeding) and `docs/contracts/body.md` (body-config
   defaulting) to describe the re-seed semantics.

## Test plan

- **Forge**: a concept with no gender cue → `intimateRegions: []` **and** the
  `forge.character.body_config.unresolved` diagnostic; "a buxom barmaid" → female
  inferred → `["vulva","breasts"]` and no diagnostic.
- **Re-seed (B)**: editing gender female→male with an untouched body-config
  re-seeds to `["penis","testicles"]`; with an author-overridden body-config,
  leaves it alone.
- **Degradation**: an explicitly empty body-config (androgynous, author-chosen)
  stays empty and is not flagged once marked overridden.

## Open questions

- **Force-fill gender (A)?** Worth it for other consumers, but the androgynous
  default still yields `[]`. Confirm the seeded-pick default and whether forcing a
  binary is acceptable.
- **Distinguish deliberate-empty from unknown-empty.** A provenance flag on the
  body-config (auto vs. overridden) would let the diagnostic and re-seed behave
  correctly. Add it?
- **Let the model propose `intimateRegions` directly (D)?** Departs from the
  current "anatomy is body-config, not model output" design — decide deliberately.
