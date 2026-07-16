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
pnpm eval:narration --models aion,glm --reasoning default,off,low
pnpm eval:narration --scenarios hi,compliment --profiles concise --no-judge
pnpm eval:narration --no-focus            # strip the §Phase-3 planner — a Phase-2-vs-Phase-3 A/B
```

Needs `OPENROUTER_API_KEY` (from `.env`) for a live run. `--dry-run` needs no key and is the way to
inspect exactly what gets sent (and to see the Phase-1/2/3 surfaces — shape profile, `## Response
shape`, `## Reaction`).

### Axes (all comma-separated; defaults in parens)

- `--models` (`aion`) — `aion` · `glm` · `deepseek` · `gemini`, or any OpenRouter id.
- `--profiles` (`concise,aggressive`) — the two `NARRATION_SHAPE_PROFILES`.
- `--reasoning` (`default`) — `default` · `off` (`reasoning.enabled:false`) · `low` (`effort:low`). This is probes P1–P3.
- `--scenarios` (all) — substring match on scenario id (`hi`, `compliment`, `question`, `multi-party`, `intimate`, `chat`, `chat-contrast`, `mt-chat`).
- `--seeds` (`1`) — repeats per cell (temperature 0.8 ⇒ fresh samples); the replicate axis the contrast bar is scored over.
- `--no-focus` — drop the Phase-3 `focus` planner from every prompt (`buildResponseShape` falls back to its deterministic Phase-2 derivation).
- `--no-judge` — deterministic metrics only (cheaper).
- `--dry-run` — print prompts, make no calls.

Env: `EVAL_JUDGE_MODEL` (default `z-ai/glm-5.2` — set to your strongest available judge), `EVAL_OUT` (default `data/eval/narration`).

## What it measures

- **Deterministic** (no judge — cheap, stable): paragraph count, segment count + **distinct NPC
  speakers** (`segmenter.parseSegments` (`@/lib/segmenter`) — catches length regressions and
  multi-party over-talking; informational, not a pass/fail bar), output tokens, TTFT, total latency,
  routed provider. Note: since the **chat** lane relaxed its `[Name]` tag to optional (dialogue-attribution
  — the renderer attributes standalone quotes), chat replies now often read **0 distinct speakers**;
  this run scores them without the renderer's standalone-quote option, so that is expected, not a regression.
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

## Paired contrast fixtures — does the chat engine's depth show? (`--axis contrast`)

The measurement baseline for character-chat-standalone.plan.md area 3 / spec §5 (the PM reports NO
noticeable effect from the personality sliders or tracked state in play), extended by the Gate 0
grounding spike. `fixtures.ts` carries eight `chat-contrast-*` pairs over ONE character (Wren);
each pair is **identical except one flipped input** and uses the real
`buildCharacterChatSystemPrompt`:

| axis | flagged / control | fixture ids |
| --- | --- | --- |
| `state` | heavy tracked state vs `state` omitted entirely | `chat-contrast-state-on` / `-state-off` |
| `sliders` | Warmth +80 & Inhibition −80 vs −80 & +80 | `chat-contrast-warm` / `-cold` |
| `stage` | regard 93 (devoted) vs 0 (neutral) | `chat-contrast-lover` / `-stranger` |
| `drunk` | intoxication 0.8 vs 0 | `chat-contrast-drunk` / `-sober` |
| `memory` | 3 facts + 1 episode vs no `memory` | `chat-contrast-memory-on` / `-memory-off` |
| `familiarity` | deeply known vs stranger, same cool regard | `chat-contrast-familiar-hostile` / `-stranger-hostile` |
| `mask` | warm regard behind a cold front vs openly warm | `chat-contrast-masked` / `-honest` |
| `grounding` | 6am pre-shower/not ready vs 8am post-shower/ready | `chat-contrast-grounding-pre-shower` / `-post-shower` |

```bash
pnpm eval:narration --scenarios chat-contrast --models aion,glm --seeds 5 --no-judge   # generate (live spend)
pnpm eval:narration:compare --axis contrast                                            # blind pair judging
pnpm eval:narration:compare --axis contrast --dry-run                                  # inspect pairing, no calls
```

To run only the Gate 0 ablation cheaply:

```bash
pnpm eval:narration --scenarios chat-contrast-grounding --profiles concise --models aion --seeds 5 --no-judge
pnpm eval:narration:compare --axis contrast
```

`compare.ts` pairs flagged vs control by the fixtures' `contrast` metadata within
(model × profile × reasoning × seed), hash-shuffles which reply is "A" (position-bias mitigation),
and the **blind judge** — told only the player message and what the hidden difference *is* — must
identify which reply carries the flag and rate the difference's visibility (1 = indistinguishable,
5 = unmistakable). A judge parse failure degrades to *unidentified* (counted incorrect), never a
defaulted guess. **Acceptance bar: ≥80% correct identification per axis** — the table prints
PASS/FAIL; below the bar the axis is declared **not enacted** and its prompt wording gets tuned and
re-run (spec §5 outcome routing). Where an axis defines a lexical cue list (`CONTRAST_AXES[..].cueRe`
— state/drunk/memory/grounding), the deterministic `cueSep` column reports flagged-hits-cue-and-control-doesn't
(the `sensoryRelevant` pattern; also per-row as the `cue` column in `run.ts`), a judge-drift guard.
After tuning, the pairs stay as the permanent regression harness.
- **Judge model:** set `EVAL_JUDGE_MODEL` to a **strong** model so it out-classes the cast it scores
  — e.g. `EVAL_JUDGE_MODEL=google/gemini-3.1-pro-preview` (there is no `gemini-3.5-pro` slug). A strong
  judge is usually a reasoning model, so the rank judge uses a 1500-token budget to avoid
  reasoning-tokens-eat-the-output empties.

## Multi-turn transcript scenarios (`mt-chat-*`)

Single-turn cells can't show the failures that emerge over a conversation — repetition creep,
interview-mode question cadence, sensory frequency, paragraph inflation, warmth escalating on its
own (narrator-prompt-consolidation.plan.md slice 6). A scenario with a `script` runs as a
transcript: the runner feeds each scripted player input in order, the model sees its own prior
replies as history, and — when the scenario defines `buildTurnSystem` — the system prompt is
rebuilt **per turn** with the live route's per-turn derivations (the sensory-allowance line from
that turn's input, the reply-discipline gates from the prior replies).

```bash
pnpm eval:narration --scenarios mt-chat --models glm --no-judge   # transcripts, deterministic metrics only
pnpm eval:narration --scenarios mt-chat --dry-run                 # turn-1 system + the script, no spend
```

Longitudinal metrics (all deterministic; printed in their own table and saved per-row as
`multiTurn`): **q-end%** (replies ending on a dialogue question — `replyEndsInQuestion`),
**repeat%** (mean share of a reply's word 5-grams already seen in earlier replies — stock-phrase /
re-description creep; nonzero noise floor, read comparatively across runs), **sens%** (replies with
a person-level sensory reference — `mt-chat-smalltalk` is all-`none` turns so this should be ~0;
`mt-chat-statements` has exactly one attention beat), and **paragraphs avg/max** (length inflation
under the resting profile). The judge (when on) scores the whole formatted transcript against the
scenario's longitudinal expectation.

## Scope guard

The harness **measures** — a low score is a signal to iterate the prompt wording, never a build
failure. The golden scenarios live in `fixtures.ts`; the surrounding "scenery" blocks (scene
snapshot, presence roster, wardrobe) are hand-authored fixture strings, while the Phase-1/2/3
surface under test is produced by the real builders.
