# Romantic contact affordances — grounded contact, permission, and effects

Status: **active; reconciled to `main` on 2026-08-18.** The affectionate contact
slice is live in character chat. The shared contact core, durable contact
lifecycle, scene/body-relations owner, player-authored affectionate action lane,
narrow player-authored romantic action producer, NPC deterministic ending floor,
NPC reply-scene authority implementation, and directional `romantic_touch`
permission owner all exist. The NPC authority increments and romantic permission
owner remain gated; the romantic producer only runs when a permission owner is
wired, so with the flag off the lane behaves exactly as it did before the
producer existed. The foot domain is built but deliberately unregistered.
Contact effects and intimate-region mechanics remain future work.

Outcome: A player can touch a character and have the game itself settle what
happened — who moved, what was in the way, whether that character had allowed it
— so that physical moments stop being whatever the narrator improvised that
turn.

This reconciliation changes the continuation design in two important ways:

1. **Visual perception/presentation is now owned by visual state.** Contact must
   not build a second visual visibility, salience, repetition, memory, or narrator
   capture system.
2. **The permission proof needs its own action producer.** The live player touch
   producer was intentionally and literally affectionate-only, so enabling
   `CHAT_ROMANTIC_PERMISSION` alone could not produce a permission-gated
   romantic attempt. A narrow romantic action seam is an explicit prerequisite
   for the first romantic proof. That producer is now built and deterministically
   tested; what remains of Track B is owner work — the controlled live proof and
   the rollout ruling for this specific action surface.

Technical companions:

- [technical index](romantic-contact-affordances.spec.md)
- [shared contact core](romantic-contact-affordances.spec.contact-core.md)
- [scene/body-relations owner](romantic-contact-affordances.spec.scene.md)
- [NPC actor control](romantic-contact-affordances.spec.actor-control.md)
- [directional permission owner](romantic-contact-affordances.spec.permission.md)
- [observations, effects, and presentation routing](romantic-contact-affordances.spec.effects.md)
- [foot domain](romantic-contact-affordances.spec.foot.md)
- [intimate domain](romantic-contact-affordances.spec.intimate.md)
- [truth-source audit](romantic-contact-affordances.audit.md)
- [affectionate trial](romantic-contact-affordances.trial.md)

Related owners:

- [visual state and attention](visual-state.plan.md) owns visual projection,
  observer/camera visibility, visual attention, visual memory, and narrator/image
  selection;
- [constraint-first narrator guidance](narrator-physical-guidance.plan.md) owns
  mandatory physical constraints, premise corrections, and committed action
  outcomes/transitions;
- [clothing state graph](clothing-state-graph.plan.md) owns garment identity,
  presentation, condition, coverage, and garment-carried material;
- body-surface state owns current body wetness where it exists;
- future physiology/body-surface work must own swelling, residue, marks,
  temperature, and other current body facts before contact can consume them.

## Outcome

A physical interaction should be one committed piece of world state rather than
something the narrator is asked to improvise. Vesper should know:

- who authored the action and which body they control;
- whether the other participant must move and who owns that choice;
- whether the surfaces can actually reach each other;
- what clothing/material lies between them;
- what permission scope the action requires;
- whether contact starts, continues, changes, or ends;
- what physical phenomena follow from the committed contact;
- which effects were actually committed by their state owners;
- what a particular observer can perceive;
- which one or two useful details are worth presenting.

The narrator renders those answers. It does not become the owner of them.

## Current state of the codebase — 2026-08-18

| Area | Current state |
| --- | --- |
| Shared contact core | Built and used by character chat under `apps/web/src/contracts/affordances/contact/`. |
| Player movement + affectionate hand contact | Built and live behind `CHAT_CONTACT_ACTIONS`; unchanged by the romantic work, and still vetoes romantic/intimate framing outright. |
| Contact persistence | Durable `chat_contact_events` lifecycle with idempotent start/update/end projection and retake pruning. |
| Scene/body relations | Built: participants, control, posture, support, proximity, facing, reach, discontinuity clearing, and active contacts. |
| NPC deterministic endings | Built and part of the live contact floor. |
| NPC movement/start/update authority | All three increments are built behind `CHAT_NPC_SCENE_DECISIONS` and the authority-kind scope. Shadow measurement opened 2026-08-10; no committed review/acceptance artifact exists in the repository as of this reconciliation. |
| Romantic permission owner | Built behind `CHAT_ROMANTIC_PERMISSION`, exact directional `romantic_touch` only; developer override is separate. |
| Romantic action producer | Built: a separate narrow player producer emits `actionKind: "romantic"` for a closed caress/stroke/cup family. Runs only when a permission owner is wired, so `CHAT_ROMANTIC_PERMISSION=off` leaves the lane unchanged. Deterministically tested; not yet proven live. |
| Foot domain | Built and fixture-driven, intentionally absent from the live affordance-domain registry. |
| Body-surface wetness | Owned and now consumed beyond hair; visual state projects non-dry regional wetness. |
| Residue / dirt / blood / cosmetics wear on skin | No current body-state owner. |
| Contact marks / pressure impressions | No current body-state owner. |
| Contact-derived visual body language | Built in visual state: active contacts can produce hand occupation and committed contact motion. |
| Visual visibility + attention + repetition | Built in visual state, including per-subject exposure/consent, selection, memory/cue state, and narrator projection. |
| Positive visual-state narration | Slice 7 exists behind a per-chat switch and is off by default; contact must not assume visual cues are globally live. |
| Contact material transfer / marks / scratches / garment displacement | Not built; proposals remain future until owning state transactions exist. |
| General tactile / olfactory / gustatory presentation | No shared cross-modal perception/presentation owner yet. |
| Intimate contact domain | Not built; blocked on exact future scopes plus missing physiology/body-surface owners and nonvisual sensory routing. |

### What changed since the previous plan

The old plan was written when contact had to sketch its own perception and cue
pipeline. That is no longer true.

Visual state now:

- projects body-surface wetness, wardrobe state, conditions, and supported
  affordance observations;
- consumes the committed scene/contact lifecycle for posture, support, facing,
  hand occupation, and contact motion;
- computes per-subject visual exposure and visibility;
- owns visual attention, notice/mention state, repetition control, and narrator
  selection;
- renders visual constraints and at most two optional visual cues through the
  single chat visual-state narrator adapter.

The contact plan therefore becomes narrower and cleaner: **contact owns physical
action, lifecycle, mechanics, and effect proposals; visual state owns the visual
read of those truths.**

## Ownership map

### Contact core owns

- action-kind to permission-scope mapping;
- attempt -> resolution -> commitment separation;
- access/reach/material/support/policy combination;
- active contact identity and lifecycle;
- pressure/area/motion/material-between facts that were committed with contact;
- effect proposals caused by contact;
- evidence and deterministic replay of contact truth.

### Scene/body-relations owns

- participant control;
- coarse posture and support;
- pair proximity/facing and reach inputs;
- continuous co-presence and discontinuity clearing;
- the scene projection containing active contacts.

### Permission owns

- directional, exact-scope grants/withdrawals/attempt denials;
- chronology and retake behavior;
- invalidation of dependent active contacts on withdrawal;
- the player-target `not_required` exception.

Permission never creates an action, movement, desire, attraction, or physical
possibility.

### Wardrobe and body-state owners own

- current coverage and material layers;
- garment presentation, condition, deposits, damage, and displacement after a
  wardrobe operation commits;
- body wetness, residues, marks, physiology, and temperature only where a real
  state owner exists.

Contact may consume or propose changes to these owners. It may not persist a
shadow copy.

### Visual state owns the visual consumer path

For visual facts the required path is:

```text
committed scene/contact/body/wardrobe truth
        -> visual-state adapters/features
        -> composition + per-subject visibility
        -> visual attention + cue state
        -> narrator/image/inspector digest
```

Contact must not create a parallel `ContactMentionPriority`, visual cooldown
store, visual memory, or visual presentation capture.

### Narrator physical guidance owns binding prose handoff

Committed/rejected/unresolved action outcomes and mandatory stop transitions are
binding physical guidance. They are not optional visual flavor and do not wait
for visual-state narration to be enabled.

### A future sensory owner must own nonvisual presentation

Tactile, olfactory, and gustatory facts are real use cases, but visual state is
explicitly visual. Their perception, observer binding, attention, cooldown, and
narrator selection should be a **shared sensory presentation layer**, not three
contact-specific copies and not an accidental extension of visual state.

Until that owner exists, nonvisual contact phenomena may be computed in pure
fixtures but must not be promoted into narrator cues by inventing a local
presentation subsystem.

## Design corrections from this review

### 1. Do not build the old contact-specific visual attention system

The previous effects design had its own perception gate, mention-priority
formula, repeat keys, noticed/offered/realized timestamps, and
`ContactPresentationCapture` concept. That now duplicates visual state.

**Ruling:** visual contact facts use visual state's visibility, memory, attention,
selection, and retake behavior. The effects spec now keeps only physical
observation/effect contracts and channel routing.

### 2. Add a channel boundary before any new contact observation is wired

The shared `AffordanceObservation` contract does not carry a sensory channel.
`visual-state/observations.ts` reasonably treats the observations handed to it
as visual candidates. That is safe for the existing visual domains, but unsafe
for contact if tactile/scent/taste observations are mixed into the same list.

**Ruling:** contact phenomena must remain channel-tagged until routing. Only
`channel: "visual"` observations may be adapted to the current visual-state
`AffordanceObservation` bridge. Tactile/olfactory/gustatory observations stay out
of visual state and out of narrator prompts until a shared nonvisual sensory
owner exists.

A future general affordance contract may add a channel discriminant, but contact
must not silently change the meaning of the existing observation type.

### 3. Active contact needs a first-class visual relation before rich positive contact narration

Visual state currently gets two useful consequences of active contact:

- a hand can be marked occupied;
- committed contact motion can be projected as still/pressing/sliding/etc.

That is enough for continuity support but not enough to render the full relation
`her hand is on your shoulder` from structured truth. The current motion feature
is keyed to the contact relation but does not itself carry human-resolvable
source/target participant names and both loci.

**Ruling:** before contact supplies rich positive visual narration, add a
visual-state contact-relation feature sourced from `CommittedContactRead`. It
must carry the contact id, source participant/locus, target participant/locus,
and only visually valid material/placement facts. Visual-state visibility and
selection still decide whether it is seen or mentioned.

This is **not** required for the first permission proof, whose correctness can be
verified from the committed contact/action outcome and inspector state.

### 4. The first romantic proof needed its own action producer

Status: built 2026-08-18 — the producer exists, its evidence and permission
behavior are deterministically tested, and the affectionate path is unchanged.

The player-side producer used to be narrow in a way that closed the proof off:

- `detectChatAffectionateTouch` uses an allow-list;
- `ChatContactAct.actionKind` was literally `"affectionate"`;
- romantic/intimate framing is vetoed rather than downgraded.

The permission owner was therefore an authoritative answer with no romantic
attempt to answer.

**Ruling:** insert a new narrow player-authored romantic action producer before
the romantic proof. Do **not** broaden or weaken the affectionate detector. The
new producer should reuse the actor-generic resolver/lifecycle and differ only in
its admitted evidence and `actionKind: "romantic"`.

For the first proof, keep it intentionally small:

- player actor only;
- hand as the acting surface;
- non-intimate target loci already supported by the contact vocabulary, plus
  the face (owner ruling, below);
- a closed, explicitly romantic gesture vocabulary such as a caress/stroke/cup
  family with deterministic evidence validation;
- no target movement or implicit emotional reaction;
- no kissing, intimate anatomy, clothing manipulation, restraint, or sexual
  activity;
- fail closed on ambiguous or mixed affectionate/romantic language;
- never fall back to `affectionate` when the romantic detector rejects a line.

The target NPC's existing `romantic_touch` grant must be read before the attempt
is resolved. No grant, wrong direction, wrong scope, withdrawn grant, or
unavailable owner must prevent commitment.

The delivered producer holds that whole boundary. Two consequences are worth
naming for the owner.

**Both halves of the act are now allow-lists.** The first attempt guarded where
a touch could land with an allow-list, but guarded what else the sentence could
say with a list of refused words. That was the wrong shape and adversarial
probing proved it twice: the refusal list missed whole families it had never
thought to name, while simultaneously refusing innocent prose — the entry meant
to catch *untie* was also catching *until*. A list of forbidden words over
free-form English cannot be finished, and every entry that closes a gap also
refuses something harmless.

The producer now matches the **whole sentence** instead: an opening `I`, an
optional adverb from a closed set, one of the three verbs, whose body, an
allowed body area, an optional closing phrase from a closed set, and the end of
the sentence. `I caress your arm and <anything>` is refused because there is a
trailing clause at all — the producer forms no opinion about what the clause
says. Nothing outside the shape it recognizes can commit.

**Owner ruling (2026-08-18): the romantic lane admits the cheek.** `cheek` and
`cheeks` map to the body registry's existing coarse `face` area — no new cheek
location was invented — which gives `cup` the target it was missing. The romantic
lane now reaches nine body areas; the affectionate lane still reaches eight and
refuses the cheek in every form. The constraint the owner attached: the shared
refusal list that guards the affectionate detector and the frozen NPC ending
floor must not lose the cheek to make this work, so the carve-out lives in a
romantic-only list and the shared one is byte-identical. Detail in the
permission spec.

**The cost, stated plainly.** Ordinary romantic prose carrying a second clause —
`"I caress your arm until you smile."` — now commits nothing. That is a refusal
where a commit would arguably have been fine. It is never the reverse, and the
asymmetry is the point: the failure this design accepts is silence, and the
failure it refuses is committing world state nobody authorized. If the live proof
finds it too tight, loosening it is a candidate follow-up.

### 5. NPC authority review and player romantic proof are parallel gates, not one chain

The old plan made the first romantic proof wait for the entire NPC
movement/start/update rollout. That dependency is broader than the code needs.

A **player -> NPC** romantic attempt uses player actor control and the directional
permission owner. It does not require NPC reply-scene movement/start/update
authority unless the attempted contact needs the NPC to voluntarily move.

**Ruling:**

- continue the item-4 shadow review and staged NPC authority rollout on its own
  operational track;
- build and test the narrow player romantic producer independently;
- run the first player -> NPC permission proof once that producer and permission
  owner are enabled in a controlled test;
- require NPC `start` authority only before claiming **NPC-initiated** romantic
  contact support.

### 6. Current-state body ownership is better than the old plan says, but aftermath still has gaps

Body-surface wetness is a real whole-body owner and visual state now consumes it.
The old wording that regional moisture was generally unowned is obsolete.

Still unowned on the body side:

- dirt/blood/cosmetics residue on skin;
- pressure/contact marks;
- swelling and visible fatigue;
- general surface product/residue inventory;
- contact temperature as persistent/current body truth where a domain needs it.

Garment deposits/condition/damage already have owners; do not duplicate them in
contact.

### 7. Retakes do not need a contact-owned presentation snapshot

Retake correctness now composes existing owners:

- contact lifecycle rows + restored scene;
- permission ledger + prune/fold;
- wardrobe/body/environment restored state;
- visual-state snapshot recomputation;
- visual memory/cue state restored by its own owner.

**Ruling:** remove the planned `ContactPresentationCapture`. If a future
nonvisual sensory layer needs durable notice/mention state, it owns that state
itself and rolls it back beside the visual-memory precedent.

## Core physical laws

These remain unchanged.

- An attempted action is not committed contact.
- A committable resolution is not current truth until the lifecycle commit
  succeeds and persistence acknowledges it.
- Unknown is not a default. Missing reach, support, material, policy, or source
  state degrades toward unresolved/silence.
- Player narration never moves an NPC.
- NPC narration never moves the player.
- A voluntary target adjustment belongs to that target's behavior authority.
- Permission is directional and exact-scope; relationship/affection/arousal do
  not manufacture it.
- Physical possibility does not imply desire, pleasure, acceptance, or reaction.
- Clothing/material can transmit contact without granting direct skin access.
- Contact ends on explicit release, separation, scene discontinuity, policy
  withdrawal, or a committed state change that invalidates the path.
- Effects become observations only after their owning transaction commits.
- Retry and retake cannot double a contact or effect.

## Revised continuation order

### Track A — operational review of already-built NPC authority

Status: **hold — 2026-08-18 owner ruling.** Keep shadow measurement running; do
not enable NPC authority. This is not a rejection: the evidence needed to accept
it does not exist yet.

Two conditions the owner attached to the eventual review:

- **Weigh precision over recall.** A missed NPC movement means Vesper fails to
  capture something the narrator said. A false commit means Vesper writes
  authoritative world state the narrator never said. The second is much worse,
  so the review is not looking for the best overall score.
- **Set the acceptance thresholds before reading the corpus.** A number chosen
  after seeing the data is a description of the data, not a gate. The owner has
  approved a pre-registered gate for `movement` authority — sample size,
  precision, a zero-tolerance failure class, recall, latency, and timeout — which
  is written down in the NPC actor-control spec and applies to `movement` alone;
  each later widening re-runs it. Note that precision and recall cannot come from
  the report tool, which computes no accuracy by design: they need a human
  labelling pass that has not happened.

1. Export/review the 2026-08-10+ shadow corpus with
   `pnpm report:npc-scene-decisions`.
2. Record trigger accuracy, false positives/negatives, drop reasons,
   p50/p95/p99 **settle wait**, timeout rate, and cost per 100 replies.
3. Make and record the owner cost/quality ruling.
4. If accepted, enable authority in order:
   `movement` -> `movement,start` -> `movement,start,update`, with an acceptance
   check after each widening.

The repository currently contains the instrument and records that the window was
opened, but it does not contain a final reviewed corpus or acceptance ruling.
Do not infer one from the existence of telemetry.

### Track B — first genuinely romantic contact proof

5. **Build the narrow player romantic action producer** described above. This is
   the new prerequisite the old plan missed.
   Status: built 2026-08-18 — a closed caress/stroke/cup family on the existing
   non-intimate body areas, refusing everything else rather than softening it.
6. Wire its attempt to the existing permission projection/read and shared contact
   resolver without changing the affectionate path.
   Status: built 2026-08-18 with item 5 — one player producer now feeds the
   resolver, and the permission read the pipeline already loads answers it.
7. Run deterministic/adversarial tests for the cases below.
   Status: built 2026-08-18 — every case is covered by the pure suite **except
   retake**, whose permission/contact restoration is exercised by the existing
   `chat-permission.int.test.ts` integration layer instead.
   - grant present -> physically valid action commits;
   - no grant -> no contact commit;
   - reverse-direction grant -> no commit;
   - wrong scope -> no commit;
   - withdrawal -> no commit and dependent existing contact ends;
   - retake -> permission/contact state restores;
   - ambiguous romantic evidence -> no action;
   - permission-neutral affectionate touch remains unchanged.
8. Enable `CHAT_ROMANTIC_PERMISSION` only for the controlled proof and run the
   first player -> NPC live scenario.
   Status: next — owner-gated, not code-gated. Nothing further needs building.
9. If the proof passes, decide the production rollout of that **specific**
   romantic action surface. Do not infer support for kissing, undressing,
   intimate touch, or sex.
   Status: owner decision, queued behind item 8.

Track B does not wait for NPC movement/start/update authority unless the chosen
fixture requires an NPC voluntary adjustment.

### Track C — visual contact continuity and presentation

10. Add the visual-state contact-relation feature from committed contact.
11. Route visual contact phenomena through visual-state observations/features,
    not contact-specific cue ranking.
12. Evaluate positive visual contact narration under the existing per-chat
    visual-state narration switch. Binding action outcomes remain independently
    available through narrator physical guidance.

### Track D — grounded contact effects and richer domains

13. Add the missing body-surface owners needed by the next phenomenon:
    residue/product inventory and marks first; do not create them inside contact.
14. Add effect transactions for conserved transfer and idempotent marks/
    displacement, delegating garment changes to wardrobe.
15. Decide/build the shared nonvisual sensory presentation owner before tactile,
    olfactory, or gustatory contact cues are promoted into narration.
16. Register only foot phenomena whose complete truth/perception path exists;
    keep unsupported phenomena fixture-only.
17. Expand calibration from the foot fixture matrix using semantic bands and
    source-backed state only.

### Track E — intimate contact

18. Define exact future scopes beyond `romantic_touch`.
19. Land the required physiology/body-surface owners.
20. Prove exposure/access with wardrobe + scene + permission + channel-specific
    perception.
21. Only then register intimate phenomena and run a dedicated leak-prevention
    trial.

## Flags and rollout boundaries

Code defaults remain conservative:

- `CHAT_CONTACT_ACTIONS` — default off in code; owns contact-state work.
- `CHAT_NPC_SCENE_DECISION_SHADOW` — default off in code; measurement only.
- `CHAT_NPC_SCENE_DECISIONS` — default off; requires contact actions.
- `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS` — unset/blank means `movement`
  only, the fail-safe first authority increment.
- `CHAT_ROMANTIC_PERMISSION` — default off; requires contact actions.
- `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` — independent admin/test capability.
- visual-state narrator use is controlled by its **per-chat** switch and remains
  off by default; it is not a contact flag.

The last deployment state documented by this plan family is 2026-08-10:
`CHAT_CONTACT_ACTIONS`, `CHAT_PHYSICAL_CONSTRAINTS`, and
`CHAT_NPC_SCENE_DECISION_SHADOW` were on; NPC authority and romantic permission
were off. Treat that as a dated deployment observation, not a code invariant.

## What is deliberately not in scope yet

- kissing;
- intimate anatomy or internal contact;
- undressing another participant;
- nudity-exposure permission;
- sex;
- restraint/pinning;
- a full skeletal pose solver;
- automatic emotional or physiological reactions;
- contact-created residue/marks without owning state;
- contact-specific visual memory or narrator ranking;
- a contact-specific tactile/scent/taste memory system;
- successor parity before the character-chat contracts are proven.

## Open questions

### Operational

- Does the NPC shadow corpus meet the accuracy/latency/cost gate for movement
  authority? Still genuinely open: the owner has ruled to hold and keep
  measuring — see Track A — so there is now a ruling but not an acceptance, and
  the evidence that would settle it does not exist yet.
- After the first romantic proof, should that narrow player action surface ship
  immediately or remain test-only until the visual contact-relation projection
  is available?

### Shared sensory architecture

- Should the future nonvisual sensory presentation owner be a generalization of
  visual-state attention/memory contracts or a sibling package with the same
  laws? The required behavior is settled; the package boundary is not.
- Should `AffordanceObservation` eventually gain an explicit sensory-channel
  discriminant, or should channel-tagged domain facts adapt into separate
  visual/tactile/olfactory/gustatory observation contracts? Do not make this
  change merely for contact without a cross-domain design.

### Effects/body state

- Which body-state package owns skin residue/product inventory and contact marks?
  Visual state currently records these as unavailable; the next effect slice
  needs a real mutation/read owner before implementation.
- Which effect should be the first end-to-end commit proof: a conserved surface
  transfer or a temporary pressure mark? Prefer the smallest owner transaction
  that exercises retry + retake without requiring physiology.

### Future permission scopes

- What exact scopes replace the one-scope MVP for kissing, intimate touch,
  clothing manipulation, nudity exposure, and sexual activity?
- Which relationship transitions, if any, automatically **revoke** particular
  grants? Improvement still never auto-grants or restores permission.

## Acceptance criteria for the next implementation phase

Before new contact-domain mechanics are promoted, the documentation and code
must agree on all of these:

1. A real action producer exists for every action kind being tested.
2. Every required authority read has an owner; unknown fails closed.
3. Contact truth commits before any observation/presentation consumes it.
4. Visual contact facts enter visual state and use its visibility/attention/
   memory path.
5. Nonvisual facts do not enter visual state.
6. No second contact-owned cue memory or presentation capture exists.
7. Retake restores contact, permission, effects, and presentation owners to the
   same cut.
8. Permission scope/direction and actor control remain orthogonal to physical
   feasibility.
9. Effects cannot appear before their owner transaction commits.
10. Tests prove negative cases as strongly as the happy path.
