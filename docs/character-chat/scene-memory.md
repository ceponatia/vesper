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

1. **Pre-prompt (movement).** `detectSceneMovement` (`engine/chat-intent.ts`, deterministic, no
   model call) reads every movement verb in the turn's input ("I follow her to the kitchen", "we
   head outside") and the route calls `switchScenePlace` to switch `current` (minting a stub place on
   first mention) **before** the prompt builds, so this turn's Scene injection is right. Each verb is
   read structurally for three things:
   - **Destination** — the noun phrase after the verb's first destination preposition, cut at the
     first function word ("to her desk and lean against it" reads `desk`, "to the table by the
     window" reads `table`), or an adverbial destination ("outside", "upstairs"). A preposition
     with no determiner after it ends the read ("walk over to talk", "go to bed", "walk over to
     Wren"). A verbless coordinated segment that opens on a path word continues the same verb's
     motion to its own destination ("I walk past her and into the kitchen", "…, then through to
     the kitchen"); a coordinated clause with its own subject or verb gets its own read.
   - **Kind** — a place; a position WITHIN the current place — furniture or a fixture, which never
     mints a stub (owner ruling 2026-09-27: "I walk over to the desk" is not a place change); or no
     destination at all — a body part, garment, or abstraction ("my hand to her thigh", "into my
     dress", "to an agreement") is a gesture or an idiom. A destination named by an established
     place — one with at least one detail or connection — is a place whatever its head noun; a bare
     stub earns no such exemption.
   - **Mover** — player input must move the player, so an unrelated third party's own errand
     narrated in passing ("the bartender walks back to the back room") cannot relocate the shared
     scene. The mover is the verb's own subject (I, we, let's, or the persona's name; "you" is the
     character), else the subject shared from the previous clause ("the bartender nods and walks
     to the back room" is the bartender's errand), else — only when nothing precedes the verb in its
     sentence — the imperative player; a player direct object ("she leads me to the back room") also
     moves the player. Storyteller (narrator-mode) input is authorized scene authoring: any
     subject's movement relocates the scene, and there "you" is the player.

   The last place change in the input wins. The sibling read `detectWithinPlaceMovement` reports the
   player's own within-place move only when the input has no place change; the contact leg ends the
   player's held contacts on it (`physical-legs.md`). "Just changed" = a new current place this
   turn, or a pending time skip.
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
   ([images/pipelines/scene-subjects.md](../images/pipelines/scene-subjects.md)).

**Reset.** Scene memory rides the ordinary chat resets: a hard `deleteChat` clears it with
the transcript/summary/memory; **archive** leaves it intact by design; and "another take"
rolls it back with the rest of the state via the pre-exchange snapshot
(`scene_memory` is in `storedChatStateSchema`), so a regenerated exchange never
double-accretes.
