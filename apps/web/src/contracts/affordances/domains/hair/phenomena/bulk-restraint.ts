import { defineAffordancePhenomenon, type AffordanceResolution } from "../../../core";
import { HAIR_LOCATION_ID, type HairAffordanceFrame } from "../frame";
import { hairSuppressed, HAIR_NO_RESTRAINT } from "./bands";
import { hairBulkRestraint } from "./restraint";

/**
 * `hair.bulk_restraint` — what is currently holding this hair's bulk still
 * (narrator-physical-guidance.plan.md slice 2).
 *
 * The first phenomenon in the corpus that emits a **constraint** rather than an
 * observation, and the reason is the whole point of the constraint-first policy: a
 * braid is a braid in still air. `hair.wind_or_motion_response` already computes
 * the same restraint, but only ever as a reason for its own silence — so with no
 * wind and no motion the fact that the hair is bound was known to the domain and
 * reached nobody. A narrator told nothing about it is free to write hair streaming
 * loose over a committed braid, which is exactly the contradiction class the trial
 * measured.
 *
 * Three properties follow from that framing:
 *
 * - **Independent of any current force.** No `wind`/`motion` dependency, and no
 *   force term in the resolve — the restraint is a property of how the hair is
 *   worn and what it weighs, both of which are structural to this domain. So this
 *   resolution is present on every cut the domain can read at all.
 * - **It says only what is holding the bulk, never what to describe.** The
 *   constraint carries a bare domain code (`pinned`, `bound`, `covered`,
 *   `water_loaded`); which narrator claims that code forbids is the claim
 *   lexicon's job (`../claims.ts`), and the wording is the lane renderer's.
 * - **Nothing holding it is an explicit silence,** not an absent resolution: loose,
 *   uncovered, dry-enough hair really is free to move, and `no_restraint` is that
 *   answer rather than a gap a reader has to interpret.
 *
 * The gate arithmetic is deliberately NOT duplicated here — `restraint.ts` owns it
 * and the wind/motion phenomenon reads the identical function, so the two can never
 * drift into disagreeing about whether a ponytail counts as bound.
 */

export const HAIR_BULK_RESTRAINT_ID = "hair.bulk_restraint";

type BulkRestraintInput = Pick<HairAffordanceFrame, "mechanics" | "presentation">;

export const hairBulkRestraintPhenomenon = defineAffordancePhenomenon<HairAffordanceFrame, BulkRestraintInput>({
  id: HAIR_BULK_RESTRAINT_ID,
  // No lane dependency at all: arrangement, coverage, and wetness are STRUCTURAL to
  // the hair domain (`domain.ts` header), so if the domain resolved, this can.
  dependencies: [],
  selectInput: (frame) => ({ mechanics: frame.mechanics, presentation: frame.presentation }),
  resolve: (input): AffordanceResolution => {
    const code = hairBulkRestraint(input);
    if (code === null) return hairSuppressed(HAIR_BULK_RESTRAINT_ID, HAIR_NO_RESTRAINT);
    return { kind: "constraint", id: HAIR_BULK_RESTRAINT_ID, code, locationId: HAIR_LOCATION_ID };
  },
});
