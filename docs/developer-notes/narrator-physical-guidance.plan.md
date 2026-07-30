# Constraint-first narrator physical guidance

Status: active — slices 0–2 shipped 2026-07-30 (proposed 2026-07-29 from the
closed affordance-cue trial; the shared contract landed before the
romantic-contact narrator slice, as intended). Slice 2's as-built detail is in
[narrator-physical-guidance.spec.md](narrator-physical-guidance.spec.md) §"Slice
2 as built". Remaining: slice 3 (romantic-contact action results), slice 4
(change-gated positive detail), slice 5 (the two trials), slice 6 (successor
adapter).

## In one sentence

Use committed physical truth primarily to prevent impossible or contradictory
narration, correct false premises, and report resolved actions; offer a positive
descriptive detail only when a relevant state change has independently earned
the beat.

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

Add a pure compiler outside the domain-neutral affordance `core/`. It combines
eligible domain results with the current action result and turns them into
guidance candidates:

```ts
interface NarratorPhysicalGuidance {
  version: 1;
  constraints: readonly PhysicalNarrationConstraint[];
  corrections: readonly PhysicalPremiseCorrection[];
  actionOutcomes: readonly PhysicalActionOutcome[];
  transitions: readonly PhysicalStateTransition[];
  diagnostics: readonly Diagnostic[];
}

type GuidanceDisclosure =
  | "resolver_only"
  | "consistency_only"
  | "positive_detail_allowed";

interface PhysicalNarrationConstraint {
  id: string;
  subjectIds: readonly string[];
  domainId: string;
  locusIds: readonly string[];
  prohibitedClaimCodes: readonly string[];
  allowedClaimCodes: readonly string[];
  disclosure: GuidanceDisclosure;
  priority: "mandatory" | "high" | "normal";
  evidence: readonly AffordanceEvidence[];
  fingerprint: string;
}

interface PhysicalPremiseCorrection {
  id: string;
  source: "player_dialogue" | "ordinary_player_narration";
  claimCode: string;
  verdict: "contradicted" | "unsupported";
  truthCodes: readonly string[];
  disclosure: Exclude<GuidanceDisclosure, "resolver_only">;
  evidence: readonly AffordanceEvidence[];
}

interface PhysicalActionOutcome {
  actionId: string;
  status:
    | "committed"
    | "partially_committed"
    | "explicit_transition_required"
    | "rejected"
    | "unresolved";
  resultCodes: readonly string[];
  narratorMustResolve: boolean;
  disclosure: GuidanceDisclosure;
  evidence: readonly AffordanceEvidence[];
}

interface PhysicalStateTransition {
  id: string;
  subjectIds: readonly string[];
  domainId: string;
  locusIds: readonly string[];
  beforeCodes: readonly string[];
  afterCodes: readonly string[];
  causeCodes: readonly string[];
  relevance: "action" | "attention" | "none";
  disclosure: "positive_detail_allowed";
  repeatKey: string;
  evidence: readonly AffordanceEvidence[];
}
```

These are proposed contract shapes, not permission to turn domain semantics
into unbounded strings. Final types should reuse existing ids, evidence,
fixed-point helpers, and diagnostics.

### 3. Input authority is resolved before premise checking

The current message must first be classified using the chat lane's existing
input modes:

| Input form | Treatment |
| --- | --- |
| Character dialogue or ordinary conversational assertion | May be mistaken; eligible for high-confidence premise checking. |
| Player-controlled action intent | Send through the applicable action/contact resolver; the outcome, not the requested result, reaches narration. |
| Storyteller-authoritative narration | Treat as a proposed authoritative event/state change, not a false premise. Until a pre-narrator commit seam exists for that fact, exclude it from automatic correction. |
| Out-of-character direction | Instruction to the narrator; not physical evidence by itself. |
| Private thought | Not perceived by characters and not a physical-state write. |

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
- at most one state transition when that experiment is enabled;
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

### Slice 0 — preserve the evidence and freeze the old path

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

### Slice 1 — shared guidance contracts and compiler

- Add the lane-neutral candidate, disclosure, evidence, diagnostic, selection,
  and fingerprint contracts outside the affordance domain core.
- Map existing `AffordanceConstraint` and perception-safe observations into
  guidance candidates without changing domain calculations.
- Add the action-outcome adapter seam the romantic-contact resolver will use.
- Prove deterministic ordering, budget enforcement, disclosure safety,
  missing-input silence, and no domain names in the shared compiler.

### Slice 2 — hair constraint/correction proving path

- Implement high-confidence claim/reference detection for wetness degree,
  wetness provenance, arrangement/binding, motion, and coverage.
- Compile only relevant hair constraints and premise corrections.
- Add `CHAT_PHYSICAL_CONSTRAINTS`, default off, with byte-identical prompt and
  zero new computation when disabled.
- Reuse the trial's cause-true and degree-accurate semantics without forcing a
  positive hair description.
- Add read-only inspector output showing source resolution → candidate →
  disclosure → selection → rendered instruction.

### Slice 3 — romantic-contact action results

- Feed attempted contact through the shared contact resolver before the
  narrator can describe its outcome.
- Project committed contact, rejection, partial result, or explicit transition
  requirement as a mandatory action outcome.
- Keep pose, support, material-between, clothing access, actor control,
  permission, consent, and adult eligibility in their authoritative owners.
- Narrator guidance may explain the observable result but cannot turn a
  rejected or unresolved attempt into contact.
- Use the foot domain as the proving case before intimate regions.

### Slice 4 — change-gated positive detail

- Add `CHAT_PHYSICAL_TRANSITIONS`, default off and dependent on the constraint
  path.
- Derive transitions only from committed before/after state or committed
  events, never merely from adapter availability changing.
- Require positive-detail disclosure plus current action or attention
  relevance.
- Offer at most one detail and record a retake-safe cooldown fingerprint.
- Do not add generic ambient opportunities in this slice.

### Slice 5 — independent narrator trials and rollout rulings

Run two separate campaigns:

1. constraint/correction/action outcomes versus control;
2. change-gated details on top of the winning constraint configuration versus
   that configuration alone.

Do not let a positive-detail result determine whether constraints ship. Do not
combine both changes into one A/B.

### Slice 6 — successor adapter

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
- Hair and foot-contact fixtures use the same compiler without domain logic
  entering the shared layer.
- Each flag has an independent measured ship/park decision.

## Dependencies and relationship to other plans

- [Body-attribute visual affordances](body-attribute-affordances.plan.md)
  supplies physical observations, constraints, evidence, perception, and the
  closed trial harness. This plan replaces only its failed narrator projection.
- [Romantic contact affordances](romantic-contact-affordances.plan.md) supplies
  the attempted-versus-committed contact lifecycle and foot-first proving
  domain. Its narrator slice should consume this plan's action-outcome seam.
- The planned scene/body-relations owner supplies authoritative pose, support,
  surface level, contacts, and impulses.
- [Clothing state graph](clothing-state-graph.plan.md) owns garment parts,
  coverage, access, material-between, and displacement.
- Physiology and body-state owners supply live surface conditions and committed
  aftereffects.
- Successor parity depends on the successor affordance/contact adapters, not on
  copying chat prompt strings.

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

None required to begin slices 0–2. The recommended defaults are explicit:
constraint-only ships independently; authoritative storyteller state changes
are excluded until they have a pre-narrator commit seam; transitions require a
separate trial; and generic positive opportunities remain parked.
