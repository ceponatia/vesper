# Romantic contact affordances — directional permission owner

Status: **built and gated; reconciled 2026-08-18.** Character chat has a durable,
directional, exact-scope permission owner for `romantic_touch`, behind
`CHAT_ROMANTIC_PERMISSION`. The separate developer override capability is behind
`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`.

The owner is not yet proven by a genuinely romantic player contact because the
live player contact producer is still deliberately affectionate-only. A narrow
`actionKind: "romantic"` player producer is therefore a prerequisite for the
first permission proof; enabling this flag alone cannot create a romantic
attempt.

Plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Core: [romantic-contact-affordances.spec.contact-core.md](romantic-contact-affordances.spec.contact-core.md)

## Scope

The current owner answers exactly one gated scope:

```text
romantic_touch
```

It does not decide:

- whether an action occurred;
- whether surfaces can reach;
- actor control or target movement;
- attraction, arousal, desire, pleasure, or relationship state;
- kissing, intimate touch, clothing manipulation, nudity exposure, or sex.

Those future interactions require separate exact scopes if/when product design
supports them.

## Direction is part of the key

Permission is directional:

```text
permitted actor -> granting target -> exact scope -> chat/branch
```

A grant from Mara allowing Alex `romantic_touch` toward Mara says nothing about
Mara touching Alex.

Current rules:

- player -> NPC romantic contact requires that target NPC's grant to the player;
- NPC -> NPC requires the target NPC's grant in that direction;
- reverse direction never authorizes;
- another scope never authorizes the requested scope;
- NPC -> player uses the explicit `player_target` not-required basis rather than
  pre-calculating a standing player grant;
- the player still owns their next reaction, movement, acceptance, refusal, and
  reciprocation;
- player-authored narrator text cannot grant permission on behalf of an NPC.

Ordinary incidental/casual/affectionate contact remains permission-neutral under
the existing product ruling. Romantic language must never be downgraded to
`affectionate` merely to bypass this owner.

## Grant, denial, absence, and withdrawal

Keep four states semantically distinct:

- **absent** — no authoritative answer exists;
- **grant** — the target authorizes the named actor for the exact scope;
- **attempt denial** — the target rejects the current attempted action without
  necessarily deleting an existing standing grant;
- **withdrawal** — the target revokes a standing grant.

“Not now” can deny one attempt. “Do not touch me like that anymore” can withdraw
standing permission. Ambiguous language produces no permission change.

A grant or withdrawal may be grounded only in the target NPC's authoritative
assistant-side dialogue/conduct or an explicit developer override. It must not
be inferred from:

- affection/attraction/arousal;
- relationship label/score;
- an intimate-scene signal;
- lack of resistance or silence;
- previous contact by itself;
- narrator tone/genre;
- player-authored claims about what an NPC allows.

## Permission answers attempts; it does not create them

This boundary is now an explicit integration law.

The current player producer in `chat-contact-adapter.ts` creates only:

```ts
actionKind: "affectionate"
```

and its sentence gate rejects romantic/intimate framing. The shared contact core
supports `"romantic"`, and this permission owner can answer it, but character
chat currently has **no producer that constructs such an attempt**.

Therefore:

- do not modify the permission classifier to detect romantic player actions;
- do not make a permission grant itself synthesize a contact attempt;
- do not weaken the affectionate detector's romantic veto;
- do not relabel romantic prose as affectionate when the new romantic producer
  rejects it.

The first proof must add a separate narrow player romantic action producer, then
supply the resulting `actionKind: "romantic"` intent to the existing permission
read + contact resolver.

## First romantic action boundary

The initial producer is intentionally smaller than the long-term romance model.
It should admit only evidence the lane can resolve without inventing another
participant's behavior:

- player is the actor;
- hand is the acting surface;
- non-intimate target loci already supported by the chat contact vocabulary;
- closed, explicitly romantic gesture language such as caress/stroke/cup
  (final vocabulary belongs to the action-producer spec/code);
- no target reposition or voluntary target reaction;
- no kissing;
- no intimate anatomy;
- no clothing manipulation/exposure;
- no restraint/pinning;
- no sexual act.

Ambiguous/mixed framing fails closed. This is an action-evidence rule, not a
permission rule.

## Resolver adapter

The pure permission adapter receives:

- folded current permission projection;
- permitted actor id;
- granting target id;
- attempted `ContactActionKind`;
- player subject id;
- current attempt action/contact ids where relevant.

Required mapping:

- permission-neutral action -> `not_required` without a player-target basis;
- gated action aimed at player -> `not_required` with exact `player_target`
  basis + matching target id;
- explicit current-attempt denial -> `denied`;
- current exact standing grant -> `allowed` with the exact granted scopes;
- exact standing grant withdrawn/revoked -> `withdrawn`;
- no authoritative answer -> `unresolved`;
- reverse direction -> no matching grant;
- different scope -> never widened to the requested scope.

The contact resolver still combines this answer with actor control, target
agency, geometry, support, and material. Permission makes a physically valid
attempt eligible; it never makes an impossible attempt possible.

## Durable event model

Character chat uses `chat_permission_events` (migration 0096) as the durable
ledger. The chat id is the branch boundary for this lane.

Important identities/provenance:

- unique `(chat_id, event_ref, sequence)` for idempotency;
- `guard_message_id` for retake pruning;
- direction: permitted actor + granting target;
- exact scope;
- event kind/source;
- story time + source order/evidence offset;
- attempt action/contact ids for action-local denials.

The active projection is a pure fold over surviving ledger rows rather than a
second persisted summary.

Current event meanings include:

```text
granted
attempt_denied
withdrawn
relationship_revoked      (reserved for future relationship integration)
developer_overridden
```

Developer overrides store an explicit grant/withdraw operation in their typed
payload and remain separately authorized/audited.

## Chronology

Only permission effective before an action may authorize it.

The fold orders by committed chronology (story time, commit order, source order,
evidence offset). An ambiguous tie fails closed.

A grant clearly earlier in one assistant reply may authorize a later action only
when that lane eventually supports both authoritative actions in the same reply
and their evidence order is unambiguous. A later grant never authorizes an
earlier action.

For the first **player -> NPC** romantic proof, the permission event must already
be committed before the player's next attempted action. This keeps the proof
simple and avoids conflating same-reply NPC chronology with the missing player
action seam.

## NPC permission decision leg

`chat-permission-decision.ts` is a conservative assistant-reply classifier leg.

It:

- runs only when `CHAT_ROMANTIC_PERMISSION` is enabled and the cheap trigger
  fires;
- reads only the committed assistant reply plus compact permission digest;
- never reads player text as grant authority;
- performs at most one classifier call per eligible reply;
- parses candidates independently so one malformed item does not erase valid
  siblings;
- requires deterministic evidence grounding/attribution/assertion validation;
- drops self-grants, player-as-granting-target mistakes, ambiguous/conditional/
  negated/question evidence, and other unsupported cases;
- writes accepted events through the one atomic permission/contact invalidation
  entry point;
- degrades to **no new permission event**, never a fabricated grant.

An `attempt_denied` candidate is stored only when it can bind to the current
attempt action id (and contact id when one committed). A denial with no current
attempt is dropped rather than becoming dead standing authority.

## Withdrawal and active contact invalidation

A withdrawal invalidates only active contacts that depend on the matching:

```text
permitted actor -> granting target -> exact scope
```

The authoritative path must commit atomically/guardedly:

1. permission event;
2. affected `policy_withdrawn` contact endings;
3. resulting scene/contact projection;
4. developer audit row where applicable.

`appendChatPermissionEventsWithInvalidation` is the current character-chat entry
point.

A one-direction withdrawal must not end the reverse direction or unrelated
contacts.

## Mandatory stop handoff

A newly withdrawn contact may need one binding narrator transition so prose does
not continue a contact the state owner ended.

That handoff belongs to constraint-first physical guidance, not the optional
visual-state cue path.

Rules:

- expose only the observable stop/separation requirement;
- never expose permission records, relationship thresholds, developer override
  metadata, or diagnostics;
- never author the player's reaction;
- do not make visual-state narration a prerequisite for the stop.

## Developer controls

`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` is deliberately independent of the
runtime permission flag so a controlled fixture may be prepared first.

The current endpoint remains admin/owner gated and audited. Controls must:

- name chat/branch, actor, target, exact scope, and operation;
- record `developer_override` provenance/audit;
- use the same projection/invalidation transaction as production events;
- never be invokable through chat prose;
- serialize against the exchange and fail closed on scene conflict.

The UI should describe direction plainly (for example, “Alex may touch Mara
romantically”), not present a symmetric checkbox.

## Retake and transcript mutation

Permission authority rolls back with the story take it came from.

- retake prunes discarded reply-sourced permission rows;
- retry is idempotent;
- the folded projection after prune is authoritative;
- discarded denial/withdrawal cannot survive into the replacement take;
- transcript-only edits/deletes cannot rewrite a reply that authored permission
  authority; regeneration is the state-aware path;
- pruning failure refuses the retake rather than letting stale permission become
  authoritative.

Developer overrides guarded by the newest assistant reply are intentionally
pruned if that reply is regenerated; the operator reapplies the override if it
is still wanted.

## Relationship integration

Automatic relationship-based revocation remains reserved, not part of the MVP.

If implemented later:

- relationship owner emits an authoritative transition event;
- permission owner may map a downward transition to scope-specific revocation;
- improvement never auto-grants;
- recovery never automatically restores a revoked grant;
- a fresh target-authored grant is required.

The contact resolver never polls a relationship label and derives permission.

## Revised first-proof sequence

1. Build the separate narrow **player romantic action producer** described in
   the plan/contact-core boundary.
2. Unit-test producer evidence without permission side effects.
3. Feed the resulting `actionKind: "romantic"` attempt through the existing
   policy adapter + contact resolver.
4. Prove deterministically:
   - exact grant -> physically valid attempt commits;
   - no grant -> no contact commit;
   - reverse-direction grant -> no commit;
   - wrong scope -> no commit;
   - withdrawn grant -> no commit;
   - action-local denial -> current attempt rejected without deleting an
     unrelated standing grant;
   - withdrawal of a live dependent contact ends it `policy_withdrawn`;
   - affectionate contact remains unchanged/permission-neutral;
   - retake restores permission + contact state.
5. Use the developer override or an earlier NPC-authored grant to seed one
   controlled player -> NPC scenario.
6. Enable `CHAT_ROMANTIC_PERMISSION` for that controlled proof and verify the
   committed contact/action outcome, ledger, scene, retake, and narrator stop
   behavior.
7. Decide rollout for that **specific romantic action surface** only.

This proof does **not** require general NPC scene-decision movement/start/update
authority unless the chosen fixture asks the target NPC to reposition. The NPC
authority shadow review remains a parallel operational gate.

## Future exact scopes

`romantic_touch` never implicitly authorizes future categories. Product design
must define exact directional scopes before supporting, at minimum:

- kissing;
- intimate non-penetrative touch;
- removing/moving another participant's clothing;
- exposing one's own nudity to another participant;
- sexual activity.

Whether any scope implies another is a future explicit product ruling. The
current core performs exact membership and does not invent a hierarchy.

## Required tests

### Direction/scope

- player -> NPC exact grant works only in that direction;
- NPC -> NPC reverse direction remains independent;
- player-target exception names the real player target;
- wrong scope cannot authorize;
- `romantic_touch` cannot authorize kissing/intimate/clothing/nudity/sex.

### Authorship/evidence

- explicit NPC grant/offer can commit when unambiguous;
- silence/affection/arousal/relationship/lack of resistance cannot grant;
- player text cannot author an NPC grant;
- “not now” denial is action-local;
- clear standing withdrawal revokes;
- chat text resembling a developer command cannot trigger override.

### Chronology/rollback

- later grant cannot authorize earlier action;
- ambiguous chronology fails closed;
- retry is idempotent;
- retake removes discarded grant/denial/withdrawal;
- stale permission cannot survive a failed prune;
- transcript edit cannot rewrite an authority-producing assistant reply.

### Invalidation/narration

- withdrawal ends only matching dependent contacts;
- stop handoff is binding even when optional visual-state narration is disabled;
- narrator cannot continue invalidated contact or expose policy internals;
- player reaction remains uncommitted.

### Integration gap regression

- enabling `CHAT_ROMANTIC_PERMISSION` without a romantic action producer does
  **not** cause affectionate input to become romantic;
- romantic-framed input rejected by the affectionate detector does not fall back
  to affectionate contact;
- the future romantic producer emits `actionKind: "romantic"` explicitly.
