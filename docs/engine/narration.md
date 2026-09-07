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

## Exchange ownership

`apps/web/src/server/engine/sim-exchange.ts` dispatches exchange modes after
`sim-exchange/context.ts` resolves authority and freezes one narrator instruction
source under the caller's exchange lock. That context is passed unchanged through
co-present dialogue, departure, accompany, solo narration, and same-cut rerender.
Presentation and memory reads share the context owner; no mode resolves a second
instruction source.

Within `sim-exchange/`, `turn.ts` routes fresh turns, `admission.ts` admits player
commands, and `engagements.ts` owns standing-scene lookup and opening. `dialogue.ts`
renders co-present turns, `travel.ts` coordinates departure and accompany, `solo.ts`
builds and renders solo cuts, and `retake.ts` rerenders an existing committed cut.
`time.ts` shares drain and arrival settlement with command routes while durable
catch-up jobs remain in `sim-time-jobs.ts`. Both conversation lanes use
`chat-reply-store.ts` for reply persistence and browsable takes.

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
not an instruction the model could ignore.

`mustEnact` carries only the beats relevant to this response, never a dump of
everything due. `allowedTransitions` are beats already resolved elsewhere in
the turn that the narrator may portray — not permission to decide a new hard
outcome in prose.

### Perspective filtering

The cut query joins through the observation ledger before it reads event
detail: an actor who witnessed something gets it as a required beat; an actor
who did not gets no actor, item, source, destination, event, or denial-cause
detail at all — only a generic prohibition on claiming the unobserved change.
The filtering happens in the query, not in prompt wording, so a
non-observer's cut structurally cannot carry the detail regardless of how the
narrator is instructed to behave.

### Forbidden claims

Alongside the state it does carry, a cut lists the claims prose must not make.
The catalog spans: an actor in an impossible place; travel
without a journey; possession or consumption without an event; knowledge
without belief or evidence; access without a grant or a successful explicit
attempt; action incompatible with activity or body claims; speech or action
attributed to the player's own actor without player authorization; disclosure
of a private denial cause; and a future event stated as already completed.

### One snapshot

A cut is a picture of one committed branch state. The turn's own commands —
advancing story time, deliberation, departures — commit first, outside any
read transaction. Every input the compiler then consumes (the branch head,
the interval's events, space, observations, activities, beliefs, pressures,
soft canon, body reads) is loaded inside one read-only repeatable-read
transaction, so the cut's `branchVersion`, sequence range end, story time,
events, and projections all describe the same committed state: a command
that commits while those reads run lands wholly before or wholly after the
cut, never across it. The loaders the assembler calls take that transaction
rather than opening reads of their own. Persisting the cut and acknowledging
pressures happen after the transaction closes.

### Stability

A NarrativeCut is immutable and addressable: recompiling the same cut ID
either reproduces the same `semanticHash` or fails with a version diagnostic.
Prompt formatting built on top of a cut may change over time, but the
semantic cut itself stays inspectable and stable. The
successor narrator reaches a persisted cut through `renderCommittedCut` →
`buildSimRenderPrompt`, re-reading the same cut for every retry attempt — a
rerender reuses the same cut ID and hash and carries no command or
persistence capability of its own. Legacy character chat builds its prompt
through `buildCharacterChatPromptParts` and never reaches a NarrativeCut at
all; the two lanes stay separate.

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

Every field is resiliently parsed with a safe default (pattern detailed in
[resilience.md](../resilience.md)). Within a cut, the
narrator is free to choose phrasing, sensory focus, gesture, pacing, subtext,
and bounded licensed detail; it enacts the beats the cut requires and does not
assert any claim on the forbidden list.

### Hard effects

Movement, item transfer, body injury, resource consumption, access, and
activity completion resolve before narration runs — they never wait on prose
confirmation. If prose omits a required hard beat, the presentation auditor
can request a rerender or append a deterministic bridge sentence, but it
cannot undo an event that already happened. This is what
keeps a flaky or evasive model response from ever rolling back world state.

### Armed effects

An armed effect is for a semantic outcome that exists only if it is actually
expressed — a promise offered or accepted, an invitation, a disclosure, a
warning, a boundary, a question, an apology, or a permission granted or
withdrawn:

```ts
type ArmedEffect = {
  id: string;
  cutId: string;
  preconditionVersion: number;
  effectType: SpeechActType;
  actorId: string;
  targetActorIds: string[];
  detail: string;
  disclosureContent?: DisclosureContent;
  consentScopeKey?: ConsentScopeKey;
};
```

`detail` is a short human-readable summary of the content, and the only part of
an effect the prompt shows the narrator; it is never parsed back into state.
The two optional fields carry structure free text cannot. `disclosureContent`
is legal only on a `disclosure_made` effect: enacting one appends a real
knowledge event alongside the speech act, so gossip spoken in prose enters the
belief ledgers with full provenance. `consentScopeKey` names the scope a
boundary or permission covers, and is required on exactly the three
consent-scoped types — `boundary_expressed`, `permission_granted`, and
`permission_withdrawn` — and rejected on every other.

After narration, each ID the narrator claims to have enacted is filtered
against the cut's own `armedEffects` membership; unlisted IDs are ignored and
unenacted effects expire. Confirming also requires this cut to still be the
engagement's newest — a superseded cut is refused (`cut_superseded`) rather
than confirmed against changed state — with no separate actor or
branch-version recheck. Armed effects exist for speech acts, not a side door
for physical outcomes to reach the world without hard-effect resolution.

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
state by accident.

Post-turn extraction is deliberately narrow: it only pulls information
deterministic code could not already know — episode compression, semantic
propositions actually spoken, and permitted soft-canon proposals. It never
decides completed movement, item transfer, body effects, commitment outcomes,
access, or witness eligibility; those stay hard-effect territory.

## Building the prompt

`sim-render.ts` assembles the narrator prompt under the shared presentation
charter (`prompts/charter.ts`). The charter separates two concepts that are
easy to conflate: the **epistemic viewpoint** — whose knowledge partitions the
cut — from the **prose camera** — second person addressed to the player,
third person for everyone else. The narrator never authors the player's own
words, thoughts, feelings, or actions.

The prompt never carries raw identifiers. Beats and armed effects are
addressed by opaque, per-cut-deterministic handles (`B1..Bn` over `mustEnact`
then `allowedTransitions`, `E1..Em` over `armedEffects`); zones and actors
render as display labels; pressures render as relative story time. The trust
boundary (`parseNarratorResult`) maps declared handles back to real IDs before
validating anything else — a value that doesn't map falls into the existing
unknown-ID handling rather than being trusted. Player text, summaries, memory
lines, and transcript tails are fenced as untrusted data (`prompts/untrusted.ts`)
before they reach the prompt.

### The solo cut

When a turn runs WITHOUT a co-present primary — the player walked off, or either
party is in transit — the render is **dual-block**: a second-person player-side
block (the player's own zone, co-present NPCs, held items), then a third-person
**away vignette** of the primary living their engine-supplied routine MUSTs
(location, active activity, due commitments), for the reader only and never
player-character knowledge. It reuses the SAME charter blocks as `sim-render.ts`
(canon, presentation state, conversation) and only swaps the COMMITTED-TRUTH
block for a SOLO SCENE block and the JSON contract for `{prose}` — builder
`prompts/sim-solo-render.ts`, render loop `renderSoloNarration` in
`sim-narrator.ts`, pure shaping `@vesper/simulation-core/solo-cut`. A solo turn
advances the branch clock 60s (draining triggers) and never dead-ends: it always
degrades to a deterministic dual-block fallback.

The composer's **Narrator input mode** flows into successor turns, co-present and
solo alike — a `narrator` send is storyteller steering, so it skips input
admission and reframes the player-turn block.

### Departure context on the solo prompt

When the solo turn is a player-CHOSEN departure — an admitted natural-language "I
walk to the town square" — block (a) gains a one-line **departure arc**: whom the
player just left (only on a farewell, when a co-present scene was ended as a
choice) and the from/to zones. Block (a) then narrates the goodbye, the walk, and
the arrival as ONE continuous beat, never a jump-cut; block (b) stays the
primary's away vignette, which may naturally show them in the moments after the
player left. The choreography — end scene as `participant_choice` → move → drain
to arrival — runs BEFORE the render, so the solo turn skips its own 60s span
advance: the clock already jumped the travel. The line is pure
(`buildSoloDepartureLine`, `@vesper/simulation-core/departure`) and rides in via
`SimSoloRenderContext.departure`.

## Narrator instruction authority

Every narrator builder — successor co-present (`prompts/sim-render.ts`),
successor solo (`prompts/sim-solo-render.ts`), and the legacy character-chat 1:1
and ensemble builders — emits a tree of **classified nodes** and renders it once,
rather than joining strings ad hoc. The classification is
`contracts/narrator-prompts/authority.ts`, and it exists so exactly one layer can
be swapped for hand-written text without disturbing anything else:

- **`behavior`** — narrator craft: role, prose camera, pacing, richness, dialogue
  style, topic discipline. The only layer that is ever replaced.
- **`runtime_context`** — authored and committed facts.
- **`runtime_invariant`** — fences that bound the reply whatever its style:
  player-agency law, perception ceilings, untrusted-data fencing, the minor
  fence, per-turn physical and sensory ceilings.
- **`transport_contract`** — anything software downstream parses: the `[Name]`
  speaker-tag grammar the chat renderer segments on, the successor's strict JSON
  schema, the retry correction block.

**Units split at sentence boundaries, and a mixed sentence takes the strictest
authority.** Several charter units are one string that crosses the line — the
viewpoint rule ends with *"never put words, thoughts, or actions in their
mouth"*, and the narrator-camera rule mixes where the camera sits (craft) with
what may never be written for the player (law). Left whole and marked craft, a
prompt experiment could delete the very clause that protects player agency. The
split pieces rejoin with the separator they were already written with, and
`cameraViewpointRule`, `narratorCameraRule` and `PHYSICAL_STATE_LAW_RULE` are
**derived from** their nodes, so there is no second copy of the text to drift.

**Rule numbers are positional, not authored.** `CHAT_RULES` and
`ENSEMBLE_CHAT_RULES` are `numbered_list` nodes whose numbers come from index, so
production renders the same 1…16 and 1…12 it always did, and a prompt that drops
behavior rules renumbers its survivors contiguously instead of leaving gaps.
Nothing may cite a rule by its displayed number — bind to heading names, as
[../character-chat/prompts.md](../character-chat/prompts.md) §Style rules for
prompt text requires.

Blank separation is structural, not literal: the tree uses `separator: "\n\n"`
with `dropEmpty` rather than `""` entries in a `join("\n")`. The two render
identically, but literal empties would strand blank lines wherever a dropped unit
used to be.

An optional `instructionSource` on each builder's input decides the render.
Absent, or `{kind:"production"}`, and the prompt is byte-identical to the
unclassified build. `{kind:"test"}` drops every `behavior` unit and puts
the owner's text in an explicit `behavior_slot` — visible in the builder rather
than an emergent property of a filter. The source resolves once
per exchange, after the exchange lock, and is frozen across hidden retries; helper
agents never see it. The owner-facing tool that writes these prompts is the
Narrator Prompt Lab.

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
over length alone.

A retry is never a blind reroll: the second attempt rebuilds the prompt from
the same persisted cut, with a correction block naming exactly what the
previous audit rejected. A deterministic bridge sentence is the last resort,
used only after the feedback retry has already run, and always appended as
its own paragraph rather than spliced mid-sentence. Semantic verification — a
beat genuinely enacted in meaning, a forbidden claim truly absent even in
paraphrase — stays a property the prompt is written to encourage, not
something the structural audit checks.

## Confirming a cut

`confirm_narrator_result`'s idempotency key derives from the cut ID alone,
and the cache is status-blind: whichever result — accepted, rejected, or
conflict — was stored first for that key is what every later retake replays,
verbatim. A cut whose first confirm is rejected (`nothing_to_record`, when
neither an armed effect nor a soft-canon proposal survived validation) stays
rejected forever; no later retake of that cut can succeed. When a confirm
does get accepted, a retake still never re-arms truth — it cannot supersede
the original armed effects, so they can't be delivered twice.

## Invariants

- A cut's privacy boundary is enforced by omitting fields at compile time, not
  by prompting the model to stay quiet about them.
- `mustEnact` and `allowedTransitions` never grant the narrator a new hard
  outcome to decide — only which already-resolved beats to portray and how.
- Hard effects are final before narration starts; no presentation-side retry,
  bridge, or audit failure can undo one.
- Armed effects only exist if the narrator's prose expresses them, and only
  ever carry speech-act outcomes — never a route for physical state changes.
- Soft canon promotion to hard state is always an explicit, audited event,
  never an automatic side effect of reuse.
- The prompt carries opaque handles and display labels, never raw IDs — the
  trust boundary remaps handles back to real IDs, so a value that doesn't map
  is treated as unknown rather than trusted.
- A cut confirms its presentation at most once; a retake changes what is
  shown, never which effects were armed.
- A cut's metadata, events, and projections describe one committed branch
  state; no command commits partway through its inputs.

## Degradation

Everything the narrator returns crosses a trust boundary and is resiliently
parsed with a safe default per the `parseOr` pattern in
[resilience.md](../resilience.md). A failed presentation
audit degrades to a corrective retry and, failing that, a deterministic bridge
paragraph rather than a failed turn — the turn always
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
