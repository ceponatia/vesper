# Initiative & memory callbacks

The two ways the character moves without being asked: reaching out first when the
player reopens the conversation, and surfacing an old shared moment unprompted.

## Initiative (the character reaches out first)

The reopen opener (`chat-initiative.plan.md`):
the pickup strip gains **"Let {who} start ✦"**, which runs a `continue`-kind
exchange with `initiative: true` — the server builds the cue
(`buildInitiativeCue`, `engine/chat-initiative.ts`): reach out FIRST, with her
own material (**near plans lead** since chat-plans-promises — an imminent
commitment "is tonight still on?" or the cold open after being stood up — then
top open loops + unresolved non-secret wants — withheld secrets
never leak into the cue; the drives tail law owns them — plus, since the
remainder pass, the **unseen shift** and the **daily rhythm** below), the **"a
life meanwhile" license** folded in (build decision: instead of a separate
life-event agent, the cue invites ONE small concrete thing from her life since,
skip-aware — zero extra model calls, exactly as grounded as the narrator
already is; since chat-offscreen-life it also carries the **supporting cast**
as material — the sister is who she'd have seen — and when the meanwhile pass
left a `pending_meanwhile_note` for this gap, that note **leads the material
and the license switches to "pick your ONE meanwhile beat from it — never
invent a different meanwhile"**: dedupe rule F, improvisation yields to canon),
the **comms-when-apart register** (`*Name: …*` texted opener when
the fiction has them apart), and a restraint clause (one beat, end on something
answerable, never narrate the player). Standing rulings hold: **D3** —
generation stays player-tapped, never background, and the marker never reads
the wall clock (re-ruled 2026-07-12: loops + milestones only); **D8** — what
the gap meant comes from the pending skip note, never real time. The opener is
an ordinary continue exchange: clock ticks, archivist off (opening path),
lock/guard semantics unchanged; the pulse is skipped **except** when the
opener-selfie license armed, where it runs **opener-scoped** (below).

The remainder slices (shipped 2026-07-12):

- **Marker v2 — the unseen-milestone seen-cursor** (spec §8.4 v2). The hub's
  "has something to say" derivation (`GET /api/chats`) stays read-time-pure.
  Since chat-plans-promises an **imminent or just-missed PLAN outranks open
  loops** (`planHubReason` over the chat's `plans` + `clock_minutes` — a
  commitment coming due is the strongest pull); with no near plan the top open
  loop leads, and with no loops the reason is the **newest
  milestone unseen since the player last opened the conversation**
  (`unseenMilestoneReason`, `contracts/relationships/history.ts` —
  `first_exchange` never fires it). "Seen" is the `character_chats.
  milestones_seen_at` cursor (migration 0043), stamped **only on conversation
  open** (`PATCH …/:chatId {seen: true}`, fired by the page's mount effect) —
  deliberately not by the transcript GET, which refetches after every exchange
  and would mark each milestone seen the instant it lands. So a milestone
  landing mid-visit lights the hub marker on the next visit and clears on the
  next open (the unread-badge pattern). The `?say=1` banner no longer requires
  open loops: a loop-less tap runs the full initiative opener, and the opener
  cue itself names the unseen shift as material ("what just shifted between
  you") via a one-column `loadMilestonesSeenAt` read on initiative beats.
- **Daily rhythm** (`profile.schedule` authoring — see
  [authoring.md](../authoring.md) §Daily rhythm). The cue renders the schedule as
  one compact line (`formatScheduleRhythm` — "mornings: waiting tables at the
  Dockside Café; evenings: sketching at the pier") grounding the life-meanwhile
  license, so "just got off shift" beats draw on authored routine instead of
  invention.
- **Opener selfie** — see [images.md](images.md) §Selfies (the opener arm).


## Memory callbacks

Fused recall is input-relevance-only, so shared history never resurfaced on its own —
the character could never say "remember when…" unprompted. The memory-callback cue
(`memory-callbacks.plan.md`)
fixes that with one low-frequency, one-turn tail line:

- **Gate first, cost second** (`chat-callback.ts` `chatCallbackEligible`, pure): real
  player turns only, at most once per `CHAT_CALLBACK_MIN_GAP_MINUTES` of chat clock
  (10 exchanges of ticks — a time skip naturally re-opens eligibility), and only on a
  **lull**: suppressed by a first exchange, a pending skip note, a scene change, an
  intimate beat (cue or arousal floor), a sensory-focus block, or a character question
  the player is mid-answering. No regard-band gate (owner ruling 2026-07-11) — the
  band picks the wording, not the eligibility.
- **Selection** (`chat-memory.ts` `retrieveChatCallback` → pure `selectChatCallback`):
  one embedding of the input + one query over episodes ≥8 exchanges old
  (`callbackEpisodeCandidates`, each carrying its similarity to the input). Scoring
  prefers **old**, **milestone-marked** (joined by `source_message_id` — an exchange
  that minted a `player_marked`/`strong_reaction`/band-crossing milestone is a
  *moment*), and **topic-distant** — candidates at/above the echo ceiling are dropped
  outright (recall would surface them anyway; a callback is a tangent). Used refs
  never repeat (`callback_history`, burned at offer time so "another take" rolls the
  burn back with the snapshot and the retake gets the same opportunity).
- **Render** (`chatCallbackLine`, volatile tail, lowest priority): one optional aside
  worded by regard band — warm bands get nostalgia, the middle a plain remembering,
  cold bands a pointed edge ("a point to make, a wound … never warmth you don't
  feel"). Always droppable: the scene in motion outranks the memory.
- **Degradation**: any retrieval/embedding failure ⇒ no line +
  `chat_memory.callback.failed` (warn) — an ordinary turn, never a failed reply.

