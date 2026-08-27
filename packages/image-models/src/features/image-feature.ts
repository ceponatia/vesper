import type { ImageModel } from "@vesper/image-core";

/**
 * A SEMANTIC capability a model composes rather than reimplements.
 *
 * A feature is the answer to "what does Vesper want to express here?" — an
 * identity-bearing reference, a reproducible seed, a LoRA — stated once and
 * reused by every family that expresses it. It is deliberately NOT the answer
 * to "which provider field carries it": that is the probed capability record's
 * job, and it stays the record's job for a reason. Field names differ per
 * version (`cfg` on one model, `guidance` on another), and the whole point of
 * the probe is that alias discovery happens ONCE. A feature that carried a
 * field name would be a second, staler copy of the registry row, and the first
 * time a version moved a field the two copies would disagree silently.
 *
 * So every hook here takes the PROBED MODEL RECORD and asks IT. The rule that
 * follows is short and worth stating outright: **a feature never names a
 * provider input field.** It reads `advancedCapabilities`, `supportedAspects`,
 * `outputFormat`, `referenceCapacity(model)` — the record's own vocabulary —
 * and answers in semantic terms.
 *
 * The vocabulary is grown as needed, never enumerated in advance. There is no
 * master list of every capability an image model could conceivably have, and
 * there should not be one: an unused member is an unproven claim, and the
 * registry row is what a render actually travels through.
 */
export interface ImageFeature {
  /**
   * Stable identifier, spelled in the NORMALIZED vocabulary rather than a
   * provider's (`negativePrompt`, never `negative_prompt`). It becomes an entry
   * in the composed adapter's `capabilities`, so renaming one is a public API
   * change, not a tidy-up.
   */
  readonly id: string;
  /** One sentence: what this capability MEANS, in Vesper's terms. */
  readonly semantic: string;
  /**
   * Whether the model's ACTIVE probed version really exposes what this feature
   * needs — the difference between "this family can do LoRAs" (a static family
   * claim, which `capabilities` carries) and "the version this row was probed
   * at has somewhere to put one" (a fact about a row, which only the row knows).
   *
   * Absent means the question has no honest record-derived answer, which is a
   * legitimate state and is documented at each such feature. It never means
   * "always bound" by accident.
   */
  readonly isBound?: (model: ImageModel) => boolean;
  /**
   * Reasons this render may not proceed, in plain English, one string each. An
   * empty result means the feature has nothing to refuse — refusals are the
   * exceptional answer, so an empty array is the normal one.
   *
   * These are PRE-SPEND refusals about the model/request pairing, not the
   * compile step's final-wire invariant, which stays in `@vesper/image-core`
   * where the payload actually exists. A
   * feature answers "this model cannot carry what you are asking for"; the
   * kernel answers "the payload does not carry what the plan claims".
   */
  readonly validate?: (model: ImageModel, request: ImageModelRequestFacts) => readonly string[];
}

/**
 * What one render asks for, in the terms a feature reasons about.
 *
 * Deliberately tiny, and deliberately not `ImageRenderIntent`: the intent is
 * the render's full normalized request and lives in `@vesper/image-core`, while
 * this is the handful of facts a family adapter needs to judge a pairing before
 * anything is planned or spent. It grows only when a feature genuinely cannot
 * answer without a new fact — every field added here is a field every future
 * caller has to be able to supply.
 */
export interface ImageModelRequestFacts {
  /** How many reference images this render intends to send. */
  readonly referenceCount: number;
  /** Whether this render carries a LoRA at all. Which one is the library's business. */
  readonly usesLora: boolean;
}
