import { fnv1aHex } from "@vesper/contracts";
import { z } from "zod";
import { imageProfileTaskSchema, imagePromptStrategySchema } from "../models/image-model-profiles";
import { stableJson } from "../render-kernel/stable-json";
import { imageConceptIds, type ImageConceptId } from "./concepts";
import { imagePromptDialectIds } from "./dialects";
import { imageNegativeBlockIds, type ImageNegativeBlockId } from "./negative-constraints";

/**
 * Prompt packs: the versioned, promotable, rollback-able DATA half of the prompt
 * system (model-aware-image-prompts.plan.md §"Prompt-pack management").
 *
 * Positive and negative are separate products with separate identities,
 * versions, evidence and promotion history — that is the plan's central claim
 * and this module is where it becomes structural. What holds them together is a
 * BINDING: one profile pins one positive version and one negative version, and a
 * render resolves the pair atomically, so promoting only the negative side
 * creates a new binding that reuses the old positive version rather than letting
 * a render observe half an activation.
 *
 * The split between what lives here and what lives in code is a security ruling
 * as much as an engineering one. A manifest may say WHICH named blocks are on,
 * in what order, at what priority, and which reviewed wording variant to use. It
 * may not contain executable JavaScript, a condition expression, or a
 * whole-prompt template — otherwise an admin text field becomes a path to
 * production prompt logic that no test has seen.
 *
 * Storage is deliberately not decided here. These are the contracts a database
 * row must satisfy, and the seeded registry below is the code-owned,
 * version-pinned source the first endpoint runs from. The plan's own degradation
 * rule allows exactly that: a code fallback is legitimate when it is byte-
 * identical to a known active version, and a code-owned pack IS its own known
 * active version until a table exists to promote a different one.
 */

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Confidence ladder from the research doc's evidence policy. `anecdotal` and
 * `hypothesis` may justify a TRIAL; only a trial verdict or authoritative
 * endpoint evidence may justify a promotion.
 */
export const imagePromptEvidenceConfidences = ["authoritative", "strong", "hypothesis", "anecdotal"] as const;
export const imagePromptEvidenceSourceTypes = [
  "official_model",
  "official_endpoint",
  "provider_guide",
  "community_guide",
  "reddit",
  "vesper_trial",
] as const;

export const imagePromptEvidenceSchema = z.object({
  id: z.string().min(1),
  sourceType: z.enum(imagePromptEvidenceSourceTypes),
  url: z.string().optional(),
  /** ISO date the source was last read. Review expiry is measured from it. */
  reviewedAt: z.string().min(1),
  modelSlug: z.string().min(1),
  versionId: z.string().optional(),
  claim: z.string().min(1),
  confidence: z.enum(imagePromptEvidenceConfidences),
});
export type ImagePromptEvidence = z.infer<typeof imagePromptEvidenceSchema>;

/** Whether this evidence may satisfy a promotion gate on its own. */
export function isPromotableImagePromptEvidence(evidence: ImagePromptEvidence): boolean {
  if (evidence.sourceType === "vesper_trial") return true;
  return evidence.confidence === "authoritative" && evidence.sourceType !== "reddit";
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

const conceptIdSchema = z.enum(imageConceptIds);
const blockIdSchema = z.enum(imageNegativeBlockIds);

/**
 * What a POSITIVE pack decides.
 *
 * Not "the prompt". The prompt is compiled from world facts through a dialect;
 * a positive pack only shapes that compile at the edges — which concepts this
 * endpoint has no useful wording for, which ones deserve a stronger claim on the
 * budget here than elsewhere, which reviewed wording variant the dialect should
 * speak, and what rendering intent to add when the operation named none.
 *
 * `suppressedConcepts` is the one that needs a warning attached: suppressing a
 * concept whose claims are MANDATORY does not silently shrink the prompt, it
 * refuses the render. That is intended — an endpoint that cannot express an
 * identity anchor is an endpoint that should not be rendering identity-critical
 * work — and the compile step reports it as a refusal rather than a trim.
 */
export const imagePositivePackManifestSchema = z.object({
  version: z.literal(1),
  suppressedConcepts: z.array(conceptIdSchema).default((): ImageConceptId[] => []),
  priorityAdjustments: z.partialRecord(conceptIdSchema, z.number()).default(() => ({})),
  /** A key the dialect resolves to one of its reviewed wordings. Never free text. */
  wordingVariant: z.string().min(1).default("default"),
  /**
   * Rendering-intent descriptors contributed when the operation states none.
   *
   * Free strings, and the one place a pack contributes wording — but they enter
   * as `style.descriptor` CLAIMS, so they are ordered, fitted and collision-
   * checked exactly like world facts. A descriptor that contradicted an
   * exclusion would be caught by the same linter that catches a world fact.
   */
  renderingIntent: z.array(z.string().min(1)).default((): string[] => []),
});
export type ImagePositivePackManifest = z.infer<typeof imagePositivePackManifestSchema>;

/** What a NEGATIVE pack decides: which guarded blocks are on, and how hard. */
export const imageNegativePackManifestSchema = z.object({
  version: z.literal(1),
  enabledBlockIds: z.array(blockIdSchema).default((): ImageNegativeBlockId[] => []),
  priorityOverrides: z.partialRecord(blockIdSchema, z.number()).default(() => ({})),
  evidenceIds: z.partialRecord(blockIdSchema, z.array(z.string().min(1))).default(() => ({})),
  wordingVariant: z.string().min(1).default("default"),
});
export type ImageNegativePackManifest = z.infer<typeof imageNegativePackManifestSchema>;

// ---------------------------------------------------------------------------
// Pack versions and bindings
// ---------------------------------------------------------------------------

export const imagePromptPackChannels = ["positive", "negative"] as const;
export type ImagePromptPackChannel = (typeof imagePromptPackChannels)[number];

export const imagePromptPackStatuses = ["candidate", "active", "retired"] as const;
export type ImagePromptPackStatus = (typeof imagePromptPackStatuses)[number];

const dialectIdSchema = z.enum(imagePromptDialectIds);

/**
 * One immutable pack version.
 *
 * Immutable is the load-bearing word: a promotion creates a new row and a
 * rollback activates a prior one. Nothing edits a version in place, because a
 * stored render's provenance names a version id and that name has to keep meaning
 * what it meant when the image was made.
 */
export const imagePromptPackVersionSchema = z.object({
  id: z.string().min(1),
  packId: z.string().min(1),
  channel: z.enum(imagePromptPackChannels),
  slug: z.string().min(1),
  version: z.number().int().positive(),
  dialectId: dialectIdSchema,
  /** Parsed per channel by `parseImagePromptPackManifest`; unknown shape until then. */
  manifest: z.unknown(),
  contentHash: z.string().min(1),
  status: z.enum(imagePromptPackStatuses),
  evidence: z.array(imagePromptEvidenceSchema).default((): ImagePromptEvidence[] => []),
  supersedesVersionId: z.string().nullable().default(null),
});
export type ImagePromptPackVersionRow = z.infer<typeof imagePromptPackVersionSchema>;

/** A pack version with its manifest already parsed to the channel's shape. */
export interface ImagePromptPackVersion<TManifest> extends Omit<ImagePromptPackVersionRow, "manifest" | "evidence"> {
  readonly manifest: TManifest;
  readonly evidence: readonly ImagePromptEvidence[];
}

export type ImagePositivePackVersion = ImagePromptPackVersion<ImagePositivePackManifest>;
export type ImageNegativePackVersion = ImagePromptPackVersion<ImageNegativePackManifest>;

/**
 * The pair a render resolves: one profile, one dialect, one positive version,
 * one negative version.
 *
 * `versionId` pins a provider version. An endpoint version may bind a different
 * pack from the floating model row, which is the plan's rule that a provider
 * schema update never silently inherits an untested pack.
 */
export const imagePromptProfileBindingSchema = z.object({
  id: z.string().min(1),
  /**
   * The profile's stable KEY (`item-standard`), not its database id.
   *
   * A key rather than an id because a binding has to be expressible in code
   * before any table exists to hold one, and a code-owned seed cannot know a row
   * id that a migration will generate. The key is the same value the render
   * fingerprint already uses to identify a profile, so nothing is lost.
   */
  profileKey: z.string().min(1),
  /** The database ids, once bindings are stored beside the profile rows. */
  profileId: z.string().nullable().default(null),
  modelId: z.string().nullable().default(null),
  modelSlug: z.string().min(1),
  versionId: z.string().nullable().default(null),
  task: imageProfileTaskSchema,
  promptStrategy: imagePromptStrategySchema,
  promptDialectId: dialectIdSchema,
  positivePackVersionId: z.string().min(1),
  negativePackVersionId: z.string().min(1),
  status: z.enum(imagePromptPackStatuses),
});
export type ImagePromptProfileBinding = z.infer<typeof imagePromptProfileBindingSchema>;

/**
 * A pack version's content hash: the manifest, deterministically.
 *
 * Over the manifest ALONE — not the id, status or evidence — because the hash
 * answers "is this the same prompt behavior?", and a candidate promoted to active
 * is byte-identical behavior under a new status. Two independently-authored
 * versions that hash alike are genuinely the same pack, which is what makes the
 * plan's code-fallback rule ("only when byte-identical to a known active
 * version") checkable rather than a promise.
 */
export function imagePromptPackContentHash(manifest: unknown): string {
  return fnv1aHex(stableJson(manifest));
}

/** Parse a stored positive manifest, or null when it does not satisfy the contract. */
export function parseImagePositivePackManifest(value: unknown): ImagePositivePackManifest | null {
  const parsed = imagePositivePackManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse a stored negative manifest, or null when it does not satisfy the contract. */
export function parseImageNegativePackManifest(value: unknown): ImageNegativePackManifest | null {
  const parsed = imageNegativePackManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// The code-owned registry
// ---------------------------------------------------------------------------

const positivePacks = new Map<string, ImagePositivePackVersion>();
const negativePacks = new Map<string, ImageNegativePackVersion>();
const bindings: ImagePromptProfileBinding[] = [];

/** Register a positive pack version. Called once per pack module at import time. */
export function registerImagePositivePack(version: ImagePositivePackVersion): void {
  positivePacks.set(version.id, version);
}

/** Register a negative pack version. */
export function registerImageNegativePack(version: ImageNegativePackVersion): void {
  negativePacks.set(version.id, version);
}

/** Register a profile binding. */
export function registerImagePromptBinding(binding: ImagePromptProfileBinding): void {
  bindings.push(binding);
}

export function imagePositivePack(id: string): ImagePositivePackVersion | null {
  return positivePacks.get(id) ?? null;
}

export function imageNegativePack(id: string): ImageNegativePackVersion | null {
  return negativePacks.get(id) ?? null;
}

/**
 * The active binding for one endpoint and task, or null when this lane has not
 * been cut over.
 *
 * Null is the ORDINARY answer during a staged rollout, not an error: a lane with
 * no binding keeps its existing prompt path, which is what lets the plan's
 * "cut over one endpoint/task lane at a time" happen without a flag. A version-
 * pinned binding wins over a floating one for the same pair, because a pin exists
 * precisely to say "this version behaves differently".
 */
export function activeImagePromptBinding(query: {
  readonly modelSlug: string;
  readonly task: string;
  readonly versionId?: string | null;
}): ImagePromptProfileBinding | null {
  const candidates = bindings.filter(
    (binding) =>
      binding.status === "active" && binding.modelSlug === query.modelSlug && binding.task === query.task,
  );
  const pinned = query.versionId
    ? candidates.find((binding) => binding.versionId === query.versionId)
    : undefined;
  return pinned ?? candidates.find((binding) => binding.versionId === null) ?? null;
}

/** Every registered binding, for admin surfaces and coverage tests. */
export function registeredImagePromptBindings(): readonly ImagePromptProfileBinding[] {
  return [...bindings];
}
