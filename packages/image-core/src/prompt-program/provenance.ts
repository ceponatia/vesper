import { z } from "zod";
import { sceneStagingSurfaceProvenanceSchema, type SceneStagingSurfaceProvenance } from "../scene-ir";
import { imageNegativeBlockIds } from "./negative-constraints";

/**
 * What a render STORES about the prompt program it ran.
 *
 * Two rules shape everything below.
 *
 * **Identifiers and fingerprints, never copies of the world.** A stored image
 * must not carry a snapshot of the character, the location or the item — that
 * would be a second, silently-diverging copy of canonical truth living in image
 * metadata forever. It carries source revisions and selected fact KEYS instead,
 * so a developer inspector can resolve the current definitions and say plainly
 * when they no longer match the revision this render used.
 *
 * **Enough to answer "why did the image look like that".** Which packs were
 * active, which claims survived fitting, which exclusions were dropped and
 * because of what, where each surviving exclusion travelled, and what the
 * provider added on its own. Without the drop reasons in particular, a negative
 * pack that silently stopped applying looks exactly like a pack that is working.
 *
 * The record sits under `meta.promptProgram`, beside the existing `meta.render`
 * (provider attempt) and `meta.visualState` (character provenance) keys, with
 * `meta.worldState` carrying the read token and source revisions.
 */

export const IMAGE_PROMPT_PROGRAM_META_KEY = "promptProgram";
export const IMAGE_WORLD_STATE_META_KEY = "worldState";

const blockIdSchema = z.enum(imageNegativeBlockIds);

/** One exclusion's fate, flattened for storage. */
export const imageNegativeOutcomeRecordSchema = z.object({
  constraintId: blockIdSchema,
  /** `dedicated_field`, `inline_instruction`, `positive_replacement` or `dropped`. */
  transport: z.string().min(1),
  /** Why it was dropped, when it was. */
  reason: z.string().optional(),
  /** Conflict keys that survived linting. */
  keptKeys: z.array(z.string()).default((): string[] => []),
  /** Keys the world protected, and the claim that protected each. */
  removedKeys: z
    .array(z.object({ key: z.string(), claimId: z.string() }))
    .default((): { key: string; claimId: string }[] => []),
});
export type ImageNegativeOutcomeRecord = z.infer<typeof imageNegativeOutcomeRecordSchema>;

/**
 * The world side: which read this render used and what it read.
 *
 * Stored apart from the prompt program because the two answer different
 * questions and have different lifetimes. "Was this the same world?" survives a
 * pack promotion; "which pack said that?" does not.
 */
export const imageWorldStateProvenanceSchema = z.object({
  version: z.literal(1),
  readKind: z.string().min(1),
  readToken: z.string().min(1),
  atMinutes: z.number().optional(),
  worldFingerprint: z.string().min(1),
  subjectRefs: z.array(z.string()).default((): string[] => []),
  locationRef: z.string().nullable().default(null),
  itemRefs: z.array(z.string()).default((): string[] => []),
  /** Selected fact keys — what the prompt actually drew on, not every field read. */
  factKeys: z.array(z.string()).default((): string[] => []),
  sourceRevisions: z
    .array(z.object({ owner: z.string(), entityId: z.string(), revision: z.string() }))
    .default((): { owner: string; entityId: string; revision: string }[] => []),
  suppressions: z
    .array(z.object({ key: z.string(), owner: z.string(), reason: z.string() }))
    .default((): { key: string; owner: string; reason: string }[] => []),
});
export type ImageWorldStateProvenance = z.infer<typeof imageWorldStateProvenanceSchema>;

/** The prompt side: which packs, which dialect, and what the compile decided. */
export const imagePromptProgramProvenanceSchema = z.object({
  version: z.literal(1),
  programFingerprint: z.string().min(1),
  worldFingerprint: z.string().min(1),
  bindingVersionId: z.string().min(1),
  positivePackVersionId: z.string().min(1),
  negativePackVersionId: z.string().min(1),
  promptDialectId: z.string().min(1),
  promptStrategy: z.string().min(1),
  task: z.string().min(1),
  modelSlug: z.string().min(1),
  /** The version the binding pinned, when it pinned one. */
  pinnedVersionId: z.string().nullable().default(null),
  /** Claims that reached the compiled prompt, in emission order. */
  positiveClaimIds: z.array(z.string()).default((): string[] => []),
  /** Claims a budget squeeze or an unrenderable concept removed. */
  droppedClaimIds: z.array(z.string()).default((): string[] => []),
  /**
   * Which endpoint kept the registry's measured staging wording, and which wrote its own.
   *
   * A staging revision names a sentence that was tuned on renders, so the measurements
   * behind `on_all_fours@3` are facts about images that contained those exact bytes. Half
   * the endpoints do not send them. Without this list every render looks like it used the
   * measured wording, and the next tuning round reasons from images that never had it.
   *
   * One entry per SURVIVING staging claim: a claim named in {@link droppedClaimIds} carries
   * no entry here, because it produced no wording to have a disposition about. The compile
   * fills both lists from one pass so they cannot disagree.
   */
  sceneStagingSurfaces: z
    .array(sceneStagingSurfaceProvenanceSchema)
    .default((): SceneStagingSurfaceProvenance[] => []),
  negativeOutcomes: z.array(imageNegativeOutcomeRecordSchema).default((): ImageNegativeOutcomeRecord[] => []),
  /** Provider-contributed prompt channels, declared by the dialect. */
  hiddenPromptSources: z
    .array(z.object({ kind: z.string(), field: z.string(), overridable: z.boolean(), value: z.string().optional() }))
    .default((): { kind: string; field: string; overridable: boolean; value?: string }[] => []),
  /**
   * Hashes of what was sent, not the text itself.
   *
   * The compiled text may also be stored where retention and access policy
   * permit it, but a hash is what makes "did this render send the same prompt as
   * that one" answerable regardless of whether the text was retained.
   */
  positivePromptHash: z.string().min(1),
  negativePromptHash: z.string().nullable().default(null),
  /** Final reference bindings, after planning and capacity trimming. */
  references: z
    .array(z.object({ position: z.number().int().positive(), role: z.string(), subjectRef: z.string().optional() }))
    .default((): { position: number; role: string; subjectRef?: string }[] => []),
});
export type ImagePromptProgramProvenance = z.infer<typeof imagePromptProgramProvenanceSchema>;

/**
 * Parse a stored record defensively, returning null on anything unexpected.
 *
 * Image metadata is a trust boundary like any other (docs/resilience.md §1): the
 * rows are years old, written by code that has since changed, and a gallery
 * inspector must degrade to "no prompt provenance" rather than throwing at a
 * reader.
 */
export function parseImagePromptProgramProvenance(value: unknown): ImagePromptProgramProvenance | null {
  const parsed = imagePromptProgramProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse a stored world-state record defensively. */
export function parseImageWorldStateProvenance(value: unknown): ImageWorldStateProvenance | null {
  const parsed = imageWorldStateProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
