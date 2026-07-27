# The exchange pipeline

One chat exchange from lock to settle: `engine/chat-pipeline.ts` (`submitChatMessage`),
the post-turn fan-out that follows the flushed reply, the detached jobs it enqueues,
and the persistence guards that keep a mid-stream delete from resurrecting orphans.

## The exchange lifecycle

All orchestration lives in `engine/chat-pipeline.ts` (`submitChatMessage`). The HTTP route
(`app/api/chats/[chatId]/route.ts`) is a thin parse → auth → stream shell. One
exchange:

1. **Lock.** A per-conversation keyed lock (`engine/keyed-lock.ts`, key
   `chat_exchange:{chatId}`) — a second concurrent submit gets a 409
   `chat_busy`. Held until the stream settles, released on every path.
2. **Exchange kind** (spec §4): `send` inserts the user line with a pre-minted id — the
   guard row for the reply persist; `open` (the "Prompt character" opening beat) and
   `continue` ("go on") have no player line — the model gets a synthetic, non-persisted
   cue; `action_beat` (a tapped action chip, see below) is the same beat shape carrying a
   chip id; `regenerate` ("another take") targets the LAST assistant reply: state rolls back
   to the pre-exchange snapshot, the old take's memory is retracted (provenance, §4.3),
   and the reply row updates in place with the old take kept browsable (`takes`, cap
   `CHAT_REPLY_TAKES_CAP`); `rerun` (re-send a player line, see below) is the atomic snip.
   A player **Stop** aborts the model stream server-side; the accumulated prefix persists
   with `meta.stopped` and the fan-out runs over it.

   **Action beats** (`kind: "action_beat"`, `action` = the chip id — chat-action-beats.plan.md):
   the four status-strip chips ("Offer a drink / Freshen up / Take a breather / Heat things
   up") are no longer silent state pokes — a tap is a **narrated one-beat exchange**. No
   player line is persisted; the server builds a **register-aware synthetic cue** from the
   chip id (`engine/chat-action-beat.ts` `buildActionBeatCue` — apart ⇒ answer as a text,
   co-present ⇒ in-scene, the apart/co-present read is the last reply's comms spans, the
   same signal the selfie offer uses) and applies the chip's **deterministic effect**
   (`applyChatAction`, intoxication↑ / hygiene refresh / energy↑ / arousal↑ + flushed) to
   the drifted state **pre-narration**, so the reply reflects the shift. The pulse is
   skipped (no player act, like `continue`); the archivist runs. The effect is rollback-safe
   via the pre-exchange snapshot (the anchor is the PRE-effect state), and the chip id rides
   the reply's `meta.actionBeat` so **"another take"** on the beat reproduces both the cue
   and the effect (rolled back first, so it re-applies exactly once — never doubles). The
   beat targets the **primary** — the roster member whose status strip hosts the chips; in a
   group the other members neither pulse nor take the effect (build ruling).

   **Atomic rerun** (`kind: "rerun"`, `messageId` = the target user line): the ONE path
   that reconciles with an in-flight reply instead of 409ing off it. Ordering is the whole
   fix (`chat-pipeline.ts`, data-loss-rerun): **stop → wait → acquire → transact.** Before
   touching anything it calls `stopChatReply` for the chat (settling any streaming reply,
   which releases the lock), then re-acquires the lock with a **bounded wait**
   (`acquireKeyedLockWithin`, up to `CHAT_RERUN_LOCK_WAIT_MS`, re-issuing the stop each
   poll). If the lock still can't be had it returns 409 `chat_busy` **with the transcript
   completely untouched** — nothing is ever deleted before the exchange is accepted. Under
   the lock, in one transaction, it validates the target is a `user` line in this chat
   (else 400 `invalid_rerun_target`, nothing modified) and deletes ONLY its **successors**
   — computed by ordering in SQL and slicing after the target's position, never by a
   `created_at > $date` predicate (JS `Date` truncates Postgres microseconds, which would
   re-select the target itself). The target row is **reused** as the prompt guard, never
   re-inserted; deleted assistant successors have their memory retracted
   (`reconcileMessageMemory`), and state mirrors regenerate. Only the **latest
   exchange's prompt** is eligible for in-place rerun: sole successor = the newest
   reply, **or zero successors** — the reply never persisted (stream failure/timeout,
   empty reply, pre-text stop), the retry path behind the failure popup. A zero-successor
   rerun skips the snapshot rollback: the failed exchange never settled, so live state
   is the correct starting point (the stored anchor belongs to the previous exchange).
   An older target returns 400 `rerun_requires_branch` before deleting anything: the
   one-exchange snapshot cannot restore an arbitrary discarded suffix, so the honest
   operation is a future conversation branch, not a false rollback. From there an accepted
   rerun streams exactly like `send`. The client (`chat-conversation.tsx`) deletes NOTHING
   and never abort-and-hopes: it optimistically snips the lines after the target and, on
   any failure, restores them (the server guarantees the transcript is byte-identical).
3. **Window + summary.** The rolling summary covers everything up to its watermark; the
   verbatim window (`CHARACTER_CHAT_HISTORY_TURNS` = 40 exchanges) is everything after it.
   When the unsummarized tail reaches the fold trigger, a detached `chat_summary` job is
   enqueued fire-and-forget (§4).
4. **State drift.** The pipeline loads the shared **scenario** once, ticks its clock
   once for the whole exchange (`CHAT_TICK_MINUTES` = 1 story minute since
   chat-clock-calendar — ONE story timeline, never per member), then `driftChatState`
   (pure) drifts each member against it — meters decay toward personalized baselines
   by `CHAT_METER_DRIFT_MINUTES` (= 4; meter pacing is exchange-keyed, deliberately
   decoupled from the 1-minute clock tick) for present members only (the away-freeze);
   conditions expire against the shared clock for everyone. **No time passes between visits**
   (spec §8, D8 — the wall-clock model was removed outright): the only between-scene
   lever is a player **time skip** (`POST …/time-skip`), which advances the scenario
   clock, stamps its one-shot `pending_skip_note` (worded by the primary's regard band,
   `chatSkipNote`, with a "a life meanwhile" license **and the calendar landing** —
   "It is now Friday evening", chat-clock-calendar) and `skip_history` ring, then
   gives each PRESENT member the per-character half (condition expiry, scene-budget
   reset, feeling decay, and **rhythm auto-dress** — a `profile.schedule` row covering
   the skipped-to clock that names an outfit preset re-dresses the member for that
   window, `rhythmOutfitPatch`; ux-improvements slice 8.4) — **meters untouched**
   (D14, flavor-only v1). Lazily seeds from the authored defaults when no row exists.
   A qualifying skip (cumulative ≥ one story day since the last pass) also fires the
   detached **meanwhile pass** (`chat_meanwhile` job — chat-offscreen-life,
   [the spec](../developer-notes/chat-offscreen-life.spec.md)): one call proposing the
   cast's off-screen developments, folded into facts / drives / cast / plans /
   whereabouts + the one-shot meanwhile note. Fire-and-forget: the next exchange
   proceeds on grounded improvisation if it hasn't landed.
5. **RAG recall.** `retrieveChatMemory` — fused retrieval over the participant's
   **memory group** (`MemoryScope` `{kind:"chat", groupId}`, [memory.md](../memory.md)
   §Memory keying): each of last turn's persisted `memoryQueries` + this input is
   embedded and retrieved separately, then RRF-fused with per-source attribution
   (`retrievedDetail` on the memory trace); pinned "remember this" facts ride ahead of
   the top-k regardless of similarity. Shared-history conversations share a group;
   fresh starts are islands. Each leg degrades with a diagnostic (facts to
   pinned-only, episodes to `[]`).

   **One embed per turn** (chat-agent-improvements.plan.md slice 3): the pipeline embeds the
   whole turn's query set ONCE — the player's input plus every participant's persisted
   `memoryQueries` — through `QueryEmbeddings.embed` (`server/memory/query-embeddings.ts`;
   trimmed + deduped) and hands that cache to every consumer: the fact leg, the episode leg,
   each ensemble member's pair of legs, and the memory-callback picker (whose anti-echo
   anchor IS the player's input). Each of those used to embed its own copy of the same
   texts — 2–3 round-trips for one text set, and unlike every other agent cost this one sits
   on the **pre-reply** path the player actually waits on. A failed embed degrades each leg
   exactly as its own would (facts → pinned-only, episodes → `[]`, callback → none). A
   caller that passes no cache still embeds internally, unchanged (the eval harness).
6. **Prompt build.** `buildCharacterChatPromptParts` (pure, snapshot-tested) — split
   for provider prefix caching (spec §9) into a **stable prefix** (identity → persona →
   scenario → background → regard-colored disposition → the composed **Relationship** block → cards →
   attributes → sensory cues → rules; byte-identical across turns, re-rendering only on
   a band crossing on either relationship axis — asserted by a prefix-byte-stability test) and a **volatile tail**
   (recap, memory, voice ring, state, drives, scene, cast, disinhibition +
   transient-appearance overrides — then the **"Right now" digest**, then the voice
   re-anchor + response-shape line). The digest (chat-agent-improvements slice 4) is the
   tail's one-turn directives gathered under a single heading that states their authority
   and **ordered by tier** — **binding** (storyteller-narration note, notation/comms
   routing, attached photos, time passed, first-scene establish) → **gate** (sensory focus,
   the sensory-allowance ceiling, the reply-discipline gates, a voice-slip correction) →
   **license** (the continue/initiative cue, the selfie license) → **flavor** (the
   memory-callback line). Before it, a dozen possible notes rendered in the order their
   features happened to ship, with nothing stating which governs when they pull apart.
   Deferral for a crowded turn is deliberately NOT done at render time — see §The one-turn
   notes below. An experimental `CHAT_PROMPT_LAYOUT=turn_context` switch (default off)
   moves the tail + fenced current input into a final user message instead; see
   [prompts.md](prompts.md) §Character-chat prompt-cache split. The rules carry the **player-input
   perception partition** (quoted = heard, narration = seen, interiority = invisible), the
   optional **markup-notation legend** (`*…*` thought/comms, `((…))` OOC, `_…_` italics —
   sigils parsed by the shared `@/lib/message-spans.ts`, with a per-turn comms/OOC tail note
   from `chatNotationNote`, plus the narrator's own-output emphasis rule: `_underscores_`,
   never asterisk-emphasis), and the **player-POV narrator camera** (involuntary perception +
   light reflex writable, the player's agency not — and never the player's story advanced on
   the narrator's turn; when the two are in different places, the reply follows the
   character's side only, reaching the player solely through comms — rule 15). See
   [prompts.md](prompts.md) §§Character-chat sensory cues / player-input perception /
   player-POV narration / state as a narration system / long-term memory, plus the
   regex-only one-turn cue (`engine/chat-intent.ts`).
7. **Stream.** `streamCharacterChat` — a `streamText` + `openrouter().chat()` shape,
   through `stripNarratorArtifactStream` and then
   `collapseRepeatedBlocksStream` (server/ai/narrator-repeats.ts — drops Aion
   tandem-repeat blocks, a verbatim re-emit of the reply's own trailing paragraphs,
   before they reach the live feed or the persisted accumulated reply). The narrator model is
   the per-character pick (`characters.chatModel`, resolved through the strict curated
   list) — a headless POST without a `model` defaults to it too
   (`resolveChatModelId`), so API and UI agree. The stream is wrapped by two watchdogs
   (`withStreamTimeouts`, data-loss-rerun): a **first-token timeout**
   (`CHAT_STREAM_FIRST_TOKEN_MS` = 50s — deliberately under Fly's ~60s proxy idle
   timeout, which would otherwise kill the zero-bytes-so-far response first and turn an
   attributable timeout into a silent connection drop) and an **overall cap**
   (`CHAT_STREAM_OVERALL_MS` = 300s). On a trip it aborts the upstream call and settles
   through the same stop path as a player Stop (any partial persists with `meta.stopped`,
   the lock releases) — so a wedged provider can never hold the per-chat lock indefinitely
   (the incident that motivated the fix). See §Reply failures below for how a zero-token
   settle is classified and surfaced.
8. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](../resilience.md) §5) — the reply persists (§5) and the post-turn fan-out
   runs (§3). All of it is off the perceived-latency path.
9. **Render (dialogue-attribution).** The transcript owns dialogue presentation, so chat rule 3
   makes the `[Name]` tag **conditionally optional** (dialogue stays quoted; other people —
   flavor NPCs and named side characters alike — speak in narration prose with plain
   attribution, never with a bracketed tag and never as a bare quoted paragraph). The contract
   is mechanical (tightened 2026-07-10, and 2026-07-11 for side NPCs): a whole-line quote
   auto-attributes **only in a reply with no tags at all**; a line mixing the character's speech
   with narration/action beats must open with the tag or split into separate quote/prose lines,
   and a reply that tags anywhere must tag every character line — its untagged quotes render as
   narrator prose (a side NPC's own quoted paragraph, the Amanda report). The reply renders as
   in-bubble per-speaker segments
   (`components/characters/chat-segments.ts` over the shared pure `lib/segmenter`, with
   standalone-quote attribution ON since chat is one-on-one): the tag is hidden behind a small
   speaker label and, in a tag-free reply, a bare whole-line quote attributes to the character. Segment content still
   flows through the `MessageContent` span renderer, where each span body also passes through
   `parseEmphasisRuns` (`lib/message-spans`) so a `_…_` pair nested inside quoted speech
   ("it's _perfect_!") renders italic instead of literal underscores (outermost-sigil rule —
   the quote stays one atomic speech span). Stored transcripts stay byte-verbatim. See
   [prompts.md](prompts.md) §Dialogue tagging and [ui.md](../ui.md) §Chat.


## Post-turn fan-out

`finalizeChatState` runs **pulse ‖ the three extraction legs** in parallel (`Promise.all`),
then one guarded state write:

- **Pulse** (`runChatPulse`): classifies the exchange onto the §6 personality curve —
  regard/mood deltas, arousal bump for intimate concepts, mindNote refresh, and the
  optional **feeling proposal** ([state.md](state.md) §Emotional weather: label + cause only; intensity
  derives from the curve's move). Degrades to drift-only state. Skipped for
  `continue` beats and narrator-mode inputs (no player act to react to — §Narrator
  input).
- **Extraction** (`runChatExtraction`, chat-agent-improvements.plan.md slice 1b): what was
  ONE 13-field "archivist-lite" call is now **three focused legs run in parallel** with each
  other and with the pulse — same post-flush slot, so the split costs two extra small calls
  and **no perceived latency**, while each leg holds 3–5 assignments instead of thirteen:

  | Leg | Fields | Diagnostic prefix |
  | --- | --- | --- |
  | **memory scribe** | `episodeSummary`, `facts`, `memoryQueries` | `chat_memory_scribe.*` |
  | **continuity tracker** | `scene`, `outfit`, `playerOutfit`, `attributeChanges`, `presence`, `cast` | `chat_continuity.*` |
  | **character tracker** | `openLoops`, `plans`, `driveUpdates`, `voiceExemplar`, `characterSlip`, `traitShifts` | `chat_character_notes.*` |

  All three sheets are **composed from the field library** (`prompts/chat-extractors.ts` —
  slice 1a: one module per field owning its instruction, context block, rules, and example
  value; a leg is an ordered list of field keys). Unarmed fields vanish from the sheet
  entirely (a 1-on-1 never sees the `presence` instructions; a drive-less character never
  sees `driveUpdates`), and every worked example is RENDERED from the leg's own field list,
  so examples can no longer drift out of sync with it. The legs merge back into the one
  `ChatArchivist` aggregate (`mergeChatExtractions`), so **every fold below is unchanged**.

  **Per-leg degradation** is the point of the split: a failed leg costs only its own
  fields. The folds key on the leg that owns each field — a degraded **character** leg keeps
  the standing open loops (an empty list must never wipe them), a degraded **memory** leg
  drops the stale `memoryQueries` and flags `lastMemoryTrace.degraded`, and every other
  leg's reads still land. All three down ⇒ the pre-split whole-archivist degrade (no memory
  written, nothing folded). Covered by `chat-extraction-legs.int.test.ts`.

  The **edited-reply re-extraction** (`reextractEditedReply`) runs the memory scribe
  ALONE (`runChatMemoryScribe`): that path re-files long-term memory and rewrites no state
  row, so before the split it paid for all thirteen fields and discarded eleven.

  The merged aggregate carries the same fields as before — the episode
  summary, `FactDraft[]`, next-turn `memoryQueries` (the scribe also reads the rolling
  summary's `Established:` ledger, so a pronoun-heavy beat files a fact naming the person
  instead of a dangling referent), `attributeChanges` (applied through
  the `overlaySourceMayChange` inherent-trait guard), plus the three character-fidelity
  voice/consistency reads (slices 8-10; the character leg is armed with a compact voice
  reference — the profile's `voiceAnchors` + the life-stage register — and the character's
  `developable` traits at their current band): `voiceExemplar` (≤1 distinctly in-voice line
  → the `voice_exemplars` ring), `characterSlip` (a one-line "the reply broke character"
  corrective → `lastMemoryTrace.characterSlip`, rendered as next turn's corrective tail),
  and `traitShifts` (direction-only developable-trait nudges → `trait_overlays`, applied
  ONLY when a relationship milestone landed this exchange, clamped one band from the
  authored value via `applyChatTraitOverlays`); `openLoops` (the full ≤3 list
  each time, prior loops fed back through the prompt; a **degraded** character leg keeps the
  prior loops rather than wiping them), the optional `scene` proposal merged into
  `scene_memory` ([state.md](state.md) §Scene memory), the optional `cast` proposals merged into
  `supporting_cast` ([supporting-cast.md](supporting-cast.md) §Supporting cast; roster/player names excluded), the optional
  `plans` proposals folded into the scenario ([state.md](state.md) §Plans & promises) —
  `mergeChatPlans` then `advancePlans` (deterministic due/missed transitions), whose fresh
  resolutions feed the pulse's `commitmentsDue` (computed pre-fan-out so the parallel pulse
  sees a just-missed commitment) and mint `plan_kept`/`plan_missed` milestones — the roster-gated
  `presence` transitions ([multi-character.md](multi-character.md) §Multi-character), `driveUpdates` ([state.md](state.md) §Drives), and the optional
  `outfit` change (chat-wardrobe-parity — see [state.md](state.md) §Wardrobe):
  `foldOutfitProposal` (in `finalizeChatState`) reads the archivist's two grammars —
  a whole-outfit `description` (naming an authored preset → seeds the structured
  `worn_item_ids` via `matchOutfitPresetInText`; unmatched → a free-text overlay
  replacement) and garment-level `removed`/`added` (folded through the pure
  `applyWornGarmentChanges` against the loaded worn items + the character's preset pool
  — an unmatched removal skips with a diagnostic, an unmatched addition rides the
  free-text overlay). The narrator wearing-line, the scene image, and the `chat_look`
  key all read the resolved wardrobe (`resolveChatWardrobe` — [state.md](state.md)
  §Wardrobe): the rendered garment phrase (`wardrobeOutfitText`, occlusion-filtered +
  subtype-led) plus coverage-computed exposure (`exposedRegions`). `seedChatState` seeds
  `worn_item_ids` from the default preset directly; a legacy free-text row (empty worn
  list) still resolves through the marker-heal (`resolveSeededOutfit` →
  `defaultOutfitPhrase`) until re-dressed. A failed item lookup degrades to `""`
  (composer inference) — ids never reach the narrator.
  Its memory write is additionally fenced
  so an infra throw never costs the pulse's state. Every write is **provenance-stamped**
  (`source_message_id` on facts + episodes, spec §4.3): deleting or editing an assistant
  line retracts/re-extracts its memory (`reconcileMessageMemory` / `reextractEditedReply`),
  and "another take" rolls it back exactly.
- The finalizer also appends the **relationship arc** (`appendRelationshipSample` /
  `deriveExchangeMilestones`, `contracts/relationships/history.ts`), persists the
  **scenario** beside the state (the merged scene memory, the clock the pipeline ticked
  once for the whole exchange, the one-shot skip-note clear — same prompting-message
  guard), and returns `{bigMoment}` — true on a regard-band crossing or strong reaction —
  which the route uses to queue an **auto scene** anchored to the reply when the chat's
  `scene_auto` is `"milestones"` (`queueChatScene`, deduped against live renders,
  fire-and-forget; a failed queue log-warns and never touches the settled reply). Caveat:
  a scene stays anchored to the message id it was queued for, so if "another take" later
  replaces that reply, the inline moment illustrates the superseded beat — acceptable.
- The pipeline also persists the **pre-exchange snapshots** — one state half
  per roster member (`character_chat_state.pre_exchange_state`, keyed by chat +
  character) and one shared scenario half (`character_chats.pre_exchange_scenario`) —
  the rollback boundary "another take"
  restores so a regenerated exchange never double-applies drift/pulse effects (the
  relationship samples/milestones AND the clock tick / scene merge / callback burn roll
  back with them). One carve-out: the **supporting cast never rolls back**
  (`rollbackScenario` keeps the live list — accrete-only + author-curated between takes;
  see [supporting-cast.md](supporting-cast.md)). `loadPreExchangeState` is three-valued: a recorded `{}` is the
  **first-exchange sentinel** (no prior state → the regenerate re-seeds from the
  authored defaults, exactly as the live first exchange did), a real state rolls back to
  it, and a **missing** row degrades to no-rollback with `chat_state.snapshot.missing`
  (followups F3); `loadPreExchangeScenario` treats `{}` the same way (keep the live
  scenario). Both are written under the **same prompting-message guard** as the paired
  state save, so a mid-stream delete can't split the halves (F5). "First exchange" (the arc baseline + `first_exchange` milestone) keys on an
  empty relationship history, not a null snapshot, so a state row that pre-exists the first
  send — a premise Save, an opening beat, a pickup skip — still records it (F4).
- **Ensemble members settle CONCURRENTLY** (chat-agent-improvements slice 2): every present
  member's referenced-only pulse + personal note-taker + state save + rollback-snapshot
  save runs in one `Promise.all`, not one member after another. Each member restores its
  own anchor **before drift** on regenerate/rerun, then writes its pre-exchange state under
  the same prompt-row guard as its settled state. Thus one discarded take cannot leave
  non-primary regard, mood, drives, milestones, wardrobe, or carry-over queries behind.
  Each member's legs read and write only their own row, and the whole settle runs **inside
  the exchange lock** — so settling a four-member
  roster serially stacked up to four back-to-back agent round-trips in the lock window, and
  a fast-typing player ate a 409 `chat_busy` for the difference. Error handling stays
  per-member (each keeps its own `try`/`catch`), so one member's failure still can't cost
  another's state.
- **State mutations 409 while a reply streams** (followups F1): the exchange holds the
  `chat_exchange:{chatId}` lock across the whole settle and the finalizer rewrites the full
  state row, so time skip / mark moment / state-tools PATCH / action chips first check
  `chatBusyResponse` and return **409 `chat_busy`** rather than be clobbered by the pending
  finalize.
- Every leg races a shared timeout (`withGenerateTimeout`, `server/ai`) and runs on the
  agent model. Every degradation is a diagnostic, never a failed reply — the reply already
  streamed.


## The one-turn notes (and why deferral happens pre-burn)

The volatile tail's per-turn directives render through one ordered digest (§Prompt build,
step 6). Where a turn is **crowded** — several one-turn notes competing for the same beat —
the low-priority ones are dropped, but that decision is made **upstream in the pipeline, not
at render time**, for a hard reason: an offered **memory callback burns its anti-repeat ring
entry the moment it is chosen** (`appendCallbackEntry`, riding this exchange's ordinary state
write). A callback dropped later by a render-time cap would be *spent without ever reaching
the page*, and that episode could never be offered again.

So `chatCallbackEligible` (`engine/chat-callback.ts`, pure) is the tail's soft cap: it runs
**before** a single token or embedding is paid for, and yields the flavor slot to anything
that outranks it — a first exchange, a pending skip note, a scene change, an intimate beat, a
sensory-focus block, an unanswered question, **attached photos**, **storyteller-narration
input**, or an **armed photo beat** (a selfie request, an unprompted offer, or the opener's
photo license — the last three added by chat-agent-improvements slice 4). The prompt builder
then renders exactly what survived the gate; it never silently drops a note.

## Reply failures

A reply that never arrives is **classified and persisted, never guessed at**. The
plain-text token stream has no error frame — once the route commits its 200, the
only in-band signal the client can see is "zero bytes, clean close" — so the cause
travels out-of-band instead:

1. `streamExchange`'s catch classifies the thrown provider error
   (`classifyProviderError`, `server/ai/errors.ts`): it unwraps the AI SDK's
   `RetryError`, reads `APICallError.statusCode` + the OpenRouter error envelope in
   `responseBody`, and maps them onto the closed `ChatReplyFailureCode` vocabulary
   (`contracts/turns/chat-reply-failure.ts`) — timeout, rate_limited, no_credits,
   auth_failed, moderation_blocked, context_too_long, provider_error, network,
   empty_reply, unknown. The same call feeds the `log.warn`, so `fly logs` shows the
   class, status, and the provider's own words (previously only `error.message`).
2. `resolveReplyFailure` (pure) decides what the exchange records: only a
   **zero-text** settle records a failure (a partial that persisted is a visible
   reply); a watchdog trip outranks the stop flag it shares an AbortController with
   (`timeout`); a genuine player Stop records nothing; a clean zero-token stream is
   `empty_reply`.
3. The verdict is written to `character_chats.last_reply_failure` (cleared by any
   exchange that settles) **before the generator returns**, so the route's drain —
   and therefore the client's post-exchange refetch — strictly follows it.
4. The transcript GET returns it on the `chat` envelope; the client's
   zero-tokens-received path hands it to `replyFailureToast`
   (`components/chat/reply-failure.ts`), which maps each class to its own copy
   (quoting the provider's words where they add signal) with a 10-minute staleness
   guard. No record ⇒ honest "no cause recorded" copy.

Adding a failure class = a literal in the contract + a copy entry in the client map
(registry pattern — never a migration; unknown stored codes parse to `unknown`).

## Jobs

| Type | Path | Recovery |
| --- | --- | --- |
| `chat_summary` | engine queue (`enqueueChatSummary`), detached; folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock` | heartbeated while running; a dead row is failed by the detached-job sweep |
| `chat_scene_sketch` | engine queue (`enqueueChatSceneSketch`), detached; expands a just-introduced place into a visual sketch on `scene_memory` ([state.md](state.md) §Scene memory step 4) — write is an optimistic CAS, never the exchange lock; one live job per chat | same detached sweep; a lost CAS or failed run simply re-fires while the place's sketch stays absent |
| `chat_look_image` | engine queue (`enqueueChatLookImage`, fired by the finalizer on an outfit/appearance change), detached; mints the outfit-true look anchor ([images.md](images.md) §Scene reference anchors) — image-active chats only, keep-latest | same sweep; a failed mint leaves renders on the avatar and the next change re-fires |
| `chat_place_image` | engine queue (`enqueueChatPlaceImage`, fired lazily by `queueChatScene` on the first render in a sketched place), detached; CAS-writes `ScenePlace.imageId` | same sweep; a lost CAS / failed render re-fires on the next render there |
| `chat_scene_image` | api-side `startJob` via the shared `queueChatScene` (`chats/[chatId]/scene/queue.ts`) — manual POST **and** the auto big-moment hook; one live render per chat (check-then-insert dedupe); anchored at queue time (manual = newest assistant line, auto = the exchange's reply) | `sweepDetachedApiJobs` (`engine/recovery.ts`) fails any detached running job whose heartbeat is older than `API_JOB_STALE_MS` |


## Persistence guards

- **Reply persist** (`persistAssistantReply`): atomic `INSERT … SELECT … WHERE EXISTS`
  keyed on the prompting user line, so a Clear Chat or message delete landing mid-stream
  can't resurrect an orphan reply.
- **State write** (`saveChatState`): same guard shape, keyed on the same row.
- **Delete** (`deleteChat` — the one destructive verb; **archive** via `PATCH
  {archived:true}` is the everyday shelve/restore action): one transaction — the chat
  row's FK cascades take transcript + summary + participants + state; the scene-image
  prompt scrub runs **per conversation** for chat-keyed rows (sibling chats keep
  theirs), plus the legacy character-wide scrub for pre-slice-9 null-`chatId` rows —
  assets survive either way (`images.chat_id` is SET NULL); the memory group is purged
  only when no other conversation references it. **Character deletion routes through
  this too** (deletion-leak audit, 2026-07-10): `DELETE /api/characters/:id` runs every
  chat the character participates in through `deleteChat` BEFORE deleting the character
  row — deleting the character alone cascaded `chat_participants`/`character_chat_state`
  away and stranded the chat row, transcript, and memory group (invisible in the hub,
  which inner-joins participants, but fully stored). Ordering matters: the participant
  rows are the only map from chat to memory group, so the purge must run while they
  still exist. **Ownership is proved inside `deleteChat(chatId, ownerId)`**, not taken
  from the caller (security-authz.plan.md slice 2): it re-reads the chat under
  `id + owner_id` and no-ops with a `chat.delete_denied` warn when nothing matches, and
  the character traversal is itself owner-scoped — a cross-owner participant row is
  skipped, and that chat survives. **A successor chat's world dies with it**
  (successor-world-lifecycle.plan.md, engine.spec §39 ruling 31): when the chat row
  carries a `sim_branch_id`, the world resolves through `sim_branches` and its
  `sim_worlds` row is deleted in the same transaction — cascades take the branch and
  every branch-scoped row. A set-but-dangling branch id degrades
  (`chat.delete_sim_branch_missing` warn, chat still deletes); the leaked world is
  reclaimed by the admin orphan sweeper. Character deletion inherits this through
  the same traversal.

