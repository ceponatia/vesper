# API surface & diagnostics

The HTTP routes under `/api/chats` and the diagnostic codes the lane emits. Ownership
resolves through the chat row (`chats/owned.ts` `loadOwnedChat`) on every route below.

## Conversations and the transcript

- **`GET /api/chats?characterId=&archived=1` · `POST /api/chats`** — list conversations ·
  create one. `memory: "shared" | "fresh"` chooses whether the new conversation joins the
  character's existing memory group or starts an island.
- **`GET/POST/PATCH/DELETE /api/chats/:chatId`** — the newest transcript page, one exchange,
  rename/archive/restore, and the hard delete.
- **`POST /api/chats/:chatId/stop`** — cut the in-flight reply short (the prefix persists
  with `meta.stopped`).
- **`PATCH/DELETE /api/chats/:chatId/messages/:messageId`** — edit / snip one line, then
  rebuild every derivative that still carries its old wording (§Continuity repair below).
- **`PATCH /api/chats/:chatId/messages/:messageId/take`** — make a recorded take the
  displayed reply (display-only).
- **`GET/POST /api/chat-presets` · `DELETE /api/chat-presets/:id`** — scenario presets;
  `POST /api/chats {presetId}` seeds a new conversation from one. UI: Apply/Save-as/Delete
  preset in `chat-scenario-modal.tsx`, "Start from preset" in `new-chat-dialog.tsx`.

**The transcript GET** returns 100 rows; `?before=<messageId>` keysets older pages, with
`hasMore`/`nextBefore` in the envelope (the UI's "Load earlier").

**The exchange POST** takes `kind: send | open | continue | regenerate | rerun`. `rerun`
takes `messageId` = the latest exchange's user line; older targets return
`rerun_requires_branch` without mutation. A `send` may carry `attachmentIds` ≤4
([images.md](images.md) §Player photos), may be photo-only, and may carry `inputMode:
"narrator"` ([supporting-cast.md](supporting-cast.md) §Narrator input). The response is a
plain-text token stream; an archived chat answers 409 `chat_archived`.

**Assistant replies that authored an NPC permission event are state-authoritative.** The
transcript-only PATCH/DELETE routes return 409 `message_has_permission_authority` for those
rows: editing or snipping prose may not rewrite NPC agency. A state-aware regenerate/rerun
path performs the explicit permission and contact rollback instead.

### Continuity repair

**An edited or snipped line's wording also lives outside the transcript** — folded into the
rolling summary, extracted into the facts and episode of the exchange it belonged to, and
possibly kept as a voice exemplar — so both verbs rebuild all three before answering, and
await the work: a fire-and-forget repair lets the very next send retrieve what the player just
removed. Everything the repair reads from another store (the player persona the scribe
addresses) is resolved before the write, so that lookup failing costs the request rather than
leaving a committed line with unrepaired derivatives.

- **Memory** — repair follows the **exchange**, not the edited row. Memory is stored under an
  assistant message id, but the extraction behind it read the player's half too, so a player
  line's wording lives in the exchange anchored on the reply that followed it: editing or
  deleting one retracts that reply's extraction and re-files it from the current transcript
  (the new player text, or no player half at all after a delete). A player line no reply has
  answered yet has no derivative and is `unaffected`. An edited assistant line re-files itself;
  a deleted one is retracted only, having no anchor left to file under.
- **Summary** — re-folded whenever the line's `(createdAt, id)` is at or before the summary
  watermark, for user and assistant lines alike. A line AFTER the watermark is still verbatim
  in the window and costs no model call. The coverage decision and the rebuild it triggers run
  under the per-chat summary lock, so a fold already in flight settles first and the decision
  reads its advanced watermark rather than the one it is about to replace. The rebuild resets
  the row before re-folding, so a degraded fold ends at an empty summary with a null watermark —
  the whole transcript verbatim again, never the stale recap.
- **Voice** — every exemplar sourced from the line is dropped from each roster member's live
  ring and from its "another take" rollback snapshot, so a retake cannot resurrect it. An
  exemplar recorded before provenance existed is dropped when its line occurs verbatim in the
  old content.

The repair holds the chat exchange lock, because the exchange finalizer rewrites the state
row's rings wholesale: both verbs answer 409 `chat_busy`, having written nothing, while a
reply streams or another repair runs — and a send that arrives mid-repair gets the same code
naming the repair. The transcript write commits before the derivatives are rebuilt, so a step
that fails is reported rather than failing the request.

`PATCH` returns `{ id, continuity }` and `DELETE` returns `{ deleted: true, continuity }`:

| Field                   | Values                                                                  |
| ----------------------- | ----------------------------------------------------------------------- |
| `summary`               | `rebuilt` \| `unaffected` \| `failed`                                   |
| `memory`                | `reextracted` \| `degraded` \| `reconciled` \| `unaffected` \| `failed` |
| `voiceExemplarsRemoved` | exemplars dropped from the live rings                                   |
| `voice`                 | `scrubbed` \| `unaffected` \| `failed`                                  |
| `diagnostics`           | the repair's diagnostic codes                                           |

## Roster and relationships

- **`POST /api/chats/:chatId/participants` · `PATCH/DELETE …/participants/:characterId`** —
  roster add (cap 4, its own shared/fresh memory choice per joiner; seeds matrix pairs) ·
  presence flip (through `editChatState`, 409 mid-stream) · remove (never the last; the
  primary's heir promotes — [multi-character.md](multi-character.md)).
- **`GET/PUT /api/chats/:chatId/relationships`** — the conversation's directed NPC↔NPC
  matrix + roster · upsert authored edges (band picks → live scalars; roster-validated).
- **`GET/PUT /api/characters/:id/relationships`** — the character's library-default edges
  (the editor's Relationships tab; seeds new conversations). GET returns the full set and its
  revision. PUT supplies that revision and replaces the set transactionally; a stale write returns
  409 `relationship_conflict` with the current set and revision for explicit recovery.
- **`GET /api/chats/:chatId/relationship`** — Relationship-panel payload: both axis bands +
  scalars, region label, texture, history samples, milestones, story-so-far, open loops.

## State, the clock, and memory

- **`GET/PATCH/POST /api/chats/:chatId/state`** — state snapshot (drift-on-read) · author
  edit · action chip (primary only). 409 `chat_busy` while a reply streams.
- **`POST /api/chats/:chatId/time-skip`** — `{amount: moments|hours|overnight|days}` →
  `CHAT_SKIP_MINUTES` (`contracts/turns/chat-skip.ts`).
- **`POST /api/chats/:chatId/remember`** — "remember this": pin an `origin:"player"` fact —
  confidence 1, no message anchor, force-retrieved, never superseded by extraction
  ([memory.md](../memory.md)).
- **`POST /api/chats/:chatId/milestones`** — "mark this moment": append a `player_marked`
  milestone on a message (label defaults to a line excerpt).
- **`POST /api/chats/:chatId/summary/rebuild`** — `rebuildChatSummary`: reset + re-fold the
  rolling summary from the full transcript under the summary lock (heavy-write rate
  limited).
- **`GET /api/chats/:chatId/export?format=md|json&memory=1`** — transcript export: title,
  scenario, story-so-far, transcript, opt-in memory appendix.

`?characterId=` targets any roster member on the state routes — the per-character sheet.
`ChatStateEdit` is ONE patch surface: per-character fields write the target's row, chat-wide
fields write the scenario (`premise` / `activeSocialCards` / `sceneMemory` /
`supportingCast` / `plans` — the Plans panel's whole-list save — and `calendarStart`, the
clock card's "story starts on…" editor, which rebases every derived date).

A **time skip** advances the SHARED scenario clock and stamps the skip note (worded by the
primary's band, naming the calendar landing) + `skip_history`, then gives each PRESENT
member their condition expiry / scene-budget reset / feeling decay / rhythm auto-dress (real
weekday via `calendar_start`); meters are untouched. The snapshot's `calendarStart` lets the
client name the landing ("It's now Friday evening"). A qualifying skip (cumulative ≥ 1 story
day since the last pass) also fires the detached **meanwhile pass** (`chat_meanwhile` job —
[plans.md](plans.md) §Off-screen life).

## Images

- **`POST /api/chats/:chatId/attachments`** — upload ONE player photo (data URL in,
  `chat_upload` asset id back — [images.md](images.md) §Player photos); 409 on an archived
  chat, generation-rate-limited.
- **`GET/POST /api/chats/:chatId/scene`** — list **this chat's** scenes only (sibling chats
  / un-chat-keyed rows stay Gallery-only) plus `rendering` · queue a render via
  `queueChatScene` (409 `scene_busy` while one is live).

`rendering` is true while a `chat_scene_image` job is live (`hasLiveChatSceneJob`), which is
what keeps the client polling through the composer step *before* the pending image row
exists. The chat's `sceneModel` pick (`character_chats.scene_model`, on the shared scenario;
saved on select from the strip's dropdown via the state PATCH, or the Scenario modal's
select) is **reference-only** — stored picks parse back to `reference`, and every render is
the identity-locked avatar edit
([images/pipelines/chat-images.md](../images/pipelines/chat-images.md)).

## Admin routes

### `GET/POST /api/admin/chat-permissions/:chatId`

The `romantic_touch` permission dev surface ([physical-legs.md](physical-legs.md)).
**Admin-role-gated + owner-scoped** (`withOwnerAdminOwnedChat`), requested through the
`/self/` mirror with its own parity test.

- **GET** returns the directional standing-grant projection + a bounded recent-event list,
  readable regardless of flags.
- **POST** applies one developer override `{permittedActorId, grantingTargetId, operation:
  grant|withdraw}`, **additionally gated by `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`**
  (hidden 404 when off). The target must be a roster NPC, never the player; 409
  `chat_busy`/`chat_archived` apply.

An override appends a `developer_overridden` ledger event through the same atomic
invalidation path production events use (a withdraw ends dependent contact in the same
transaction) and records a `romantic_permission_developer_override` audit event with the
operator. It **holds** the `chat_exchange:<chatId>` lock across the write (bounded wait,
then the same 409 `chat_busy`) rather than only probing it, and the sweep's scene write is a
CAS — a racing exchange scene write refuses the whole call as 409 `scene_conflict` with
nothing committed. UI: the conversation menu's admin-only "Permissions (dev)" panel
(`chat-permissions-panel.tsx`). Chat text is never an override.

### `/api/admin/chat-inspector/:chatId[/…]`

The memory inspector family — **admin-role-gated (404 for non-admins, so it works on the
deployed build) and owner-scoped**:

- **Overview** — all facts including superseded/retracted, each labeled with its `channel`
  (`perceived`/`private`/`ooc`, the RAG visibility fence — [memory.md](../memory.md) §Fact
  channel), plus episodes + summary.
- **Facts / episodes / summary** — facts create/PATCH (pin/retract/restore,
  re-embed-on-edit) · episodes PATCH/DELETE + `score?q=` · summary PATCH.
- **Prompt preview** (`chat-prompt-preview.ts` `previewChatPrompt`) — "what reaches the narrator": it re-derives the
  flag-gated legs from the stored cut so the bytes match a live turn's, contact leg
  included, and it OBEYS every flag because it is showing prompt bytes.
- **Affordance preview** (`previewChatAffordances`) — the staged read: source inputs →
  structural profile → mechanics → observations or suppression reason → perception filtering
  → selected cue, per domain. READ-ONLY, computes on demand and stores nothing, and reports
  the `CHAT_AFFORDANCE_CUES` flag rather than obeying it.
- **Physical-guidance preview** (`previewChatPhysicalGuidance`) — the constraint/premise
  staircase: input authority → committed state and per-owner availability → relevance →
  candidates with their disclosure, including the contact leg's resolved act → what the gate
  and the budget kept → the rendered instruction. Same READ-ONLY shape; reports
  `CHAT_PHYSICAL_CONSTRAINTS` **and** `CHAT_CONTACT_ACTIONS` rather than obeying either.
  Guidance is never persisted, and the contact leg's plan runs while its ledger append and
  scene fold deliberately do not ([physical-legs.md](physical-legs.md)).
- **Visual-state preview** (`previewChatVisualState`) — the lane-neutral visual snapshot:
  source facts → projected features → composition and suppressions → visibility evidence →
  attention scores → narrator/image selections, plus shadow measurements. It serves both
  lanes, dispatching per chat authority, and shows the viewing conditions the production
  reads actually ran under and which of them are stated defaults rather than owned readings.
  READ-ONLY, never spends notice or mention state, and reports the
  `CHAT_VISUAL_STATE_SHADOW` flag rather than obeying it.

The visual-state preview also carries the **realized image digest** (`imageDigest`): each
subject's required and optional facts with the prompt segment each belongs to, the
missing-mandatory report, suppression reasons with counts, the snapshot/selection/camera
fingerprints, and the `meta.visualState` provenance record a render row stores. It is
realized from the same snapshot, selection and camera context the shadow build selected
under, so both lanes show it identically — the cast-of-one chat scene render assembles its
cut through this same `chatVisualStateShadowInput` factory, while the preview itself feeds
no render.

### The `/self/` mirror

The handlers live at `/api/admin/chat-inspector/:chatId/…` but the inspector client
(`apps/web/src/lib/api-inspector.ts`) requests every panel through
`/api/admin/self/chat-inspector/:chatId/…`. Each mirrored path is a one-line re-export twin
(`export { GET } from "@/app/api/admin/chat-inspector/[chatId]/<name>/route"`) under
`apps/web/src/app/api/admin/self/chat-inspector/[chatId]/`, so authorization lives in
exactly one place — the canonical handler's `withSelfOwnedChat`. **A new inspector panel
needs both files**: the canonical route alone type-checks, lints, and passes its own tests
while 404ing in the running app.
`apps/web/src/app/api/admin/self/chat-inspector/parity.test.ts` walks both trees and fails
on a canonical route without a twin, a twin without a canonical route, or a twin that
re-exports fewer verbs than the handler declares.

## Sim-routed dispatch (`POST /api/chats/:chatId`)

When a chat is routed to the successor engine (its `engine_authority` is past the view
threshold, branch-linked, and actor-mapped — the GET envelope's `chat.simRouted` flag), the
POST fork resolves authority **once, before kind dispatch**: every operation has successor
semantics or is refused, and the legacy pipeline (`submitChatMessage`) is unreachable for
it.

The successor response keeps the existing plain-text transport. It sends invisible
heartbeats while world resolution, generation, and the full-cut audit run; after the audit
accepts one telling, that approved prose is revealed in small paced chunks so the reply
grows in the bubble instead of arriving as one blob. This is deliberately post-audit
streaming, not raw provider-token streaming: a rejected hidden attempt must never leak
before its correction. The client's post-exchange transcript refetch reconciles the
persisted rows.

Each POST `kind` resolves to one of these. Every accepted kind answers with the
heartbeat-while-resolving/auditing, then paced-approved-prose-chunks response described
above:

- **`send`** — `runSimChatExchange`: land the player line, run input admission, advance the
  span, render a fresh cut, persist a new reply.
- **`continue`** — real turn with **no player utterance**: no user row, no admission, span
  still advances (time moves), render omits the player-turn block.
- **`open`** — as `continue`, plus `simOpening` on the reply's `meta`, the opening-directive
  flag the prompt reads.
- **`regenerate` / `rerun`** — **re-render the SAME committed cut**: resolve the cut id from
  the last reply's `meta.cutId` (fallback `latestCutIdForEngagement`), re-render fresh
  prose, replace the reply row in place (content + browsable `takes` + meta). NO time
  advance, NO admission, NO new rows.
- **`action_beat`, or any kind with `action` set** — **refused** with 409
  `sim_unsupported_operation`; legacy action chips have no successor semantics.
- **any kind with `attachmentIds`** — **refused** with 409 `sim_unsupported_operation`;
  vision reads are not wired to the sim lane.

The UI hides the attachment control and action chips for a sim-routed chat (a hidden control
beats a dead one that 409s); Continue / Regenerate / Go on / Prompt stay visible and run the
successor semantics above. The kind→mode decision is the pure `decideSimOperation`
(`app/api/chats/[chatId]/sim-routing.ts`).

## Diagnostics

Every leg failure below is ALSO recorded durably and tallied with a suspected cause — see
[../resilience.md](../resilience.md) §Agent-failure telemetry and the inspector's **Agent
health** panel (`GET /api/admin/chat-inspector/[chatId]/agent-failures`, admin-only). A
transport failure emits `${leg}.api_error` (with the provider's class) rather than
mislabeling itself `${leg}.parse_failed`.

`chat_state.pulse` / `.degraded` / `.timeout` · the three extraction legs, each with its own
`.extract` / `.timeout` / `.api_error` / `.parse_failed`: `chat_memory_scribe.*` ·
`chat_continuity.*` · `chat_character_notes.*` (one degraded leg costs only its own fields —
see [post-turn.md](post-turn.md); `chat_archivist.degraded` still marks the demo-mode skip
of all three) · `chat_personal_notes.*` (the ensemble's per-member pass) ·
`chat_memory.episodes_failed` / `.facts_failed` · `memory.queries.embed_failed` (the turn's
shared query-embed batch — every leg then takes its own degraded path) ·
`memory.facts.embed_failed` / `memory.episodes.embed_failed` (a per-leg fused-retrieval
embed failure — facts degrade to pinned-only, episodes to `[]`) ·
`chat_memory.callback.failed` (a degraded memory-callback retrieval — the turn just carries
no callback line) · `chat_vision.describe_failed` (a degraded photo read — the character
sees "a photo you can't quite make out"; a non-degraded later retake retries) ·
`chat_state.memory.write_failed` · `chat_state.attribute.unknown` /
`.inherent_change_rejected` · `chat_summary.fold` / `.degraded` / `.empty` ·
`chat_state.snapshot.missing` · `chat_memory.reconciled` · the transcript-edit repair's
`chat_continuity.summary.rebuilt` / `.summary.failed` / `.memory.degraded` (**warn** — the old
extraction is retracted and the re-file degraded, so nothing replaced it) / `.memory.failed` /
`.voice.scrubbed` / `.voice.failed` (§Continuity repair; the tracker leg's `chat_continuity.*`
above is a different leg) · the `romantic_touch` permission
owner's `chat_permission.scene.stale` (a racing scene write refused the whole append —
nothing committed), `chat_permission.rollback.failed` (**error** — a retake exhausted the
discarded-take permission prune retries, so the retake is refused before a replacement reply
can commit), `chat_permission.stop_guidance.unreadable` (an unreadable contact-ending
payload degrades to a generic stop line rather than silence) and `.stop_guidance.over_bound`
(more pending stops than the transition budget; the generic line is cut before any named
pair).

Route errors: `chat_busy` (409; a streaming reply, a world catch-up, or a transcript edit
repairing the conversation's derivatives — the message names which), `chat_archived` (409),
`message_has_permission_authority`
(409; a transcript-only edit/delete tried to rewrite an NPC permission source),
`scene_conflict` (409; the permission override lost a scene CAS — retry),
`invalid_rerun_target` (400), `rerun_requires_branch` (400; an older line cannot be safely
rewritten through a one-exchange state snapshot), `sim_unsupported_operation` (409; an
attachment or legacy action chip on a sim-routed chat — see §Sim-routed dispatch),
`scene_busy` (409), `rate_limited` (429), `not_found` (404). A failed `queueChatScene` (auto
or manual) log-warns (`chat_scene` scope) and returns null — never a failed exchange.
Degradation tests assert the fallback **and** the code ([testing.md](../testing.md)).
