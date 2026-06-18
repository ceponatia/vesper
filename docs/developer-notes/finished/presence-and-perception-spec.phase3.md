# Presence & perception — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Presence / §Symmetric perception. Decisions 8, 11, 13,
14 apply.

> **Implementation status (2026-06-12).** Not started — this spec is
> the likely core of phase 3. Groundwork already in place:
> `witnessed_by` stamping (interim co-location semantics, write-only)
> since phase 1; an absence notice in `scene.ts` (player input naming
> an absent NPC warns the narrator — a precursor to the
> reference-vs-enact rule); `audibility` stored unread on links.
> Heads-up from [phase-2-plan.md](phase-2-plan.md) T9:
> arrival/departure lines in `NextTurnBrief` ship under the same
> interim co-located ⇒ perceived assumption — this spec's witness
> machinery should gate them when it lands.
> **Pulled forward 2026-06-12 (followups.phase2.md #13) — the
> prompt-side presence slice:** a "Who is where" roster in the turn
> context (Present / Nearby-adjacent / Elsewhere, interim co-location
> semantics), the "Presence fidelity" rulebook block using this spec's
> resolved reference-vs-enact wording plus a Nearby exception (an
> adjacent character may join same-turn only via a narrated physical
> arrival before their first line), and a continuity major-violation
> for enacted absent characters. Treat those as done when implementing
> here — this phase replaces the roster's co-location semantics with
> channels (sight/sound/comms) and adds salience, awareness blocks,
> and true witness sets on top.

> **Phase-3 scope notes (2026-06-13, from phase-3-plan rulings).** Phase
> 3 is presence & perception v1 only. It pulls in the minimal proximity
> primitive its `sight` channel needs — the
> [proximity](proximity-spec.phase3.md) tier ladder + scale-derived tier
> existence + entry defaults — and leaves engagement, contested checks,
> the movement lock, and the staging surface to phase 4. Comms ships its
> channel + player-side + pending-messages line; NPC-*initiated* comms
> defers to phase 4. Observer / god-mode POV is deferred (see
> [deferred.plan.md](deferred.plan.md)).
>
> **Shipped 2026-06-13** ([phase-3-plan.md](phase-3-plan.md) completed):
> presence channels, the attention × salience witness matrix + awareness
> blocks (incl. pairwise NPC↔NPC lines), the two continuity violation
> kinds, darkness + `senseEffects`, comms v1 (player-side), and
> first-impression channel fidelity. System doc:
> [../perception.md](../perception.md). The §Gaps items above tagged
> v2 / phase-4 (full sound channel, NPC-initiated comms, player-unperceived
> path) stayed deferred.

## Problem

Two failures, one root. (1) Characters the player cannot see or hear
appear in narration anyway — there is no presence rule, only co-location
convention. (2) NPCs are omniscient within a room: the character facing
the sink *feels* what the player does behind her. Both are the narrator
defaulting to omniscience because nothing tells it otherwise; prompting
for restraint has failed and will keep failing. The fix is deterministic
facts in the prompt, enforced by the continuity agent.

## Design: presence channels (player-side)

Deterministic pre-turn computation per participant:

| Channel | Condition | Narrator rights |
| --- | --- | --- |
| `sight` | co-located (at perceivable proximity — see proximity-spec `distant`) | full presence |
| `sound` | audibility-linked location (post-v1; field designed now, decision 11) | voice/noise only, no visuals |
| `comms` | active call/text link | dialogue only |
| `absent` | none | **must not act, speak, or appear** |

Prompt side: only present characters get full canonical blocks; absent
participants get at most a one-line roster. Hard rule in the rulebook:
non-present characters may be **referenced** (talked about, remembered)
but never **enacted**. Continuity gains `narrated_absent_character`.

## Design: comms

Runtime link `{ kind: "call" | "text", withParticipantId, since }`;
opened/closed by a small simulant `commsEvents` field. Mechanism
style-agnostic; availability authored (phone, sending-stone). NPC-initiated
(decision 8): world-tick/schedule emits
`commsIntent { fromName, kind, urgency, gist }` → queued on runtime →
texts arrive silently as a pending-messages context line; calls surface
at the next turn boundary as an offer ("your phone buzzes") the player
answers/ignores as their action. Ring-outs become missed-call facts the
caller knows about. Escalation past one ring-out + follow-up text is
**director-only**.

## Design: symmetric perception (NPC-side)

### Attention × salience

- **Attention** (derived, decision 13): from `activity`/`posture` →
  `engaged_with(target) / absorbed(task) / idle_alert /
  asleep_or_impaired`. Sharpened by optional **perception hints** on
  item/affordance definitions (`attention: absorbing | faces_away |
  outward`) — a sink implies facing away from the room, no furniture
  geometry needed. Neutral default where unauthored.
- **Salience**: every notable action carries
  `{ visual: obvious | subtle, audible: loud | quiet | silent }`.
  Default **obvious** (decision 14); stealth must be declared, and a
  stealth marker only counts when a **concealment target** exists —
  "quietly" to a lover at `contact` is tone, the same words with her
  unaware mother present is a sneak.

### Where it runs

1. **Pre-turn**: intent detection classifies the player input's salience;
   crossed with each present NPC's attention ⇒ per-NPC **awareness
   blocks** in the turn context ("Mara — absorbed at the sink, back
   turned: does NOT perceive quiet actions this turn; WILL react to
   anything loud").
2. **Post-turn**: the simulant tags its events with the same salience
   vocabulary; the merge computes the **witness set** per event — the
   `witnessed_by` stamp character-memory-spec consumes.
3. **Enforcement**: continuity gains `reacted_to_unperceived_event`.

Cross-location: when the sound channel ships, `loud` events add
audibility-linked locations' occupants to the witness-candidate set —
NPCs hear through walls too (guard-investigates, eavesdropping NPCs).

### Extensible senses

A detection-channel registry (`sight`, `hearing`; later `scent`,
`tremorsense`, …) + optional per-character sense profile (acuity per
channel). Nothing non-human ships in v1; the two channels just aren't
hardcoded so deep that a third is a rewrite.

## Constants

Attention-derivation table, salience defaults, awareness-block budget —
`engine/constants.ts` / `contracts`.

## Gaps & opportunities

> **Rulings 2026-06-11** (decisions 24–27 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> v1 ships darkness (time-of-day × location light) + `senseEffects` on
> conditions; the player-unperceived event path is designed now and
> built v2; awareness blocks include terse NPC↔NPC lines; player-side
> "you hear a crash next door" ships in v1 ahead of the full sound
> channel. Still open below: glance-impression channel fidelity, comms
> speaker-tag verification, group calls/voicemail, the
> reference-vs-enact prompt formulation.

- **Narrator-invented NPC actions are only checked post-hoc.** The
  pre-turn awareness blocks govern reactions to the *player's declared
  action* — but the narrator also invents NPC actions mid-narration (Mara
  whispers to Tom), and whether a *third* character perceived those is
  computed only after the fact, from simulant tags. An NPC can therefore
  react within the same narration to a subtle NPC action they shouldn't
  have seen, and only continuity catches it a turn later. Mitigation:
  awareness blocks should state pairwise NPC awareness too ("Tom cannot
  see what happens near the sink"), not just NPC-of-player.

  **Ruled 2026-06-13:** build it. Awareness blocks maintain *pairwise*
  NPC awareness, recomputed every turn, so the narrator always knows
  where each NPC is and what each can see or hear — and that state
  *governs* narrator-invented NPC actions pre-turn, not merely a
  post-hoc continuity catch. Co-located pairs are phase-3 scope; scaling
  awareness to NPC↔NPC pairs in *different* locations (two NPCs
  interacting off-camera) defers to off-screen simulation (phase 5),
  which owns absent-character activity.
- **No environmental or condition modifiers on senses.** Darkness,
  candlelight, a deafening forge, fog; conditions like blindfolded,
  earmuffed, drunk. The sight channel is binary and eternal noon. The
  conditions registry is the natural carrier (`senseEffects` on a
  condition definition), and location/time-of-day supplies ambient
  modifiers (time-and-travel-spec exposes the time context). Without at
  least darkness, night scenes quietly break the perception model's
  credibility.
- **The player's own perception is unmodeled — co-located hidden actions
  are impossible.** Narration is player-POV, so anything narrated is
  perceived; an NPC cannot do something subtle the player *doesn't*
  notice while co-located (pickpocketing the player, slipping poison,
  an exchanged glance). That's a real expressiveness loss — the inverse
  of the kitchen-sink bug. Possible shape: simulant may emit
  player-unperceived events that skip narration and land only in state +
  witness sets ("you find out later"). Flag as opportunity; it has POV
  and fairness implications worth a dedicated think. **Ruled
  2026-06-13:** ships v2, confirmed — not phase 3. Vesper keeps core
  RPG mechanics so it can serve as a full NSFW *RPG* when the player
  wants one; hidden acts against the player are part of that capability,
  just not the first cut.
- **Glance impressions ignore channel fidelity.** First-encounter
  impressions render full appearance — but a character first met at
  `distant` (silhouette down the beach) or via `comms` (voice only)
  should get a degraded impression, with the full one firing on first
  `sight`-at-close encounter. The impression renderer needs a channel
  parameter; without it the impression system contradicts the presence
  system on day one.
- **Speaker tagging through comms is unverified.** The segmenter tags
  `[Name]` against the present-NPC list; a comms-present character must
  be taggable (their dialogue is the *whole point* of the channel) —
  verify the present list used for tagging includes comms-present
  participants, and that scene-image/impression machinery doesn't then
  treat them as physically there.
- **Comms scope is single-pair.** No group calls, no voicemail content
  (a missed call could carry a message that becomes a told-fact), no
  persistent text-thread history the player can reread. All deferrable;
  text history is the one players will ask for first — it's also a
  natural UI surface for the pending-messages mechanic. **Ruled
  2026-06-13:** phase 3 ships the comms *channel* + player-side
  calls/texts + the pending-messages context line; NPC-*initiated*
  calls/texts (they need the director / world-tick to emit intents)
  defer to phase 4. Group calls, voicemail content, and rereadable text
  history are parked in [deferred.plan.md](deferred.plan.md).
- **"Referenced but not enacted" needs a crisp prompt formulation.**
  The narrator must distinguish talking *about* Mara from Mara talking.
  Easy to state, easy for a model to fumble in reported speech ("Mara
  told me yesterday that…" — allowed — vs Mara's voice drifting in from
  nowhere — not). The continuity check needs the same distinction or
  it will false-positive on every reminiscence.
- **Off-screen *player*-adjacent events have no presence path.** A loud
  crash in the next room should reach the *player* as sound-channel
  narration even pre-sound-channel ("you hear a crash next door" is
  narratively basic). Consider shipping a minimal player-only audibility
  (loud events in adjacent locations become a context line) ahead of the
  full NPC-side sound channel — cheap, high-flavor.

## Verification & final resolutions (2026-06-11, pre-implementation)

Code verification results and the last design calls, closing this spec's
open items:

- **Canonical blocks stay in the static rulebook for ALL participants**
  (correction to §presence-channels above). Verified: canonical facts
  render in the rulebook (`scene.ts` `buildCanonicalFactsBlock` over all
  NPCs) — filtering them by presence would churn the prompt prefix cache
  on every move. The present/absent split happens **in turn context
  only**: a present roster + the hard rule + one-line absent roster.
  Identity reference for absent characters is *desirable* anyway (the
  narrator may reference them).
- **Segmenter: no change needed.** Verified it tags against all session
  NPCs by design (liberal acceptance, `pipeline.ts:550`). The narrator's
  present-NPC list (`pipeline.ts:398`, co-location filter) must expand
  to include `comms`-present participants; the parser already copes.
- **Glance impressions get a fidelity parameter** (resolved): the
  renderer takes the perceiving channel/tier; `distant` ⇒ silhouette
  impression (build/movement/coloring only), `comms` ⇒ voice impression,
  `sight`-at-`near` ⇒ full. `runtime.encounteredParticipantIds` marks
  **full** encounters only — a distant or comms first contact does not
  consume the first-impression moment (verified today it marks on any
  co-location; that changes).
- **Reference-vs-enact rulebook wording** (resolved, draft):
  *"Characters listed as absent exist and may be discussed, quoted from
  memory, or expected — but they must not appear, act, or speak in the
  present scene. Reported speech ('she told me yesterday…') is fine;
  a new line of dialogue from an absent character is never fine."*
  The continuity check mirrors it: flag only *present-tense enactment*,
  never mention or recollection.
- **Perception hints live on both item definitions and affordance
  entries** (resolved; brainstorm still-open #1): optional
  `attention: "absorbing" | "faces_away" | "outward"` — affordance
  entry overrides item default overrides neutral. One vocabulary,
  registry-validated.

## Testing

Pure: channel computation per participant; salience classification incl.
concealment-target rule (intimate "quietly" ≠ stealth); witness-set
lookup table (attention × salience matrix); awareness-block rendering.
Degradation: missing attention data ⇒ `idle_alert` + diagnostic; missing
salience ⇒ obvious. Integration: absent character enacted ⇒ continuity
violation; subtle action behind absorbed NPC ⇒ excluded from her witness
set; comms-present character tags dialogue.

## Docs to update when implementing

`turn-engine.md` (pre-turn steps, witness computation, commsEvents),
`prompts.md` (presence roster, awareness blocks, reference-vs-enact
rule), `contracts.md` (salience vocab, detection-channel registry,
perception hints), `memory.md` (witnessed_by), `ui.md` (pending
messages).
