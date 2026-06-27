# Narrator prompt focus & proportionate reaction

Status: **active** — Phase 1 (prompt wording + shape profiles + dev toggle) **shipped 2026-06-27**;
Phases 2–3, the interim manual golden-scenario eval, and the reasoning probes P1–P3 remain (gated
per §Open questions / §Rollout plan). The behavioral eval harness is a separate follow-on task.

Goal: make narration stay on the player's current beat, react in proportion to
what the player actually did, and stop doting. Concretely:

- Characters respond to the player's immediate input **first**.
- A turn usually carries **one focused beat**, not a fan of unrelated mini-topics.
- NPCs don't each volunteer extra dialogue unless they're directly involved.
- Replies feel **naturally concise** — no hard character/token/line cap.
- Ordinary remarks, agreement, greetings, and mild compliments are **not** treated
  as huge emotional gifts.
- Affection / gratitude / fluster scale with **relationship state, authored
  disposition, current mood, and the explicit `## Reaction` line** — not by default.
- Characters may accept, ignore, tease, deflect, be awkward, change the subject, or
  answer plainly instead of validating every player statement.

> **Note (decision 3):** the "one focused beat" goal is reinterpreted below — the
> *focused core* is the **response to the player** (answered first), with living-world
> texture welcome **around** it. See §Decisions.

This is a **prompt-shaping** plan. The strong bias is: change wording in the
existing pure builders first (Phase 1), add a deterministic derived "shape" line
second (Phase 2), and only add a new LLM call (Phase 3) if 1–2 prove insufficient.

Related: [prompts.md](../prompts.md) (architecture this plan edits),
[personality-and-state.spec.md](personality-and-state.spec.md) §6 (the reaction
curve this plan leans on), [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md)
(the intake brief Phase 2/3 read), [turn-engine.md](../turn-engine.md) (pipeline).

---

## Decisions locked (2026-06-27 review)

1. **Length is a live, dev-toggled shape profile; default "concise but immersive."**
   (Toggle surface / global-only / both-lanes resolved 2026-06-27.) Define named narration
   *shape profiles* and pick the active one via a **dev-settings UI toggle** — live, no
   restart, dev-only and gated like the impersonate route so it never ships to players —
   governing **both** the session and character-chat lanes identically. Ship
   `concise_immersive` (default: short for trivial inputs, a few rich paragraphs for a
   normal beat) + an `aggressive_concise` backup. The profile is a **global dev/code A/B
   knob only — NOT per-world**; authors tune richness via authored Style directives
   (decision 2). See revised **Phase 1.1 + 1.6**.
2. **Global default + authored override.** Apply concise + proportionate everywhere, but
   the rules explicitly **yield to authored Style directives / `narratorGuidance`** (and
   character disposition) that call for richer or warmer narration — reusing the existing
   fenced authored channels, **no new schema**. See the override clause in **Phase 1**.
3. **Preserve lively texture** (this *overrides* my "beat-first" recommendation). Keep
   room for one unprompted, self-motivated NPC beat each turn even when mildly tangential
   — the world should feel alive, and some topic drift is acceptable. This **relaxes the
   original "one focused beat, no unrelated topics" brief**: the focused thing is the
   **response to the player** (answered first); living-world texture rides **around** it.
   The anti-doting + multi-party-restraint work is unchanged — those target reaction
   *proportionality* and *over-talking*, not autonomous world life. See **Phase 1.2/1.3**.
4. **A behavioral eval harness is a separate follow-on build task** (sequenced *after*
   the prompt work, not alongside Phase 1 — per the 2026-06-27 clarification). Snapshot
   tests prove *wording*, not *behavior*, so we do want a scored, repeatable eval (golden
   scenarios → real narrators → deterministic metrics + an LLM-judge rubric) sweeping
   models × shape profiles × reasoning settings — but it ships as its **own task once the
   prompt phases are in**. **Interim verification is manual** golden-scenario eval on the
   dev account, and the reasoning probes P1–P3 are likewise **run by hand** until the
   harness exists (it will later automate them). OpenRouter spend is accepted; the harness
   stays **out of `pnpm verify` / CI**. See §Behavioral eval harness (follow-on task).

---

## Problem statement

The narrator over-produces and over-rewards. Two structural causes in the current
prompt, both fixable:

1. **A length floor that invites topic sprawl.** `PARAGRAPH_GUIDANCE`
   (`src/server/engine/prompts/constants.ts:8`) says *"Write 3–5 paragraphs per
   turn."* Combined with `PROSE_STYLE_RULES` rule 6 (*"At least one NPC action per
   turn should be self-motivated"*, `narrative.ts:109`), a quiet one-line player
   input ("hi") still has to fill 3–5 paragraphs, so the model manufactures errands,
   open-thread reminders, and extra speakers to reach the floor. The chat lane has
   the same shape softer — `CHAT_RULES` rule 4 (`prompts/character-chat.ts:153`)
   says *"one or two short paragraphs"*, which is better but still a fixed target.

2. **No proportionality signal, so the default is to validate.** The narrator is
   told *how* a character feels about the player (`buildRelationshipBlock`,
   `scene.ts:1136`) and, when intake classifies a social act, exactly how the target
   takes it (`buildReactionLine`, `scene.ts:1189`, rendered as `## Reaction
   (authored disposition — play this; do not re-decide whether they mind)`). But
   **nothing tells the narrator that an *unclassified* remark deserves no special
   emotional reaction.** Absent a `## Reaction` line, the model falls back to its
   RLHF prior: warmth, gratitude, doting. The chat lane has *no* reaction machinery
   at all (no presence, no exposure, no `buildReactionLine`) — only `WARMTH_HINTS`
   keyed off the affinity stage (`prompts/character-chat.ts:72`), which steers
   baseline warmth but never says "a plain remark gets a plain answer."

The reaction *curve* already produces proportionality — `evaluateSocialReaction`
(`src/contracts/personality/reactions.ts:116`) returns a `band` that is literally
`"barely registers it"` / `"is mildly pleased"` / `"is pleased"` / `"is delighted"`
(`bandFor`, `reactions.ts:166`). The information exists; the prompt just doesn't
turn the **absence** of a strong band into restraint, and the length floor actively
fights restraint.

---

## Current architecture findings

Grounded in the files this plan touches.

### Prompt assembly is centralized and snapshot-testable
All narrator prompt text is pure functions in `src/server/engine/prompts/`
(`narrative.ts`, `character-chat.ts`) with tunables in `constants.ts`. Tests in
`narrative.test.ts` / `character-chat.test.ts` assert anchor strings, block order,
byte-stability, fence integrity, and caps. **Every wording change in this plan has a
test home already.** (Builders are `import`ed straight in the tests, not snapshotted
to a `.snap` file — assertions are explicit `toContain` / ordering checks.)

### The session narrator is a two-block prompt over real chat history
`assemblePreTurn` (`pipeline.ts:487`) builds:
- `system` = `buildStaticRulebook(...)` (`narrative.ts:168`) — byte-stable across a
  session's consecutive turns (prefix caching, asserted by `narrative.test.ts:120`).
- `messages` = the last `NARRATIVE_HISTORY_TURNS` real `{role:"user", input}` /
  `{role:"assistant", narration}` pairs, then **one** final `{role:"user"}` carrying
  `buildTurnContext(...)` (`narrative.ts:306`) — the volatile state digest + the
  fenced player input (`pipeline.ts:816-821`).
- Streamed via `streamText` in `liveNarrativeStream` (`pipeline.ts:318`) with
  `providerOptions: narrativeProviderOptions(modelId, { sortLatency: true })`.

### Character chat is the same shape, minus session machinery
`streamCharacterChat` (`engine/character-chat.ts:41`) sends
`{ system: buildCharacterChatSystemPrompt(...), messages: windowed user/assistant }`
via the same `streamText` + `narrativeProviderOptions(modelId)` path. No presence,
exposure, RAG, `buildReactionLine`, or `buildTurnContext` — the system prompt
(`prompts/character-chat.ts:165`) is the whole rulebook, and a flat message window
is the only memory.

### The digest pattern already exists for volatile, deterministic restatement
`buildTurnDigest` (`scene.ts:616`) renders `## This turn (binding digest — each line
restates an authoritative block below)` immediately after the clock in
`buildTurnContext` (`narrative.ts:316`, `pipeline.ts:747`). Its discipline is
**pure restatement** of authoritative blocks (presence: "Voice freely" / "May bring
in" / "Never enact", plus a blocked-threshold line) — *"every line restates an
authoritative block, never new facts."* This is the right host pattern for a Phase 2
"response shape" line. It renders nothing when there's nothing to constrain.

### The reaction line is the anti-doting lever, already wired
`buildReactionLine` (`scene.ts:1189`) is fed from `intentBrief.socialActs`
(`pipeline.ts:771`), resolves against the NPC's authored disposition + world cards,
and renders the curve's verdict band. It's **volatile** (never cached) and produced
by the same resolver/curve the merge applies, so the line and the affinity delta
can't disagree. **Today it only renders for a classified `socialAct`** — there's no
"and when there's no act, don't escalate" counterpart. That gap is what Phase 1's
proportionate-reaction rule and Phase 2's reaction-scale line close.

### Intake already produces the structured signal Phase 2/3 need
`IntentBrief` (`src/contracts/turns/intent-brief.ts`) carries `actionType`
(`converse | move | observe | … | meta | other`), `addressedNpcs`, `socialActs`,
`narratedNpcBehaviors`, `movement`, etc., all display-name-keyed and degrade-to-empty
(`emptyIntentBrief()`). It's persisted on the turn and already drives
`buildReactionLine` / `buildPuppetDeflection` / glance / awareness. **Phase 2 can
derive a focus line from data already in `assemblePreTurn` — no new model call.**

### Reasoning knobs are request-level and partly model-hostile today
- `narrativeProviderOptions` (`provider.ts:83`) deliberately sets **no** reasoning
  knob: a 2026-06-21 live probe showed the default narrator **Aion 2.0**
  (`aion-labs/aion-2.0`) *ignores* `effort:"minimal"` and `reasoning.max_tokens:128`
  (usage unchanged ~220 tok/turn) and *rejects* `effort:"none"` /
  `reasoning.enabled:false` ("Reasoning is mandatory for this endpoint").
- `generateChecked` (`generate-checked.ts:41,94`) *does* send
  `reasoning:{enabled:false}` for fast classifiers, and the option doc notes it's
  reliable on `deepseek-v4-flash` and `glm-5.2` but rejected by models that mandate
  reasoning (`gemini-3.5-flash`, `aion-2.0`).
- Versions: `ai ^6.0.201`, `@openrouter/ai-sdk-provider ^2.9.1`, `zod ^4.4.3`.

---

## Role/message architecture

**1. Are we already sending `system`, `user`, and `assistant` for both lanes?**
Yes. Session: `streamText({ system, messages })` where `messages` is real
`user`/`assistant` history + a final `user` (`pipeline.ts:318,816`). Chat:
`streamText({ system, messages })` where `messages` is windowed real
`user`/`assistant` (`character-chat.ts:47,52`). Both use a single `system` string and
genuine role-tagged history.

**2. Would splitting into more role messages help, or hurt caching / clarity?**
It would **hurt**, for this goal. Prefix caching only pays while the `system` prefix
is byte-stable (`prompts.md` §"The two-block narrative prompt";
`narrative.test.ts:120`). Splitting stable rules across several `system` messages
risks (a) some upstream OpenRouter providers concatenating/normalizing multiple
system parts (boundary lost, and any normalization change = cache miss), and (b)
moving any volatile text into a system message poisons the cached prefix on every
turn. Splitting the *user* side (e.g. a separate "rules reminder" user message)
pollutes the real-history window the model reads as voice continuity
(`NARRATIVE_HISTORY_TURNS`) and competes with the actual last turn for "what just
happened." The current 1-system + real-history + 1-volatile-user shape is already the
right factoring; this plan adds **text inside those existing blocks**, not new roles.

**3. Should we add artificial `assistant` example messages?**
**No** (default). Skepticism warranted: a fake `assistant` turn sits adjacent to the
real history window and primes length, voice, and content far more strongly than rule
text — it would teach the model the *length* and *register* of the example, which is
exactly the variable we're trying to keep flexible ("concise by default, expand when
warranted"). It also breaks history clarity (`pipeline.ts:817` interleaves only real
turns; a synthetic pair would read as "this happened"). Keep guidance as **stable
rule text** (Phase 1, cached in `system`) or **volatile derived lines** (Phase 2, in
the final `user`). Few-shot assistant exemplars are allowed **only** as a
deliberately-gated eval experiment (§Open questions), never as the default path.

**4. Does AI SDK + OpenRouter preserve multiple `SystemModelMessage`s, or flatten?**
**Treat as unverified — do not rely on it.** `ai@6` accepts `system: string` plus a
`messages` array that may include role `"system"` parts, but how
`@openrouter/ai-sdk-provider@2.9.1` maps multiple system parts to the upstream
OpenAI-style `messages` (kept as separate `{role:"system"}` entries vs. merged) is
provider-/endpoint-dependent and not contracted. Probe before ever depending on it
(§Open questions, probe P0). The recommendation below sidesteps the question
entirely by keeping a single `system`.

**5. Safest target architecture (recommended — matches the stated preference):**
- **Stable rulebook stays in one `system` string** (`buildStaticRulebook`). All
  Phase 1 wording lands here (and in the chat `system`).
- **Real history stays `user`/`assistant`** (unchanged).
- **Volatile state + focus + player input stay in the final `user` message**
  (`buildTurnContext`). Phase 2's reaction-scale / speaker-focus line lands here,
  next to `buildTurnDigest`.
- **No fake `assistant` messages** outside a gated eval.
- **Untrusted fences unchanged**: player input keeps `neutralizePlayerInput` +
  `fenceUntrusted` (`narrative.ts:353`); authored spans keep their fences. No Phase
  adds raw untrusted text outside a fence, and all new lines are **framework text**
  (derived from typed state), never echoed player prose.

---

## Reasoning strategy

**1. Can OpenRouter reasoning options go through `providerOptions.openrouter` for
narrator calls?** Yes — same channel `generateChecked` already uses
(`generate-checked.ts:94` sets `providerOptions.openrouter.reasoning`). For the
narrator we'd thread a `reasoning` field through `narrativeProviderOptions`
(`provider.ts:83`) so `streamText` (`pipeline.ts:332`) and chat
(`character-chat.ts:57`) both pick it up from one place — mirroring how
`PROVIDER_IGNORE` / `providerRouting` are already per-model there.

**2. Are reasoning controls request-level or per prompt-section?** **Request-level.**
There is no way to ask the model to "reason only about focus" within one generation.
This is the central architectural reason a *separate* planner call (Phase 3) is the
only way to get *selective* reasoning, rather than a per-section prompt trick.

**3. For the final narrator generation, enable / disable / minimize / default?**
**Leave model-default per model** for now. The narrator's job is prose quality;
there's no evidence reasoning is the cause of over-talking (that's the length floor),
and the one model we have data on (Aion 2.0) mandates reasoning. Don't touch the
narrator reasoning knob until a probe shows a *specific* model gets more topical /
less verbose with it changed.

**4. Is a small structured pre-narration "focus planner" a better use of reasoning
than making the narrator reason more?** **Yes, if reasoning is wanted at all.**
Because reasoning is request-level (Q2), the only way to "spend reasoning on
planning" without inflating narration is a separate `generateChecked` call on a cheap
agent model (`deepseek-v4-flash`) — which is exactly Phase 3's `NarrationFocusBrief`.
But note: Phases 1–2 need **no reasoning** at all (rules + deterministic derivation),
so the planner is a fallback, not the first move.

**5. Live probes before changing any reasoning knob.** See §Open questions P1–P3.
Measure, per model, per setting `{default, enabled:false, effort:low}`: reasoning
tokens (provider usage), TTFT + total latency (the Inspector's `latencyMs` /
`routedProvider` already surface this — `provider.ts:28`, `generate-checked.ts:69`),
output-token / paragraph count (verbosity), and topicality on the golden scenarios.

### Conservative model matrix

| Model | Narrator reasoning stance | Notes / required probe |
|---|---|---|
| **Aion 2.0** (`aion-labs/aion-2.0`, default narrator) | **Leave model-default. Do not assume it can be disabled or minimized.** | The 2026-06-21 probe (recorded in `provider.ts:83`) showed effort-flooring bought nothing and `enabled:false` is rejected. Re-probe (P1) only to confirm still-true; do not ship a knob for it. |
| **GLM 5.2** (`z-ai/glm-5.2`, chat default) | **Probe, then likely set a knob** if a setting measurably reduces verbosity without hurting voice. | Honors `reasoning:{enabled:false}` per `generate-checked.ts` agent usage; verify supported `effort` values and the latency/verbosity/topicality effect *as a narrator* (P2). Already has a DeepInfra exclusion (`PROVIDER_IGNORE`, `provider.ts:44`) — keep it. |
| **Owl Alpha** (`openrouter/owl-alpha`) | **Send no reasoning option until parameters are verified.** | Stealth/alpha slug; supported params unknown and may reject or silently ignore. Probe `{default, enabled:false}` for accept/reject + effect (P3) before adding any knob. |

If selective reasoning is ultimately wanted, prefer the Phase 3 **structured
planner/classifier** call (cheap model, `disableReasoning` per model) over any
per-section narrator prompt trick.

---

## Proposed prompt text changes

All Phase 1 + Phase 2 changes are wording/derivation in the existing pure builders.
No new model call. Exact targets and proposed text below.

### Phase 1 — low-risk wording (cached `system`; immediate) — **shipped 2026-06-27**

> **Shipped note (2026-06-27).** All of 1.1–1.7 landed: `NARRATION_SHAPE_PROFILES` /
> `narrationShapeId` / the dev override store in `prompts/constants.ts` (replacing
> `PARAGRAPH_GUIDANCE`, now removed); `proseStyleRules(shape)` + the reframed self-motivated
> rule, new proportionate-reaction rule, response-first `RESPONSE_CONTRACT` rule, and the
> multi-party presence-fidelity rule in `narrative.ts`; the shape profile + proportionate +
> stay-in-voice rules in `character-chat.ts`'s `CHAT_RULES`; `narrationShape: narrationShapeId()`
> wired into both lanes (`pipeline.ts`, the chat route); the dev-only `POST/GET /api/dev/narration-shape`
> route (404 in prod, gated like impersonate) + a `NarrationShapeToggle` in the admin Inspector tab;
> snapshot tests in `narrative.test.ts` / `character-chat.test.ts`; and the `docs/prompts.md`
> §Narration shape & proportionate reaction section. The authored override (1.7) reuses the existing
> fenced Style-directive / `narratorGuidance` channels — no new schema. **Next:** interim manual
> golden-scenario eval (step 2) + probes P1–P3 (step 3) before Phase 2.

**1.1 Replace the paragraph floor with selectable shape profiles (decision 1).**
Make narration length a hot-swappable, eval-sweepable A/B knob instead of one
hard-coded string.

`src/server/engine/prompts/constants.ts` — replace the single `PARAGRAPH_GUIDANCE`
(line 8, consumed as `PROSE_STYLE_RULES` rule 1, `narrative.ts:104`):

```ts
export type NarrationShapeId = "concise_immersive" | "aggressive_concise";

export const NARRATION_SHAPE_PROFILES: Record<NarrationShapeId, string> = {
  // Default: focus without losing the immersive register.
  concise_immersive:
    "Write one focused beat per turn. Match length to what the input calls for, never " +
    "padding to a target: a quiet or simple input gets a short reply; a normal scene beat " +
    "is usually a few rich paragraphs; expand further only when the moment earns it — a " +
    "first encounter, a room entry or scene transition, a consequence touching several " +
    "characters, or an explicit player ask. Keep the prose vivid. End on a natural " +
    "sentence; never trail off.",
  // Backup A/B variant — flip on to test a tighter feel.
  aggressive_concise:
    "Be brief and tightly scoped. Answer the player's input in as few sentences as it " +
    "honestly needs, then stop; expand into fuller description ONLY for a first encounter, " +
    "a scene transition, a multi-character consequence, or an explicit player ask. No " +
    "padding, no summary, no wrap-up. End on a natural sentence.",
};

/** Active narration shape. Resolution order: the live dev-settings override (set via the
 *  dev-only toggle, below) → NARRATION_SHAPE env (headless default) → concise_immersive.
 *  Per-call callers (tests, eval harness) pass an explicit shape and skip this. */
export function narrationShapeId(): NarrationShapeId {
  const pick = readDevNarrationShape() ?? process.env.NARRATION_SHAPE; // dev override is undefined in prod
  return pick === "aggressive_concise" ? "aggressive_concise" : "concise_immersive";
}
```

To make the profile **per-call swappable** (so the eval harness can sweep both in one
process and both can be snapshot-tested), thread it through the builders rather than
capturing a module-level const:

- `narrative.ts`: add `narrationShape?: NarrationShapeId` to `StaticRulebookInput`
  (`narrative.ts:17`); convert the `PROSE_STYLE_RULES` const array into a
  `proseStyleRules(shape: NarrationShapeId)` function (same pattern as the existing
  `dialogueTaggingRules` / `narrationModeRules` functions), whose rule 1 is
  `NARRATION_SHAPE_PROFILES[shape]`. `buildStaticRulebook` calls
  `proseStyleRules(input.narrationShape ?? "concise_immersive")`.
- `pipeline.ts`: pass `narrationShape: narrationShapeId()` into `buildStaticRulebook`
  (`pipeline.ts:695`). **Chat lane too** (decision: chat adopts profiles):
  `buildCharacterChatSystemPrompt` gains a `narrationShape?` input, defaulted from
  `narrationShapeId()` in the chat route, and its length guidance consumes
  `NARRATION_SHAPE_PROFILES[shape]` (see 1.6). The one dev toggle governs both lanes.

**Live dev toggle (decision: dev-settings UI now).** A dev-only control flips the active
profile without a restart. Mirror the existing dev-only impersonate path
(`/api/dev/impersonate`, 404 in prod): a `POST /api/dev/narration-shape` route sets a
server-side value via `setDevNarrationShape`, read by `readDevNarrationShape` (a
module-level store seeded from `NARRATION_SHAPE`; persisting it to a dev-settings row is
optional for survive-restart), and a small toggle in the dev UI (the Inspector panel /
world-tab dev area) calls it. Gate it exactly as the impersonate route is gated so it
never ships to players. Flipping it busts the prefix cache for subsequent turns —
intended, and dev-only.

No character/token/line number appears in either profile (acceptance criterion). The
profile is a **global dev/code knob only — not per-world** (decision: global only); authors
tune richness via authored Style directives (1.7). Both profiles are snapshot-tested in
**both** lanes.

**1.2 Make the response-first rule explicit — without banning liveliness (decisions 2 + 3).**
`RESPONSE_CONTRACT` (`narrative.ts:117`). Append rule 3 (revised from the original
"one job, no unrelated topics" wording, which decision 3 deliberately relaxed):

```
3. The player's input is the turn's core — answer it first and give it the focus.
   Living-world texture around it is welcome (a present character pursuing their own
   goal, mood, schedule, or an open thread; an ambient detail) and may be mildly
   tangential — but it supports the response, never buries it under unrelated errands,
   logistics, or open-thread reminders, and never becomes doting. If authored Style
   directives call for a richer or different shape, follow them.
```

The last sentence is the **decision-2 override** (the narrator already follows authored
`Style directives` / `narratorGuidance`, fenced in `buildStaticRulebook`). This keeps
the existing intimate-only restraint (`PROSE_STYLE_RULES` rule 10, the "coat-drive
rule") and the authority order (input > Direction > threads) intact, while honoring
decision 3's "preserve lively texture."

**1.3 Keep self-motivated NPC initiative as living-world texture (decision 3).**
`PROSE_STYLE_RULES` rule 6 (`narrative.ts:109`) — decision 3 keeps this rule rather
than softening it; only reframe it so initiative reads as *life*, not *doting*:

```
6. At least one present NPC should do something self-motivated each turn — act on their
   own goals, mood, schedule, or an open thread (see the NPC affordances block) — so the
   world feels alive. This initiative is texture around the player's beat, never a reward
   or validation of the player; keep it in character and proportionate (see the Reaction
   and Relationships blocks).
```

This preserves liveliness (the "at least one self-motivated action" floor stays) but
routes NPC initiative away from doting and toward autonomous character life.

**1.4 Add a proportionate-reaction rule.**
New `PROSE_STYLE_RULES` rule (insert after the new rule 6; renumber tail). Proposed:

```
- Reactions are proportionate. You do not need to verbally reward, thank, or validate
  every player statement. Compliments, agreement, greetings, and small overtures
  scale with the "## Reaction" line, the Relationships block, the character's mood,
  and their disposition — when no "## Reaction" line is present, treat the input as
  ordinary: a plain answer, a small gesture, a tease, a deflection, or no special
  emotional reaction is correct. Affection, gratitude, or being flustered are earned,
  not the default.
```

This explicitly names the existing blocks (`## Reaction` from `buildReactionLine`;
Relationships from `buildRelationshipBlock`; mood from `buildMeterConditionBlock`) so
the model leans on authored verdicts instead of inventing whether a remark matters —
and crucially says what to do **when there is no verdict**.

**1.5 Add multi-party restraint.**
Extend `PRESENCE_FIDELITY_RULES` (`narrative.ts:65`) with a new rule (name-free, so it
stays cache-stable — asserted by `narrative.test.ts:104,158`):

```
7. Presence is permission to exist in the scene, not an obligation to speak. Voice
   only the characters the player addressed, who are directly affected by this beat,
   or who have a concrete in-the-moment reason to act. A present character with
   nothing to do this turn can stay silent — do not give every present NPC a line.
```

This is **not** in tension with the self-motivated-NPC rule 6 (decision 3): rule 6
keeps one autonomous NPC beat for liveliness; rule 7 forbids a *chorus* — every present
NPC chiming in or each validating the player. One character acting on their own; the
rest silent unless they have a reason.

(Alternatively this can live as a new `PROSE_STYLE_RULES` line; presence-fidelity is
the better semantic home and keeps the "who may speak" rules together.)

**1.6 Carry the same discipline into character chat.**
`CHAT_RULES` (`prompts/character-chat.ts:145`). The chat lane has no presence/reaction
machinery, so the rules must self-contain the proportionality. Revise rule 4 and add
two rules:

- Rule 4 → **consume the active shape profile** (decision: chat adopts profiles), threaded
  via the new `narrationShape` input. Lead rule 4 with `NARRATION_SHAPE_PROFILES[shape]`,
  then keep the chat-specific tail, so the one dev toggle changes chat length identically
  to the session lane:
  ```
  4. {active shape profile}. Resolve the immediate beat and end on a present moment
     (a line, a gesture, a look), never a summary or reflection.
  ```
- New rule (proportionate reaction, since chat has no `## Reaction` line — it leans on
  `WARMTH_HINTS` / the "Your current state" block instead):
  ```
  - React in proportion. An ordinary remark, greeting, or mild compliment gets a
    natural, in-character answer — not effusive gratitude or doting. Let warmth track
    your current state and how you actually feel about this person (above); affection
    is earned, not automatic. You may tease, deflect, change the subject, or answer
    plainly.
  ```
- New rule (single-character analogue of multi-party restraint — keep to your own
  voice; don't narrate a chorus):
  ```
  - Stay in your own voice and the current topic. Don't spin up unrelated errands or
    new sub-plots to fill space; answer what's in front of you.
  ```

`warmthHintForStage` (`prompts/character-chat.ts:85`) already steers *baseline*
warmth per stage; the new rule governs *reaction* to a given message, which is the
missing half.

**1.7 Authored override (decision 2).** Concise + proportionate is the global default,
but a world author can opt back into richer/warmer narration through the channels that
already reach the rulebook — `worldStyle.directives` and `narratorGuidance` (fenced into
`buildStaticRulebook`, `narrative.ts:176-180`). The decision-2 clause in rule 1.2 ("If
authored Style directives call for a richer or different shape, follow them") is the
seam; **no new schema or field** is required. Character-level warmth is already
overridable *by construction* — proportionality scales with disposition + relationship +
`## Reaction`, so a canonically devoted character at high affinity dotes correctly
without any new knob. Document this in `docs/prompts.md` so authors know directives like
"lush, descriptive narration" are the lever.

### Phase 2 — deterministic "response shape" line (volatile `user`; no new call)

Once Phase 1 ships and is evaluated, add a derived, restatement-only shape line to
the turn context — same discipline as `buildTurnDigest` (restate, never invent).

- **New pure builder** `buildResponseShape(...)` in `src/server/engine/scene.ts`,
  next to `buildTurnDigest`. Inputs come straight from data already in
  `assemblePreTurn`: `intentBrief.actionType`, `intentBrief.addressedNpcs`, the
  present-NPC set, the evaluated reaction band (reuse the exact
  `resolveSocialReaction`/`evaluateSocialReaction` result `buildReactionLine` already
  computes — factor it so the band is computed once and shared), open-thread count,
  and `brief.directives`. **No new LLM call.**
- **New optional field** `responseShape?: string` on `TurnContextInput`
  (`narrative.ts:216`), rendered in `buildTurnContext` immediately **after**
  `turnDigest` (`narrative.ts:316`) so the two volatile-restatement blocks sit
  together at the top of the `user` message, after the clock and before wardrobe.
  Wire it in `pipeline.ts` alongside the `buildTurnDigest` call (`pipeline.ts:747`).
- **Keep `buildTurnDigest` unchanged** (it owns presence restatement); the shape
  line is a sibling, not an extension of its signature — this preserves the existing
  digest tests untouched.

The line restates only derived facts. Example renderings (illustrative, not final):

```
## Response shape (this turn — derived, not new facts)
- Current beat: answer the question; introduce a new topic only if it follows from the answer.
- Reaction scale: ordinary acknowledgement — do not escalate affection.
- Speaker focus: only Mara needs to answer; another present NPC speaks only if directly affected.
```

Mapping (deterministic):
- **Current beat** ← `actionType` (`converse`/`observe` → "respond, don't open a new
  topic"; `move` → follow guidance already covers it; etc.) + open-thread/Direction
  presence ("a new topic is allowed only if a Direction or urgent thread requires it").
- **Reaction scale** ← the evaluated band: no `socialAct` → "ordinary acknowledgement
  — do not escalate affection"; band `barely registers it`/`mildly` → "small";
  `pleased`/`delighted` (or `displeased`/`stung`) → defer to the `## Reaction` line,
  emit nothing here (avoid double-stating). This makes the *absence* of a strong band
  an explicit instruction, which Phase 1 rule 1.4 states only in the abstract.
- **Speaker focus** ← `addressedNpcs ∩ present`; empty → omit the line (no false
  constraint). Names are framework-derived from typed participants, not echoed input.

Render nothing (`""`) when nothing is constrained, exactly like `buildTurnDigest`
(`scene.ts:643`).

**Character chat Phase 2 (optional):** chat has `chat-state.ts` (affinity, mood,
conditions, premise) feeding `buildStateSection` (`prompts/character-chat.ts:95`). A
chat analogue could add a one-line "react in proportion to your current state" steer
*only when* state indicates neutral/low warmth — but Phase 1's CHAT_RULES change may
suffice; gate on eval.

### Phase 3 — optional structured pre-narration focus planner (later-phase only)

**Only if Phase 1 + 2 are insufficient on the golden scenarios.** A small structured
classifier, not prose. Clearly marked deferred.

- **Schema** `narrationFocusBriefSchema` (new, alongside `intent-brief.ts`),
  `.default()`-ed per field so parsed-empty is the degraded fallback (same convention
  as `IntentBrief`):
  - `primaryResponse`: `converse | answer_question | resolve_action |
    react_emotionally | transition_scene | ooc_answer`
  - `directTargets`: NPC display names (capped array, like `addressedNpcs`)
  - `reactionScale`: `none | small | moderate | strong`
  - `allowedNewTopic`: `none | one_open_thread | urgent_scene_event`
  - `suggestedShape`: `concise_exchange | scene_establishing | multi_party |
    action_resolution`
  - `notes`: short list, no prose generation
- **Call** via `generateChecked` (`generate-checked.ts`) on the agent model
  (`agentModelId(bundle.world.agentModel)`), `code: "agent.focus"`, with
  `disableReasoning` set per the matrix (true for `deepseek-v4-flash`/`glm-5.2`;
  never for a mandate-reasoning model), `degradeSeverity: "warn"`,
  `fallback: emptyNarrationFocusBrief`. Run it in the existing pre-turn fan-out
  (`pipeline.ts:567`), concurrent with retrieval/intake, so its latency hides — or
  fold it into the intake agent's output to avoid a second call entirely (preferred:
  intake already classifies `actionType`/`addressedNpcs`/`socialActs`; extend its
  schema rather than add a leg).
- **Renders** through the *same* `buildResponseShape` field as Phase 2 (the planner
  just supplies richer inputs); degrades safely to the Phase-2 deterministic
  derivation, then to nothing.
- **Never replaces deterministic rules** for presence, wardrobe, movement, or
  perception — those stay owned by the existing scene builders / merge. The planner
  only shapes *focus and reaction scale*.

Decision rule for promoting Phase 3: if, after Phase 1–2, the golden scenarios still
show topic sprawl or doting on ≥2 of the curated narrators, build it (preferring the
intake-extension form).

---

## Testing and eval plan

### Snapshot / unit tests
`src/server/engine/prompts/narrative.test.ts` (`buildStaticRulebook` +
`buildTurnContext` describe blocks):
- Assert the old floor is **gone**: `not.toContain("3–5 paragraphs")` /
  `not.toContain("3-5 paragraphs")`.
- Assert the default (`concise_immersive`) shape text is present:
  `toContain("Write one focused beat per turn")`, `toContain("Keep the prose vivid")`.
- Assert the `aggressive_concise` profile is **selectable and different**: build with
  `narrationShape: "aggressive_concise"`, `toContain("Be brief and tightly scoped")`,
  and assert it differs from the default build.
- Assert each fixed profile is **byte-stable**: two builds with the same `narrationShape`
  are identical (extends the existing byte-stability test, `narrative.test.ts:120`).
- Assert the response-first rule present: `toContain("The player's input is the turn's
  core")`, plus the decision-2 override clause `toContain("authored Style directives")`.
- Assert proportionate-reaction rule present: `toContain("Reactions are proportionate")`
  / `toContain("earned, not the default")`.
- Assert the self-motivated-NPC rule (rule 6) **survives** (decision 3 kept liveliness):
  `toContain("so the world feels alive")`.
- Assert multi-party restraint present and **name-free / cache-stable**: extend the
  existing slice-equality tests (`narrative.test.ts:104,158`) to cover the new
  presence-fidelity rule (build with two different `npcNames`, assert the slice is
  byte-identical).
- Assert **no hard cap introduced**: a regex guard that neither profile nor the rulebook
  contains `\d+ (characters|tokens|words|lines|sentences|paragraphs)`.
- Keep the untrusted-fence tests green (`narrative.test.ts:129,367`) — unchanged.

`src/server/engine/prompts/character-chat.test.ts` (`buildCharacterChatSystemPrompt`):
- Assert the fixed "one or two short paragraphs" target is replaced
  (`not.toContain("one or two short paragraphs")`), new concise/proportionate rules
  present, "How to respond:" / `[Name]` tagging still present
  (`character-chat.test.ts:48-50,81`).
- Assert the chat lane **consumes the shape profiles** (decision: chat adopts profiles):
  the default build contains `"Write one focused beat per turn"`; a build with
  `narrationShape: "aggressive_concise"` contains `"Be brief and tightly scoped"` and
  differs from the default.

Phase 2 adds, in `narrative.test.ts` `buildTurnContext`:
- `buildResponseShape` rendered after the digest and before wardrobe (ordering
  assertion in the style of `narrative.test.ts:181`).
- Omitted (`""`) when nothing is constrained (mirror the digest-omission test,
  `narrative.test.ts:216`).
- Reaction-scale line emitted as "ordinary acknowledgement" when `socialActs` is
  empty, and **suppressed** (deferring to `## Reaction`) when a strong band is
  present — a focused unit test on `buildResponseShape` itself.

### Manual model eval matrix (interim — until the harness follow-on)
This is the **interim** behavioral check until the automated harness (§Behavioral eval
harness) is built as a separate follow-on task. Run each golden scenario (below) against
each curated narrator, via the dev account (`uxtest-main@vesper.local`, see CLAUDE.md) on
a seeded session, before/after Phase 1, sweeping **both shape profiles** via
`NARRATION_SHAPE`. Capture output length, topic count, and reaction tone. Use the
Inspector's per-leg latency/provider (`routedProvider`, `latencyMs`).

| Model | Lane | What to watch |
|---|---|---|
| Aion 2.0 (`aion-labs/aion-2.0`) | session default | Topic sprawl + doting (its abliterated prior is the worst offender); confirm Phase 1 wording lands without a reasoning knob. |
| GLM 5.2 (`z-ai/glm-5.2`) | chat default + session option | Verbosity vs. the dropped floor; whether a reasoning setting (P2) further tightens topicality. |
| Owl Alpha (`openrouter/owl-alpha`) | option | Whether it honors the shape guidance at all; param acceptance (P3). |

### Golden eval scenarios
Pass = focused, proportionate, on-beat. Fail = sprawl, doting, or unrequested
logistics.

1. **"hi" in a quiet room.** Expect: brief in-character response; no effusive
   gratitude; at most **one light self-motivated NPC beat** (decision 3 keeps the world
   alive), never a pile of new plots or doting. (Exercises 1.1, 1.3, 1.4, 1.5.)
2. **"That jacket looks good on you."** Expect: proportionate to disposition /
   relationship / `## Reaction` — pleased-but-measured for a neutral acquaintance,
   not worshipful unless the relationship + reaction support it. (Exercises 1.4 +
   `buildReactionLine`; Phase 2 reaction-scale line.)
3. **Direct in-world factual question while open threads exist.** Expect: answer
   first; no unrelated **logistics dump** or thread-reminder list — one ambient touch is
   fine, an errand checklist is not. (Exercises 1.2 + `RESPONSE_CONTRACT`; Phase 2
   "answer first; new topic only if it follows".)
4. **Small action with several NPCs present.** Expect: only directly relevant NPCs
   react/speak; others may stay silent. (Exercises 1.5; Phase 2 speaker-focus.)
5. **Intimate / emotionally charged beat.** Expect: stay inside the moment; no
   errands/reminders/logistics unless the player raises them. (Already covered by
   `PROSE_STYLE_RULES` rule 10 — this scenario is a **regression guard** that Phase 1
   doesn't weaken it.)
6. **Character-chat one-on-one compliment.** Expect: distinct character voice;
   focused, proportionate reply; no generic doting. (Exercises the `CHAT_RULES`
   changes 1.6.)

---

## Behavioral eval harness (follow-on task)

Sequenced **after** the prompt phases (decision 4, clarified 2026-06-27) — its **own
build task with its own roadmap line**, not part of Phase 1. Until it exists,
verification is the interim manual eval above. When built:

- **Placement:** a standalone script (`scripts/eval-narration.ts`, run via a
  `pnpm eval:narration` alias) or a vitest file guarded to skip unless
  `OPENROUTER_API_KEY` + `EVAL=1` are set — **never in `pnpm verify` / CI** (live spend).
- **Real prompt assembly:** reuse the actual builders (`buildStaticRulebook` /
  `buildTurnContext` / `buildCharacterChatSystemPrompt`) over a few fixture session
  bundles, so it exercises the *real* prompt, not a mock. Pass `narrationShape` directly
  to sweep both profiles in one process.
- **Run matrix:** golden scenarios × narrators (Aion 2.0, GLM 5.2, Owl Alpha) × shape
  profiles (`concise_immersive`, `aggressive_concise`) × reasoning settings (the P1–P3
  knobs). Stream each via the existing `openrouter().chat()` path.
- **Deterministic metrics (no judge — cheap, stable):** paragraph/segment count and the
  number of distinct NPC speakers (reuse `parseSegments` / `engine/segmenter.ts`) →
  catches length regressions and multi-party over-talking directly; TTFT / total latency
  + routed provider (`routedProvider`, `latencyMs`).
- **LLM-judge rubric (1–5 each), strong judge model:** answered-the-input-first,
  proportionate-reaction (cross-checked against the scenario's authored `## Reaction`),
  on-beat focus, no-unrequested-logistics, voice quality. Judge call is structured via
  `generateChecked` (same resilience ladder), `disableReasoning` per the matrix.
- **Output:** a scored table per (model × profile × reasoning) so we pick the default
  profile empirically and decide each model's reasoning knob with data — this is where
  probes **P1–P3** are ultimately automated (until then they're run by hand).
- **Scope guard:** the harness *measures*; it never gates `pnpm verify`. A red rubric is
  a signal to iterate prompt wording, not a build failure.

---

## Rollout plan

1. **Phase 1 wording + shape profiles + dev toggle** — `constants.ts`
   (`NARRATION_SHAPE_PROFILES`, `narrationShapeId`, `readDevNarrationShape`) + `narrative.ts`
   (`proseStyleRules(shape)`, `StaticRulebookInput.narrationShape`, the RESPONSE_CONTRACT +
   presence-fidelity rules) + `prompts/character-chat.ts` (`CHAT_RULES` consuming the
   profile) + both pipeline callers (`pipeline.ts`, chat route) + the **dev-only toggle**
   (`POST /api/dev/narration-shape` + a dev-UI control, gated like impersonate), with the
   snapshot tests above; default profile `concise_immersive`, governing **both** lanes,
   **global-only** (no per-world field). Update `docs/prompts.md` in the same change (the
   PROSE_STYLE_RULES / RESPONSE_CONTRACT / presence-fidelity descriptions, the shape-profile
   mechanism + dev toggle, both-lanes coverage, and the authored-override lever). Run
   `pnpm verify`. (Roadmap line already added.)
2. **Interim manual eval** (matrix + golden scenarios) on the dev account, sweeping both
   profiles via `NARRATION_SHAPE`. Go/no-go for Phase 2 and for picking the default profile.
3. **Reasoning probes P1–P3** by hand (independent of Phase 1). Only if a probe shows a
   clear win, add a per-model `reasoning` knob to `narrativeProviderOptions`
   (`provider.ts:83`) — never for Aion 2.0.
4. **Phase 2 shape line** if eval shows residual sprawl/doting. New `buildResponseShape`
   + `TurnContextInput.responseShape` + pipeline wiring + tests.
5. **Phase 3 planner** only if Phase 1–2 still insufficient on ≥2 narrators — preferring
   the intake-schema-extension form over a new agent leg.
6. **Behavioral eval harness** — a **separate follow-on task** (its own roadmap line) once
   the prompt work is in, automating steps 2–3.

Each phase is independently shippable and independently revertible (Phase 1 is prompt
wording + an additive, dev-only profile toggle with no player-facing runtime change;
Phase 2 is an additive optional field; Phase 3 is an additive degrade-safe call; the
harness touches no runtime path).

---

## Risks and mitigations

- **Dropping the floor makes replies too terse / clipped.** Mitigation: the default
  profile is `concise_immersive` (not aggressive), with an explicit "expand when warranted"
  list (first encounter, transition, multi-character consequence, explicit ask) and "keep
  the prose vivid"; `aggressive_concise` is opt-in. Eval scenarios 1 + 5 guard both ends.
- **Liveliness vs. focus tension (decision 3).** Keeping unprompted NPC initiative risks
  re-introducing the over-talking we're fixing. Mitigation: the division of labor — rule 6
  allows **one** autonomous NPC beat for life; rule 7 forbids a **chorus**; rule 1.4
  forbids **doting**. The harness's distinct-speaker-count metric catches a creeping chorus
  even with liveliness on; if drift is still too high, the `aggressive_concise` profile is
  the dial.
- **Interim verification is manual (harness deferred).** Mitigation: snapshot tests lock
  the prompt *wording* so it can't silently change; the golden scenarios are explicit and
  run before each promotion; the follow-on harness adds repeatable scoring later.
- **Models ignore prose rules (esp. abliterated Aion 2.0).** Mitigation: Phase 2's
  volatile shape line rides *after* history near generation (the same reason
  `buildTurnDigest` re-anchors the tag format there) where it's hardest to ignore;
  Phase 1 alone may move some models and not others — the eval matrix is per-model for
  exactly this reason.
- **Prefix-cache regression.** Mitigation: each fixed shape profile is byte-stable, so
  the cached `system` prefix is stable for a session. Flipping the **live dev toggle**
  busts the cache for subsequent turns by design (a dev-only experimentation cost, not a
  player path); the harness/tests override per-call. Phase 2 adds only to the *volatile*
  user block (already uncached), and the new presence rule is name-free (cache-stability
  tests extended).
- **Phase 2 line "inventing" outcomes.** Mitigation: it restates only `IntentBrief` /
  presence / evaluated-band / Direction — same restatement-only contract as
  `buildTurnDigest`; reuse the *exact* reaction evaluation `buildReactionLine` already
  runs so the two can never disagree.
- **Reaction-scale line double-stating the `## Reaction` block.** Mitigation: emit the
  scale line only when there's **no** strong band (the gap case); defer to
  `## Reaction` otherwise.
- **Reasoning knob breaks a model.** Mitigation: never send a reasoning option to a
  model whose params aren't probed (Owl Alpha); Aion 2.0 stays default; degrade path
  in `generateChecked` already turns a rejected option into a clean fallback.
- **Chat lane drifts from session lane.** Mitigation: keep the wording parallel and
  cross-referenced; both lanes already share `narrativeProviderOptions` so any
  reasoning knob applies to both from one site.

---

## Open questions (require live provider probes)

P1–P3 are **run by hand** in the interim and **automated by the behavioral eval harness**
follow-on task. None blocks Phase 1 (which sets no reasoning knob).

- **P0 — multiple system messages.** Does `@openrouter/ai-sdk-provider@2.9.1` preserve
  two `{role:"system"}` parts to upstream, or merge them? Only matters if we ever
  consider splitting `system`; the recommendation avoids it, so P0 is low priority.
- **P1 — Aion 2.0 reasoning, re-confirm.** Is `reasoning.enabled:false` still rejected
  and `effort:"minimal"` still a no-op (per the 2026-06-21 note in `provider.ts:83`)?
  Confirm before assuming the comment is still accurate.
- **P2 — GLM 5.2 reasoning as a narrator.** Which `effort` values are accepted? Does
  `enabled:false` (or low effort) measurably reduce verbosity / latency and improve
  topicality on the golden scenarios — *as a narrator* (not just as a classifier)?
- **P3 — Owl Alpha params.** Does it accept any `reasoning` option (vs. reject /
  silently ignore)? What's the latency/verbosity baseline? Verify before sending
  anything.
- **P4 — few-shot exemplar experiment (gated).** Does one carefully-built synthetic
  `assistant` exemplar improve focus more than it harms length/voice flexibility?
  Default answer is "don't"; this is a measured experiment, not a planned change.

---

## Acceptance criteria

- The `3–5 paragraphs` floor is gone; replaced by selectable shape profiles
  (`NARRATION_SHAPE_PROFILES`), default `concise_immersive`, with an `aggressive_concise`
  backup. The profile is per-call selectable (builder input), flipped live by a **dev-only
  UI toggle** (gated like impersonate, never shipped to players), governs **both** the
  session and chat lanes, and is **global-only (no per-world field)**. No hard
  character/token/line/word/sentence/paragraph cap in either profile or anywhere in the
  narrator/chat prompts.
- A proportionate-reaction rule exists in **both** lanes (`PROSE_STYLE_RULES` and
  `CHAT_RULES`), naming the `## Reaction` / Relationships / mood / disposition signals
  and stating the no-verdict default.
- A response-first rule exists in `RESPONSE_CONTRACT` with the **authored-override**
  clause (decision 2); the self-motivated-NPC rule (`PROSE_STYLE_RULES` 6) is **retained**
  for liveliness (decision 3) and routed away from doting.
- A multi-party restraint rule exists (presence-fidelity), name-free and cache-stable,
  reconciled with rule 6 (one autonomous beat OK; no chorus).
- Each fixed profile is byte-stable for identical input; untrusted fences
  (`fenceUntrusted` / `neutralizePlayerInput`) are unchanged; prefix caching is preserved
  (profiles byte-stable; Phase 2 additions volatile-only).
- Every change maps to a named file/function/constant; no new LLM call is introduced
  before Phase 3, and Phase 3 is gated on Phase 1–2 eval.
- `narrative.test.ts` + `character-chat.test.ts` updated to assert the above; the interim
  manual golden-scenario eval is run on Aion 2.0 / GLM 5.2 / Owl Alpha before each phase
  promotion. `pnpm verify` passes.
- The behavioral eval harness lands as a **separate follow-on task** (its own roadmap
  line), not part of Phase 1.
- `docs/prompts.md` updated in the same change as any shipped wording.
