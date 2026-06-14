# GPT review: Movement authority & intent fidelity

Source: [../movement-authority-spec.phase4.md](../movement-authority-spec.phase4.md)

## Overall opinion

This spec is pointed at the right failure. The current merge still lets post-narration `simulant.movements` move NPCs on player-authored turns, while only protecting the player from off-turn movement. That is exactly the class of bug described here: the narrator/simulant can turn player-authored flavor into canonical NPC travel.

The main update I would make before implementation is to rebase the design on the now-existing intake seam. `IntentBrief.movement` already records `self`, `narrated_npc`, `co_travel_request`, and `implied_subspace` in `src/contracts/turns/intent-brief.ts:47`, but `src/server/engine/merge.ts:2021` (`ApplyTurnInput`) and `src/server/engine/merge.ts:113` (`MergeTurn`) do not carry that brief into the reducer. So the core gap is no longer "how should we classify authority?" It is "thread the persisted intake brief into merge and make merge prefer it over the simulant for player movement."

## Gaps and mismatches

- Open question A is stale. The source spec frames authority as merge-inferred versus adding `willedBy` to the simulant result, but the repo now has an input-side classifier. Adding `willedBy` to post-turn movements would duplicate the newer, better boundary.

- The spec says a BFS helper does not exist for multi-hop player routing, but `src/server/engine/movement.ts:36` (`nextHopToward`) already exists and checks passable links through `checkLinkAccess`. The missing piece is player integration: `src/server/engine/merge.ts:375` (`stagedLocationAnchor`) still returns nothing for reachable non-adjacent targets.

- NPC authority is still unenforced in code. The current movement loop starts at `src/server/engine/merge.ts:1366`, blocks player movement only when the author is not the player at `src/server/engine/merge.ts:1375`, and otherwise applies adjacent moves. There is no symmetric "player-authored turn cannot directly relocate an NPC" guard.

- The resolver criticism is partly overstated. `resolveSessionLocation` does exact match and unique containment at `src/server/engine/merge.ts:354`; it is loose, but it is not actually a nearest-adjacent heuristic. I would focus the fix on movement-specific classification and suppression rather than a global resolver rewrite.

- Convergence remains soft. `buildNextBrief` accepts `director.storySoFar` directly at `src/server/engine/merge.ts:1181`, then appends capped corrections at `src/server/engine/merge.ts:1219`. If the director summary has already cemented a wrong location, the correction can still lose the prompt fight.

## Improvements I would make

- Make `IntentBrief.movement` the primary movement authority input for player turns. The merge should derive the player's intended destination from intake, route or block it deterministically, and treat the simulant's player movement as secondary evidence at most.

- Reuse `nextHopToward` for partial traversal. It already centralizes graph traversal and access checks; adding another BFS next to merge would create drift.

- Split movement sources explicitly in the implementation plan:
  - player self movement: intake-derived, merge-enforced;
  - player-authored NPC movement: proposal/drop unless consent/system logic accepts it;
  - director/world movement: `runtime.stagedIntents`;
  - companion/NPC-authored turns: allowed only through the explicit authoring path and graph checks.

- Add a movement-specific strict location resolver path. Keep general loose matching for user-friendly commands, but movement enforcement should be able to say "unresolved/implied subspace, no graph hop" without globally breaking containment matches like "the garden."

- Add a high-priority state reconciliation path for player-location contradictions. A dropped movement note is not enough if `storySoFar` and the prose have already moved the scene.

## Things I do not think are a good idea

- Do not add `willedBy` to `SimulantResult.movements` now. The current post-turn agent schema is intentionally small, and the input-side classifier sees the distinction before narration muddies it.

- Do not model every implied sub-room as a graph node for v1. The failure can be fixed with authority gating plus `implied_subspace` no-op handling. Authoring implied rooms can wait until there is clear UX pressure.

- Do not tighten `resolveSessionLocation` globally as the first move. Existing tests and behavior rely on friendly phrase matching; a movement-specific strict mode is safer.

- Do not let co-travel become a director-only story decision. The player request is visible pre-narration, and the consent/adjudication should be deterministic enough to avoid "the model decided they came along because it sounded nice."

## Test additions I would expect

- Player-authored NPC movement from `simulant.movements` is dropped with `merge.movement.unauthorized`.
- Intake `movement.kind: "self"` routes the player one hop toward a reachable non-adjacent destination.
- Intake `movement.kind: "implied_subspace"` produces no graph movement even when words overlap a location name.
- Simulant player movement that disagrees with intake is ignored or diagnosed.
- Director `storySoFar` cannot override canonical player location after a dropped or partial move.
