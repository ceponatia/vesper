# Ideas for This Project

This document lists preliminary ideas for fixes and features in Vesper, an AI chatbot app focused on romantic roleplay. Development should not be done directly from this document; elements should be expanded upon in their own documents in the `developer-notes` folder. When those documents are written, it should be noted here that the element has been addressed in a linked document.

## Improvements to NPC Characters

1. agent(s) that provide the narrator with necessary fields based on the current direction of the chat.

- For example, if the player and a companion are being intimate, the agent(s) will provide the narrator with fields and instructions related to intimacy to steer it.

2. Find a way to limit character dialogue in certain situations.

- Especially during intimacy, characters talk too much, asking irrelevant questions and behaving unrealistically. In real intimacy, there is far less talking. The narrative in these situations should be limited to one or two dialogue lines for flavor (but enforce that this is _only_ when useful) otherwise the narrative should mainly be visual and sensory descriptions.

3. Add sensory schema to characters.

- Currently, there is no explicit sensory data linked to characters.
- We will want to add scents, flavors, and tactile feedback for various body fields. This is not only related to intimacy and can be used in a variety of scenarios.

4. Add intimate body regions.

- The current schema was forked from a more general RPG project (reverie). We need to expand to a full body plan similar to what is in `aionchat` (~/projects/aionchat/packages/contracts).

5. Add functionality for nonhuman species.

- We will need to add several species to the game to facilitate fantasy and sci-fi game types.
  - Elves, mermaids, orcs, various aliens, etc.
