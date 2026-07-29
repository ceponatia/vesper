# Slice 5 narrator trial — cue path vs. appearance path

Status: **complete — deterministic half 2026-07-28, live comparison
2026-07-29** (run on the replaced `OPENROUTER_API_KEY`; ~$0.72 of spend).
Companion to [body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
§"Slice 5 — narrator trial". Harness: `scripts/eval/affordance-cues/`.

## Recommendation

**Keep `CHAT_AFFORDANCE_CUES` OFF.** The live comparison ran on 2026-07-29 and
the pre-registered decision rule — *contradictions per exchange lower in the cue
arm, with repetition not higher* — was **not met**: contradictions tied exactly
(0.13 / exchange in both arms) and repetition rose slightly in the cue arm
(0.08 vs 0.00). The numbers are in §Live results.

What the cues bought was specificity (4.38 vs 4.00) — the cue arm talks about
hair more (1.00 vs 0.71 mentions / exchange) and in more concrete terms — at
identical naturalness (4.63 both). The blinded judge preferred the control
transcript 6–4, though the silence controls (byte-identical prompts) also leant
2–0 toward "control", which puts a visible label-noise floor under that margin.

The honest reading: in this matrix the narrator already avoids the
contradictions the cue path was built to prevent (a 0.13 / exchange base rate
leaves almost no headroom), so the cues added detail without fixing anything
measurable. That is not the trade the plan asked for ("reduces contradictions
and adds concrete variation without … repetitive"). If the feature earns a
rematch, the matrix — not the physics — is what should change: scenarios
engineered to induce contradiction (rapid coverage changes, provenance
switches, multi-garment layering) would give the cue arm headroom to show a
difference; a same-model self-consistency judge panel would tighten the 6–4
read. Until someone chooses to fund that, OFF is the supported state.

## Owner rulings (2026-07-28, same day)

Both open items above were ruled on the day the trial ran:

- **Live run deferred.** The owner chose not to replace the dead key
  mid-session; `CHAT_AFFORDANCE_CUES` stays OFF and the live half remains the
  one open step of slice 5. When a working `OPENROUTER_API_KEY` lands in
  `.env`, the run is `pnpm eval:affordance-cues` (see §Re-running it).
- **The sensory-allowance collision is resolved: cues win.** A current
  physical-effect cue counts as new information, not static appearance — the
  no-appearance instruction exists to stop re-describing unchanged looks and
  must not suppress the cue block. Implemented the same day (with the slice 6
  garment work): when the allowance is `none` and cue lines are present, the
  allowance line carves out the cue block by its shared heading constant
  (`chatSensoryAllowanceLine`, `AFFORDANCE_CUE_BLOCK_HEADING`); prompts are
  byte-identical whenever the flag is off or no cue fired. Selection/ranking
  in `contracts/affordances` never reads the allowance — this is
  prompt-projection policy only. A future live run therefore measures the
  cues, not the collision; §Design finding below is kept as the record of why
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

| id | character | hair | wet | covering | air | expectation |
| --- | --- | --- | --- | --- | --- | --- |
| `rain-arrival-loose` | Wren (dense/thick/wavy) | loose | soaked → damp, cause rain | none | outdoor breeze → indoors | clumping, rain provenance, then a band change |
| `hooded-downpour-braid` | Wren | braid | soaked, cause rain | opaque hood | gusting → indoors | bound-mass clumping; wind suppressed by binding |
| `clifftop-wind-dry` | Ilse (sparse/fine/straight) | loose | dry | none | breeze → gusting → indoors | whole-hair motion, rising a band, then silence |
| `bun-in-gale` | Wren | bun | soaked → damp, cause splash | none | gusting → indoors | clumping; wind suppressed by pinning |
| `bath-immersion-still` | Wren | loose | soaked → damp, cause immersion | none | indoors, still | clumping with **no** rain clause |
| `soaked-and-windy` | Wren | loose | soaked → damp, cause rain | none | outdoor strong wind | water weight must beat the wind |
| `sheer-scarf-splash` | Wren | loose | soaked → damp, cause splash | sheer scarf | indoors, still | clumping through partial coverage |
| `damp-ends-in-gust` | Ilse | loose | damp, cause rain | none | gusting → indoors | motion on damp (not saturated) hair |
| `silent-dry-still-loose` | Wren | loose | dry | none | indoors, still | **silence control** |
| `silent-dry-still-braid` | Ilse | braid | dry | none | outdoors, dead calm | **silence control** |

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

| measure (per exchange unless noted) | cues | control |
| --- | --- | --- |
| contradictions | **0.13** | **0.13** |
| repetitions | 0.08 | 0.00 |
| static restatements | 0.13 | 0.08 |
| specificity (1–5) | **4.38** | 4.00 |
| naturalness (1–5) | 4.63 | 4.63 |
| hair mentions | 1.00 | 0.71 |
| judge preference (scenarios) | 4 | **6** (0 ties) |

The silence controls — where both arms received byte-identical prompts, so any
preference is pure label/sampling noise — went 2–0 to "control", which is the
noise floor to hold under the 6–4 headline.

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

| allowance | cue offered | no cue |
| --- | --- | --- |
| `none` | **11** | 6 |
| `visual_accent` | 1 | 7 |
| `close_range_hook` | 2 | 3 |

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

| step | status |
| --- | --- |
| Fixture matrix, reads, cue projection, prompts | complete, all self-checks pass |
| 60 paired narrator generations | **not run** — provider auth failed |
| 10 blinded judge calls | **not run** |
| Contradiction / repetition / specificity / naturalness numbers | **absent** |

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
arm, with repetition not higher**. Fill in the numbers here and the recommendation
above becomes a real ruling.

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
