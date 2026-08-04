# Romantic contact affordances — directional permission owner

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md),
continuation item 5. Product behavior was owner-ruled 2026-08-04 and the owner
was implemented the same day behind `CHAT_ROMANTIC_PERMISSION` (default off;
the developer override has its own `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`
capability). §As built records the implementation decisions; enablement waits
for the plan's item-6 romantic proof.

## Scope

This specification defines the smallest authoritative permission owner needed
for the first genuinely romantic contact proof in character chat. The MVP owns
one exact scope: `romantic_touch`.

It does not decide whether an action is physically possible, author an NPC's
movement, infer attraction or arousal, or write the player's reaction. Actor
control, geometry, wardrobe, contact lifecycle, physiology, and narration
remain with their existing owners.

The current scope is deliberately narrower than the long-term consent model.
Kissing, intimate anatomy, undressing another participant, exposing oneself to
another participant, and sex require future exact scopes. They are not aliases
or implied descendants of `romantic_touch`.

## Direction and participant rules

A permission key is directional:

```text
permitted actor -> granting target -> exact scope -> story branch
```

If Mara grants Alex `romantic_touch`, Alex may attempt that class of contact
toward Mara. The record says nothing about Mara acting toward Alex.

The MVP applies these rules:

- Player-to-NPC romantic contact requires a grant authored by the target NPC.
- NPC-to-NPC romantic contact requires a grant authored by the target NPC.
  Mutual permission is represented by two records.
- NPC-to-player contact does not require Vesper to pre-calculate a standing
  player grant. The player controls their own next reaction. The NPC still
  needs actor control over its action, and the narrator may not commit the
  player's acceptance, reciprocation, pleasure, movement, or other voluntary
  response.
- Player-authored narrator mode never changes those boundaries.

Ordinary incidental, casual, and affectionate contact remains permission-neutral
under the existing owner ruling. Romantic or fetish-framed contact is never
relabeled as affectionate to avoid this owner.

## Exact scopes and future matrix

The MVP contains only `romantic_touch`, with exact membership and no
implication graph. A stored grant is usable only when the requested action maps
to that exact scope.

Future work should replace the single-scope MVP with a directional matrix. At
minimum, product design should consider distinct scopes for:

- kissing;
- romantic non-intimate touch;
- intimate touch;
- removing or moving another participant's clothing;
- exposing one's own nudity to another participant;
- sexual activity.

Names and granularity remain future decisions. The invariant is settled now:
one scope never silently authorizes another.

Relationship labels describe feeling, not permission. `cherished` or
`smitten` cannot create any grant and cannot substitute for one.

## Grant, denial, absence, and withdrawal

The owner keeps four meanings separate:

- **Absent:** no authoritative answer exists.
- **Grant:** the target authorizes the named actor for the exact scope.
- **Denial:** the target rejects the current attempt without necessarily
  changing an existing standing grant.
- **Withdrawal:** the target revokes an existing standing grant.

“Not now” normally denies the current attempt. “Do not touch me like that
anymore” withdraws the standing grant. Ambiguous language produces no permission
change.

A production NPC grant or withdrawal may come from explicit NPC dialogue or
unambiguous NPC-authored conduct that directly offers or retracts the contact.
The decision must be grounded in the NPC-side assistant message or simulation
event. It must not be inferred from:

- affection, attraction, arousal, or physiology;
- relationship label or score;
- an intimate-scene or touch-welcomeness signal;
- lack of resistance or silence;
- narrator tone, genre, or prior contact alone;
- player-authored claims about what the NPC permits.

The first implementation should use a structured, evidence-bearing decision
with conservative deterministic validation. Do not add another broad keyword
detector. Adversarial and natural-language fixtures are required because the
first consent classifier pass is expected to need refinement.

## Authorship and developer controls

Only the target participant's authoritative side may grant, deny, or withdraw
permission attributed to that target. Player input and player-authored narrator
mode cannot write an NPC permission event. No participant can grant on behalf
of another.

Testing requires a separate authority path. Authorized development/test users
may change permission and relationship values instantly through the developer
menus. Those controls must:

- write structured events or state through a dedicated endpoint;
- require the existing developer/admin authorization and an explicit
  development/test capability gate;
- identify the affected branch, actor, target, scope, value, and operator;
- record an auditable `developer_override` source;
- use the same projection and contact-invalidation path as production events;
- never parse chat content as an override command;
- never expose the override as an ordinary player or narrator capability.

The menu should show direction in plain language, such as “Alex may touch Mara
romantically,” rather than a symmetric checkbox.

## Events and active projection

The permission ledger is event-backed and branch-local. The exact schema may
reuse existing repository conventions, but it must preserve the following
semantics:

```ts
type RomanticPermissionEventKind =
  | "granted"
  | "attempt_denied"
  | "withdrawn"
  | "relationship_revoked"
  | "developer_overridden";

interface RomanticPermissionEvent {
  eventId: string;
  branchId: string;
  permittedActorId: string;
  grantingTargetId: string;
  scope: "romantic_touch";
  kind: RomanticPermissionEventKind;
  sourceKind: "npc_decision" | "relationship_transition" | "developer_override";
  sourceMessageId?: string;
  sourceEventId?: string;
  attemptActionId?: string;
  attemptContactId?: string;
  storyTime: number;
  orderInSource: number;
}
```

The durable event needs idempotency identity and enough provenance to reproduce
the decision. The active projection contains only current standing grants.
Attempt denials remain evidence about an attempt but do not remove a standing
grant unless the same source also proves withdrawal.

A story branch inherits the permission projection at its fork point. Later
events are branch-local. A grant never becomes global character metadata and
never leaks into an unrelated chat, a cloned character, or a sibling branch.

## Relationship-based automatic revocation

Relationship integration is reserved but not implemented by this MVP.

When relationship state eventually emits authoritative transitions, a future
per-scope matrix may define significant downward thresholds. Crossing a
threshold commits a `relationship_revoked` permission event. For example, a
change from `cherished` to `cold` may revoke Alex's grant to touch Mara.

This is one-way:

- relationship decline may revoke a standing grant;
- relationship improvement never creates a grant;
- recovering above the threshold never restores a revoked grant;
- a fresh target-authored grant is required after revocation.

The permission owner consumes a committed relationship transition. It must not
poll a label and silently change policy during contact resolution.

## Chronology and non-retroactivity

Every event has an effective position in committed chronology. Resolution may
use only permission effective before the attempted action.

A grant may authorize a clearly later action in the same committed assistant
reply when evidence offsets establish that order. It never authorizes an action
whose evidence precedes the grant. Ambiguous ordering fails closed.

This rule is separate from rollback. Retake cleanup prevents a discarded
reply's events from surviving; chronological ordering prevents a later event in
a retained reply from authorizing an earlier act.

## Retakes and branches

Permission uses the same rollback boundary as the story state it governs:

- Retaking an assistant reply restores the permission projection from before
  that reply.
- Permission events sourced from the discarded reply are pruned or excluded
  from the restored branch.
- Replaying the same reply is idempotent.
- A new branch receives the projection at the fork point.
- Permission changes after the fork remain local to their branch.
- A discarded denial or withdrawal cannot affect the replacement reply.

The permission event, active projection, contact projection, and narrator cut
must never describe different branch moments.

## Revocation during active contact

A withdrawal or automatic revocation invalidates every active contact that
depends on that directional grant and exact scope. Within the authoritative
settle:

1. commit or order the permission change;
2. end affected contacts with `policy_withdrawn`;
3. persist the permission and contact projections atomically, or through one
   guarded sequence that cannot expose a mixed state;
4. emit a mandatory, narrator-safe action outcome or high-priority transition
   when the prose has not already portrayed the stop.

The narrator instruction should communicate only the observable change needed
to continue naturally. It must not expose relationship thresholds, permission
records, developer overrides, or diagnostic detail. The narrator may portray
stopping, separating, or a natural NPC reaction, but may not keep the old
contact active or author the player's reaction.

A permission change occurs at a turn settlement boundary, not in the middle of
the player's submitted text. If it lands after one narrator reply, the next
reply receives the binding transition.

## Resolver adapter

The permission owner supplies the shared contact core with a result for the
attempt's exact actor, target, scope, branch, and chronological position.

Required behavior:

- current exact grant -> `allowed`;
- explicit denial of the current attempt -> `denied`;
- standing grant withdrawn or relationship-revoked -> `withdrawn`;
- no answer or malformed/unavailable owner -> `unresolved`;
- different direction or different scope -> scope missing, never allowed;
- player-target exception -> the lane's explicit not-required result, without
  manufacturing a player grant.

The contact resolver remains responsible for combining policy with actor
control, target agency, geometry, support, wardrobe, and lifecycle. A permission
grant makes an attempt eligible for resolution; it does not force an NPC to
perform or accept an action and does not make an impossible action possible.

## Required fixtures and tests

Direction and scope:

- player-to-NPC allowed only by that NPC's grant to that player;
- NPC-to-NPC allowed in one direction while the reverse remains unavailable;
- reverse-direction grant cannot authorize the attempt;
- `romantic_touch` cannot authorize kissing, intimate touch, undressing,
  nudity exposure, or sex;
- NPC-to-player uses the explicit player-target exception and never creates a
  player reaction.

Evidence and authorship:

- explicit NPC dialogue and unambiguous direct offer can grant;
- silence, affection, arousal, relationship label, lack of resistance, and
  player-authored narrator prose cannot grant;
- “not now” denies the attempt without withdrawing a standing grant;
- clear “anymore” language withdraws;
- player attempts to author an NPC grant fail;
- chat text resembling a developer command never invokes an override;
- the developer menu can set each direction independently and records an audit
  source.

Chronology and restoration:

- later same-reply grant cannot authorize an earlier action;
- clear grant-before-action ordering may authorize the later action;
- ambiguous ordering fails closed;
- retake removes discarded grant, denial, and withdrawal events;
- branch inherits only pre-fork state and then diverges;
- retry is idempotent.

Revocation and narration:

- withdrawal ends only contacts dependent on that direction and scope;
- relationship revocation uses the same path when that integration ships;
- relationship recovery does not restore the grant;
- permission/contact projections cannot commit a mixed state;
- the next narrator cut receives a mandatory/high-priority stop transition
  when needed;
- narrator output cannot continue invalidated contact or expose policy internals.

## Implementation order

1. Add the event schema, active projection, idempotency, and branch/retake
   restoration.
2. Add the developer-menu controls and audit path so fixtures and live testing
   can set both directions and relationship inputs without chat commands.
3. Add the conservative NPC-side grant/denial/withdrawal decision and evidence
   validator.
4. Adapt exact policy reads into the shared contact resolver.
5. End permission-dependent contacts on withdrawal and wire the mandatory
   narrator handoff.
6. Run adversarial unit/integration tests, then the plan's genuinely romantic
   proof.

Successor parity remains separate. It may be claimed only after the successor
lane enforces the same direction, scope, chronology, revocation, developer
separation, and rollback laws.

## As built (2026-08-04)

Implementation decisions recorded at build time; everything above remains the
requirement set.

- **The chat is the branch.** Character chat has no separate branch entity, so
  `branchId` is `character_chats.id`, and branch-locality is chat-scoped rows
  with cascade FKs. Fork inheritance needs no mechanism in this lane.
- **Ledger, no stored projection.** `chat_permission_events` (migration 0096)
  copies the contact ledger's identity: unique `(chat_id, event_ref, sequence)`
  for idempotency, `guard_message_id` for retake pruning (nullable only for an
  override recorded before any message exists). The active projection is a pure
  fold over the pruned rows (`src/contracts/affordances/permission/`), so
  retake/branch restoration IS the existing prune — pruning is unconditional at
  every site the contact ledger prunes. Event-ref namespaces:
  `permission-reply:<assistantMessageId>` (NPC decisions, guard = the assistant
  row) and `permission-override:<eventId>` (developer overrides, guard = the
  chat's newest message).
- **One atomic entry point.** `appendChatPermissionEventsWithInvalidation`
  commits permission rows, the withdrawal sweep's `policy_withdrawn`
  contact-ended rows, the swept scene, and the operator audit event in one
  transaction; a mixed state cannot commit.
- **Both producers are serialized against the exchange.** The NPC leg inherits
  the per-chat `chat_exchange:<chatId>` lock by running inside the settle tail;
  the developer override *acquires* that lock (bounded wait, then the same
  `chat_busy` 409 it answers when the fast-path probe finds a live stream)
  rather than merely probing it, because a probe leaves a window in which an
  exchange finalizer can rewrite the scene from its own earlier read and
  resurrect the contacts the sweep just ended. Underneath both, the sweep's
  scene write is a compare-and-swap against the raw column value it read — the
  database's own answer for any future producer that forgets the lock. A
  collision refuses the whole call as `stale_scene` (surfaced by the endpoint
  as 409 `scene_conflict`) with nothing committed. The CAS base is the raw
  value, not the parsed state, so a repaired-on-read scene cannot look changed.
- **Player-target exception on the read.** `ContactInteractionPolicyRead` gained
  `notRequiredBasis?: "player_target"` plus `notRequiredTargetId`; the resolver
  accepts `not_required` only when both the basis and named subject match the
  attempted target. A bare or misdirected `not_required` remains `unresolved`.
- **Overrides use the spec's `developer_overridden` kind** with
  `operation: "grant" | "withdraw"` in the typed payload; the endpoint is
  `/api/admin/chat-permissions/:chatId` (owner-admin + ownership + capability
  flag), audited as `romantic_permission_developer_override`.
- **NPC decision is a single-phase settle-tail leg** (one trigger-gated
  classifier call per reply max, assistant text only), with a deterministic
  validator: verbatim evidence grounding with absolute offsets, NPC attribution
  (including the adjacent narration line, so a reply that hands the words back
  to the player — "that was what you had said" — cannot ground a grant),
  conditional/negation/question/restraint vetoes for grants, player-as-target
  and self-grant drops, and dedupe per direction. A `withdrawn` may take back
  either a standing grant or an offer made **earlier in the same reply**: a
  reply that allows the touch and then retracts it must not leave a standing
  grant, so only the withdrawal is emitted (emitting both would end
  not-standing too, but a chronology cutoff falling between the two offsets
  would read the retracted offer as effective). A two-half begin/finish split
  is a noted future optimization.
- **The stop instruction rides the guidance transition tier** (its first
  producer): `policy_withdrawn` endings that no assistant reply has yet
  followed emit one mandatory, idempotently-phrased line each through the
  constraints block. Every pending pair emits — the tier budget was raised from
  1 to 4, the lawful maximum one exchange can produce, because an ensemble
  reply can end contact on several pairs at once and a line dropped inside the
  one-reply window is lost permanently. Past that bound the producer trims and
  files a `warn` (`chat_permission.stop_guidance.over_bound`), cutting the
  degraded generic line before any named pair.
- **Retake semantics of overrides:** an override guarded by the newest
  assistant message is pruned when that reply is regenerated — the rollback
  boundary restores the pre-exchange scenario, which predates the override, so
  keeping its rows would expose exactly the mixed state the transaction rule
  forbids. An operator re-applies the override if it is still wanted.
- **Chronology:** the pure comparator (storyTime, commit order, orderInSource,
  evidence offset; ties are `ambiguous` and fail closed) is exercised by the
  fold's `effectiveBefore` cutoff. A player attempt treats every committed
  ledger event as effective, since all of them precede it.
- **Permission authority is independent of general physical guidance.**
  `CHAT_ROMANTIC_PERMISSION` composes with `CHAT_CONTACT_ACTIONS`, not
  `CHAT_PHYSICAL_CONSTRAINTS`. A pending mandatory stop still goes through the
  one shared guidance compiler and renderer when the general experiment is off;
  a stop read, compile, or render failure aborts the exchange before a reply can
  consume the one-reply delivery window.
- **Retake pruning fails closed across later turns.** Both possible permission
  guards are removed in one idempotent statement with bounded retries. If all
  retries fail, the retake is refused before a replacement reply commits; stale
  permission can therefore never become authoritative on a later turn.
- **Attempt denials are action-local.** The settle leg binds `attempt_denied` to
  the exchange's player contact action and, when it committed, the resulting
  contact. The invalidation sweep re-derives policy against that contact id,
  ending only the denied attempt while the
  standing grant remains available for a later action. A denial with no current
  attempt is dropped rather than stored as dead authority.
- **Transcript edits cannot rewrite NPC agency.** An assistant reply that
  authored an NPC permission event returns 409 from the transcript-only edit and
  delete routes. Regenerate/rerun remains the state-aware rollback path and
  prunes permission and contact rows before replacing the take.
- **Exactness is pinned.** Fixtures prove a one-direction withdrawal leaves an
  unrelated direction and contact active, the player-target basis names the
  actual target, and the stop-row read covers the contact lifecycle maximum.
