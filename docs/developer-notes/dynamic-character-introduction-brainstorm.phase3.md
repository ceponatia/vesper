# Dynamic character introduction — brainstorm

Companion to [dynamic-character-introduction-spec.phase3.md](dynamic-character-introduction-spec.phase3.md).
This doc records the alternatives weighed, the riffs that didn't make the
spec, and the genuinely open questions.

## Context blob vs provisional row

The original sketch: on introduction, give the narrator a temporary
description in context; forge in the background; on completion, drop the
blob and feed the character through the normal path.

The spec keeps the _shape_ of that idea (sketch now, full character later,
seamless handoff at a turn boundary) but changes the interim representation
from a context blob to a provisional `session_participants` row. Why:

- **The blob only fixes the narrator.** Every other consumer still fails
  during the interim turns: the segmenter can't tag their dialogue (name not
  in the present list), simulant events referencing them are dropped by the
  merge, facts can't ground a `subject_id`, follow scores and schedules and
  meters don't exist. A character can be "temporary" for several turns if
  the forge is slow or fails — that's a long time to be half-real.
- **The swap becomes a non-event.** With a blob there are two context
  assembly paths and an explicit cutover (drop blob, start rendering
  participant) — a seam that can double-render or gap. With a row, prompt
  assembly has exactly one path the whole time; enrichment is an UPDATE.
- **Precedent**: `session_locations.emergent` already models "play created
  this, the world definition didn't". Participants get the same treatment.
- **Cost**: one insert inside the existing merge transaction. The blob isn't
  cheaper, it's just less connected.

The one thing the blob did implicitly — "don't commit to details yet" — is
preserved by the sparse snapshot: empty attributes render nothing, and the
conceptNote bio is deliberately thin.

## Detection: who notices a new character?

| Option                                                            | Pros                                                                                                                           | Cons                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Director field** (`castSignals`, chosen)                     | Mirrors `threadSignals` exactly; zero added per-turn cost; director already reasons at story level ("will this person recur?") | Dilutes the single-concern rule a little; director prompt grows                                                                                  |
| B. New conditional "casting" agent                                | Single concern; can be skipped most turns via a cheap trigger (capitalized names in narration not in the present list)         | New agent + prompt + fallback to maintain; the trigger heuristic misses unnamed-but-recurring characters and false-positives on lore name-drops  |
| C. Deterministic only (promote on `merge.participant.unresolved`) | No LLM                                                                                                                         | Far too noisy: mentioned-but-absent people, historical references, hypotheticals all unresolve; "should this person persist?" is a judgment call |
| D. Narrator self-tags (`[[new: Nessa]]` in narration)             | Zero post-turn cost                                                                                                            | Pollutes the prose contract; narrators leak markup; couples detection to the most style-sensitive prompt in the system                           |

A's "will they recur" judgment is the actual hard part, and the director is
the only agent already paid to think about story trajectory. B is the
fallback if directing quality measurably degrades from the schema growth —
the merge-side gates don't change, so swapping A→B later is cheap.

Worth keeping from C even under A: count `merge.participant.unresolved`
diagnostics per display name across turns. Two-plus unresolved events for
the same name = the director missed someone — surface it in the Turn
Inspector (or auto-signal, phase 3+).

## Forge-result merge policy

How should the forge's output combine with what play established meanwhile?

- **Forge wins** — rejected: the forge ran from a snapshot of canon taken at
  enqueue time; play may have moved (simulant `attributeChanges`, dressing
  events). Overwriting play data re-introduces the contradiction class the
  continuity agent exists to catch.
- **Re-forge on conflict** — rejected for v1: doubles cost, unbounded loop
  risk if play keeps moving.
- **Fill-empty-only (chosen)** — deterministic, idempotent, testable without
  an LLM, and play-derived values are _evidence_ while forge values are
  _invention_; evidence should win. The cost: a forge value that's
  strictly better than a thin play value is discarded. Acceptable — the
  manual editor exists, and "the model overwrote what the story said" is the
  worse failure.
- Middle ground worth revisiting: fill-empty for attributes/outfit, but let
  the forge _append_ prose fields (bio, personality, voice) since prose
  elaboration rarely contradicts. The spec adopts this for bio only.

## Deriving attributes from text: identity-conditioned ranges

The spec's range mechanism (§Attribute derivation) came out of this thread.
The motivating example: a character described as Latina should draw hair
color from {brown, dark_brown, black}, not uniformly from the full
vocabulary — today's `fillCoreVisualDefaults` is a uniform seeded pick, so
"weary harbor-master, Latina, late forties" can roll platinum blonde and
green eyes, and the narrator then asserts it with rulebook authority.

### Where the priors live

| Option                                                                                                                                    | Pros                                                                                                                                                                                                     | Cons                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Model-emitted ranges (chosen)** — the attribute agent returns `{id, plausible: string[]}` subsets, seeded pick draws from the subset | Scales automatically as the vocabulary expands (the model sees live `allowedValues` every call); handles fictional species, eras, and mixed heritage without curated data; one schema field, no new call | Plausibility quality rides on the model; a bad range still validates (it's in-vocabulary) — mitigated by wide-range-when-unsure prompting                                                                                                                                                |
| B. Registry prior tables — data like `priors: { "identity.heritage=latina": { "hair.color": ["brown","dark_brown","black"] } }`           | Deterministic, free at forge time, reviewable                                                                                                                                                            | Combinatorial maintenance as both the identity axes and the value vocabulary grow (the stated plan is to grow it _a lot_); useless for fantasy ancestries the table never named; a permanent stereotype-encoding surface in code review; heritage is free text, so keys don't even close |
| C. Hybrid — model ranges, table fallback                                                                                                  | Covers model failure                                                                                                                                                                                     | The fallback's coverage problem is B's coverage problem; the actual fallback (full-vocabulary pick + diagnostic) is simpler and honest                                                                                                                                                   |

A's scaling argument is decisive given the planned vocabulary expansion:
every new allowed value enriches ranges for free, whereas B turns each
vocabulary addition into a table-audit chore across every identity key.

### The heritage anchor

The example implies an identity axis the registry doesn't have. Shape
question for `identity.heritage`:

- **Free text (lean)** — "Latina", "Igbo", "wood-elf of the northern
  clans", "Martian-born" all work; the range derivation happens in the
  model, which reads text fine. Cost: not pickable from a dropdown, no
  closed vocabulary for the manual editor.
- Enum / enum_list — closed, pickable, but a real-world ethnicity list is
  both impossible to complete and wrong for every fantasy world; per-world
  vocabularies would be a new mechanism.

Free text wins for the same reason `identity.species_presentation` is
text. The `identityAnchor: true` flag (rather than hardcoding the four ids
in the prompt builder) keeps "which attributes condition the ranges" a
registry data edit — consistent with the extension-point rule, and new
anchors (era? regional origin?) become one-line additions.

### Riffs not in the spec

- **Weighted ranges** (`plausible: [{value, weight}]`): more fidelity
  (dark_brown likelier than brown), but the seeded picker gets more
  complex and the model's weights would be noise at this fidelity. Revisit
  only if uniform-within-range picks look wrong in practice.
- **Persisting the range** alongside the picked value (e.g. in the
  attribute's `note` or a draft-only field): would let the editor offer
  "re-roll within range" and let a future avatar pipeline express
  uncertainty. Draft-only seems right if ever; persisted rows should stay
  a single value.
- **Range-fill at provisional time** — see next section.
- **Numeric attributes**: ranges generalize (`min`/`max` narrowing for
  height by heritage+gender+age), but enum core visuals are where the
  pain is; do enums first.

### Guardrails (worth restating away from the spec's brevity)

Identity-conditioned priors are a sensitive mechanism to build casually:

- Physical attributes only. Heritage conditioning personality, voice,
  intelligence, role, or behavior is a hard no — enforce in the system
  prompt and reject in review any registry/prompt change that crosses it.
- Soft priors, not rules: explicit text always wins ("Latina with dyed
  silver hair" is a definite value, the prior never argues), and weak
  identity signal ⇒ wide range or no range. People vary; ranges encode
  _plausibility mass_, not membership criteria.
- The worked examples in `ATTRIBUTES_SYSTEM` should include both a
  text-overrides-prior case and a no-signal-wide-range case, so the model
  sees the boundary, not just the mechanism.

## Attribute seeding for provisionals

Should the provisional row get core-visual defaults so glance impressions
have something to say? **Still no**, though the range mechanism weakens the
original objection. Uniform seeded defaults can directly contradict the
narration that just introduced the character; range-constrained picks
contradict less often — but the merge doesn't read the narration, so even a
plausible pick is a blind guess against text that may have stated "blonde"
outright. The forge job runs a turn later _with_ the narration and fills
the same attributes correctly; saving one turn of sparse rendering isn't
worth any contradiction risk repeated with rulebook authority. Empty
attributes + conceptNote prose is honest about what's known. (This inverts
the authoring-time tradeoff: there, defaults beat blanks because a human
reviews the draft; here nothing is reviewed before it reaches the prompt.)

## Library adoption ("did you mean")

When the introduced name matches a library character _not_ in the world's
cast, v1 drops the signal with a diagnostic. Richer options, in ascending
ambition:

1. Surface a session-UI prompt: "Narration introduced 'Mara' — link to
   library character Mara?" (human-in-the-loop, fits AI-drafts/human-owns).
2. Auto-link when the embedding match is very strong and the library
   character's tags fit the world. Risky: silently pulling a character from
   another world's tone into this one.
3. Treat the whole library as a casting pool the director can draw from
   (give it candidate names pre-turn). Interesting but changes the
   director's contract and prompt budget; park it.

Option 1 is the natural phase-3 item.

## Promote to library

Emergent participants are session-only (`character_id` null). A "save to
library" action would copy the enriched snapshot into a `characters` row and
backfill `character_id` — making the NPC reusable across worlds, giving the
avatar pipeline its usual entity to hang images on, and matching the
existing provenance story (`source: "creation"` until touched). Cheap,
high-delight, clearly phase 3. Open sub-question: do facts about them
travel? Probably not — facts are session-scoped memory, the profile is the
portable artifact.

## Avatars for emergent NPCs

The avatar pipeline keys on character rows (`images.entity_kind =
'character'`), but participants already carry `avatar_image_id`, so either:
(a) avatars only after promote-to-library (free, but provisional NPCs stay
faceless), or (b) teach the pipeline to target a participant snapshot
directly. Lean (a) first — it sequences naturally and avoids a new image
entity kind. Revisit if faceless NPCs feel bad in the session UI.

## Schedules, meters, follow scores

All work immediately because the provisional row goes through
`spawnParticipantState`: meters initialize with world overrides, follow
scoring sees them as a co-located NPC. Schedules are empty until the forge
writes them — should the forge invent a schedule? Mild yes: the profile
agent already produces one for authored characters, and an off-screen
routine is what makes a recurring NPC feel persistent. Constraint: first
schedule entry should keep them near where they were met for plausibility.

## Crowd and background characters

Explicit non-goal: "three dockworkers" never become participants. The
director rule (named or directly interacted with, plausibly recurring) plus
the per-turn cap is the filter. If a background character gets addressed by
name next turn, they get introduced _then_ — lazy instantiation is the
feature, not a gap.

## Pre-emptive casting

The director could forge characters _ahead_ of need ("the player is heading
to the harbor; staff it"). Deliberately out of scope: it inverts the
evidence-first constraint (nothing established in play to anchor the forge),
spends money on characters the player may never meet, and the lazy path
already covers the moment of contact. The world forge is the right place for
"staff the harbor" — at authoring time, with a human reviewing.

## Risks

- **Cast bloat**: every chatty session mints NPCs; rulebook grows, prefix
  cache churns. Mitigations: the caps, the "plausibly recurring" prompt
  rule, and possibly an idle policy (no interaction for N turns ⇒ drop from
  the rulebook block but keep the row). Watch real sessions before building
  the idle policy.
- **Contradiction at enrichment**: forge fills a detail the narration never
  stated, narrator adopts it, player remembers otherwise. Mitigated by
  canon-constrained prompts + fill-empty merge; continuity agent is the
  backstop. Residual risk accepted.
- **Director overreach**: signals on every named extra. The cap bounds the
  damage to 1/turn; tune the prompt examples (include a negative example:
  crowd texture, name-dropped historical figure).
- **Two cache misses per introduction** (row insert, then enrichment).
  Bounded and rare; not worth engineering around. If it ever matters,
  batch enrichment adoption to coincide with other rulebook changes.

## Open questions

1. Does the glance-impression renderer actually tolerate an attribute-empty
   profile, or does it emit awkward scaffolding? (Verify before phase 1.)
2. Should `state.emergent.status = "failed"` auto-retry the forge once on
   the next session open, or stay manual-retry only? (Lean manual —
   resilience.md prefers degraded-and-visible over silent retry loops.)
3. Rerun of the introducing turn keeps the participant (consistent with
   movements not being reversed) — is that right, or should reconcile
   archive emergent participants whose introducing turn was rerun and whose
   name the new narration never mentions? (Lean keep; removal is a phase-3
   manual action.)
4. Should companion-role introduction ever be possible in play (a stray dog
   that becomes a companion), or is role promotion a manual editor action?
   (Lean manual.)
5. Cap values: 1/turn feels right; is 12/session too generous for the
   rulebook budget? Needs play data.
6. `identity.heritage` as free text: does the manual editor need anything
   beyond a text input (suggestions from world lore? recently-used values?),
   or is plain text fine until the editor grows autocomplete generally?
   - Heritage will not be free text. We can create some starter heritages for testing without having to define every heritage we eventually will want.
7. When the vocabulary expansion lands, does the attribute prompt stay
   under budget with full `allowedValues` listings, or does the range step
   need to split into its own call (spec §Scaling)? Measure at expansion
   time.
8. Should existing characters get a one-time re-derivation pass when the
   expanded vocabulary lands (their values were picked from the coarse
   list), or do they keep coarse values until manually edited? (Lean keep —
   provenance marks them `creation`, and a bulk rewrite of saved characters
   sits badly with human-owns.)

## User Notes

1. The time between a new character being introduced and the completed character being generated would likely be less than two turns because of the time it takes for the player to type their turn plus the narrator and system turns. This may be an okay window for which to use the blob.
2. Heritage - does not exist yet but this will be a _defined_ schema. There will be no free text ethnicity or heritages in the final game. Ethnicity would be like "Elf" and heritage would be like "Wood Elf". So, the system should be able to match these 1:1.
