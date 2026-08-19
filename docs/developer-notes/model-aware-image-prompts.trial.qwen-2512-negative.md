# Qwen Image 2512 — negative-prompt block trials

Status: in progress — trials rendering and being graded (2026-08-19)

Companion to [model-aware-image-prompts.plan.md](model-aware-image-prompts.plan.md) §"Stage 6";
instrument: `scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts`.

## What is being decided

Whether Qwen Image 2512's dedicated `negative_prompt` field is worth sending for
the item and location lanes, block by block — not as one global yes or no. Each
negative block gets its own verdict against the failure it exists to suppress:

- **helpful** — a repeatable reduction in the named failure without an
  unacceptable rise in collateral damage;
- **neutral** — the failure occurred in the no-negative arm and the block did
  not move it;
- **harmful** — the block damaged legitimate content;
- **inconclusive** — the failure never appeared in the no-negative arm, so the
  block was never actually tested.

The first production-pack A/B (2026-08-19, one seed per cell) is recorded as
harness verification only; its renders live in `evidence/entity-negative-ab-r1/`.

## Method

Paired seed sets (8–10 per arm, identical across arms), one negative block per
comparison, everything else held constant. Positives are neutral — they never
name the thing the negative is meant to suppress. Primary metrics are binary
facts; subjective quality is collateral. A near-zero failure rate in the
no-negative arm makes a cell inconclusive rather than neutral.

## Results

Pending grading. The matrix below fills in as trials complete.

| Trial | Fixture     | Block under test           | Verdict | Note    |
| ----- | ----------- | -------------------------- | ------- | ------- |
| A     | apple + mug | transport canary           | pending | —       |
| B1    | scarf       | support suppression        | pending | —       |
| B2    | coat        | support suppression        | pending | —       |
| C     | storefront  | generated text             | pending | —       |
| D     | ALDWIN sign | broad vs narrow text       | pending | —       |
| E     | compass     | broad vs narrow text       | pending | —       |
| F     | glove/boot  | extra objects              | pending | —       |
| G     | cane/umbrella | composition              | pending | —       |
| H     | interior    | generated text             | pending | —       |
| I     | poster      | watermark/signature        | pending | —       |

## What stays owner-gated

- the production pack's wording changes, which follow this matrix;
- Trial J (the combined candidate pack over a representative suite, on the
  `entity-negative-ab.ts` harness) — it runs only after the matrix is reviewed
  and the candidate pack revised;
- probing/activating the Qwen 2512 version, which also switches on the portrait
  profiles' inert `steps`/`go_fast` settings.
