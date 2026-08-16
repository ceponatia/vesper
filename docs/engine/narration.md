# Narration

Narration is the last leg of a simulation turn: it takes the branch state a
turn's commands and events just changed and turns the slice of it one actor
may know into prose. Two contracts carry the work — the **NarrativeCut**, an
immutable, perspective-filtered snapshot the compiler hands to the narrator,
and the **narrator/effects contract**, which governs what the narrator may say
and which outcomes its prose can still change. The compiler and cut store live
in `apps/web/src/server/engine/simulation` (`arbiter-store.ts`,
`narrative-cut-store.ts`); the prompt, its trust boundary, and the audit live
in `apps/web/src/server/engine/prompts` and `apps/web/src/server/engine/sim-narrator.ts`.

For how the state inside a cut gets decided — perception, deliberation, beats
— see [mind.md](mind.md). For how beliefs, assertions, and evidence are
tracked and later surfaced as `speakerBeliefs` and `perceptibleNow`, see
[knowledge.md](knowledge.md).

## How it works

1. The compiler builds a `NarrativeCut` from the branch's projected state for
   one viewpoint actor and one engagement, addressed by a stable cut ID.
2. `sim-render.ts` turns the cut into a prompt under the shared presentation
   charter, addressing beats and armed effects by opaque handles rather than
   raw IDs.
3. The narrator model returns prose plus which beats and armed effects it
   enacted and which soft-canon facts it proposes. The result crosses a trust
   boundary (`parseNarratorResult`) before anything downstream trusts it.
4. A deterministic presentation audit checks the prose for leaks, contract
   echoes, and thinness; a failed check triggers one corrective retry, then at
   most a deterministic bridge paragraph.
5. `confirm_narrator_result` commits the cut's presentation exactly once,
   arming the effects the narrator actually enacted.

Hard effects (movement, item transfer, injury, resource use, access,
activity completion) are never part of this pipeline — they are already
resolved in branch state before the cut is compiled, so narration presents
them rather than causing them.

## The NarrativeCut

A cut's fields fall into a few groups:

| Group            | Purpose                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Identity & range | pins the cut to one branch, its sequence and story-second range, compiler version, and hash |
| Viewpoint        | which actor's eyes, which engagement this cut belongs to                                    |
| Scene state      | perspective-safe loci, activities, and body reads — mind.md, bodies.md                      |
| Turn content     | beats to enact now vs. already-resolved transitions to portray                              |
| Evidence         | perceptible events, beliefs, pressures — mind.md, knowledge.md                              |
| Boundaries       | forbidden claims, failure presentations, creative licenses                                  |
| Effects          | armed effects the narrator may trigger by expressing them                                   |
| Provenance       | source trace behind every compiled fact                                                     |

```ts
type NarrativeCut = {
  id: string;
  semanticHash: string;
  compilerVersion: string;
  worldId: string;
  branchId: string;
  branchVersion: number;
  engagementId: string;
  viewpointActorId: string;
  fromSequence: number;
  throughSequence: number;
  fromStorySecond: number;
  throughStorySecond: number;
  currentLoci: PerspectiveSafeLocus[];
  currentActivities: PerspectiveSafeActivity[];
  mustEnact: NarrativeBeat[];
  perceptibleNow: EvidenceView[];
  speakerBeliefs: BeliefView[];
  relevantPressures: PressureView[];
  allowedTransitions: NarrativeBeat[];
  forbiddenClaims: ForbiddenClaim[];
  failurePresentations: PublicFailurePresentation[];
  creativeLicenses: CreativeLicense[];
  armedEffects: ArmedEffect[];
  bodilyReads: CutBodilyReads;
  provenance: ProvenanceRef[];
};
```

The compiler omits private fields from the cut outright rather than asking the
narrator's prompt not to mention them — the privacy boundary is structural,
not an instruction the model could ignore (engine.spec §22.1).

`mustEnact` carries only the beats relevant to this response, never a dump of
everything due. `allowedTransitions` are beats already resolved elsewhere in
the turn that the narrator may portray — not permission to decide a new hard
outcome in prose (engine.spec §22.1).

### Perspective filtering

The cut query joins through the observation ledger before it reads event
detail: an actor who witnessed something gets it as a required beat; an actor
who did not gets no actor, item, source, destination, event, or denial-cause
detail at all — only a generic prohibition on claiming the unobserved change
(engine.spec §22). The filtering happens in the query, not in prompt wording, so a
non-observer's cut structurally cannot carry the detail regardless of how the
narrator is instructed to behave.

### Forbidden claims

Alongside the state it does carry, a cut lists the claims prose must not make.
The catalog spans (engine.spec §22.2): an actor in an impossible place; travel
without a journey; possession or consumption without an event; knowledge
without belief or evidence; access without a grant or a successful explicit
attempt; action incompatible with activity or body claims; speech or action
attributed to the player's own actor without player authorization; disclosure
of a private denial cause; and a future event stated as already completed.

### Stability

A NarrativeCut is immutable and addressable: recompiling the same cut ID
either reproduces the same `semanticHash` or fails with a version diagnostic.
Prompt formatting built on top of a cut may change over time, but the
semantic cut itself stays inspectable and stable (engine.spec §22.3). The
successor narrator reaches a persisted cut through `renderCommittedCut` →
`buildSimRenderPrompt`, re-reading the same cut for every retry attempt — a
rerender reuses the same cut ID and hash and carries no command or
persistence capability of its own. Legacy character chat builds its prompt
through `buildCharacterChatPromptParts` and never reaches a NarrativeCut at
all; the two lanes stay separate (engine.spec §22).

## The narrator contract

The narrator returns a small, trust-boundary-checked result:

```ts
type NarratorResult = {
  prose: string;
  enactedArmedEffectIds: string[];
  enactedBeatEventIds: string[];
  proposedSoftCanon: SoftCanonProposal[];
  diagnostics?: string[];
};
```

Every field is resiliently parsed with a safe default (engine.spec §23.1;
pattern detailed in [resilience.md](../resilience.md)). Within a cut, the
narrator is free to choose phrasing, sensory focus, gesture, pacing, subtext,
and bounded licensed detail; it enacts the beats the cut requires and does not
assert any claim on the forbidden list (engine.spec §23.1).

### Hard effects

Movement, item transfer, body injury, resource consumption, access, and
activity completion resolve before narration runs — they never wait on prose
confirmation. If prose omits a required hard beat, the presentation auditor
can request a rerender or append a deterministic bridge sentence, but it
cannot undo an event that already happened (engine.spec §23.2). This is what
keeps a flaky or evasive model response from ever rolling back world state.

### Armed effects

An armed effect is for a semantic outcome that exists only if it is actually
expressed — a promise, an invitation, a disclosure, a warning, a boundary, a
question, or an apology (engine.spec §23.3):

```ts
type ArmedEffect = {
  id: string;
  cutId: string;
  effectType: string;
  actorId: string;
  targetActorIds: string[];
  payload: unknown;
  expiresAfterCut: boolean;
  preconditionVersion: number;
};
```

After narration, each ID the narrator claims to have enacted is filtered
against the cut's own `armedEffects` membership; unlisted IDs are ignored and
unenacted effects expire. Confirming also requires this cut to still be the
engagement's newest — a superseded cut is refused (`cut_superseded`) rather
than confirmed against changed state — with no separate actor or
branch-version recheck. Armed effects exist for speech acts, not a side door
for physical outcomes to reach the world without hard-effect resolution
(engine.spec §23.3).

### Soft canon

The narrator may also propose small, non-authoritative facts:

```ts
type SoftCanonProposal = {
  key: string;
  value: unknown;
  scope: "scene" | "relationship" | "character" | "location" | "world";
  subjectIds: string[];
  confidenceFixedPoint: number;
  validUntil?: number;
  sourceCutId: string;
};
```

`subjectIds` names who or where the fact is about — actors for scene,
relationship, or character scope, a zone for location scope, empty for world
scope; the scope check rejects any subject outside the cut's own visible
actors and zones. A proposal also passes conflict, privacy, duplication, and
world-type checks before it is kept, and can be rejected without
regenerating the prose that proposed it. Reused soft canon can be promoted
into audited, provenanced hard state through a separate ruled path, but
promotion is always its own explicit event — soft canon never turns into hard
state by accident (engine.spec §23.4).

Post-turn extraction is deliberately narrow: it only pulls information
deterministic code could not already know — episode compression, semantic
propositions actually spoken, and permitted soft-canon proposals. It never
decides completed movement, item transfer, body effects, commitment outcomes,
access, or witness eligibility; those stay hard-effect territory (engine.spec
§23.4).

## Building the prompt

`sim-render.ts` assembles the narrator prompt under the shared presentation
charter (`prompts/charter.ts`). The charter separates two concepts that are
easy to conflate: the **epistemic viewpoint** — whose knowledge partitions the
cut — from the **prose camera** — second person addressed to the player,
third person for everyone else. The narrator never authors the player's own
words, thoughts, feelings, or actions (engine.spec §23.5).

The prompt never carries raw identifiers. Beats and armed effects are
addressed by opaque, per-cut-deterministic handles (`B1..Bn` over `mustEnact`
then `allowedTransitions`, `E1..Em` over `armedEffects`); zones and actors
render as display labels; pressures render as relative story time. The trust
boundary (`parseNarratorResult`) maps declared handles back to real IDs before
validating anything else — a value that doesn't map falls into the existing
unknown-ID handling rather than being trusted. Player text, summaries, memory
lines, and transcript tails are fenced as untrusted data (`prompts/untrusted.ts`)
before they reach the prompt (engine.spec §23.5).

## Presentation audit and retry

Before the structural audit runs, model prose is normalized — artifacts
stripped, repeated blocks collapsed, fences and quotes trimmed. The audit
itself is deterministic and structural, not a semantic read of the prose. It
rejects three things: an id or handle token leaking into prose
(`presentation.id_leak`), prose that reads as JSON or echoes contract field
names or placeholder brackets (`presentation.contract_echo`), and prose that
falls under a substance floor (`presentation.too_thin`), recorded whenever
prose comes in under the floor with beats or an utterance in play, on every
attempt — only the verdict depends on attempt context: a non-final attempt
reruns, the final attempt accepts thin prose rather than withholding a turn
over length alone (engine.spec §23.6).

A retry is never a blind reroll: the second attempt rebuilds the prompt from
the same persisted cut, with a correction block naming exactly what the
previous audit rejected. A deterministic bridge sentence is the last resort,
used only after the feedback retry has already run, and always appended as
its own paragraph rather than spliced mid-sentence. Semantic verification — a
beat genuinely enacted in meaning, a forbidden claim truly absent even in
paraphrase — stays a property the prompt is written to encourage, not
something the structural audit checks (engine.spec §23.6).

## Confirming a cut

`confirm_narrator_result`'s idempotency key derives from the cut ID alone,
and the cache is status-blind: whichever result — accepted, rejected, or
conflict — was stored first for that key is what every later retake replays,
verbatim. A cut whose first confirm is rejected (`nothing_to_record`, when
neither an armed effect nor a soft-canon proposal survived validation) stays
rejected forever; no later retake of that cut can succeed. When a confirm
does get accepted, a retake still never re-arms truth — it cannot supersede
the original armed effects, so they can't be delivered twice (engine.spec
§23.7).

## Invariants

- A cut's privacy boundary is enforced by omitting fields at compile time, not
  by prompting the model to stay quiet about them (engine.spec §22.1).
- `mustEnact` and `allowedTransitions` never grant the narrator a new hard
  outcome to decide — only which already-resolved beats to portray and how
  (engine.spec §22.1).
- Hard effects are final before narration starts; no presentation-side retry,
  bridge, or audit failure can undo one (engine.spec §23.2).
- Armed effects only exist if the narrator's prose expresses them, and only
  ever carry speech-act outcomes — never a route for physical state changes
  (engine.spec §23.3).
- Soft canon promotion to hard state is always an explicit, audited event,
  never an automatic side effect of reuse (engine.spec §23.4).
- The prompt carries opaque handles and display labels, never raw IDs — the
  trust boundary remaps handles back to real IDs, so a value that doesn't map
  is treated as unknown rather than trusted (engine.spec §23.5).
- A cut confirms its presentation at most once; a retake changes what is
  shown, never which effects were armed (engine.spec §23.7).

## Degradation

Everything the narrator returns crosses a trust boundary and is resiliently
parsed with a safe default per the `parseOr` pattern in
[resilience.md](../resilience.md) (engine.spec §23.1). A failed presentation
audit degrades to a corrective retry and, failing that, a deterministic bridge
paragraph rather than a failed turn (engine.spec §23.6) — the turn always
produces prose, even when the model's own attempt is rejected twice.

## Related

- [mind.md](mind.md) — perception and deliberation that produce the loci,
  activities, and beats a cut compiles from.
- [knowledge.md](knowledge.md) — beliefs, assertions, and evidence that
  populate `speakerBeliefs` and `perceptibleNow`.
- [@vesper/simulation-core](../../packages/simulation-core/README.md) — perspective and
  narration contracts, and the chat narrator's entry point.
- [../resilience.md](../resilience.md) — the trust-boundary parsing pattern
  used at the narrator result boundary.
- Normative source: `docs/developer-notes/engine.spec.mind.md`, engine.spec
  §22 (NarrativeCut) and §23 (Narrator and effects).
