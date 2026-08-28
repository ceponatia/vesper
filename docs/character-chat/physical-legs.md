# Physical legs

Three optional legs run inside an exchange between RAG recall and the prompt build
([pipeline.md](pipeline.md) §The exchange lifecycle, step 6): affectionate contact,
constraint-first narrator guidance, and the `romantic_touch` permission owner. Each is
behind its own flag, each defaults off, and **none of them ever writes another's state** —
that independence is what keeps either experiment interpretable on its own.

## Affectionate contact

`CHAT_CONTACT_ACTIONS` (default off), `engine/chat-contact-adapter.ts`. Regex-only over
the player's own line: no model call and no
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
for a plainly affectionate hand-to-shoulder/arm/back/hand/head touch.

Two hooks end contacts before detection runs: a pending story-clock skip ends every active
contact (`separated`; owner ruling 2026-07-31), and a scene-place change ends them as
`scene_changed` — which is also the door "I walk over to her desk" comes through,
since the contact detectors read that as furniture while `detectSceneMovement` reads
a move, and a held touch does not survive the mover either way.

A detected act is resolved by the shared contact core against the scene's reach, support,
and material reads — a dressed body whose wardrobe published no coverage capture resolves
`unresolved` (silence), never bare skin. A committable one is folded, and ALL of the
exchange's durable commits (hook ends, the plan's release then departure ends, then
the touch's events) are
written **atomically with the scene projection before the prompt builds**
(`appendChatContactEventsWithScene`: one transaction over the ledger rows and
`character_chats.scene`, idempotent on `(chat, event ref, sequence)`, and VERIFIED —
a conflicting row under this exchange's keys aborts the whole write, files an `error`
diagnostic, and leaves the outcome `unresolved`). Only a verified write's
acknowledgment licenses a `committed` action outcome.

Anything the detectors cannot read cleanly produces silence — a hedge, a negation
(including the complete straight/curly/apostrophe-free auxiliary-contraction family), a
question, an ambiguous target, storyteller narration, speech rather than narration, and
(owner constraint) any romantic, intimate, or restraint framing anywhere in the sentence, so
a romantic case can never be relabeled into a commit. The two ENDS lift the restraint
veto and nothing else does — "I pull my hand back" and "I pull away" are the plainest
English there is, and a missed end strands a durable row.

### Departure

The **departure** is the approach's inverse and the fourth producer of an end: the
player's own body moving off (`near` for the step-back class — "I step back", "I take
a step back", "I step/back/pull/move/draw away", "I lean back", "I put some distance
between us"; `distant` for the crossing class — "I walk away", "I step/move/walk
across the room"), from a named person, a sole-character pronoun, or — unnamed —
from everyone. It ends **every**
active contact the player is a participant in, either direction (her hand on the
player goes too), reason `separated`, one durable `endContact` commit each on the
same combined ordered list as everything else.

Its distance claim obeys the never-invent law: a `player`-origin `set_proximity` is written
**only** where the pair already has a proximity fact (and only when the new band is
genuinely farther — a departure widens, never narrows) or where an active contact proves
they were close; a pair nobody placed stays unknown. Facing is untouched — stepping back is
not turning away.

Plan order is release → departure → approach → touch, so "I step back.
I walk over to Wren." ends the touch and lands `close`, while within ONE sentence a
named destination outranks a departure ("I walk across the room to Wren" is an
arrival). Release/departure precedence: a hand-only "I pull my hand back" releases
(`withdrawn`) and states no distance; a whole-body "I pull away" is a departure
(`separated`) and is deliberately not also a release, since the departure already
ends the same contacts and more.

A retake deletes the discarded take's ledger rows under the same exchange guard the scene
projection rolls back on (`deleteChatContactEventsForGuard`, beside `rollbackScenario` —
unconditionally, not flag-gated: pruning a discarded take's durable rows is hygiene, not
behavior). The settle-time save re-writes the same scene the transaction already persisted;
the ledger is the record the projection caches.

## Constraint-first narrator guidance

`CHAT_PHYSICAL_CONSTRAINTS` (default off), `engine/chat-physical-guidance.ts`: what this
body's committed state forbids the
narrator to claim, plus the high-confidence false premises in the player's own
framing — gated, ordered and budgeted by the shared guidance layer and rendered as one
binding block ahead of the tail's other notes. Nothing here is persisted; the
selection recomputes from the same cut and the same message, so the existing rollback
anchors reproduce it.

It also owns the **only door onto the prompt**, so the contact
outcome above reaches the narrator only when this flag is on as well: with it off,
contact still commits and still persists, and the prompt is byte-identical. The rules the
block compiles are [physical-guidance.md](physical-guidance.md); its rendered wording is
[perception-gates.md](perception-gates.md) §Physical consistency.

## The `romantic_touch` permission owner

`CHAT_ROMANTIC_PERMISSION` (default off), composed over
`CHAT_CONTACT_ACTIONS` but independent of the optional general-constraints leg. Four
pieces, all flag-off byte-identical.

1. **The policy read.** The chat's `chat_permission_events` ledger (migration 0096 — the
   contact ledger's sibling: idempotent on `(chat, event ref, sequence)`, guard-pruned
   on retake, chat-scoped because the chat IS the story branch) is listed once per
   exchange and folded into the standing-grant projection — there is no stored
   projection column, the fold over the pruned rows is the restoration — and
   `derivePermissionPolicyRead` answers for any attempt whose kind requires a grant:
   exact directional `romantic_touch` grant → allowed; withdrawn → withdrawn; absent →
   unresolved (silence); a player target → the ruled not-required exception (the player
   writes their own reaction; no grant is manufactured). Permission-neutral kinds keep
   the historical stub verbatim.
2. **The NPC-side decision**
   (`engine/chat-permission-decision.ts`): at settle, strictly after the beat's last
   scene writer, a trigger-gated single classifier call over the committed assistant
   reply ONLY — never player text — parsed by a closed per-digest contract and then
   deterministically validated (evidence must ground verbatim in an admissible span
   attributed to the granting NPC; conditionals, negations, questions, restraint
   framing, player echo, and player-as-target all drop with typed reasons; `withdrawn`
   needs a standing grant). Survivors append as `granted` / `attempt_denied` /
   `withdrawn` events under `permission-reply:<assistantMessageId>`. An
   `attempt_denied` event is bound to the exchange's current contact action; it ends only
   that action's active contact and leaves the standing grant intact.
3. **A standing withdrawal ends dependent contact atomically**
   (`appendChatPermissionEventsWithInvalidation`: permission rows + `policy_withdrawn`
   contact-ended rows + swept scene, one transaction — never a mixed state).
4. **The next narrator cut gets the stop** (`engine/chat-permission-guidance.ts`): endings
   no assistant reply has yet followed emit a mandatory transition line through the
   shared constraints compiler/renderer even when `CHAT_PHYSICAL_CONSTRAINTS` is off —
   named, idempotent, continuation-forbidding, never mechanics vocabulary, never the
   player's reaction. A stop-build failure aborts before a reply consumes the delivery
   window.

Retake prunes both possible permission guards atomically with bounded retries;
exhausted retries refuse the retake. The audited developer override (grant/withdraw per
direction from the conversation menu, admin-only) is [api.md](api.md)'s
`/api/admin/chat-permissions/:chatId`; chat text is never an override. The contact
preview keeps the permission-neutral stub deliberately (no detector can currently
produce a permission-requiring act, so preview/live parity holds).

## The dev previews re-derive both legs read-only

`previewChatPrompt` and `previewChatPhysicalGuidance` ([api.md](api.md) §Admin routes)
re-derive these legs without writing. Guidance is pure, so a
preview is simply a second evaluation. The contact leg is not — a live turn appends to
`chat_contact_events` and advances the scene projection — so `previewChatContactOutcomes`
runs `planChatContactTurn` and words the outcome while **discarding the planned scene and
performing no write**: looking at a prompt never moves a body or records a touch.

It keys on the newest player line's own row id, which for an ordinary send IS the exchange
guard the ledger was written under, so the inspector explains that contact rather than a
look-alike. The one thing it assumes rather than observes is the persistence
acknowledgment a `committed` status rests on (a preview performs no write, and without a
synthesized acknowledgment every contact would preview as silence); replaying the newest
line against the cut that line already settled
ordinarily re-derives the same contact and folds `contact_continued`, which legitimately
writes no row either way.

The prompt preview OBEYS both flags (it is showing bytes); the
guidance inspector reports them and runs the leg regardless, so a developer can see what
turning a flag on would do before turning it on.
