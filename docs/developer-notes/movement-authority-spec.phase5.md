# Movement authority & intent fidelity — spec

> **Resequenced 2026-06-14:** this work is now **phase 5**. A standalone **phase 4**
> (the body-model build) was inserted ahead of it — see
> [intimate-anatomy-sensory-and-species-spec.phase4.md](intimate-anatomy-sensory-and-species-spec.phase4.md).
> This file was renamed from `*.phase4.md` and its body now reads "phase 5" throughout.

Status: **draft for discussion** (2026-06-13). Phase 5 ("the world moves"
— see [phase-3-to-4.md](phase-3-to-4.md)). This is a sibling of
[npc-movement-spec.phase3.md](npc-movement-spec.phase3.md) (the movement
*engine*: drives, traversal, follow/approach, companion atomicity). That
spec answers *when does an NPC decide to move and how do they path*; this
one answers a prior question it never poses: **who is allowed to commit a
movement, and what counts as a movement at all.** The two share the
traversal primitives (shortest path on the session link graph,
nodes-only, one hop per `travelMinutes`). A third sibling —
[scheduled-arrivals-spec.phase5.md](scheduled-arrivals-spec.phase5.md),
findings from this same session — answers a further one: how an NPC comes
to be somewhere at a particular game-clock time (a player-arranged
appointment, which today nothing schedules).

`phase-5-plan.md` does not exist yet (it is step 3 of the phase-3→4
migration). When it is authored, the open questions at the bottom fold
into its `## Open questions` per the docs convention.

## Problem — a real session broke (`pyfb0hznglqkqj35ezjvjcxh`)

The player and Eleanor Vance agreed to go to lunch at the Anchor Cafe.
The location graph is a chain: **Town Hall ↔ Main Street ↔ Anchor Cafe**
(Town Hall is *not* adjacent to the cafe; each hop is 10 min). What
actually happened, reconstructed from `agent_results` + `diagnostics`:

| Turn | Player input | Simulant emitted | Merge verdict | Player loc | Eleanor loc |
| --- | --- | --- | --- | --- | --- |
| 31 | "…walk past to Town Hall" | player → Town Hall | applied (adjacent) | Town Hall | Town Hall (meeting) |
| 32 | "**Eleanor steps out** from her zoning meeting… I wave" | **Eleanor → Main Street** | applied | Town Hall | Main Street |
| 33 | "It's a date!" | Eleanor → Anchor Cafe | applied | Town Hall | **Anchor Cafe** |
| 34 | "I catch up to Eleanor **on main street**" | player → **Anchor Cafe** | **dropped** `merge.movement.invalid` | Town Hall | Anchor Cafe |
| 35 | "I enter anchor cafe" | player → Anchor Cafe (drop) + Eleanor → Anchor Cafe (no-op) | **dropped** again | **Town Hall** | Anchor Cafe |

End state: the player was stranded two hops behind at Town Hall while
Eleanor (and Sarah Jenkins, a cafe regular) carried on a co-located
conversation with him in the prose. The brief's `storySoFar` read *"Brian
and Eleanor arrived at the Anchor Cafe… Sarah Jenkins greeted them"* while
the same brief's `droppedEvents` said *"Brian did not actually move to
Anchor Cafe."* State and narration had fully decoupled, irrecoverably,
with only a self-expiring `Correction:` line as remediation. (Recovered
by hand: `UPDATE session_participants SET location_id = <cafe>`.)

The decisive corruption was **turn 32**, not 34. "Eleanor steps out from
her zoning meeting" was intended as *scene flavor* — the council chamber
is an *implied* sub-room of Town Hall with no graph node, so the player
narrated her leaving it. The simulant read it as a committed NPC
displacement, walked Eleanor out of Town Hall to Main Street, and from
there one hop per turn to the cafe — leaving the player behind. Every
later attempt to reunite was a 2-hop teleport the adjacency guard
correctly refused.

## Root cause — three distinctions the engine does not make

The merge's movement step (`engine/merge.ts:1356–1420`) resolves a
participant + a target location, drops the move if the player isn't the
turn author (`:1365`) or the target isn't adjacent (`:1379`), and
otherwise commits it. It has no concept of:

1. **Authorship vs. authority.** Movement is extracted from the
   *narration* with no regard for *who willed it*. A player describing an
   NPC's action ("Eleanor steps out") is treated identically to the NPC
   deciding to leave. The only authority check that exists is the inverse
   — the *player* can't be moved on a non-player turn (`:1365`). There is
   no symmetric rule that an *NPC* can't be moved by player narration.
   **Player text must never directly relocate an NPC.**
2. **Flavor vs. command.** Narrating an NPC's incidental action in the
   shared scene ("she shifts the papers", "she steps out of the meeting")
   is not a request to move them, and even an explicit request ("come to
   lunch with me") is a *proposal* the system must adjudicate — the NPC
   decides whether to agree and whether it makes sense. None of this is
   modeled; any movement the prose implies is committed verbatim.
3. **Implied sub-space vs. graph node.** "Steps out of the meeting" is
   movement *within* the Town Hall node (an implied council chamber → the
   hall), not a graph traversal. `resolveSessionLocation`
   (`merge.ts:347`) has a loose containment fallback and the simulant
   freely names any location, so flavor about an implied nook gets
   over-resolved to the nearest *real* adjacent node. There is no
   representation for intra-location movement, so it is silently promoted
   to a hop.

Two downstream failures turned the corruption into an unrecoverable
spiral:

4. **Multi-hop player intent is dropped, not routed.** When the player's
   willed destination is reachable but non-adjacent, `isAdjacent`
   (`:1379`) drops the whole move and emits one soft `droppedEvents`
   line. Nothing advances the player even one hop. On turn 34 the player
   literally typed "main street" (one hop, adjacent, would have applied),
   but the simulant emitted the cafe (two hops) following the prose, and
   the move was rejected. Had the engine routed one hop along the path,
   the chain would have self-healed by turn 35.
5. **No convergence forcing function.** The narration, director
   `storySoFar`, and brief directives ("Focus on the interaction between
   Brian, Eleanor, and Sarah") all committed to the wrong location while
   world state pinned the player at Town Hall, and nothing reconciled
   them. The continuity agent fired *late* (turn 35, not 34), *partial*
   (flagged Eleanor, missed Sarah — the worse "talking to someone who
   isn't there" case), and *toothless* (its correction lost to the
   director's own reinforcing directives).

## Design

### 1. Movement authority model (the core fix)

A participant's displacement is committed only when **willed by an agent
with authority over that participant**:

- **Player-authored turn**: commits the *player's own* movement (subject
  to the graph + link-access checks already in `merge.ts`). NPC movements
  extracted from the same turn are **proposals, not commits** — they pass
  through the NPC-agency gate (below) before they can take effect.
- **NPC-/companion-authored turn or world-tick**: NPC movement is willed
  by the NPC's own drives — the existing [npc-movement
  spec](npc-movement-spec.phase3.md) governs it (drives, commitment,
  `merge.movement.unmotivated` for uncitable world-tick proposals).

Mechanism — pick one in design review (Open question A):

- **(a) Merge-inferred authority (pure, no schema change).** In the
  movement loop, when `turn.author === "player"` and the moved
  participant is an NPC, do not commit; route the move into the agency
  gate. The player only directly moves themselves.
- **(b) Simulant-tagged authority (schema change).** Add `willedBy` /
  `kind: "self" | "narrated"` to each `movements[]` entry so the simulant
  distinguishes "the NPC decided to leave" from "the player narrated the
  NPC leaving." More expressive, but pushes a judgment onto the LLM that
  (a) makes deterministically.

Default recommendation: **(a)** — deterministic, no new trust boundary,
and the turn author already encodes everything we need.

Dropped player-narrated NPC moves get a diagnostic
(`merge.movement.unauthorized`, sibling to `unmotivated`) and a gentle
`droppedEvents` note so the next turn can reconcile the prose.

### 2. NPC-agency / co-travel consent

When the player *asks or commands* an NPC to go somewhere together, the
decision to accompany is the **system's**, not the player's text. Reuse
the movement engine's existing machinery rather than inventing a new one:

- Detect an agreed joint destination (director signal, or a co-travel
  intent in the player input + an NPC who assents in-fiction).
- Gate the NPC's accompaniment on **follow/approach scores + relationship
  stage** (the `computeFollowScores` path the npc-movement spec already
  defines). A wary stranger does not follow the player to lunch; a love
  interest who just called it "a date" does.
- A refusal is surfaced as narrator guidance ("she hesitates, says she'll
  catch up") rather than a silent no-op (Open question E).

### 3. Implied / intra-location movement is a no-op

Movement *within* the current node's implied sub-spaces ("steps out of
the meeting", "walks to the window", "heads to the back") must not resolve
to an adjacent graph hop.

- Commit a movement only when the target is a **distinct graph node**,
  the mover actually changes nodes, and (for an NPC on a player turn) the
  move is authorized per §1.
- Tighten `resolveSessionLocation`'s loose containment fallback
  (`merge.ts:347`) for movement targets: a flavor phrase that only
  matches a node by the nearest-adjacent heuristic should not become a
  hop. Prefer "stayed here" over "guessed an adjacent node."
- Authoring lever (Open question C): implied sub-spaces (council chamber
  in Town Hall, the kitchen of a `room`-scale apartment) are deliberately
  *not* nodes. The engine should treat them as in-node flavor, not force
  every nook onto the graph. Optionally the location forge gains an
  "implied rooms" affordance list so the narrator/simulant know these are
  sub-spaces of the current node.

### 4. Multi-hop player routing (partial traversal)

When the player's willed destination is **reachable but non-adjacent**,
route them **one hop along the shortest path** instead of dropping the
whole move. Needs a BFS helper next to `isAdjacent`/`findLink`
(`merge.ts:340`, `:219`) — none exists today. Emit an en-route staging
note ("Brian is now on Main Street, still heading to the Anchor Cafe") so
the narrator does not describe arrival. This self-heals the failure: turn
34 → player to Main Street, turn 35 → player completes to the cafe.

Couples to the [time-and-travel](time-and-travel-spec.phase3.md)
"partial-traversal brief note" leftover and the npc-movement traversal
model (nodes-only, shortest path, progress per `travelMinutes`). Open
question D: one hop per turn, or consume the turn's travel-minute budget
to cover multiple hops? (Affects `resolveTurnMinutes` clock cause.)

### 5. Convergence forcing function (state ↔ narration)

Prevent and detect divergence, not just patch it after:

- **Pre-turn**: close the multi-hop dead zone in `stagedLocationAnchor`
  (`merge.ts:368`, called `pipeline.ts:506`). Today it stages only an
  *adjacent* target and emits guidance only for an *access-blocked*
  adjacent link; a non-adjacent willed destination ("I enter anchor
  cafe" from Town Hall) gets **no staging, no block message, no
  guidance** — the narrator overrides the roster from prose momentum.
  Surface next-hop guidance for a reachable non-adjacent target ("you can
  only reach Main Street this turn; the cafe is further on"), agreeing
  with the §4 partial move.
- **Continuity**: flag **every** narrated-present character who is
  canonically elsewhere (fix the Sarah miss), and when a
  `narrated_absent_character` implicates the *player's own* location,
  escalate beyond a soft directive — a high-priority correction or a
  reconcile trigger.
- **Director**: ground `storySoFar` to the canonical player location so a
  summary can't cement "arrived at the cafe" while state says Town Hall.

## Failed guards (summary)

| Guard | Where | What it did | Fix |
| --- | --- | --- | --- |
| Player-not-author | `merge.ts:1365` | Blocks moving the *player* off-turn; no symmetric NPC rule | §1 authority model |
| Adjacency | `merge.ts:1379` | Correctly refused 2-hop teleport, but dropped wholesale with only a soft note | §4 route one hop |
| Location resolver | `merge.ts:347` | Loose containment promoted implied-room flavor to a real hop | §3 in-node no-op |
| Staged-anchor | `merge.ts:368` | No staging/guidance for non-adjacent willed targets (dead zone) | §5 next-hop guidance |
| Continuity | post-turn agent | Late, partial (missed Sarah), toothless correction | §5 catch-all + escalate |

## Testing

Pure: NPC move extracted from a player turn is dropped/held
(`merge.movement.unauthorized`), player self-move on the same turn still
applies; implied-sub-space flavor resolves to no movement; non-adjacent
reachable target advances exactly one hop with an en-route note;
unreachable target still drops. Co-travel: agreed joint destination with
a stage-gate pass co-moves the NPC, a fail holds them with narrator
guidance. Integration (replay the `pyfb0…` sequence): turns 32–35 keep
the player and Eleanor co-located throughout; continuity flags *all*
narrated-but-absent characters; the session never reaches the stranded
state.

## Open questions

- **A. Authority mechanism** — merge-inferred from turn author (pure) vs.
  a simulant `willedBy` field (schema change, LLM judgment). Recommended:
  merge-inferred. This decides whether the fix is a merge-layer guard or
  an agent-contract change. (§1)
- **B. Co-travel adjudication** — deterministic (reuse follow/approach
  scores + stage gate) vs. a per-turn director decision. Decides whether
  consent lives in the merge or an agent. (§2)
- **C. Implied sub-spaces** — pure suppress-flavor in the merge, or a
  modeled "implied rooms" affordance the location forge authors. (§3)
- **D. Partial traversal granularity** — one hop per turn vs.
  travel-minute-budget multi-hop; interaction with the clock cause in
  `resolveTurnMinutes`. (§4)
- **E. Refused requests** — when the player commands a move and the NPC
  declines, how is the refusal surfaced (narrator guidance vs. a
  continuity-style correction)? (§2)

## Docs to update when implementing

`turn-engine.md` (merge step 2: authority gate, partial traversal,
implied-room no-op), `prompts.md` (multi-hop next-hop guidance, co-travel
guidance), `contracts.md` (simulant `movements` schema only if option B /
`willedBy` is chosen), and a cross-link from
[npc-movement-spec](npc-movement-spec.phase3.md) (this spec supplies the
authority precondition its traversal assumes).
