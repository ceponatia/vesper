import type { RegionExposure } from "../items/visibility";

/**
 * THE EXPOSURE READ — the one canonical wording of a garment-coverage readout,
 * per region, for every image prompt that states what a body shows.
 *
 * Exposure is a composition read over the coverage readout, not a projected
 * feature: the visual digest deliberately never maps it
 * (`visualImageFactSegmentKind` has no exposure arm), so its words cannot come
 * from a fact table. They come from here. The character image adapter
 * (`character-adapter.ts`) synthesizes its authoritative `subject.exposure`
 * world-digest claims from {@link visualExposureReads}, and every dialect
 * wraps such a value as "<subject> is <value>" — which is why the table carries
 * the predicate-FRAGMENT inflection those claims need beside the standalone
 * clause.
 *
 * The composition rules live here too, so no consumer can restate them
 * differently: covered regions are SILENT (silence IS the covered statement;
 * wardrobe authority says what covers them), and bare legs stay unstated when
 * the pelvis is already bare, per the readout's own contract.
 *
 * Pure by construction: no IO, no registry writes, deterministic over its
 * inputs.
 */

/**
 * The canonical bare/sheer wording per region — one table, so every consumer
 * states exposure identically.
 *
 * Each cell carries the SAME statement in two grammatical inflections, kept
 * adjacent so they cannot drift: `clause` stands alone, and `fragment` is the
 * predicate completing "<subject> is …" — the wrapping every world-digest
 * dialect applies to a `subject.exposure` value, so a complete clause there
 * would compile "Mira is the torso is bare". A fragment therefore never opens
 * with an article-led noun phrase and never carries its own finite verb.
 */
const EXPOSURE_CLAUSES: Readonly<
  Record<keyof RegionExposure, Record<"bare" | "sheer", { clause: string; fragment: string }>>
> = {
  torso: {
    bare: { clause: "the torso is bare", fragment: "bare at the torso" },
    sheer: { clause: "the torso shows through sheer fabric", fragment: "in sheer fabric that shows the torso" },
  },
  pelvis: {
    bare: { clause: "bare below the waist", fragment: "bare below the waist" },
    sheer: { clause: "the hips show through sheer fabric", fragment: "in sheer fabric that shows the hips" },
  },
  legs: {
    bare: { clause: "the legs are bare", fragment: "bare-legged" },
    sheer: { clause: "the legs show through sheer fabric", fragment: "in sheer fabric that shows the legs" },
  },
  feet: {
    bare: { clause: "barefoot", fragment: "barefoot" },
    sheer: { clause: "the feet show through sheer fabric", fragment: "in sheer fabric that shows the feet" },
  },
};

/** One region the readout says something about: which region, how, and the canonical wording. */
export interface VisualExposureRead {
  readonly region: keyof RegionExposure;
  readonly coverage: "bare" | "sheer";
  /** The statement as a standalone clause. */
  readonly clause: string;
  /** The same statement as a predicate completing "<subject> is …" — what a world-digest `subject.exposure` value carries. */
  readonly fragment: string;
}

/**
 * The composition read over the coverage readout, for the regions a consumer
 * frames: covered regions are silent, and bare legs stay unstated when the
 * pelvis is already bare, per the readout's own contract. One function, so no
 * two prompt paths can disagree about what a readout SAYS.
 */
export function visualExposureReads(
  exposure: RegionExposure,
  regions: readonly (keyof RegionExposure)[],
): readonly VisualExposureRead[] {
  const reads: VisualExposureRead[] = [];
  for (const region of regions) {
    const coverage = exposure[region];
    if (coverage === "covered") continue;
    if (region === "legs" && coverage === "bare" && exposure.pelvis === "bare") continue;
    reads.push({ region, coverage, ...EXPOSURE_CLAUSES[region][coverage] });
  }
  return reads;
}
