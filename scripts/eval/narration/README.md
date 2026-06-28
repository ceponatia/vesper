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

## Scope guard

The harness **measures** — a low score is a signal to iterate the prompt wording, never a build
failure. The golden scenarios live in `fixtures.ts`; the surrounding "scenery" blocks (scene
snapshot, presence roster, wardrobe) are hand-authored fixture strings, while the Phase-1/2/3
surface under test is produced by the real builders.
