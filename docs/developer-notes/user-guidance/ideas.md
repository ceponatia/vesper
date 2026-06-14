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
