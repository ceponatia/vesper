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
mature/yellow/manual policy and `insufficientBuzz: false` must all check out.
Paid POSTs are never retried. A transport-ambiguous submit halts the run until
`recent` / `reconcile` has reconciled it by tag or id.

`CIVITAI_API_TOKEN` is read from the repository `.env` once, kept in a private
field, and appears in no saved file (every retained request/response goes
through `lib/redact.mjs`: secrets by key, signed URLs by query, data URLs by
hash).

## Commands

```bash
node scripts/eval/civitai-klein-4b/run.mjs run --manifest scripts/eval/civitai-klein-4b/manifests/phase-0-capability.json
```

| Command | Purpose |
| --- | --- |
| `run --manifest F [--only a,b] [--skip a,b] [--test T0.2] [--quote-only]` | what-if every selected arm; paid arms also submit when the gates are open. `--quote-only` prices a paid manifest without spending. |
| `resolve-loras [--refresh-loras]` | live-verify every LoRA in `manifests/loras.json` (id, modelId, type, status, base model, sha256) and print the AIRs |
| `recent [--take N] [--tags a,b]` | list recent workflows on the account (the list endpoint carries more than the single-workflow read) |
| `reconcile --manifest F --arm ID --workflow WID` | finish an arm whose poll was abandoned or whose submit was ambiguous |
| `compare A B` | sha256 / pixel-identical / mean-abs-diff / dHash distance of two images |
| `sheet --manifest F (--test T | --arms a,b) [--columns N]` | labelled contact sheet of delivered outputs |
| `promote --manifest F --arm ID --as KEY` | copy a delivered output into `inputs/promoted/KEY.jpg` for use as a fixture (CHAR_B) |
| `aggregate --phase P` | aggregate a graded `scores/P.csv` against the RESULTS.md continuation gates |
| `summarize --manifest F` | rebuild `summaries/<phase>.{json,md}` from the per-arm records after an interrupted run |
| `grid --spec S.json` | contact sheet from a spec (`{ title, columns, cells: [{ file, label, crop? }] }`; `crop` is fractional) — mixes phases, gates and the reference fixtures |

Two companion scripts: `continuation.mjs` writes `ledger.md` (spend from
`ledger.json`, every executed arm, classification of every manifest arm),
and `publish.mjs` builds `web/` (contact sheets as JPEG, renders, docs,
scores, `index.html` of direct links; adult arms excluded unless
`--include-adult`) and prints the `aws s3 sync` command for the public bucket.

## Layout

```
scripts/eval/civitai-klein-4b/
  run.mjs                  CLI
  lib/{env,redact,civitai,image,manifest,scoring}.mjs
  manifests/fixtures.json  reference pack (Sabrina, one synthetic identity)
  manifests/loras.json     LoRA registry, pinned by immutable version id
  manifests/prompts.json   P1–P12 and the variant prompts
  manifests/phase-*.json   arms per phase

eval-images/civitai-klein-4b/        (gitignored)
  inputs/<KEY>.jpg + index.json      prepared JPEG references + hashes
  runs/<phase>/<arm>/                request.json, whatif.json, echo.json, [submit.json,
                                     timeline.json, workflow.json, output.json], record.json
  images/<phase>/<arm>.jpg           delivered outputs
  summaries/<phase>.{json,md}        per-phase tables
  scores/<phase>.csv                 grading sheet (0–4 rubric + hard-failure flags)
  contact-sheets/*.png + specs/      sheets and the grid specs that built them
  ledger.json                        MACHINE ledger the spend caps read — never edit
  ledger.md                          human ledger (continuation.mjs)
  lora-resolution.json               live LoRA metadata as verified
  RESULTS.md                         the single results record
  web/                               shareable bundle (publish.mjs)
```

## Generating the paid phases

`manifests/phase-0-capability.json` is hand-written. Phases 1–10 are emitted by

```bash
node scripts/eval/civitai-klein-4b/manifests/generate.mjs
```

from `manifests/decisions.json` (seeds, size, the distilled/base recipes, LoRA
weights, the variant strength, the post-grading "best" choices). Edit the
decisions after grading a phase and regenerate; `manifests/index.json` lists the
execution order and the gates between phases. Price any phase without spending:

```bash
node scripts/eval/civitai-klein-4b/run.mjs run --manifest scripts/eval/civitai-klein-4b/manifests/phase-6-base.json --quote-only
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
