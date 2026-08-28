# The post-turn fan-out

What runs after the reply has flushed: the reaction pulse, the three extraction legs, the
one guarded state write they merge into, and the detached jobs the exchange enqueues. All
of it is off the perceived-latency path — the reply already streamed, so every failure here
is a diagnostic and a degraded fold, never a failed exchange.

## The fan-out

`finalizeChatState` runs **pulse ‖ the three extraction legs** in parallel (`Promise.all`),
then one guarded state write:

- **Pulse** (`runChatPulse`): classifies the exchange onto the personality curve —
  regard/mood deltas, arousal bump for intimate concepts, mindNote refresh, and the
  optional **feeling proposal** ([state.md](state.md) §Emotional weather: label + cause only; intensity
  derives from the curve's move). Degrades to drift-only state. Skipped for
  `continue` beats and narrator-mode inputs (no player act to react to —
  [supporting-cast.md](supporting-cast.md) §Narrator input).
- **Extraction** (`runChatExtraction`): **three focused legs run in parallel** with each
  other and with the pulse — one post-flush slot, so the split costs two extra small calls
  and **no perceived latency**, while each leg holds 3–5 assignments:

  | Leg                    | Fields                                                                                | Diagnostic prefix        |
  | ---------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
  | **memory scribe**      | `episodeSummary`, `facts`, `memoryQueries`                                            | `chat_memory_scribe.*`   |
  | **continuity tracker** | `scene`, `outfit`, `playerOutfit`, `attributeChanges`, `presence`, `cast`             | `chat_continuity.*`      |
  | **character tracker**  | `openLoops`, `plans`, `driveUpdates`, `voiceExemplar`, `characterSlip`, `traitShifts` | `chat_character_notes.*` |

  All three sheets are **composed from the field library** (`prompts/chat-extractors.ts`:
  one module per field owning its instruction, context block, rules, and example
  value; a leg is an ordered list of field keys — [prompts.md](prompts.md) §The chat
  extraction field library). Unarmed fields vanish from the sheet
  entirely (a 1-on-1 never sees the `presence` instructions; a drive-less character never
  sees `driveUpdates`), and every worked example is RENDERED from the leg's own field list,
  so examples cannot drift out of sync with it. The legs merge back into the one
  `ChatArchivist` aggregate (`mergeChatExtractions`), so every fold below reads one shape.

  **Per-leg degradation** is the point of the split: a failed leg costs only its own
  fields. The folds key on the leg that owns each field — a degraded **character** leg keeps
  the standing open loops (an empty list must never wipe them), a degraded **memory** leg
  drops the stale `memoryQueries` and flags `lastMemoryTrace.degraded`, and every other
  leg's reads still land. All three down ⇒ the whole-archivist degrade (no memory
  written, nothing folded). Covered by `chat-extraction-legs.int.test.ts`.

  The **edited-reply re-extraction** (`reextractEditedReply`) runs the memory scribe
  ALONE (`runChatMemoryScribe`): that path re-files long-term memory and rewrites no state
  row, so paying for the other two legs' fields would discard every one of them.

  The merged aggregate carries the episode
  summary, `FactDraft[]`, next-turn `memoryQueries` (the scribe also reads the rolling
  summary's `Established:` ledger, so a pronoun-heavy beat files a fact naming the person
  instead of a dangling referent), `attributeChanges` (applied through
  the `overlaySourceMayChange` inherent-trait guard), plus the three
  voice/consistency reads (the character leg is armed with a compact voice
  reference — the profile's `voiceAnchors` + the life-stage register — and the character's
  `developable` traits at their current band): `voiceExemplar` (≤1 distinctly in-voice line
  → the `voice_exemplars` ring), `characterSlip` (a one-line "the reply broke character"
  corrective → `lastMemoryTrace.characterSlip`, rendered as next turn's corrective tail),
  and `traitShifts` (direction-only developable-trait nudges → `trait_overlays`, applied
  ONLY when a relationship milestone landed this exchange, clamped one band from the
  authored value via `applyChatTraitOverlays`); `openLoops` (the full ≤3 list
  each time, prior loops fed back through the prompt; a **degraded** character leg keeps the
  prior loops rather than wiping them), the optional `scene` proposal merged into
  `scene_memory` ([scene-memory.md](scene-memory.md)), the optional `cast` proposals merged into
  `supporting_cast` ([supporting-cast.md](supporting-cast.md) §Supporting cast; roster/player names excluded), the optional
  `plans` proposals folded into the scenario ([plans.md](plans.md) §Plans & promises) —
  `mergeChatPlans` then `advancePlans` (deterministic due/missed transitions), whose fresh
  resolutions feed the pulse's `commitmentsDue` (computed pre-fan-out so the parallel pulse
  sees a just-missed commitment) and mint `plan_kept`/`plan_missed` milestones — the roster-gated
  `presence` transitions ([multi-character.md](multi-character.md) §Multi-character),
  `driveUpdates` ([state.md](state.md) §Drives), and the optional
  `outfit` change ([wardrobe.md](wardrobe.md) §Archivist outfit changes):
  `foldOutfitProposal` (in `finalizeChatState`) reads the archivist's two grammars —
  a whole-outfit `description` (naming an authored preset → seeds the structured
  `worn_item_ids` via `matchOutfitPresetInText`; unmatched → a free-text overlay
  replacement — but over a modelled wardrobe only when the proposal's verbatim
  `changeEvidence` is present in this exchange's text, asserts a completed change
  (`classifyOutfitChangeQuote`, `contracts/items/outfit-change-evidence.ts`), AND attributes
  to that wardrobe's owner in the very sentence that asserted (owner rulings 2026-08-01 — the
  two halves of the exchange are passed separately, since which half a quote came from decides
  who "I"/"you" is, see [wardrobe.md](wardrobe.md) §Archivist outfit changes);
  otherwise the structured list is kept, `chat_wardrobe.outfit_restatement` / the player
  twin's `chat_wardrobe.player_outfit_restatement` / the per-member personal pass's
  `chat_wardrobe.ensemble_outfit_restatement` (`settleEnsembleMember` — the same preset rung
  and evidence gate, each member scoped to their OWN name so a roster-mate's change clause
  cannot wipe their look, though no delta path), with any unworn garments the kept
  description named reported in the diagnostic message by the two IO-backed folds — the
  pure ensemble one has no item-loading seam) and garment-level `removed`/`added`
  (folded through the pure
  `applyWornGarmentChanges` against the loaded worn items + the character's preset pool
  — an unmatched removal skips with a diagnostic, an unmatched addition rides the
  free-text overlay). The narrator wearing-line, the scene image, and the `chat_look`
  key all read the resolved wardrobe (`resolveChatWardrobe` — [wardrobe.md](wardrobe.md)):
  the rendered garment phrase (`wardrobeOutfitText`, occlusion-filtered +
  subtype-led) plus coverage-computed exposure (`exposedRegions`). `seedChatState` seeds
  `worn_item_ids` from the default preset directly; a free-text row (empty worn
  list) still resolves through the marker-heal (`resolveSeededOutfit` →
  `defaultOutfitPhrase`) until re-dressed. A failed item lookup degrades to `""`
  (composer inference) — ids never reach the narrator.
  Its memory write is additionally fenced
  so an infra throw never costs the pulse's state. Every write is **provenance-stamped**
  (`source_message_id` on facts + episodes): deleting or editing an assistant
  line retracts/re-extracts its memory (`reconcileMessageMemory` / `reextractEditedReply`),
  and "another take" rolls it back exactly.
- The finalizer also appends the **relationship arc** (`appendRelationshipSample` /
  `deriveExchangeMilestones`, `contracts/relationships/history.ts`), persists the
  **scenario** beside the state (the merged scene memory, the clock the pipeline ticked
  once for the whole exchange, the one-shot skip-note clear — same prompting-message
  guard), and returns `{bigMoment}` — true on a regard-band crossing or strong reaction —
  which the route uses to queue an **auto scene** anchored to the reply when the chat's
  `scene_auto` is `"milestones"` (`queueChatScene`, deduped against live renders,
  fire-and-forget; a failed queue log-warns and never touches the settled reply). A scene
  stays anchored to the message id it was queued for, so if "another take" later
  replaces that reply, the inline moment illustrates the superseded beat — accepted.
- The pipeline also persists the **pre-exchange snapshots** — one state half
  per roster member (`character_chat_state.pre_exchange_state`) and one shared scenario
  half (`character_chats.pre_exchange_scenario`) — under the same prompting-message guard
  as the paired state save, so a mid-stream delete cannot split the halves. What those
  anchors restore, and the three-valued read that handles a missing one, is
  [state.md](state.md) §Retake rollback boundary. One carve-out lives here: the
  **supporting cast never rolls back** (`rollbackScenario` keeps the live list —
  accrete-only + author-curated between takes; see
  [supporting-cast.md](supporting-cast.md)). "First exchange" (the arc baseline +
  `first_exchange` milestone) keys on an
  empty relationship history, not a null snapshot, so a state row that pre-exists the first
  send — a premise Save, an opening beat, a pickup skip — still records it.
- **Ensemble members settle CONCURRENTLY**: every present
  member's referenced-only pulse + personal note-taker + state save + rollback-snapshot
  save runs in one `Promise.all`, not one member after another. Each member restores its
  own anchor **before drift** on regenerate/rerun, then writes its pre-exchange state under
  the same prompt-row guard as its settled state. Thus one discarded take cannot leave
  non-primary regard, mood, drives, milestones, wardrobe, or carry-over queries behind.
  Each member's legs read and write only their own row, and the whole settle runs **inside
  the exchange lock** — settling a four-member
  roster serially would stack up to four back-to-back agent round-trips in the lock window,
  and a fast-typing player would eat a 409 `chat_busy` for the difference. Error handling
  stays per-member (each keeps its own `try`/`catch`), so one member's failure still cannot
  cost another's state.
- **State mutations 409 while a reply streams**: the exchange holds the
  `chat_exchange:{chatId}` lock across the whole settle and the finalizer rewrites the full
  state row, so time skip / mark moment / state-tools PATCH / action chips first check
  `chatBusyResponse` and return **409 `chat_busy`** rather than be clobbered by the pending
  finalize.
- Every leg races a shared timeout (`withGenerateTimeout`, `server/ai`) and runs on the
  agent model. Every degradation is a diagnostic, never a failed reply.

## Jobs

- **`chat_summary`** — engine queue (`enqueueChatSummary`), detached; folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock`.
  Recovery: heartbeated while running; a dead row is failed by the detached-job sweep.
- **`chat_scene_sketch`** — engine queue (`enqueueChatSceneSketch`), detached; expands a just-introduced place into a visual sketch on `scene_memory` ([scene-memory.md](scene-memory.md) step 4) — write is an optimistic CAS, never the exchange lock; one live job per chat.
  Recovery: same detached sweep; a lost CAS or failed run simply re-fires while the place's sketch stays absent.
- **`chat_look_image`** — engine queue (`enqueueChatLookImage`, fired by the finalizer on an outfit/appearance change), detached; mints the outfit-true look anchor ([images.md](images.md) §Scene reference anchors) — image-active chats only, keep-latest.
  Recovery: same sweep; a failed mint leaves renders on the avatar and the next change re-fires.
- **`chat_place_image`** — engine queue (`enqueueChatPlaceImage`, fired lazily by `queueChatScene` on the first render in a sketched place), detached; CAS-writes `ScenePlace.imageId`.
  Recovery: same sweep; a lost CAS / failed render re-fires on the next render there.
- **`chat_scene_image`** — api-side `startJob` via the shared `queueChatScene` (`chats/[chatId]/scene/queue.ts`) — manual POST **and** the auto big-moment hook; one live render per chat (check-then-insert dedupe); anchored at queue time (manual = newest assistant line, auto = the exchange's reply).
  Recovery: `sweepDetachedApiJobs` (`engine/recovery.ts`) fails any detached running job whose heartbeat is older than `API_JOB_STALE_MS`.
