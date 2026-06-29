# Narration eval — results (run 1)

Record of the live runs of the behavioral eval harness
([narrator-prompt-focus.plan.md](narrator-prompt-focus.plan.md) §Behavioral eval harness;
`pnpm eval:narration`, `scripts/eval/narration/`). Captured **2026-06-28**. This is the
data the plan's "remaining is execution" step was gated on — *picking the default shape
profile* and *deciding each model's reasoning knob*. **No decisions are recorded as made
here** — this is the evidence; the rulings will land in the plan when chosen.

- **Run 1** — the full 108-cell matrix scored by the **absolute 1–5 judge** (GLM 5.2). It
  *compressed* to 4.4–5.0, so its small deltas are noise. Detailed below from §What was run.
- **Run 2** — a **pairwise / ranking re-judge** of run 1's *saved* narrations (no
  regeneration) by a stronger judge (`google/gemini-3.1-pro-preview`), via
  `pnpm eval:narration:compare`. Relative ranking breaks the compression — this is **the
  sharper read, and it supersedes run 1's close calls.** It is summarized first, immediately
  below; run 1's tables remain underneath as the underlying per-cell data.

---

## Run 2 — pairwise re-judge (the sharper read, 2026-06-28)

The "sharper judging" methodology follow-up, now done. A relative judge ranks 2–3 candidates
that differ on **one axis** (everything else held fixed), forcing a full ordering + a
per-dimension winner; candidate order is shuffled to kill position bias. **83 controlled
comparison groups** (47 profile + 36 reasoning), **0 degraded**. Metrics: **win-rate** (how
often a value ranked #1 in its group), **Borda%** (full-ordering points), **per-dimension wins**.

### Profile — the run-1 near-tie was hiding a strong per-model split

| value | groups | win-rate | Borda% | answeredFirst | proportionate | onBeat | noLogistics | voice |
|---|---|---|---|---|---|---|---|---|
| aggressive_concise | 47 | 51% | 51% | 8 | **12** | 8 | 2 | 18 |
| concise_immersive | 47 | 49% | 49% | 6 | 4 | 5 | 2 | **25** |

Per-model win-rate (this is the real signal):

| model | concise_immersive | aggressive_concise |
|---|---|---|
| **aion** (session default) | **83%** (10/12) | 17% (2/12) |
| **glm** (chat default) | 29% (5/17) | **71%** (12/17) |
| **owl** | 44% (8/18) | **56%** (10/18) |

- The 51/49 overall split is **not "no signal"** — it's two strong opposing per-model
  preferences cancelling. **Aion strongly prefers `concise_immersive`; GLM strongly prefers
  `aggressive_concise`; Owl leans aggressive.**
- Dimensionally: `concise_immersive` wins **voice** (richer prose), `aggressive_concise` wins
  **proportionate** (tighter ⇒ less doting) and on-beat/answered-first.
- **Tension for the global knob:** the shape profile is a single **global** dev knob across
  **both** lanes (plan decision 1). But Aion is the **session** narrator and GLM is the
  **chat** default, and they now disagree. One global default is therefore suboptimal for one
  lane — worth deciding whether to (a) keep global `concise_immersive` (suits the session
  default + best voice), (b) global `aggressive_concise` (suits chat/GLM + proportionality),
  or (c) revisit the "global-only" decision and make the profile **per-lane / per-model**.

### Reasoning — `low` is the clear overall winner; per-model rulings sharpen

| value | groups | win-rate | Borda% | answeredFirst | proportionate | onBeat | noLogistics | voice |
|---|---|---|---|---|---|---|---|---|
| low (`effort:low`) | 36 | **53%** | **56%** | 3 | 3 | 5 | 3 | **18** |
| off (`enabled:false`) | 24 | 29% | 53% | 1 | **4** | 0 | 0 | 7 |
| default | 35 | 29% | 41% | **5** | 2 | 5 | 2 | 11 |

Per-model (Borda%; `off` is impossible for Aion — rejected):

| model | default | off | low |
|---|---|---|---|
| **aion** | 33% (4/12) | — | **67%** (8/12) |
| **glm** | 55% (4/11) | 35% (1/12) | **61%** (7/12) |
| **owl** | 33% (2/12) | **71%** (6/12) | 46% (4/12) |

- **Aion → `effort:low`** (67% vs 33% default). Run 1 only had an anecdote (low fixed the one
  doting miss); the sharper judge makes it a **positive signal**. `off` stays impossible.
- **GLM → `low`** (edges default; `off` is worst).
- **Owl → `off`** — this **flips run 1** (whose compressed absolute had owl-default best). The
  relative judge says reasoning *hurts* Owl, and `off` ranks best (71%).

### How Run 2 updates the rulings — **RULED & WIRED 2026-06-29**

All four were ruled and landed in code (see narrator-prompt-focus.plan.md §Decisions locked 1 +
§Reasoning strategy; `NARRATION_LANE_DEFAULTS` in `prompts/constants.ts`, `NARRATOR_REASONING` in
`server/ai/provider.ts`):

1. **Default profile** → resolved the global-vs-per-lane tension by going **per-lane**: session
   `concise_immersive` (favors Aion + voice), chat `aggressive_concise` (favors GLM + proportionality).
   The dev override stays global (force-overrides both lanes).
2. **Aion reasoning** → **`effort:low`** (now positively supported, not just a doting patch).
3. **GLM reasoning** → **`low`** (default a close second; `off` worst). `off` noted in code as the
   latency-optimized swap for chat if TTFT outranks the marginal quality.
4. **Owl reasoning** → **`enabled:false`** (reasoning degrades it — a reversal from run 1).

### Run 2 caveats

- **Single judge, single pass per group.** No self-consistency vote yet — a follow-up could
  run each group through the judge N times (or a second strong judge) and keep majority
  orderings. Position bias is mitigated (shuffled labels) but not eliminated.
- **Focus (Phase 3) still not isolated** — `--axis focus` is built and ready but needs a
  `pnpm eval:narration --no-focus` generation run to diff against (separate spend).
- Group verdicts (with the judge's per-group rationale) are in
  `data/eval/narration/comparison.json`.

---

## What was run

```
pnpm eval:narration --models aion,glm,owl --reasoning default,off,low
```

- **108 cells** = 6 golden scenarios × 3 models (Aion 2.0 `aion-labs/aion-2.0`,
  GLM 5.2 `z-ai/glm-5.2`, Owl Alpha `openrouter/owl-alpha`) × 2 shape profiles
  (`concise_immersive`, `aggressive_concise`) × 3 reasoning settings
  (`default`, `off` = `reasoning.enabled:false`, `low` = `effort:low`).
- **Phase-3 focus on** for every cell (no `--no-focus` A/B this run — see Follow-ups).
- Judge model = **GLM 5.2** (the harness default). Deterministic metrics from
  `segmenter.parseSegments`.
- **95 live / 13 dead.** Raw rows: `data/eval/narration/results.json`.

## Two caveats that shape how to read this

1. **Judge compression.** Almost every live cell scored **4.4–5.0** on the 1–5 rubric.
   The GLM judge is lenient and barely discriminates, so **judge deltas under ~0.3 are
   noise**. Trust the **deterministic metrics** (verbosity, distinct speakers, latency)
   and the **judge notes on the worst cells** over the small average gaps.
2. **Dead cells confirm probe P1.** All **12 Aion `off` cells** failed instantly —
   *"Reasoning is mandatory for this endpoint and cannot be disabled."* (the
   2026-06-21 note in `provider.ts` still holds). Plus **1 GLM timeout**
   (`chat-compliment glm concise/default`, ~76s → empty). A few *live* cells also had
   70s+ latency tails from provider hiccups (Owl/GLM). Dead cells are excluded from all
   averages below.

## Decision 1 — default shape profile

Judge avg by model × profile (reasoning=default, live cells):

| model | concise_immersive | aggressive_concise | Δ (con − agg) |
|---|---|---|---|
| aion | 4.70 | 4.93 | −0.23 |
| glm | 4.76 | 4.80 | −0.04 |
| owl | 4.87 | 4.87 | 0.00 |
| **ALL** | **4.78** | **4.87** | **−0.09** |

Verbosity by profile (reasoning=default, live):

| profile | avg paragraphs | avg output tokens | avg distinct speakers |
|---|---|---|---|
| concise_immersive | 3.53 | 256.4 | 0.71 |
| aggressive_concise | 2.83 | 227.9 | 0.78 |

`proportionate` dimension only (the anti-doting target), by model × profile:

| model | concise | aggressive |
|---|---|---|
| aion | 4.83 | 5.00 |
| glm | 4.80 | 5.00 |
| owl | 5.00 | 5.00 |

**Read:** the judge marginally favors `aggressive_concise` (4.87 vs 4.78), but it is
**entirely an Aion effect** (−0.23); GLM and Owl are tied within noise. The real,
trustworthy difference is **verbosity**: `concise_immersive` produces the *richer* prose
(3.5 par / 256 tok vs 2.8 par / 228 tok) — exactly as designed, and the intended
"immersive register." **Both profiles clear the old 3–5 floor; no cell hit a cap.**
aggressive has a tiny anti-doting edge (5.00 proportionate everywhere). There is **no
empirical mandate to switch the default away from `concise_immersive`**; `aggressive_concise`
remains the right tighter-feel backup.

## Decision 2 — per-model reasoning knob

Judge avg by model × reasoning (live cells, profiles pooled; `n` = live cells def/off/low):

| model | default | off | low | n (def/off/low) |
|---|---|---|---|---|
| **aion** | 4.82 | *rejected* | 4.85 | 12 / 0 / 12 |
| **glm** | 4.78 | 4.78 | 4.92 | 11 / 12 / 12 |
| **owl** | 4.87 | 4.83 | 4.75 | 12 / 12 / 12 |

- **Aion (session default) — probe P1:** `enabled:false` is **rejected** → only `default`
  or `low` are possible. Overall default ≈ low (4.82 vs 4.85). **But** on the hard "hi"
  beat, `default` invented an errand (3.40) while `low` was clean (4.80) — `effort:low`
  happened to suppress the residual doting there at no overall quality cost. `low` is
  **not** faster, though. **Never ship `enabled:false` for Aion.**
- **GLM (chat default) — probe P2:** honors all three. default = off (4.78), low edges
  ahead (4.92). `off` is a **clear latency win** (sub-500ms TTFT on many cells) at zero
  quality cost; `low` is a marginal quality nudge.
- **Owl — probe P3:** accepts the params (no rejection) but **reasoning hurts** it
  (default 4.87 > off 4.83 > low 4.75). Leave Owl at `default`; do **not** add a knob.

## Quality texture (deterministic + dimension reads)

Per-dimension judge avg (reasoning=default, profiles pooled, live):

| model | answeredFirst | proportionate | onBeat | noUnreqLogistics | voice |
|---|---|---|---|---|---|
| aion | 4.92 | 4.92 | 4.83 | 4.75 | 4.67 |
| glm | 4.82 | 4.91 | 4.73 | 4.91 | 4.55 |
| owl | 4.92 | 5.00 | 5.00 | 5.00 | 4.42 |

Latency + length by model (reasoning=default, live):

| model | TTFT | total | avg output tokens |
|---|---|---|---|
| aion | 4978ms | 6198ms | 417.9 |
| glm | 2193ms | 4544ms | 214.7 |
| owl | 3001ms | 6224ms | 90.3 |

- **`voice` is the weakest dimension everywhere** (aion 4.67 / glm 4.55 / owl 4.42).
- **Length spread is large:** Owl is extremely terse (**90 tok** — safe but thin), Aion
  richest (**418 tok**), GLM middle (215). Owl's top judge scores ride on its brevity
  dodging failure modes, not on strong prose.
- **Multi-party restraint holds** — distinct speakers on the multi-party scenario:
  aion 0.75, glm 1.00, owl 0.83. **No chorus** anywhere (the rule-7 / rule-6 division of
  labor is working).
- **The "hi" greeting is the consistent stress point** — 5 of the 8 lowest live cells are
  "hi". This is the anti-doting target scenario, and the one genuine miss was Aion-default.

### Worst cell vs contrast (the residual failure mode)

`hi-quiet-room aion concise/default` — **3.40**, proportionate=4:

> Maya looks up from the counter, a damp cloth still in her hand. The kettle's ticking
> has almost faded.
>
> "Hey." She tosses the cloth into the sink and leans back against the counter, arms
> crossed loosely. "You must be the one checking in today. Hope the drive wasn't too bad
> — the road through town's been torn up all spring."

*Judge note: greets first and stays measured, but assumes a 'checking in' errand and
volunteers road logistics the player never asked about.*

Same model, `concise/low` — **4.80**, proportionate=5:

> Maya looks up from the counter, cloth paused mid-stroke. The evening light catches the
> dust motes drifting slow between you.
>
> [Maya] "Hey."
>
> She wrings the cloth out once, then drops it beside the sink and leans back against the
> counter, crossing her arms. Not quite a study, not quite a dismissal — just someone
> who's been alone in a kitchen long enough to be curious about who just walked in.
>
> [Maya] "Kitchen's closed, technically. But I was about to put the kettle back on. You
> want tea?"

*Judge note: clean, proportionate greeting with one natural self-motivated beat (tea);
prose is vivid though slightly ornate for a one-word input.*

The errand-invention / unrequested-logistics failure the whole plan targets **still
surfaces on Aion-default** but is rare and was suppressed by `effort:low` here.

## Open decisions — **all RULED & WIRED 2026-06-29** (see §"How Run 2 updates the rulings")

These were the run-1 framing (absolute judge); Run 2 sharpened them and they are now ruled in
the plan + code. Kept for the audit trail:

1. **Default profile** → ~~keep `concise_immersive` vs switch to `aggressive_concise`~~ → **per-lane**
   (session `concise_immersive`, chat `aggressive_concise`) — Run 2's per-model split made a single
   global default wrong for one lane.
2. **Aion reasoning** → ~~leave `default` vs add `effort:low`~~ → **`effort:low`**.
3. **GLM reasoning** → ~~`default` vs `off` vs `low`~~ → **`low`** (`off` noted as the latency swap).
4. **Owl reasoning** → ~~leave `default`~~ → **`enabled:false`** (Run 2: `off` best).

## Methodology follow-ups (before locking rulings)

- **Sharper judging — DONE (Run 2 above).** The pairwise/ranking judge
  (`pnpm eval:narration:compare`, `google/gemini-3.1-pro-preview`) broke the compression and
  surfaced the per-model profile split + the sharpened reasoning rulings. Remaining nicety: a
  **self-consistency vote** (N passes or a second strong judge per group).
- **Isolate Phase 3.** Both runs held focus **on**, so the Phase-3 planner's contribution is
  unmeasured. The `--axis focus` comparison is **built and ready**; it needs a
  `pnpm eval:narration --no-focus` generation run to diff against (`compare --axis focus --vs`)
  to confirm the planner earns its keep before relying on it.
- **Provider-tail noise.** A few 70s+ cells (Owl/GLM) were provider hiccups, not model
  behavior — re-run flaky cells if their numbers matter to a decision.
