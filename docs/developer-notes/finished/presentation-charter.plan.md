# Presentation charter — one narrator craft law for both lanes, and the successor narrator repaired

Status: **shipped — 2026-07-22** — all five slices same-day (full gate green: lint /
cycles / typecheck / 2 394 pure tests / jscpd, plus the targeted sim int suites; live
verification on Fly v116 — a fresh `/worlds` chat confirmed second-person camera,
in-voice prose, mechanical `[Name]` attribution rendering, no id/handle leaks, lean
beat-scaled shape, attachments/chips hidden, retake = same cut + fresh prose + takes
browser + NO time advance, Go-on = no user row + span advance 8:01→8:02 + continuity
held across takes; screenshots in `screenshots/charter-*.png`). Leftovers, parked:
sensory-allowance port (OQ3) and a sim-lane voice ring (OQ4) below; the LLM-judge
audit leg and the prose-plus-sidecar A/B ride the owner-gated eval spend
([deferred.plan.md](deferred.plan.md)); token streaming stays deferred (withhold
contract); a richer "narrating…" progress state is optional polish — the existing
typing indicator covered the 30–90s renders legibly. (Planned 2026-07-22 from the
two-model narrator review — GPT + Fable
comparing the legacy chat narrator against the R2 successor narrator; owner endorsed the
review's frame: keep the engine and the committed-cut model, treat the current successor
narrator as an R2 prototype whose presentation layer shipped several stages early).

The engine's authority model is **not in question** — committed cuts, the §23.1 trust
boundary, ruling-8 withhold, viewpoint-partitioned §24 memory, and input admission all
stay exactly as shipped. What's broken is the **presentation layer**: the successor
narrator's prompt is a serialization of the cut, not a piece of the game. This plan
repairs it by extracting the legacy chat narrator's craft law into a **shared charter**
both lanes consume — never by copying the 2,645-line legacy prompt into the sim lane
(two giant rulebooks would diverge again).

Findings this plan answers (confirmed against `lib/simulation/presentation.ts`,
`server/engine/sim-exchange.ts`, `sim-narrator.ts`, and the route fork in
`app/api/chats/[chatId]/route.ts`):

| # | Finding | Severity |
| - | ------- | -------- |
| F1 | Camera/POV mismatch: the sim asks for "third-person prose from the viewpoint actor's vantage" while the viewpoint actor IS the player — it conflates epistemic access with prose camera. Legacy law: third-person character, second-person player ("you"). | Critical (feel) |
| F2 | No persona/voice/scenario: `sim-exchange` loads `sim_characters.name` only; the authored `CharacterProfile` (personality, voice anchors, exemplars, preferences, bio, species) never reaches the prompt. | Critical (feel) |
| F3 | No content framing / life-stage fence: the adult-fiction license AND the minor fence are both absent. | **Stop-ship** |
| F4 | Mixed narrator routes: only a plain send routes to the sim; continue / regenerate / action beats / attachments silently fall back to the legacy narrator, whose prose never became simulation truth — the next sim turn sees it as mere "previous narration". | **Stop-ship** |
| F5 | No shape discipline: "100–350 words" replaces the legacy proportionality / topic / dialogue-craft / freshness / resolve-then-one-move rules. | High |
| F6 | No attribution/notation contract: the `[Name]` tag law and the message-notation legend are absent, so the chat renderer's mechanical attribution has nothing to bind to. | High |
| F7 | No scrubbers/provider options: same Aion family, none of the protections (artifact strip, repeat collapse, `narrativeProviderOptions` reasoning/routing knobs). | High |
| F8 | Raw ids leak into the prompt (event ids, zone ids, action-definition ids, proposition keys, "act by second 123456", `BODILY READS: {json}`), inviting technical prose and id echo. | High |
| F9 | Auditor is declaration-only: it checks the arrays, not the prose; retry is a blind reroll (same prompt, no feedback); the bridge bolts raw beat summaries onto the prose. | High |
| F10 | Untrusted interpolation: player text, summaries, memory lines ride unfenced (legacy fences via `prompts/untrusted.ts`). | High |
| F11 | Thin history: 12 transcript lines vs the legacy lane's ~15 verbatim exchanges + summary fold. | Medium |

## Design

### 1. The charter — `server/engine/prompts/charter.ts` (+ `profile-sections.ts`)

Pure, parameterized prompt units extracted from `prompts/character-chat.ts`, consumed by
BOTH lanes. The extraction is a refactor with a hard invariant: **the legacy prompt
stays byte-identical** (the existing snapshot tests are the gate). Units:

- **Content framing** — `CONTENT_FRAMING` / `CONTENT_FRAMING_MINOR_PRIMARY` (+ the
  ensemble minor line for future multi-actor scenes), keyed off the authored age via
  `lifeStageForAge`, plus the binding life-stage register block.
- **Camera & agency** — legacy rules 2 and 4 plus the "Reading the player's message"
  perception block: third-person character, second-person player, involuntary-perception
  license, never author the player's words/actions/feelings, no mind-reading.
- **Attribution & notation** — legacy rule 3 (the mechanical `[Name]` tag contract) and
  the full message-notation legend (quotes/asterisks/underscores/OOC/texted-reply
  grammar).
- **Craft** — proportionality (rule 8), topic discipline (9), state-as-behavioral-law
  (12), the no-refusal rule (13), natural dialogue (14), the Shaping block
  (resolve-then-one-move + worked example + per-shape `chatLengthStory` + freshness),
  and the intimate-craft block (minor-gated).
- **Profile sections** (`profile-sections.ts`) — the authored-canon builders extracted
  from `character-chat.ts`: identity line, bio excerpt, species phrase,
  disposition-band rendering, voice anchors, micro exemplars, preferences
  (intimate-gated), life stage. Single source; jscpd stays quiet because it's reuse,
  not copy.

Already-shared modules the sim lane simply starts using: `prompts/untrusted.ts`
(fencing), `ai/narrator-artifacts.ts` + `ai/narrator-repeats.ts` (output
normalization), `ai/provider.ts` `narrativeProviderOptions` (routing + reasoning
knobs), `NARRATIVE_TEMPERATURE`.

Lane-specific rules deliberately NOT chartered in v1: the sensory-allowance machinery
(rules 10–11 — the sim lane has no `chat-intent` detectors yet), separation law (rule
15 — the engine owns presence), attachments (rule 16 — blocked in the sim lane v1,
see §4).

### 2. Successor context assembly — `prompts/sim-render.ts` replaces `buildCutRenderPrompt`

The prompt builder moves from `lib/simulation/presentation.ts` into
`server/engine/prompts/sim-render.ts` (beside the legacy builder; still pure and
snapshot-testable). `lib/simulation/presentation.ts` keeps parse + audit only.
**Viewpoint splits into two explicit concepts:** *epistemic viewpoint* (whose
knowledge partitions the cut — unchanged, the player actor) and *prose camera*
(charter law — second person to the player, third person for everyone else).

Context blocks, in order (stable-prefix-first for provider caching, mirroring the
legacy §9 prefix/tail split):

1. **Role & safety** — narrator-of-a-committed-world framing (render only what the
   world established; never move/create/reveal/decide) + charter content framing +
   no-refusal + camera/agency.
2. **Authored canon** (stable) — the primary character's `CharacterProfile` via the
   chat participant row (the `/worlds` front door already creates successor chats FROM
   a library character — `successor-chats/route.ts` reads `characters.profile`):
   identity, bio excerpt, personality bands, voice anchors, micro exemplars,
   preferences, life stage; the player persona (name, bio, voice, intimacy guidance)
   via `resolveChatPersona`.
3. **Committed truth** (the cut) — world clock line (kept); presence with **display
   names and zone display names** (never ids); activities humanized to verbs; MUST
   ENACT beats as **opaque handles** `B1..Bn` with summaries; MAY PORTRAY; failed
   attempts (public faces only); FORBIDDEN claims; armed speech acts as handles
   `E1..En`; beliefs rendered as plain-English claims (humanized proposition keys);
   pressures as legible story time ("needs to leave within about an hour", derived
   from `actBy − now`), never "act by second N"; bodily reads rendered as English
   sign sentences from the closed visible-sign registry, never `JSON.stringify`.
4. **Sim presentation state** — outfit line (`readSimChatOutfit` projection),
   relationship framing from the §21 ledger reads (`readSimChatRelationship` bands →
   prose guidance, reusing the legacy relationship-law phrasing shapes).
5. **Conversation** (volatile, fenced) — rolling summary, §24 memory lines
   (epistemic labels kept), transcript tail widened to **30 messages (~15
   exchanges)**, admitted-action line, the player's turn. Every player-authored or
   model-derived string goes through `fenceUntrusted`.
6. **Output contract & craft** — charter craft/attribution/notation blocks; then the
   JSON contract **described field-by-field with no literal prose placeholder**
   (the template-echo incident's root cause): `prose` (the reply, obeying every rule
   above), `enactedBeatIds` (the `B` handles actually enacted), `enactedEffectIds`
   (`E` handles), `proposedSoftCanon`. The word-count band is replaced by the
   charter's per-shape length story.

Handles map back to real event/effect ids at the trust boundary
(`parseNarratorResult` gains the map); unknown handles are flagged exactly as unknown
ids are today. **Id hygiene is then auditable**: no bracketed handle, event/zone/actor
id, or proposition key may appear in prose.

### 3. Render loop repair — `sim-narrator.ts`

- **Normalization before audit**: `stripNarratorArtifacts` → `collapseRepeatedBlocks`
  → trim stray code fences/quote wrappers, THEN `auditPresentation`. (The
  placeholder-echo auditor rule generalizes: prose that is JSON, contains contract
  field names, or is only bracketed placeholders ⇒ rerender.)
- **Targeted retry, not a reroll**: the prompt is rebuilt per attempt; attempt ≥2
  appends a CORRECTION block naming exactly what the previous audit rejected (missing
  beats with their summaries, leaked handles/ids, empty/placeholder prose). Same
  persisted cut every attempt — ruling 8 untouched.
- **Auditor additions (deterministic only)**: handle/id-leak regex; JSON-echo; a
  minimum-substance floor (e.g. <40 words while the cut carries beats or an
  utterance ⇒ retry once). The audit stays structural; semantic verification (beat
  truly enacted in meaning, forbidden claim absent in paraphrase, speech act actually
  delivered) remains prompt-enforced and is **honestly out of scope** here — an
  LLM-judge audit leg is parked with the owner-gated eval spend
  ([deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs).
- **Bridge demoted to last resort**: only after the feedback retry still misses ≤2
  beats; bridge text lands as its own short paragraph, never glued mid-sentence.
- **Provider parity**: `narrativeProviderOptions(modelId)` on the narrator call,
  temperature aligned to `NARRATIVE_TEMPERATURE` (0.85).
- **Kept deliberately**: structured JSON output (the review's ruling — the incident
  proved the placeholder example poor, not the envelope; a prose-plus-sidecar A/B is
  a later experiment), the withhold contract, no token streaming (streaming unaudited
  prose would break withhold; an explicit client "narrating…" progress state covers
  the 30–60s wait instead).

### 4. Routing parity — no silent legacy fallback for sim-routed chats

The fork in `app/api/chats/[chatId]/route.ts` becomes kind-aware: **every operation on
a sim-routed chat either has successor semantics or is refused with a clear error and
a hidden/disabled UI affordance.** The legacy pipeline becomes unreachable for
sim-routed chats — today an attachment, Continue, action beat, or Regenerate quietly
produces legacy prose and legacy state writes that never became world truth (F4).

Semantics **RULED by the owner 2026-07-22** (engine.spec.operations.md §39 rulings
18–19):

| Operation | Successor semantics (ruled) |
| --------- | --------------------------- |
| Regenerate | **Re-render the SAME cut** — same committed events, fresh prose. Presentation-legal per §22.3/§23 (rerender-creates-nothing is corpus-proven); confirm-by-id v2 cut supersedence governs effect arming on the retake. This does NOT violate the recorded "a retake is a branch fork" boundary — that boundary is about different *outcomes*; a different *telling* of the same outcome is exactly what rerender is for. Outcome-level retakes (branch fork UI) stay future work. |
| Continue | A successor turn with **no player utterance** — `prepareEngagementTurn` advances the span, the render omits the VIEWPOINT TURN block ("the scene breathes"). |
| Character-opens ("open") | Same as Continue plus an opening directive. |
| Attachments | **Refused** v1 (clear error; UI hides the control for sim chats). A later slice can pass vision reads as fenced presentation context. |
| Legacy action chips / `action` sends | **Refused** v1 — typed sim commands and input admission are the successor's action surface. UI hides the chips. |
| Rerun | Follows Regenerate's ruling (same-cut re-render). |

## What does NOT change

Engine authority, committed cuts, ruling-8 withhold, §24 viewpoint-partitioned recall
(explicitly kept — epistemically safer than importing every legacy RAG leg), input
admission, the deliberator, the legacy chat lane (byte-identical prompts, pinned by
snapshots), and the shadow-parity machinery.

## Slices

1. **Charter extraction** (pure refactor) — `charter.ts` + `profile-sections.ts`
   extracted from `character-chat.ts`; legacy prompt byte-identical (snapshot gate).
   **Landed 2026-07-22:** 184/184 legacy tests pass with zero snapshot changes;
   21 new charter unit tests. Rule bodies are number-free (the caller owns
   numbering); known v1 caveat — `attributionTagRule` still references the
   chat-lane "Scene notes"/"Supporting cast" blocks ("when present" phrasing keeps
   it harmless in the sim lane).
2. **Successor context assembly** — `sim-render.ts` with the six blocks; handle
   mapping at the trust boundary; `sim-exchange.ts` loads profile + persona +
   projections; history widened; fencing everywhere. Prompt snapshot tests (adult,
   minor, no-calendar, no-utterance variants).
   **Landed 2026-07-22:** `buildSimRenderPrompt(cut, context, opts)` returns
   `{system, prompt, handleMap}`; deterministic B/E handles (mustEnact +
   allowedTransitions, then armedEffects); `parseNarratorResult` maps handles → ids
   pre-validation; both `runSimTurn` AND `runSimRetake` load the same
   presentation inputs concurrently, each degrading independently (profile via
   participant → `characters.profile`, persona via `resolveChatPersona`, outfit +
   relationship via `sim-surfaces`, zone labels from `sim_zones.kind` via
   `zoneDisplayNoun` — the schema has NO zone/location name column, so kinds are
   the only humane label source; raw ids humanize as last resort); tail 12 → 30.
   Player-viewpoint beliefs render as never-voice context (player agency), not
   "voiceable".
3. **Render loop** — normalization, targeted retry, auditor additions, bridge
   demotion, provider parity. Unit tests falsified against the old loop (a
   placeholder echo, a leaked handle, a missing beat each provoke the right verdict
   and a corrective attempt-2 prompt).
   **Landed 2026-07-22:** per-attempt prompt with a CORRECTION block naming the
   prior audit's failures; prose normalized (`stripNarratorArtifacts` →
   `collapseRepeatedBlocks` → fence/quote trim) BEFORE audit; new deterministic
   audit checks `presentation.id_leak` / `presentation.contract_echo` /
   `presentation.too_thin` (too-thin retries once, accepts on the final attempt,
   and without attempt info records the diagnostic only); bridge only after the
   feedback retry; `generateChecked` gained an additive `providerOptions`
   pass-through so the narrator runs `narrativeProviderOptions` +
   `NARRATIVE_TEMPERATURE` like the legacy lane. **Plus the retake double-arm
   fix:** the confirm `idempotencyKey` is now keyed on `{cutId}` alone — one
   confirm per cut, first accepted render wins; a retake replaces presentation,
   never armed truth (invariant commented at `buildConfirmCommand`, pure-tested).
4. **Routing parity** — kind-aware fork + refusals + UI affordance gating +
   Regenerate/Continue successor semantics (per owner ruling), int-tested
   (regenerate-same-cut row-count invariance; no legacy writes for sim chats).
   **Landed 2026-07-22 (code):** the POST fork resolves authority once, before
   kind dispatch (`isSimRoutedAuthority`), then a pure `decideSimOperation`
   (`app/api/chats/[chatId]/sim-routing.ts`) maps each kind to a successor mode or
   a 409 `sim_unsupported_operation` refusal — the legacy `submitChatMessage` is
   unreachable for a sim-routed chat. `runSimChatExchange` grew a `mode`
   (`send` | `continue` | `open` | `retake`): continue/open run an utterance-free
   turn that still advances the span (ruling 19, `simOpening` on the reply meta for
   open); retake (regenerate/rerun) re-renders the SAME committed cut from the
   reply's `meta.cutId` (fallback `latestCutIdForEngagement`) and replaces the row
   in place (content + browsable takes), never advancing time or admitting input
   (ruling 18). The GET envelope carries `chat.simRouted`; the composer hides the
   attachment control + legacy action chips for sim chats while Continue/Regenerate
   stay. Pure test (`sim-routing.test.ts`) + int test (`sim-routing.int.test.ts`:
   regenerate row/event invariance + same-cut id, continue-advances-time with no
   user row, attachment/action → 409 no writes) both green. **Hazard RESOLVED
   same day in slice 3:** a live-model retake enacting a *different* armed-effect
   subset could have double-armed `confirm_narrator_result` (the cut stays
   "latest" so supersedence never fires, and a different enacted set meant a
   different idempotency key) — the confirm idempotency is now keyed on `{cutId}`
   alone, so a cut confirms at most once and retake confirms dedupe to the first
   accepted render.
5. **Live verification** — deploy to Fly, drive the standing internal test world and
   a fresh `/worlds` chat via the uxtest account; verify feel items by hand (camera,
   voice, attribution rendering in the chat UI, length, no ids); add the "narrating…"
   progress state if not already legible.

Docs to update in the same changes: `docs/character-chat/prompts.md` (charter
pointer), a new short doc or section for the successor narrator prompt
(`docs/prompts/` or `docs/character-chat/`), `engine.spec.mind.md` §23 (auditor
additions, correction-feedback retry, handle mapping — new sub-sections, global
numbering preserved), §39 for the routing rulings, and this plan's status line.

## Open questions

_Resolved 2026-07-22: routing semantics per operation (per-op successor semantics,
never legacy fallback) and Continue-advances-time — both ruled by the owner and
recorded as engine.spec.operations.md §39 rulings 18–19; the §4 table is the detail._

- **OQ3 — sensory-allowance machinery in the sim lane**: port the `chat-intent`
  detectors + allowance line in a later slice, or leave the conservative default?
  Recommended: later slice; the charter's conservative default ("no allowance line ⇒
  none") holds meanwhile.
- **OQ4 — voice-exemplar ring**: the sim lane runs no settle legs, so the runtime ring
  (`chat_state.voiceExemplars`) never populates. Recommended: profile anchors +
  micro-exemplars only in v1; a sim-lane voice ring waits until the sim lane grows a
  settle.
