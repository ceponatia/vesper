# Romantic contact affordances — directional permission owner

Status: **built and gated; reconciled through the 2026-08-22 owner rulings.**
Character chat has a durable, directional, exact-scope permission owner for the
currently implemented `romantic_touch` scope behind `CHAT_ROMANTIC_PERMISSION`.
The separate developer override capability is behind
`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`.

The narrow player-authored `actionKind: "romantic"` producer is built, its
negative-case suite exercises the real permission seam, and the controlled live
proof passed on 2026-08-18. Both proof flags were reverted afterwards. The two
findings from that proof are closed in code but have not yet been observed live;
the owner-run fixed-lane rerun is the remaining rollout gate. Owner ruling
(2026-08-22): the narrow romantic surface stays test-only until that rerun
passes, and ships if it does.

**Plan:** [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)  
**Technical component:** `character-chat directional permission ledger + policy adapter`  
**Primary owner:** `permission`, not contact, relationship state, or the narrator  
**Primary integration:** `player romantic action -> permission policy read -> shared contact resolver`, plus the assistant-reply permission decision leg  
**Model/dependency:** the permission classifier uses Vesper's existing agent-model route; model output is only a proposal and never permission authority by itself  
**Core dependency:** [shared contact core](romantic-contact-affordances.spec.contact-core.md)

---

## 1. Purpose and ownership boundary

This owner answers one question: **did this target authorize this actor for this
exact permission scope, in this direction, at this point in the story?**

Permission does not decide:

- whether an action occurred;
- whether the actor controls the body attempting it;
- whether the target must move;
- whether the surfaces can reach;
- whether clothing/material permits the requested path;
- attraction, arousal, desire, pleasure, relationship state, or emotional
  reaction;
- how the narrator writes the moment.

Those are separate owners. Permission makes a physically valid attempt eligible;
it never makes an impossible attempt possible, creates an action, or manufactures
another participant's behavior.

Current delivery state:

| Responsibility | State |
| --- | --- |
| Durable directional ledger | Built and live when the flag is enabled |
| `romantic_touch` policy adapter | Built |
| Player romantic action producer | Built and proven live 2026-08-18 |
| Assistant-reply permission decision leg | Built and proven in the first live proof |
| Withdrawal -> dependent-contact invalidation | Built and proven in the first live proof |
| Mandatory narrator stop handoff after withdrawal | Built and proven in the first live proof |
| Neutral guidance for unanswered permission | Built 2026-08-18; not yet observed live |
| Fixed-lane rerun | Next, owner-run |
| Narrow romantic rollout | Test-only until rerun passes; ships if it does |
| Future permission scopes | Product law settled 2026-08-22; action families not built |
| Relationship-triggered revocation | No current band transition revokes; future explicit semantic events only |

---

## 2. Direction and exact scope are part of the key

Permission is directional:

```text
permitted actor -> granting target -> exact scope -> chat/branch
```

A grant from Mara allowing Alex `romantic_touch` toward Mara says nothing about
Mara touching Alex.

Current rules:

- player -> character romantic contact requires that target character's grant to
  the player;
- character -> character requires the receiving character's grant in that
  direction;
- reverse direction never authorizes;
- another scope never authorizes the requested scope;
- character -> player uses the explicit `player_target` `not_required` basis
  rather than pre-calculating a standing player grant;
- the player still owns their next reaction, movement, acceptance, refusal, and
  reciprocation;
- player-authored prose cannot grant permission on behalf of a character.

Ordinary incidental/casual/affectionate contact remains permission-neutral under
the existing product ruling. Romantic language must never be downgraded to
`affectionate` merely to bypass this owner.

The only implemented gated scope today is:

```text
romantic_touch
```

It does **not** authorize kissing, intimate touch, clothing manipulation, nudity
exposure, or sexual activity.

---

## 3. Grant, denial, absence, and withdrawal stay distinct

The ledger keeps four meanings separate:

- **absent** — no authoritative answer exists;
- **grant** — the target authorizes the named actor for the exact scope;
- **attempt denial** — the target rejects the current attempted action without
  necessarily deleting an existing standing grant;
- **withdrawal** — the target revokes a standing grant.

“Not now” can deny one attempt. “Do not touch me like that anymore” can withdraw
a standing permission. Ambiguous language produces no permission change.

A grant, denial, or withdrawal may be grounded only in the target character's
authoritative assistant-side dialogue/conduct or an explicit developer override.
It must not be inferred from:

- affection, attraction, or arousal;
- relationship label, band, or score;
- an intimate-scene signal;
- lack of resistance or silence;
- previous contact by itself;
- narrator tone or genre;
- player-authored claims about what a character allows.

Unknown is not denial, and denial is not withdrawal. Those distinctions remain
visible all the way through resolver behavior, persistence, rollback, and
narrator guidance.

---

## 4. Permission answers attempts; it never creates them

The player producer in `chat-contact-adapter.ts` currently creates only:

```ts
actionKind: "affectionate" | "romantic"
```

The affectionate half is unchanged and still rejects romantic/intimate framing
as a whole. The romantic half is a separate producer admitting only a closed
caress/stroke/cup family. The act type names only kinds this lane can actually
author rather than the contact core's entire `ContactActionKind`; a kind with no
producer stays a compile-time omission rather than turning into runtime silence.

Therefore:

- do not modify the permission classifier to detect player romantic actions;
- do not let a permission grant synthesize a contact attempt;
- do not weaken the affectionate detector's romantic veto;
- do not relabel rejected romantic prose as affectionate contact.

### Flag-off identity

`detectChatContactAct` receives `romanticEnabled`, defaulting to false, and
`planChatContactTurn` derives it from the presence of a permission policy source.
`chat-pipeline.ts` wires that source only under
`chatRomanticPermissionEnabled()`.

This is required because the lane admits **one** act per turn. A romantic
sentence produced while nobody can answer its permission question would consume
the act slot and suppress a later affectionate sentence that would otherwise
commit. With the permission owner absent, the romantic producer therefore does
not run at all.

That identity is measured rather than assumed: the original 4096-case
three-clause differential found zero divergences from the affectionate-only
lane with the gate off and 1443 with it on. After the allow-list repair, the
5832-permutation differential still reports zero gate-off divergences.

When an owner *is* wired, an unanswered permission question remains
`unresolved` / `permission_unresolved`. The evidence distinguishes
`permission_owner_absent` from a truly permission-neutral kind.

---

## 5. Narrow romantic action boundary

The first romantic producer is intentionally smaller than the eventual romance
model. It admits only evidence the lane can resolve without inventing another
participant's behavior:

- player is the actor;
- hand is the acting surface;
- non-intimate target loci already supported by the contact vocabulary, plus
  `face` under the cheek ruling below;
- closed caress/stroke/cup gesture language;
- no target reposition or voluntary target reaction;
- no kissing;
- no intimate anatomy;
- no clothing manipulation/exposure;
- no restraint/pinning;
- no sexual act.

Ambiguous or mixed framing fails closed. This is an action-evidence rule, not a
permission rule.

### Owner ruling (2026-08-18) — cheek maps to the existing face locus

`cheek` / `cheeks` resolve to the body registry's existing coarse `face` locus.
No cheek-specific body location was invented, and `cup` gains the natural target
it previously lacked. The romantic lane reaches nine loci; the affectionate lane
still reaches eight and refuses the cheek in every affectionate form.

The shared `CHAT_CONTACT_ROMANTIC_TARGET_RE` remains byte-identical because it
also guards the affectionate detector and the frozen character-authored ending
floor. The carve-out is romantic-only:

- `CHAT_ROMANTIC_CONTACT_EXCLUDED_TARGET_RE` — shared list minus `cheeks?`, read
  only by the romantic gate;
- `chatRomanticTargetLocationEntries` — shared locus map plus
  cheek/cheeks/face, read only by the romantic producer;
- `face` appears in neither refusal list because it was never itself romantic
  framing; it was merely an otherwise unreachable surface.

### Both halves of the producer are allow-lists

The first implementation allow-listed the locus but deny-listed everything else.
Adversarial probing showed why that shape cannot be made safe: **75 of 86 probes**
defeated the deny-list (`make love`, `chain you to the bed`, `titty`, `taking
off`, `go down on you`, `privates`, and whole unnamed families), while the same
list rejected harmless prose — notably `unti\w*` matching `until`, plus innocent
uses of `lift`, `tie`, `bound`, `erect`, and `sex`.

Durable rule: **never repair this class of leak by adding another forbidden
word.**

`ROMANTIC_DIRECT_RE` therefore anchors the entire sentence: start, optional
closed adverb, closed verb family, owner, allow-listed locus, optional closed
trailing adjunct, terminal punctuation, end. `I caress your arm and <anything>`
is rejected because a trailing clause exists at all; the producer does not need
to classify what that clause means. `CHAT_ROMANTIC_CONTACT_OUT_OF_SCOPE_RE` was
deleted and must not return as another deny-list.

All 46 reported leaks closed under that design, and the gate-off differential
remained identical.

The cost is deliberately one-directional: ordinary romantic prose such as
`"I caress your arm until you smile."` commits nothing even though it might have
been safe. That is acceptable silence, never an unauthorized commit. If the
fixed-lane rerun shows that strictness is too costly to ordinary writing,
loosening the recognized positive grammar is a follow-up; adding forbidden words
is not.

### Owner ruling (2026-08-18) — do not casually harden the affectionate veto

The shared `contactSentenceEligible` path also feeds the frozen character-authored
ending detector. Adding refusal terms there can make legitimate releases or
separations disappear, leaving a contact live after prose ended it.

If the affectionate list later proves genuinely incomplete, split these concepts
first:

1. frozen character-ending eligibility — behavior-equivalent to today;
2. affectionate-action eligibility;
3. romantic-action eligibility.

Only after that split may the affectionate gate be hardened independently.

---

## 6. Resolver adapter

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
  basis and matching target id;
- explicit current-attempt denial -> `denied`;
- current exact standing grant -> `allowed` with the exact granted scopes;
- exact standing grant withdrawn/revoked -> `withdrawn`;
- no authoritative answer -> `unresolved`;
- reverse direction -> no matching grant;
- different scope -> never widened to the requested scope.

The contact resolver combines this answer with actor control, target agency,
geometry, support, and material. Permission can never substitute for those reads.

---

## 7. Durable event model and chronology

Character chat uses `chat_permission_events` (migration 0096) as the durable
ledger. The chat id is the branch boundary for this lane.

Important identity/provenance:

- unique `(chat_id, event_ref, sequence)` for idempotency;
- `guard_message_id` for retake pruning;
- direction: permitted actor + granting target;
- exact scope;
- event kind/source;
- story time + source order/evidence offset;
- attempt action/contact ids for action-local denials.

The active projection is a pure fold over surviving ledger rows; there is no
second persisted summary.

Current event meanings include:

```text
granted
attempt_denied
withdrawn
relationship_revoked      (reserved for future explicit relationship integration)
developer_overridden
```

Developer overrides store an explicit grant/withdraw operation in their typed
payload and remain separately authorized/audited.

### Chronology law

Only permission effective **before** an action may authorize it.

The fold orders by committed chronology: story time, commit order, source order,
then evidence offset. An ambiguous tie fails closed.

A grant clearly earlier in one assistant reply may authorize a later action only
if a future lane supports both authoritative actions in that same reply and the
evidence order is unambiguous. A later grant never authorizes an earlier action.

For the first player -> character romantic proof, the permission event must
already have committed before the player's next attempted action.

---

## 8. Assistant-reply permission decision leg

`chat-permission-decision.ts` is a conservative classifier over a **committed
assistant reply**. It uses Vesper's existing agent-model route, not the narrator
model selected for the chat. The classifier output is a proposal; deterministic
validation and the permission owner's guarded transaction decide what, if
anything, becomes authority.

The leg:

- runs only when `CHAT_ROMANTIC_PERMISSION` is enabled and its cheap trigger
  fires;
- reads only the committed assistant reply plus a compact permission digest;
- structurally excludes player text as grant authority;
- performs at most one classifier call per eligible reply;
- parses candidates independently so one malformed item does not erase valid
  siblings;
- requires deterministic evidence grounding, attribution, and assertion
  validation;
- drops self-grants, player-as-granting-target mistakes,
  ambiguous/conditional/negated/question evidence, and unsupported cases;
- writes accepted events only through the single atomic permission/contact
  invalidation entry point;
- degrades to **no new permission event**, never a fabricated grant.

An `attempt_denied` candidate is persisted only when it can bind to the current
attempt action id, and contact id when one committed. A denial with no current
attempt is dropped rather than becoming dead standing authority.

---

## 9. Withdrawal, invalidation, and mandatory narrator handoff

A withdrawal invalidates only active contacts that depend on the matching:

```text
permitted actor -> granting target -> exact scope
```

The authoritative path commits atomically/guardedly:

1. permission event;
2. affected `policy_withdrawn` contact endings;
3. resulting scene/contact projection;
4. developer audit row where applicable.

`appendChatPermissionEventsWithInvalidation` is the character-chat entry point.
A one-direction withdrawal must not end reverse-direction or unrelated contacts.

A newly invalidated contact may need one binding narrator transition so prose
does not continue contact the state owner ended. That handoff belongs to
constraint-first physical guidance, not optional visual-state narration.

The handoff may:

- expose only the observable stop/separation requirement;
- never expose permission records, relationship thresholds, developer override
  metadata, or diagnostics;
- never author the player's reaction;
- never depend on visual-state narration being enabled.

---

## 10. Unanswered permission and narrator guidance

Status: **built 2026-08-18; not yet observed live.**

The first live proof exposed a state/prose split: with no grant on record the
resolver correctly returned `unresolved` / `permission_unresolved` and committed
nothing, but the narrator received no corresponding premise line and described
the caress as landing.

`permission_unresolved` now earns a typed unresolved-premise line through
`chatContactUnresolvedPremise`, beside `geometry_unavailable`. The underlying
attempt stays unresolved: no permission row, contact fold, or acknowledgment is
invented.

The wording must preserve both sides of the distinction:

| Must | Must not |
| --- | --- |
| foreclose depicting the touch landing | assert that a refusal happened |
| leave refusing open as the character's choice | name permission, consent, or a ledger |
| state only the unresolved gap | claim distance, motive, or a decision not owned |

**“Do not assert a refusal” is not “do not depict one.”** The character may
refuse in the generated reply; that assistant-side refusal is precisely what the
permission decision leg can ground as an `attempt_denied` event. A prompt that
forbade depicting refusal would make that denial path practically unreachable.

Owner ruling (2026-08-18): an unanswered attempt does not have to remain
narratively undecided. The reply may author a denial, which the decision leg then
records. What it may not do is depict the touch as completed when nothing
committed it.

An explicit `attempt_denied` continues to use the existing blocking rejection
guidance.

### Expected first flag-on behavior

With the flag on and no grant yet, an eligible romantic sentence occupies the
turn's single act slot and resolves `permission_unresolved`. A later affectionate
sentence in that same player message therefore does not commit. This follows the
existing one-act/written-order laws and is not a regression. With the flag off,
the romantic producer never runs and this slot interaction cannot occur.

---

## 11. Developer controls

`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` is deliberately independent of the
runtime permission flag so a controlled fixture may be prepared before enabling
the production lane.

The endpoint remains admin/owner gated and audited. A control must:

- name chat/branch, actor, target, exact scope, and operation;
- record `developer_override` provenance/audit;
- use the same projection/invalidation transaction as production events;
- never be invokable through chat prose;
- serialize against the exchange and fail closed on scene conflict.

The UI describes direction plainly — for example, “Alex may touch Mara
romantically” — rather than offering a symmetric checkbox.

---

## 12. Retake and transcript mutation

Permission authority rolls back with the story take that authored it.

- retake prunes discarded reply-sourced permission rows;
- retry is idempotent;
- the folded projection after pruning is authoritative;
- discarded denial/withdrawal cannot survive into the replacement take;
- transcript-only edits/deletes cannot rewrite an assistant reply that authored
  permission authority; regeneration is the state-aware path;
- pruning failure refuses the retake rather than allowing stale permission to
  survive.

Developer overrides guarded by the newest assistant reply are intentionally
pruned if that reply is regenerated; the operator reapplies the override if it
is still desired.

---

## 13. Future exact scopes — owner ruling 2026-08-22

`romantic_touch` never implicitly authorizes future categories.

Scopes remain **exact, directional, and non-inheriting**:

- initial planned vocabulary beyond `romantic_touch` is `kiss`,
  `intimate_touch`, `clothing_manipulation`, and `nudity_exposure`;
- a scope lands only with the supported action family that needs it, never ahead
  of the producer/owner path;
- there is no generic `sexual_activity` grant;
- later sexual action families receive their own exact scopes when those action
  families actually exist;
- no scope implies another;
- an action may require multiple exact scopes, and every required scope must be
  satisfied;
- conjunction of exact scopes replaces inheritance/hierarchy;
- self-directed clothing removal or exposure is the actor's own authority, not
  automatically another participant's contact permission.

Example of the intended composition: an action that manipulates another
participant's clothing *and* exposes intimate anatomy may require both
`clothing_manipulation` and `nudity_exposure`; a later touch of that exposed
intimate locus separately requires `intimate_touch`. Do not create a compound
scope merely to encode that sequence.

These are product/contract rulings. Only `romantic_touch` is implemented today.

---

## 14. Relationship integration — owner ruling 2026-08-22

No current familiarity or regard-band transition automatically revokes
permission. A relationship score/band is not a backdoor permission decision in
either direction.

Future relationship-triggered revocation is reserved for an **explicit semantic
relationship event** strong enough to carry that meaning, such as an
authoritative breakup or no-contact transition. If such an owner/event model is
introduced later, permission may map that event through a scope-specific
revocation matrix.

Binding laws remain:

- ordinary familiarity/regard movement never auto-revokes;
- relationship improvement never auto-grants;
- recovery never restores a revoked grant;
- a fresh target-authored grant is required after revocation;
- the contact resolver never polls a relationship label/band and derives
  permission.

The existing `relationship_revoked` permission event kind remains reserved for
that future explicit integration; its existence does not mean current
relationship dynamics emit it.

---

## 15. Failure and degradation behavior

Permission fails closed without converting missing information into a decision:

- missing owner for a gated action -> unresolved/no commit;
- no matching exact grant -> unresolved/no commit unless an explicit denial or
  withdrawal applies;
- malformed/ambiguous classifier output -> no new permission event;
- provider timeout/error in the permission decision leg -> no new permission
  event and a diagnostic, never a guessed grant or denial;
- reverse-direction or wrong-scope grant -> does not authorize;
- stale committed assistant bytes -> no permission event from those bytes;
- failed permission/contact invalidation transaction -> no partial authority;
- failed retake prune -> refuse the retake rather than preserve stale authority.

An explicit character-authored denial is an authoritative answer, not a system
failure. An unanswered permission owner is different: its narrator guidance must
neither depict the touch landing nor invent a refusal.

---

## 16. Proof, rerun, and rollout

The 2026-08-18 controlled proof established, live:

- no grant -> no contact commit;
- permission did not override impossible geometry;
- exact grant + physical reach -> contact committed;
- withdrawal ended a dependent live contact;
- regenerate left no duplicate contact;
- the permission gate, withdrawal sweep, and stop handoff all executed in
  production for the first time.

Evidence:
[romantic-contact-affordances.trial.romantic-proof.evidence.md](romantic-contact-affordances.trial.romantic-proof.evidence.md).

That proof also exposed the unresolved-guidance and multi-word-name gaps. Both are
closed in code, so the original proof is no longer the rollout input.

The next gate is the plan's item-10 fixed-lane rerun. It preserves, per case, the
sanitized input, actual reply, narrator guidance, and contact state before setup,
after setup, and after the exchange; each case is graded against both world state
and prose consistency.

Owner ruling (2026-08-22): **test-only until the fixed-lane rerun passes; ship
this specific caress/stroke/cup surface if it passes.** This decision does not
wait on character movement authority, kissing, intimate touch, body effects, or
the sensory architecture, and it authorizes none of those adjacent surfaces.

The proof/rerun does not require general character movement/start/update
authority unless a chosen fixture requires the target to reposition voluntarily.

---

## 17. Required tests

### Direction and scope

- player -> character exact grant works only in that direction;
- character -> character reverse direction remains independent;
- player-target exception names the real player target;
- wrong scope cannot authorize;
- `romantic_touch` cannot authorize kissing, intimate touch, clothing
  manipulation, nudity exposure, or sexual activity;
- future multi-scope actions require every exact scope, never a widened parent.

### Authorship and evidence

- explicit character grant/offer can commit when unambiguous;
- silence, affection, arousal, relationship state, or lack of resistance cannot
  grant;
- player text cannot author a character grant;
- “not now” denial is action-local;
- clear standing withdrawal revokes;
- chat text resembling a developer command cannot trigger override.

### Chronology and rollback

- later grant cannot authorize earlier action;
- ambiguous chronology fails closed;
- retry is idempotent;
- retake removes discarded grant/denial/withdrawal;
- stale permission cannot survive a failed prune;
- transcript edit cannot rewrite an authority-producing assistant reply.

### Invalidation and narration

- withdrawal ends only matching dependent contacts;
- stop handoff is binding even when optional visual-state narration is disabled;
- narrator cannot continue invalidated contact or expose policy internals;
- unanswered permission guidance prevents a false landing without fabricating a
  refusal;
- the character remains free to author a denial in the reply;
- player reaction remains uncommitted.

### Producer/integration regression

- exact grant -> physically valid romantic attempt commits;
- no grant -> no contact commit;
- reverse-direction grant -> no commit;
- wrong scope -> no commit;
- withdrawn grant -> no commit;
- action-local denial rejects the current attempt without deleting an unrelated
  standing grant;
- withdrawal of a live dependent contact ends it `policy_withdrawn`;
- granted but physically unreachable touch still does not commit;
- affectionate contact remains permission-neutral and unchanged;
- ambiguous romantic evidence creates no action;
- romantic-framed input rejected by the romantic producer never falls back to
  affectionate contact;
- the producer emits `actionKind: "romantic"` explicitly;
- with no permission owner wired, the romantic producer does not run and the
  lane remains byte-identical to its pre-producer behavior;
- written order still wins: a later romantic sentence cannot outrank an earlier
  eligible affectionate sentence;
- retake restores permission and contact state through the integration layer.

---

## 18. Non-goals and remaining implementation work

This permission spec does not itself implement:

- kissing;
- intimate touch;
- clothing manipulation;
- nudity exposure;
- sexual action families;
- character-initiated romantic action authority;
- automatic relationship-driven permission changes;
- physical reach, wardrobe access, physiology, or sensory presentation.

The 2026-08-22 product questions on future scope shape and ordinary
relationship-band revocation are **closed** by §§13–14. Implementation remains
future work and must arrive with the corresponding action/state owners rather
than expanding `romantic_touch` into a catch-all permission.