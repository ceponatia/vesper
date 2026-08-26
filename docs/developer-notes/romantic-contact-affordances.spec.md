# Romantic contact affordances — technical index

Status: **current implementation map, reconciled to `main` on 2026-08-26; owner
rulings folded through 2026-08-26.**
This document is the short technical entry point. Domain-specific laws live in
the companion specs; historical build detail remains in git history and the
audit/trial records rather than being repeated here.

Plain-English plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Companions:

- [shared contact core](romantic-contact-affordances.spec.contact-core.md)
- [scene/body relations](romantic-contact-affordances.spec.scene.md)
- [NPC actor control](romantic-contact-affordances.spec.actor-control.md)
- [directional permission](romantic-contact-affordances.spec.permission.md)
- [observations/effects/presentation routing](romantic-contact-affordances.spec.effects.md)
- [foot domain](romantic-contact-affordances.spec.foot.md)
- [intimate domain](romantic-contact-affordances.spec.intimate.md)

## Canonical current boundaries

The contact feature is no longer one monolithic affordance pipeline. Current
ownership is intentionally split:

```text
authored action evidence
        |
        v
actor / target authority + permission
        |
        v
scene geometry + support + wardrobe/material
        |
        v
contact resolution
        |
        v
contact lifecycle commit + durable ledger
        |
        +--------------------+---------------------+
        |                    |                     |
        v                    v                     v
binding action outcome   visual-state read     effect proposal
(narrator guidance)      (visual only)         (owner transaction)
```

Contact owns the physical interaction. It does **not** own visual attention,
visual memory, narrator repetition, garment state, body residue, or permission.

## Capability matrix — true as of 2026-08-26

| Capability                               | Character chat                  | Successor                | Notes                                                       |
| ---------------------------------------- | ------------------------------- | ------------------------ | ----------------------------------------------------------- |
| Scene participants/control               | Built                           | Engine-owned equivalent  | Chat scene seeds player/NPC control explicitly.             |
| Proximity/facing/reach                   | Built                           | Engine-owned equivalent  | Chat relations require continuous co-presence.              |
| Posture/support                          | Built coarse read               | Richer engine state      | No general fine-pose solver.                                |
| Player approach/depart                   | Built                           | Engine command path      | Player lane only authors the player's body.                 |
| Player affectionate hand contact         | Built/live lane                 | Not this adapter         | Deterministic allow-list; romantic framing vetoed.          |
| Player romantic contact                  | Proven live 2026-08-18, gated   | Not claimed              | Caress/stroke/cup family, nine loci; rerun decides rollout. |
| Contact lifecycle                        | Built                           | No parity claim          | Active-contact projection + start/update/end commits.       |
| Contact persistence/retake               | Built                           | Engine-specific          | Character chat uses `chat_contact_events`.                  |
| NPC deterministic contact endings        | Built                           | Engine-specific          | Frozen live floor.                                          |
| NPC movement/start/update decisions      | Built, authority gated          | N/A                      | Shadow window open since 2026-08-10; no reviewed corpus.    |
| Directional `romantic_touch` owner       | Built, gated                    | No parity claim          | Exact direction/scope; withdrawal ends dependent contacts.  |
| Body-surface wetness                     | Built owner/read                | Lane-specific            | Whole-body wetness, not hair only.                          |
| Body contact marks                       | Built, gated                    | Not relied on            | Pressure marks; commit leg behind `CHAT_CONTACT_EFFECTS`.   |
| Body-surface deposits/residue            | Built, ungated                  | Not relied on            | Merged 2026-08-25; no live exchange has run it.             |
| Surface products on skin                 | Owner ruled, unbuilt            | Not relied on            | The one undelivered part of the 2026-08-22 ruling.          |
| Conserved surface transfer               | Built, fixture-only             | Not relied on            | No lane resolves a source read or a layer path.             |
| Scratch/skin damage                      | **No owner**                    | **No owner**             | Not a mark kind; a stored scratch quarantines.              |
| Contact effect transactions              | Built, none live                | Not built                | Mark gated off; nothing proposes a transfer.                |
| Visual contact body language             | Built                           | Adapter can read scene   | Hand occupation + committed contact motion.                 |
| Full visual contact relation             | Built 2026-08-22                | No parity claim          | `body_language.contact_relation`; not offered to images.    |
| Visual visibility/attention/memory       | Built in visual state           | Lane-neutral contracts   | Per-subject visibility; narrator projection exists.         |
| Positive visual-state narration          | Per-chat, off by default        | Consumer-specific        | Not a contact flag.                                         |
| Tactile/olfactory/gustatory presentation | **Missing shared owner**        | **Missing shared owner** | Sibling owners ruled 2026-08-22; never contact-local.       |
| Foot mechanics                           | Built pure domain, unregistered | Unwired                  | Register only after its required owners/routes exist.       |
| Intimate mechanics                       | Not built                       | Not built                | Requires future exact scopes + state/perception owners.     |

## Flags

### Code switches

- `CHAT_CONTACT_ACTIONS=on`
  - enables the character-chat contact lane;
  - default off in code.
- `CHAT_NPC_SCENE_DECISION_SHADOW=on`
  - classifier + durable envelope, no new authority;
  - default off in code.
- `CHAT_NPC_SCENE_DECISIONS=on`
  - enables reviewed NPC scene authority;
  - effective only with contact actions;
  - default off.
- `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS`
  - comma-separated `movement,start,update`;
  - unset/blank deliberately means `movement` only.
- `CHAT_ROMANTIC_PERMISSION=on`
  - folds/uses directional permission and runs the NPC permission decision leg;
  - effective only with contact actions;
  - default off.
- `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE=on`
  - separate admin/test capability.
- `CHAT_CONTACT_EFFECTS=on`
  - enables the pressure-mark commit leg only;
  - effective only with contact actions;
  - default off.

Visual-state narrator output is controlled by visual state's **per-chat** switch,
not by a contact environment flag.

### Deliberately unswitched paths

Two effect paths have no flag at all, and each omission is a ruling:

- **body-surface deposits/residue** — ungated by owner ruling 2026-08-25:
  material on skin is ordinary body state like wetness, and gating it would make
  it unrememberable for continuity work unrelated to contact. It therefore
  activates for every chat on the next deploy;
- **conserved surface transfer** — needs no switch because no chat-lane producer
  resolves a source material read or an owner-addressable layer path, so nothing
  outside fixtures can propose one.

### Last documented deployment observation

The plan family last verified production flags on 2026-08-10:

- contact actions: on;
- physical constraints: on;
- NPC scene decision shadow: on;
- NPC scene decision authority: off;
- romantic permission: off.

The 2026-08-18 romantic proof turned romantic permission on for a controlled
window and reverted it afterwards, so that list remains the standing picture.
Contact effects have never been enabled in any environment.

That is dated deployment evidence, not a guarantee about the current environment.
The codebase itself cannot prove whether the shadow review has since been
completed outside the repository, and no deployed exchange has yet exercised the
ungated deposits path.

## Shared contact contracts

Executable owner:

```text
apps/web/src/contracts/affordances/contact/
```

Key types/laws:

- `ContactActionIntent` — proposed physical act;
- `ContactActionContext` — authority/geometry/support/material/policy reads;
- `ContactResolution` — `committable`, `explicit_transition_required`,
  `rejected`, or `unresolved`;
- `CommittedContactRead` — active physical truth after commit;
- `ContactEffectProposal` — a requested owner mutation, never truth itself;
- lifecycle start/update/end commits — durable state changes;
- exact action-kind -> permission-scope mapping;
- target-agency decisions distinct from actor control;
- material-between and channel transmission distinct from direct access.

A rejected or unresolved attempt never enters a current observation frame.

## Character-chat lane map

Primary implementation paths:

```text
apps/web/src/server/engine/chat-contact-adapter.ts
apps/web/src/server/engine/chat-contact-reply.ts
apps/web/src/server/engine/chat-npc-scene-*.ts
apps/web/src/server/engine/chat-permission-*.ts
apps/web/src/server/engine/chat-pipeline.ts
apps/web/src/server/engine/chat-state.ts
```

Effect owner transactions are pure and live under `contracts/` instead; the
settle fold that commits them is in `chat-state.ts`. Detail:
[effects spec](romantic-contact-affordances.spec.effects.md) §§7–9.

### Player side

The producers are deliberately narrow:

- player narration spans only;
- explicit first-person movement/touch;
- approach/depart plus affectionate hand contact;
- a separate closed romantic caress/stroke/cup hand contact, matched against the
  **whole sentence** (both the shape and the locus are allow-lists, so a trailing
  clause of any content refuses), on the affectionate lane's eight loci plus
  `face`, and running only when a permission owner is wired;
- one admitted contact action per turn, of whichever kind the player wrote —
  a single scan in written order keeps "first eligible sentence wins";
- no intimate/resisting/restraining fallback, and no romantic-to-affectionate
  downgrade: a line the romantic gate rejects carries romantic framing, which
  the affectionate gate vetoes whole;
- material read from the current exchange's wardrobe cut;
- persistence acknowledgment required before the narrator may be told a contact
  committed.

**Important:** `ChatContactAct.actionKind` is `"affectionate" | "romantic"` —
the two kinds this lane has a producer for, deliberately narrower than the
core's `ContactActionKind`. `incidental`, `casual`, and `intimate` stay compile
errors here, so a kind cannot reach the resolver ahead of its producer and its
permission owner. The NPC lane is separate and still hard-codes
`"affectionate"`; its evidence gate enforces that.

### Inspector preview

`previewChatContactOutcomes` in `chat-pipeline.ts` loads the permission ledger
under the same `chatRomanticPermissionEnabled()` gate as the live leg, and is
async for that reason.

The preview **obeys** the permission flag rather than reporting on it. Without
the ledger read the preview would produce no romantic act at all — the producer
is gated on the policy source's presence — while the live turn consults the real
owner, so the preview would show silence for a romantic act the live turn would
in fact commit. A preview that disagrees with the turn it previews is worse than
no preview at all. With the flag off both paths leave the romantic producer
switched off, which is the honest preview of a turn that does not run it.

### NPC side

Two tiers remain distinct:

1. deterministic ending floor — already authoritative;
2. one structured reply-scene decision leg — movement/start/update candidates,
   deterministic evidence gates, durable envelope, and staged authority.

No free-prose extractor may mint new NPC movement/start/update authority.

## Permission lane map

Executable owner:

```text
apps/web/src/contracts/affordances/permission/
apps/web/src/server/engine/chat-permission-events.ts
apps/web/src/server/engine/chat-permission-decision.ts
```

The current owner knows exactly one gated scope: `romantic_touch`.

Direction is:

```text
permitted actor -> granting target -> exact scope -> chat/branch
```

Rules:

- player -> NPC romantic touch requires that NPC's grant to the player;
- NPC -> NPC requires the target NPC's grant in that direction;
- NPC -> player uses the explicit player-target `not_required` basis rather than
  manufacturing a player grant;
- reverse direction does not authorize;
- another scope does not authorize;
- withdrawal ends dependent active contacts;
- relationship/affection/arousal never create permission;
- retake prunes discarded permission authority.

The permission owner answers attempts. **It does not create attempts.** The
narrow romantic player producer now supplies them, and only while this owner is
available to answer: the producer is gated on `permissionPolicy !== undefined`,
so with `CHAT_ROMANTIC_PERMISSION` off it does not run and the lane is
byte-identical to its pre-producer behavior. That is stronger than silence, and
deliberately so — a turn admits one act, so a produced-then-unresolved romantic
sentence would consume the slot and suppress a later affectionate sentence that
commits today.

## Visual-state integration

Visual contact presentation now follows the visual-state architecture.

Existing integration:

- `visual-state/body-language.ts`
  - projects scene posture/support/facing;
  - derives hand occupation from active committed contacts;
  - projects committed contact motion;
  - projects the full `body_language.contact_relation` feature from
    `CommittedContactRead` (built 2026-08-22), which is what a structured
    `hand on shoulder` line renders from. Narrator-eligible behind the per-chat
    visual-state switch; deliberately not offered to image selection yet.
- `visual-state/observations.ts`
  - adapts resolved `AffordanceObservation` values into visual-state features;
  - carries the observation repeat family into visual-state selection.
- visual-state visibility/selection
  - owns per-subject exposure and visibility;
  - owns visual notice/mention/repetition state;
  - selects narrator/image digests.
- `chat-visual-state-cues.ts`
  - is the single narrator renderer for visual-state facts.

The relation feature lives in visual state because it is a **view of committed
contact**, not another contact store. Detail:
[effects spec](romantic-contact-affordances.spec.effects.md) §5.

## Sensory-channel boundary

The existing lane-neutral `AffordanceObservation` type does not carry a sensory
channel. The current visual-state bridge assumes the observations it receives are
visual candidates.

Therefore new contact phenomena use a channel-tagged domain result, built
2026-08-22 in `contracts/affordances/contact/phenomena.ts`. No producer emits a
phenomenon yet, so the seam is real but unused:

```ts
type ContactPerceptionChannel =
  | "visual"
  | "tactile"
  | "olfactory"
  | "gustatory";

interface ContactPhenomenonObservation {
  channel: ContactPerceptionChannel;
  // structured phenomenon/locus/intensity/evidence fields
}
```

Routing law:

- `visual` -> may adapt into visual-state observation/features;
- `tactile` / `olfactory` / `gustatory` -> do **not** enter visual state and do
  not enter a narrator prompt until a shared nonvisual sensory owner exists.

Owner ruling (2026-08-22): `AffordanceObservation` does not gain a channel
discriminant for contact. Each sense is a distinct sensory subsystem with its
own observation contract; a shared routing envelope may carry the channel; any
change to the shared contract is designed cross-domain. Detail:
[effects spec](romantic-contact-affordances.spec.effects.md).

## Effects and current-state ownership

The contact core may propose effects, but current truth stays with the state owner.

Already owned:

- body-surface wetness;
- body-surface deposits/residue, including dirt, blood, and cosmetics;
- temporary contact/pressure marks;
- garment presentation/condition/deposits/damage;
- active contact itself.

Still missing on the body side:

- surface products on skin;
- scratch/skin damage;
- swelling/visible fatigue;
- general contact temperature/physiology reads needed by later domains.

Surface products keep the designated owner ruled 2026-08-22: they expand
`BodySurfaceState` beside wetness, deposits, and marks, split by module rather
than into new subsystems. They are the one part of that ruling still unbuilt.
Scratch/skin damage has no owner at all, is not a member of the mark-kind
vocabulary, and a stored scratch quarantines rather than reads.
Swelling/fatigue and temperature/physiology stay with a future physiology owner.
Detail: [effects spec](romantic-contact-affordances.spec.effects.md).

Consequences:

- a transfer cannot be narrated before an owner transaction commits it;
- a mark cannot exist only in contact memory;
- garment displacement must be a wardrobe operation;
- visual state consumes the committed result afterward.

## Retake/rollback ownership

There is no `ContactPresentationCapture`.

Character-chat retake correctness composes:

- restored scenario/scene + contact ledger;
- permission ledger prune/fold;
- restored wardrobe/body/environment state;
- pure visual-state recomputation;
- visual memory/cue-state restoration by the visual owner.

If a future nonvisual sensory layer keeps notice/mention state, that layer owns
and restores it. Contact remains physical truth only.

## Revised implementation sequence

Per-step delivery history belongs to the
[plan](romantic-contact-affordances.plan.md) §19; each track here carries one
status line so a reader can see what is left without opening it.

### Parallel track A — already-built NPC authority

Status: blocked on a reviewed shadow corpus and the owner's cost/quality ruling.

1. Review the shadow corpus and telemetry.
2. Record owner quality/cost ruling.
3. If accepted, widen authority in order: movement -> start -> update.

### Track B — permission proof

Status: built 2026-08-18 — awaiting the owner-run live rerun at step 8.

4. Add a **separate narrow player romantic action producer**; do not weaken the
   affectionate detector.
5. Reuse the shared resolver/lifecycle with `actionKind: "romantic"` and the
   existing permission read.
6. Prove grant/no-grant/reverse-direction/wrong-scope/withdrawal/retake cases.
   Pure tests drive the real permission seam; retake restoration stays with the
   `chat-permission.int.test.ts` integration layer.
7. Run the first controlled player -> NPC romantic live proof.
8. Rerun the live proof against the closed silent-refusal and naming gaps with
   the evidence-capturing instrument (`scripts/trial/romantic-contact/`).
9. Rollout of this specific surface, contingent on step 8.

Track B does not require general NPC authority unless the fixture asks an NPC to
voluntarily reposition.

### Track C — visual continuity

Status: built 2026-08-22 — awaiting the step 12 narration evaluation.

10. Add visual-state contact relation projection.
11. Route only visual contact observations into visual state.
12. Trial optional positive visual narration under the existing per-chat switch.

### Track D — richer mechanics/effects

Status: in progress — steps 13–14 built, neither live; step 15 next.

13. Expand `BodySurfaceState` into the deposits/residue and marks owner before
    the phenomena that require it (ruled 2026-08-22).
14. Add effect transactions with idempotency/rollback — temporary pressure mark
    first, conserved transfer second (ruled 2026-08-22).
15. Build the shared nonvisual sensory presentation owner as sibling package(s)
    beside visual state (ruled 2026-08-22).
16. Register only foot phenomena whose complete truth + perception path exists.

### Track E — intimate

Status: blocked on the Track B rerun, the exact future scopes, and the missing
physiology and sensory owners.

17. Define the exact scopes with their action families, per the 2026-08-22
    scope-model ruling in the permission spec.
18. Land physiology/body-surface owners.
19. Prove exposure + channel-specific perception + rollback.
20. Register intimate phenomena only after all gates exist.

## Invariants for every future slice

1. No action kind without a real producer.
2. No physical fact from narrator prose alone.
3. No NPC movement from player authorship.
4. No player reaction from NPC/narrator authorship.
5. Unknown remains unknown.
6. Permission and physical feasibility remain separate.
7. No observation before contact/effect commitment.
8. Visual facts use visual-state visibility/attention/memory.
9. Nonvisual facts never leak through the visual-state bridge.
10. No second contact-specific presentation memory/cooldown store.
11. Retry/retake are idempotent and restore one coherent cut.
12. Every negative path is fixture-tested, not only the happy path.
