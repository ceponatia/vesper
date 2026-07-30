# Affordance-cue narrator trial

The owner-gated live comparison for **slice 5** of
`docs/developer-notes/body-attribute-affordances.plan.md`: does the
`CHAT_AFFORDANCE_CUES` narrator cue path **reduce contradictions of committed
physical state** without costing repetition or prose naturalness?

Round 1 (2026-07-29) ran and failed to decide anything: the control arm
contradicted at 0.13/exchange, so the cue arm had nothing to reduce. The
**rematch** rebuilds the instrument — a bait matrix, a split judge, and an
induction gate that refuses to render a verdict until the baits demonstrably
tempt. Round-1 record:
[`body-attribute-affordances.trial.md`](../../../docs/developer-notes/body-attribute-affordances.trial.md).
Rematch design (the authority for everything below):
[`body-attribute-affordances.trial.rematch.md`](../../../docs/developer-notes/body-attribute-affordances.trial.rematch.md).

## Run

```bash
pnpm eval:affordance-cues --dry-run          # matrix, cue lines, self-checks. NO model calls, free.
pnpm eval:affordance-cues                    # the full paired trial + judging (live, billable)
pnpm eval:affordance-cues --matrix v1        # the round-1 matrix, unchanged (regression baseline)
pnpm eval:affordance-cues --no-judge         # generate both arms, skip all judging
pnpm eval:affordance-cues --scenario rain    # substring match on scenario id
```

`--matrix rematch|v1` selects the scenario set and **defaults to `rematch`**.
`v1` is the round-1 matrix preserved verbatim; it still runs, and its fixture
guard still runs in `pnpm test`, so a calibration change that breaks the old
matrix is still visible. Every other flag works identically for both.

Other flags: `--out <dir>` (default `data/eval/affordance-cues`, or `EVAL_OUT`),
`--chat-model <slug>`, `--judge-model <slug>`, `--concurrency N` (default 3,
scenario-level).

`--dry-run` writes `matrix.json`; a live run writes **`trial.json`** (the full
audit: every prompt, reply and judge answer) **and `summary.json`** (the same
round with the narration removed — provenance, raw counts, verified violation
quotes, spend). `data/` is gitignored, so `trial.json` never leaves the machine:
after a real round, copy `summary.json` to
`results/<matrix>-<YYYY-MM-DD>.json` and commit it — that file is the audit
record. See [`results/README.md`](results/README.md) for the convention and
[`summary.ts`](summary.ts) for the schema (`trialSummarySchema`, `version: 1`,
guarded by `summary.test.ts` in `pnpm test`). Numbers still get quoted into the
trial doc; they are now checkable against a committed file rather than only a
transcription.

**Not wired into `pnpm verify`/CI, ever.** It spends money and it measures a
judgment call. The fixture guard (`harness.test.ts`) *is* pure and does run in
`pnpm test` — it proves the matrix still fires before anyone spends anything.

## Design

**Bait + anchor.** The cue path can only help where two things meet: a true
current effect exists (so a cue fires) *and* the scene strongly tempts a
specific, checkable, wrong embellishment. Round 1 had the first without the
second, which is why it measured nothing. Every rematch scenario therefore
belongs to a **bait family** — `provenance_bait`, `binding_bait`,
`coverage_bait`, `degree_bait`, `assertion_bait` — that names the wrong claim
its scenes tempt, and arms that bait per exchange (`baits`) only where the hair
domain genuinely speaks.

Two structural controls ride along: **silence controls** (dry, still — zero cues
and byte-identical prompts, the judge's label-noise floor) and one **invention
control** (rain-adjacent framing over committed dry-under-shelter state, where no
cue can fire, so both arms are identical by construction). Neither enters the
paired comparison; the invention control exists to show whether the bait tempts
the narrator at all.

Every scenario is still built from *committed typed state* (a story clock, a
`ChatEnvironment`, a `body_surface` wetness entry with its cause, real worn
garment rows), never from prose, because prose is exactly what the layer under
test refuses to treat as an input.

**Both arms get identical inputs except the cue block.** The read
(`buildChatAffordanceRead`), the projection (`renderChatAffordanceCues`), the
per-turn sensory allowance (`deriveChatSensoryAllowance`) and the prompt
(`buildCharacterChatSystemPrompt`) are all the production functions; the harness
only assembles the state slice the database-bound pipeline would have loaded, and
hands the same object to both arms. A self-check asserts the cue-arm prompt is
the control prompt with exactly one block (plus the "cues win" carve-out) spliced
in. Generation runs through `streamCharacterChat` — the real chat narrator, on the
chat lane's default model, at the production temperature — and each arm carries
its own history, so repetition is measured over what that arm actually said.

**Judging is split** (rematch §Judge redesign), because one comparative call
cannot report an absolute rate:

1. **Per-arm contradiction audit** — 2 calls per scenario, temperature 0,
   **arm-blind**: the judge sees ONE transcript, presented as "the narrator's
   replies", with no cue block, no arm label and no second transcript to anchor
   against. Per exchange it gets the committed-state table plus, where a bait is
   armed, that bait's `tempts` phrase as a named specific check, and returns a
   five-dimension checklist — `wetness_degree`, `provenance`,
   `motion_vs_binding`, `coverage`, `adopted_false_premise` — each
   `violated | clean | not_applicable`, **with a verbatim quote for every
   `violated`**. The runner verifies each quote against the transcript
   (case-insensitive, whitespace-normalized) and **discards violations whose
   quote it cannot find**, counting the discards in the report. Contradictions
   per exchange = surviving violations. Repetition, static restatement,
   specificity and naturalness ride in the same per-arm call, so they are no
   longer comparative anchors.
2. **Pairwise preference** — 1 call per scenario, A/B blinded by the same
   deterministic per-scenario hash round 1 used. **Advisory only**: it no longer
   gates anything: it exists to catch a cue arm that wins the audit while reading
   worse.

An audit that degrades — a failed model call, or an answer that skips or invents
an exchange after one corrective retry — **fails the run** (non-zero exit, no
verdict). The round-1 rule stands: an eval that silently scores blank output is
worse than one that crashes.

Exit codes: `0` a completed run (including `verdict: "fail"` and
`verdict: "invalid_induction"` — both are real measurements), `2` a failed
self-check or a degraded audit (`verdict: null`, the numbers are not a result),
`1` a bad flag, a missing/rejected key, or an empty narration.

## What it reports

`trial.json` carries `matrix`, the machine-readable `verdict`, the induction
numbers, the per-family paired table, the full per-exchange audit detail
(dimension verdicts, kept quotes, discarded quotes and why), preference tallies
for bait and silence scenarios separately, the self-checks, the diagnostics, and
approximate token counts for generation and judging. The console prints the same
in summary: the cues-vs-control block over **bait scenarios only**, the
per-family table (control contradictions/exchange, cue contradictions/exchange,
armed-bait hit rate), the discarded-quote counts, the induction gate, and a
clearly-labelled `verdict:` line.

`summary.json` carries the committable subset: `version`, matrix, verdict,
fixture commit (+ dirty flag), model ids and temperatures, config/per-arm prompt
digests, per-arm raw dimension counts (`violated` = the judge's raw verdicts,
split into `verifiedViolations` + `discardedViolations`), exchanges with any
violation, the quote-verified violations with their arm/scenario/exchange refs,
optional `physicalClaims` (nothing computes them yet), and spend (call counts,
approximate tokens, OpenRouter key-usage delta). It carries **no narration** —
prompts, replies and judge rationales stay in `trial.json`. A degraded arm
contributes nothing rather than a clean zero, matching the run's refusal to
publish a verdict.

## Induction gate (checked before any verdict)

A round only measures anything if the baits demonstrably tempt:

- control-arm contradictions ≥ **0.40/exchange** over the bait scenarios, and
- ≥3 of the 5 bait families show ≥1 control-arm violation.

If either fails the run reports `verdict: "invalid_induction"`, prints which
families failed to bait, and renders **no feature verdict**. The follow-up then
iterates the **matrix** (stronger bait, more leading player lines, longer
scenarios) — never the cue path and never the decision rule.

## Decision rule (frozen for the campaign)

On a **valid** round, the cue path passes iff all three hold, over bait scenarios:

1. cue-arm contradictions ≤ **60%** of control's (≥40% relative reduction);
2. cue-arm repetitions exceed control's by ≤ **0.05**/exchange;
3. cue-arm naturalness ≥ control's − **0.25**.

Preference, specificity and the mechanical hair proxies are reported, not gated.
Changing any of these numbers requires an owner ruling — they are frozen so the
campaign cannot be talked into a pass.

**On a pass** (2026-07-29 owner ruling): flip `chatAffordanceCuesEnabled()` to
default **ON** (`CHAT_AFFORDANCE_CUES=off` becomes the override direction),
record the ruling in the trial doc and the plan, and ship on the next deploy.
**On a fail of a valid round**: if the narrator ignored an offered cue (cue
present, same-dimension violation anyway), one recorded cue-side change is
justified and the campaign continues; if cues were woven and the reduction still
missed, a **second consecutive valid fail is final** — the flag parks OFF.
Campaign spend is capped at **$10 cumulative** (round 1's $0.72 excluded); at the
cap without a conclusion, record the state and ask.

## Caveats

- The narrator runs at the production temperature (0.85) and OpenRouter exposes
  no seed, so generation is **not** reproducible. Everything upstream of the
  model call is deterministic: same fixtures, same reads, same cue lines, same
  prompts, same A/B blinding.
- A round is a *directional* sample. Treat a gap of a few hundredths in a
  per-exchange rate as noise — which is why the decision rule asks for a 40%
  relative reduction rather than "lower".
- The audit is one model. Blinding, per-exchange ground truth and the quote
  verification guard against label bias and invention, but not against a
  systematic blind spot shared across its calls.
- Only `hair.wet_clumping` and `hair.wind_or_motion_response` can reach
  production in this lane; adhesion needs a contact owner and shedding needs a
  committed impulse. The trial therefore measures the reachable half of the hair
  domain, which is also all the flag can currently ship.
