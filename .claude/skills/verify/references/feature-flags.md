# Run a feature-flag experiment

A Fly secret change restarts the Machine and affects every user. Change flags only when the user has requested or already authorized the experiment.

Before changing anything:

1. Confirm the active image contains the code the flag gates. Use the release/commit evidence and, when necessary, inspect the built server code on the Machine for the owning symbol.
2. Find and read the actual parser in the current source. Search for the exact environment name under `apps/web/src` and follow any composed helper it calls. Do not assume every flag is boolean or accepts the same value.
3. Record whether the flag is unset or set, and its exact current value. Do the same for every prerequisite flag that the experiment will change. Flag values are operational data; do not print unrelated secrets.
4. Decide the restoration commands before the first mutation. Restore the exact prior value, or unset the secret if it was previously absent, even when the experiment fails. Leave a new value in place only when the user's request says it should remain.

Current parser shapes in `apps/web/src/server/engine/prompts/constants.ts` illustrate why source inspection is required:

- Most chat gates are enabled only by the literal value `on`; `true` and `1` stay off.
- `CHAT_PROMPT_LAYOUT` selects `turn_context`; every other value resolves to `system_tail`.
- `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS` is a comma-separated subset of `movement,start,update`. Unset or blank defaults to `movement`; an explicit nonblank value with no recognized tokens grants no kinds.
- `CHAT_CONTACT_EFFECTS`, `CHAT_NPC_SCENE_DECISIONS`, and `CHAT_ROMANTIC_PERMISSION` are effective only while `CHAT_CONTACT_ACTIONS=on`. The NPC authority-kind setting scopes `CHAT_NPC_SCENE_DECISIONS`; it does not enable that gate.

Set only the values and prerequisites the parser requires, then wait for the restarted Machine to become healthy. Verify the effective value on the Machine and prove the behavior through the UI, API state, prompt/inspector output, or narrowly filtered logs. Restore temporary values and wait for health again before reporting the final state.
