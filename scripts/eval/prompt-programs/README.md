# Prompt-program eval

Paid, manually run trials for the prompt-program layer
(`packages/image-core/src/prompt-program/`). Not a `pnpm test` gate — every
question here is answered by looking at a picture.

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

Renders land in `screenshots/qwen-negative-blocks/<trial>/`, one file per
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

Paid. Renders both arms per case into `screenshots/entity-negative-ab/`.
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
