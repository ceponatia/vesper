# Prompt-program eval

Paid, manually run trials for the prompt-program layer
(`packages/image-core/src/prompt-program/`). Not a `pnpm test` gate — every
question here is answered by looking at a picture. The one exception is
`shadow-report.ts`, which reads a database and spends nothing.

The endpoint-neutral machinery — trial/arm/fixture contracts, the paired-seed
render loop, contact sheets, scoring templates, the rates report, and the
determinism comparison — lives in `negative-trial-harness.ts` and is shared by
the per-block trials, the canary program, and the variant prompt A/B below. Each
script owns only its endpoint description (the seeded row's shape plus the
probed negative field), its trial definitions, and its CLI.
`negative-block-report.ts` is the pure half — CSV parsing, rate arithmetic, and
the manifest-provenance merge that lets a resumed `--render` run keep skipped
renders' recorded `executedVersionId`/`predictionId` — covered by `pnpm test`.

An endpoint may declare a reference SUPPLIER
(`NegativeTrialEndpoint.references`) for a workflow that cannot run from a bare
prompt — an edit-only model such as Qwen Image Edit 2511. The harness resolves
it **once per run** and sends exactly those bytes on every arm, seed and trial,
so "the reference is held constant" is a property of the harness rather than of
a supplier remembering to be pure; it is invoked only on a `--render` run, so a
free run and a report never demand the file. Endpoints that declare none send no
`references` key at all and are byte-identical to what they were.

## `negative-field-canary.ts` — is an endpoint's negative field even alive

Issue #253. Qwen Image 2512 exposed `negative_prompt` and ignored it (16/16
canary failures), so no endpoint's negative channel is trusted on the wrapper's
word: before any per-block trial is bought on an endpoint, this program runs
the fruit-bowl protocol there (owner ruling 2026-08-29). The earlier
direct-conflict canary — a requested red apple with "apple" in the negative —
was retired because it measures whether the negative can override an explicit
positive request, which is not how negative prompts are used and risks false
"inert" verdicts. The corrected protocol tests suppression of prompt-IMPLIED
content: the positive asks for "a classic bowl of assorted fresh fruit" and
never names apples, the ON arm sends `apple, apples, red apple`, and a working
field means apple incidence in the ON arm falls measurably below the OFF arm at
paired seeds. The OFF arm doubles as the base-rate check — the delta is only
readable if apples actually appear without the negative, and a low OFF rate
makes the verdict unreadable: escalate to A2/A3 or re-fixture instead of
recording "inert". Graders mark one binary per render, `apple_present`
(collateral: `other_fruit_preserved`). The recorded qwen instrument below keeps
its old conflict fixture verbatim so its 2026-08-19 runs stay reproducible.

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
that shows no suppression — or whose OFF-arm base rate is too low to read —
mirroring how the qwen canary escalated through `go_fast` and guidance. Trial A
runs each endpoint's production configuration:
the reviewed settings from `reviewed-profile-controls.ts` ride every render
(PuLID 832×1216 + `method: "fidelity"`; Pony 832×1216 with the OFF arm sending
`negative_prompt: ""` explicitly, because that wrapper's provider default is
`"nsfw, naked"` and an absent field would be a different negative, not none).
The PuLID canary sends a fixed synthetic `reference_image` on every arm — the
wrapper's workflow refuses bare prompts ("PuLID requires a reference face
image", measured 2026-08-29; the schema's prompt-only claim is wrong live), so
with-reference is both the only runnable shape and the production shape. The
face rides from `eval-images/negative-canary-fruit-bowl/reference-face.webp`
(override with `CANARY_FACE=<path>`); any clear synthetic front-facing
portrait works, held constant across every arm of a run. Each endpoint's
negative field and sampling knobs are the probed inputs recorded in
`docs/image-models/models/<model>.md`.

Trial D renders one arm twice at one seed and the harness compares SHA-256
hashes itself: identical files mean the seed pins sampling and OFF/ON byte
differences are meaningful; differing files mean byte-level comparison says
nothing (the qwen compass misreading is the precedent). Renders land in
`eval-images/negative-canary-fruit-bowl/<endpoint>/<trial>/`, with the same manifests,
contact sheets, and `scores-<trial>.csv` templates as the block trials; grade
`apple_present` per render and `--report` prints the OFF-arm base rate, the
ON-vs-OFF delta per sampling path, and the determinism result, with a legend
restating the base-rate caveat. The verdict — working or inert, per endpoint,
or unreadable pending a better fixture — is recorded on issue #253, and
dialects declare `negativeTransport` accordingly.

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

## `shadow-report.ts` — what a window of recorded shadow verdicts says

Issue #256. A character image lane in shadow compiles the candidate prompt
program beside its production prompt and records the comparison on the row
(`server/images/shadow-comparison.ts`, `image.meta.shadowComparison`). This is
the reading of that window: a narrowed query, a defensive parse, and the pure
aggregator in `apps/web/src/lib/images/shadow-evidence.ts`, which owns every
rule about which records may be attributed to what and is covered by
`pnpm test`.

**Free.** It reads; it contacts no provider and writes no row.

```bash
pnpm tsx scripts/eval/prompt-programs/shadow-report.ts                                   # portrait_variant, the last 500 rows with a verdict
pnpm tsx scripts/eval/prompt-programs/shadow-report.ts --kind portrait_variant --variant-kind pose
pnpm tsx scripts/eval/prompt-programs/shadow-report.ts --lane variant --model qwen/qwen-image-edit-2511
pnpm tsx scripts/eval/prompt-programs/shadow-report.ts --since 2026-08-29T00:00:00Z --limit 2000 --json
fly ssh console -a vesper -C "pnpm tsx scripts/eval/prompt-programs/shadow-report.ts"    # against the deployed database
```

Flags: `--kind` (`avatar`, `portrait_variant`, `scene`, `chat_look`; default
`portrait_variant`), `--lane`, `--variant-kind`, `--model`, `--since`,
`--until`, `--limit` (default 500), `--json`, `--help`. A flag present but
valueless exits rather than reading as absent — the two are opposite intentions,
and here the difference is the scope of a claim.

**Reading the numbers.** The four verdicts stay four. `unmeasured` is not a
pass — it is a render that produced no evidence either way (no binding, no fact
list, a capture that refused to plan) — and `error` is the comparator itself
breaking. The only honest denominator for a parity rate is the *measured* count
(`parity + divergence`), so the headline states all four buckets and there is
deliberately no single "pass rate" field anywhere in the summary. Rows whose
stored blob the schema cannot parse are counted and reported on their own line,
never coerced into a verdict.

What the report structurally **cannot** see, restated on every run: every list
on a stored verdict is capped at its first 16 entries, so a fact frequency table
is a floor rather than a total; and `image_shadow.allowlist_inert` and
`image_shadow.capture_refused` are sink-only codes that never reach a row, so
how often a seeded delta was filtered away and which side's capture refused are
both invisible here.

It prints counts, diagnostic codes, canonical shadow fact names, prompt lengths
and the binding identity from `meta.render`. Never prompt text, never a
character name, never an attribute value — the fact names are subject-agnostic
by construction (`shadowFactName` strips the subject prefix). More than one
`executedVersionId` in a window is called out: the provider moved underneath the
evidence, and those renders are not one experiment. A render that failed a
precondition never reached `produce` and therefore carries a verdict with **no**
`meta.render`; those rows are named `(not recorded)` rather than inheriting
another row's binding.

## `variant-prompt-ab.ts` — legacy variant prompt vs compiled prompt program

Issue #256, the `variant-standard` cutover. The shadow answers the structural
half (facts, transport, anchors). This answers the half no comparator can: does
the compiled program make an equally good picture — same face, requested change
achieved, apparent age held, stated facts intact. Manually graded, on pinned
Qwen Image Edit 2511.

```bash
pnpm tsx scripts/eval/prompt-programs/variant-prompt-ab.ts                        # free: all three prompts per kind, the matrix, the CSV templates
pnpm tsx scripts/eval/prompt-programs/variant-prompt-ab.ts --dry-run              # free: the same, said explicitly
AB_TRIAL=pose pnpm tsx .../variant-prompt-ab.ts --render                          # PAID: one kind (6 renders)
AB_TRIAL=all  pnpm tsx .../variant-prompt-ab.ts --render                          # PAID: the whole matrix (26 renders)
AB_TRIAL=D    pnpm tsx .../variant-prompt-ab.ts --render                          # PAID: the determinism control (2 renders)
pnpm tsx .../variant-prompt-ab.ts --report                                        # per-arm rates from the graded CSVs
```

Flags: `--legacy-arm legacy|frozen` (default `legacy` — see the ruling below),
`--version <replicate version id>`, `--reference <path>`, `--out <dir>`,
`--render`, `--report`, `--dry-run`. `--render` and `--dry-run` together are
refused as opposite instructions.

Render counts — four ordinary variant kinds × two arms × three paired seeds,
plus a two-render determinism control:

| trial        | arms                  | seeds | renders |
| ------------ | --------------------- | ----- | ------- |
| `pose`       | legacy/frozen, compiled | 3   | 6       |
| `outfit`     | legacy/frozen, compiled | 3   | 6       |
| `expression` | legacy/frozen, compiled | 3   | 6       |
| `setting`    | legacy/frozen, compiled | 3   | 6       |
| `D`          | first, second (identical payloads) | 1 | 2 |
| **full**     |                       |       | **26**  |

`AB_SEEDS=<n>` moves the seed count (the harness reads it), `AB_SEED_BASE=<n>`
moves the seeds, `AB_OUT=<dir>` moves the output root.

**The one variable is the positive prompt.** Same seed in each paired
comparison, the same reference bytes in both arms, the same reviewed provider
controls (`go_fast: false`, derived from `reviewed-profile-controls.ts` rather
than restated — a trial without them would grade a configuration production does
not run), the same 3:4 target, the same pinned version. The endpoint sends no
negative at all: 2511 exposes no negative input, and a compiled program that
produced one would refuse the run rather than let a second variable in.

The compiled arm resolves its binding with **`resolver: "shadow"`**. The variant
binding is still registered as a `candidate` (`packs-qwen-2511.ts`) and this
trial is the evidence for promoting it, so `active` would resolve null and every
compiled arm would be unbound. The trial states the model row and the
`variant-standard` profile row locally — reading or activating the production
row would repin the version for every profile that resolves to it, and the
evidence has to come first.

The fixture is **the script's own**, declared in `variant-prompt-ab.ts`: a
succubus with spiraled horns, membranous wings and a spaded tail, dressed. The
variant lane's one named cutover delta is
`VARIANT_SHADOW_DELTA = { removed: [], added: ["horns", "wings", "tail"] }`, so
a fixture without species features would measure nothing about the delta.

It is deliberately **not** the shadow's lane probe. A runnable script cannot
import `@/server/test-support`: that barrel eagerly imports vitest
(`route-assertions.ts`, `sim-assertions.ts`, `sim-harness.ts`) and any non-vitest
consumer dies at load with *"Vitest cannot be imported in a CommonJS module using
require()"*, while `eslint.config.mjs` zone 4 bans the narrower
`@/server/test-support/image-lane-probe` spelling from `scripts/**`.
`scripts/check-route-authz.ts` records the same constraint and resolves it the
same way. The consequence worth stating: a number from this trial and a number
from `shadow-report.ts` describe two characters authored to the same shape, not
one character. Both arms of the trial still describe one character — the legacy,
frozen and compiled prompts are all built from a single `buildVariantSegments`
assembly over one realized cut.

`nsfw_test` is excluded: that kind runs on the LoRA wrapper slug
(`qwen/qwen-image-edit-plus-lora`), a different endpoint with a different
binding, so evidence gathered there says nothing about this one.

Trial `D` is the determinism control, and it is required reading for everything
else. **Determinism has never been measured on 2511.** If a held seed does not
reproduce a byte-identical image, part of every arm-to-arm difference belongs to
the sampler rather than to the prompt, and the grading has to be read that much
more conservatively.

### The legacy arm is an open owner ruling

Issue #256 asks for the comparison "against the frozen Stage 0 payload hashes".
But the frozen builder those hashes pin — `buildVariantInstruction`, held by
`prompt-freeze.test.ts` — **has no production caller.** Production ships
`buildVariantSegments(...).prompt`, which is also the legacy side the shadow
measures. So both arms exist and are selectable:

- `--legacy-arm legacy` (**default**) — `buildVariantSegments`, what production
  actually sends. Promoting the binding replaces this string, so this is the
  comparison a cutover decision is about.
- `--legacy-arm frozen` — `buildVariantInstruction`, the Stage 0 string. Answers
  a historical question about a builder nothing calls.

Each arm renders into its own output root, so their grading sheets never
collide. **Whichever arm runs**, `stage0-anchor.json` records the frozen string,
its `fnv1aHex` and its character count for every kind, so a run always states
its relationship to the freeze. Those hashes are taken over this trial's own
fixture; `prompt-freeze.test.ts` remains the canonical Stage 0 record and this
script neither reads nor re-pins it. **Which arm the promotion decision is
actually about is the owner's call, and it is unresolved.**

### Output

Everything lands under `eval-images/variant-prompt-ab/<legacy-arm>/`, local and
untracked (owner ruling 2026-08-28):

- `<kind>/<fixture>-<arm>-s<seed>.webp` — one render per cell, idempotent (an
  existing file is skipped and never re-bought);
- `<kind>/manifest.json` — the executed version id per render, the reviewed base
  controls, and the trial's `block` line carrying the Stage 0 anchor hash;
- `<kind>/sheet-<fixture>-<arm>.webp` — the labeled contact sheet grading reads;
- `scores-<kind>.csv` — the grading sheet, never overwritten once it exists;
- `stage0-anchor.json` — all three prompts per kind with hashes and lengths,
  rewritten every run (it is derived, not graded);
- `README.md` — the run-notes skeleton with a **Verdict: TO BE FILLED** section,
  written once and never overwritten.

Grade one binary per column, blank meaning **ungraded** and never "no":
`identity_face_fidelity`, `requested_change_succeeded`,
`apparent_age_preserved`, `preserved_facts_intact`, `geometry_framing_ok`,
`no_other_regression`, plus free-text `notes`. The columns are derived from the
exported `VARIANT_PROMPT_AB_DIMENSIONS` registry, so the sheet and these docs
cannot drift apart. `--report` prints per-arm rates and no Δ column — the shared
harness computes deltas against an arm named `off`, and these arms are named for
the prompt each one sends.

Two reading notes for the console output: the harness's per-arm line prints
`(bare positive)` for the compiled arm, because that arm carries a whole
positive override rather than a suffix — the authoritative prompts are the three
printed above the trials and recorded in `stage0-anchor.json`. And the trial's
model literal carries empty `advancedCapabilities`; if the deployed 2511 row's
probed record ever declares a measured prompt budget, production's compiled
prompt would be fitted to it and this trial's is not.

Nothing here enters git, so **the verdict has to be written up on issue #256**
or it does not exist.
