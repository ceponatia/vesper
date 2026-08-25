# Romantic contact affordances — grounded contact, permission, and effects

Status: active — reconciled to `main` 2026-08-18; owner rulings folded 2026-08-22

Outcome: A player can touch a character and have the game itself settle what
happened — who moved, what was in the way, whether that character had allowed it
— so that physical moments stop being whatever the narrator improvised that
turn.

**Proposed workstream:** `contact affordances — coordinated contact, scene/body-relations, permission, effects, and presentation work whose truths remain separately owned`  
**Primary integration lane:** `the Vesper web application's character-chat turn pipeline`  
**Primary integration:** `contact resolution/lifecycle plus the binding guidance and owner reads the turn pipeline hands downstream`  
**Provider/dependency:** `no new provider — the two model-assisted classifier legs use Vesper's existing agent-model route; narrator-model selection remains separate, and deterministic validators/owners retain authority`

## 1. Goal

A physical moment should be one committed piece of world state rather than
something the narrator improvises and then forgets. When a player writes that
they touch a character, Vesper should answer these questions from its own
records rather than from the prose:

- who authored the action, and which body that person is allowed to move;
- whether the other participant has to move, and who owns that choice;
- whether the two surfaces can actually reach each other;
- what clothing or material lies between them;
- what permission the action requires, and whether that character gave it;
- whether the touch starts, continues, changes, or ends;
- what physical consequences follow, and which of them a state owner actually
  committed;
- what a particular observer can perceive, and which one or two details are
  worth mentioning at all.

The narrator renders those answers. It never becomes the owner of them.

The quality bar is that this reads as ordinary chat rather than a parallel mode.
Players write plain prose; there is no contact syntax to learn. Every switch
governing the work defaults to off, and with a switch off the lane must behave
exactly as it did before the work behind it existed — not merely quietly, but
identically.

---

## 2. Core architectural rule

**Contact owns the physical event. Every neighbouring truth keeps its own
owner.**

Contact decides whether an attempted touch is possible, records that it
happened, tracks it until it ends, and proposes consequences. It does not decide
what anyone can see, what anyone is wearing, what anyone's body currently
carries, whether a character wants the touch, or how the moment is written.

```text
scene placement + wardrobe + permission ledger   (owners outside this work)
                     |
                     v
        contact resolution and lifecycle          (this work)
                     |
     +---------------+-----------------+
     |               |                 |
     v               v                 v
binding narrator  visual state     effect proposals
guidance          (the visual read) (committed by their owners)
```

Contact may depend on scene placement and support, the current wardrobe cut, the
permission ledger's answer, and body-state reads wherever a real owner exists.
It must not duplicate visual state's visibility, attention, memory, or narrator
selection; it must not keep a shadow copy of wardrobe or body state; and it must
never read narrator prose as physical authority.

The dependency direction does not change. The scene owner consumes the contact
core and never the reverse, so a lane with no scene model still gets a contact
core that answers "unresolved" rather than one that fails to build.

### The physical laws that follow

These are unchanged, and they bind every future slice:

- An attempted action is not committed contact.
- A resolution that could commit is not truth until the commit succeeds and the
  durable record acknowledges it.
- Unknown is not a default. Missing reach, support, material, permission, or
  source state degrades toward unresolved, and unresolved means silence.
- Player narration never moves a character; character narration never moves the
  player.
- A voluntary adjustment by anyone else belongs to whoever owns that
  participant's behavior.
- Permission is directional and exact. Relationship, affection, and arousal
  never manufacture it.
- Physical possibility never implies desire, pleasure, acceptance, or reaction.
- Clothing and material can transmit a touch without granting skin contact.
- Contact ends on explicit release, separation, a scene break, a withdrawal of
  permission, or a committed change that invalidates the path.
- A consequence becomes observable only after the owner holding it commits it.
- Retrying or regenerating a turn can never double a touch or its consequences.

---

## 3. What the workstream owns

**The contact core owns the physical event itself**, because it is the only
place that sees the whole attempt at once: which action kind was attempted and
therefore which permission it needs, the separation of attempt from resolution
from commitment, the combination of reach, material, support, and policy into
one answer, the identity of a live touch and its lifecycle, the pressure, area,
motion, and material-between facts committed with it, the consequences it
proposes, and the evidence that lets the same inputs replay to the same result.

**The scene and body-relations owner owns where the bodies are**, because reach
is a property of the pair rather than of either action: who controls each
participant, coarse posture and what carries their weight, how close a pair is
and which way each faces, whether co-presence has been continuous, and the
projection that carries the live touches alongside the placement facts that make
them possible.

**The permission owner owns whether a character allowed this**, because consent
is a record a character authors, not a physical property to be derived: exact
directional grants, attempt denials and withdrawals, the chronology that decides
which of them applied when, the invalidation of live touches a withdrawal
undermines, and the explicit exception that Vesper never pre-authorizes the
player's own response. Permission never creates an action, a movement, a desire,
an attraction, or a physical possibility.

If this work disappeared, what would disappear with it is Vesper's ability to
say whether a touch actually happened — leaving only prose that asserts one.

Delivery state of what this work owns:

| Responsibility                                     | State                                                   |
| -------------------------------------------------- | ------------------------------------------------------- |
| Attempt, resolution, and commitment separation     | Live in character chat                                  |
| Contact lifecycle and its durable record           | Live; regenerating a turn prunes cleanly                |
| Scene participants, posture, support, reach        | Live                                                    |
| Player movement and affectionate hand contact      | Live; still refuses romantic framing outright           |
| Deterministic character-authored contact endings   | Live, and frozen as the floor                           |
| Player romantic contact producer                   | Proven live 2026-08-18; flags reverted, rollout pending |
| Directional romantic-touch permission owner        | Proven live 2026-08-18; flags reverted, rollout pending |
| Character-authored movement, start, update         | Built; authority on hold pending reviewed evidence      |
| Foot mechanics                                     | Built as fixtures; deliberately unregistered            |
| Contact effects                                    | First proof (pressure mark) built 2026-08-22, switch off |
| Material on skin — mud, blood, dust, cosmetics     | Live and ungated since 2026-08-25                       |
| Intimate-region mechanics                          | Not built; blocked on several owners                    |

---

## 4. What remains outside the workstream

**Clothing state owns garments** — identity, presentation, condition, coverage,
and any material a garment carries. Contact reads the current cut and may
propose a garment change; it never edits one. Detail:
[clothing state graph](clothing-state-graph.plan.md).

**Body-surface state owns what is currently on skin and hair.** Whole-body
wetness is live and already consumed elsewhere. Owner ruling (2026-08-22):
surface products, residues, deposits, and temporary contact marks expand this
same owner rather than becoming a new subsystem — designated, but not yet built,
so contact still cannot commit them.

**Visual state owns the visual read** — what each observer can see, what is
worth noticing, what has already been mentioned, how often to repeat it, and
what reaches the narrator or an image. Contact supplies committed truth and
stops there. The current bridge already derives hand occupation from active
committed contacts, projects committed contact-motion bands, computes
per-subject exposure and visibility, and — when the separate per-chat
visual-state narration switch is on — renders visual constraints plus at most
two optional cues through the single chat visual-state narrator adapter. The
bridge now also carries a first-class contact relation — which hand is on which
shoulder, as structured truth rather than two partial signals — built 2026-08-22
and rendered only in chats whose visual-state narration switch is on. Detail:
[visual state and attention](visual-state.plan.md).

**Narrator physical guidance owns binding prose handoff** — mandatory physical
constraints, premise corrections, committed action outcomes, and the stop a
withdrawal requires. This guidance is binding rather than optional flavour, and
it does not wait for visual-state narration to be switched on. Detail:
[constraint-first narrator guidance](narrator-physical-guidance.plan.md).

**Future sibling sensory owners own touch, smell, and taste presentation.**
Owner ruling (2026-08-22): these are sibling packages beside visual state rather
than a generalization of it — the senses share the same broad laws but differ
enough to own their own contracts. Until they exist, nonvisual phenomena may be
computed in fixtures but must not reach live narration.

**A future physiology owner must own swelling, temperature, and comparable
current body facts** before contact may consume them.

**Still without any owner:** scratches and skin damage. Material transfer and
garment operations have owners in principle, but neither can be committed until
those owners grow the transaction that does it.

This section exists to stop the same fact being modelled twice. Contact may
consume or propose changes to any of the owners above. It may never persist its
own copy of one.

---

## 5. Existing system integration

The work joins the character-chat turn that already exists rather than adding a
lane beside it.

```text
player writes an ordinary message
   |
   v
the chat turn pipeline
   |
   v
contact leg: read who controls whom, the scene, the wardrobe cut,
             and the permission ledger
   |
   v
resolution -> lifecycle commit -> durable record
   |
   v
binding narrator guidance, the visual-state read, and the inspector
   |
   v
the reply the player sees
```

The systems that stay authoritative are the ones named in §4, plus the chat's
own turn pipeline, its regenerate/retake behavior, and its persistence.

For the **current Track B romantic surface and already-built contact path**, no
new player-facing route, player-facing screen, provider, job type, or package is
required; players continue to write ordinary prose. The current path uses two
durable records that already exist, one for the contact lifecycle and one for
the permission ledger, both scoped to a chat and both pruned when a turn is
regenerated.

Future tracks are intentionally different: Track D extends the existing
body-surface owner for residue/marks and adds new sibling sensory presentation
package(s). Those future packages are part of the planned architecture and must
not be erased merely to keep the current Track B path package-neutral.

---

## 6. Data and contract changes

The concepts this work introduced, in plain terms:

- **An attempted action** — what the player's sentence proposed. Owned by
  contact, runtime only, and never persisted, because a proposal is not an
  event.
- **A resolution** — the verdict on that attempt: committable, needing an
  explicit transition first, rejected, or unresolved. Owned by contact, runtime
  only.
- **A committed contact** — the live physical truth after a commit succeeds.
  Owned by contact and persisted as a lifecycle record per chat, so a touch that
  began three exchanges ago is still a fact rather than a memory of prose.
- **Scene facts** — posture, facing, proximity, support, and who controls each
  body. Owned by the scene module, persisted with the chat, and every fact
  carries where it came from. There is deliberately no "narration" source.
- **Permission entries** — a directional, exact-scope ledger keeping four states
  apart: no answer on record, a standing grant, a denial of this one attempt,
  and a withdrawal of a standing grant. Owned by the permission module,
  persisted per chat, folded rather than summarized.
- **An effect proposal** — a requested consequence such as a transferred
  substance or a pressure mark. Owned by contact only as a request; the state
  owner decides and commits. Never persisted by contact.
- **A channel-tagged phenomenon** — a physical consequence carrying which sense
  could perceive it, so that a touch or a scent cannot be mistaken for something
  visible. Runtime only until its presentation owner exists.

Existing vocabulary is extended rather than duplicated. Body locations, scene
postures, distance bands, and the rest are registries: growing one is a data
edit, not a schema migration. The 2026-08-18 cheek ruling is the worked example
— the romantic lane reached the cheek by mapping it onto the existing coarse
face area instead of inventing a new location.

Exact shapes belong to the specs listed in §25, not to this plan.

---

## 7. Model / provider / implementation strategy

Two contact-adjacent classifier legs use model inference:

- **The character reply-scene decision leg** reads a reply the character already
  gave and proposes movement or contact that the prose already states.
- **The permission decision leg** reads the same committed reply and proposes
  permission events the character authored in it.

Both call Vesper's existing **agent-model route** (`agentModelId()` /
`generateChecked`), not the narrator model selected to write the chat reply. No
new provider or separately hosted service is introduced by this work. A cheap
trigger decides whether each call is worth making; the trigger is a cost gate
and never authority. Each leg performs at most one classifier call per eligible
reply, so a reply may incur one scene-decision call and one permission-decision
call if both independent triggers fire; neither leg ever makes one call per
character.

The **model output itself never commits state**. It proposes candidates only.
Deterministic grounding, attribution, schema/admission checks, the shared
resolver, and the appropriate owner transaction decide whether an accepted
candidate becomes authority. In shadow mode the scene leg records its admitted
plan dry; in authority mode deterministic execution may commit the admitted
movement/contact through the owning transaction. The permission leg may append
validated permission events through its guarded permission/contact invalidation
transaction. In both cases, the model is evidence extraction, never the writer
of authoritative state.

The player-side producers that turn a player's sentence into an attempted action
remain model-free because they author world state from the player's own words
and must be reproducible and arguable. The narrator remains a separate consumer
of the committed/guidance result.

Recommendation: keep these boundaries. Do not add a provider for contact, and do
not let unvalidated free-prose extraction mint authority.

---

## 8. Starting configuration

N/A for model/sampler tuning — this plan introduces no owner-tuned inference
parameters that should be selected by experiment. The work does contain fixed
physical vocabularies/tables and pre-registered operational acceptance
thresholds; those are contract/policy values, not a tuning sweep. The movement
authority thresholds are fixed before the corpus is read and belong to
evaluation (§20).

---

## 9. State / identity / source-of-truth strategy

Every input to a contact decision is a **read from the owner that holds it**,
never a fact contact reconstructs for itself.

```text
authoritative owners
  scene placement · wardrobe cut · permission ledger · body-surface state
        |
        v
resolved reads handed to the contact resolver
        |
        v
committed contact truth
        |
        v
consumers: narrator guidance · visual state · future sensory owners
```

The competing sources of truth this rules out, explicitly:

- no second store of moisture, residue, or marks inside contact;
- no shadow copy of what anyone is wearing;
- no contact-owned record of what was noticed, mentioned, or recently repeated;
- no contact-owned presentation snapshot — the previously planned one was
  removed, because regenerating a turn is already correct when each owner
  restores its own state.

Regenerating a turn therefore composes: the restored scene and contact record,
the pruned and refolded permission ledger, the restored wardrobe and body state,
a recomputed visual read, and visual memory restored by its own owner. If a
future sensory owner keeps notice-and-mention state, that owner restores it too.

---

## 10. Storage and association

There is no trained or generated **asset** in this work that needs character
association, resource versioning, or staleness checks. The work does create and
consume runtime classifier outputs and durable authority records; those are
state/evidence, not generated resources. The durable contact/permission records
are described in §6, and their regenerate/retake behavior is in §9 and §13.

---

## 11. Current limitations that must remain limitations

This work stays inside all of the following rather than expanding the shared
system to accommodate itself:

- **One admitted contact action per turn**, and the first eligible sentence
  wins. This is why a romantic sentence must not be produced when nobody can
  authorize it: an unanswerable romantic attempt would consume the slot and
  silence a later affectionate sentence that would have committed.
- **Coarse placement only** — a handful of height rungs and four distance bands.
  No coordinates, no angles, no gait, no full pose solver.
- **No restraint or pinning.** The scene model has no way to say a limb is held,
  so nothing may be built on the assumption that it can.
- **Coarse material transmission** derived from coverage. These values are
  placeholders for real material reads, and must not be tuned into pretend
  physics.
- **The romantic lane matches whole sentences** against a closed vocabulary. A
  trailing clause of any content refuses, so ordinary romantic prose carrying a
  second clause commits nothing. The failure this accepts is silence; the
  failure it refuses is committing world state nobody authorized. Loosening it
  is a candidate follow-up if the rerun finds it too tight, never a defect to be
  patched with a list of forbidden words.
- **The affectionate detector is not broadened or weakened**, because the same
  eligibility check guards the frozen ending floor, and loosening it there would
  make legitimate endings vanish.
- **Character-authored contact remains affectionate-only.** A character
  initiating romantic contact is not supported and is not claimed.
- **The foot domain stays unregistered** until each phenomenon has a complete
  path from a real source through commitment to a perception owner.

The switches, and what each one bounds:

| Switch                                       | Default and effect                                    |
| -------------------------------------------- | ----------------------------------------------------- |
| `CHAT_CONTACT_ACTIONS`                       | Off in code; owns all contact-state work              |
| `CHAT_NPC_SCENE_DECISION_SHADOW`             | Off in code; measurement only, no authority           |
| `CHAT_NPC_SCENE_DECISIONS`                   | Off; requires contact actions                         |
| `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS`    | Unset means movement only — the fail-safe first step  |
| `CHAT_ROMANTIC_PERMISSION`                   | Off; requires contact actions                         |
| `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE`      | Independent admin and test capability                 |
| `CHAT_CONTACT_EFFECTS`                       | Off; requires contact actions; owns effect commits    |

Visual-state narration is governed by its own per-chat switch, off by default.
It is not a contact switch, and contact must never assume visual cues are live.

The last deployment state this plan family verified was 2026-08-10: contact
actions, physical constraints, and shadow measurement on; character authority
and romantic permission off. Treat that as a dated observation of one
deployment, not as a code invariant.

---

## 12. Specialized behavior

### Contact lifecycle

A touch has a life. It starts only from a resolution that could commit, keeps
the same identity while it merely continues, changes only the facts an update
explicitly owns, and ends for a stated reason. It never stays alive because
prose mentioned it, and it never expires on a wall clock. Retrying the same
event cannot create a second touch.

### Scene placement and reach

The scene answers one question authoritatively: can this surface meet that one
from where these bodies actually are. Distance sets a ceiling, height difference
and orientation can only lower it, and nothing the scene holds can make a touch
easier than the distance already allows. An unstated fact is absent rather than
assumed, and an absent fact makes the answer unresolved rather than optimistic.

### Directional permission

Permission is a record a character authors, keyed by who may act, who is
allowing it, exactly what is allowed, and in which chat. A grant one way says
nothing about the other way, and a grant for one thing never widens to another.
A withdrawal ends the live touches that depended on it and nothing else. Only a
character's own committed words, or an audited developer override, can create
one; silence, affection, arousal, a relationship label, and anything the player
wrote about the character cannot.

Owner ruling (2026-08-22): scopes stay exact, directional, and non-inheriting.
No scope ever implies another, and an action may require several exact scopes at
once with all of them satisfied. The initial planned scope vocabulary beyond
`romantic_touch` is `kiss`, `intimate_touch`, `clothing_manipulation`, and
`nudity_exposure`, added only when the matching action family is actually
implemented. There is no broad `sexual_activity` grant; later sexual action
families receive their own exact scopes when they exist rather than inheriting
from one umbrella permission. Undressing oneself is the actor's own authority
rather than somebody else's contact permission.

Owner ruling (2026-08-22): no current familiarity or regard-band transition
automatically revokes permission, which remains something the target authored.
A future relationship owner may map a stronger explicit semantic event such as a
breakup or no-contact transition onto scope-specific revocation, but improvement
never auto-grants, recovery never restores a revoked grant, and a fresh grant
from the character is always required. The
[directional permission owner](romantic-contact-affordances.spec.permission.md)
is the reconciled companion implementation contract for these 2026-08-22
scope/revocation rulings.

### The narrow romantic action lane

A separate producer, deliberately smaller than the eventual romance model: the
player is the actor, a hand is the acting surface, the gesture comes from a
closed caress, stroke, and cup family, and the target is one of the ordinary
non-intimate body areas plus the face. It never softens a rejected romantic line
into an affectionate one, and it runs at all only while a permission owner is
wired to answer it — which is what makes the switch-off state identical to the
lane before this producer existed, rather than merely quiet.

Owner ruling (2026-08-18): the romantic lane admits the cheek, mapped onto the
existing coarse face area, on the condition that the shared refusal list
guarding the affectionate lane and the frozen ending floor is left untouched.
Detail: [directional permission owner](romantic-contact-affordances.spec.permission.md).

### Character-authored scene decisions

One structured leg reads a reply the character already gave and proposes the
movements and touches that reply states. The classifier output cannot commit
anything. Every proposal passes deterministic admission and then the same scene/
contact owners used elsewhere; shadow mode records admitted plans dry, while
authority mode may execute the admitted plan through the guarded owning
transaction. Authority is staged — movement first, then starting a touch, then
updating one — and each widening re-runs its own acceptance gate.

### Contact effects

Contact may calculate that a consequence is possible and propose it. The owner
of that state decides and commits, and only then can anyone observe it. Owner
ruling (2026-08-22): the temporary pressure mark is the first end-to-end proof
because it is the smallest complete one — a single owner, one place on the body,
one expiry rule — and conserved transfer is the second, because taking material
from one surface and putting it on another atomically is a larger piece of
architecture than a first proof should carry. Detail:
[observations, effects, and sensory routing](romantic-contact-affordances.spec.effects.md).
That companion spec is reconciled to the 2026-08-22 mark-first, body-surface,
and modality-specific sensory rulings.

---

## 13. Failure and degradation behavior

The rule throughout is that Vesper falls silent rather than inventing, and that
a refusal is never disguised as an event.

- **A missing scene, support, or material read** leaves the attempt unresolved.
  Nothing commits and nothing is recorded.
- **No permission on record** leaves the attempt unresolved. The narrator now
  receives a line that forecloses writing the touch as landing while asserting
  no refusal of its own and explicitly leaving declining open to the character —
  which it must, because the character declining in prose is the only route by
  which a denial ever reaches the ledger.
- **An explicit denial** produces its own blocking guidance, unchanged.
- **A withdrawal** ends the touches that depended on it and hands the narrator a
  binding stop, without exposing the permission record, any threshold, override
  metadata, or a diagnostic.
- **An attempt that is rejected or unresolved** never becomes a live touch and
  never feeds a physical consequence as though it had happened.
- **Stored state that cannot be read** follows the owning subsystem's explicit
  fail-closed corruption law; contact does not invent a common repair. Scene
  state may degrade unreadable placement facts toward absence/unresolved, while
  body-surface state deliberately quarantines a corrupt location so `unknown`
  cannot become the convenient default `dry`. In every case, unreadable data
  must never be laundered into a materially useful claim.
- **A proposed consequence whose owner does not exist yet** is simply not
  available. Contact keeps no hidden timer and shows nothing.
- **Retry and regenerate** are idempotent, and a failed prune refuses the
  regenerate rather than letting stale authority survive.
- **Every switch off** restores the previous behavior with no code change, and
  the romantic lane's off state is identical to the lane before that producer
  existed.

Nothing here degrades quietly into materially different behavior: the diagnostic
channel records genuine failures, while an **explicit character-authored
denial** is an authoritative answer rather than a system fault. An unanswered
permission owner is different: its neutral guidance must neither depict the
touch as landing nor invent a refusal.

---

## 14. Web UI integration

There is no new player-facing screen, and there should not be one. Players write
ordinary prose; the feature's whole point is that it reads what they already
write.

| Web surface           | Existing mechanism        | New behavior                            |
| --------------------- | ------------------------- | --------------------------------------- |
| Chat message box      | Ordinary prose            | Contact is recognized, not typed        |
| Chat inspector        | Per-turn outcome preview  | Shows the contact outcome for the turn  |
| Admin permission tool | Admin-gated, audited      | Seeds or revokes a grant for a test     |

The inspector's preview obeys the permission switch rather than reporting on it:
with the switch off, both the preview and the live turn leave the romantic
producer switched off, which is the honest preview of a turn that does not run
it. A preview that disagrees with the turn it previews would be worse than none.

The admin permission control states direction in plain language — "Alex may
touch Mara romantically" — rather than offering a symmetric checkbox, because
the underlying grant is not symmetric. It stays admin-only and audited, and it
can never be triggered from chat prose.

---

## 15. Normal production path

```text
player message
   |
   v
existing chat turn pipeline
   |
   v
existing contact leg
   |
   v
authority + permission read  ->  scene, support, and wardrobe reads
   |
   v
contact resolution
   |
   v
lifecycle commit + durable record
   |
   +--> binding narrator guidance (always)
   |
   +--> visual state, which decides what is seen and mentioned
   |
   +--> effect proposal, committed by its own owner if one exists
   |
   v
existing persistence and the reply the player reads
```

Nothing in that path is contact-specific except the contact leg itself, which is
the test of whether this is integrated or has quietly become a parallel system.

---

## 16. Shared abstractions versus implementation-specific controls

Owner ruling (2026-08-22): the shared observation contract does **not** gain a
sensory-channel discriminant for contact's sake. Vesper treats sight, hearing,
touch, smell, and taste as distinct sensory subsystems under one shared
presentation architecture. Domain state may emit channel-tagged phenomena for
routing, and a shared routing envelope may carry the channel, but each sense
keeps its own observation contract owned by its own subsystem, and they are
never collapsed into one generic cross-sensory type. Any change to the shared
contract is designed across domains, never from contact alone. Detail:
[observations, effects, and sensory routing](romantic-contact-affordances.spec.effects.md).

Two further boundaries follow the same rule:

- **Supporting an action kind in the shared core is not the same as being able
  to author it in a lane.** The chat lane deliberately names only the kinds it
  has a producer for, so a kind cannot reach the resolver ahead of the producer
  and the permission owner that gate it.
- **Vocabularies stay data.** Postures, distance bands, body locations, and
  scopes grow by data edit inside their owning registry rather than by widening
  a general-purpose contract to fit one domain.

---

## 17. Multi-entity / complex-case behavior

The simple case and the general case are genuinely different here, and success
on the first does not carry to the second.

- **Player toward a character** is the proven direction. It needs the player's
  own actor control and the character's directional grant, and — as long as the
  character does not have to move — nothing else.
- **Character toward the player** never requires a manufactured player grant;
  Vesper does not pre-authorize the player's response. The player still owns
  their own reaction, movement, acceptance, refusal, and reciprocation.
- **Character toward character** requires the receiving character's grant in
  that direction.
- **A character initiating romantic contact is not supported.** It would need
  both a character-side romantic producer and the authority to start a touch,
  neither of which is claimed.
- **Two characters acting in one reply** is handled by ordering the actions by
  where they appear in the prose, and failing closed when the order is
  ambiguous.
- **Supporting cast without a stable identity** is excluded rather than guessed
  at.
- **Successor chats** are out of scope until the character-chat contracts are
  proven; no parity is claimed for that lane.

---

## 18. Prompting / policy / rule interaction

Two different kinds of instruction reach the narrator, and confusing them is the
failure mode this section exists to prevent.

- **Binding physical guidance** — that a touch committed, that it was refused on
  physical grounds, that the premise of a sentence is wrong, or that a
  withdrawn touch must stop — is owned by narrator physical guidance. It is
  mandatory, and it does not wait for visual-state narration to be enabled.
- **Optional visual cues** — at most a couple of details worth mentioning — are
  owned by visual state and gated by its own per-chat switch.

Nonvisual phenomena reach neither until their sibling owner exists. Nothing may
smuggle a touch, a scent, or a taste into the visual path or into a
contact-specific narrator block.

The wording for an unanswered permission attempt carries the whole design, and
its two halves only look like the same rule:

| Must                                   | Must not                              |
| -------------------------------------- | ------------------------------------- |
| foreclose depicting the touch landing  | assert that a refusal happened        |
| leave refusing open as the character's | name permission, consent, or a record |
| state only the gap                     | claim a distance or a decision        |

"Do not assert a refusal" is not "do not depict one". Reading them as one
produces a line that forbids the character from declining at all — and since her
declining in prose is the only route by which a denial reaches the ledger, that
would make the denial path unreachable and leave her no way to say no.

Guidance never exposes permission records, relationship thresholds, override
metadata, or diagnostics, and it never authors the player's reaction.

---

## 19. Development stages

Five tracks. Track B is the only one whose remaining work is the owner's; the
rest are queued engineering or a hold awaiting evidence.

### Track A — operational review of already-built character movement authority

Status: hold — owner ruling 2026-08-18, reaffirmed 2026-08-22; keep shadow
measurement running and do not enable authority.

This is a hold pending evidence, not a rejection: the corpus that would justify
acceptance does not exist yet. Two conditions bind the eventual review. **Weigh
precision over recall** — a missed movement means Vesper failed to capture
something the narrator said, while a false commit means Vesper wrote
authoritative world state the narrator never said, and the second is far worse.
**Set the thresholds before reading the corpus** — a number chosen afterwards
describes the data instead of gating it. The pre-registered gate is written down
in the [character actor-control spec](romantic-contact-affordances.spec.actor-control.md)
and applies to movement alone; each later widening re-runs it.

1. Export and review the shadow corpus collected since 2026-08-10 with
   `pnpm report:npc-scene-decisions`. Status: queued — the instrument exists, a
   reviewed corpus does not.
2. Record trigger misses relevant to real actions, false positives and negatives,
   dominant drop reasons, p50/p95/p99 **settle wait**, timeout rate, token/spend
   coverage, and cost per hundred replies. Status: accuracy is blocked on a
   human labeling pass, which the reporting tool deliberately does not perform.
3. Make and record the owner's cost and quality ruling. Status: queued.
4. If accepted, widen authority one step at a time — movement, then starting a
   touch, then updating one — with an acceptance check after each. Status:
   queued.

The repository holds the instrument and the record that measurement opened. It
does not hold a reviewed corpus or an acceptance ruling, and neither may be
inferred from the existence of telemetry.

### Track B — the first genuinely romantic contact proof

Status: in progress — items 5–9 built 2026-08-18, item 10 next and owner-run,
item 11 ruled contingent on it 2026-08-22.

5. Build the narrow player romantic action producer. Status: complete —
   2026-08-18; a closed caress, stroke, and cup family on the ordinary body
   areas, refusing everything else rather than softening it.
6. Wire its attempt to the existing permission read and shared resolver without
   changing the affectionate path. Status: complete — 2026-08-18, with item 5.
7. Run deterministic and adversarial tests against the real permission seam.
   Status: complete — 2026-08-18; every case is covered by the pure suite except
   regenerate-and-restore, which the integration layer covers instead. The
   preserved matrix is:
   - grant present -> physically valid action commits;
   - no grant -> no contact commit;
   - reverse-direction grant -> no commit;
   - wrong scope -> no commit;
   - withdrawal -> no commit and dependent existing contact ends;
   - regenerate/retake -> permission/contact state restores;
   - ambiguous romantic evidence -> no action;
   - permission-neutral affectionate touch remains unchanged.
8. Enable romantic permission for a controlled window and run the first live
   player-to-character scenario. Status: complete — passed 2026-08-18. No grant
   refused the touch, permission did not override distance, an authorized
   reachable touch committed, a withdrawal ended a live touch, and regenerating
   left no duplicate. Both switches were reverted afterwards. Report:
   [first romantic proof trial](romantic-contact-affordances.trial.romantic-proof.md).
9. Close the two gaps that proof exposed. Status: built 2026-08-18 — awaiting
   live observation; the owner set both as rollout conditions. A refusal is no
   longer silent, and a character can now be named the way players name them — a
   unique first name and a name of more than one word both resolve, and an
   ambiguous one is still silence.
10. Rerun the live proof against the fixed lane, capturing evidence rather than
    a summary. Status: next — owner-run; the instrument is built and its grading
    is tested, and the run needs a deploy plus the proof switches for the window
    only. For every case preserve the sanitized input, the actual reply, the
    guidance handed to the narrator, and the pair's contact state before setup,
    after setup, and after the exchange. What it must prove is in §20.
11. Decide the production rollout of that specific romantic action surface.
    Status: owner-ruled 2026-08-22, contingent on item 10 — the surface stays
    test-only until the rerun passes, and ships if it does. The ruling waits on
    nothing else: not movement authority, kissing, intimate touch, body effects,
    or the sensory architecture, all of which stay on their own tracks. Do not
    read it as support for any other surface.

Track B does not wait on character movement authority unless a chosen scenario
asks a character to reposition voluntarily.

### Track C — visual contact continuity and presentation

Status: items 12–13 built 2026-08-22; item 14 next — nothing here was required
for the Track B rerun.

12. Add a first-class visual contact relation sourced from `CommittedContactRead`,
    so that "her hand is on your shoulder" can be rendered from structured truth
    rather than from the two partial signals available today. The feature must
    carry the contact id, source participant and source locus, target participant
    and target locus, plus only visually valid material/placement facts. Visual
    state still owns observer-specific visibility and selection. Status:
    complete — 2026-08-22; narration stays behind the per-chat visual-state
    switch, and the relation is deliberately not offered to images yet.
13. Route visual contact phenomena through visual state's own observation path
    rather than any contact-specific ranking. Status: complete — 2026-08-22;
    only visual candidates can reach visual state, every other sense is withheld
    with a recorded reason, and tests prove the leak is impossible.
14. Evaluate positive visual contact narration under the existing per-chat
    switch. Binding action outcomes remain independently available. Status:
    next — chats with the switch on can now receive relation lines, and this
    evaluation is what decides whether they read well.

### Track D — grounded contact effects and richer domains

Status: in progress — the pressure-mark first proof was built 2026-08-22 behind
a default-off switch and the residue/deposit owner shipped 2026-08-25; transfer
and the sensory owners remain.

15. Expand the body-surface owner to cover surface material and temporary
    condition — deposits, residue, and contact marks beside the existing wetness
    — rather than creating owners inside contact. Status: complete — 2026-08-25.
    A character can now carry mud, blood, dust, food, paint or cosmetics on a
    named part of their body, the continuity leg records it arriving and being
    washed off, and the narrator can be told about it. It is deliberately
    ungated: material on skin is ordinary body state, and hiding it behind the
    contact switch would have made it unrememberable for the continuity system
    that has nothing to do with contact. Surface products are the one part of
    the ruling still unbuilt.
16. Add effect transactions: the temporary pressure mark first, conserved
    transfer second, with garment changes delegated to wardrobe. Status: in
    progress — the pressure-mark transaction was built and proven 2026-08-22
    (commit, no double-commit on retry, clean removal on regenerate, readable
    afterward) and its switch stays off. Conserved transfer remains, and owner
    ruling (2026-08-25) settled that it lands **fixture-only** when it does: no
    pairing the chat lane can actually produce has an implemented owner on both
    sides, so nothing it committed would be conserved. Three separate gaps each
    have to close first, and they are named in the
    [effects spec](romantic-contact-affordances.spec.effects.md) §15 stage 8.
17. Build the shared nonvisual sensory presentation owner as sibling packages
    beside visual state, before any touch, smell, or taste cue reaches live
    narration. Status: queued.
18. Register only foot phenomena whose complete truth and perception path
    exists; keep the rest fixture-only. Status: queued.
19. Expand calibration from the foot fixtures using semantic bands and
    source-backed state only. Status: queued.

### Track E — intimate contact

Status: blocked on the Track B rerun, the exact future scopes, and the missing
physiology, body-surface, and sensory owners.

20. Define the exact scopes beyond romantic touch alongside the action families
    that need them.
21. Land the required physiology and body-surface owners.
22. Prove exposure and access from wardrobe, scene, permission, and
    channel-specific perception together.
23. Only then register intimate phenomena, and run a dedicated leak-prevention
    trial.

---

## 20. Evaluation criteria

| Dimension       | What is being evaluated                                     |
| --------------- | ----------------------------------------------------------- |
| Correctness     | Does the record match what actually happened in the scene?  |
| Authority       | Did only the right person author each change?               |
| Degradation     | Does a missing fact produce silence rather than a guess?    |
| Prose agreement | Does the reply avoid contradicting the record?              |
| Reliability     | Do retry and regenerate leave exactly one coherent cut?     |
| Performance     | Is the added wait per turn acceptable at the tail?          |
| Cost            | Is the improvement worth the per-reply spend?               |
| Maintainability | Did any owner acquire a second copy of somebody's truth?    |
| Reproducibility | Does the same restored cut replay to the same result?       |

**The Track B rerun (item 10)** grades every case twice and must pass both. The
first grading is what the case required of the world: the action produced, the
resolver's verdict and its reason, the durable commits, which touches are live
and which ended, where permission stands, whether a denial bound to the right
attempt, the kind of guidance handed to the narrator, and identity across a
regenerate. The second is whether the prose contradicts what was recorded. Prose
consistency alone can never pass a case. The required cases are: no grant,
explicit denial, natural named phrasing, a commit, a withdrawal, and a
regenerate.

**Track A's movement gate** is pre-registered and lives in the
[character actor-control spec](romantic-contact-affordances.spec.actor-control.md):
a minimum corpus size spread over enough distinct chats, a precision bar with a
statistical lower bound, a zero-tolerance failure class where a single instance
disqualifies, a deliberately loose recall bar, a timeout ceiling, an added-wait
ceiling at the tail, and a cost figure the owner sets. Precision and recall
require a human labeling pass; no amount of extra telemetry produces them.

---

## 21. First proof before substantial implementation

The cheapest experiment that could have disproved this architecture was to put a
real romantic attempt in front of a real permission owner in one controlled live
scenario — before building effects, the sensory architecture, or any intimate
mechanics. It cost one narrow producer plus a seeded grant, and it had a clean
pass or fail reading: either the character's own recorded decision governed what
became true, or it did not.

It ran on 2026-08-18 and passed, and it earned its keep immediately by exposing
two things no test had: an unanswered permission owner told the narrator nothing,
so the prose described the touch as landing; and no written form of a
character's name reached a name of more than one word, so ordinary writing met
silence. Both are closed, and the rerun that confirms them is the plan's next
step.

The same discipline governs Track D. Owner ruling (2026-08-22): the first effect
proof is the temporary pressure mark, not conserved transfer, because the mark
is the smallest thing that still exercises the whole chain from commit through
retry, regenerate, and a later read.

---

## 22. Explicit non-goals

Deliberately outside this work, however adjacent:

- kissing;
- intimate anatomy or internal contact;
- undressing another participant;
- nudity-exposure permission;
- sex;
- restraint or pinning;
- a full skeletal pose solver;
- automatic emotional or physiological reactions;
- contact-created residue or marks without a state owner to hold them;
- contact-specific visual memory or narrator ranking;
- a contact-specific memory system for touch, scent, or taste;
- successor-lane parity before the character-chat contracts are proven;
- broadening or weakening the affectionate detector to make the romantic lane
  easier;
- responding to a leaked phrase by adding it to a list of forbidden words.

Approving the romantic surface's rollout approves that surface and nothing else.
Worthwhile adjacent work discovered along the way is recorded separately rather
than folded in here.

---

## 23. Risks and open questions

**Does the character shadow corpus meet the pre-registered gate for movement
authority?**

- *What is unknown:* whether the movements proposed from character replies are
  accurate enough, fast enough, and cheap enough to be allowed to write world
  state.
- *Why it matters:* a false commit writes authoritative state the narrator never
  said, which is a far worse failure than missing a movement, and it is the
  failure that would corrupt the authority itself.
- *How it should be resolved:* owner ruling (2026-08-22, reaffirming
  2026-08-18) is HOLD — continue shadow collection. Movement authority may be
  reconsidered only after the pre-registered sample requirement is met, the
  corpus receives a human accuracy labeling pass, latency, timeout, and cost are
  recorded, and the acceptance gate in the
  [character actor-control spec](romantic-contact-affordances.spec.actor-control.md)
  is evaluated. The repository contains no evidence that permits an accept or
  reject decision, so the question stays open.

The remaining risk on Track B is narrower and is not an open question: the
romantic lane's strictness may refuse ordinary romantic prose more often than is
comfortable. That is a known, one-directional cost — silence where a commit
would have been acceptable, never the reverse — and the rerun is what measures
whether it bites.

Every other question this plan once carried — the romantic surface's rollout,
the sensory package boundary, whether the shared observation contract should
carry a channel, who owns residue and marks, which effect to prove first, the
shape of future permission scopes, and whether a relationship change should
revoke permission — was resolved by owner rulings on 2026-08-22 and is recorded
in this plan and in the reconciled companion
[effects spec](romantic-contact-affordances.spec.effects.md) and
[permission spec](romantic-contact-affordances.spec.permission.md). Their future
implementation slices must follow those recorded rulings rather than reopening
the settled product questions implicitly.

---

## 24. Definition of done for the next implementation phase

This is the promotion gate for the **next implementation phase**, not a claim
that every Track D/E item in this long-running plan is complete. Before new
contact-domain mechanics are promoted, documentation and code must agree that:

1. A real action producer exists for every action kind being tested.
2. Every required authority read has an owner; unknown fails closed.
3. Contact truth commits before any observation or presentation consumes it.
4. Visual contact facts enter visual state and use its visibility, attention,
   memory, and selection path.
5. Nonvisual facts do not enter visual state.
6. No second contact-owned cue memory or presentation capture exists.
7. Regenerating/retaking restores contact, permission, effects, and presentation
   owners to the same cut.
8. Permission scope/direction and actor control remain orthogonal to physical
   feasibility.
9. Effects cannot appear before their owner transaction commits.
10. Tests prove negative cases as strongly as the happy path.
11. For any rollout slice whose flag-off identity is part of its contract,
    turning that switch off restores the previously pinned behavior.

---

## 25. Documentation requirements

Rulings and reasons get written down; the sequence of work does not. When a
slice lands, its spec records what is built and any ruling the build settled;
when a spec completes, this plan records that in one line; when behavior ships
to players, the matching reference doc under `docs/` is updated in the same
change.

The effects and permission companion specs were reconciled to the 2026-08-22
owner rulings on 2026-08-22. Future implementation work must update the relevant
companion spec and this plan together whenever a later owner ruling changes one
of those boundaries.

Companion documents for this topic:

- [technical index](romantic-contact-affordances.spec.md)
- [shared contact core](romantic-contact-affordances.spec.contact-core.md)
- [scene and body relations](romantic-contact-affordances.spec.scene.md)
- [character actor control](romantic-contact-affordances.spec.actor-control.md)
- [directional permission owner](romantic-contact-affordances.spec.permission.md)
- [observations, effects, and sensory routing](romantic-contact-affordances.spec.effects.md)
- [foot domain](romantic-contact-affordances.spec.foot.md)
- [intimate domain](romantic-contact-affordances.spec.intimate.md)
- [truth-source audit](romantic-contact-affordances.audit.md)
- [affectionate trial](romantic-contact-affordances.trial.md) and its
  [evidence appendix](romantic-contact-affordances.trial.evidence.md)
- [first romantic proof trial](romantic-contact-affordances.trial.romantic-proof.md)
  and its
  [evidence appendix](romantic-contact-affordances.trial.romantic-proof.evidence.md)

Neighbouring owners whose plans this work depends on:
[visual state and attention](visual-state.plan.md),
[constraint-first narrator guidance](narrator-physical-guidance.plan.md), and
the [clothing state graph](clothing-state-graph.plan.md).