# Attribute mutability & change-path integrity — spec

Status: **shipped — 2026-06-19** (all three slices; see the plan for completion notes).
Design settled for all three slices; open questions resolved 2026-06-19 (§10).

Plan: [attribute-mutability.plan.md](attribute-mutability.plan.md). This spec is
the **re-analysis (2026-06-19)** of two 2026-06-15 notes —
[attribute-mutability.md](attribute-mutability.md) (the enforcement proposal) and
[attribute-mutability-user-notes.md](attribute-mutability-user-notes.md) (the
schema-design wishlist). Both predate the **non-human-species** work
([finished/non-human-species.plan.md](finished/non-human-species.plan.md), shipped
2026-06-18), which silently built most of the design wishlist. This spec records
what is now **already done**, what is **still live**, and the **settled rulings**
where the shipped design diverged from the notes.

---

## 1. What the two source notes asked for, vs. what shipped

The design half of the notes is ~85% shipped. Reconciliation (verified 2026-06-19):

| User-note item | Status now | Where |
| --- | --- | --- |
| #1 Full anatomical body; nonhumanoid-aware | **partial / by design** — humanoid body plan only; nonhumanoid plans are acknowledged future data adds | `body/plans.ts`, `contracts.md` §Body model |
| #2 Body groups targeting section *or* explicit attributes | **done** | `body/locations/` tree + `species/targets.ts` |
| #3 Species templates choose groups + which attributes | **done** | `species/realize.ts` (`allowed`/`disallowedBodyLocationIds`, `attributeRules`, `defaultFeatureGroups`) |
| #4 Reduce free-text fields | **live gap** — 7 `text` attributes remain | see §6 |
| #5 Attributes (de)activate other attributes; gender→drop vulva/breasts | **done** (mechanism); **diverged** on policy | `attributes/types.ts` `activatesGroups`, `species/realize.ts`; see §7 |
| #5 No player override "at this stage" | **diverged → ruling** — anatomy is a fully-overridable seed | §7 R1 |
| #5 DB sentinel so models know an attribute is intentionally absent | **diverged → ruling** — absence + applicability filtering is the marker | §7 R2 |
| #5 Deactivated fields hidden in UI | **done** | `attribute-picker.tsx` filters by `realizeBody(...).isAttributeApplicable` |
| #6 Reverie-style inline per-part schemas | **done** | `attributes/categories/*.ts` via `defineAttributeGroup` |
| #7 Rename `groups`→body parts, `locations`→groups | **done in spirit** — `groups/`→`categories/` (per-body-part files); `body/locations/` is the tree with group-roots (head/torso/arms/pelvis/legs) | `attributes/categories/`, `body/locations/` |
| #8 Colloquial groups ("face" → face+eyes+brows+lips) | **done** | `species/targets.ts` |
| Species LLM descriptions (forge/narrator steer) | **done** | species `appearance`/`lore`, `speciesAppearancePhrase`/`speciesLorePhrase` |

**The one thing none of the shipped work touched is the original 🔴 finding:**
`AttributeDefinition.mutability` is still read by nothing. That is the load-bearing
content of this spec.

---

## 2. Current state of the mutability invariant (verified 2026-06-19)

`docs/contracts.md` still documents the rule as a promise:

```ts
mutability: "inherent" | "mutable" | "temporary";   // inherent: narrative can't change it
```

It is enforced nowhere. `rg mutability src` returns only the type definition
(`attributes/types.ts:12-14`), the per-category definition files, and tests — **no
consumer**: not the merge reducer, not `resolveAttributes`, not the editor, not the
forge, not the prompt builders.

Counts today: **51 `inherent` / 35 `mutable` / 0 `temporary`** (was 45/33/0 in the
2026-06-15 note; the non-human work added morphology + intimate attributes).
`temporary` remains a value with **zero members and no consumer**.

### The leak (unchanged in shape, only in line numbers)

The sole runtime writer of attribute overlays is the post-turn simulant merge,
`engine/merge.ts:1721-1746` (was `1560-1586`). Its comment still reads *"Attribute
changes (rare, lasting)"*:

```ts
for (const change of simulant.attributeChanges) {
  const participant = findParticipant(change.participantName, parts);
  if (!participant) { /* merge.participant.unresolved warn + continue */ }
  if (!attributeRegistry.byId(change.attributeId)) { /* merge.attribute.unknown warn + continue */ }
  const overlay = parseOrNull(attributeValueSchema,
    { id: change.attributeId, value: change.value, source: "narrative", note: change.note },
    sink, "merge.attributeChange");
  if (!overlay) { /* merge.attribute.invalid warn + continue */ }
  participant.state.attributeOverlays = [
    ...participant.state.attributeOverlays.filter((o) => !(o.id === overlay.id && o.source === "narrative")),
    overlay,
  ];
}
```

It validates participant-resolves, id-is-known, value-matches-schema — then writes.
It never reads `def.mutability`. The simulant contract still types `attributeId` as a
bare `z.string().min(1)` (`contracts/turns/agent-results.ts:74-83`), so the model is
offered the **entire** vocabulary, inherent traits included.

Provenance precedence (`contracts/registry/provenance.ts`) is unchanged: `base 0 <
creation 1 < narrative 2 < condition/injury/item/magic/environment 3 < manual 4`. A
`narrative` overlay therefore **outranks** the authored `creation`/`base` value and
**persists across every subsequent turn** until a `manual` write supersedes it.

`magic` / `item` / `injury` / `environment` overlay sources are **never produced** by
any writer (`rg 'source: "(magic|item|injury|environment)"' src` → none). Every
attribute change today is flattened to `narrative`. This matters for §5 (D6).

### Why it matters (unchanged)

Identity drift is the exact failure the post-turn world model exists to prevent. An
LLM over-reading prose ("her eyes flashed green") can emit `eyes.color := green`; the
overlay outranks the base, re-applies every turn, compounds rather than
self-corrects, and surfaces to nobody. The doc promises protection that the code does
not provide.

**Applicability filtering does not cover this.** `realizeBody(...).isAttributeApplicable`
(now consumed by the editor, forge, scene, character-chat, and image prompts) drops
*stale/inapplicable* attributes (wings on a wingless char). It says nothing about
whether a *narrative overlay on an applicable inherent attribute* is allowed. The two
gates are orthogonal; mutability is still ungated.

---

## 3. Why `resolveAttributes` is not the fix (unchanged)

Making the resolver refuse a low-authority overlay over an inherent base is rejected
as the *primary* fix: it is a pure, hot function consumed in ~half a dozen places
(`scene.ts` ×3, `pipeline.ts` ×2, `character-chat`); loading it with mutability/source
policy makes resolution stateful, and it would **mask** an already-persisted bad
overlay (it stays in `state.attributeOverlays`, just hidden) rather than prevent it.
Enforcement belongs at the **write boundary** where the resilience rules put
validation. The resolver may gain a defensive check later (§5 D5) behind the same
policy helper.

---

## 4. Design — the enforcement slice (load-bearing)

### D1. A pure mutability/source policy in contracts

Add one tested, pure function next to `resolveAttributes` so the rule has one home
and the engine cannot disagree with the UI. `value.ts` already exports
`AttributeValueSource` (line 19); import `AttributeMutability` from `./types`
(exported at `types.ts:14`):

```ts
// contracts/attributes/value.ts
/**
 * May an overlay from `source` change an attribute of this `mutability`?
 * Inherent traits accept only deliberate, high-authority changes — a human author
 * (manual) or an explicit supernatural transformation (magic). Plain narrative drift
 * is rejected. Mutable/temporary attributes accept any source.
 */
export function overlaySourceMayChange(
  mutability: AttributeMutability,
  source: AttributeValueSource,
): boolean {
  if (mutability === "inherent") return source === "manual" || source === "magic";
  return true;
}
```

**Resolved (was open question 1): the inherent allow-list is `{ manual, magic }`.**
`magic` is never produced today, so admitting it now is harmless and future-proofs the
policy for the transformation seam (D6); `manual` keeps the human author able to fix
anything. `narrative`/`condition`/`injury`/`item`/`environment` are rejected on
inherent attributes.

### D2. Enforce at the merge boundary; correct via `droppedEvents`

In the `attributeChanges` loop (`merge.ts:1721`), after the id resolves, consult the
policy and treat a rejected inherent change exactly as merge already treats a dropped
event — diagnostic **plus** a human-readable `droppedEvents` correction the narrator
sees next turn (the movement-drop at `merge.ts:1509` is the established precedent):

```ts
const def = attributeRegistry.byId(change.attributeId);   // already resolved above
if (!overlaySourceMayChange(def.mutability, "narrative")) {
  // Resolved (was open question 2): suppress a spurious correction when the model is
  // merely re-asserting the value that already resolves — only correct on a real divergence.
  const current = resolveAttributes(participant.snapshot.attributes, participant.state.attributeOverlays)
    .find((v) => v.id === change.attributeId)?.value;
  if (!valuesEqual(current, change.value)) {
    sink.push(diag("warn", "merge.attribute.inherent_change_rejected",
      `narrative change to inherent attribute "${change.attributeId}" dropped`,
      { participant: participant.displayName, attributeId: change.attributeId }));
    droppedEvents.push(
      `${participant.displayName}'s ${def.label.toLowerCase()} is an inherent trait and did not change.`);
  }
  continue;
}
```

~8 lines, local, matches "diagnostics over exceptions, degraded defaults." The
`droppedEvents` correction gently re-grounds the narrator next turn instead of the
drift silently sticking. (`valuesEqual` is a shallow scalar/array compare — reuse an
existing helper if one is already in `merge.ts`/`lib`; otherwise inline it.)

### D3. Constrain the simulant at the source (prevention)

The boundary stops bad writes; this stops the model from trying.

- **Prompt (do now, in this slice).** The simulant rulebook
  (`engine/prompts/agents.ts`, `SIMULANT_SYSTEM`) currently says only
  *"attributeChanges: rare lasting bodily changes only (haircut, injury)."* Tighten it
  to name the boundary: it is for **lasting, mutable** changes — a haircut, a dye job,
  a new tattoo, weight/training change, an injury's lasting mark — and **never** for
  eye color, gender, apparent age, species, bone structure, or other inherent traits.
- **Schema narrowing (optional, defense-in-depth).** The forge already builds a
  registry-derived `z.enum` of ids and narrows enum values via
  `realizedBody.allowedValuesFor(def)` (`character-forge.ts:381-385,452,551,698`). The
  simulant's `attributeId` could likewise become an enum restricted to `mutable`
  attribute ids, making the model literally unable to name an inherent id. Larger
  change (post-turn schemas are static today) and does **not** remove D2 (a model can
  still emit a well-formed-but-wrong *mutable* change, and other writers may appear),
  so it is defense-in-depth, not a replacement. Tracked in the plan as a stretch.

### D4. Dispose of the dead `temporary` value

**Resolved (was open question 3): drop it.** `temporary` has zero members and no
consumer; the phase-4 live-state decision routed transient state (erect/aroused/
disheveled) to the **arousal meter + conditions** and chose no new mutability tier.
Keeping a never-used branch invites exactly the "documented but inert" drift this spec
is about. Removal is safe: `mutability` is a static registry property, never persisted,
so there is no migration — drop `"temporary"` from `attributeMutabilities`
(`attributes/types.ts:12`) and update the `contracts.md` parenthetical. Exhaustive
`switch`es over the enum (lint-enforced) will flag any branch that must go.

---

## 5. Forward-looking / deferred (not in the enforcement slice)

### D5. Optional resolver hardening (defense-in-depth)

Once D1 exists, `resolveAttributes` *could* additionally refuse to let a
non-permitted source shadow an inherent base value, as a safety net against overlays
written before the fix or by a future buggy writer — behind the same
`overlaySourceMayChange` helper so there is one policy. Recommended only **after** the
enforcement slice ships, and paired with a one-time scrub of any persisted `narrative`
overlays on inherent ids. Do not lead with it (§3).

### D6. The transformation seam (ties off the dead `magic` source)

The principled answer to "but sometimes an inherent trait *should* change" is not to
weaken the rule but to give legitimate transformations the `magic` source the policy
already admits. When wanted: the simulant flags a change as transformative → the merge
maps it to `source: "magic"` → `overlaySourceMayChange("inherent", "magic")` returns
true. This revives one of the never-produced sources for a real use case and keeps
mundane `narrative` drift blocked. Out of scope; D1 is shaped to make it a later
data/flag change, not a redesign.

---

## 6. Live gap — free-text reduction (user-note #4)

Seven `valueType: "text"` attributes remain. The note's rationale: fewer free-text
fields ⇒ the engine can send **programmatic, well-designed prompt hints** to the
narrator/agents instead of a player's raw prose. The note also explicitly wants to
**keep** some free text where it genuinely helps (`hair.style` is its named example).

| Attribute | Mutability | Disposition | Rationale |
| --- | --- | --- | --- |
| `hair.style` | mutable | **keep text** | The note's own example of useful free text; styles are open-ended. |
| `identity.heritage` | inherent | **keep text** | `contracts.md` is explicit: real-world ethnicities + fantasy ancestries can't share a closed list; flagged `identityAnchor`. |
| `voice.accent` | mutable | **keep text** | Genuinely open-ended ("soft coastal lilt"); prompt-hint already steers rendering. Converting loses fidelity for little gain. |
| `presentation.scent_baseline` | mutable | **keep text** | Open-ended signature scent ("lavender soap and cedar"); hygiene thresholds + exposure gating already do the programmatic work. |
| `horns.color` | inherent | **→ `enum_list`** | Convert, drawing from the shared `MATERIAL_COLORS` palette (below). |
| `tail.color` | inherent | **→ `enum_list`** | Same. |
| `wings.color` | inherent | **→ `enum_list`** | Same. |

**Resolved (was Q1).** Convert the **three morphology colors** to `enum_list` and
keep the other four as text. `enum_list` (not `enum`) because morphology colors are
routinely two-tone ("jet-black with a red spade", "snow-white feathers tipped grey") —
a list of 1–2 palette terms stays programmatic while preserving that expressiveness.

### The shared value-vocabulary module (user Q1's "central palette" idea)

New pure file `contracts/attributes/shared-values.ts` is the home for value lists
reused across categories. The pattern is **base + per-field augment** (the user's
`eyes.color`-adds-`hazel` model). It must **reproduce the exact current value strings**
of any list it replaces — `allowedValues` members are persisted on character profiles,
so a rename silently invalidates stored values (`parseOr` drops them). The first
constants, chosen for real overlap with zero persisted-value churn:

| Constant | Members | Consumers | Notes |
| --- | --- | --- | --- |
| `HAIR_DENSITY` | `none·fine·light·moderate·thick` | `arms.hair`, `legs.hair` | The two lists are **byte-identical** today — pure DRY extraction. `chest.hair` keeps its `sparse` variant (body-appropriate) and stays local. |
| `INTIMATE_SCENT_BASE` | `clean·musky·salty` | `vulva.scent` (+`sweet`), `penis.scent` (exact), `vulva.taste` (+`tangy`,`sweet`) | Clean base+augment that reproduces each field's current set and order. |
| `MATERIAL_COLORS` | non-skin surface palette — e.g. `obsidian·jet_black·bone_white·ivory·ash_grey·smoke_grey·crimson·blood_red·russet·tan·gold·bronze·silver·iridescent·pearlescent·translucent·matches_skin` | the 3 morphology colors (new `enum_list`) | The "central palette, augmented per field" example. Each morphology field may add its own terms (e.g. wings `feathered_white`) on top. |

**Scope ruling (was Q1 follow-up).** The shared-color refactor is **morphology only.**
`eyes.color` / `hair.color` / `skin.tone` stay curated **local** lists: they are
`coreVisual` with `autoDefaultExcludes` tied to specific values and a deliberate
natural→supernatural ordering, share only ~6 generic terms, and folding them onto a
base would reorder them and risk persisted-value breakage for marginal gain.
`arms.build`/`legs.build` likewise stay local (overlap, but not identical; composition
is fragile). This honours the note's own caveat that "many body areas do need their own
lists of available values." The module is the seam; future shared axes are one-line
additions once a genuine duplication appears.

Each change is a vocabulary edit per the registry contract (edit the file → `vitest
contracts`), not a migration.

---

## 7. Recorded rulings — where the shipped design diverged from the notes

These are **settled** (per the 2026-06-19 scoping decision). They are recorded so a
future reader does not "fix" the divergence back toward the stale note.

### R1. Anatomy is a fully-overridable seed, not a gender lock

User-note #5 asked that gender deactivate vulva/vagina/breasts and that players **not**
be allowed to override "at this stage." The shipped design instead makes
`activatesGroups` a creation-time **seed**: `identity.gender = "female"` seeds
`["vulva","breasts"]`, `"male"` seeds `["penis","testicles"]`, and the editor's
`BodyConfigSection`/`BodyFeaturesSection` let an author toggle any intimate region or
feature on/off afterward ("each character can override it").

**Ruling: keep the override.** A romance engine with succubi, futanari, and arbitrary
fantasy morphology needs per-character anatomy that gender cannot dictate; a hard lock
would block legitimate characters. The seed gets the common case right with zero
clicks; the editor stays authoritative. This is strictly more capable than the locked
proposal and the note's stated reason for the lock (avoiding accidental
mis-activation) is served by the seed being *correct by default*.

### R2. Absence is the marker — no DB sentinel for inapplicable attributes

User-note #5 also wanted intentionally-absent attributes stored with a sentinel (a
`null` / "this character does not have X because male") so a querying model knows the
absence is deliberate. The shipped design stores nothing for absent attributes;
`realizeBody(...).isAttributeApplicable` filters them out at every surface (editor,
forge, scene, character-chat, image prompts), so the model **never sees** the
attribute id at all.

**Ruling: no sentinel.** The concern the sentinel addressed — a model querying a
trait the character lacks — cannot arise: applicability filtering means inapplicable
ids are never surfaced to any agent, and the colloquial-target resolver
(`expandBodyTarget`) already drops, e.g., breast attributes on a flat-chested
character. A sentinel would add a persisted-state shape, a parse boundary, and a
"present-but-absent" third state to every consumer, for a problem filtering already
eliminates. If a future agent ever needs to *assert* an absence ("she has no tail"),
that belongs in a generated prompt hint derived from the realized body, not in stored
per-attribute rows.

---

## 8. Live gap — editor does not narrow enums by species rule

Surfaced during the 2026-06-19 re-analysis (not in either source note, but adjacent
and cheap). `realizeBody` exposes `allowedValuesFor(def)` (def values ∩ rule
`allowedValues` − `disallowedValues`) and `defaultValueFor(def)`, and the **forge uses
both** (`character-forge.ts:452,551,698`). The **editor does not** — `attribute-picker.tsx`
renders enum `<option>`s from raw `def.allowedValues` (`:562,:573`). Consequence: a
faerie's `wings.shape` is rule-locked to `"butterfly"`, but the editor still offers the
full base palette, and `required` rule defaults are neither pre-seeded nor marked.

**Fix (resolved Q2 — hard-restrict).** Point the editor's enum/enum_list controls at
`body.allowedValuesFor(def)` (it already computes `body = realizeBody(...)` at
`attribute-picker.tsx:94`) and **drop out-of-rule options entirely** — a species rule is
a species fact, not a default, so a faerie's `wings.shape` simply offers only
`"butterfly"`. Body-config toggles (intimate regions / features) remain the per-character
override surface (R1); the hard-restrict applies to *value narrowing within an applicable
attribute*, not to which anatomy a character has. Required-rule defaults: when a stored
value is absent for a `required` attribute whose rule carries a `defaultValue`, seed it —
done where species/heritage is set (mirror `character-editor.tsx`'s existing
`setHeritage` feature-seeding), **not** in a render effect (react-hooks lint forbids sync
setState in effects). A value already out of the narrowed set (e.g. after a species
change) is shown as a flagged invalid selection so the author can see and fix it rather
than having it silently rewritten.

---

## 9. Test plan

Per `docs/testing.md` (degradation tests assert fallback **and** diagnostic code):

- **Pure** (`attributes/value.test.ts`): `overlaySourceMayChange` truth table —
  `inherent` rejects `narrative`/`condition`/`injury`/`item`/`environment`, admits
  `manual`/`magic`; `mutable` admits all.
- **Merge** (`engine/merge.test.ts`): a simulant `attributeChange` on `eyes.color`
  leaves `state.attributeOverlays` unchanged, pushes
  `merge.attribute.inherent_change_rejected`, and adds a `droppedEvents` line; the same
  change whose value **equals** the current resolved value pushes **no** diagnostic and
  **no** correction (equality short-circuit); a change on `hair.color` is written
  normally.
- **Regression**: a `manual` overlay on an inherent id is still honored (the rule
  targets narrative drift, not the author).
- **Registry** (`attributes/registry.test.ts`): after D4, `attributeMutabilities` has
  exactly `["inherent","mutable"]`; no definition references `"temporary"`.
- **Editor** (when §8 lands): a faerie's `wings.shape` control offers only
  `allowedValuesFor` values; a `required` default is pre-seeded.

---

## 10. Resolved questions

All open questions are now resolved (rulings live in the cited sections):

- **Q1 (free-text / shared vocab, §6).** Convert the three morphology colors to
  `enum_list` drawing from a shared `MATERIAL_COLORS` palette; keep `voice.accent`,
  `presentation.scent_baseline`, `hair.style`, `identity.heritage` as text. The shared
  module ships `HAIR_DENSITY` + `INTIMATE_SCENT_BASE` + `MATERIAL_COLORS`; the
  color-sharing scope is **morphology only** (eyes/hair/skin/limb-build stay local).
- **Q2 (editor narrowing, §8).** **Hard-restrict** enum options to the
  species-narrowed set; seed `required` defaults where species/heritage is set.

Resolved earlier in this re-analysis (were open in the 2026-06-15 note): inherent
allow-list = `{ manual, magic }` (D1); equality short-circuit on near-miss re-asserts
(D2); `temporary` → drop (D4); override seed kept (R1); no sentinel (R2).
