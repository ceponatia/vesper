# The ghost-mannequin defect and its fix

Evidence for the item lane's clothing-presentation rewording
(model-aware-image-prompts.trial.qwen-2512-negative.md, Trial B).

**The defect.** The shipped wording said "presented on an invisible ghost
mannequin, holding the garment's own shape". "Ghost mannequin" is the industry
term for exactly this shot, and naming it put a plainly visible dress form in the
picture. "Invisible" subtracted nothing.

**The fix.** Wording that names no support at all: "hanging in its own shape with
nothing else in the frame, the garment alone".

| Sheet                             | Wording        | Support visible |
| --------------------------------- | -------------- | --------------- |
| `scarf-production-wording.webp`   | shipped        | 6/6             |
| `scarf-new-wording.webp`          | replacement    | 0/6             |
| `coat-production-wording.webp`    | shipped        | 6/6             |
| `coat-new-wording.webp`           | replacement    | 0/6             |
| `coat-inline-arm.webp`            | "do not include a mannequin…" | 1/6 (s103, a stand below the hem) |

Same six seeds across every arm, no negative field anywhere — this endpoint
ignores it. Collateral clean: scarf translucency 6/6 in every arm, coat shape and
authored scorched cuffs 6/6 in every arm.

The inline sheet is kept because it is the argument against inline exclusions:
the only non-shipped render that grew a support is the one whose prompt named
one. Per-seed grading in the two CSVs.
