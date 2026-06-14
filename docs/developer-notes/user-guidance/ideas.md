# Ideas for This Project

This document lists preliminary ideas for fixes and features in Vesper, an AI chatbot app focused on romantic roleplay. Development should not be done directly from this document; elements should be expanded upon in their own documents in the `developer-notes` folder. When those documents are written, it should be noted here that the element has been addressed in a linked document.

## Improvements to NPC Characters

- All currently settled in `developer-notes/ideas-feedback.md`.

## Model Improvements

1. New models

- We need to look into using lighter / faster models for some of the agentic tasks that don't require a lot of reasoning.
- Some of these models have content moderation, so we need to identify fields that might trip that system and prevent the sensitive models from seeing those fields unless absolutely necessary (in which case we would need to use a different model, but will determine that case-by-case).

2. New agents to spread out work in parallel

- There are a few agents doing a lot of work. To improve speed we could create more agents that run asynchronously in parallel and then pass their output to a governor who does not let the next stage in the turn progress until it has all requested agent results.
- This could cause some latency in turns but ideally we would use small, fast models so the increase would be negligible.
