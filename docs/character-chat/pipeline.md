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
   `chat-offscreen-life.spec.md`): one call proposing the
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
6. **Physical legs** (both experimental, both default off, and neither ever writes the
   other's state — that independence is what keeps either trial interpretable).

   **Affectionate contact** (`CHAT_CONTACT_ACTIONS`, `engine/chat-contact-adapter.ts` —
   `romantic-contact-affordances.plan.md`
   §"Continuation order" 1). Regex-only over the player's own line: no model call and no
   extraction leg, the `chat-intent.ts` precedent. It **seeds the scenario's scene** (a
   participant per player + PRESENT roster member, an authored controller each, and a
   `scene_default` standing posture on a seeded floor for a new arrival — distance and
   orientation are NEVER seeded, because only a movement the player actually wrote may
   claim those, and a scene nobody has moved in resolves `unresolved`), folds a detected
   approach as a `player`-origin scene intent over the player's **own** body (a
   possessive destination — "her desk", "Wren's chair" — names furniture, not a person,
   and states no distance), detects a player release ("I pull my hand back") ending the
   matching contacts (`withdrawn`), detects a player **departure** ("I step back", "I
   pull away from her", "I walk across the room") — see below — and reads the same line
   for a plainly affectionate hand-to-shoulder/arm/back/hand/head touch. Two hooks end
   contacts before detection runs: a pending story-clock skip ends every active contact
   (`separated`; owner ruling 2026-07-31), and a scene-place change ends them as
   `scene_changed` — which is also the door "I walk over to her desk" comes through,
   since the contact detectors read that as furniture while `detectSceneMovement` reads
   a move, and a held touch does not survive the mover either way. A detected act is
   resolved by the shared contact core against the scene's reach, support, and material
   reads — a dressed body whose wardrobe published no coverage capture resolves
   `unresolved` (silence), never bare skin. A committable one is folded, and ALL of the
   exchange's durable commits (hook ends, the plan's release then departure ends, then
   the touch's events) are
   written **atomically with the scene projection before the prompt builds**
   (`appendChatContactEventsWithScene`: one transaction over the ledger rows and
   `character_chats.scene`, idempotent on `(chat, event ref, sequence)`, and VERIFIED —
   a conflicting row under this exchange's keys aborts the whole write, files an `error`
   diagnostic, and leaves the outcome `unresolved`). Only a verified write's
   acknowledgment licenses a `committed` action outcome. Anything
   the detectors cannot read cleanly produces silence — a hedge, a negation (including the
   complete straight/curly/apostrophe-free auxiliary-contraction family), a question,
   an ambiguous target, storyteller narration, speech rather than narration, and (owner
   constraint) any romantic, intimate, or restraint framing anywhere in the sentence, so
   a romantic case can never be relabeled into a commit (the two ENDS lift the restraint
   veto and nothing else does — "I pull my hand back" and "I pull away" are the plainest
   English there is, and a missed end strands a durable row).
   The **departure** is the approach's inverse and the fourth producer of an end: the
   player's own body moving off (`near` for the step-back class — "I step back", "I take
   a step back", "I step/back/pull/move/draw away", "I lean back", "I put some distance
   between us"; `distant` for the crossing class — "I walk away", "I step/move/walk
   across the room"), from a named person, a sole-character pronoun, or — unnamed —
   from everyone. It ends **every**
   active contact the player is a participant in, either direction (her hand on the
   player goes too), reason `separated`, one durable `endContact` commit each on the
   same combined ordered list as everything else. Its distance claim obeys the
   never-invent law: a `player`-origin `set_proximity` is written **only** where the
   pair already has a proximity fact (and only when the new band is genuinely farther —
   a departure widens, never narrows) or where an active contact proves they were
   close; a pair nobody placed stays unknown. Facing is untouched — stepping back is not
   turning away. Plan order is release → departure → approach → touch, so "I step back.
   I walk over to Wren." ends the touch and lands `close`, while within ONE sentence a
   named destination outranks a departure ("I walk across the room to Wren" is an
   arrival). Release/departure precedence: a hand-only "I pull my hand back" releases
   (`withdrawn`) and states no distance; a whole-body "I pull away" is a departure
   (`separated`) and is deliberately not also a release, since the departure already
   ends the same contacts and more. A retake deletes the discarded
   take's ledger rows under the same exchange guard the scene projection rolls back on
   (`deleteChatContactEventsForGuard`, beside `rollbackScenario` — unconditionally, not
   flag-gated: pruning a discarded take's durable rows is hygiene, not behavior). The
   settle-time save re-writes the same scene the transaction already persisted; the
   ledger is the record the projection caches.

   **Constraint-first narrator guidance** (`CHAT_PHYSICAL_CONSTRAINTS`,
   `engine/chat-physical-guidance.ts`): what this body's committed state forbids the
   narrator to claim, plus the high-confidence false premises in the player's own
   framing — gated, ordered and budgeted by the shared guidance layer and rendered as one
   binding block ahead of the tail's other notes. Nothing here is persisted; the
   selection recomputes from the same cut and the same message, so the existing rollback
   anchors reproduce it. It also owns the **only door onto the prompt**, so the contact
   outcome above reaches the narrator only when this flag is on as well: with it off,
   contact still commits and still persists, and the prompt is byte-identical.

   **The `romantic_touch` permission owner** (`CHAT_ROMANTIC_PERMISSION`, composed over
   `CHAT_CONTACT_ACTIONS` but independent of the optional general-constraints experiment —
   `romantic-contact-affordances.spec.permission.md`,
   plan item 5, built 2026-08-04). Four pieces, all flag-off byte-identical. (1) The
   **policy read**: the chat's `chat_permission_events` ledger (migration 0096 — the
   contact ledger's sibling: idempotent on `(chat, event ref, sequence)`, guard-pruned
   on retake, chat-scoped because the chat IS the story branch) is listed once per
   exchange and folded into the standing-grant projection — there is no stored
   projection column, the fold over the pruned rows is the restoration — and
   `derivePermissionPolicyRead` answers for any attempt whose kind requires a grant:
   exact directional `romantic_touch` grant → allowed; withdrawn → withdrawn; absent →
   unresolved (silence); a player target → the ruled not-required exception (the player
   writes their own reaction; no grant is manufactured). Permission-neutral kinds keep
   the historical stub verbatim. (2) The **NPC-side decision**
   (`engine/chat-permission-decision.ts`): at settle, strictly after the beat's last
   scene writer, a trigger-gated single classifier call over the committed assistant
   reply ONLY — never player text — parsed by a closed per-digest contract and then
   deterministically validated (evidence must ground verbatim in an admissible span
   attributed to the granting NPC; conditionals, negations, questions, restraint
   framing, player echo, and player-as-target all drop with typed reasons; `withdrawn`
   needs a standing grant). Survivors append as `granted` / `attempt_denied` /
   `withdrawn` events under `permission-reply:<assistantMessageId>`. An
   `attempt_denied` event is bound to the exchange's current contact action; it ends only
   that action's active contact and leaves the standing grant intact. (3) A standing
   **withdrawal ends dependent contact atomically**
   (`appendChatPermissionEventsWithInvalidation`: permission rows + `policy_withdrawn`
   contact-ended rows + swept scene, one transaction — never a mixed state). (4) The
   **next narrator cut gets the stop** (`engine/chat-permission-guidance.ts`): endings
   no assistant reply has yet followed emit a mandatory transition line through the
   shared constraints compiler/renderer even when `CHAT_PHYSICAL_CONSTRAINTS` is off —
   named, idempotent, continuation-forbidding, never mechanics vocabulary, never the
   player's reaction. A stop-build failure aborts before a reply consumes the delivery
   window. Retake prunes both possible permission guards atomically with bounded retries;
   exhausted retries refuse the retake. The audited developer override (grant/withdraw per
   direction from the conversation menu, admin-only) is [api.md](api.md)'s
   `/api/admin/chat-permissions/:chatId`; chat text is never an override. The contact
   preview keeps the permission-neutral stub deliberately (no detector can currently
   produce a permission-requiring act, so preview/live parity holds).

   **The contact and guidance legs are re-derived by the dev previews, read-only** (`previewChatPrompt` and
   `previewChatPhysicalGuidance`, [api.md](api.md) §API surface). Guidance is pure, so a
   preview is simply a second evaluation. The contact leg is not — a live turn appends to
   `chat_contact_events` and advances the scene projection — so `previewChatContactOutcomes`
   runs `planChatContactTurn` and words the outcome while **discarding the planned scene and
   performing no write**: looking at a prompt never moves a body or records a touch. It keys
   on the newest player line's own row id, which for an ordinary send IS the exchange guard
   the ledger was written under, so the inspector explains that contact rather than a
   look-alike. The one thing it assumes rather than observes is the persistence
   acknowledgment a `committed` status rests on (a preview performs no write, and without a
   synthesized acknowledgment every contact would preview as silence — the exact blind spot
   this closes); replaying the newest line against the cut that line already settled
   ordinarily re-derives the same contact and folds `contact_continued`, which legitimately
   writes no row either way. The prompt preview OBEYS both flags (it is showing bytes); the
   guidance inspector reports them and runs the leg regardless, so a developer can see what
   turning a flag on would do before turning it on.
7. **Prompt build.** `buildCharacterChatPromptParts` (pure, snapshot-tested) — split
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
   regex-only one-turn cue (`engine/chat-intent.ts`). The cue, movement, sensory-focus,
   and contact reads share the channel/sentence and contraction primitives in
   `lib/chat-input-evidence.ts`, then apply detector-specific evidence policies; there is
   no universal eligibility gate because a visual accent, a prompt premise, a
   scene-memory mutation, and a durable contact have different false-positive costs.
8. **Stream.** `streamCharacterChat` — a `streamText` + `openrouter().chat()` shape,
   through `stripNarratorArtifactStream`, then `stripMisplacedSpeakerTagStream`
   (server/ai/narrator-speaker-tags.ts — de-brackets a known name written outside a
   line-opening tag position, e.g. `"Nice to see you, [Brian]."`; the roster comes in as
   `speakers`, the player + supporting cast as `plain`), then
   `collapseRepeatedBlocksStream` (server/ai/narrator-repeats.ts — drops Aion
   tandem-repeat blocks, a verbatim re-emit of the reply's own trailing paragraphs,
   before they reach the live feed or the persisted accumulated reply). The narrator model is
   the per-character pick (`characters.chatModel`, resolved through the strict curated
   list) — a headless POST without a `model` defaults to it too
   (`resolveChatModelId`), so API and UI agree. Resolution ends server-side in
   `chatNarrativeModelId`, which adds a second gate to curation: a pick whose provider
   has no configured key falls back to the lane default rather than spending the turn
   on a certain 401. `textModel` then points the id at whichever upstream serves it —
   the narrator list is the only model list in the app that may name a provider other
   than OpenRouter. The stream is wrapped by two watchdogs
   (`withStreamTimeouts`, data-loss-rerun): a **first-token timeout**
   (`CHAT_STREAM_FIRST_TOKEN_MS` = 50s — deliberately under Fly's ~60s proxy idle
   timeout, which would otherwise kill the zero-bytes-so-far response first and turn an
   attributable timeout into a silent connection drop) and an **overall cap**
   (`CHAT_STREAM_OVERALL_MS` = 300s). On a trip it aborts the upstream call and settles
   through the same stop path as a player Stop (any partial persists with `meta.stopped`,
   the lock releases) — so a wedged provider can never hold the per-chat lock indefinitely
   (the incident that motivated the fix). See §Reply failures below for how a zero-token
   settle is classified and surfaced.
9. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](../resilience.md) §5) — the reply persists (§5) and the post-turn fan-out
   runs (§3). All of it is off the perceived-latency path.
10. **Render (dialogue-attribution).** The transcript owns dialogue presentation, so chat rule 3
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

  | Leg                    | Fields                                                                                | Diagnostic prefix        |
  | ---------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
  | **memory scribe**      | `episodeSummary`, `facts`, `memoryQueries`                                            | `chat_memory_scribe.*`   |
  | **continuity tracker** | `scene`, `outfit`, `playerOutfit`, `attributeChanges`, `presence`, `cast`             | `chat_continuity.*`      |
  | **character tracker**  | `openLoops`, `plans`, `driveUpdates`, `voiceExemplar`, `characterSlip`, `traitShifts` | `chat_character_notes.*` |

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
  replacement — but over a modelled wardrobe only when the proposal's verbatim
  `changeEvidence` is present in this exchange's text, asserts a completed change
  (`classifyOutfitChangeQuote`, `contracts/items/outfit-change-evidence.ts`), AND attributes
  to that wardrobe's owner in the very sentence that asserted (owner rulings 2026-08-01 — the
  two halves of the exchange are passed separately, since which half a quote came from decides
  who "I"/"you" is, see [state.md](state.md) §Wardrobe);
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
step 7). Where a turn is **crowded** — several one-turn notes competing for the same beat —
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

1. **A provider failure usually does not throw.** `streamText`'s `textStream` drops
   error parts and delivers the failure to its `onError` callback, rejecting the
   `finishReason`/`usage` promises — so a failed generation arrives as a clean stream
   of zero deltas. `streamCharacterChat` therefore captures the error from `onError`
   and classifies it there; `streamExchange`'s catch still covers a genuinely thrown
   error. Either way the classifier is the same `classifyProviderError`
   (`server/ai/errors.ts`): it unwraps the AI SDK's `RetryError`, reads
   `APICallError.statusCode` + the provider error envelope in `responseBody`, and also
   recognizes an error envelope delivered as a plain JSON object in-stream (an
   upstream that answers HTTP 200 and puts `{"error": …}` in an SSE frame). It maps
   them onto the closed `ChatReplyFailureCode` vocabulary
   (`contracts/turns/chat-reply-failure.ts`) — timeout, rate_limited, no_credits,
   auth_failed, moderation_blocked, context_too_long, provider_error, network,
   empty_reply, unknown.
2. **How the generation ended is recorded, not inferred.** `streamCharacterChat`
   reports a `NarratorCompletion` (`server/ai/narrator-completion.ts`) — provider,
   model, finish reason, token counts, and the text length both BEFORE and AFTER the
   output normalizers. Counts and finish state only: no prompt, prose or reasoning
   content. A zero-visible-text exchange logs the whole record
   (`engine.chat "narrator produced no visible text"`).
3. `resolveReplyFailure` (pure) decides what the exchange records: only a
   **zero-text** settle records a failure (a partial that persisted is a visible
   reply); a watchdog trip outranks the stop flag it shares an AbortController with
   (`timeout`); a genuine player Stop records nothing. A zero-text settle that neither
   threw, timed out nor stopped is classified from the completion record
   (`classifyEmptyNarratorCompletion`) rather than assumed silent:

| Evidence                                | Recorded as                         |
| --------------------------------------- | ----------------------------------- |
| `content-filter` finish                 | `moderation_blocked`                |
| `error` finish                          | the provider error's own class      |
| raw text > 0, none survived normalizing | `empty_reply` / `normalizer_erased` |
| reasoning tokens reported, no prose     | `empty_reply` / `reasoning_spent`   |
| `length` finish, no reasoning reported  | `empty_reply` / `length_capped`     |
| billed output tokens that never arrived | `empty_reply` / `hidden_output`     |
| `stop` finish with no such evidence     | `empty_reply` / `model_silent`      |
| no usable evidence                      | `empty_reply`, no cause             |

4. The verdict is written to `character_chats.last_reply_failure` (cleared by any
   exchange that settles) **before the generator returns**, so the route's drain —
   and therefore the client's post-exchange refetch — strictly follows it.
5. The transcript GET returns it on the `chat` envelope; the client's
   zero-tokens-received path hands it to `replyFailureToast`
   (`components/chat/reply-failure.ts`), which maps each class to its own copy
   (quoting the provider's words where they add signal) with a 10-minute staleness
   guard. An `empty_reply` carrying a cause takes that cause's copy instead of the
   class copy, so the popup never claims the model said nothing when the server knows
   it hit the length cap or that Vesper's own normalizers erased the reply. **No
   cause's copy names a mechanism the metadata did not measure**: only
   `reasoning_spent` carries a reported reasoning-token count, so only it blames a
   thinking chain — which matters because no Featherless narrator reports a reasoning
   split at all: the thinking rows are asked with `enable_thinking: false`, and the
   rest never emit a chain. Credential
   failures name the upstream only when the recorded model id identifies one
   (`narrativeModelProvider`), and say "the model provider" otherwise — the narrator
   list is multi-provider. No record ⇒ honest "no cause recorded" copy.

Adding a failure class = a literal in the contract + a copy entry in the client map
(registry pattern — never a migration; unknown stored codes parse to `unknown`). The
same is true of `ChatReplyFailureCause`, the optional refinement of `empty_reply`.

### One hidden retry, for one model

A narrator model may opt into a single hidden retry for a zero-visible-text completion
(`narratorHiddenRetryModel`, keyed by exact id in `server/ai/provider.ts`). It runs only
when nothing reached the player — so nothing can be duplicated — and never after a
content-filter or generation-error finish, a player abort, or a thrown exception. It
lives inside `streamCharacterChat`, so both attempts share the caller's abort signal and
the one first-token/overall watchdog budget. A partial reply is never retried, and every
model without an explicit policy entry keeps today's behavior of surfacing the empty
reply immediately.

## Jobs

- **`chat_summary`** — engine queue (`enqueueChatSummary`), detached; folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock`.
  Recovery: heartbeated while running; a dead row is failed by the detached-job sweep.
- **`chat_scene_sketch`** — engine queue (`enqueueChatSceneSketch`), detached; expands a just-introduced place into a visual sketch on `scene_memory` ([state.md](state.md) §Scene memory step 4) — write is an optimistic CAS, never the exchange lock; one live job per chat.
  Recovery: same detached sweep; a lost CAS or failed run simply re-fires while the place's sketch stays absent.
- **`chat_look_image`** — engine queue (`enqueueChatLookImage`, fired by the finalizer on an outfit/appearance change), detached; mints the outfit-true look anchor ([images.md](images.md) §Scene reference anchors) — image-active chats only, keep-latest.
  Recovery: same sweep; a failed mint leaves renders on the avatar and the next change re-fires.
- **`chat_place_image`** — engine queue (`enqueueChatPlaceImage`, fired lazily by `queueChatScene` on the first render in a sketched place), detached; CAS-writes `ScenePlace.imageId`.
  Recovery: same sweep; a lost CAS / failed render re-fires on the next render there.
- **`chat_scene_image`** — api-side `startJob` via the shared `queueChatScene` (`chats/[chatId]/scene/queue.ts`) — manual POST **and** the auto big-moment hook; one live render per chat (check-then-insert dedupe); anchored at queue time (manual = newest assistant line, auto = the exchange's reply).
  Recovery: `sweepDetachedApiJobs` (`engine/recovery.ts`) fails any detached running job whose heartbeat is older than `API_JOB_STALE_MS`.


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
  (successor-world-lifecycle.plan.md): when the chat row carries a `sim_branch_id`,
  the world resolves through `sim_branches` and its `sim_worlds` row is deleted in
  the same transaction — cascades take the branch and every branch-scoped row. A
  set-but-dangling branch id degrades
  (`chat.delete_sim_branch_missing` warn, chat still deletes); the leaked world is
  reclaimed by the admin orphan sweeper. Character deletion inherits this through
  the same traversal.

