# Attribute mutability: an unenforced invariant

> **Superseded as the working plan (2026-06-19).** This analysis has been folded
> into [attribute-mutability.spec.md](attribute-mutability.spec.md) +
> [attribute-mutability.plan.md](attribute-mutability.plan.md), which re-verified it
> against the current code (the leak still exists; line numbers shifted). Its three
> open questions are now resolved there. Kept as the original deep-dive on the leak.

Status: **analysis / proposal** (2026-06-15). Supplement to
[character-schema-audit.md](character-schema-audit.md) finding **A1**. Goes deep
on the one 🔴 finding: `AttributeDefinition.mutability` is documented as a
binding rule, exists as a three-value enum on every attribute, and is **read by
nothing**. This doc covers what the field is supposed to mean, exactly how the
guarantee leaks, why it matters for a continuity-sensitive romance engine, and a
ranked set of fixes with code sketches that match the project's conventions
(pure contracts, `parseOr`/diagnostics at trust boundaries, degraded defaults,
corrections via `droppedEvents`).

## The invariant, as documented vs. as implemented

`docs/contracts.md` (Attribute system) states the rule plainly:

```ts
mutability: "inherent" | "mutable" | "temporary"; // inherent: narrative can't change it
```

That parenthetical is a **promise**: the narrator/simulant may not mutate an
inherent trait. The schema carries it on every definition
(`contracts/attributes/types.ts`), and the registry is meticulous about setting
it — **45 attributes are `inherent`, 33 are `mutable`, 0 are `temporary`**
(`rg 'mutability:' src/contracts/attributes/groups`).

It is enforced nowhere. `rg mutability src` outside the type definition and the
contracts tests returns **no consumers** — not the merge reducer, not
`resolveAttributes`, not the editor, not the prompt builders. The field is pure
documentation that the code does not honor.

## What the three values are meant to mean

- **`inherent`** (45) — structural/genetic identity: `eyes.color`, `eyes.shape`,
  `identity.gender`, `identity.apparent_age`, `identity.heritage`,
  `identity.species_presentation`, `build.height`, `build.frame`, `face.shape`,
  `ears.shape`, `voice.pitch`, `voice.timbre`, `penis.size`, etc. These define
  _who the character is_. A turn of prose should not be able to rewrite them.
- **`mutable`** (33) — things that legitimately change over play or over time:
  `hair.color` (dye), `hair.length`/`hair.style` (a cut), `skin.markings` (a new
  tattoo), `build.musculature`/`build.weight_presentation` (training),
  `presentation.*` (grooming/scent/style), `voice.accent`/`voice.cadence`,
  `breasts.size`, `movement.gait`/`posture_default`. These are exactly what the
  simulant's `attributeChanges` is _for_.
- **`temporary`** (0) — declared, never used. The phase-4 spec's Decision 2
  routed live transient state (erect / lubricated / aroused / disheveled) to the
  **arousal meter + conditions** and explicitly chose **no new mutability tier**
  ([phase-4-plan.md](finished/phase-4-plan.md) §Live state). So `temporary` is vestigial:
  a value with no members and no consumer.

The crucial observation: **`inherent` vs `mutable` is precisely the gate the
narrative attribute-change path needs.** The distinction already encodes the
right policy; the engine just never consults it.

## How the guarantee leaks

The only runtime writer of attribute overlays is the post-turn simulant merge
(`engine/merge.ts:1560-1586`). Its own comment calls these _"Attribute changes
(rare, lasting)"_ — i.e. it is meant for the `mutable` set. The loop:

```ts
for (const change of simulant.attributeChanges) {
  const participant = findParticipant(change.participantName, parts);
  if (!participant) {
    /* warn + continue */
  }
  if (!attributeRegistry.byId(change.attributeId)) {
    /* warn unknown + continue */
  }
  const overlay = parseOrNull(
    attributeValueSchema,
    {
      id: change.attributeId,
      value: change.value,
      source: "narrative",
      note: change.note,
    },
    sink,
    "merge.attributeChange",
  );
  if (!overlay) {
    /* warn invalid + continue */
  }
  participant.state.attributeOverlays = [
    ...participant.state.attributeOverlays.filter(
      (o) => !(o.id === overlay.id && o.source === "narrative"),
    ),
    overlay,
  ];
}
```

It validates three things — participant resolves, id is known, value matches the
registry schema — and then writes. It never reads `def.mutability`. The
simulant's contract (`contracts/turns/agent-results.ts:74-83`) types
`attributeId` as a bare `z.string().min(1)`, so the model is offered the _entire_
attribute vocabulary, inherent traits included.

`resolveAttributes` (`contracts/attributes/value.ts:51`) then ranks the overlay:
`narrative` (precedence 2) outranks `creation` (1) and `base` (0). So the change
**persists across every subsequent turn** and shadows the authored value, until
something writes a higher-precedence (`manual`) value over it.

Net result: a single simulant turn can permanently change a character's eye
color, gender, apparent age, species presentation, or bone structure, and the
documented protection does nothing to stop it.

## Why it matters

1. **Identity drift is the failure this engine most needs to prevent.** The
   whole post-turn architecture exists to keep a _persistent, queryable_ world
   model true. An LLM over-reading prose ("her eyes flashed green") and emitting
   `eyes.color := green` is a plausible, silent corruption of a defining trait —
   exactly the class of error continuity-checking is supposed to catch, leaking
   through the one path that writes canonical appearance.
2. **It is sticky and invisible.** Because the overlay outranks the base and is
   re-applied every turn, the drift compounds rather than self-correcting, and
   nothing surfaces it to the author (no diagnostic, no correction).
3. **There is no legitimate transformation path either.** The `source` enum has
   `magic` and `item` (precedence 3) for exactly the "a curse turned her hair
   white" case — but those sources are **never produced** (audit finding B3), so
   today every change, mundane or supernatural, is flattened to `narrative`.
   There is no way to say "this inherent trait changed _and that's intended_"
   distinct from "the narrator drifted." Mutability + source together are the
   vocabulary for that distinction; neither is wired.
4. **The doc actively misleads.** A future contributor reading
   `contracts.md` will assume inherent traits are protected and build on a
   guarantee that isn't there.

## Why `resolveAttributes` can't quietly fix it

Tempting idea: make the resolver refuse to let a low-authority overlay shadow an
inherent base value. Rejected as the _primary_ fix because:

- It is a pure, well-tested function consumed in five places
  (`scene.ts` ×3, `pipeline.ts` ×2); loading it with mutability/source policy
  makes resolution stateful and harder to reason about.
- It would **mask** already-persisted bad overlays rather than prevent them —
  the corrupt value stays in `state.attributeOverlays`, just hidden, which is
  worse for debugging than never writing it.

Enforcement belongs at the **write boundary**, where the resilience rules say
validation lives. The resolver may optionally gain a defensive check later
(§Solution D), but it is not where the rule should first live.

## Solutions

Ranked. The recommendation is **A + B together** as the minimal correct fix,
with C and E as cheap follow-ups and D as optional hardening.

### A. A pure mutability/source policy in contracts (the missing primitive)

Add one tested, pure function next to `resolveAttributes` so the rule has a
single home and the engine can't disagree with the UI:

```ts
// contracts/attributes/value.ts
/**
 * May an overlay from `source` change an attribute of this `mutability`?
 * Inherent traits accept only deliberate, high-authority changes — a human
 * author (manual) or an explicit supernatural transformation (magic). Plain
 * narrative drift is rejected. Mutable/temporary attributes accept any source.
 */
export function overlaySourceMayChange(
  mutability: AttributeMutability,
  source: AttributeValueSource,
): boolean {
  if (mutability === "inherent")
    return source === "manual" || source === "magic";
  return true;
}
```

The exact allow-list for inherent is the one real decision (see Open questions);
the function is where it gets made, tested, and documented — not scattered across
call sites.

### B. Enforce at the merge boundary, correct via `droppedEvents`

In the `attributeChanges` loop (`merge.ts:1561`), after the id is resolved,
consult the policy and treat a rejected inherent change exactly like merge
already treats an invalid move (`merge.ts:1372-1395` is the precedent — diagnostic
**plus** a human-readable correction the narrator sees next turn):

```ts
const def = attributeRegistry.byId(change.attributeId);
if (!def) {
  /* existing merge.attribute.unknown warn + continue */
}
if (!overlaySourceMayChange(def.mutability, "narrative")) {
  sink.push(
    diag(
      "warn",
      "merge.attribute.inherent_change_rejected",
      `narrative change to inherent attribute "${change.attributeId}" dropped`,
      { participant: participant.displayName, attributeId: change.attributeId },
    ),
  );
  droppedEvents.push(
    `${participant.displayName}'s ${def.label.toLowerCase()} is an inherent trait and did not change.`,
  );
  continue;
}
```

This is ~6 lines, local, matches the "diagnostics over exceptions, degraded
defaults" rule, and the `droppedEvents` correction means the narrator is gently
re-grounded next turn instead of the drift silently sticking. Degradation tests
assert both the fallback (overlay not written) **and** the diagnostic code, per
`docs/testing.md`.

### C. Constrain the simulant at the source (prevention, complementary)

The boundary check stops bad writes; this stops the model from trying:

- **Prompt** (cheap, do now): the simulant's instructions for `attributeChanges`
  should say it is for _lasting, mutable_ changes — a haircut, a dye job, a new
  tattoo, weight change — and never for eye color, gender, apparent age, species,
  or bone structure.
- **Schema narrowing** (stronger, optional): mirror the forge, which already
  builds a registry-derived enum of _allowed_ ids (`character-forge.ts`
  `buildAttributeSectionSchema`). The simulant's `attributeId` could likewise be
  an enum restricted to `mutable` attributes. This makes the contract
  self-documenting and the model literally unable to name an inherent id. It is a
  larger change (the post-turn schemas are static today) and does **not** remove
  the need for B (a model can still emit a well-formed-but-wrong mutable change,
  and other writers may appear), so treat it as defense-in-depth, not a
  replacement.

### D. Optional resolver hardening (defense-in-depth only)

Once A exists, `resolveAttributes` _could_ additionally refuse to let a
non-permitted source shadow an inherent base value, as a safety net against
overlays written before the fix (or by a future buggy writer). Keep it behind
the same `overlaySourceMayChange` helper so there is one policy. Recommended only
after A+B, and paired with a one-time scrub of any persisted `narrative` overlays
on inherent ids. Do not lead with this (see §"Why resolveAttributes can't").

### E. Resolve the dead `temporary` value (housekeeping)

`temporary` has zero members and no consumer, and the live-state decision (D2)
that would have populated it is settled in favor of meters/conditions. Either:

- **Drop it** from the `attributeMutabilities` enum (safe — it is a static
  registry property, never persisted, so no migration), or
- **Keep it reserved** with a one-line `contracts.md` note that it is intended
  for future overlay-only transient attributes and is currently unused.

Leaning drop, since keeping a never-used branch invites the same "documented but
inert" drift this whole doc is about. Trivial either way.

### F. The transformation seam (forward-looking, ties off B3)

The principled long-term answer to "but sometimes an inherent trait _should_
change" is not to weaken the rule but to give legitimate transformations the
`magic` source the policy already admits. When that feature is wanted, the
simulant would flag a change as transformative; the merge maps it to
`source: "magic"`; `overlaySourceMayChange("inherent", "magic")` returns true.
This revives one of the five dead sources (audit B3) for a real use case and
keeps mundane `narrative` drift blocked. Out of scope for the fix, but the policy
in A is shaped to make it a later data/flag change, not a redesign.

## Recommended minimal fix

1. Add `overlaySourceMayChange` to `contracts/attributes/value.ts` with unit
   tests over the policy table (A).
2. Call it in the merge `attributeChanges` loop; reject inherent narrative
   changes with `merge.attribute.inherent_change_rejected` + a `droppedEvents`
   correction (B).
3. Add the simulant prompt guidance (C, prompt half only).
4. Decide `temporary` (E).
5. Update `docs/contracts.md` so the parenthetical points at the now-real
   enforcement, and note `magic`/`manual` as the deliberate-change escape hatch.

Steps 1–2 are the load-bearing change and are small. 3–5 are same-PR polish.

## Test plan

Per `docs/testing.md` (degradation tests assert fallback **and** diagnostic):

- **Pure** (`value.test.ts`): `overlaySourceMayChange` truth table — inherent
  rejects `narrative`/`condition`/`item`, admits `manual`/`magic`; mutable admits
  all.
- **Merge** (`merge.test.ts`): a simulant `attributeChange` on `eyes.color`
  leaves `state.attributeOverlays` unchanged, pushes
  `merge.attribute.inherent_change_rejected`, and adds a `droppedEvents` line; a
  change on `hair.color` is written normally.
- **Regression**: a `manual` overlay on an inherent id is still honored (the rule
  targets narrative drift, not the author).

## Open questions

- **Inherent allow-list.** Is `{ manual, magic }` the right set, or should
  `manual` alone be permitted until the transformation feature (F) ships? Magic
  isn't produced today, so admitting it now is harmless and future-proofs the
  policy — leaning include both. Confirm before writing the helper.
  **Answer** Keep magic in the set for future use but currently the system should not be allowed to use magic as a reason for transformation.
- **Reject vs. clamp on near-misses.** Some "changes" the model emits to an
  inherent attribute may actually be re-asserting the existing value (no real
  change). Worth a cheap equality check to suppress a spurious correction when
  the proposed value equals the current resolved value? Leaning yes — only
  correct on an actual divergence.
  **Answer** I agree with an equality check to save on unnecessary operations.
- **`temporary`: drop or reserve?** (E). Leaning drop.
  **Answer** Drop, I cannot think of a reason we would need temporary when we could use mutable.
