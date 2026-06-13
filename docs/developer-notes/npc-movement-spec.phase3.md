# NPC movement, follow & approach — spec

Status: **draft for discussion**. Part of the multi-character split — see
[multi-character-overview.phase3.md](multi-character-overview.phase3.md); rationale in
the brainstorm §Movement / §Stay-follow-approach.

> **Implementation status (2026-06-12).** Landed early with the
> foundations phase: schedule day-of-week mask + seeded jitter;
> `runtime.lastInteractedTurn` written from intent targets, companion
> speakers, and co-located name mentions (the proximity-events source
> waits for the proximity phase); the follow-score affinity gate
> (below-acquaintance stages cap the score). The link `access` /
> `doorItemId` columns exist and spawn copies them, but nothing enforces
> them yet. Scheduled in [phase-2-plan.md](phase-2-plan.md) — treat as
> done when implementing here: player-side access enforcement + door
> binding (T8 — built as one pure passability helper that phase-4 NPC
> traversal must reuse; `keyItemId` stays reserved until keys ship),
> arrivals/departures in `NextTurnBrief` (T9). Not
> started: drives, traversal, world-tick proposals, approach scores,
> the schedule-conflict follow term, "I follow her", companion
> full-path atomicity (waits for multi-hop traversal).
>
> **Update 2026-06-13 — director-staged movement slice shipped.** A minimal
> vertical slice landed to ground director-decided beats that need an absent
> NPC relocated first (the Eastport "Maya texts she's locked out, but is still
> at the clinic" bug). Now built: **multi-hop traversal** (`engine/movement.ts`
> `nextHopToward` — BFS over `session_links`, reusing `checkLinkAccess`,
> nodes-only, one hop/tick); a **narrow world-tick proposal channel** — the
> director's `stageMovement` signal (propose-and-audit: names resolve or drop,
> unreachable/expired/orphaned destinations cancel with `merge.movement.*`);
> **commitment** (a staged NPC overrides its schedule tick); and **NPC-initiated
> comms** on arrival (`runtime.pendingComms`, surface-once). The narrator is
> constrained to quick-chat self-initiated texts (no location claims / meet-ups),
> with a continuity backstop — see [../perception.md](../perception.md) §Comms,
> [../turn-engine.md](../turn-engine.md) §Director-staged movement. **Still not
> started** (the full engine): autonomous drives (schedule-as-drive replacement,
> needs/affordance/social/goal scoring), approach scores, follow-score changes /
> "I follow her", companion full-path atomicity, travel-weighted pathfinding,
> in-transit encounters / LOD.

## Problem

Off-screen NPCs teleport to schedule slots; nothing else moves them.
Movement should be *motivated* — schedules, needs, goals, social pull —
with staying put as the default, and an LLM allowed to propose moves only
when it can cite a reason the engine can verify.

## Design

### Drives (deterministic candidate generation)

Each drive emits `(destination, urgency, reason)`; highest urgency above
threshold wins; **no drive ⇒ no movement** (inertia is the default):

1. **Schedule** — upcoming entry within lead time (= path cost from
   time-and-travel) ⇒ start moving. Replaces the teleport.
2. **Needs** — meters past thresholds seek location affordances
   (`seeks` hint on meter registry entries × `affordances` on locations).
3. **Goals/threads** — open threads naming the character; authored
   `goals` profile field.
4. **Social** — high-affinity edge to someone at a known location.
5. *(future)* **Witnessed events** — investigate the crash next door;
   requires the sound channel.

**Commitment**: a chosen destination persists until reached, fulfilled,
or superseded by a strictly higher-urgency drive — no per-tick
re-scoring oscillation.

### Traversal

Route = shortest path on the session link graph; progress per tick at
link `travelMinutes`. Characters occupy **nodes only** (no mid-edge
positions); the player can meet them in transit at shared nodes.
Background-tier characters far from the player may multi-hop cheaply
(LOD applies to transit fidelity); active-tier characters near the
player traverse honestly.

### World-tick proposals (propose-and-audit)

The world-tick may propose moves for narrative reasons no rule sees —
but every proposal must cite a verifiable drive or witnessed event;
uncitable moves drop (`merge.movement.unmotivated`).

### Follow scores (extending `computeFollowScores`)

- **Interaction tightened** to intent-detected targeting (dialogue at /
  direct action on the character). Co-presence and talking to others no
  longer feed recency.
- **Schedule-conflict term**: active/imminent entry elsewhere is strong
  stay/leave pressure; overriding it requires high affinity and is
  surfaced so the narrator plays the hesitation.
- **Affinity gate**: below `acquaintance`, follow likelihood caps near
  zero regardless of this scene's chattiness — unless a drive supplies a
  concrete reason (hired guide, guard escort, stalker).

### Approach scores (new, symmetric)

When the player enters a location: per-NPC initiative guidance from
affinity stage, busyness, schedule, threads involving the player. High ⇒
"greets/approaches"; low ⇒ "ignores unless engaged". Friends approach;
strangers don't.

## Gaps & opportunities

> **Rulings 2026-06-11** (decisions 32–35 in the
> [decisions doc](multi-character-presence-and-movement-decisions.phase3.md)):
> link access model ships in v1 — `public | private | locked |
> timeWindow` + optional `doorItemId` binding, with basic enforcement
> (locked blocks, private discourages NPC pathing, time-window
> redirects); schedules get seeded jitter + day-of-week mask in v1;
> followers traverse the player's full path same-turn and arrive
> together; overt "I follow her" in v1, covert shadowing later as a
> contested-check application. Still open below: unreachable/blocked
> destination waiting rules, held-items-travel verification, crowding.

- **No link access control — the biggest hole in this spec.** Every
  adjacent link is traversable by everyone at all hours: NPCs can path
  through the player's bedroom, the player through the locked vault, the
  whole cast through each other's homes at 3am. Needs an access model on
  links: `public | private(ownerIds) | locked(keyItemId) | timeWindow`.
  This gates *player* movement too (currently unrestricted beyond
  adjacency) and interacts with doors-as-items (below). Decide before
  maps grow past dev size.
- **Doors are items; links are rows; nothing connects them.** Item
  open/close events exist, but a closed/locked door doesn't block (or
  even slow) traversal, and won't affect future audibility. A
  `doorItemId` on links binds the systems: item state drives
  traversability and sound damping. Cheap to add with the access model,
  painful after.
- **Arrivals surface nowhere.** When an NPC's traversal reaches the
  player's location between turns, the next narration should *stage* it
  ("Mara pushes through the door mid-conversation") — today nothing
  carries "X arrived since last turn" into the brief. Add
  arrivals/departures to `NextTurnBrief`; same for "X left toward the
  docks" when the player could see it. Without this, motivated movement
  happens but reads as teleporting anyway — the whole feature's visible
  payoff is this one brief field.
- **Schedules are robotic.** Identical times daily, no day-off, no
  variance, no being sick. Seeded jitter (±N minutes, deterministic per
  character+day) plus the day-of-week mask (time-and-travel gap) makes
  routines read as life instead of clockwork. Tiny effort, large feel.
- **"I follow her" is unmodeled.** Player-follows-NPC needs: matching the
  target's traversal across turns, and the stealth variant (shadowing —
  composes with salience/perception: following is an action with a
  concealment target). The machinery exists in pieces; nothing assembles
  it.
- **Companion travel atomicity.** A companion who follows through a
  multi-link journey should arrive *with* the player in the same turn,
  not trail one tick behind through three rooms. Rule: likely-follows
  NPCs move with the player's full path in the same merge.
- **Unreachable destinations.** Drive targets with no path (islands,
  access-controlled once that exists): cancel the drive with a
  diagnostic and let the next drive win — never leave a character
  marching at a wall. Also: what does a *blocked* schedule do (workplace
  door locked)? Wait at the obstacle is the human answer; needs a rule.
- **Held items travel implicitly — verify.** Item placement `held` should
  move with the holder through traversal; confirm the merge treats
  held-by-mover as location-independent, including container contents.
  A merchant who walks away from her own handbag is a placement bug
  waiting to be discovered in play.
- **Crowding/capacity is unmodeled.** Twelve NPCs converging on one
  `intimate`-scale room is legal. Probably fine for v1 (scale and
  narration absorb it); flag so it's a known accepted oddity, and the
  movement scorer could later prefer less-crowded affordance matches.

## Verification & final resolutions (2026-06-11, pre-implementation)

- **Held items travel with their holder — verified, no work needed.**
  Placement is holder-relative and location-independent
  (`schema.ts:273–307` CHECK constraint; movement only sets the
  participant's `locationId`). An NPC cannot accidentally abandon held
  items.
- **Interaction tracking is net-new, not a tightening.** Verified:
  `turnsSinceInteraction` is hardcoded `{}` at its only call site
  (`pipeline.ts:452`) — the follow-score recency term has never fired.
  Implement: `runtime.lastInteractedTurn: Record<participantId, turn>`,
  written in the merge from (a) intent-detected targets, (b) the NPC
  speaking on a companion-authored turn, (c) proximity events reaching
  `contact`+. Co-presence alone never writes it — which delivers the
  original "interaction means targeting" rule by construction.
- **Blocked/unreachable destinations** (resolved): no path or
  access-denied ⇒ cancel the drive with a diagnostic
  (`merge.movement.unreachable`) and let the next drive win — never
  march at a wall. Exception: a **schedule** drive blocked at a closed
  door waits at the obstacle (activity: "waiting") up to a lead-time
  budget, then gives up with a diagnostic — the human behavior at a
  locked workplace.
- **Crowding**: accepted oddity for v1, recorded; the affordance-match
  scorer may later prefer less-crowded candidates.

## Testing

Pure: drive candidate generation per drive (thresholds, lead-time math);
commitment (no oscillation across ticks with stable inputs); follow-score
changes (targeted-interaction-only recency; affinity gate; schedule
term); approach scores; pathfinding incl. no-path cancellation.
Integration: schedule drive walks an NPC across three links over
successive ticks; world-tick move with uncitable reason drops with
diagnostic; arrival lands in the next brief (once that gap closes).

## Docs to update when implementing

`turn-engine.md` (drives, traversal in merge step 4, brief fields),
`contracts.md` (meter `seeks`, goals field, link access model),
`prompts.md` (approach/follow guidance, arrival staging).
