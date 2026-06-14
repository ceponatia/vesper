# User Guidance for Phase 4

Coding agents must take this guidance into consideration when implementing phase 4.

## Important Changes Post-Phase-3

- We decided that having agents that can run in between the player turn and the narrator turn is a good idea after all. Too many intents were being lost and the narrator was often running amok in stories because there as no governor constraining its actions. Now, we can have the player write their prompt and then agents check the player's intent against what's going on in the story, characters involved, etc. and give focused instructions to the narrator.
- With the in-between agents (need a better name, perhaps intermediaries?), the system and assistant prompts for the narrator can be much more composable and less rigid. We will examine refactoring this.

## Changes to Movement authority & intent fidelity

Status: Draft

- Open question A is stale. The source spec frames authority as merge-inferred versus adding `willedBy` to the simulant result, but the repo now has an input-side classifier. Adding `willedBy` to post-turn movements would duplicate the newer, better boundary. Remove this open question.
- Multi-hop movement routing is partially implemented. The missing piece is player integration: `src/server/engine/merge.ts:375` (`stagedLocationAnchor`) still returns nothing for reachable non-adjacent targets.
- NPC authority is still unenforced in code. The current movement loop starts at `src/server/engine/merge.ts:1366`, blocks player movement only when the author is not the player at `src/server/engine/merge.ts:1375`, and otherwise applies adjacent moves. There is no symmetric "player-authored turn cannot directly relocate an NPC" guard.
  - Now that we are implementing agents in between the player turn and the narrator turn, we can have an agent check if the npc `agrees` with moving (based on conversation context, affinity, and tbd factors).
- The resolver criticism is partly overstated. `resolveSessionLocation` does exact match and unique containment at `src/server/engine/merge.ts:354`; it is loose, but it is not actually a nearest-adjacent heuristic. I would focus the fix on movement-specific classification and suppression rather than a global resolver rewrite.
- Convergence remains soft. `buildNextBrief` accepts `director.storySoFar` directly at `src/server/engine/merge.ts:1181`, then appends capped corrections at `src/server/engine/merge.ts:1219`. If the director summary has already cemented a wrong location, the correction can still lose the prompt fight.
  - The director will likely need to be scaled back due to now having agents in between the player turn and narrator turn.
