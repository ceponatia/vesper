# Prompt-program eval

Paid, manually run trials for the prompt-program layer
(`packages/image-core/src/prompt-program/`). Not a `pnpm test` gate — every
question here is answered by looking at a picture.

## `entity-negative-ab.ts`

The Stage 6 trial for Qwen Image 2512's negative transport. The item and
location lanes already compile guarded exclusions and record a transport
decision for each; what is missing is evidence that **sending** them beats not
sending them on this endpoint.

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

Grade `scores.csv` by eye, then promote only the two or three renders the verdict
rests on into `evidence/` — see `evidence/README.md`.

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
