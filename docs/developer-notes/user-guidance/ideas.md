# Ideas for This Project

This document lists preliminary ideas for fixes and features in Vesper, an AI chatbot app focused on romantic roleplay. Development should not be done directly from this document; elements should be expanded upon in their own documents in the `developer-notes` folder. When those documents are written, it should be noted here that the element has been addressed in a linked document.

## Improvements to NPC Characters

1. Make some fields hidden / inactive unless other fields contain specific choices.

- Example: `breast_size` and `vagina` are irrelevant when gender is male. When female is selected, these fields activate and become available on the UI.
  - The auto-generation pipelines for characters will need to be updated to understand and utilize this.

2. Improve the auto-generation agents.

- Currently only a few fields are filled out, depending on the detail written in the prompt by the user. We should instruct the agent in how to derive default values from other values it adds.
- For example, if a character's build is slender but the user doesn't say anything about shoulders, hips, etc., we can logically guess that those fields would also be narrow or slender.
  - The user can always override this if they want to but it makes the initial character sheet more detailed without manually editing every field.

3. Autonomy

- This is a long-planned but barely fleshed out feature. What separates vesper from other romantic chatbot apps is that it allows a living world that continues even when the player isn't directly observing it.

## Model Improvements

1. New models

- We need to look into using lighter / faster models for some of the agentic tasks that don't require a lot of reasoning.
- Some of these models have content moderation, so we need to identify fields that might trip that system and prevent the sensitive models from seeing those fields unless absolutely necessary (in which case we would need to use a different model, but will determine that case-by-case).

2. New agents to spread out work in parallel

- There are a few agents doing a lot of work. To improve speed we could create more agents that run asynchronously in parallel and then pass their output to a governor who does not let the next stage in the turn progress until it has all requested agent results.
- This could cause some latency in turns but ideally we would use small, fast models so the increase would be negligible.
- Fields to omit would include apparent age and age (when added) because we do have non-adult characters in the game who are _not_ for intimate scenarios, but this would still likely trip up many models when grouped with other characters who _do_ have intimate fields.
- More fields tbd through conversation with assistants.

## World Forge

There is currently a bug. The steps to reproduce it are thus:

1. Enter a prompt for a new world in the world forge UI

- agent fills out world details and creates 3 starter characters, some locations, and items.

2. Add a new character, not from library.
3. Save the world.

The new character(s) that were added manually by the user will disappear. The save action doesn't appear to run the character creation pipeline. Troubleshoot why this is and how to fix. Clicking save on a new world seems to run the pipeline for characters, locations, and items that were created by the agent, so those must already be primed in the system somehow. Adding a new character doesn't prime it in the same way.
This may also happen with items and locations but is currently unknown as it has not been tested.

## Locations

1. Through playtesting it is clear we need to also provide context about adjacent locations to the narrator so it doesn't write things like "you look into the window of the clinic and see Maya standing behind the front desk" when Maya isn't actually at the clinic. If the narrator got information about the adjacent clinic location and who is present, it wouldn't write that prose (or would be less likely to).

## RAG

> Being addressed in [RAG-improvements.plan.md](../RAG-improvements.plan.md) (initial impressions / sequencing for all seven items below).

1. Add a measured fact relevance policy rather than a blunt universal threshold. For example: include facts if score is above a configurable floor, or if the subject is currently present/addressed, or if a director memory query explicitly mentions the subject. That keeps important character facts from disappearing while reducing random semantic neighbors.

- We definitely want to check `isPresent` for a lot of prompt injections. NPCs should still act behind the scenes when not present with the player, but this will be asynchronous and non-turn-blocking, so it can use a totally different agent pipeline.

2. Improve query construction. preTurnRetrieve currently concatenates all previous memory queries and the current input into one newline-delimited embedding query. Simple and cheap, but it can blur multiple intents together.
   A stronger version would embed each query separately, retrieve per query, then combine results with max score or reciprocal-rank fusion. I would also log which source query produced each hit. That would make tuning much easier and would reduce “one query dominates everything” behavior.
   The end goal is to have RAG that can pull out individual facts along with who they were created by (who experienced them), who they pertain to (if anyone), and so on.
3. Centralize lore gating. lore.ts already has clean helpers for always-tier, scene-tier, unlocked, and retrieval eligibility selection. But the pipeline also has local isUnlocked and sceneChunkMatches helpers. That is a drift risk: future changes to tag matching, unlock behavior, or manual unlock rules could accidentally affect retrieval lore but not scene lore, or vice versa.
4. fact supersedence should eventually prefer subjectId over subjectName. The fact insert stores both, but supersedence currently searches active facts by embedding and then gates on normalized subject name plus similarity. That works for early single-character cases, but it can get fragile with aliases, renamed characters, duplicate names, or imported entities. Prefer subjectId equality when present, and fall back to normalized name only for unresolved subjects.
5. the project is already writing richer memory metadata than retrieval consumes. Facts have canon and witnessedBy, and the merge now computes a perception-based witness set for facts, but the docs explicitly say the knowledge-ledger consumer is still future work and canon is ignored by retrieval for now. That is okay, but it is the next big semantic leap: NPCs should not retrieve facts they never witnessed, and belief/lie facts should not enter the narrator’s truth channel unless the mode calls for it.
6. I would also add a small retrieval evaluation harness. The current tests prove mechanics, not quality. I would want golden scenarios like: “given these ten episode summaries and this query, episode 3 must rank top two,” “secret lore should not appear until unlock,” “irrelevant fact should not appear above threshold,” and “renamed/aliased subjects supersede correctly.” Track precision@k, recall@k, and score distributions. This is boring work, but it is how you stop threshold tuning from becoming vibes in a trench coat.
7. Determine how RAG can truly become a replacement for long conversation history and summarization (which most chat systems use today). We want to procedurally create the conversation history without simply sending flat "last n turns" to the narrator. It should be specific to who is present, the situation, and location/adjacent locations.

## UI

1. In World page, move the existing sessions to the top from the bottom. It makes no sense to have to scroll to the bottom of the page to resume a session.
2. Planned: actual map editor with nodes and connections with allows players to visualize the area map. Currently it is just a collapsible list of cards. Clicking the nodes in the visual map would open the card for editing.
3. Locations which have connections defined in the library (not just in the world) should prompt users to ask if they want to import the whole `area` instead of just the one location. If they say no, the location will import without any connections. If they say yes, it will import everything with the same `area` field, preserving connections. The only connection that would need to be configured is the ingress/egress points for the whole area.
4. In the session page, when generating a scene image, the first time I click the image always does nothing. It depresses as if it's about to process and turns grey for a moment, and then returns to default with no image generated. The second time I press it, it generates an image. Need to fix this ASAP.

## Overall Engine

1. Nail down the `time` system.

- Currently time passes seemingly at random intervals. The player can say "I wait 3 hours" and time correctly passes, which is correct, but in normal turns anywhere from 1 to 10 minutes has been observed passing for seemingly no reason.
- We need to define what actions pass more time than one minute.
- Narrator also needs to be taught how to use time. It shouldn't say something like "Cassandra washes the dishes and then gets ready for bed" within a 1 minute window.
- This is difficult to nail down because the agents are responsible for advancing time and the narrator has to work within their somewhat indirect framework. The agents in between player and narrator turns can help with this, but the narrator can still arbitrarily decide to do something that takes several minutes, and if it does so, the follow up agents then have to reconcile. This potentially advances the game time far past what the user expected. But we also don't want to handicap the narrator and prevent it from taking longer actions. We could define a range of time which it's okay for the narrator to use, such as 1-10 minutes. Anything longer than this would be instructed to not do.

2. We need a way to rectify and fix game sessions when something goes wrong. For example when the game writes regular in-narrative dialogue for an npc instead of using the [name] system; this can potentially break background agents and then it takes a lot of effort to rectify the changes. Defining systems for this will also improve what happens when players delete past messages or re-run prompts; we'd be able to rectify the database against what was removed or changed.

## Schema

1. Related to #1 in Overall Engine, we need to define actions and their related time costs per turn. This should be a generic list of action types. We can't possibly list every possible thing an npc can do in a world.

- We could also define actions that cannot be done in one turn. The narrator may start them, and then the next turn(s) they are ongoing. The narrator can still narrate other dialogue and minor actions, but it must include prose about the ongoing action as well.
- example: npc gets ready for bed (npc MUST be at home or a domicile it `owns` such as a hotel room).
  - Turn 1, moves to the bathroom (likely 1 minute)
  - Turn 2, undresses and turns on the water, waiting for it to warm up. Could potentially add minor actions like looking in the mirror, etc. (5 minutes)
  - Turn 3, takes a shower. This would be a longer action and might take 2 turns. (10 minutes, depending on factors such as hygiene, etc.)
  - Turn 4, still showering but narrator writes that they're finishing up and then shut off the shower. (10 minutes [so shower is a 20 minute block])
  - Turn 5, npc dries hair and body, moves to bedroom. (5 minutes)
  - Turn 6, npc puts on pajamas and gets in bed. Done. (5 minutes)
- This is a rough example to show how it would work. The number of turns and minutes are not set in stone.
