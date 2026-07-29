# Slice 5 narrator trial — rematch spec

Status: active (authored 2026-07-29 after the first live round; owner rulings
same day: full levers — matrix + judge + cue-side, every change recorded; spend
cap **$10 total** for the campaign; **a valid pass flips
`CHAT_AFFORDANCE_CUES` default ON**). Companion to
[body-attribute-affordances.trial.md](body-attribute-affordances.trial.md)
(round 1 record) and
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
§Slice 5. Harness: `scripts/eval/affordance-cues/`.

## Why round 1 could not have succeeded

Round 1's control arm contradicted at 0.13/exchange — near zero — so the cue
arm had nothing to reduce. Post-hoc, the reason is structural: the narrator
only *contradicts committed state* when it is tempted into a **checkable
physical claim that is wrong**, and round 1's scenarios never tempted it. The
scripts set a state, the player lines were ordinary, and a narrator that
stays vague or follows its own history is automatically consistent.

The cue arm's mechanism of benefit is **anchoring**: on a cue-bearing
exchange, the true current effect is in the prompt, so the narrator weaves
the given detail instead of inventing an attractive wrong one. It follows
that headroom exists only on exchanges where BOTH hold:

1. a true current effect exists (a cue fires), and
2. the scene strongly tempts a *specific, judgeable, wrong* embellishment.

Round 1 had (1) without (2). A dry romantic scene has (2) without (1) — and
produces byte-identical prompts, so it can never differentiate the arms.
The rematch matrix engineers (1) ∧ (2): **bait + anchor**.

## Scenario families (the bait taxonomy)

Every rematch scenario belongs to exactly one family and declares, per
exchange, which bait is armed. Families, with the wrong claim each tempts and
the true anchor the cue supplies:

| family | bait (the tempting wrong claim) | anchor (what the cue truthfully says) | judge check |
| --- | --- | --- | --- |
| `provenance_bait` | wetness attributed to the salient weather ("still wet from the rain") when the committed cause is a bath, a burst tap, a dunk | degree + true provenance ("damp from the bath water") | provenance wording vs committed cause |
| `binding_bait` | bound/pinned hair "streaming", "cascading", "whipping" in wind | what binding actually permits ("the pinned coil holds; loose wisps at the temples stir") | motion claim vs binding + wind |
| `coverage_bait` | a hooded/covered head described as a visible wet cascade | what coverage lets through ("clumped strands showing at the hood's edge") | visibility claim vs coverage |
| `degree_bait` | mild dampness inflated to "soaked", "dripping", "drenched" | the calibrated band ("damp at the ends only") | intensity claim vs committed wetness band |
| `assertion_bait` | a scripted player line asserting a false state ("you're drenched!", "with your hair loose like that—") which the narrator is tempted to adopt | the true state, which contradicts the player's framing | adopted-false-premise vs committed state |

Two structural controls ride along, exactly as in round 1:

- **silence controls** (≥2 scenarios, dry + still): correct behavior is zero
  cues and byte-identical prompts; any judge preference there is the
  label-noise floor.
- **invention control** (1 scenario, optional per round): rain-adjacent
  romantic framing, committed state dry under shelter, no cue fires — both
  arms identical. Measures raw bait efficacy on the narrator (does the bait
  actually tempt?), not the feature. Its contradictions count toward the
  induction gate's evidence that baits work, never toward the paired
  comparison.

Matrix size per round: **10–12 scenarios × 3–4 exchanges** (state may flip
mid-scenario; a bait may arm on any exchange, not only the first). Target ≥16
cue-bearing exchanges per round. Player lines are allowed — encouraged — to
be leading, flirtatious, or presumptuous; that is what production players are.

## Scenario contract (shared between fixtures and runner)

Each scenario extends the existing fixture shape with:

```ts
family: "provenance_bait" | "binding_bait" | "coverage_bait"
      | "degree_bait" | "assertion_bait" | "silence" | "invention_control";
/** Per exchange: which bait is armed and what wrong claim it tempts. */
baits: ReadonlyArray<{ exchange: number; tempts: string } | null>;
```

`tempts` is a short human phrase ("attributes bath wetness to rain") consumed
by the judge prompt as the *specific* check for that exchange, and by the
report. Self-checks (extend `harness.test.ts`):

- every bait family fires ≥1 cue somewhere in the matrix;
- every `silence` scenario emits 0 cues with byte-identical prompts;
- the `invention_control` emits 0 cues;
- cue cap and no-duplication checks from round 1 still hold across the new
  matrix;
- `--matrix v1` still selects the round-1 scenarios unchanged (they are the
  regression baseline and stay green).

## Judge redesign

Round 1 used one pairwise call per scenario. The rematch separates
measurement from preference:

1. **Per-arm contradiction audit** (2 calls/scenario, arm-blind): the judge
   sees ONE transcript plus the committed-state table per exchange plus each
   armed bait's `tempts` phrase, and returns per exchange a checklist verdict:
   `{wetness_degree, provenance, motion_vs_binding, coverage, adopted_false_premise}`
   each `violated | clean | not_applicable`, **with a verbatim quote for every
   `violated`**. Contradictions/exchange = violated count. Audits run at
   temperature 0. A `violated` without a quote is discarded by the runner
   (schema-enforced).
2. **Pairwise preference** (1 call/scenario, A/B blinded by the round-1
   deterministic hash): unchanged from round 1, but **advisory** — it no
   longer gates the decision; it exists to catch a cue arm that wins the
   audit while reading worse.
3. Repetition, static restatement, specificity, naturalness stay in the
   audit call (per-arm, so they are no longer comparative anchors).

Cost shape: ~30 judge calls/round vs 10 — still ≈$1.5/round all-in.

## Induction gate (validity precondition — checked before any verdict)

A round is a **valid measurement** only if the baits demonstrably tempt:

- control-arm contradictions ≥ **0.40/exchange** aggregated over bait
  scenarios, and
- ≥3 of the 5 bait families show ≥1 control-arm violation.

An invalid round renders **no feature verdict** — its follow-up iterates the
MATRIX (stronger bait, more leading player lines, longer scenarios), never
the cue path, and never the decision rule. This is the guard that keeps
iteration honest: we tune the *instrument* until it can detect, then let it
decide.

## Decision rule (frozen for the campaign; changes require an owner ruling)

On a **valid** round, the cue path passes iff all three hold:

1. cue-arm contradictions ≤ **60%** of control's (≥40% relative reduction)
   over bait scenarios;
2. cue-arm repetitions exceed control's by ≤ **0.05/exchange**;
3. cue-arm naturalness within **0.25** of control's.

Preference and specificity are reported, not gated. On a pass: flip
`chatAffordanceCuesEnabled()` to default ON (env `CHAT_AFFORDANCE_CUES=off`
becomes the override direction), record the ruling in the trial doc and plan,
and ship on the next deploy — per the 2026-07-29 owner ruling. On a fail of a
valid round: examine cue-bearing violated exchanges — if the narrator
**ignored** an offered cue (cue present, same-dimension violation anyway),
one recorded cue-side change (wording, block placement, framing) is
justified and the campaign continues; if cues were woven and the reduction
still missed, a **second consecutive valid fail is the final verdict** — the
flag parks OFF and the campaign ends regardless of remaining budget.

## Iteration protocol

- Round 0 (free): `--dry-run` over the rematch matrix; all self-checks green
  before any spend.
- Each live round: full paired run (`--matrix rematch`), then in order:
  induction gate → decision rule → next action per the rules above.
- Every round appends to the trial doc's **§Rematch log**: date, cost, what
  changed since the last round (matrix / judge / cue-side, itemized),
  induction-gate numbers, decision-rule numbers, action taken.
- Hard stop at **$10 cumulative** campaign spend (round-1's $0.72 excluded);
  if the cap is reached without a conclusion, record the state and ask.

## Implementation notes

- `run.ts` gains `--matrix rematch|v1` (default `rematch`), the induction
  gate, the per-family paired table, and a machine-readable
  `verdict: "pass" | "fail" | "invalid_induction"` in `trial.json`.
- The v1 scenario set is preserved untouched under `--matrix v1`; its
  fixture guard keeps running in `pnpm test`.
- Audit schema is enforced the same way round 1's judge contract was (JSON
  round-trip + bounds in the pure fixture guard); an audit call that degrades
  still fails the run loudly — the round-1 rule stands: **an eval that
  silently scores blank output is worse than one that crashes**.
- Nothing here is wired into `pnpm verify`/CI; the runner still preflights
  the key and refuses to spend on any failed self-check.
