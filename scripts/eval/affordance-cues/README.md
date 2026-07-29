# Affordance-cue narrator trial

The owner-gated live comparison for **slice 5** of
`docs/developer-notes/body-attribute-affordances.plan.md`: does the
`CHAT_AFFORDANCE_CUES` narrator cue path beat the current appearance-only path on
**contradiction rate, repetition, specificity and prose naturalness**?

Results and the standing recommendation live in
[`docs/developer-notes/body-attribute-affordances.trial.md`](../../../docs/developer-notes/body-attribute-affordances.trial.md).

## Run

```bash
pnpm eval:affordance-cues --dry-run     # matrix, cue lines, self-checks. NO model calls, free.
pnpm eval:affordance-cues               # the full paired trial + judging (live, billable)
pnpm eval:affordance-cues --no-judge    # generate both arms, skip the judge
pnpm eval:affordance-cues --scenario rain   # substring match on scenario id
```

Other flags: `--out <dir>` (default `data/eval/affordance-cues`, or `EVAL_OUT`),
`--chat-model <slug>`, `--judge-model <slug>`, `--concurrency N` (default 3,
scenario-level).

`--dry-run` writes `matrix.json`; a live run writes `trial.json`. `data/` is
gitignored, so quote numbers into the trial doc rather than linking the file.

**Not wired into `pnpm verify`/CI, ever.** It spends money and it measures a
judgment call. The fixture guard (`harness.test.ts`) *is* pure and does run in
`pnpm test` — it proves the matrix still fires before anyone spends anything.

## Design

**Paired scenarios.** Ten scripted conversations, three consecutive exchanges
each — 30 paired exchanges, 60 narrator generations. Every scenario is built from
*committed typed state* (a story clock, a `ChatEnvironment`, a `body_surface`
wetness entry with its cause, real worn garment rows), never from prose, because
prose is exactly what the layer under test refuses to treat as an input.

The matrix spans wet × dry, loose × braided × pinned × ponytail, hooded ×
sheer-scarfed × bare, wind × still, indoors × outdoors, and rain × immersion ×
splash provenance. Two scenarios are **silence controls** — dry, still — where the
correct behaviour is that no cue fires at all and the two arms receive
byte-identical prompts. They are the null control for the feature *and* for the
judge.

**Both arms get identical inputs except the cue block.** The read
(`buildChatAffordanceRead`), the projection (`renderChatAffordanceCues`), the
per-turn sensory allowance (`deriveChatSensoryAllowance`) and the prompt
(`buildCharacterChatSystemPrompt`) are all the production functions; the harness
only assembles the state slice the database-bound pipeline would have loaded, and
hands the same object to both arms. A self-check asserts the cue-arm prompt is
the control prompt with exactly one block spliced in.

Generation runs through `streamCharacterChat` — the real chat narrator, on the
chat lane's default model, at the production temperature. Each arm carries its
own conversation history, so repetition is measured over what that arm actually
said.

**Judging.** One LLM judge call per scenario sees both transcripts as A and B —
assigned by a deterministic per-scenario hash — plus, per exchange, the committed
physical state in plain English as ground truth for the contradiction count. The
ground-truth block deliberately omits the rendered cue lines, or the judge would
know which arm was which on sight. Alongside the judge, three model-free proxies
are recorded: hair mentions per exchange, hair-sentence count, and lexical
overlap of hair talk between consecutive exchanges.

## What it reports

Per criterion, cues vs control: contradictions per exchange, repetitions per
exchange, static-appearance restatements per exchange, mean specificity (1–5),
mean naturalness (1–5), a physics-report flag, and the judge's overall
preference. Plus the mechanical checks — cue cap, appearance/cue duplication, the
silence controls — and a `sensoryAllowance` × cue cross-tab.

## Decision rule

Flip `CHAT_AFFORDANCE_CUES` **on** when, over the cue scenarios:

1. contradictions per exchange are **lower** in the cue arm (this is the primary
   claim; the plan's own release contract asks for "cues reduce contradictions
   without causing repetition");
2. repetitions per exchange are **not higher** in the cue arm;
3. mean naturalness is within **0.3** of control and no scenario is flagged a
   physics report;
4. specificity is **higher** in the cue arm;
5. both silence controls emit zero cues, and the judge's preference on them is
   split rather than one-sided (a one-sided split there is judge label bias, and
   invalidates the preference figure everywhere else).

Failing 1 or 2 ⇒ keep it off. Failing only 3 or 4 ⇒ a projection-wording problem,
not a physics one: retune `chat-affordance-cues.ts` and rerun.

## Caveats

- The narrator runs at the production temperature (0.85) and OpenRouter exposes
  no seed, so generation is **not** reproducible. Everything upstream of the
  model call is deterministic: same fixtures, same reads, same cue lines, same
  prompts, same A/B blinding.
- 30 paired exchanges is a *directional* sample. Treat a gap of a few hundredths
  in a per-exchange rate as noise.
- Only `hair.wet_clumping` and `hair.wind_or_motion_response` can reach
  production in this lane; adhesion needs a contact owner and shedding needs a
  committed impulse. The trial therefore measures the reachable half of the hair
  domain, which is also all the flag can currently ship.
