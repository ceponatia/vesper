# Character chat — state as a narration system — spec

Status: **implemented — 2026-06-30** (all mechanics built; this stays the design-of-record.
The Decisions section below records the rulings as shipped). Read with
[character-chat-state-narration.plan.md](character-chat-state-narration.plan.md) — that
plan is the build order; **this is the truth** for how each piece works. Leans on the
shipped light-state mechanics ([character-chat-state.spec.md](finished/character-chat-state.spec.md))
and generalizes the opportunistic-cue discipline from
[character-chat-sensory.plan.md](character-chat-sensory.plan.md).

## 0. Problem and principles

Character chat already **tracks** a full `character_chat_state` row (meters, affinity,
conditions, `mindNote`, premise, outfit, social cards) but the narrator barely **acts on
it**. The goal is to make the tracked state *enacted* — intoxication ⇒ looser posture,
slurred edges, lowered inhibition; low hygiene ⇒ modified scent/texture/visual read —
under one hard constraint the roadmap intake states twice: **the narrator must not
re-describe state every turn**.

Three principles govern every mechanic below:

1. **State is standing coloring, foregrounded only on change.** The character should
   *behave* affected continuously (carried by overlays + disposition shift + graded
   background prose), but only *call out* a state shift as a fresh beat the turn its band
   changes. This is the anti-repetition law (§5), and it's the same "surface a cue only
   when the beat earns it" discipline already shipped for scent.
2. **Render-time only — never mutate authored data.** Every derivation (attribute
   overlays, trait shift, graded cue) is computed per turn from the state row and
   discarded. Authored attributes and traits are never written. A character can never be
   corrupted by being drunk.
3. **Degrade to today's behavior.** Every helper is pure and total; an empty or missing
   input yields exactly the current stateless output. A malformed condition effect is
   dropped, never thrown (resilience.md §1/§3).

## 1. The current surface (precise baseline)

`buildStateSection` (`engine/prompts/character-chat.ts:104`) is the entire state→narrator
channel today:

```ts
function buildStateSection(state, name): string {
  const lines = [];
  const mood = deriveMoodDescriptor(state.meters);        // blended valence phrase
  if (mood) lines.push(`- You are feeling ${mood} right now.`);
  for (const hint of crossedThresholdHints(state.meters)) lines.push(`- ${hint}`); // on/off
  const warmth = warmthHintForStage(stageForValue(state.affinity).id, name);
  if (warmth) lines.push(`- ${warmth}`);
  for (const c of state.conditions) if (c.promptHint) lines.push(`- ${c.promptHint}`);
  if (state.mindNote?.trim()) lines.push(`- On your mind: ${state.mindNote.trim()}`);
  return lines.length ? `Your current state (let this color how you speak and react — never recite it):\n${lines.join("\n")}` : "";
}
```

The route (`app/api/characters/[id]/chat/route.ts:151`) passes only
`{ meters, affinity, conditions, mindNote, premise }` — `driftedState` is the full
`ChatState` (it also has `outfit`, `outfitExposed`, `activeSocialCards`, `clockMinutes`),
but those four are not threaded in. Attributes resolve statically:
`resolveAttributes(profile.attributes, [])` (`character-chat.ts:248`), the **empty overlay**
that drops every condition effect.

**What reaches the narrator today:** a derived mood phrase, *threshold-crossing* meter
hints (binary, two levels max), a stage warmth steer, condition `promptHint` strings, and
the `mindNote`. **What is dropped:** sub-threshold gradients, meter *severity*, every
condition's structured `attributeEffects` and `senseEffects`, the outfit, and the active
cards.

**The provenance correction (important).** The contract was *designed* for condition→
attribute overlays — `ConditionEffect { attributeId, value }`, the `attributeEffects`
field ("Overlaid while active with source `condition`, sourceId = condition id"), and a
`condition` entry in `provenanceSources` at precedence **3** (above `narrative` 2 / `creation`
1 / `base` 0, below `manual` 4). **But nothing consumes it.** Both creation sites set
`attributeEffects: []` (`merge/phases/conditions.ts:57`, `chat-state.ts:583`), and no code
ever turns a condition effect into an `AttributeValue` overlay. So this plan **builds** the
conversion; it is not reusing an existing session mechanism. (The session lane can adopt the
same pure helper later — that's a follow-up, not a dependency.)

## 2. Mechanic A — condition → attribute overlays (no migration)

**New pure helper** (`contracts/conditions/overlays.ts`):

```ts
// Each active condition's attributeEffects → AttributeValue overlays, guarded so a
// condition can NEVER rewrite an inherent attribute (eye color, species, gender) even
// at render time. resolveAttributes is pure last-write-wins and does NOT itself apply
// overlaySourceMayChange (that guard lives at the merge write boundary), so we apply it
// here — otherwise a stray condition effect on an inherent attribute would silently
// change the prompt.
export function conditionAttributeOverlays(conditions, registry): AttributeValue[] {
  const overlays = [];
  for (const c of conditions) {
    for (const eff of c.attributeEffects) {
      const def = registry.byId(eff.attributeId);
      if (!def) continue;
      if (!overlaySourceMayChange(def.mutability, "condition")) continue; // inherent ⇒ dropped
      overlays.push({ id: eff.attributeId, value: eff.value, source: "condition", sourceId: c.id });
    }
  }
  return overlays;
}
```

**Builder change** (`character-chat.ts:248`): replace the empty array —
`resolveAttributes(profile.attributes, conditionAttributeOverlays(state.conditions, attributeRegistry))`.
The existing attribute loop already filters by `realizedBody.isAttributeApplicable` and
`excludeFromPrompts`, so an inapplicable/excluded overlaid attribute still can't leak. The
sensory-cue loop (`sensoryCues`) reads the same `resolved` list, so a condition that changes
`presentation.scent_baseline` (e.g. "unwashed") flows into the scent cue automatically.

**Seeding conditions with real effects.** Today chat conditions carry `attributeEffects: []`
everywhere. Add a pure **condition catalog** (`contracts/conditions/catalog.ts`) keyed by
normalized label → `{ attributeEffects, senseEffects?, promptHint }`, mirroring the existing
label→senseEffects mapping pattern (`contracts/perception/darkness.ts`, referenced in
`condition.ts`). Apply it wherever a chat condition is created (the `fluster`→"flushed"
action and `applyChatAction`'s other chips in `chat-state.ts`, the pulse, and the
state-tools "add condition" path) so "drunk"/"unwashed"/"flushed"/"tired" arrive with their
overlays attached instead of empty. Starter set (illustrative, vocabulary-editable):

| Label | attributeEffects (mutable attrs only) | promptHint (today's text stays) |
| --- | --- | --- |
| flushed | `skin → flushed/warm` | (existing arousal hint) |
| unwashed | `presentation.scent_baseline → sour/sweat`, `hair → lank` | (existing hygiene hint) |
| disheveled | `hair → mussed`, `presentation → rumpled` | — |

(The exact attribute ids resolve against `attributeRegistry`; only **mutable** attributes
qualify — the guard drops anything inherent.)

**`senseEffects`** (intoxication/blindfold dulling the character's *own* read of the player)
is **out of v1** — chat has no perception pipeline; revisit if a "doesn't quite catch your
tone" beat proves wanted (D6).

## 3. Mechanic B — graded meter → prose

`crossedThresholdHints` is on/off per `meterDefinitions[].thresholds` entry (intoxication
has two: `>0.35` tipsy, `>0.7` drunk). Replace its use in `buildStateSection` with a
**graded** derivation that yields a band *and* a normalized intensity, so the narrator can
scale and so §5 can detect band changes:

```ts
// contracts/meters/registry.ts — new, registry-driven (vocabulary stays in meterDefinitions)
export interface MeterCue { meterId: string; band: string; hint: string; intensity: number }
export function meterStateCue(meterId, value): MeterCue | null
```

`band` is the label of the deepest crossed threshold (e.g. `intoxication:drunk`);
`intensity` is how far past it the value sits, normalized 0–1, for "slightly"/"badly"
phrasing. The threshold vocabulary stays a **data edit** in `meterDefinitions` — adding a
third intoxication band ("sloppy/blackout") is one array entry, no code. `deriveMoodDescriptor`
is unchanged (it's already a blended read, not a threshold).

## 4. Mechanic C — temporary disposition shift (the "inhibition" lever)

The intake's example: high intoxication should *temporarily* lower inhibition.
`intimate.inhibition` is a **real authored trait** (`traits/definitions.ts:237`), and
`social.guardedness` is its everyday cousin — so drive this through the existing Disposition
block rather than inventing a knob:

```ts
// New pure helper (near personalizeMeters in contracts/personality/modulation.ts):
// intoxication (and, lighter, high arousal) → transient TraitValue overlays that lower
// inhibition, guardedness, AND composure. source "condition" (precedence 3) beats the
// authored creation value (1). Bounded; recedes as intoxication drifts down (driftChatState
// already decays it).
export function stateDispositionOverlays(meters): TraitValue[]
```

Magnitude: a curve keyed on intoxication (≈0.35 → slight, ≈0.7 → strong), mapping to a
bounded point-shift on **three** traits — `intimate.inhibition` ↓ (the literal match),
`social.guardedness` ↓ (the everyday "looser, less guarded" read), and `temperament.composure`
↓ (drunk reads more volatile/impulsive, not just less guarded — **decided**, see Decisions).
Applied by **pre-resolving**
the traits before `dispositionBands` (which internally resolves with `[]`, so a pre-resolved
list is idempotent):

```ts
const shifted = resolveTraits(profile.traits, stateDispositionOverlays(state.meters));
const everydayDisposition = dispositionBands(traitRegistry, shifted, { intimateOnly: false });
const intimateDisposition = dispositionBands(traitRegistry, shifted, { intimateOnly: true });
```

Because `inhibition` is intimate-category, its shift surfaces inside the existing "When the
moment turns intimate, these also drive you" sub-block; the `guardedness` shift colors the
everyday block. Authored sliders are never written — this is render-time only.

## 5. Mechanic D — anti-repetition (the heart of the plan)

Every state cue (each meter band from §3, plus a hygiene/intoxication "visible-state" band)
has a discrete **band key**. The rule:

- **Band unchanged from last surfaced** ⇒ the cue is *standing coloring* — it is **not**
  restated. The character still acts affected, because mechanics A (overlays), C
  (disposition shift), and the background graded prose already bias the whole reply.
- **Band changed** (sobering up, tipping into drunk, hygiene crossing into "unwashed",
  energy into "exhausted") ⇒ the cue is **foregrounded once** as a fresh beat, and the new
  band is recorded as surfaced.

**Persistence.** This needs memory of what was last surfaced across turns. Add a jsonb column
`surfaced_cues` to `character_chat_state` (`Record<string, string>` — cueKey → last band;
default `{}`). On **seed** (or first stateful turn), initialize it to the *current* bands
**silently** so a fresh chat doesn't dump every cue on turn one — only subsequent *changes*
fire. Updated and persisted alongside the rest of the state in the post-turn finalize.
(Alternative: derive the "previous" bands from the pre-drift loaded meters with no migration
— rejected because drift + reload make "previous" ambiguous; see D5.)

**Prompt shape.** `buildStateSection` splits its lines into two intents:
- a **standing** clause (today's "let this color how you speak — never recite it"), carrying
  the steady-state mood/warmth/`mindNote`; plus
- at most a **one-line "this just changed"** beat for any cue whose band moved this turn.

**Rule.** Add a `CHAT_RULES` entry mirroring rule 10 (the sensory rule): *"When your physical
state visibly shifts — sobering, getting drunk, growing tired, dishevelment — you may mark it
once, in action, as it changes. Otherwise let it color your tone and manner and never restate
it."*

## 6. Mechanic E — outfit + active social cards to the narrator

Graduates the scenario plan's explicit deferral ("Surfacing active cards to the chat narrator
prompt"; "Should the chat narrator also see the outfit text and active cards"). `driftedState`
already has both at the call site; thread them into the `state` object and `buildStateSection`:

- **Outfit** (`state.outfit`, gated by `outfitExposed` for tone) → a light scene-anchor line
  ("You're wearing …"). Low-risk.
- **Active cards** → **soft framing only (decided).** The pulse already resolves reactions
  against `activeSocialCards` *post-hoc*; surfacing them *pre-emptively* risks the narrator
  pre-playing a reaction the curve is supposed to own. So surface each card only as soft "what
  you care about / what you won't stand for" framing — its *theme*, **never** its mechanical
  `severity` — drawn from the card's authored description. The pulse remains the sole owner of
  the actual affinity/mood reaction; the framing just keeps the narrator from contradicting a
  card it can't see (e.g. flirting warmly with someone whose card makes that a taboo).

## 7. Mechanic F — one-turn intent cue (in scope, both layers)

**Decided: build both layers in this plan.** Two complementary mechanisms, not an either/or:

1. **Whole-state surfacing (the base).** The narrator always receives the full state each
   turn (mechanics A–E), with §5's change-gating preventing repetition. Cheap and complete on
   its own — viable precisely because there's one character and no locations.
2. **A pre-turn intent classifier (the sharpener).** Chat has **no pre-turn agent** today (the
   only structured call, the pulse, is post-turn), so this is a clean insertion point: a
   regex-first classifier (mirroring `engine/intent.ts`, degrading to a no-signal default) reads
   the player input for proximity / approach / touch / intimacy / first-encounter signals and
   raises a **one-turn** hint. That hint sharpens *which* opportunistic cues are invited this
   turn (scent on closeness, a state beat on a touch) so the narrator fires them when the beat
   earns it rather than whenever the band merely allows it. It must **not** persist into chat
   history, and (like `engine/intent.ts`) runs regex-first so it adds no LLM call on the hot
   path — an optional model upgrade is a later tuning step, not a dependency.

Graduates the sensory plan's deferred **beat-cue wrapper**; it also seeds the pre-narrator
intake that [character-chat-primary.plan.md](character-chat-primary.plan.md) wants (build once,
shared).

## 8. Mechanic G — state → scene image (in scope, graduates `deferred.plan.md`)

**Decided: bundled into this plan** so prose and imagery ship together. The deferred
"State-aware chat scene image" folds mood/meters (flushed, tipsy, tired), conditions, and the
`mindNote` into `renderCharacterSceneImage`'s prompt — the visual axis of "modify … visual
attributes to make them dirtier." Crucially it reuses the **same** §2/§3/§4 derivations (the
condition overlays and graded bands), so prose, the standing companion avatar (which already
reflects mood via `chatStateSnapshot.avatarCue`), and the scene image all agree rather than
drifting. This removes the entry from [deferred.plan.md](deferred.plan.md) (leave a one-line
"graduated → character-chat-state-narration" tombstone there).

## 9. Debug surface

Extend the State-tools modal (`components/characters/chat-state-tools.tsx`) and the
`ChatStateSnapshot` / `lastPulseTrace` payload to show *what actually reached the narrator
this turn*: the resolved condition overlays, the graded meter bands + intensities, the
disposition trait-shift, the `surfaced_cues` map (which cues fired as a change-beat vs. stood
as coloring), and the outfit/cards surfaced. This makes §5's gating tunable by observation —
the dev surface the roadmap intake explicitly asked to "expand."

## 10. Data and schema

- **One migration:** `character_chat_state.surfaced_cues jsonb not null default '{}'`
  (§5). Everything else is pure + prompt-layer.
- No change to `facts`/`episodes`/attribute tables. No new meters or traits (we *shift*
  existing traits at render time; we *read* existing meters).
- `senseEffects` application: not in v1.

## 11. Files touched (map)

- **contracts (pure):** `conditions/overlays.ts` (new — `conditionAttributeOverlays`),
  `conditions/catalog.ts` (new — label→effects), `meters/registry.ts` (`meterStateCue` +
  any new threshold vocabulary), `personality/modulation.ts` (`stateDispositionOverlays`).
- **engine:** `prompts/character-chat.ts` (the chokepoint — overlays into `resolveAttributes`,
  graded cues, disposition pre-resolve, split standing/changed lines, soft-card framing, new
  `CHAT_RULES` entry), `chat-state.ts` (seed conditions from the catalog; compute + persist
  `surfaced_cues`), a **new chat intent classifier** (`engine/chat-intent.ts`, regex-first,
  mirroring `engine/intent.ts`) wired into the route as a one-turn hint, `prompts/chat-state.ts`
  if the pulse needs to label conditions.
- **scene image (D4):** the chat scene-render prompt path (`renderCharacterSceneImage` + its
  prompt builder) folds the §2–§4 state derivations in; reuse the same helpers so prose/
  avatar/image agree.
- **route / api:** thread `outfit`/`activeSocialCards`/changed-bands + the intent hint through
  the `state` object and prompt build (`route.ts`).
- **db:** `schema.ts` (`surfaced_cues`) + a generated migration.
- **frontend:** `chat-state-tools.tsx` (debug surface), snapshot type in `lib/client`.
- **docs:** `../ui.md` (Chat tab — what the state strip now drives), `../prompts.md` (chat
  lane — the state-enactment block + the anti-repetition rule alongside Sensory cues),
  `../images.md` (chat scene image now state-aware), `deferred.plan.md` (tombstone the
  graduated scene-image entry).

## 12. Resilience

Every helper is pure/total and degrades to today's stateless output: empty conditions ⇒ empty
overlays ⇒ static attributes; missing `surfaced_cues` ⇒ treat all bands as already-surfaced
(no spurious beats) and re-seed; a malformed condition effect ⇒ dropped by the registry +
mutability guards, never thrown. `parseOr` the new column at the state boundary. No mechanic
adds an LLM call on the hot path (§7's classifier, if built, is regex-first with a degraded
fallback like `engine/intent.ts`).

## 13. Testing

Pure unit tests per derivation (overlay assembly incl. the inherent-attribute guard; graded
`meterStateCue` bands + intensity; `stateDispositionOverlays` magnitude + bounds; the
band-change gate). A `character-chat` snapshot test proving the prompt is byte-identical for a
rested/neutral character (no regression). A chat eval fixture asserting a state beat fires on
a band *change* and is absent on the following steady-state turn (§5's contract).

## Decisions

Owner rulings (2026-06-30) and adopted defaults. None currently open.

- **D1 — surfacing model (§7):** **both, in this plan.** Whole-state surfacing + §5
  change-gating is the base; the pre-turn intent classifier is also built here to sharpen cue
  timing. (Owner.)
- **D2 — inhibition trait set (§4):** lower **all three** — `intimate.inhibition`,
  `social.guardedness`, **and** `temperament.composure` (drunk reads more volatile). (Owner.)
- **D3 — active cards to the narrator (§6):** **soft framing only** — theme, never mechanical
  severity; the pulse stays the sole owner of the card reaction. (Owner.)
- **D4 — scene-image (§8):** **bundled into this plan**; reuses the §2–§4 derivations so prose,
  avatar, and image agree. Graduates the `deferred.plan.md` entry. (Owner.)
- **D5 — `surfaced_cues` storage (§5):** **new jsonb column** on `character_chat_state`
  (durable across reload; one migration). (Adopted default — flag to revisit.)
- **D6 — `senseEffects` (§2):** **out of v1** (chat has no perception pipeline). (Adopted
  default — flag to revisit.)
- **D7 — change-beat budget (§5):** **at most one** state change-beat per turn, to protect the
  concise profile; when several bands move at once, surface the most salient and let the rest
  ride as standing coloring. (Adopted default — flag to revisit.)
