# Constraint-first narrator physical guidance

Status: active — slices 0–3 shipped 2026-07-30/31; slices 4–6 remain. The
constraint path is **live in production**.

Outcome: A player can misstate what a character's body is doing — calling
braided hair loose, or reaching for someone who is too far away — and still get
a reply that stays true to the scene, so that the narration stops agreeing with
a mistake the player just made.

## In one sentence

Use committed physical truth primarily to prevent impossible or contradictory
narration, correct false premises, and report resolved actions; offer a positive
descriptive detail only when a relevant state change has independently earned
the beat.

## Where this stands

**The feature is live, not an experiment.** `CHAT_PHYSICAL_CONSTRAINTS` has been
`on` in production since 2026-08-02 — a deployed secret, set as a condition of
the affectionate-contact enablement recorded in
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md).
Constraints, corrections and action outcomes reach live narrator prompts today.
The *source* default is still off, so "experimental, default off" describes the
code and not what players receive; it is not a safe summary of this feature's
status. The accurate one is that the constraint path is live and slice 5's
campaign has never measured it.

Shipped:

- **Slices 0–2 (2026-07-30)** — evidence preserved and the old cue path frozen;
  the shared guidance contracts and compiler; the hair constraint/correction
  proving path. The owner-review corrective pass and slice 2.1 applied the same
  day: clause-local claim binding, constraint relevance gating, provenance truth
  decoupled from the 60-minute cue-freshness window, the disclosure gate made an
  allowlist, and the inspector's missing `/self/` twin.
- **Slice 3 (2026-07-31)** — shipped through the chat lane's affectionate-contact
  leg rather than a foot-domain resolver (see §Slice 3).

Remaining:

- **Slice 4** — change-gated positive detail. Gated on a design decision, not
  code: `CHAT_PHYSICAL_TRANSITIONS` does not exist, and the transition tier now
  carries a mandatory tenant that slice 4 cannot displace.
- **Slice 5** — both trials unrun, and the committed trial-record format is still
  shaped for the closed cue campaign.
- **Slice 6** — successor adapter, not started.

As-built technical detail is in
[narrator-physical-guidance.spec.md](narrator-physical-guidance.spec.md).

## Decision

`CHAT_AFFORDANCE_CUES` remains off. Do not revive or rename its always-on
positive-cue projection.

Keep the affordance engine, domain profiles, current-state reads, evidence,
perception gates, provenance/degree wording improvements, retake capture, and
evaluation harness. Replace only the narrator-facing policy.

The replacement has four distinct outputs:

1. **Consistency constraints** — scoped claims the narrator must not make.
2. **Premise corrections** — high-confidence contradictions in the player's
   framing that the narrator must not adopt.
3. **Resolved action outcomes** — what an attempted physical action actually
   did, could not do, or requires before it can occur.
4. **State-change details** — at most one optional positive fact, only when the
   committed state changed and the current action or attention makes it relevant.

The first three form the initial release. State-change details are a separate,
default-off experiment with their own decision rule. Generic descriptive
opportunities remain parked until either a later domain supplies evidence for
them or the state-change design proves that positive guidance can add grounded
detail without increasing contradictions.

## What the trial established

The closed
[affordance-cue trial](body-attribute-affordances.trial.md) supports a narrow
shipping decision:

- the tested positive cue block did not earn default-on status;
- the cause/degree wording correction fixed the targeted provenance failure;
- increased specificity did not produce a net contradiction reduction;
- category-local gains in false-premise handling and repetition were promising
  but did not reproduce consistently across both valid rounds;
- hair wetness and motion through one narrator model do not establish how
  garment, contact, pose, or future-model guidance will behave.

The working hypothesis is that volunteering a concrete physical detail raises
the number of checkable claims. That is plausible and matches the specificity
results, but the small, high-variance trial did not prove it as a universal
causal law. This plan therefore removes forced positive detail from the first
release and measures claim opportunity explicitly in the next trial.

## Experience we want

If Wren's hair is soaked from a bath and remains braided, a player may say,
"The storm drenched your loose hair." The narrator should not silently adopt
rain as the cause or describe loose hair streaming in the wind. It also should
not be forced to mention Wren's hair merely because the system knows the
premise is wrong. It may ignore the mistake, have Wren correct it naturally, or
respond around it while keeping the physical account true.

If a player tries to touch a character's head while the committed pose puts it
out of reach, the contact resolver decides the result before prose generation.
The narrator receives the resolved result — no contact occurred, a small
committed adjustment made it possible, or an explicit transition is required —
instead of a gentle hint about pose.

If a towel has just changed soaked hair to damp hair and the current beat
already concerns drying off, one positive transition may be offered. If the
conversation is about something else, the correct output is silence.

## Boundaries

- This is a projection and action-result layer, not a second physics engine.
- It reads committed state, committed events, and resolver results. Narrator
  prose is never promoted to physical truth.
- A player's assertion does not rewrite world state merely because it appears
  in dialogue.
- Storyteller-authoritative narration and controlled-actor action intents are
  not treated as ordinary false premises. They go through the lane's applicable
  state/action authority first.
- Missing data never becomes a positive fact. An unresolved input may prohibit
  an unsupported assertion, but it cannot supply a guessed alternative.
- Full feasibility, permission, consent, and actor control remain resolver
  responsibilities. Prompt text cannot grant them.
- Hidden state may constrain a resolver without entering the narrator prompt.
- The narrator never receives private sensory or internal-response facts that
  its current viewpoint cannot know.
- No new model call is added to the turn. Selection, conflict checks, and prompt
  rendering are deterministic.
- Recognition cues remain a separate identity/memory concern.
- Image consumers continue to read structured affordance results, not this
  narrator-specific projection.

## Architecture

### 1. Physical truth stays domain-owned

The existing affordance pipeline continues to produce observations,
constraints, suppressions, evidence, and diagnostics. The romantic-contact
core produces committed contacts, access results, contact constraints, effects,
and action outcomes. Clothing, physiology, scene/body relations, and the
successor engine remain authoritative for their own state.

No domain formats narrator instructions. Domain code emits stable semantic
ids, bands, cause tags, locations, participants, and evidence.

### 2. A lane-neutral guidance compiler classifies results

A pure compiler sits outside the domain-neutral affordance core. It combines
eligible domain results with the current action result and turns them into
guidance candidates of the four kinds above — each one carrying who it is
about, which body part it concerns, what the narrator may and may not claim,
who is allowed to be told, the evidence behind it, and a deterministic identity
so two runs over the same committed state produce the same guidance in the same
order.

Domain semantics stay opaque ids the compiler carries rather than strings it
reads. The contract shapes as built, and every difference between them and this
proposal, are recorded in
[narrator-physical-guidance.spec.md](narrator-physical-guidance.spec.md).

### 3. Input authority is resolved before premise checking

The current message must first be classified using the chat lane's existing
input modes:

- **Character dialogue or an ordinary conversational assertion** — may be
  mistaken, so it is eligible for high-confidence premise checking.
- **A player-controlled action intent** — goes through the applicable
  action/contact resolver, and the outcome rather than the requested result is
  what reaches narration.
- **Storyteller-authoritative narration** — a proposed authoritative event or
  state change, never a false premise. Until a pre-narrator commit seam exists
  for that fact, it is excluded from automatic correction outright.
- **Out-of-character direction** — an instruction to the narrator, not physical
  evidence by itself.
- **A private thought** — not perceived by characters, and not a physical-state
  write.

This prevents a stale pre-turn read from "correcting" a legitimate,
author-authorized state change.

### 4. Deterministic risk and premise detection

Do not add a general LLM claim-extraction leg. The first release uses:

- structured action intents and resolver outputs where available;
- the current message's existing input-mode parse;
- a small domain-owned lexicon of exact physical claims for tested enums and
  bands;
- entity, body-locus, and domain references in the current message;
- recent committed action context when the current message continues it.

The detector may emit:

- `contradicted` only when committed truth directly conflicts with a parsed
  claim;
- `unsupported` when the player invites a concrete claim whose required owner
  is unavailable or invalid;
- no correction when negation, metaphor, hypothetical language, target entity,
  or authority is ambiguous.

Domain reference without a safely parsed claim may still raise the priority of
an already-known consistency constraint. It must not invent a correction.

**Ruling (owner, 2026-07-30): the claim lexicon is scaffolding, never state
authority.** Words like `storm`, `pool`, and `river` exist for two purposes
only: as test vocabulary while wetness/provenance behavior is developed, and to
detect a conversational claim ("the storm soaked your hair") for comparison
against committed truth. They must never mutate physical state directly. The
eventual authority chain is: world state ("it is raining") → spatial/exposure
resolution (outside, uncovered, exposed) → physical interaction (rain contacts
her hair for ten minutes) → body-state update (wetness = wet, cause = rain) →
narrator guidance. Being "in the water" is likewise not enough by itself — a
resolver must weigh depth, which regions are submerged, whether the head
entered the water, arrangement, coverings, exposure time, and later drying;
waist-deep in a river does not wet hair. Tests must enforce the separation:
keywords alone never change state, structured events produce body-state
changes, player assertions never become world truth, keyword detection may
only identify a possible claim (ambiguity produces silence), and narrator
guidance derives exclusively from committed state and resolved actions.
Even in the detector, keywords need clause-local association — `storm` must
not fire for "a storm is approaching", nor `pool` for "your hair gleams in a
pool of light".

### 5. Disclosure is a hard gate

Guidance is filtered for its consumer before ranking:

- `resolver_only` can affect action resolution but never appears in a narrator
  prompt;
- `consistency_only` may render only as a prohibition or resolved limitation;
  the prompt must not state the hidden positive alternative;
- `positive_detail_allowed` has passed viewpoint, channel, exposure, and
  intimate-policy gates and may be rendered positively if selected.

High salience cannot override disclosure. A negative instruction about hidden
state must be phrased without explaining the hidden cause, and the prompt must
forbid the narrator from mentioning excluded alternatives or the instruction
itself.

### 6. Selection favors risk, not inventory

Selection order:

1. mandatory resolved action outcomes;
2. current-turn premise corrections;
3. constraints touching the attempted action, named entity, locus, or domain;
4. constraints needed to continue an already-active physical interaction;
5. one eligible state transition;
6. generic descriptive opportunity — none in the initial release.

Prompt budgets for the proving release:

- all mandatory action outcomes, normally one;
- at most two premise corrections;
- at most three scoped consistency constraints;
- at most one *positive* state transition, when slice 4's experiment is enabled
  — the tier itself carries a larger budget, because the permission owner's
  mandatory stops share it and an ensemble reply can end several at once;
- zero generic opportunities.

Constraints are not output suggestions and do not need a narration cooldown.
Transitions do: unchanged fingerprints stay silent, and a retake restores the
same pre-turn mention state.

### 7. Prompt projection is imperative and precedence-safe

The server adapter renders semantic guidance near the current player message,
after volatile state and before response-shape instructions. It uses a distinct
heading and explicit precedence over general appearance/sensory allowances.

Example:

```text
Physical consistency for this exchange:
- Binding constraint: do not describe Wren's hair as loose, cascading,
  streaming, or whipping; it remains secured in a braid.
- Premise check: the player's storm-cause claim conflicts with committed
  state. Do not adopt rain as the cause. Do not correct the player aloud
  unless Wren would naturally do so.
- Resolved action: hand-to-head contact did not occur from the current pose;
  a larger position change is required before it can occur.
- Optional changed detail: Wren's hair has just gone from soaked to damp
  after toweling. Use only if the current drying-off beat benefits from it.
```

The renderer owns wording, but does not smuggle in new semantics. A
constraint-only turn contains no instruction to mention a body detail.

**This block is now the only prompt door for physical instructions, and one of
its tenants is mandatory.** The romantic-contact permission owner's revocation
stop — "that touch has ended, do not continue or resume it" — is delivered
through this block and nowhere else, and it has exactly one reply window: a
stop that misses it is never shown at all. It is *not* gated on
`CHAT_PHYSICAL_CONSTRAINTS`, because permission authority may not depend on an
optional presentation experiment; with that flag off, a pending stop still
compiles and renders through the same compiler and renderer, alone.

Two consequences for slices 4–6. Anything that can drop, reorder, or budget the
transition tier can silently destroy a mandatory instruction, so a change to
selection is a change to permission behavior. And any future work that turns
this block off wholesale — a rollback, a rename, an experiment retired — has to
keep that arm alive.

## State and retakes

- Compile guidance from the same committed cut used by the narrator.
- Capture resolver outcomes and transition fingerprints through the lane's
  actual branch/retake boundary.
- Do not overload the old `affordance_cues` memory with new semantics.
- Constraint and correction selection is recomputable from the captured input,
  cut, and action outcome; persist nothing merely to remember that a prompt
  contained a constraint.
- If transition cooldown needs storage, give it a namespaced, versioned
  `physical_guidance` state with `parseOr`, bounded entries, and degradation
  diagnostics.
- Retaking an exchange must restore the same physical cut, input authority,
  resolver outcome, selection, and pre-turn transition memory.

## Delivery

### Slice 0 — preserve the evidence and freeze the old path (shipped 2026-07-30)

- Keep `CHAT_AFFORDANCE_CUES` default off and mark its renderer as a closed
  experiment.
- Preserve the reusable bait matrix, quote verification, induction gate, and
  v1 fixtures.
- Add a safe committed result format for future fixture-only trials: model
  identifiers, fixture commit, prompt/config hashes, raw dimension counts,
  exchanges with any violation, physical-claim counts, verified violation
  quotes, and spend. Do not rely on a gitignored `trial.json` transcription as
  the only audit record.
- Correctly label the previous mechanism explanation as a working hypothesis,
  not a cross-domain law.

### Slice 1 — shared guidance contracts and compiler (shipped 2026-07-30)

- Add the lane-neutral candidate, disclosure, evidence, diagnostic, selection,
  and fingerprint contracts outside the affordance domain core.
- Map existing `AffordanceConstraint` and perception-safe observations into
  guidance candidates without changing domain calculations.
- Add the action-outcome adapter seam the contact resolver consumes in slice 3.
- Prove deterministic ordering, budget enforcement, disclosure safety,
  missing-input silence, and no domain names in the shared compiler.

### Slice 2 — hair constraint/correction proving path (shipped 2026-07-30)

- Implement high-confidence claim/reference detection for wetness degree,
  wetness provenance, arrangement/binding, motion, and coverage.
- Compile only relevant hair constraints and premise corrections.
- Add `CHAT_PHYSICAL_CONSTRAINTS` with a code default of off, a byte-identical
  prompt, and zero new computation when disabled. (What the deployed value is
  today is in the Status line above.)
- Reuse the trial's cause-true and degree-accurate semantics without forcing a
  positive hair description.
- Add read-only inspector output showing source resolution → candidate →
  disclosure → selection → rendered instruction.

### Slice 3 — romantic-contact action results (shipped 2026-07-31)

What this slice promised, and which of it holds today:

- Attempted contact goes through the shared contact resolver before the
  narrator can describe its outcome, and the resolved result is projected as a
  mandatory action outcome — the first tier of the block, ahead of any standing
  truth about the body.
- For contact that is exactly four values: **committed**,
  **explicit_transition_required**, **rejected**, **unresolved**. There is no
  romantic-contact partial result — `partially_committed` stays in the generic
  guidance vocabulary only, reserved for a future domain that needs per-locus
  commitment, and the contact adapter never emits it.
- Pose, support, material-between, clothing access, actor control, permission,
  and consent stayed in their authoritative owners.
- Narrator guidance explains the observable result and cannot turn a rejected
  or unresolved attempt into contact. An attempt whose reach the scene could
  not establish gets a presentation-only premise fencing the prose from
  inventing the landing, while the state stays unresolved.

**The proving case changed, and the plan is the thing that was wrong.** This
slice named the foot domain as the case to prove before intimate regions. What
actually consumed the seam is the chat lane's affectionate-contact leg — a
plainly affectionate hand touch to a shoulder, arm, back, hand, or head —
delivered under
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
and accepted by its own internal trial. The foot domain exists but is not in
the live domain set, so no foot affordance runs in production. Nothing about
the seam depended on which body part proved it, and the substitution cost this
plan nothing; the foot registration is that plan's sequencing decision, not a
remaining item here.

### Slice 4 — change-gated positive detail (not started)

The transition tier now has a producer, but it is **not this one**: the
permission owner's revocation handoff emits a binding "that touch has ended"
stop through the same tier (2026-08-04). Nothing derives a positive
change-gated detail, and `CHAT_PHYSICAL_TRANSITIONS` does not exist in the
codebase.

- Add `CHAT_PHYSICAL_TRANSITIONS`, default off and dependent on the constraint
  path.
- Derive transitions only from committed before/after state or committed
  events, never merely from adapter availability changing.
- Require positive-detail disclosure plus current action or attention
  relevance.
- Offer at most one detail and record a retake-safe cooldown fingerprint.
- Do not add generic ambient opportunities in this slice.

### Slice 5 — independent narrator trials and rollout rulings (not run)

Neither campaign has been run. The constraint path is nonetheless live in
production, because `CHAT_PHYSICAL_CONSTRAINTS` was turned on as a condition of
the affectionate-contact enablement rather than on a result from this slice.
That does not retire the campaign — it makes it a measurement of something
players are already receiving, and it means the honest comparison arm is now
"the flag off", not "before the feature existed".

Run two separate campaigns:

1. constraint/correction/action outcomes versus control;
2. change-gated details on top of the winning constraint configuration versus
   that configuration alone.

Do not let a positive-detail result determine whether constraints ship. Do not
combine both changes into one A/B.

Before either campaign runs, generalize the committed trial-record format. Its
arms are still the closed cue trial's two ("cues" and "control"), and
physical-claim counts remain optional because the claim-normalized instrument
does not exist yet. The format preserves headroom but cannot yet enforce a
complete constraint/action-outcome trial record; that generalization is slice 5
setup work, not finished infrastructure.

### Slice 6 — successor adapter (not started)

- Normalize successor cut, action, observation, and contact results into the
  same guidance contracts.
- Keep lane-specific authority and capture outside the shared compiler.
- Prove equivalent guidance for equivalent fixtures while allowing honest
  differences where one lane lacks an owner.

## Evaluation

### Deterministic gate

Before any paid generation:

- every bait names a specific prohibited or unsupported claim;
- the control is tempted in fixture dry-runs where the induction design expects
  it;
- feature-off prompts are byte-identical;
- constraints contain no positive-detail instruction;
- hidden/resolver-only facts never reach the prompt;
- authoritative storyteller inputs are not misclassified as false premises;
- rejected and unresolved actions cannot render as committed;
- silence controls stay byte-identical;
- retakes reproduce candidate and selection fingerprints;
- a failed or empty judge response fails the run.

### Reported measures

Primary:

- percentage of exchanges with any physical contradiction;
- false-premise adoption rate on armed exchanges;
- required action outcomes narrated incorrectly or omitted.

Claim-normalized:

- physical claims made per exchange;
- contradictions per physical claim;
- correct grounded physical claims per exchange.

Guardrails:

- repetition per exchange;
- irrelevant or forced physical mentions;
- naturalness and specificity;
- prompt tokens and added turn latency;
- per-domain and per-bait-family results.

Dimension counts remain diagnostic. The primary exchange-level measure avoids
double-counting one sentence under two overlapping labels. Every violation
still requires a verified quote.

### Decision rules

Freeze each campaign's matrix, model ids, induction gate, thresholds, and
stopping rule before spending.

For the first constraint campaign, retain the established induction bar:
control contradictions at least `0.40` per armed exchange and at least three
families with a control violation. Pass only if:

- the constraint arm cuts exchanges with any contradiction by at least 40%;
- false-premise adoption is materially lower in the applicable families;
- contradictions per physical claim do not worsen;
- required action-result accuracy does not worsen;
- repetition rises by no more than `0.05` per exchange; and
- naturalness stays within `0.25` of control.

For the transition campaign, require:

- no regression in exchange-level or claim-normalized contradictions;
- more correct grounded changed-state details;
- no material increase in irrelevant physical mentions;
- the same repetition and naturalness guardrails.

Two consecutive valid failures close the tested design. An invalid induction
round changes the instrument, not the feature or decision rule. Results apply
to the tested model, domain, and guidance type; they are not generalized to
all affordances.

## Acceptance criteria

- A player can state a false physical premise without the narrator adopting it.
- Constraint-only guidance does not force a physical detail into the reply.
- A requested contact cannot appear in prose before it is committed.
- An unreachable or blocked action is resolved consistently with pose,
  support, material, policy, and actor authority.
- A hidden fact may constrain resolution without leaking into narration.
- A committed, relevant state change may earn one optional detail; an
  unchanged or irrelevant state does not.
- Missing or invalid inputs produce conservative silence or an unsupported
  claim fence, never a guessed fact.
- Retakes reproduce the same guidance and action result from the same cut.
- Hair and contact fixtures use the same compiler without domain logic entering
  the shared layer.
- Each flag has an independent measured ship/park decision. **Not met for
  `CHAT_PHYSICAL_CONSTRAINTS`**, which is live in production ahead of slice 5's
  constraint campaign.

## Dependencies and relationship to other plans

- [Body-attribute visual affordances](body-attribute-affordances.plan.md)
  supplies physical observations, constraints, evidence, perception, and the
  closed trial harness. This plan replaces only its failed narrator projection.
- [Romantic contact affordances](romantic-contact-affordances.plan.md) supplies
  the attempted-versus-committed contact lifecycle, and its affectionate-contact
  leg is the live consumer of this plan's action-outcome seam. It also owns the
  decision that turned `CHAT_PHYSICAL_CONSTRAINTS` on in production, and the
  permission owner that became the transition tier's first producer.
- The planned scene/body-relations owner supplies authoritative pose, support,
  surface level, contacts, and impulses.
- [Clothing state graph](clothing-state-graph.plan.md) owns garment parts,
  coverage, access, material-between, and displacement.
- Physiology and body-state owners supply live surface conditions and committed
  aftereffects.
- Successor parity (slice 6) depends on the successor affordance/contact
  adapters, not on copying chat prompt strings. Neither adapter exists, so
  slice 6 cannot start.

## Explicitly parked

- Re-enabling the old positive affordance cue block.
- A general LLM physical-claim parser before each narrator call.
- Generic ambient descriptive opportunities.
- Treating player prose as committed contact or state.
- Using narrator instructions to replace contact, consent, actor-control, pose,
  clothing, or physiology authority.
- Claiming the hair trial proved a universal relationship between specificity
  and contradictions.

## Open questions

- **Does the constraint campaign still run, now that the flag is on?** The
  constraint path went live on 2026-08-02 as a condition of a different plan's
  enablement, so this plan's promise of an independent measured decision per
  flag is currently unkept. Either the campaign runs against a flag-off arm, or
  the promise is formally withdrawn — leaving it unsaid means the plan claims a
  discipline the product no longer follows.
- **Does slice 4 need its own tier, now that the tier has a producer?** The
  permission owner's revocation stop already occupies the transition tier with
  a mandatory, budget-bounded candidate whose loss is permanent. A
  change-gated positive detail entering the same tier competes with it. Decide
  whether slice 4 shares the tier under a priority rule, or gets its own.

Settled and not reopened: constraint-only ships independently of positive
detail; authoritative storyteller state changes stay excluded until they have a
pre-narrator commit seam; generic positive opportunities remain parked.
