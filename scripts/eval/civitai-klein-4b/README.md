# Civitai FLUX.2 Klein 4B qualification harness

A standalone, zero-spend-by-default runner for the Klein 4B qualification
suite. It talks to the Civitai Orchestration API directly (not through
Vesper's adapter) so that it can exercise what Vesper does not yet expose:
`4b-base`, multiple LoRAs, `sdcpp` `createVariant`, more than two references,
and reference ordering.

It imports no application code and starts no service. Generated output lives
under gitignored `eval-images/civitai-klein-4b/`.

## Spend gates

Every default is zero-spend. A paid submit happens only when **all four** hold:

| Gate | Value |
| --- | --- |
| `CIVITAI_EVAL_DRY_RUN` | the literal `false` (unset = dry run) |
| `--paid` | present on the command line |
| `CIVITAI_EVAL_MAX_PAID_RUNS` / `--max-paid-runs` | > 0 |
| `CIVITAI_EVAL_MAX_YELLOW_BUZZ` / `--max-yellow-buzz` | > 0 |

Both caps are compared against the **cumulative** `ledger.json` in the output
directory, so they bound the whole suite, not one invocation. Before every paid
submit the identical body is sent with `whatif=true`; the quote, the echo, the
mature/yellow/manual policy and `insufficientBuzz: false` must all check out. A
response that carries no billing data at all is unpriced, not free: the quote
stays `null` and the submit is refused, because a zero would consume none of
the Buzz cap. Paid POSTs are never retried. A transport-ambiguous submit halts
the run until `recent` / `reconcile` has reconciled it by tag or id.

Rerunning an arm never lands on top of the previous attempt: its records move
to `runs/<phase>/<arm>/superseded/<workflow>/`, its render to
`images/<phase>/superseded/`, and the graded score rows follow the bytes they
describe, so a fresh render is graded fresh and a failed rerun leaves no stale
`output.json` behind.

`CIVITAI_API_TOKEN` comes from the process environment — `scripts/web.mjs`
solely owns loading the repository `.env`, so this harness adds no second
loader. Keep it in `.env` and pass it with Node's own flag:

```bash
node --env-file=.env scripts/eval/civitai-klein-4b/run.mjs run --manifest ...
```

The token is read once, kept in a private field, and appears in no saved file
(every retained request/response goes through `lib/redact.mjs`: secrets by key,
signed URLs by query, data URLs by hash).

## Commands

```bash
node scripts/eval/civitai-klein-4b/run.mjs run --manifest scripts/eval/civitai-klein-4b/manifests/phase-0-capability.json
```

| Command | Purpose |
| --- | --- |
| `run --manifest F [--only a,b] [--skip a,b] [--test T0.2] [--quote-only]` | what-if every selected arm; paid arms also submit when the gates are open. `--quote-only` prices a paid manifest without spending. |
| `resolve-loras [--refresh-loras]` | live-verify every LoRA in `manifests/loras.json` (id, modelId, type, status, base model, sha256) and print the AIRs |
| `recent [--take N] [--tags a,b]` | list recent workflows on the account (the list endpoint carries more than the single-workflow read) |
| `reconcile --manifest F --arm ID --workflow WID` | finish an arm whose poll was abandoned or whose submit was ambiguous. The workflow must identify as that arm (its `arm:`/phase tags, its metadata, or the ledger entry of the ambiguous submit) or it is refused; an ambiguous submit's pending ledger entry is resolved in place rather than counted a second time |
| `compare A B` | sha256 / pixel-identical / mean-abs-diff / dHash distance of two images |
| `sheet --manifest F (--test T | --arms a,b) [--columns N]` | labelled contact sheet of delivered outputs |
| `promote --manifest F --arm ID --as KEY` | copy a delivered output into `inputs/promoted/KEY.jpg` for use as a fixture (CHAR_B) |
| `aggregate --phase P` | aggregate a graded `scores/P.csv` against the RESULTS.md continuation gates |
| `summarize --manifest F` | rebuild `summaries/<phase>.{json,md}` from the per-arm records after an interrupted run |
| `grid --spec S.json` | contact sheet from a spec (`{ title, columns, cells: [{ file, label, crop? }] }`; `crop` is fractional) — mixes phases, gates and the reference fixtures |

Two companion scripts: `continuation.mjs` writes `ledger.md` (spend from
`ledger.json`, every executed arm, classification of every manifest arm),
and `publish.mjs` builds `web/` (contact sheets as JPEG, renders, docs,
scores, `index.html` of direct links) and prints the `aws s3 sync` command for
the public bucket.

`selftest.mjs` checks the two rules that are expensive to get wrong — what the
share bundle treats as adult, and what the spend gates treat as a quote —
against the committed manifests. It imports no application code and touches
nothing outside a temp directory, so it runs anywhere (Vitest collects only
`scripts/**/*.test.ts`, so it is not part of CI):

```bash
node scripts/eval/civitai-klein-4b/selftest.mjs
```

`publish.mjs` rebuilds `web/` from empty every time, so a bundle built earlier
with `--include-adult` cannot survive into a default one. What counts as adult
comes from the manifests, never from a file name: each manifest declares
`"adult"`, and inside an SFW manifest the adult arms are the ones on an adult
prompt family (`A*`, `S*`, the two-women pose prompts). A render or contact
sheet the manifests cannot place refuses the default bundle by name instead of
being published into it.

## Layout

```
scripts/eval/civitai-klein-4b/
  run.mjs                  CLI
  selftest.mjs             offline checks for the adult and quote rules
  lib/{env,redact,civitai,image,manifest,scoring}.mjs
  manifests/fixtures.json  reference pack (Sabrina, one synthetic identity)
  manifests/loras.json     LoRA registry, pinned by immutable version id
  manifests/prompts.json   P1–P12, the A* adult and S* scene prompts
  manifests/gate-*.json    arms per gate (the current plan)
  manifests/phase-*.json   arms per phase (the superseded library + phase 0)
  manifests/index.json     execution order (generated) + the library archive

eval-images/civitai-klein-4b/        (gitignored)
  inputs/<KEY>.jpg + index.json      prepared JPEG references + hashes
  runs/<phase>/<arm>/                request.json, whatif.json, echo.json, [submit.json,
                                     timeline.json, workflow.json, output.json], record.json
  runs/<phase>/<arm>/superseded/     a prior attempt, archived by its workflow id
  images/<phase>/<arm>.jpg           delivered outputs
  images/<phase>/superseded/         renders a rerun replaced
  summaries/<phase>.{json,md}        per-phase tables
  scores/<phase>.csv                 grading sheet (0–4 rubric + hard-failure flags)
  contact-sheets/*.png + specs/      sheets and the grid specs that built them
  ledger.json                        MACHINE ledger the spend caps read — never edit
  ledger.md                          human ledger (continuation.mjs)
  lora-resolution.json               live LoRA metadata as verified
  RESULTS.md                         the single results record
  web/                               shareable bundle (publish.mjs)
```

## Generating the manifests

The current plan is the **adaptive gate suite** (`gate-*.json`), emitted from
`manifests/decisions.json` by

```bash
node scripts/eval/civitai-klein-4b/manifests/generate-gates.mjs
```

which also writes `manifests/index.json`: the execution order of the current
plan, each gate's title, which gates are adult, and — under `archive` — the
original 553-arm `phase-1 … phase-10` library that the gates superseded. The
library is not an execution plan; it is kept for the evidence its executed arms
provide (each gate cites what it reuses), and `manifests/generate.mjs` is what
emitted it. `manifests/phase-0-capability.json` is hand-written and free.

The gates are adaptive: grade a gate, edit the decisions, regenerate, run the
next one. Generation depends only on committed files, so the same decisions
produce the same manifests on every checkout — a fixture that exists only on
the owner's machine fails its own arm at execution time rather than silently
shrinking the experiment. Price any manifest without spending:

```bash
node scripts/eval/civitai-klein-4b/run.mjs run --manifest scripts/eval/civitai-klein-4b/manifests/gate-8-adult-solo.json --quote-only
```

## Manifest arms

```json
{ "id": "T2.4-A", "test": "T2.4", "mode": "paid", "prompt": "P5", "seed": 424242,
  "references": ["R1_FACE", "R3_FULL_BODY"],
  "loras": [ { "key": "L2", "strength": 2.0 } ],
  "input": { "cfgScale": 1, "steps": 8 }, "priority": "low",
  "negativePrompt": "NEG1", "recipe": "distilled-2ref-s8", "notes": "..." }
```

`prompt` may compose keys (`"P2+ANATOMY_POSITIVE"`) or be replaced by
`promptText`. `references` are fixture keys in order (order is a semantic
contract under test). `loras` is an ordered list; the serialized map keeps that
order. `input` overrides the manifest `defaults`; `engine: "sdcpp"` with
`operation: "createVariant"` and `strength` selects the variant path.
