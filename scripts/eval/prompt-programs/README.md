# Prompt-program eval

Paid, manually run trials for the prompt-program layer
(`packages/image-core/src/prompt-program/`). Not a `pnpm test` gate — every
question here is answered by looking at a picture.

The endpoint-neutral machinery — trial/arm/fixture contracts, the paired-seed
render loop, contact sheets, scoring templates, the rates report, and the
determinism comparison — lives in `negative-trial-harness.ts` and is shared by
the per-block trials and the canary program below. Each script owns only its
endpoint description (the seeded row's shape plus the probed negative field),
its trial definitions, and its CLI. `negative-block-report.ts` is the pure
half — CSV parsing, rate arithmetic, and the manifest-provenance merge that
lets a resumed `--render` run keep skipped renders' recorded
`executedVersionId`/`predictionId` — covered by `pnpm test`.

## `negative-field-canary.ts` — is an endpoint's negative field even alive

Issue #253. Qwen Image 2512 exposed `negative_prompt` and ignored it (16/16
canary failures), so no endpoint's negative channel is trusted on the wrapper's
word: before any per-block trial is bought on an endpoint, this program runs
the red-apple protocol there — the qwen instrument's trials A/A2 fixture and
arms verbatim, with per-endpoint sampling paths.

```bash
pnpm tsx scripts/eval/prompt-programs/negative-field-canary.ts                        # free: every endpoint's arms + CSV templates
CANARY_ENDPOINT=sd35 AB_TRIAL=A pnpm tsx .../negative-field-canary.ts --render        # PAID: one trial on one endpoint
CANARY_ENDPOINT=sd35 AB_TRIAL=all pnpm tsx .../negative-field-canary.ts --render      # PAID: that endpoint's full program
CANARY_ENDPOINT=sd35 pnpm tsx .../negative-field-canary.ts --report                   # rates + deltas + determinism verdict
```

Endpoints and per-endpoint render counts (`AB_TRIAL` picks one trial):

| endpoint | model                                        | A (production path) | A2 (alternate path)        | A3 (high guidance) | D (determinism) | full |
| -------- | -------------------------------------------- | ------------------- | -------------------------- | ------------------ | --------------- | ---- |
| `sd35`   | `stability-ai/stable-diffusion-3.5-large`    | 20                  | —                          | 12 (`cfg: 9`)      | 2               | 34   |
| `pulid`  | `nsfw-api/sdxl-pulid` (pinned)               | 20                  | —                          | 12 (`cfg: 7`)      | 2               | 34   |
| `pony`   | `aisha-ai-official/likereality-pony-v1` (pinned) | 20              | 12 (`prepend_preprompt: false`) | 12 (`cfg_scale: 10`) | 2          | 46   |

The cheap verdict path is A + D (22 renders); A2/A3 are escalations for an A
that shows no steering, mirroring how the qwen canary escalated through
`go_fast` and guidance. Trial A runs each endpoint's production configuration:
the reviewed settings from `reviewed-profile-controls.ts` ride every render
(PuLID 832×1216 + `method: "fidelity"`; Pony 832×1216 with the OFF arm sending
`negative_prompt: ""` explicitly, because that wrapper's provider default is
`"nsfw, naked"` and an absent field would be a different negative, not none).
The PuLID canary is bare-prompt — no `reference_image`, so no face adapter in
the loop. Each endpoint's negative field and sampling knobs are the probed
inputs recorded in `docs/image-models/models/<model>.md`.

Trial D renders one arm twice at one seed and the harness compares SHA-256
hashes itself: identical files mean the seed pins sampling and OFF/ON byte
differences are meaningful; differing files mean byte-level comparison says
nothing (the qwen compass misreading is the precedent). Renders land in
`eval-images/negative-canary/<endpoint>/<trial>/`, with the same manifests,
contact sheets, and `scores-<trial>.csv` templates as the block trials; grade
the CSVs and `--report` computes per-arm rates and OFF→ON deltas. The verdict —
working or inert, per endpoint — is recorded on issue #253, and dialects
declare `negativeTransport` accordingly.

## `qwen-2512-negative-blocks.ts` — the per-block induction trials

The Stage 6 promotion evidence. One trial per negative block, each built to
INDUCE the failure that block exists to suppress, because a block judged
against renders where the failure never appears is not neutral — it is
untested. Paired seed sets, one variable per comparison, binary scoring first,
and the output is a matrix (block × failure → helpful / neutral / harmful /
inconclusive), never a single global verdict.

```bash
pnpm tsx scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts             # free: prints every arm, writes scoring templates
AB_TRIAL=B1 pnpm tsx scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts --render   # PAID: one trial
AB_TRIAL=all ... --render                                                       # PAID: everything
pnpm tsx scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts --report    # rates + deltas from the graded CSVs
```

Renders land in `eval-images/qwen-negative-blocks/<trial>/`, one file per
fixture × arm × seed, plus a labeled contact sheet per fixture × arm for
grading, a `manifest.json` recording the executed version id per render, and a
`scores-<trial>.csv` template (never overwritten once it exists). Grade the
binary columns, then `--report` computes per-arm rates and OFF→ON deltas; the
verdict stays human.

Trial A is a deliberately contradictory lab canary (`red apple, apple` in the
negative against a requested red apple) proving the transport steers at all —
it bypasses the production collision linter by design and is not a production
wording. Trials B–I each test one block against an induced failure. Trial J —
the combined candidate pack over a representative suite — runs later on the
`entity-negative-ab.ts` harness, after the owner reviews the matrix and the
pack wording is revised.

## `entity-negative-ab.ts` — the production-pack A/B harness

Compiles the real production packs over projected rows with everything held
constant except `negativeFieldAvailable` — the exact boundary a version probe
crosses. The 2026-08-19 run (one seed per cell) is recorded as harness
verification: it proved the plumbing and surfaced the dress-form and
compass-dial observations, but supports no promote/reject verdict. Trial J
re-uses this harness with paired seeds once a reviewed candidate pack exists.

Two arms over seven fixed rows — four items, three locations — with the seed,
the packs, the world and the positive prompt held constant. The only variable is
`negativeFieldAvailable`, which is the exact boundary a version probe crosses.

```bash
pnpm tsx scripts/eval/prompt-programs/entity-negative-ab.ts
```

Free: prints each case's positive prompt, its compiled negative, which
exclusions would be delivered and which were dropped by the collision linter,
and writes a blank `scores.csv`. Nothing is sent.

```bash
pnpm tsx scripts/eval/prompt-programs/entity-negative-ab.ts --render
```

Paid. Renders both arms per case into `eval-images/entity-negative-ab/`.
`AB_CASE=<id>` runs one row, `AB_SEED=<n>` moves the held seed, `AB_OUT=<dir>`
moves the output.

Grade `scores.csv` by eye. Every render stays local, under the untracked root
`eval-images/` (owner ruling 2026-08-28) — nothing is promoted into git, so the
verdict itself has to be written up on the issue the run was for.

**It does not touch production.** The negative field is switched by a local model
literal, not by probing the database row: activating that row's version would
repin four seeded profiles at once, so the evidence has to come first.

Worth knowing before grading composition: the seeded `qwen/qwen-image-2512` row
offers no 3:2, so a location render — whose card is 3:2 — is produced at 4:3 and
cropped. The script reports the negotiated shape per case. That crop is the
capability layer working as designed, not a prompt failure, and a composition
score that blames the prompt for it is measuring the wrong thing.

Two of the seven rows — `lettered_sign` and `shop_front` — author lettering in
prose that no projection turns into a protected claim, so today's compile sends
the text exclusions anyway. Whether the model then refuses to draw the words is
the question those two cells answer.
