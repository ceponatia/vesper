# Narrator prompt consolidation — response to the 2026-07-10 external review

Status: draft (point-by-point assessment done 2026-07-10; slices need owner rulings —
see Open questions — and two are gated on eval runs that are themselves owner-gated spend)

An external GPT review (2026-07-10, delivered in conversation — not in `gpt-review/`,
which reviews plan docs; this one reviewed shipped code) audited the narrator prompt
system: `prompts/character-chat.ts`, `prompts/narrative.ts`, `prompts/constants.ts`,
`prompts/intake.ts`, the chat stream assembly, and the narration eval harness. Its
thesis — **fewer static rules, stronger deterministic per-turn permissions, more
multi-turn evaluation, no new reasoning layer** — is the direction this codebase
already chose (exposure mask, cue invites, the deterministic response-shape line, the
focus-planner "wash" ruling). Several of its points are real and actionable; several
re-litigate decisions the owner made deliberately, or miss machinery that already
exists. This plan records the verdict on each and turns the accepted ones into slices.

## Verdict summary

| # | Review point | Verdict |
| --- | --- | --- |
| 1 | Chat length instructions conflict (`aggressive_concise` vs "about three paragraphs") | **Real conflict — but resolution needs an owner ruling** (the baseline was owner-instructed) |
| 2 | NPC initiative should be optional, not per-turn mandatory | **Accept, softened wording** (was a deliberate keep — eval-check the quiet-turn case) |
| 3 | Remove the two-or-three-trait per-turn quota | **Modify — gate on the enactment measurement run** (the quota fixed a documented flat-character problem) |
| 4 | Rewrite POV rule as a grammar contract; reconsider the reflex license | **Decline** (rule 2 already is that contract; the reflex license is owner ruling D2) |
| 5 | Restrict chat's incidental-people license | **Accept, softened** (scene-consistent walk-ons stay legal; invented persistent people don't) |
| 6 | Consolidate sensory rules behind a deterministic per-turn allowance | **Accept** — it's the session exposure-mask pattern, ported lightweight to chat |
| 7 | Replace linear authority order with a domain map | **Weak accept — fold-in polish only** (domain blocks already self-declare authority) |
| 8 | Chat: stable system prompt + final turn-context user message | **Accept — strongest architectural point** (real cache win; eval-gated) |
| 9 | Reframe/move the mature-content block; soften the no-refusal rule | **Decline** (framing exists due to documented refusals; rule 14 already has the in-character arm). Optional: a priming-probe fixture to test the hypothesis |
| 10 | Rename `react_emotionally`, derive reactionScale deterministically | **Mostly already done** (authored band already overrides the planner); rename is cheap polish |
| 11 | Multi-turn eval scenarios | **Strong accept — the biggest genuinely new idea** |

Where the review went wrong, concretely:

- **It didn't know the "about three paragraphs" baseline was an owner instruction**
  (roadmap §Shipped "Chat reply discipline + scene memory", 2026-07-09) — landed ten
  days *after* the eval made `aggressive_concise` the chat resting default. Deleting
  it unilaterally could undo a deliberate correction (see Open questions).
- **`reactionScale` already defers to the deterministic resolver**: `buildResponseShape`
  (scene.ts) lets the authored reaction band always win; the planner's scale is only
  read when no authored reaction resolved. The review's "better still" is shipped.
- **Rule 14's "more effective version" is already half of rule 14** — the in-character
  boundary arm ("play it as N's own in-world choice") is verbatim there; only the
  absolute never-refuse clause differs, and that clause exists because open narrator
  models demonstrably refuse in a borrowed assistant voice (comment at
  `character-chat.ts` CONTENT_FRAMING).
- **Its "sensoryAllowance" proposal is the session lane's exposure mask** —
  `exposureRules()` in narrative.ts renders exactly the binding per-sense,
  per-turn allowance it describes. The idea is still right for chat; it's a port,
  not an invention.
- **The chat POV rule is already the mechanical contract it proposes** (rule 2:
  third-person for the character, second-person "you" for the player, first person
  only inside quoted dialogue).

## Slices

Ordered by value ÷ risk. 1–3 are wording-level; 4–6 are structural.

### 1. Cheap wording fixes (no gate; one pass over both rulebooks)

- **Incidental people (chat rule 3)**: append a qualifier — an incidental person must
  fit the established scenario/scene memory (a waiter *in the restaurant the scenario
  put you in* is fine), stays unnamed and non-recurring unless the player engages
  them, and is never invented just to enliven a reply. Keeps the flavor-NPC license
  (deliberate, 2026-07-09 dialogue-attribution work) while closing the
  convenient-stranger hole the review names — chat has no presence roster to do it
  structurally.
- **NPC initiative (session prose rule 6)**: drop the per-turn mandate ("at least one
  … each turn") for a licensed-when-earned form: a present NPC with a concrete,
  immediate reason (goal, schedule, open thread — the affordances block) may
  contribute one self-motivated beat; a quiet turn needs no manufactured activity.
  This aligns rule 6 with presence-fidelity rule 7 ("present ≠ obligation to speak")
  and the response contract's "texture never buries the beat". Verify with the
  existing `hi` quiet-turn eval scenario — living-world texture was a deliberate keep
  (narrator-prompt-focus Phase 1), so watch that quiet scenes don't go inert.
- **Intake `react_emotionally` (intent-brief.ts + intake.ts + scene.ts)**: rename to
  `acknowledge_emotional_beat` and soften the rendered steer ("acknowledge the
  emotional beat the player landed — at the scale the Reaction line sets"). Pure
  vocabulary polish; the authority already sits with the authored band. Honors the
  "keep but don't grow" planner ruling.

### 2. Chat length-story reconciliation (owner ruling first — Open question A)

The conflict is real: chat rule 5 renders the active shape profile
(`aggressive_concise`: "as few sentences as it honestly needs") while "Shaping each
reply" states "Baseline shape: about three paragraphs". Concrete beats vague, so the
baseline likely wins and the profile's effect erodes. But **don't delete the
baseline** — reconcile so the length story lives in exactly one place: move it into
the shape-profile text (`constants.ts`), where `concise_immersive` owns the
~three-paragraph baseline and `aggressive_concise` owns the review's replacement
("length follows the beat; a simple exchange may be one line of dialogue and one
action beat; add paragraphs only when new action, consequence, or sensory information
occurs"). The "Shaping each reply" block keeps resolve-then-one-move, the worked
example, and freshness — everything except the length sentence. Which profile chat
should then rest on is the owner's call (Open question A).

### 3. Trait-quota softening — gated on the enactment measurement run

The review's caricature risk (traits performed, not possessed) is plausible, but the
quota exists because the opposite failure was *measured*: before personality-enactment
(2026-06-28), chat never surfaced the sliders and characters read flat. The
already-queued **enactment measurement run** (roadmap §Next; ≥80% blind disposition
identification per axis) is the natural gate: run it once as shipped, then rerun with
the softened wording — "let the traits this beat makes relevant govern what you
notice, withhold, say, and do; never demonstrate a fixed number of traits per reply"
(both lanes: chat rule 6, session prose rule 7). Softening survives only if blind
identification holds the bar. Same treatment for the age rule (keep "speak and act
your age", drop the every-dimension enumeration) — it can share the run.

### 4. Chat sensory allowance — deterministic per-turn line (port of the exposure-mask pattern)

Today the "one cue, earned" instruction is stated in ~4 places (Sensory-cues framing,
rules 11–12, the cue invite, the Sensory-focus block), which raises sensory salience —
the exact failure the session lane solved with `exposureRules()`. Chat has no exposure
tracking, but it already computes the inputs each turn (`detectChatCue`,
`detectSensoryFocus`, arousal, outfit): derive a per-turn allowance
(`none | visual_accent | close_range_hook | focused_description`) in the route and
render ONE binding tail line ("Sensory allowance this turn: none — no scent, texture,
warmth, or close physical detail"). The static Sensory-cues block shrinks to data +
one deferral line ("follow the current-turn sensory allowance"); rules 11–12 collapse
into it; the cue invite and Sensory-focus block become the `close_range_hook` /
`focused_description` arms instead of siblings. Add a fixture asserting zero sensory
references on a `none` turn (the `sensoryRelevant` metric already exists).

### 5. Chat turn-context restructure — stable system + final user message (eval-gated)

Confirmed against `chat-pipeline.ts`: chat sends `system = prefix + volatile tail`,
then raw history. The tail precedes the history in token order, so **every tail change
invalidates the provider cache for the entire history window every turn** — the §9
split protects only the prefix. The session lane already uses the right shape (stable
rulebook / history / final user message = turn context + fenced input). Converge chat:
system = prefix only; final user message = tail sections + the fenced current player
input (composed at stream time — the stored transcript row is never touched, same as
`notationNote` today). Gains: system + history become an append-only cached prefix;
turn data sits adjacent to the input it governs; the eval inspector shows exactly what
changed per turn. Risks: system-role instructions may carry more behavioral authority
than user-role context for some models — so A/B through the eval harness (both chat
models) before flipping the default, and keep the assembly behind a switch until then.
No separate planning message, no new LLM leg (the focus-planner wash ruling stands).

### 6. Multi-turn eval scenarios

The harness's fixtures are single-turn (`messages: [{ role: "user", content:
playerInput }]`). Add transcript fixtures (8–12 exchanges, scripted player side; the
model generates each reply seeing its own prior output) and score longitudinally —
the failure modes single turns can't show: repeated scent/outfit/setting
re-description, question-ending cadence (the span parser already detects questions),
answer-ask-act-every-turn shape, topic drift after simple statements, invented
incidental people, signature-phrase reuse, warmth escalating without state changes,
thought/reflex authorship creep, paragraph count after trivial inputs under the
resting profile, and sensory references on `none` turns. Most metrics are
deterministic (regex/parser over the transcript) in the existing
`scripts/eval/narration/` style; the judge rubric extends for the fuzzy ones. This
slice should land **before** slices 3–5 flip anything, since it's the instrument that
proves them. Live runs stay owner-gated spend, like every eval run so far.

### Declined (recorded so we don't re-litigate)

- **Mature-content reframe / softening rule 14**: the framing exists because open
  narrator models refuse in an assistant voice without it (documented at
  CONTENT_FRAMING); the refusal failure mode is strictly worse than the hypothesized
  priming. Rule 14 already carries the in-character-boundary arm the review proposes.
  *Optional follow-up if the owner shares the priming concern*: one eval fixture —
  innocuous small-talk input, judge scores for unprompted sexual interpretation —
  to test the hypothesis cheaply before moving any text.
- **POV grammar-contract rewrite**: chat rule 2 already states the mechanical
  contract (third person for the character, "you" for the player, first person only
  in quoted dialogue). No change worth the snapshot churn.
- **Removing the player-reflex license**: owner ruling D2 (chat-narrator-pov plan)
  explicitly drew this boundary — involuntary perception + light reflex writable;
  voluntary action, speech, and named emotions never. An external review is not
  grounds to reopen it.
- **Authority domain map**: the domain blocks each self-declare authority ("sole
  authority for…"), and the linear order covers the residual same-fact conflicts.
  At most, reword `AUTHORITY_ORDER`'s lead-in to "when blocks state the same fact"
  as fold-in polish while touching narrative.ts in slice 1.

## Open questions

- **A. Chat length story (slice 2)** — the ~three-paragraph baseline was a direct
  owner instruction (2026-07-09), *after* the eval set chat to `aggressive_concise`
  (2026-06-29). Was it a deliberate counterweight because `aggressive_concise` replies
  read too skimpy in live play? If yes: chat's resting profile should flip to
  `concise_immersive` (or a new middle profile) and the baseline moves into it. If
  no: adopt the review's beat-scaled replacement inside `aggressive_concise`. Either
  way the length story ends up in one place.
- **B. Slice ordering** — slice 6 (multi-turn eval) is the instrument for 3–5;
  build it first, or accept wording-only slices 1–2 shipping ahead of it?
- **C. Priming probe** — is the mature-content-priming concern worth one eval
  fixture, or drop it entirely?
