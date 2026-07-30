# Narrator physical guidance — shared contracts

Status: companion to narrator-physical-guidance.plan.md — slice 1 contracts and
slice 2 (hair constraint/correction proving path) as built, 2026-07-30

Product rationale, delivery slices, evaluation, and decision rules live in
[narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md). This
document is the coding-agent view of what has actually shipped: slice 1's type
shapes, the laws enforced in code, the deterministic ordering scheme, the seams
slices 3–6 plug into, and — in the last section — slice 2's hair
constraint/correction path as built.

## Scope of slice 1

`src/contracts/affordances/guidance/` — a pure, lane-neutral compiler that turns
already-resolved domain results into narrator-bound guidance candidates, gates
them by disclosure, orders them deterministically, and enforces the prompt
budget. It contains no domain knowledge, no lane knowledge, no IO, and no model
call.

Placement: a **sibling** of `affordances/core/`, not a member. The core stages a
calculation it knows nothing about and may not learn that narration exists; this
layer exists precisely to know what a narrator may be told.
`core/domain-neutrality.test.ts` polices only `core/`, so this folder carries its
own `domain-neutrality.test.ts`.

Import direction (enforced by ESLint for `src/contracts` purity, and by the
folder's own neutrality test):

```text
attribute/body contracts + contracts/diagnostics
        → affordances/core
        → affordances/guidance
        → lane adapters under src/server
```

`guidance/` may import `../core` and `../../diagnostics`. It may never import
`../domains/*`, `@/server`, `@/app`, or `@/components`. Domain vocabulary enters
as **data** (a `ConstraintClaimMapping` table, opaque claim codes), never as a
module.

## Laws encoded in the types

1. **Claim codes are opaque.** Every `*ClaimCodes` / `*Codes` / `truthCodes`
   field is domain-owned vocabulary. This layer carries, orders, budgets, and
   gates them; it never parses, matches, negates, or interprets one.
2. **Disclosure is data, never inferred.** The producer that knows whether a fact
   is perceptible states it per candidate. The gate only enforces it, so salience
   cannot unlock hidden state — the gate never sees a rank. Being data, it is
   also *untrusted* data: the gate is an allowlist checked at runtime, not a
   denylist leaning on the union (see §Disclosure law).
3. **Every candidate carries a fingerprint.** Ordering, over-budget reporting,
   and retake reproduction are defined in terms of it, so no tier falls back on
   input order (an adapter may reorder two reads of the same committed cut).
4. **Missing data never becomes guidance.** An absent input yields no candidate.
   It may license a prohibition; it may never supply a substituted positive fact.

## Type shapes as built

Vocabularies are exported both as `as const` arrays and as derived unions
(`guidanceDisclosures` / `GuidanceDisclosure`, `guidancePriorities`,
`physicalActionStatuses`, `physicalTransitionRelevances`) — the house pattern
from `core/perception.ts`, so tests and future zod schemas can iterate them.

```ts
type GuidanceDisclosure = "resolver_only" | "consistency_only" | "positive_detail_allowed";
type GuidancePriority = "mandatory" | "high" | "normal";
type PhysicalActionStatus =
  | "committed" | "partially_committed" | "explicit_transition_required" | "rejected" | "unresolved";
type PhysicalTransitionRelevance = "action" | "attention" | "none";

/** Deterministic identity every candidate carries. */
interface GuidanceFingerprinted { readonly fingerprint: string }
/** What the shared gate and ranker need; all four kinds satisfy it structurally. */
interface GuidanceCandidateShape extends GuidanceFingerprinted { readonly disclosure: GuidanceDisclosure }

interface PhysicalNarrationConstraint extends GuidanceCandidateShape {
  readonly id: string;                                    // `<resolutionId>:<code>[:<locus>…]`
  readonly subjectIds: readonly AffordanceSubjectId[];
  readonly domainId: string;
  readonly locusIds: readonly string[];                   // empty = domain-wide
  readonly prohibitedClaimCodes: readonly string[];
  readonly allowedClaimCodes: readonly string[];          // empty unless every locus is visible
  readonly priority: GuidancePriority;
  readonly evidence: readonly AffordanceEvidence[];
}

interface PhysicalPremiseCorrection extends GuidanceFingerprinted {
  readonly id: string;
  readonly source: "player_dialogue" | "ordinary_player_narration";
  readonly claimCode: string;
  readonly verdict: "contradicted" | "unsupported";
  readonly truthCodes: readonly string[];
  readonly disclosure: Exclude<GuidanceDisclosure, "resolver_only">;
  readonly evidence: readonly AffordanceEvidence[];
}

interface PhysicalActionOutcome extends GuidanceCandidateShape {
  readonly actionId: string;
  readonly status: PhysicalActionStatus;
  readonly resultCodes: readonly string[];                // resolver's own order; order is identity
  readonly narratorMustResolve: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

interface PhysicalStateTransition extends GuidanceFingerprinted {
  readonly id: string;
  readonly subjectIds: readonly AffordanceSubjectId[];
  readonly domainId: string;
  readonly locusIds: readonly string[];
  readonly beforeCodes: readonly string[];
  readonly afterCodes: readonly string[];
  readonly causeCodes: readonly string[];
  readonly relevance: PhysicalTransitionRelevance;
  readonly disclosure: "positive_detail_allowed";
  readonly repeatKey: string;                             // cooldown identity, without the cause
  readonly evidence: readonly AffordanceEvidence[];
}

interface NarratorPhysicalGuidance {
  readonly version: 1;
  readonly constraints: readonly PhysicalNarrationConstraint[];
  readonly corrections: readonly PhysicalPremiseCorrection[];
  readonly actionOutcomes: readonly PhysicalActionOutcome[];
  readonly transitions: readonly PhysicalStateTransition[];
  readonly diagnostics: readonly Diagnostic[];
}
```

Deltas from the plan's §Architecture 2 sketch, all recorded here as the
authority:

| Change | Why |
| --- | --- |
| `subjectIds` is `readonly AffordanceSubjectId[]`, not `string[]` | The branded core id already exists; a lane-local chat id and a world id must not be swappable. |
| `PhysicalPremiseCorrection.fingerprint` added | Every kind needs a deterministic identity — corrections are budgeted, so a tie-break and an over-budget report need one too. |
| `PhysicalActionOutcome.fingerprint` added | Same, plus retake reproduction of the resolver result. |
| Bundles `GuidanceCandidateInput` (all lists optional) and `GuidanceCandidates` (all present) | One place converts `undefined` → `[]` (`normalizeGuidanceCandidates`), so "absent" is never confused with "emptied". |
| `emptyNarratorPhysicalGuidance()` | The flag-off and degraded value has a name, per the `emptyAffordancePerceptionView` precedent. |

## Disclosure law

The gate runs **before** ranking (`compile.ts` order is filter → select). If
salience could rank a `resolver_only` candidate first, a sufficiently important
secret would leak — and importance is the property secrets have.

The gate is an **allowlist, compared at runtime** — `narratorPromptDisclosures`,
a module-private `ReadonlySet<string>` holding exactly `consistency_only` and
`positive_detail_allowed`. `GuidanceDisclosure` is a closed union, but a closed
union binds only the producers the compiler can see, and this layer explicitly
expects candidates a lane adapter parsed out of a persisted or remote shape
(slice 6 successor adapters). A gate that dropped exactly `resolver_only` would
pass an unrecognised value straight into a prompt. **Unknown disclosure ⇒ no
disclosure**: anything off the allowlist is dropped. The set is typed
`ReadonlySet<string>` rather than `ReadonlySet<GuidanceDisclosure>` on purpose —
a set keyed to the union would only accept union members as lookup keys, which is
the compile-time assumption being distrusted. The types stay closed; only the
membership test is widened.

| Disclosure | `narrator_prompt` consumer | `resolver` consumer | Notes |
| --- | --- | --- | --- |
| `consistency_only` | **allowlisted** — passed; renders as prohibition or resolved limitation only | passed | The prompt must not state the hidden positive alternative. |
| `positive_detail_allowed` | **allowlisted** — passed; may render positively if selected | passed | Only transitions (slice 4) and explicitly-cleared outcomes reach this. |
| `resolver_only` | dropped, one `info` `guidance.disclosure.resolver_only` per drop | passed | Hidden state constraining silently is correct behaviour, so never `warn`/`error`. |
| anything else (out-of-union) | dropped, one **`error`** `guidance.disclosure.invalid` per drop, naming the fingerprint and the bad value | passed | Nobody meant it — it can only come from an adapter, a store, or an older release, so it is a bug, not a policy. |

The `resolver` consumer is untouched by all of this: it passes everything,
silently, including out-of-union values. Resolver-side code owns its own
validation, and this gate is the narrator's, not everyone's.

Perception half of the same law, in `buildConstraintCandidates`:

| Locus exposure (`affordanceExposureAt`) | `prohibitedClaimCodes` | `allowedClaimCodes` | Disclosure |
| --- | --- | --- | --- |
| every locus `visible` | carried | `mapping.truthClaimCodes` | `consistency_only` |
| any locus `hinted` / `hidden` / `unknown` / unlisted | carried | **empty** | `consistency_only` |
| no loci at all (domain-wide) | carried | **empty** (fails closed) | `consistency_only` |

`positive_detail_allowed` is never produced by the constraint path. A constraint
is a fence; positive detail is slice 4's transition path with its own gates.

The render seam's last-line check is `assertNoResolverOnlyLeak(guidance)`, which
enforces **the same allowlist**: one `error` per candidate in narrator-bound
guidance whose disclosure is not `consistency_only` or `positive_detail_allowed`
— `guidance.disclosure.leak` for `resolver_only` (the leak worth naming, which is
why the export keeps that name) and `guidance.disclosure.invalid` for any other
value. Both are returned rather than thrown (resilience: diagnostics over
exceptions), and the caller's contract is to drop the offending guidance, never
to fail the turn.

Because `renderChatPhysicalGuidance` already drops the whole block on **any**
error from that call, the broadened law needed no renderer change — a fact
pinned by a test rather than left to reading (`chat-physical-guidance-render.test.ts`,
"renders NOTHING for a disclosure outside the vocabulary either").

## Selection order and budgets

`selectNarratorGuidance` emits the four lists in the plan's selection order; the
array order in `NarratorPhysicalGuidance` **is** the prompt order.

| Tier | List | Rank within tier | Budget |
| --- | --- | --- | --- |
| 1 | `actionOutcomes` | `narratorMustResolve` first, then fingerprint | none — never dropped |
| 2 | `corrections` | fingerprint only (the plan ranks them as one group) | `GUIDANCE_MAX_CORRECTIONS = 2` |
| 3 | `constraints` | `mandatory` → `high` → `normal`, then fingerprint | `GUIDANCE_MAX_CONSTRAINTS = 3` |
| 4 | `transitions` | `action` → `attention` → `none`, then fingerprint | `GUIDANCE_MAX_TRANSITIONS = 1` |

- Every tier ends in a **fingerprint tie-break**, so the same candidates produce
  the same guidance in any input order, in any process, on a retake.
- Generic descriptive opportunities have **no constant**. A budget of `0` would
  invite someone to raise it; the plan parks the concept, so it does not exist
  here.
- Over-budget drops emit one `info` `guidance.selection.over_budget` per tier
  with `context: { kind, max, dropped: string[] }` (dropped fingerprints).
- `relevance: "none"` transitions are ranked last rather than dropped:
  eligibility is the producer's gate (slice 4), and a silent drop here would hide
  a producer bug.

## Fingerprint scheme

`guidanceFingerprint(parts: readonly string[]): string`

- Parts are joined with `U+001F` (the unit separator, a control character that cannot appear in an id
  or code), so `["ab","c"]` and `["a","bc"]` cannot collide by concatenation.
- Two 32-bit FNV-1a lanes with different bases **and** different multipliers,
  printed as 16 lowercase hex digits. No crypto import, no clock, no counter, no
  locale, no randomness — the same parts always produce the same digest.
- `guidanceUnorderedPart(values)` sorts with the default comparator (UTF-16 code
  units, **not** `localeCompare`, which would make a digest host-specific) for
  fields whose identity is membership: loci, prohibited codes, subject ids.
- `guidanceOrderedPart(values)` preserves order for fields whose identity is a
  sequence: before → after codes, a resolver's result codes.
- `compareGuidanceFingerprints(left, right)` is the tie-break comparator.
- A collision would mis-**order** two candidates; it can never merge them.
- Degenerate case, pinned by test: `[]` and `[""]` hash identically. Unreachable
  from a builder — every builder passes a fixed-arity list whose first part is a
  kind tag.

## File map

| File | Responsibility |
| --- | --- |
| `types.ts` | Vocabularies, the four candidate shapes, `NarratorPhysicalGuidance`, `normalizeGuidanceCandidates`, `emptyNarratorPhysicalGuidance`. |
| `fingerprint.ts` | `guidanceFingerprint`, the ordered/unordered part helpers, `compareGuidanceFingerprints`. |
| `constraint-candidates.ts` | `ConstraintClaimMapping` + `buildConstraintCandidates` — the domain-result → candidate seam and the perception rule. |
| `action-outcome.ts` | `buildActionOutcome`, `guidanceActionMustResolve` — the resolver seam and the mandate floor. |
| `disclosure.ts` | `filterGuidanceForConsumer`, `assertNoResolverOnlyLeak` — the hard gate, both ends, over one runtime allowlist (`classifyDisclosure`) so the two ends cannot drift on what "prompt-safe" means. |
| `selection.ts` | `selectNarratorGuidance`, budget constants, over-budget reporting. |
| `compile.ts` | `compileNarratorPhysicalGuidance` — gate, then select, then assemble. One fan-out sink. |
| `index.ts` | Barrel + the import-direction header. Re-exported from `affordances/index.ts`. |
| `test-support.ts` | `probe*` candidate builders for this layer's tests. Deliberately **not** in the barrel. |
| `*.test.ts` | 7 files / 59 cases: neutrality, fingerprint, constraint candidates, action outcome, disclosure (incl. out-of-union values, cast through `unknown` in the test only), selection, compile. |

## Diagnostics

All `info` except the two disclosure failures (`.leak`, `.invalid`) — the cases
where a value nobody meant reached, or nearly reached, a prompt. Codes are dotted
and namespaced under `guidance.`, mirroring `affordance.input.unavailable`.

| Code | Severity | Emitted by | Context |
| --- | --- | --- | --- |
| `guidance.constraint.unmapped` | info | `buildConstraintCandidates` | `{ domainId, constraintId, code, reason }` where `reason` is `unmapped` (no mapping matched) or `no_claim_codes` (a mapping with nothing to say). |
| `guidance.disclosure.resolver_only` | info | `filterGuidanceForConsumer` | `{ kind, fingerprint }` per withheld candidate. |
| `guidance.selection.over_budget` | info | `selectNarratorGuidance` | `{ kind, max, dropped }` per over-budget tier. |
| `guidance.disclosure.invalid` | **error** | `filterGuidanceForConsumer`, `assertNoResolverOnlyLeak` | `{ kind, fingerprint, disclosure }` per candidate whose disclosure is off the narrator allowlist. `disclosure` is `String()`-formatted, so a non-string value from a bad parse reports instead of throwing. |
| `guidance.disclosure.leak` | **error** | `assertNoResolverOnlyLeak` | `{ kind, fingerprint }` per leaked candidate. |

`compileNarratorPhysicalGuidance` records each diagnostic exactly once on both
views: the returned `guidance.diagnostics` and the caller's optional sink.
Absent or empty candidate lists compile to the empty guidance with **no
diagnostics** — a nothing-to-say turn must not be distinguishable from a
byte-identical control by its diagnostics.

## Adapter seams

### Slice 2 — chat lane, constraint/correction proving path

- **Claim lexicon as data.** The domain owns a `readonly ConstraintClaimMapping[]`
  table: `{ constraintCode, locationId?, prohibitedClaimCodes, truthClaimCodes,
  priority? }`. A locus-scoped mapping beats a code-only mapping for the same
  code; a mapping scoped to a different locus never matches. An unmapped
  constraint produces no candidate — extend the table, never the shared layer.
- **Call shape.** `buildConstraintCandidates({ subjectId, domainId, constraints,
  mappings, perception, evidence?, sink? })`, where `constraints` are the domain
  run's `AffordanceConstraint` resolutions and `perception` is the same
  `AffordancePerceptionView` the affordance read used. Identical constraints
  dedupe by fingerprint, so one fence cannot consume two budget slots.
- **Corrections** are built by the lane's detector (plan §Architecture 4) and
  handed in directly; the shared layer supplies only the shape and the ordering.
  Fingerprint them over `["correction", id, verdict, disclosure]`-style canonical
  parts via `guidanceFingerprint`.
- **Render seam.** Call `compileNarratorPhysicalGuidance` once, then
  `assertNoResolverOnlyLeak(guidance)` immediately before the guidance becomes
  prompt text; a non-empty result means drop, not throw. Wording belongs to the
  renderer — it may not add semantics, and a constraint-only turn must contain no
  instruction to mention a physical detail.
- **Flag-off path.** `CHAT_PHYSICAL_CONSTRAINTS` off must skip compilation
  entirely (`emptyNarratorPhysicalGuidance()` if a value is needed), so the
  prompt stays byte-identical and no work is done.

What slice 2 actually built against this seam is recorded in §"Slice 2 as built"
at the end of this document — that section is the authority where the two differ.

### Slice 3 — romantic-contact action results

- **One call per attempted action:** `buildActionOutcome({ actionId, status,
  resultCodes, disclosure, narratorMustResolve?, evidence? })`. The resolver
  keeps every authority it already owns (pose, support, material-between,
  clothing access, actor control, permission, consent, adult eligibility); this
  seam only stamps the identity.
- **The mandate is a floor, not a default.** `rejected`,
  `explicit_transition_required`, and `partially_committed` resolve
  `narratorMustResolve: true` whatever the caller passes. `committed` and
  `unresolved` default `false` — a committed contact is already the beat the
  player asked for, and the correct output for "the resolver could not decide" is
  silence, not an explanation. Either may opt in by passing `true`.
- **Order is identity.** `resultCodes` are fingerprinted in the resolver's own
  order, so two outcomes differing only in result order are distinct candidates.
- Action outcomes are never budgeted away, so a rejected attempt cannot fall out
  of the prompt and be narrated as contact.

### Slice 4 / slice 6 (not built)


- Transitions have their contract and their tier here, but no builder: slice 4
  owns deriving them from committed before/after state and the retake-safe
  cooldown (`repeatKey`), and `CHAT_PHYSICAL_TRANSITIONS` gates them.
- The successor adapter (slice 6) normalizes its own cut, action, and contact
  results into these same contracts. Lane-specific authority and capture stay
  outside this folder — that is the whole reason the compiler is lane-neutral and
  its neutrality is a test rather than a promise.

## Slice 2 as built — the hair constraint/correction proving path

Behind `CHAT_PHYSICAL_CONSTRAINTS` (default off). No schema change, no migration, no
persisted state: constraint and correction selection is recomputable from the captured
cut and the message, so the existing rollback anchors already make a retake reproduce
it (plan §"State and retakes"). Slice 2 ships **no positive detail, no action outcomes,
and no transitions** — the compiler's later tiers exist and stay empty.

### The domain half (`src/contracts/affordances/domains/hair/`)

| File | What it adds |
| --- | --- |
| `phenomena/restraint.ts` | **New.** `hairBulkRestraint` — the "what is holding the bulk still" gate, extracted from `wind-motion.ts` verbatim (`HAIR_PINNED_GATE`/`HAIR_BOUND_GATE` 6_000, `HAIR_COVERED_GATE` 5_000, `HAIR_WATER_LOADED_GATE` 3_000, same most-specific-first precedence). Plus `hairPresentationRestraint` (the presentation-only half) and `hairCommittedRestraint` (a committed style + coverage, no mechanics — see below). |
| `phenomena/bulk-restraint.ts` | **New phenomenon** `hair.bulk_restraint`, registered third (right after the wind/motion read it shares a gate with). Emits `kind: "constraint"` with the domain's bare code (`pinned`/`bound`/`covered`/`water_loaded`) at `HAIR_LOCATION_ID`, or the suppression `no_restraint`. `dependencies: []` — arrangement, coverage and wetness are structural to the domain, so it resolves on every cut the domain can read, **with no current force**. That gap is the reason it exists: the wind read already computed the restraint but only used it as a reason for its own silence, so on a still evening the domain knew the hair was braided and nobody was told. |
| `phenomena/bands.ts` | The ordered wetness DEGREE scale moved here from `wet-clumping.ts`: `hairWetnessBands` (`dry < damp < wet < soaked`), `hairWetnessBand(level)`, `hairWetnessBandRank`, and the three thresholds (`HAIR_WETNESS_DAMP_MIN` 2_000 — the old `MIN_WETNESS` — `_WET_MIN` 4_000, `_SOAKED_MIN` 8_000). Two consumers now share one cut, so a cue and a fence cannot disagree about what "soaked" means. |
| `claims.ts` | **New.** The claim lexicon (below), plus the two binding vocabularies the detector matches against: `hairReferenceNouns` / `isHairReferenceNoun` (what a claim must be attached to — `hair` and the style nouns, single tokens, no adjectives) and `hairWetnessAnchorPhrases` / `hairAssertsWetness` (what a provenance claim needs before a cause word counts). Both are domain data for the same reason the phrases are: they are statements about this body part, not about English. |
| `domain.ts` | `hairArrangementOf(attributes)` exported — the plain committed answer a lane needs, with `readArrangement` still wrapping it for the adapter result law. |

**`wind-motion.ts` and `wet-clumping.ts` behaviour is unchanged**, by construction: the
first now calls the extracted gate function and the second derives its `wetness_*` tag
from the shared band (identical for every level at or above its own floor). Both are
pinned by the existing worked-case tests, which were extended with the new constraint
rather than relaxed.

### The claim lexicon (`claims.ts`)

Five areas — `wetness_degree`, `wetness_cause`, `arrangement`, `motion`, `coverage` —
and thirteen codes. Each `HairClaimDefinition` carries:

- `phrases` — exact lowercase fragments, word-boundary matched. **No stemming**;
  inflections are enumerated, because a stemmer's near-misses are the ambiguity the plan
  says must produce silence.
- `display` — how a prohibition names it (`hair.motion.free_flow` → "cascading,
  streaming, or whipping").
- `truth` — the committed-truth clause, where there is an honest one
  (`hair.arrangement.braid` → "it remains secured in a braid").

`hairClaimMatches(sentence)` returns at most **one match per area**; within an area the
LONGEST phrase wins ("dripping wet" over "wet", "slightly wet" over "wet") with the
earlier index as tie-break, so the result is a pure function of the sentence. Each match
carries its `index`, which is what lets the caller's negation guard ask "was it denied
BEFORE it was asserted".

Deliberately absent, and each absence produces silence rather than a guess:
`arrangement: "other"` (a style we cannot identify supports no assertion) and any
"covered" claim (that vocabulary belongs to the garment lane).

`hairClaimMappings({ arrangement, wetnessBand })` is a **function**, not a table,
because the truth half depends on live state. It maps exactly the four restraint codes,
all scoped to `HAIR_LOCATION_ID`:

| Constraint | Prohibits | Truth (visible loci only) | Priority |
| --- | --- | --- | --- |
| `pinned` | `arrangement.loose`, `motion.free_flow` | the committed arrangement code | high |
| `bound` | `arrangement.loose`, `motion.free_flow` | the committed arrangement code | high |
| `covered` | `coverage.uncovered`, `motion.free_flow` | — (none exists) | normal |
| `water_loaded` | `motion.free_flow` | the committed degree code | normal |

Unknown state ⇒ the same mapping with **empty** `truthClaimCodes`. `coveredFraction` is
not a parameter: coverage licenses no positive hair clause, so its mapping is
state-independent.

### The detector (`src/server/engine/chat-physical-guidance.ts`)

`detectHairPremises` is pure, total, and conservative by construction — the default is
silence and a correction has to be earned, because a false correction fences off
something that is actually true and the player watches their own scene get contradicted.

**Authority, in order of how much it discards.** `narratorInput === true` returns `[]`
before anything is parsed (plan §Architecture 3: an authoritative state change has no
pre-narrator commit seam yet). Then `parseMessageSpans` runs, and `spanSource` is
exhaustive over `MessageSpanKind`: `speech` → `player_dialogue`, `narration` →
`ordinary_player_narration`, and `thought` / `ooc` / `comms` / `written` / `styled` →
not eligible.

**Sentence gates**, each silencing the sentence entirely:

| Gate | Rule |
| --- | --- |
| question | the sentence contains `?` |
| hypothetical / simile | any of `if would could should might maybe perhaps imagine suppose pretend wish "as though" "like a" "like the"`, anywhere in it |
| negation | any of `not n't "no longer" never hardly barely stopped "instead of" "rather than"` at an index **before** the matched phrase — position is the whole rule (and it is the WHOLE sentence's index, not the clause's, so narrowing the scan can only ever silence more), so "your hair is loose, not that you mind" still asserts |

**Clause-local binding — the law a claim has to satisfy before it means anything.** The
sentence is split into clauses at `, ; — –` and at `while as and but when because
though`, and `hairClaimMatches` runs **per clause**, not per sentence. A claim counts
only in a clause that names the hair, so a reference in one clause licenses nothing in
the next.

This is the correction of the original as-built behaviour, which established only that a
sentence mentioned the subject's hair and then attributed every recognised phrase
anywhere in it. That produced real false corrections — *"Your braided hair looks
beautiful while the curtains go streaming in the wind"* fenced motion, and the curtains
own that verb. Ambiguity must produce silence, and a bag of words is ambiguity.

**Subject binding**, per clause:

| Reference | Rule |
| --- | --- |
| `subject` | a reference noun with an accepted possessive within ≤4 preceding words: `your` / `<name>'s`. `her` / `his` / `their` accept only when `namesAnotherPerson` is false |
| `foreign` | a reference noun owned by somebody else — `my` / `the` / `a` / …, an ambiguous pronoun in a sentence that names another person, or **any other possessive** (`Mira's`, `friend's`). Licenses nothing and blocks the inheritance below |
| `unowned` | a reference noun with no determiner in reach ("…, hair streaming behind her") |
| `none` | no reference noun at all — the ordinary case, and the one that ends the "streaming curtains" bug |

The ≤4 window exists because "your **loose** hair" is the plan's own example phrasing and
an adjacency test would miss it. `namesAnotherPerson` is a capitalisation test with a
small `SENTENCE_OPENERS` allow-list for position 0 — deliberately incomplete, because a
word missing from it reads as a name, which makes the sentence ambiguous, which produces
silence. Every gap costs a correction that would have been made, never one that should
not have been.

**Ownership — and only ownership — is inherited across clauses.** An `unowned` clause is
bound when another clause of the same sentence is `subject` AND the sentence names
nobody else: *"Her braid has come completely loose, hair streaming behind her"* is one
continuous statement about one head. The inheritance answers **whose** hair, never
**whether** a clause is about hair — a clause with no reference noun inherits nothing,
which is precisely what stops a claim from attaching across a boundary.

**Provenance needs a wetness anchor.** A cause word only produces a `wetness_cause`
claim when the same clause also asserts a wetting (`hairAssertsWetness`: the wet half of
the degree scale plus the verbs that put water on a surface; `dry` is excluded, since
dryness is the absence the anchor exists to distinguish). Cause vocabulary is ordinary
scenery — *"a pool of light"*, *"a storm is approaching"*, *"the river runs fast"* — and
without this rule every one of them was provenance. `doused` deliberately sits in both
lists: it is a verb that asserts the wetting on its own, so it anchors itself. The cause
NOUNS never do, and a wetting in the OTHER clause never travels.

**Verdict laws**, one per area:

| Area | `contradicted` when | `unsupported` when | Silence when |
| --- | --- | --- | --- |
| `wetness_degree` | the claimed band is **≥2 steps** from the committed one on the ordered scale | `available.wetness` is false | ≤1 step apart, either direction |
| `wetness_cause` | a single committed wetting kind exists and differs | `available.wetness` is false | no single committed cause (none recorded, or two live causes) |
| `arrangement` | the committed style has a code and it differs | `available.arrangement` is false | committed style is `other` |
| `motion` | anything holds the bulk still on this cut | — | nothing holds it (then the claim is true) |
| `coverage` | `coveredFraction >= HAIR_COVERED_GATE` | `available.coverage` is false | below the gate |

**The degree distance is 2, and symmetric — a deliberate widening of the plan's "only
overstatements are fenced".** The four bands are a coarse cut of a continuous, lazily
dried level, so one step is inside the honest error of the read: hair a minute either
side of the `wet` boundary is fairly called either thing, and fencing that would spend
the feature's credibility on rounding. Understatement is normally left alone because
"wet" for soaked hair is merely *less specific* — and that reason runs out at two steps,
which is exactly where the `dry` claim lives: asserting dryness against a committed
soaking is a negation, not a vaguer description of the same thing. So "wet" against
soaked stays silent (the asymmetry the plan asked for) while "dry" against soaked is
fenced.

**`unsupported` requires an unreadable OWNER**, never merely an unhelpful answer. An
owner that answered "I cannot say which" — an unidentified style, an unrecorded cause —
yields silence: "we did not record why" is not evidence that the player is wrong.

**Motion reads the cut's own constraint**, not a re-derivation, so a fence and a
candidate cannot disagree. With no read (a suppressed domain still knows the hair is
braided) it falls back to `hairCommittedRestraint`, which is deliberately narrower — it
cannot see water load — and therefore fences less, never more.

Corrections are capped at **one per area**, first eligible sentence wins, and the shared
budget then caps the total at two. Ids are `hair:<area>:<code>:<verdict>` and
fingerprints are `guidanceFingerprint(["correction", id, code, verdict, source,
"consistency_only", unordered(truthCodes)])` — derived from the cut and the claim, never
from a counter or a clock, which is the whole retake story. Disclosure is always
`consistency_only`.

### Committed provenance is truth; cue freshness is salience

`buildChatAffordanceRead` gained one field, `committed: ChatCommittedHairState`
(`wetnessBand`, `wetnessCause`, `arrangement`, `coveredFraction`, `activeForce`, and
per-owner `available`). Handed back rather than re-derived for the same reason
`attributes` is: a fence built from a second reading of the same state could disagree
with the read it accompanies.

**Two windows, and they are not the same window.**

| | Governs | Source | Expiry |
| --- | --- | --- | --- |
| `CHAT_AFFORDANCE_EVENT_FRESHNESS_MINUTES` (60) | whether the domain may **volunteer** a cause ("still damp from the rain") — the cue/event path in `hairEvents` | the surface entry's `cause` + `updatedAtMinutes`, and active precipitation | 60 story minutes after the wetness last changed |
| `committedWettingCause` | whether a provenance claim is **wrong** — the premise fence | the surface entry's `cause` directly, while meaningful wetness remains | when the hair is dry |

Deriving the fence from the cue window was a defect: at story-minute 61 the hair is
still visibly soaked from the bath, `wetnessCause` went `null`, and a player blaming the
storm was silently believed. How long a cause is worth *mentioning* and how long it is
*true* are different questions, and only the first has an hour on it. The entry keeps
its `cause` for as long as it lives, and drying never restamps `updatedAtMinutes`
(`body-surface.ts` law 3), so the truth is readable the whole time.

Three ways to `null`, all silence rather than a guess: the hair is **dry** (nothing to
explain — the domain's own `dry` band, not `level === 0`); the recorded cause is `other`
or absent, which the map declines to translate; or **two live causes** (standing rain
landing on hair a bath already soaked), which is the original ambiguity rule preserved.
Standing precipitation answers when the entry cannot — it is rain landing on her now.

`activeForce` is not a fact about the hair and is evidence for nothing: it is the
relevance signal below, true when wind is above still air or precipitation is falling. A
past wetting event is deliberately NOT a force — a bath five minutes ago is not blowing
her hair around, and counting it would have kept the standing block that the relevance
gate exists to remove.

### Relevance: a fence has to be about something happening now

`buildChatPhysicalGuidanceStages` runs the detector FIRST (a correction is one of the
signals), computes `chatGuidanceRelevance`, and only then maps `read.constraints`
through `buildConstraintCandidates` with `hairClaimMappings(...)` — keeping the
candidates, which is what the inspector needs (the interesting failure sits *between*
candidates and result). `buildChatPhysicalGuidance` is the production entry point that
discards them.

A constraint candidate is admitted only when at least one signal holds:

| Signal | Holds when |
| --- | --- |
| `domain_reference` | the message carries a subject-bound hair reference in **any** span (eligibility is about correcting, not about what the turn is about), or **any** claim phrase at all, bound or not — plan §Architecture 4's "domain reference without a safely parsed claim may raise the priority of an already-known constraint. It must not invent a correction." |
| `premise_correction` | this turn produced a correction; the fence for its area rides along |
| `active_force` | `committed.activeForce` — a live gust makes "her hair streams behind her" plausible unprompted, which is exactly when the motion fence earns its bytes |
| `sensory_focus` | `detectSensoryFocus` resolved this turn's beat to the hair locus (threaded from the pipeline, which already computes it) |

No signal ⇒ no candidates ⇒ empty guidance ⇒ **zero prompt bytes**. The braid is true
all day, and the original build stated it on every exchange including "tell me about
your day" — an always-on block risks exactly the negative priming the closed cue
experiment already paid for once, and plan §6 compiles risk, not inventory.

**Corrections are never relevance-gated** — a correction is about the current turn by
construction — and neither is anything a later slice adds; this is the constraint tier's
admission rule only. A withheld fence files one `guidance.constraint.irrelevant` **info**
per resolved constraint on the sink (never on the guidance), because silence that a
developer cannot explain is the failure this feature's inspector exists to prevent. The
"no diagnostics when nothing is at stake" law is unchanged: it covers a cut with nothing
to say, whereas withholding a true fence is a decision worth recording.

The two halves still degrade independently: no read (or no perception view) still
premise-checks, and a message that is *about* the hair but asserts nothing still leaves
the fences standing. Neither half ⇒ `emptyNarratorPhysicalGuidance()` with **no
diagnostics**, so a nothing-to-say turn is indistinguishable from a feature-off one.

### The renderer (`chat-physical-guidance-render.ts`)

`renderChatPhysicalGuidance` calls `assertNoResolverOnlyLeak` **first**; any error drops
the whole block and files the diagnostics on the sink (degraded silence over an unsafe
prompt — never a throw). Otherwise it emits corrections then constraints, in the
compiler's order:

```text
- Premise check: the player's <area> claim conflicts with committed state. Do not adopt <display> as <area object>. Do not correct the player aloud unless <Name> would naturally do so.
- Premise check: the player's <area> claim (<display>) is not established in the story. Do not treat it as fact; leave it unconfirmed rather than inventing detail.
- Binding constraint: do not describe <possessive> hair as <displays>[; <truth clause>].
```

`chatPhysicalGuidanceBlock(lines)` prepends `PHYSICAL_GUIDANCE_BLOCK_HEADING` and
`PHYSICAL_GUIDANCE_PRECEDENCE` and returns `""` for an empty list.

Three wording laws, each pinned by a test:

1. **A constraint-only turn contains no instruction to mention a body detail.** The only
   imperative about describing is a prohibition — the closed cue experiment's failure mode
   was raising the number of checkable claims.
2. **A correction never voices the committed truth.** `truthCodes` ride the candidate for
   the inspector and the eval harness and are absent from the prose: the cause may be
   hidden, and "actually it was a bath" both leaks it and invites the narrator to argue
   with the player.
3. **A constraint's truth clause ships only when perception licensed it** —
   `allowedClaimCodes` is empty unless every locus was visible, decided upstream; the
   renderer just renders what is there. A code it cannot word is skipped, and a constraint
   with no wordable prohibition renders nothing.

The `or` in a phrase list is skipped when the final display phrase already carries one,
so `[loose, free_flow]` reads "loose, cascading, streaming, or whipping" rather than
"loose, or cascading, …".

### Wiring points

| Where | Change |
| --- | --- |
| `prompts/constants.ts` | `chatPhysicalConstraintsEnabled()` — `process.env.CHAT_PHYSICAL_CONSTRAINTS === "on"` |
| `prompts/character-chat.ts` | optional **top-level** `physicalGuidance?: readonly string[]` (turn-scoped, not state), rendered as a binding turn note between the narrator-input note and the notation note |
| `chat-pipeline.ts` | the affordance read is built when `chatAffordanceCuesEnabled() \|\| physicalConstraintsEnabled`; **cue rendering and the `affordanceCueState` write are re-gated on the cue flag alone**, so the new flag can neither revive the closed experiment nor spend its repeat gate. Guidance is compiled inside a try/catch (a failure degrades to no block) and threaded by conditional spread. The turn's already-computed `detectSensoryFocus` hint is passed in as the fourth relevance signal. `previewChatPrompt` runs the same compile over the stored cut and the newest player line, re-detecting the focus from that line so the preview cannot report a decision the turn would not have made |
| preview | `chat-physical-guidance-preview.ts` + `previewChatPhysicalGuidance` + `GET /api/admin/chat-inspector/:chatId/physical-guidance` + `physicalGuidancePreviewSchema` + `chat-inspector-physical-guidance.tsx`, mounted after the affordances panel |

Preview shape: `{ flagEnabled, inputAuthority: { narratorInput, message, spans[], eligibleSpans }, committed: { …, available[] }, relevance: { relevant, signals[], constraints: [{ code, admitted, reason }] }, candidates: { constraints[], corrections[], diagnostics[] }, selection: { constraints[], corrections[], dropped[] }, rendered[] }`. Silence here has six causes that look identical from the prompt — flag off, message ineligible, owner unavailable, claim ambiguous, **fence true but not relevant**, candidate over budget — so every stage shows its own input. The relevance stage names the signals that admitted a constraint, or `not relevant` per resolved constraint code; `dropped` is read off the diagnostics rather than diffed, so the reason survives with the fact.

### Test inventory

| File | Cases |
| --- | --- |
| `domains/hair/claims.test.ts` | lexicon invariants (every code speakable/displayable/in an area, every area covered, phrases lowercase+trimmed, **no phrase owned by two codes**, unique codes, every committed value resolves), the ordered scale, the four mappings + their prohibit/truth pairs + unknown-state emptiness, the matcher (longest-phrase-in-area, word boundary, no stemming, bath ≠ weather, index reporting, case/punctuation), the reference nouns (styles yes, adjectives and foreign nouns no, single lowercase tokens), and the wetness anchor (wettings yes, cause words alone no, `dry` excluded, word-boundary) |
| `domains/hair/phenomena.test.ts` | `hair.bulk_restraint`: `no_restraint` on free hair, one constraint per gate at the hair location, **needs no wind**, agrees with the wind read's suppression code across every arrangement × coverage × wetness combination, never produces an observation or a cue, and stays true behind opaque coverage |
| `domains/hair/hair.test.ts` | five registered phenomena; each worked case's constraint (`—`, `water_loaded`, `bound`, `covered`) alongside its existing observation assertions |
| `chat-physical-guidance.test.ts` | 50 cases: authority (narrator mode, every ineligible span kind, both sources, empty turn), sentence guards (question, hypothetical/wish/simile, negation before vs after, missing/foreign possessive, modifier window, pronoun ambiguity, hair without a claim), **clause binding** (the streaming-curtains and river fixtures, same-clause claims, ownership inheritance vs. the no-noun clause, another person's hair, `friend Mira's`), **the wetness anchor** (five scenery fixtures silent, three wettings firing, no cause across a boundary), every verdict law incl. the degree asymmetry and the `dry` case, all three `unsupported` owners, per-area cap, determinism, disclosure, **relevance** (no signal, each of the four signals, compile with and without one, corrections never gated), and compile shape (worked example, perception licensing, fences on a hair-referencing turn, silence + `guidance.constraint.irrelevant` on an unrelated one, corrections without a read, empty-with-no-diagnostics, budget) |
| `chat-physical-guidance-render.test.ts` | 13 cases: the worked line with and without its truth clause, unwordable codes, the constraint-only no-invitation assertion, correction wording per verdict and per area, tier order, leak ⇒ empty + `error`, empty ⇒ `[]`, block heading/precedence |
| `chat-affordances.test.ts` | provenance vs. cue freshness: the cause survives the 60-minute window while the hair is wet, the CUE path still ages out at the same minute, `dry` ⇒ `null`, `other`/unrecorded ⇒ `null`, two live causes ⇒ `null` while standing rain answers for itself, and `activeForce` (still air no, gale yes, rain yes, a five-minute-old bath **no**) |
| `chat-physical-guidance.int.test.ts` | 9 cases: flag off ⇒ no block (with the soaking proven on the row), flag on ⇒ the ON prompt is the OFF prompt with one block spliced in, the braid+bath cut vs a storm claim ⇒ fence + two premise checks with the bath never reaching the prompt and **no cue block**, a hair-referencing message asserting nothing ⇒ fence only, **"tell me about your day" over the same committed cut ⇒ no block at all**, **an outdoor gale ⇒ the motion fence with no player line about it**, a narrator-mode line ⇒ fence only, two rebuilds ⇒ identical lines and selection fingerprints, and the inspector's staircase with the flag off |
