# Scene memory

Chat locations are **narrator-imagined** — the lane has no location entities — so
`scene_memory` is what keeps an established setting consistent across exchanges. It is one
jsonb column on the CHAT row (part of the shared scenario, one imagined setting for the
whole roster; `contracts/turns/chat-scene-memory.ts` `ChatSceneMemory`): an accumulating,
forward-compatible memory `{ current?, places: [{ name, details[], connections[] }] }` with
hard caps (≤12 places, ≤8 details/place, ≤6 connections, length caps) and a `parseOr`
degraded default (empty memory) at the load boundary. Time is not one of its fields — it
derives from the story clock, never from extraction.

The memory is maintained **deterministic-first**, then reconciled by the archivist:

1. **Pre-prompt (movement).** `detectSceneMovement` (`engine/chat-intent.ts`, regex-first) reads a
   movement/arrival in the player's input ("I follow her to the kitchen", "we head outside") and
   the route calls `switchScenePlace` to switch `current` (minting a stub place on first mention)
   **before** the prompt builds, so this turn's Scene injection is right. "Just changed" = a new
   current place this turn, or a pending time skip.
2. **Injection.** The prompt builder renders the compact **Scene** block in the volatile tail
   (current place + details + connections + a directive that flips on "just changed"
   — see [narrator-craft.md](narrator-craft.md) §Character-chat reply discipline & scene
   memory); the time
   of day rides the separate binding **Story time** line (`storyMoment`, derived from
   `clock_minutes` + `calendar_start`), so the narrator reads the same clock the clock card shows. On the
   conversation's **first exchange** (no assistant reply yet, not an opening beat) the memory is
   empty and "just changed" cannot fire, so the tail instead renders a one-turn **first-exchange
   scene directive** (`firstExchange`): establish the scene once, narration-forward
   (sight plus one other sense), drawn from the scenario and the player's message — the movement
   path's own directive wins when a first-message move minted a place.
3. **Post-turn (reconcile).** The archivist's optional `scene` field (current-place confirmation,
   new place details/connections — ONLY what the fiction established, lenient
   parse; never the time of day) is merged onto the pre-turn memory in `finalizeChatState` via `mergeSceneMemory` (dedupe
   + caps, oldest-out; the current place is never evicted). A degraded/empty proposal is a no-op —
   the memory only ever accretes what the fiction established.
4. **Background sketch.** After the state write, a current place
   without a `sketch` enqueues a detached `chat_scene_sketch` job (`chat-scene-sketch.ts`, deduped
   per chat like the summary fold): a small agent (`prompts/chat-scene-sketch.ts`) expands the
   place into a 2–4 sentence visual sketch — every established detail incorporated, only
   compatible texture invented — written back onto `ScenePlace.sketch` via an optimistic CAS on
   the raw `scene_memory` jsonb (deliberately NOT the exchange lock, so it can never 409 a send;
   a lost race re-fires while the sketch stays absent). Consumed by the narrator's Scene block
   (`- Setting (fixed reference): …`) and the scene image's `room`
   ([images/pipelines.md](../images/pipelines.md)).

**Reset.** Scene memory rides the ordinary chat resets: a hard `deleteChat` clears it with
the transcript/summary/memory; **archive** leaves it intact by design; and "another take"
rolls it back with the rest of the state via the pre-exchange snapshot
(`scene_memory` is in `storedChatStateSchema`), so a regenerated exchange never
double-accretes.
