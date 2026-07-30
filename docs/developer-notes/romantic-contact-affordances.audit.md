# Romantic contact affordances — truth-source audit

Status: slice 0 detail for
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(code verified 2026-07-30)

## Purpose

Record which inputs the contact resolver may treat as authoritative **today**,
with a file/line for every claim. This is the baseline the plan's slice 0
demands: it stops a coding agent from satisfying a missing state contract by
parsing narrator prose, by reading an adjacent fact as the one it needs, or by
assigning an optimistic default.

Every row below was re-read in the working tree. Where a capability is absent,
the searches that came up empty are named, because "we could not find it" and
"it does not exist" have to be distinguishable a release from now.

The body-side companion is the
[body-affordance readiness audit](body-attribute-affordances.audit.md); the
lane summary in
[romantic-contact-affordances.spec.md](romantic-contact-affordances.spec.md)
§"Current lane capability audit" is the same picture at promotion, without
citations. Where they differ, this document is newer.

## Owner decisions needed

**All three RULED 2026-07-30.** Three questions the plan assigned to slice 0 had **no ruling anywhere in the
repo** at audit time. Searching all six `engine.spec*.md` files for
`minor|adult|age.?verif|underage` returned zero hits; §39
(`engine.spec.operations.md:342`) held 33 rulings of which exactly one —
ruling 16, interpersonal consent — touches this area, and it governs the
successor ledger only. Each item below carried a RECOMMENDED default that the
contracts implemented so slice 1 could ship. **The owner ruled on all three on
2026-07-30, after the slice-2 QA report; each ruling is recorded inline
below.** The evidence sections stay as written — they are why the defaults
took the shape they did.

### 1. Does the foot trial require an adult-eligibility proof, and what is one?

The existing fence is **negative and fails open**. `isMinorAge`
(`src/contracts/world/life-stage.ts:149`) returns `lifeStageForAge(age)?.minor
?? false`, and `lifeStageForAge` returns `undefined` for any non-numeric age
(`:142`) or any age above `LIFE_STAGE_MAX_HUMAN_YEARS` 120 (`:144`). So `""`,
`"ancient"`, `"seventeen"`, and `"312"` all read **adult**. The player persona
has no age at all — `personaProfileSchema`
(`src/contracts/players/persona-profile.ts:36-61`) omits the field by design, so
`personaToCharacterProfile` always yields `age: ""`. Meanwhile
`CONTENT_FRAMING` asserts in the prompt that *"Everyone taking part in romantic
or intimate content is an adult"* (`src/server/engine/prompts/charter.ts:49`)
— an unverified claim about one of the two participants in every scene.

**RECOMMENDED default (implemented in slice 1, not a ruling):** the contact core
requires an explicit `ContactParticipantEligibilityRead` covering **every**
participant for `romantic` and `intimate` action kinds, and treats `unresolved`
and `not_required` as rejections for those kinds. A lane adapter maps a
resolved non-minor life stage to `eligible`, a minor band to `ineligible`, and
**everything else — unparseable age, absent age, over-120 age, and the player
persona — to `unresolved`**. Consequence: the foot trial ships at the
`affectionate` action kind (no eligibility gate) and romantically-framed contact
fails closed in legacy chat until the owner rules.

**What the owner must decide:** (a) whether the player persona gains an
age/eligibility declaration, and (b) whether an unknown or fantasy-scaled
character age reads `unresolved` for contact even though today's prompt fence
reads it as adult. Inverting `life-stage.ts:150`'s `?? false` is a repo-wide
behaviour change across 19 call sites and is deliberately **not** proposed here.

**RULING (owner, 2026-07-30):** add an explicit
`adult | minor | unresolved` **eligibility declaration**, independent of
numeric/display age. Every participant — player persona included — must be
**positively adult** for `romantic` or `intimate` contact; fantasy-scaled ages
and the ageless player persona remain `unresolved` (and therefore fail closed)
until they carry the declaration. The repo-wide `isMinorAge` fail-open fallback
is **not** changed as part of this feature. The slice-1 default above is
confirmed as the permanent gate; the declaration itself is new build work owned
by the intimate-prerequisite track (plan slices 5–6 precondition), not by the
foot slices.

### 2. What proves actor control in legacy chat?

Legacy chat has **no typed actor-control gate**. `checkPuppetContradiction`
exists (`src/contracts/personality/puppet.ts:56`) but is dead code — its
producer `IntentBrief.narratedNpcBehaviors` and its consumer
`buildPuppetDeflection` have zero call sites, and `src/contracts/turns/intent-brief.ts`
and `src/server/engine/scene.ts` do not exist. The only live mechanism is prompt
text, and it runs the **opposite** direction: `character-chat.ts:2093` protects
the *player* from the narrator. A search of every prompt builder for a
player→NPC restraint (`writes? (you|your)|puts words|player may not|…`) returns
nothing.

What is typed is `inputMode: "player" | "narrator"`
(`src/server/engine/chat-pipeline.ts:208-212`, persisted at `:557` in
`character_chat_messages.meta`), and narrator mode is an explicit **grant** of
NPC-authoring power, not a restraint.

**RECOMMENDED default:** an interpersonal contact commits only with an explicit
`allowed` control decision. The legacy adapter (slice 3) resolves `allowed` when
the acting surface belongs to the player persona; `denied` when a
`inputMode: "player"` turn asserts an NPC's voluntary movement; and `allowed`
for an NPC actor when the movement came from the narrator model's own reply.

**What the owner must decide:** whether `inputMode: "narrator"` — today's
blanket authoring grant — extends to committing physical contact **on an NPC's
body**, or whether physical contact is carved out of narrator mode.

**RULING (owner, 2026-07-30):** player input may commit only
**player-controlled** movement; NPC movement must originate from the
NPC/narrator/simulation side. Narrator mode's general authorship grant does
**not** bypass target agency or consent — committing contact on an NPC's body
still requires the target-agency and permission gates, whatever the input
mode. The slice-1/slice-3 default above is confirmed, with the narrator-mode
carve-out resolved in the restrictive direction.

### 3. What permission rule applies to the first foot trial?

Legacy chat has **no consent grant of any kind**. `chatSceneIsIntimate`
(`src/contracts/turns/chat-intimacy.ts:55-59`) is `characterExposed ||
playerExposed || arousal >= 0.55` — derived from exposure and a meter, exactly
the derivation the contact spec forbids. `resolveTouchWelcomeness`
(`src/contracts/mood/events.ts:59-64`) is a mood projection off affinity that
gates nothing. `ChatCueHint.intimate` is a regex over the player's message
(`src/server/engine/chat-intent.ts:58`).

The successor ledger is real, typed, and fail-closed —
`consentScopeKeys = ["closeness","kiss","touch_intimate","undress","sex"]`
(`src/contracts/simulation/social.ts:49`), `resolveConsentCoverage` returning
`relevant[0]?.kind === "permission_granted"` (`:437-453`), checked in
`resolveStartActivity` (`src/lib/simulation/activities.ts:252-263`) with
`consentCovered` defaulting to `false`
(`src/server/engine/simulation/activity-store.ts:995-1008`) — but **no seeded
action definition declares `consent_covered`**; both seeded worlds use only
`at_zone_kind`. The machinery is built and dark.

**RECOMMENDED default:** scope-split by action kind. `incidental`, `casual`, and
`affectionate` contact need no permission owner in legacy chat — that is the
ordinary social contact the lane already narrates freely, and requiring a grant
the lane cannot produce would block every fixture. `romantic` and `intimate`
require an explicit `allowed` `ContactInteractionPolicyRead` whose scope list
covers the action, which legacy chat cannot yet produce, so those kinds fail
closed. This neither loosens what the lane does today nor manufactures a grant.

**What the owner must decide:** (a) which action kinds require a permission
owner in legacy chat, and (b) whether foot play framed as fetish or romantic
attention is classified `affectionate` (ships now) or `romantic` (blocked until
a legacy permission owner exists). The plan's own rule — *"Ordinary or
fetish-framed foot contact cannot bypass NPC agency"* — constrains actor control
(decision 2), not the permission scope, and does not answer this.

**RULING (owner, 2026-07-30):** ordinary incidental or affectionate social
touch stays **permission-neutral**. Foot play framed as romantic or fetish
attention is classified **`romantic`** and requires an explicit permission
scope — it must **not** be relabeled `affectionate` solely to let the first
live trial commit. Consequence accepted: the romantically-framed foot trial
stays fail-closed in legacy chat until a legacy permission owner exists;
building that owner is part of the slice-3 lane wiring, not a reason to widen
the classification.

## Capability matrix

Verdicts are **trustworthy** (an authoritative owner exists and the contact
resolver may read it now), **deferred** (an owner exists but is too narrow, or a
named prerequisite is queued), or **absent** (no owner; the dependent
observation is omitted or fixture-only).

| Truth source | Legacy character chat | Successor chat | Verdict |
| --- | --- | --- | --- |
| Pose / posture / articulation | `movement.posture_default` (`src/contracts/attributes/categories/movement.ts:31-58`) is a character-sheet resting posture whose own description defers to a "scene posture in participant state" that does not exist. `SceneSpec.pose` (`src/server/images/prompts.ts:512`) is free text authored per image render and never read back. | No pose, posture, stance, or articulation state. Closest is `activityClaimSchema` `{kind:"body"}` (`src/contracts/simulation/activities.ts:50-53`) — one occupancy bit. | **absent** |
| Reach / proximity / distance | Binary `ChatState.presence` (`src/server/engine/chat-state.ts:376`); `ChatCueHint.proximity` is a regex over the turn's text (`src/server/engine/chat-intent.ts:36`); detail tier is the constant `CHAT_RECOGNITION_BASE_DETAIL_TIER = 2` (`src/server/engine/chat-recognition-adapter.ts:71`). `chat-intimacy.ts:7`: *"it has no proximity model and no per-sense brief."* | Zone-granular only. `physicalLocusSchema` (`src/contracts/simulation/space.ts:139`); proximity is zone equality (`src/server/engine/simulation/body-store.ts:531`). `coordinateSchema` (`space.ts:60`) is stored and never computed with. | **absent** for body-to-body reach |
| Support / furniture | Bodies have none. Garments have a free-text `scene` anchor documented as *"not a spatial model"* (`src/contracts/items/garment-instance.ts:72-73`). `supportedBy`/`restingOn`/`seatedOn` → 0 hits. | Actors have only `at` / `in_transit`; items have a locus union, actors do not. | **absent** |
| Clothing state | Authoritative structured graph: `garmentInstanceStateSchema` (`src/contracts/items/garment-instance.ts:314-331`), closures `:95-107`, displacement `:118-130`, condition + deposits + damage `:261-283`, store `:391-428`, persisted `src/server/db/schema.ts:300`. | Absent. Worn slots are free-text strings (`src/contracts/simulation/materials.ts:51-52`); no parts, layers, closures, or coverage; no `sim_garments` table. Clothing-state slice 7 adapter unshipped, verified in code. | **trustworthy (legacy)**, **absent (successor)** |
| Effective coverage | `garmentEffectiveCoverage` (`src/contracts/items/garment-effective-coverage.ts:96-125`); banded read `effectiveCoverageBands` + floors (`src/contracts/items/effective-coverage-read.ts:43`, `:117-124`), captured per actor (`garment-instance.ts:405-428`). Note the band is a **maximum** across covering regions, and an uncovered location has **no entry at all** (`effective-coverage.ts:34-38`). | Coarse worn-name join only (`src/server/engine/sim-surfaces.ts:419`). | **trustworthy (legacy)** |
| Material between two surfaces | **Absent.** `grep materialBetween\|material_between` over `src/` → 0. The nearest primitive, `GarmentBodyContactRead` (`src/contracts/affordances/domains/garment/frame.ts:76-87`), is garment↔own-body and only self-establishes for `fitted`/`tight` fits. `resolveWardrobeVisibility` (`src/contracts/items/visibility.ts:55-94`) answers which *garment* is on top, never what lies between actor A's hand and actor B's foot. | Absent. | **absent — built by this plan** |
| Body surfaces | `BodySurfaceState` (`src/contracts/state/body-surface.ts:165-173`) is **wetness only**, per body location, fixed-point, with a quarantine third state (`:128-138`). Primary character only (`:48-52`), persisted `src/server/db/schema.ts:754`. The proposal vocabulary caps it further: `surfaceWetnessLocations = ["hair"]` (`src/contracts/turns/chat-surface-ops.ts:64`). | Absent — zero imports of `body-surface.ts` from any `simulation` tree. | **deferred** — one channel, one writable location; products, residue, marks, temperature have no owner |
| Physiology | Six float meters (`src/contracts/meters/registry.ts:36-105`); `arousal` at `:71` is the only physiological scalar. Erection, lubrication, swelling are authored **tendency** attributes explicitly documented as *"not live state"* (`src/contracts/attributes/categories/intimate/vulva.ts:281-299`, `penis.ts:11`). No sweat meter; every `temperature` hit in `src/` is LLM sampling temperature. | Fixed-point body meters (`src/contracts/simulation/bodies.ts:154-249`) with `arousal` at `:195-206`; reads `deriveIntimacyRead` / `deriveVisibleBodySigns` (`src/lib/simulation/body-reads.ts:176`, `:196`). `visibleBodySigns` (`bodies.ts:499`) deliberately excludes contact/exposure-gated signs — *"the vocabulary having no such member is what makes leaking it impossible"* (`:493-498`). | **absent** for every contact-relevant physiology read |
| Adult eligibility | Negative fence only; **fails open** on unparseable/absent/over-120 ages (`src/contracts/world/life-stage.ts:142-151`); 13 prompt surfaces in `character-chat.ts` consume it. Player persona has no age (`src/contracts/players/persona-profile.ts:36-61`). No content-rating flag on user, chat, character, or world (`contentRating`, `isAdult`, `ageVerif`, `underage` → 0 hits). | Same derivation in `sim-render.ts:587`, `sim-solo-render.ts:175`. No contact-specific eligibility contract. | **deferred** — usable as a negative fence, never as a positive adult proof; see owner decision 1 |
| Consent / permission | **Absent as a grant.** `chatSceneIsIntimate` is exposure ∨ arousal ≥ 0.55 (`src/contracts/turns/chat-intimacy.ts:55-59`); touch welcomeness is a mood projection (`src/contracts/mood/events.ts:59-64`); the escalation floor is a prompt sentence that yields to the scenario (`src/contracts/relationships/law.ts:356-358`). | **Trustworthy but idle.** Typed scopes (`src/contracts/simulation/social.ts:49`), fail-closed resolution (`:437-453`), precondition wiring (`src/contracts/simulation/activities.ts:94-97`; `src/lib/simulation/activities.ts:252-263`), default `false` (`activity-store.ts:995-1008`). Zero seeded actions declare it. | **absent (legacy)**, **trustworthy but unused (successor)** |
| Actor control / NPC puppeting | **Absent as a gate.** Prompt text only, protecting the player from the narrator (`src/server/engine/prompts/character-chat.ts:2093`). `checkPuppetContradiction` (`src/contracts/personality/puppet.ts:56`) is unwired dead code. `inputMode` (`chat-pipeline.ts:208-212`) is a typed authoring **grant**, not a restraint. | Three layers: account ownership (`src/server/engine/simulation/command-authz.ts:119`), `controlledActorIds` (`src/contracts/simulation/envelopes.ts:50`, enforced at `src/lib/simulation/activities.ts:231`), and per-action `controllerKinds` (`activities.ts:147`, `:236-238`). | **absent (legacy)**, **trustworthy (successor)**; see owner decision 2 |
| Perception / exposure | Wardrobe visibility `visible`/`hinted`/`hidden` plus a turn-level `ChatSensoryAllowance` (`src/server/engine/chat-intent.ts:76-84`). No per-sense proximity mask. | `observationChannels` includes `touch` and `smell` (`src/contracts/simulation/perception.ts:35`) but **no deriver emits them** — `src/lib/simulation/perception.ts` emits only `embodied`, `device`, `sight`, `sound`, `social`. Detail tiers 1–3 at `perception.ts:61`. | **deferred** — sight/coverage usable; **tactile, olfactory and gustatory channels are absent in both lanes** |
| Active contact lifecycle | **Absent.** Both typed contact reads that exist (`GarmentBodyContactRead`, `HairBodyContact`) are own-body, and neither is ever supplied: `recordedFit()` returns `undefined` by construction (`src/server/engine/chat-garment-affordances.ts:125-127`), so `contacts` is always omitted and the adapter reports *"unavailable (no typed contact owner)"* (`src/server/engine/chat-affordances.ts:78`, `:538`). | Absent. `grep -i contact` across `contracts/simulation`, `lib/simulation`, `server/engine/simulation` → two prose comments asserting the absence. | **absent — built by this plan (slice 1)** |
| Turn capture / retake | **Trustworthy.** Two whole-blob anchors: `pre_exchange_scenario` (`src/server/db/schema.ts:349-350`) and per-character `pre_exchange_state` (`:590-595`); `rollbackScenario` restores everything except accrete-only `supportingCast` (`src/server/engine/chat-state.ts:769-771`); three-way load result with a `chat_state.snapshot.missing` degrade path (`chat-pipeline.ts:674-681`). | Cut compile + re-render are pure and hash-verified (`src/lib/simulation/narrative.ts:368`; `src/server/engine/simulation/narrative-cut-store.ts:92`), but the player-facing retake is **refused** at the route (`src/app/api/chats/[chatId]/sim-routing.ts:74-81`). | **trustworthy (legacy)**, **deferred (successor)** |
| Foot sub-regions | `bodyLocationRegistry` realizes `feet → toes, top_of_foot, sole, heel` (`src/contracts/body/locations/everyday.ts:44-53`). **`arch`, `ball`, and `nails` are not body locations** — `feet.arch` and `feet.nails` exist only as authored appearance attributes (`src/contracts/attributes/categories/feet.ts:26`, `:40`). | Same shared registry, unused by the simulation lane. | **deferred to slice 2** — the foot spec's topology needs three loci the registry does not have |

## Adapter result law

Unchanged from the body audit, and the contact core encodes it as `AdapterRead<T>`
(`src/contracts/affordances/core/types.ts:100-103`): a lane input is
**supported** (value + provenance), **unavailable** (no owner, or no fact for
this cut), or **invalid** (a trust-boundary value failed parsing). The two
failure states carry no value at all, so no code path can read one as bare, dry,
motionless, in reach, permitted, or in contact.

One contrast worth stating, because the two owners chose opposite repairs. A
corrupt **body-surface** entry is quarantined rather than dropped
(`src/contracts/state/body-surface.ts:140-163`), because an absent entry there
means *dry* and dropping would launder unknown into a physical claim. A corrupt
**contact** entry is dropped, because an absent contact means *no contact*,
which is already the conservative answer — dropping cannot buy a claim.

## Slice 0 exit

1. Pose, reach, support, material-between, tactile perception, actor control
   (legacy), permission (legacy), and the active contact lifecycle are all
   recorded **absent**, not assumed. ✔
2. Clothing state, effective coverage, and the legacy retake boundary are
   recorded **trustworthy** with citations. ✔
3. Body surfaces, adult eligibility, successor consent, successor perception,
   successor retake, and foot sub-regions are recorded **deferred** with the
   specific narrowness that makes them so. ✔
4. The three product questions slice 0 was told to settle have RECOMMENDED
   defaults implemented in slice 1 and are flagged above as unresolved. ✔
5. First production lane: **legacy character chat**. Second-lane parity claim:
   **contract-level only** — the successor lane can supply actor control and
   consent but has no garment adapter, no pose, no reach, and no surface state,
   so its contact adapter would report `unavailable` for every geometry and
   material input. Successor parity is a named follow-up (plan slice 7). ✔
6. Missing inputs have diagnostic codes and conservative fixtures (below). ✔

## What slice 1 therefore builds, and what it must not

Because pose, reach, support, and material-between have **no owner in either
lane**, slice 1 ships the lifecycle as a set of pure contracts over
`AdapterRead`-shaped inputs, with no lane wiring and no storage. A lane that
cannot answer reports `unavailable`, and the resolver returns `unresolved` —
never a committed contact. This is the same shape the body audit's ruling took
for hair↔skin contact ("fixture-only — no typed contact owner exists; reach
never invents contact"), and it stays true until an owner ships.

The plan's slice 2 (foot) therefore inherits three concrete blockers, all
recorded rather than worked around:

- **no reach owner**, so every foot fixture supplies geometry explicitly;
- **no tactile perception channel**, so `foot.surface_texture_contact` is
  fixture-only until a lane asserts `touch`;
- **no regional surface state beyond `hair` wetness**, so `foot.glide_response`,
  `foot.scent_proximity`, and `foot.contact_temperature` have no production
  source. Contact temperature in particular has **no** authoritative read in
  either lane — the plan's open question *"Can contact warmth join the foot
  milestone?"* resolves **no** on today's evidence.

## Diagnostic convention

Contact diagnostics use stable dotted codes under the `contact.` namespace,
mirroring `affordance.input.unavailable` and `guidance.disclosure.leak` rather
than the bare underscore names sketched in
[the technical index](romantic-contact-affordances.spec.md#degraded-behavior).
The codes slice 1 actually emits, with severities, are listed in
[the contact-core spec](romantic-contact-affordances.spec.contact-core.md#as-built--slice-1)
§"As built". Severity follows the house rule: a missing owner is `warn`
(degraded but expected today), a malformed value is `error` (nobody meant it),
and an ordinary refusal — permission denied, out of reach — carries **no**
diagnostic, because it is an answer rather than a degradation.
