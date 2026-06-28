# Narration eval harness

Behavioral eval for the narrator prompt work (`docs/developer-notes/narrator-prompt-focus.plan.md`
§Behavioral eval harness). It assembles **real** prompts through the shipped builders
(`buildStaticRulebook` / `buildTurnContext` / `buildResponseShape` / `buildReactionLine`, and
`buildCharacterChatSystemPrompt` for the chat lane), streams them through OpenRouter, computes
deterministic metrics, and scores each with an LLM judge.

**This is a dev tool with LIVE OpenRouter spend. It is never wired into `pnpm verify` / CI.**
It automates the interim manual eval + reasoning probes P1–P3.

## Run

```bash
pnpm eval:narration                       # aion narrator, both shape profiles, judge on
pnpm eval:narration --dry-run             # assemble + print every prompt; NO model calls, NO spend
pnpm eval:narration --models aion,glm,owl --reasoning default,off,low
pnpm eval:narration --scenarios hi,compliment --profiles concise --no-judge
pnpm eval:narration --no-focus            # strip the §Phase-3 planner — a Phase-2-vs-Phase-3 A/B
```

Needs `OPENROUTER_API_KEY` (from `.env`) for a live run. `--dry-run` needs no key and is the way to
inspect exactly what gets sent (and to see the Phase-1/2/3 surfaces — shape profile, `## Response
shape`, `## Reaction`).

### Axes (all comma-separated; defaults in parens)

- `--models` (`aion`) — `aion` · `glm` · `owl` · `deepseek` · `gemini`, or any OpenRouter id.
- `--profiles` (`concise,aggressive`) — the two `NARRATION_SHAPE_PROFILES`.
- `--reasoning` (`default`) — `default` · `off` (`reasoning.enabled:false`) · `low` (`effort:low`). This is probes P1–P3.
- `--scenarios` (all) — substring match on scenario id (`hi`, `compliment`, `question`, `multi-party`, `intimate`, `chat`).
- `--no-focus` — drop the Phase-3 `focus` planner from every prompt (`buildResponseShape` falls back to its deterministic Phase-2 derivation).
- `--no-judge` — deterministic metrics only (cheaper).
- `--dry-run` — print prompts, make no calls.

Env: `EVAL_JUDGE_MODEL` (default `z-ai/glm-5.2` — set to your strongest available judge), `EVAL_OUT` (default `data/eval/narration`).

## What it measures

- **Deterministic** (no judge — cheap, stable): paragraph count, segment count + **distinct NPC
  speakers** (`segmenter.parseSegments` — catches length regressions and multi-party over-talking),
  output tokens, TTFT, total latency, routed provider.
- **LLM judge** (1–5 each): `answeredFirst`, `proportionate` (cross-checked against the scenario's
  authored `## Reaction`), `onBeat`, `noUnrequestedLogistics`, `voice`.

Results print as a table and write to `data/eval/narration/results.json`.

## Pairwise / ranking comparison (sharper judge)

The absolute 1–5 judge **compresses** (run 1 clustered at 4.4–5.0 — see
`docs/developer-notes/narrator-prompt-focus.eval-results.md`). A *relative* judge that ranks
candidates which differ on ONE axis discriminates far better. `compare.ts` does that over an
**existing `results.json`** — it **re-judges the saved narrations, no regeneration**:

```bash
pnpm eval:narration:compare                       # axes profile,reasoning over results.json
pnpm eval:narration:compare --axis profile        # just the profile decision
pnpm eval:narration:compare --axis focus --vs data/eval/narration/results-nofocus.json
pnpm eval:narration:compare --limit 2 --dry-run   # inspect the comparison groups, no judge calls
```

- **Controlled groups:** `--axis profile` groups by (scenario × model × reasoning) and ranks
  `concise` vs `aggressive` within each group; `--axis reasoning` holds (scenario × model × profile)
  and ranks the reasoning variants. Candidate order is shuffled (FNV-1a on the group key) so the same
  value isn't always "A" — position-bias mitigation.
- **`--axis focus`** pairs a focus-on `results.json` against a focus-off one (`--vs`, from a
  `pnpm eval:narration --no-focus` run) by (scenario × model × profile × reasoning) — the Phase-3 A/B.
- **Output:** per-axis **win-rate** (how often a value ranked #1), **Borda%** (full-ordering points),
  and **per-dimension wins**, overall + per-model. Group verdicts write to `comparison.json`.
- **Judge model:** set `EVAL_JUDGE_MODEL` to a **strong** model so it out-classes the cast it scores
  — e.g. `EVAL_JUDGE_MODEL=google/gemini-3.1-pro-preview` (there is no `gemini-3.5-pro` slug). A strong
  judge is usually a reasoning model, so the rank judge uses a 1500-token budget to avoid
  reasoning-tokens-eat-the-output empties.

## Scope guard

The harness **measures** — a low score is a signal to iterate the prompt wording, never a build
failure. The golden scenarios live in `fixtures.ts`; the surrounding "scenery" blocks (scene
snapshot, presence roster, wardrobe) are hand-authored fixture strings, while the Phase-1/2/3
surface under test is produced by the real builders.
