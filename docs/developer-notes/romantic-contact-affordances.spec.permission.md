# Romantic contact affordances — directional permission owner

Status: **built and gated; reconciled 2026-08-18.** Character chat has a durable,
directional, exact-scope permission owner for `romantic_touch`, behind
`CHAT_ROMANTIC_PERMISSION`. The separate developer override capability is behind
`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`.

The narrow `actionKind: "romantic"` player producer this owner was waiting on is
now built and its deterministic negative-case suite passes against the real
permission seam, so enabling the flag produces a real permission-gated attempt.
What remains is the controlled live proof and the rollout ruling — owner work,
not code work.

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

The player producer in `chat-contact-adapter.ts` creates two kinds:

```ts
actionKind: "affectionate" | "romantic"
```

The affectionate half is unchanged and its sentence gate still rejects
romantic/intimate framing whole. The romantic half is a separate producer with
its own sentence gate, admitting only a closed caress/stroke/cup family. The act
type names exactly these two kinds rather than the core's full
`ContactActionKind`, so a kind this lane cannot author stays a compile error
instead of becoming a runtime silence.

Therefore:

- do not modify the permission classifier to detect romantic player actions;
- do not make a permission grant itself synthesize a contact attempt;
- do not weaken the affectionate detector's romantic veto;
- do not relabel romantic prose as affectionate when the romantic producer
  rejects it.

**Flag-off behavior — the producer does not run at all.** `detectChatContactAct`
takes `romanticEnabled`, defaulting to **false**, and `planChatContactTurn` sets
it from `input.permissionPolicy !== undefined`. The permission owner's *presence*
is the gate: `chat-pipeline.ts` wires a policy source only under
`chatRomanticPermissionEnabled()`, so that flag reaches a pure module without the
module reading an env var.

The reasoning is not fastidiousness. A turn admits **one** act, so a romantic
sentence that gets produced and then resolves `permission_unresolved` still
consumes the slot — and takes down a later affectionate sentence that would have
committed. A romantic act nobody can authorize is therefore not a quieter
romantic act; it is one this lane must not author. Gating on the owner's presence
is what makes `CHAT_ROMANTIC_PERMISSION=off` **byte-identical to the lane before
this producer existed**, rather than merely silent.

That distinction is verified, not asserted: a differential sweep over 4096
three-clause message permutations found 0 divergences from the affectionate-only
detector with the gate off, and 1443 divergences with it on — the second number
being what proves the harness can detect divergence at all.

When an owner *is* wired, the resolver still fails closed on an unanswered
question: a bare `not_required` on a permission-requiring kind is an owner that
was never consulted, and returns `unresolved` / `permission_unresolved`. The
stub's evidence distinguishes the two silences — `permission_owner_absent` for a
gated kind with no owner wired, `permission_neutral_kind` for a kind that
genuinely needs none.

## First romantic action boundary

The initial producer is intentionally smaller than the long-term romance model.
It should admit only evidence the lane can resolve without inventing another
participant's behavior:

- player is the actor;
- hand is the acting surface;
- non-intimate target loci already supported by the chat contact vocabulary,
  plus `face` under the 2026-08-18 cheek ruling below;
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

Built 2026-08-18 to exactly this boundary, with one owner-ruled extension.

### Owner ruling (2026-08-18) — the romantic lane admits the cheek

`cheek` / `cheeks` resolve to the body registry's existing coarse `face` locus.
No new cheek location was invented, and `cup` gains the canonical target it
previously lacked. The romantic lane reaches **nine** loci; the affectionate lane
still reaches eight and refuses the cheek in every affectionate form.

The binding constraint the owner attached: the shared
`CHAT_CONTACT_ROMANTIC_TARGET_RE` must **not** lose `cheeks?` to achieve this,
because it guards the affectionate detector and the frozen NPC ending floor.
Implemented accordingly:

- `CHAT_ROMANTIC_CONTACT_EXCLUDED_TARGET_RE` — the shared list minus `cheeks?`,
  read only by the romantic gate;
- `chatRomanticTargetLocationEntries` — the shared locus map plus
  cheek/cheeks/face, read only by the romantic producer;
- the shared regex is byte-identical, and `face` appears in neither refusal list
  because it was never romantic framing — only a surface nothing previously
  reached.

### Both halves of the act are allow-lists

The first implementation guarded the locus with an allow-list and the rest of the
sentence with a deny-list. That asymmetry was wrong and adversarial probing broke
it decisively: **75 of 86 probes** defeated the deny-list — `make love`,
`chain you to the bed`, `titty`, `taking off`, `go down on you`, `privates`,
whole families it never named — while the same list over-fired on ordinary prose,
where `unti\w*` matched **until** and `lift`, `tie`, `bound`, `erect`, and `sex`
each killed innocent lines.

**The lesson, which is the durable part:** a deny-list over free-form English
cannot be finished, and every entry that tightens it also refuses something
innocent. Do not respond to a leak by adding a term.

`ROMANTIC_DIRECT_RE` is therefore anchored to the whole sentence: `^`, optional
closed adverb, closed verb family, owner, allow-listed locus, optional closed
trailing adjunct, terminal punctuation, `$`. `I caress your arm and <anything>`
is refused because a trailing clause exists at all — the producer forms no
opinion about its content. `CHAT_ROMANTIC_CONTACT_OUT_OF_SCOPE_RE` was deleted;
do not reintroduce a deny-list in its place.

Verified: all 46 reported leaks closed, and the 5832-permutation differential
still shows 0 divergence from the affectionate detector with the flag off.

**The cost is real and one-directional.** Ordinary romantic prose carrying a
second clause — `"I caress your arm until you smile."` — commits nothing. That is
a refusal where a commit was arguably fine, never a commit where a refusal was
required. Candidate follow-up if the live proof finds it too tight; not a defect.

### Owner ruling (2026-08-18) — leave the affectionate lane's veto gaps alone

The gaps the romantic gate had also exist in the shared lists the affectionate
lane reads. They stay, for this slice.

`contactSentenceEligible` is shared with the frozen NPC ending detector, which
calls it **before** recognizing withdrawals and separations. Adding refusal terms
there makes legitimate endings disappear — a contact left alive past the sentence
that released it. That is an unrelated behavioral change, in the unsafe
direction, and it conflicts with the standing instruction not to broaden or
weaken the affectionate detector while adding the romantic producer.

**Stated future direction.** Do not perpetuate this coupling forever, and do not
casually fix it here either. If the affectionate list is later found genuinely
incomplete, first **split the three concepts**:

1. frozen NPC-ending eligibility — pinned behavior-equivalent to today;
2. affectionate-action eligibility;
3. romantic-action eligibility.

Then harden the affectionate list without suppressing endings. A repair attempted
before that split will trade a detection gap for an ending bug.

Both rulings above resolve open questions the plan previously carried; the plan
no longer lists them.

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
   the plan/contact-core boundary. Status: built 2026-08-18.
2. Unit-test producer evidence without permission side effects.
   Status: built 2026-08-18 — admitted evidence, the refusal table, ambiguous
   pronouns, span handling, the never-degrade law, and written-order
   arbitration across the two kinds.
3. Feed the resulting `actionKind: "romantic"` attempt through the existing
   policy adapter + contact resolver. Status: built 2026-08-18 with step 1 —
   `planChatContactTurn` runs the one player producer, and the pipeline's
   permission read already keys off the attempt's kind.
4. Prove deterministically the cases below.
   Status: built 2026-08-18 — proven through the **real** seam rather than a
   stubbed policy read: real permission events, the real projection fold, and
   the real `derivePermissionPolicyRead`, assembled exactly as `chat-pipeline.ts`
   assembles them. One exception: retake restoration is covered by
   `chat-permission.int.test.ts`, not by these pure tests.
   - exact grant -> physically valid attempt commits;
   - no grant -> no contact commit;
   - reverse-direction grant -> no commit;
   - wrong scope -> no commit;
   - withdrawn grant -> no commit;
   - action-local denial -> current attempt rejected without deleting an
     unrelated standing grant;
   - withdrawal of a live dependent contact ends it `policy_withdrawn`;
   - affectionate contact remains unchanged/permission-neutral;
   - a granted touch that cannot physically reach still does not commit;
   - retake restores permission + contact state.
5. Use the developer override or an earlier NPC-authored grant to seed one
   controlled player -> NPC scenario. Status: next — owner-gated setup.
6. Enable `CHAT_ROMANTIC_PERMISSION` for that controlled proof and verify the
   committed contact/action outcome, ledger, scene, retake, and narrator stop
   behavior. Status: queued behind step 5; no code work is outstanding for it.
7. Decide rollout for that **specific romantic action surface** only.
   Status: owner decision, queued behind step 6.

This proof does **not** require general NPC scene-decision movement/start/update
authority unless the chosen fixture asks the target NPC to reposition. The NPC
authority shadow review remains a parallel operational gate.

### Expect this on the first flag-on turn

With the flag **on** and no grant yet, a romantic sentence takes the turn's
single act slot and resolves `permission_unresolved`. A later affectionate
sentence in the same message therefore does not commit.

That is correct under the lane's two standing laws — one act per turn, first
eligible sentence wins — and it is the same slot arithmetic that made gating the
producer on the owner's presence necessary in the first place. But it means the
first thing the operator sees on enabling the flag may look like contact
breaking. Expect it; do not debug it. It resolves the moment a grant exists, and
it does not occur at all with the flag off, where the romantic producer never
runs.

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

These still apply, now against a live producer rather than a missing one:

- enabling `CHAT_ROMANTIC_PERMISSION` does **not** cause affectionate input to
  become romantic, and an ordinary affectionate message behaves identically
  before and after the romantic producer existed;
- romantic-framed input the romantic producer rejects does not fall back to
  affectionate contact;
- the romantic producer emits `actionKind: "romantic"` explicitly;
- with no permission owner wired the romantic producer does not run at all, so
  the lane is byte-identical to its pre-producer behavior — in particular a
  romantic sentence cannot consume the turn's single act slot and suppress a
  later affectionate sentence that would have committed;
- a romantic sentence later in a message never outranks an eligible
  affectionate sentence earlier in it — one scan, written order.
