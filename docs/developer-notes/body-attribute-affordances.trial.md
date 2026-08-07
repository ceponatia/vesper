# Slice 5 narrator trial — cue path vs. appearance path

Status: **closed — final verdict 2026-07-29 after a four-round campaign**
(first live round $0.72, then the three-round rematch campaign, $6.29 — see
§Rematch log). Companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
§"Slice 5 — narrator trial"; rematch protocol:
[rematch spec](body-attribute-affordances.trial.rematch.md). Harness:
`scripts/eval/affordance-cues/`.

## Recommendation — FINAL

**`CHAT_AFFORDANCE_CUES` parks OFF.** The rematch campaign reached its
pre-committed stopping rule on 2026-07-29: two consecutive rounds with a
VALID induction gate (the matrix demonstrably tempted the control arm into
contradictions at 0.50 and 0.44 per exchange) in which the cue arm failed the
frozen decision rule — it never reduced contradictions (R2 −6%, R3 +29%
relative to control). The cue arm did consistently raise specificity, and the
**working hypothesis** for the missing net gain is that volunteering a concrete
physical detail raises the number of checkable — therefore convictable — claims.
That hypothesis is consistent with the specificity results; it is **not** a
proven causal law, and this campaign could not have made it one: one narrator
model, one domain (the reachable half of hair), ~24 paired exchanges per round,
and dimensions that no change touched swinging by 0.5 contradictions/exchange
between rounds. The decision below rests on the frozen decision rule, not on the
mechanism. Repetition reached zero in R3 and false-premise adoption was
eliminated in R2; each was a promising round-local result, not a replicated
effect. Neither changed the pre-registered trade ("reduces contradictions").

The first live round (below, §Live results) failed for the opposite reason —
a matrix with no contradiction headroom — and is kept as the record of why
the rematch campaign existed. Full round-by-round history in §Rematch log.
The replacement is new design work in
[constraint-first narrator physical guidance](narrator-physical-guidance.plan.md),
where constraints/action outcomes and change-gated details receive separate
release decisions. This flag and this trial are closed.

## Owner rulings (2026-07-28, same day)

The deterministic run raised two items and both were ruled the day it ran. The
first — whether to replace the dead model key mid-session — was answered by
deferring the live half; it ran on a replaced key the next day, and everything
that followed is in §Live results and §Rematch log. The second is still
standing policy:

- **The sensory-allowance collision is resolved: cues win.** A current
  physical-effect cue counts as new information, not static appearance — the
  no-appearance instruction exists to stop re-describing unchanged looks and
  must not suppress the cue block. Implemented the same day (with the slice 6
  garment work): when the allowance is `none` and cue lines are present, the
  allowance line carves out the cue block by its shared heading constant
  (`chatSensoryAllowanceLine`, `AFFORDANCE_CUE_BLOCK_HEADING`); prompts are
  byte-identical whenever the flag is off or no cue fired. Selection/ranking
  in `contracts/affordances` never reads the allowance — this is
  prompt-projection policy only. Every live round therefore measured the cues
  rather than the collision; §Design finding below is kept as the record of why
  the ruling was needed.

## Method

Ten scripted conversations, three consecutive exchanges each — **30 paired
exchanges, 60 narrator generations, 10 judge calls** when run live. Every scenario
is built from committed typed state (a story clock, a `ChatEnvironment`, a
`body_surface` wetness entry carrying its own cause, real worn garment rows) and
never from prose, because prose is what this layer refuses to treat as an input.

Both arms receive identical inputs; the only difference is whether the rendered
cue block reaches the prompt. The read (`buildChatAffordanceRead`), projection
(`renderChatAffordanceCues`), per-turn sensory allowance
(`deriveChatSensoryAllowance`) and prompt (`buildCharacterChatSystemPrompt`) are
all the production functions. The harness assembles only the state slice that
`chat-pipeline.ts` would have loaded from Postgres — identical for both arms — so
nothing about the cue path is re-implemented.

Generation goes through `streamCharacterChat` on the chat lane's default narrator
(`aion-labs/aion-3.0`) at the production temperature (0.85); each arm carries its
own history, so repetition is measured over what that arm actually said. Judging
is one call per scenario on a cheaper strong model (`google/gemini-3.5-flash`,
temperature 0), seeing both transcripts as A/B under a deterministic per-scenario
hash, with the committed state supplied per exchange as contradiction ground
truth. The ground-truth block excludes the rendered cue lines — a judge that could
see the cue block would know the arms on sight.

Full design, flags and decision rule: `scripts/eval/affordance-cues/README.md`.

## Scenario matrix

Ten scenarios. Character, hair arrangement, and committed wetness:

| id                       | character                   | hair  | wet                            |
| ------------------------ | --------------------------- | ----- | ------------------------------ |
| `rain-arrival-loose`     | Wren (dense/thick/wavy)     | loose | soaked → damp, cause rain      |
| `hooded-downpour-braid`  | Wren                        | braid | soaked, cause rain             |
| `clifftop-wind-dry`      | Ilse (sparse/fine/straight) | loose | dry                            |
| `bun-in-gale`            | Wren                        | bun   | soaked → damp, cause splash    |
| `bath-immersion-still`   | Wren                        | loose | soaked → damp, cause immersion |
| `soaked-and-windy`       | Wren                        | loose | soaked → damp, cause rain      |
| `sheer-scarf-splash`     | Wren                        | loose | soaked → damp, cause splash    |
| `damp-ends-in-gust`      | Ilse                        | loose | damp, cause rain               |
| `silent-dry-still-loose` | Wren                        | loose | dry                            |
| `silent-dry-still-braid` | Ilse                        | braid | dry                            |

Head covering, air condition, and what the cue is expected to do:

| id                       | covering    | air                        | expectation                                     |
| ------------------------ | ----------- | -------------------------- | ----------------------------------------------- |
| `rain-arrival-loose`     | none        | outdoor breeze → indoors   | clumping, rain provenance, then a band change   |
| `hooded-downpour-braid`  | opaque hood | gusting → indoors          | bound-mass clumping; wind suppressed by binding |
| `clifftop-wind-dry`      | none        | breeze → gusting → indoors | whole-hair motion, rising a band, then silence  |
| `bun-in-gale`            | none        | gusting → indoors          | clumping; wind suppressed by pinning            |
| `bath-immersion-still`   | none        | indoors, still             | clumping with **no** rain clause                |
| `soaked-and-windy`       | none        | outdoor strong wind        | water weight must beat the wind                 |
| `sheer-scarf-splash`     | sheer scarf | indoors, still             | clumping through partial coverage               |
| `damp-ends-in-gust`      | none        | gusting → indoors          | motion on damp (not saturated) hair             |
| `silent-dry-still-loose` | none        | indoors, still             | **silence control**                             |
| `silent-dry-still-braid` | none        | outdoors, dead calm        | **silence control**                             |

## Deterministic results

From `pnpm eval:affordance-cues --dry-run` (audit JSON at
`data/eval/affordance-cues/matrix.json`; `data/` is gitignored, so the numbers are
transcribed here). All 14 self-checks pass.

### Cue volume and the cap

Across the 30 exchanges the hair domain **resolved 23 observations** but the
ranking and repeat gate offered only **15 cue lines, over 14 exchanges** — the
other 9 were withheld. Distribution: `hair.wet_clumping` 12 clear / 4 subtle,
`hair.wind_or_motion_response` 4 strong / 1 clear / 2 subtle.

- Maximum cues in any one exchange: **2** (once — `soaked-and-windy` t1, clumping
  plus an ends-only motion read). The plan's "at most 1–2 cues per exchange" holds
  with no exceptions.
- Mean prompt growth on a cue-bearing exchange: **213 characters** (range
  185–289), roughly 50 tokens. On every cue-bearing exchange the cue-arm prompt is
  byte-for-byte the control prompt with exactly one block spliced in.

### Stable appearance vs. affordance cues do not duplicate

**0 of 15** cue lines restate a clause the prompt already carries elsewhere
(Attributes section, outfit phrase, garment lines). The projection speaks only in
current-effect verbs — *has separated into damp, clinging strands*, *streams loose
in the wind*, *sits dark and damp where it is bound up* — while the Attributes
block carries only stable form, so the two registers do not collide. The plan's
"static appearance is not repeated as a current effect" holds structurally, not by
luck.

### Silence controls

Both dry/still scenarios emitted **0 cues across 6 exchanges**, and in all 6 the
cue-arm prompt is **byte-identical** to the control's. The correct behaviour is
silence and the arms are literally indistinguishable. (This also means those six
exchanges carry no signal about the feature in a live run — they exist to
calibrate the *judge*: a one-sided A/B preference there would be label bias.)

### The repeat gate, across turns

Every cue scenario's second exchange leaves the physical state untouched. **7 of 8
went silent.** The exception is correct: `clifftop-wind-dry` t2 raises the wind
from breeze to gusting, which changes the band, and a band change is exactly what
earns the slot again. Cues resumed on t3 wherever the state genuinely moved
(a towel-off, a step indoors, a drying-out).

### A missing cause never produces an effect

Suppression codes over all 30 exchanges: `hair.sheds_droplets:no_current_impulse`
**30/30** and `hair.strands_adhere_to_skin:affordance.input.unavailable` **30/30**
— the two phenomena the chat lane cannot honestly feed stayed silent in every
single exchange, without exception. Motion was suppressed as `no_current_force`
17×, `water_loaded` 2×, `bound` 2× and `pinned` 2×; clumping as
`insufficient_wetness` 9× and `below_response_threshold` 5×. Every silence has a
named physical reason.

Provenance discipline holds too: the `still wet from the rain` clause appears only
in the rain-caused scenarios, and never in the bath (`immersion`) or the burst tap
and the spray (`splash`) — a bath does not read as weather.

## Live results (2026-07-29)

The full paired trial ran on the replaced key: 60 narrator generations (10
scenarios × 3 exchanges × 2 arms) plus 10 blinded judge calls, ~$0.72 total
(key usage 31.53 → 32.25). All 14 self-checks passed before the first billable
call. Audit JSON at `data/eval/affordance-cues/trial.json` (gitignored;
numbers transcribed here). Cue scenarios only — the 6 silence-control
exchanges carry no feature signal by construction:

> Runs from 2026-07-30 on also write `summary.json` beside `trial.json` — the
> transcript-free half of the record (fixture commit, model ids, prompt/config
> digests, raw dimension counts, verified violation quotes, spend) that is meant
> to be **committed** to
> [`scripts/eval/affordance-cues/results/`](../../scripts/eval/affordance-cues/results/README.md).
> The rounds below predate it, which is why their numbers exist only as this
> transcription.

| measure (per exchange unless noted)             | cues     | control    |
| ----------------------------------------------- | -------- | ---------- |
| contradictions                                  | **0.13** | **0.13**   |
| repetitions                                     | 0.08     | 0.00       |
| static restatements                             | 0.13     | 0.08       |
| specificity (1–5)                               | **4.38** | 4.00       |
| naturalness (1–5)                               | 4.63     | 4.63       |
| hair mentions                                   | 1.00     | 0.71       |
| judge preference — cue scenarios only           | 4        | 4 (0 ties) |
| judge preference — incl. the 2 silence controls | 4        | **6**      |

The silence controls — where both arms received byte-identical prompts, so any
preference is pure label/sampling noise — went 2–0 to "control", which is the
noise floor — and both of the "6"'s extra control picks came from exactly
those two scenarios, so among scenarios where the arms actually differed the
preference was a dead 4–4 tie. The round-1 runner pooled the two buckets, which
overstated the control lean; the rematch runner reports them separately, as the
figures above do.

Against the decision rule (§Re-running it): contradictions were **not** lower
and repetition **was** higher — the rule fails on both clauses. The specificity
gain is real and the cue-arm prose stayed exactly as natural, so the mechanism
works as designed; it just fixed a problem this matrix shows the narrator not
having. Per §Caveats, 24 paired exchanges is a directional sample and the
per-exchange-rate gaps here (0.08, 0.05) are within the "few hundredths is
noise" band — but a tie on the headline measure is not a pass, and "no
measurable benefit" is itself the finding.

## Design finding: the sensory allowance collides with the cue block

The one thing the deterministic half surfaced that is not a clean pass.

`sensoryAllowance` is derived from **the player's wording**
(`detectChatCue` / `detectSensoryFocus` over the current message); the affordance
cue block is derived from **body state**. They are computed from entirely
independent inputs and neither consults the other. So the prompt can — and in this
matrix usually does — carry both of these at once:

> Sensory allowance this turn: none — no scent, warmth, texture, or taste detail
> of Wren, and **no appearance description** beyond what Wren's own movement this
> turn makes newly visible.

> Physical detail worth noticing this turn (weave at most one into the beat, in
> action …): — Wren's auburn hair has separated into damp, clinging strands, still
> wet from the rain

Cross-tab over the 30 exchanges:

| allowance          | cue offered | no cue |
| ------------------ | ----------- | ------ |
| `none`             | **11**      | 6      |
| `visual_accent`    | 1           | 7      |
| `close_range_hook` | 2           | 3      |

**11 of the 14 cue-bearing exchanges (79%) carry an allowance of `none`.** The
exact ratio is partly a fixture artifact — cues fire when state changes, which in
these scripts is the scene-setting first exchange, whose player lines are ordinary
— but the *collision itself is structural and will be the common case in
production*, because most player lines are ordinary and hair gets wet regardless
of how the player phrases their turn.

Two readings, and the trial cannot choose between them without the live arm:

- **Benign.** The allowance governs *volunteered* sensory embroidery; the cue
  block is a specific licensed detail that overrides it. Then the cue lands and
  everything is fine.
- **Harmful.** The two lines contradict each other near the point of generation,
  and the model either ignores the cue (the feature buys nothing) or obeys it and
  reads as having broken its own rule (naturalness drops).

This is worth an explicit ruling before the live run, because if the answer is
"harmful" the fix is a prompt-ordering or precedence change, not a physics change,
and the live numbers would otherwise be measuring the collision rather than the
cues. The cheapest defensible fix is to have the allowance line acknowledge an
offered physical cue as an exception when one is present.

## What did not run on 2026-07-28, and why (historical)

Kept as the record of the first attempt; the live half ran the next day on a
replaced key — see §Live results.

| step                                                           | status                             |
| -------------------------------------------------------------- | ---------------------------------- |
| Fixture matrix, reads, cue projection, prompts                 | complete, all self-checks pass     |
| 60 paired narrator generations                                 | **not run** — provider auth failed |
| 10 blinded judge calls                                         | **not run**                        |
| Contradiction / repetition / specificity / naturalness numbers | **absent**                         |

The key in `.env` (73 chars, `sk-or-v1-…`, file last written 2026-06-23) returns
`401 User not found` from OpenRouter's own key-introspection endpoint, which means
the key or its account no longer exists — not a rate limit, not a balance problem,
not a model-routing problem. No other credential was available in the worktree.

The one live probe that fired before the preflight existed did exercise the whole
pipeline — the concurrent generation loop, the judge call, the aggregation and the
audit-JSON write all executed end to end; only the model responses were missing.
It produced empty narration in both arms, which the runner then scored as a clean
sweep of zeroes. That was fixed: an empty reply now throws, and a run where every
judge call degrades exits non-zero. **An eval that silently scores blank
transcripts is more dangerous than one that crashes** — it produces a confident,
wrong recommendation. The judge's output contract (its JSON-Schema round trip, its
score bounds, and the assertion that the cue block never reaches its prompt) is
covered by the pure fixture guard, so what remains untested is the model call
itself.

## Re-running it

```bash
# free — proves the matrix still fires
pnpm eval:affordance-cues --dry-run

# the live trial: ~60 narrator calls + 10 judge calls, a few minutes
pnpm eval:affordance-cues
```

The runner refuses to spend if any self-check fails or the key is rejected. Read
the decision rule in `scripts/eval/affordance-cues/README.md` before interpreting
the output; the headline test is **contradictions per exchange, lower in the cue
arm, with repetition not higher**. The campaign reached its terminal verdict on
2026-07-29, so a further run is new design work rather than a continuation of
this trial.

## Rematch log

Per the [rematch spec](body-attribute-affordances.trial.rematch.md) §Iteration
protocol — one entry per live round, campaign cap $10.

### Round R1 — 2026-07-29 — $1.93 — verdict: invalid_induction

- **Changed since round 1**: everything the rematch spec ordered — the 12-
  scenario bait+anchor matrix (5 families, 22 armed baits, all anchored), the
  per-arm arm-blind audit judge with quote-or-discard verification, the
  induction gate, the frozen decision rule.
- **Induction**: control 0.16 contradictions/exchange (needs ≥0.40); 2/5
  families tripped the control (coverage 0.57, binding 0.14; provenance,
  degree, assertion 0.00). No feature verdict.
- **Why**: structural — provenance/degree/assertion tempt claims about state
  only the cue arm knows (wetness reaches the prompt only through the cue
  block), so the control cannot misattribute wetness it never mentions. The
  two families that bit tempt pure invention, which needs no state knowledge.
- **Observations parked for a valid round** (cue path frozen until then): the
  cue arm was convicted for weaving the cue's own wording ("damp strands"
  against a soaked committed band — the cue adjective may understate its
  band), and both arms rationalized baits by inventing state changes ("the
  ponytail had worked loose from its tie"). Cue arm ran 0.45 c/e overall —
  worth an autopsy against these judge behaviors once induction is valid.
- **Action**: matrix v2 — establish the true state to BOTH arms in-fiction
  (player-line establishment + shared scene facts) so the control makes
  convictable claims; use mid-scenario state flips as the production-faithful
  stale-knowledge differential; flat declarative baits. Runner, judge, gate,
  rule untouched.

### Round R2 — 2026-07-29 — $1.90 (campaign $3.83) — verdict: valid FAIL

- **Changed since R1**: matrix v2 only (truth established to both arms
  before the first armed bait; stale-flip differential; flat declarative
  baits). Runner, judge, gate, rule, cue path untouched.
- **Induction**: PASSED for the first time — control 0.50
  contradictions/exchange, 5/5 families with a control violation. The
  instrument can now measure.
- **Decision rule**: FAIL on the contradiction clause — cues 0.469 vs the
  0.300 ceiling (60% of control's 0.500); a ~6% relative reduction where 40%
  is required. Repetition (0.063 vs 0.031, within +0.05) and naturalness
  (4.78 vs 4.56 — the cue arm reads MORE natural) both cleared. Specificity
  again favored cues (4.44 vs 4.11).
- **Per-family, the diagnostic split**: where the cue speaks to the baited
  dimension, anchoring wins — assertion 0.00 vs 0.50 (the cue arm never
  adopted a false premise), binding 0.33 vs 0.50. Where the cue is silent on
  the baited dimension, it hurts — provenance 0.50 vs 0.25: bath-caused
  wetness renders as bare "damp, clinging strands" (only rain gets a cause
  clause), so the cue arm talks about wet hair more and misattributes it to
  the baited storm. Degree tied (0.14) with the cue arm again convicted for
  weaving the cue's own "damp" against a soaked committed band.
- **Recorded cue-side change (the one the protocol allows on this
  evidence)**: the wetness cue lines gain band-accurate degree wording
  (subtle/clear/strong → damp/wet/soaked-scale adjectives) and a committed
  provenance clause for EVERY cause the observation carries (bath/immersion,
  splash — mirroring the existing rain mechanism at the tag source), with
  unknown causes staying clause-free. Implemented in
  `src/server/engine/chat-affordance-cues.ts` + the hair phenomena tags;
  trial guards extended symmetrically.
- **Next**: round R3 on the same matrix, judge, gate, and rule. A pass flips
  the flag default ON; a second consecutive valid fail is final — the flag
  parks OFF.

### Round R3 — 2026-07-29 — $2.46 (campaign $6.29) — verdict: valid FAIL. **FINAL.**

- **Changed since R2**: the one recorded cue-side change only (cause-true
  provenance clauses + degree-accurate wetness adjectives). Matrix, judge,
  gate, rule all frozen.
- **Induction**: valid again — control 0.44 contradictions/exchange, 5/5
  families.
- **Decision rule**: FAIL on the contradiction clause — cues 0.563 vs the
  0.263 ceiling; the cue arm contradicted MORE than control this round.
  Repetition passed at its best-ever (cues 0.000 vs 0.031); naturalness
  passed (4.67 vs 4.89, within the floor); preference tied 4–4–1.
- **The change worked on its target and it wasn't enough**: provenance went
  from the worst cue-arm family (0.50 vs 0.25) to dead even (0.13 vs 0.13).
  But binding flipped against the cues (0.83 vs 0.50, from 0.33 vs 0.50 in
  R2), assertion regressed to a tie (from the 0.00 vs 0.50 R2 win), and
  coverage/degree stayed adverse. Dimensions no change touched swung by
  0.5 c/e between rounds — real sampling variance at this n, which is
  exactly why the stopping rule was pre-committed.
- **Final verdict per the frozen protocol (second consecutive valid fail)**:
  **`CHAT_AFFORDANCE_CUES` parks OFF.** Across both valid rounds the cue arm
  never reduced contradictions (R2 −6%, R3 +29%) — and that, alone, is what
  closes the flag. The cue arm made the narrator talk about the body more
  concretely (specificity rose in every round), which plausibly exposed more
  claims to the audit; that remains a **working hypothesis about this cue shape
  in this domain through this narrator model**, not a demonstrated law. The
  evidence does not support more: untouched dimensions varied by ~0.5 c/e
  between rounds, no round measured claims per exchange, and nothing here tests
  garment, contact, or pose guidance. Repetition reached zero in R3 and
  false-premise adoption was eliminated in R2, but neither result replicated;
  they remain useful signals rather than established benefits. The
  pre-registered trade still failed.
- **What survives the campaign**: the cause-true provenance + degree wording
  (a measured quality fix, kept in production); the bait+anchor matrix,
  audit judge, and induction gate (a reusable instrument for any future
  narrator A/B); and the measured result that on this matrix, this domain and
  this narrator model, a cue system shaped like this one bought specificity
  without buying contradiction-safety — a result about the tested
  configuration, not a general property of positive physical detail. A
  differently-shaped feature is NEW design work in
  [constraint-first narrator physical guidance](narrator-physical-guidance.plan.md),
  where constraints/action outcomes and change-gated details receive separate
  release decisions. This campaign and this flag are closed.

## Caveats on the method

- **Generation is not reproducible.** The narrator runs at the production
  temperature (0.85) and OpenRouter exposes no seed. Everything upstream of the
  model call is deterministic: same fixtures, same reads, same cue lines, same
  prompts, same A/B blinding. 30 paired exchanges is a directional sample — treat
  a gap of a few hundredths in a per-exchange rate as noise.
- **The affordance read is scripted, not extracted.** State advances on rails
  rather than from each arm's own narration. That is deliberate — it is what keeps
  the arms comparable — but it means the trial does not exercise the archivist's
  extraction loop, where an arm's own prose could move the state it is later
  judged against.
- **Half the hair domain is untestable here.** Adhesion needs a contact owner and
  shedding needs a committed impulse, so both are production-silent; the trial
  measures the reachable half, which is also all the flag can currently ship.
- **The judge is a single model.** Blinding and the silence controls guard against
  label bias, but not against a systematic blind spot shared across all its calls.
- **The 6 silence-control exchanges carry no feature signal** by construction, so
  the effective sample for the comparison is 24 paired exchanges, of which 14 are
  cue-bearing.
