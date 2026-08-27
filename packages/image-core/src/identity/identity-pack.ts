import { z } from "zod";
import type { DiagnosticSink } from "@vesper/contracts";

/**
 * The identity-pack vocabulary and contracts.
 *
 * An identity pack is the record of WHICH bytes a character's face reference was
 * derived from, HOW it was cropped, and WHAT was measured about it. Everything
 * here is data and vocabulary: no geometry (that is `packages/image-core/src/identity/identity-pack-crop.ts`),
 * no thresholds (`packages/image-core/src/identity/identity-pack-policy.ts`), no persistence
 * (`src/server/images/identity-pack-*.ts`).
 *
 * Two rules shape every schema below:
 *
 * 1. **Null is "not measured"; zero is a measurement.** A face area ratio of 0,
 *    a blur score of 0, and 0 detected faces are all real observations that must
 *    survive a round trip. No optional metric may carry a numeric default, and no
 *    coercion may fold 0 into a fallback — a policy change re-evaluates STORED
 *    measurements, so a zero that was quietly rewritten as "unknown" (or an
 *    unknown quietly rewritten as 0) silently changes an old verdict.
 * 2. **A malformed row degrades, it never throws.** JSON read paths run through
 *    `parseOr` (docs/resilience.md §1); a crop or quality object that fails these
 *    schemas produces an unusable pack and a diagnostic, never an exception in a
 *    render route.
 *
 * The `IdentityFaceDetector` seam is deliberately NOT here: its `detect()` takes
 * a Node `Buffer`, and nothing in `src/contracts` references binary/platform
 * types. It lives with its only implementation, in
 * `packages/image-core/src/identity/identity-pack-detector.ts`. The detector's OUTPUT shape
 * (`DetectedFaceCandidate`) is plain numbers, so it stays in this module where
 * the pure candidate-ruling helpers can read it.
 */

/**
 * A revision's lifecycle position. "Current" means "the authoritative pack state
 * for the canonical source", not "successful" — a current row may be `unusable`
 * or `failed`, and that is exactly what stops a render lane from silently
 * re-deriving on every request.
 *
 * `schema.ts` imports this tuple for its `text(..., { enum })` column, so the
 * column and the parser cannot drift (the `imageProfileTasks` precedent).
 */
export const imageIdentityPackStatuses = [
  "pending",
  "ready",
  "unusable",
  "failed",
  "stale",
  "superseded",
] as const;
export const imageIdentityPackStatusSchema = z.enum(imageIdentityPackStatuses);
export type ImageIdentityPackStatus = (typeof imageIdentityPackStatuses)[number];

/**
 * How a revision's crop rectangle was chosen. `detector` is a face-box expansion,
 * `heuristic` is the deterministic portrait fallback, `manual` is a human crop.
 * Null (column-level) means the revision never got as far as a rectangle.
 */
export const imageIdentityCropMethods = ["detector", "heuristic", "manual"] as const;
export const imageIdentityCropMethodSchema = z.enum(imageIdentityCropMethods);
export type ImageIdentityCropMethod = (typeof imageIdentityCropMethods)[number];

/**
 * Reasons a pack is usable but imperfect. Warnings travel with a `ready` pack and
 * into render provenance; they never block on their own. Human-readable copy is
 * produced at the UI boundary so the stored logic depends only on stable codes.
 */
export const imageIdentityPackWarningCodes = [
  "heuristic_crop",
  "mild_blur",
  "partial_occlusion",
  "tight_hairline_padding",
  "tight_jaw_padding",
  "small_effective_face",
  "manual_admin_override",
] as const;
export const imageIdentityPackWarningCodeSchema = z.enum(imageIdentityPackWarningCodes);
export type ImageIdentityPackWarningCode = (typeof imageIdentityPackWarningCodes)[number];

/**
 * Reasons a revision is terminally `unusable` or `failed`. These decide retry
 * eligibility: read/decode/write failures are retryable, `ambiguous_faces` and
 * `crop_too_small` are not until the source, policy, detector version, or user
 * crop changes.
 */
export const imageIdentityPackFailureCodes = [
  "source_missing",
  "source_not_ready",
  "source_unreadable",
  "source_changed",
  "no_usable_face",
  "ambiguous_faces",
  "invalid_crop",
  "crop_too_small",
  "crop_write_failed",
  "derivation_failed",
] as const;
export const imageIdentityPackFailureCodeSchema = z.enum(imageIdentityPackFailureCodes);
export type ImageIdentityPackFailureCode = (typeof imageIdentityPackFailureCodes)[number];

/**
 * Degraded-safe warning list for the `warning_codes_json` column: a malformed
 * value parses to `[]` rather than failing the whole pack read. The fallback is a
 * thunk because zod hands a literal default/catch value through WITHOUT cloning,
 * which would make one array shared by every parsed row.
 */
export const imageIdentityPackWarningCodeListSchema = z
  .array(imageIdentityPackWarningCodeSchema)
  .catch((): ImageIdentityPackWarningCode[] => []);

/**
 * Whether a status change is one the state machine allows.
 *
 * The exhaustive switch is the point: adding a status to the tuple above makes
 * this a lint error until someone decides what it may become. `stale` and
 * `superseded` are terminal — a retry or correction creates a NEW revision so the
 * old attempt stays diagnosable, which is why nothing transitions out of them.
 */
export function isAllowedIdentityPackTransition(
  from: ImageIdentityPackStatus,
  to: ImageIdentityPackStatus,
): boolean {
  switch (from) {
    case "pending":
      return to === "ready" || to === "unusable" || to === "failed" || to === "stale";
    case "ready":
    case "unusable":
    case "failed":
      return to === "stale" || to === "superseded";
    case "stale":
    case "superseded":
      return false;
  }
}

/**
 * A rectangle in INTEGER source-image pixels, in the stored orientation. Clients
 * may submit normalized coordinates, but the server resolves and persists source
 * pixels: a normalized rectangle silently means something different the moment the
 * source is re-encoded at another size.
 *
 * `left`/`top` allow 0 (a crop flush against the source edge is legal); the sides
 * do not, because a zero-area rectangle is a malformed crop, not a measurement.
 */
export const sourcePixelCropSchema = z.object({
  left: z.number().int().min(0),
  top: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type SourcePixelCrop = z.infer<typeof sourcePixelCropSchema>;

/**
 * What was MEASURED about a revision — never what was decided about it.
 *
 * `quality.accepted` deliberately does not exist: a stored verdict would freeze
 * one policy version's judgment into the row, and the whole reason measurements
 * are persisted is so a threshold change can re-evaluate old packs without
 * rerunning a detector over every portrait.
 *
 * Every metric is nullable and none carries a numeric default. `detectedFaces: 0`
 * ("the detector ran and found nothing") and `detectedFaces: null` ("no detector
 * observation exists") are different facts and must stay different after parsing.
 * `padding` may legitimately be negative if a face box escapes its crop — that is
 * diagnostic evidence, so it is not clamped away here.
 */
export const imageIdentityPackQualitySchema = z.object({
  /** Which blur algorithm produced `blurScore`. The raw score is meaningless without it. */
  algorithmVersion: z.string().min(1),
  detectedFaces: z.number().int().min(0).nullable(),
  faceBox: sourcePixelCropSchema.nullable(),
  faceWidthPx: z.number().int().nullable(),
  faceHeightPx: z.number().int().nullable(),
  /** Face area as a fraction of the CROP area, not of the source. */
  faceAreaRatio: z.number().nullable(),
  /** Variance-of-Laplacian style score: LOWER is blurrier. */
  blurScore: z.number().nullable(),
  /** Detector-supplied where available: HIGHER is more occluded. */
  occlusionScore: z.number().nullable(),
  /** Distance from each face-box edge to the corresponding crop edge, in source pixels. */
  padding: z.object({
    topPx: z.number().int().nullable(),
    rightPx: z.number().int().nullable(),
    bottomPx: z.number().int().nullable(),
    leftPx: z.number().int().nullable(),
  }),
});
export type ImageIdentityPackQuality = z.infer<typeof imageIdentityPackQualitySchema>;

/**
 * The parsed application contract for one pack revision, versioned independently
 * of the database row so a column rename is not a contract change.
 *
 * The three versions inside `derivation` mean different things and are not
 * interchangeable: `schemaVersion` changes when THIS shape changes,
 * `derivationVersion` when the crop bytes would come out different, and
 * `policyVersion` when the same stored measurements would be judged differently.
 * Only a `derivationVersion` change invalidates an existing crop.
 */
export const imageIdentityPackV1Schema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  characterId: z.string().min(1),
  /** 1-based and monotonic per character; a retry or manual fix takes the next number. */
  revision: z.number().int().min(1),
  current: z.boolean(),
  status: imageIdentityPackStatusSchema,

  source: z.object({
    /** Nullable because the image FK is a `set null` safety net — a pack whose
     * source vanished is immediately unusable, never silently reused. */
    imageId: z.string().min(1).nullable(),
    /** SHA-256 over the STORED normalized bytes, so it names the exact input every
     * later crop reads. A byte-level change invalidates the pack even when the new
     * portrait looks identical. */
    contentHash: z.string().min(1),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),

  derivation: z.object({
    schemaVersion: z.literal(1),
    derivationVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    method: imageIdentityCropMethodSchema.nullable(),
    /** Null on heuristic and manual revisions — there was no detector to name. */
    detectorVersion: z.string().min(1).nullable(),
    /** Unbounded on purpose: detector scales differ, and clamping a valid score to
     * a guessed range would degrade a perfectly good row at parse time. */
    confidence: z.number().nullable(),
    createdAt: z.string().min(1),
  }),

  faceDetail: z.object({
    imageId: z.string().min(1).nullable(),
    crop: sourcePixelCropSchema.nullable(),
    /** ACTUAL encoded output size, which is the crop side capped by the storage
     * ceiling — not the requested crop side. */
    outputWidth: z.number().int().min(1).nullable(),
    outputHeight: z.number().int().min(1).nullable(),
  }),

  quality: imageIdentityPackQualitySchema.nullable(),
  warningCodes: z
    .array(imageIdentityPackWarningCodeSchema)
    .default((): ImageIdentityPackWarningCode[] => []),
  failureCode: imageIdentityPackFailureCodeSchema.nullable(),

  review: z.object({
    actorUserId: z.string().min(1).nullable(),
    reason: z.string().nullable(),
    reviewedAt: z.string().nullable(),
  }),
});
export type ImageIdentityPackV1 = z.infer<typeof imageIdentityPackV1Schema>;

/** Why a caller wants a pack. `identity_render` waits for bounded local derivation;
 * `background` may return after reserving work; `admin_trial` is the trial surface. */
export const identityPackPurposes = ["background", "identity_render", "admin_trial"] as const;
export const identityPackPurposeSchema = z.enum(identityPackPurposes);
export type IdentityPackPurpose = (typeof identityPackPurposes)[number];

/**
 * The idempotent server entry point's result. `blocked` is an EXPECTED outcome
 * carrying an actionable code, not an error: an unusable pack must reach the UI as
 * product feedback ("use a clearer portrait", "crop it yourself") and must stop the
 * render before any provider budget is charged.
 */
export type EnsureIdentityPackResult =
  | {
      status: "ready";
      pack: ImageIdentityPackV1;
      warnings: ImageIdentityPackWarningCode[];
    }
  | {
      status: "blocked";
      pack: ImageIdentityPackV1 | null;
      code: ImageIdentityPackFailureCode;
      retryable: boolean;
    };

export interface EnsureIdentityPackInput {
  ownerId: string;
  characterId: string;
  purpose: IdentityPackPurpose;
  sink?: DiagnosticSink;
}

/**
 * One detector observation. The adapter reports what it saw and makes NO product
 * decision — picking a face out of a multi-person result is a policy question
 * (`selectIdentityFaceCandidate` in `packages/image-core/src/identity/identity-pack-quality.ts`),
 * not a detector question.
 */
export interface DetectedFaceCandidate {
  box: SourcePixelCrop;
  confidence: number;
  landmarks?: {
    leftEye?: { x: number; y: number };
    rightEye?: { x: number; y: number };
    mouth?: { x: number; y: number };
  };
  occlusionScore?: number;
}

/**
 * Thresholds applied to a pack's OWN measurements, independent of any model.
 *
 * The two confidence floors are separate for a reason that is easy to lose: a
 * second face too weak to be the subject can still be strong enough to make the
 * identity ambiguous, so "usable primary face" and "possible additional face" are
 * different questions with different answers.
 *
 * Nullable thresholds mean "this check is not enabled at this policy version" —
 * distinct from 0, which would mean "block/warn at any score". Concrete values live
 * in `packages/image-core/src/identity/identity-pack-policy.ts`, never in a route or a column.
 */
export interface IdentityPackIntrinsicPolicy {
  version: string;
  detectorConfidenceFloor: number;
  possibleAdditionalFaceFloor: number;
  minimumCropWidthPx: number;
  minimumCropHeightPx: number;
  blurWarningThreshold: number | null;
  blurBlockThreshold: number | null;
  occlusionWarningThreshold: number | null;
  occlusionBlockThreshold: number | null;
  minimumBoundaryPaddingPx: number;
}

/**
 * The profile's half of the judgment: the same revision may be fine for a model
 * that sees a 1024px reference and useless for one that downsamples to 512, so
 * these thresholds are checked against EFFECTIVE provider pixels, not stored ones.
 */
export interface IdentityPackProfilePolicy {
  minimumEffectiveFaceWidthPx: number;
  minimumEffectiveFaceHeightPx: number;
  allowHeuristic: boolean;
  allowAdminOverride: boolean;
}

/**
 * What a supplied identity reference is FOR. `canonical_identity` is the
 * character's current source portrait (broad face, hair, body, age, presentation
 * context); `face_detail` is the hidden crop (higher local facial detail, less
 * body and composition context).
 *
 * Neither is universally better, which is why the choice is a per-profile strategy
 * rather than a global preference.
 */
export const identityReferenceRoles = ["canonical_identity", "face_detail"] as const;
export const identityReferenceRoleSchema = z.enum(identityReferenceRoles);
export type IdentityReferenceRole = (typeof identityReferenceRoles)[number];

/**
 * Which roles a profile sends and in what order. This belongs to the pinned
 * profile/version and is NEVER inferred from how many image fields a provider
 * schema happens to expose — reference count is a transport fact, role order is a
 * reviewed judgment about that model.
 */
export const identityReferenceStrategies = [
  "canonical_only",
  "face_detail_only",
  "canonical_then_face_detail",
  "face_detail_then_canonical",
] as const;
export const identityReferenceStrategySchema = z.enum(identityReferenceStrategies);
export type IdentityReferenceStrategy = (typeof identityReferenceStrategies)[number];

/**
 * One authorized, measured reference the render path MAY send. Ids and
 * measurements only: shared render intent resolves authorized bytes through the
 * normal image service after selection, so a candidate that is never chosen never
 * causes a file read.
 */
export interface IdentityReferenceCandidate {
  role: IdentityReferenceRole;
  imageId: string;
  packId: string;
  packRevision: number;
  sourceImageId: string;
  sourceContentHash: string;
  required: boolean;
  warningCodes: ImageIdentityPackWarningCode[];
  evaluation: {
    policyVersion: string;
    effectiveReferenceWidthPx: number | null;
    effectiveReferenceHeightPx: number | null;
    effectiveFaceWidthPx: number | null;
    effectiveFaceHeightPx: number | null;
  };
}

/**
 * Profile-aware eligibility. `profile_ineligible` is not a pack failure — the pack
 * may be perfect and this model still unable to carry it — so it sits alongside the
 * pack failure codes rather than inside them.
 *
 * `provenance` is candidate-parallel: entry N records candidate N. It rides the
 * eligible arm because the pack the candidates were judged against is gone by
 * the time a lane needs the record — the evaluation is the last moment both are
 * in one place, and a lane that had to re-read the pack to explain its own send
 * could read a different revision.
 */
export type EvaluateIdentityPackResult =
  | {
      eligible: true;
      candidates: IdentityReferenceCandidate[];
      provenance: IdentityReferenceProvenance[];
      warnings: ImageIdentityPackWarningCode[];
    }
  | {
      eligible: false;
      code: ImageIdentityPackFailureCode | "profile_ineligible";
      messageKey: string;
    };

/**
 * What is recorded ON the render attempt for every identity reference actually
 * sent.
 *
 * This travels with the attempt rather than the character or image row because an
 * old render must stay explainable after its pack is superseded: the revision, the
 * exact source bytes, the crop rectangle, and the effective pixels the provider saw
 * are the whole evidence chain behind "why does this scene look like that".
 */
export const identityReferenceProvenanceSchema = z.object({
  characterId: z.string().min(1),
  packId: z.string().min(1),
  packRevision: z.number().int().min(1),
  packSchemaVersion: z.number().int().min(1),
  derivationVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  role: identityReferenceRoleSchema,
  imageId: z.string().min(1),
  sourceImageId: z.string().min(1),
  sourceContentHash: z.string().min(1),
  cropMethod: imageIdentityCropMethodSchema.nullable(),
  crop: sourcePixelCropSchema.nullable(),
  warningCodes: z
    .array(imageIdentityPackWarningCodeSchema)
    .default((): ImageIdentityPackWarningCode[] => []),
  adminOverride: z.boolean(),
  effectiveReferenceWidthPx: z.number().int().nullable(),
  effectiveReferenceHeightPx: z.number().int().nullable(),
  effectiveFaceWidthPx: z.number().int().nullable(),
  effectiveFaceHeightPx: z.number().int().nullable(),
});
export type IdentityReferenceProvenance = z.infer<typeof identityReferenceProvenanceSchema>;

/** Degraded-safe provenance list for the render attempt's jsonb column. */
export const identityReferenceProvenanceListSchema = z
  .array(identityReferenceProvenanceSchema)
  .catch((): IdentityReferenceProvenance[] => []);

/**
 * A pack's lifecycle position as a STATUS VIEW sees it, which needs one arm the
 * stored vocabulary cannot have: `"none"`, for a character that has no revision
 * at all. That is an ordinary state (nobody has asked yet), not a failure, and
 * folding it into `unusable` would tell an owner their portrait was rejected
 * when nothing has looked at it.
 */
export const identityPackSummaryStatuses = [...imageIdentityPackStatuses, "none"] as const;
export const identityPackSummaryStatusSchema = z.enum(identityPackSummaryStatuses);
export type IdentityPackSummaryStatus = (typeof identityPackSummaryStatuses)[number];

/**
 * The owner-safe pack view behind `GET /api/characters/:id/identity-pack`.
 *
 * Ids, geometry, and stable codes only — no bytes, no URLs, and no detector
 * internals the crop editor does not need; that is the privacy boundary this
 * view holds. The hidden crop is named by id so it can be fetched through the
 * authorized image route; nothing here is a URL that could be pasted elsewhere.
 *
 * `pending` reaches the client explicitly rather than being flattened into "not
 * ready": derivation reserved by another process is a real state, and a view
 * that cannot say so leaves an owner staring at a spinner with no answer while
 * `ensureIdentityPack` waits out the other holder.
 *
 * `crop`, `source`, and `sourceContentHash` always describe the SAME bytes: the
 * editor frames a rectangle against the source it was told about and sends that
 * hash back, so a source that moved underneath it is a conflict rather than a
 * crop applied to a portrait the user never saw.
 */
export const identityPackSummarySchema = z.object({
  /** Null with `status: "none"`; otherwise the current revision's row id, which a write echoes back as its concurrency guard. */
  packId: z.string().min(1).nullable(),
  status: identityPackSummaryStatusSchema,
  revision: z.number().int().min(1).nullable(),
  current: z.boolean(),
  /** The revision no longer describes the character's canonical source; re-prepare before cropping. */
  stale: z.boolean(),
  method: imageIdentityCropMethodSchema.nullable(),
  source: z.object({
    imageId: z.string().min(1).nullable(),
    width: z.number().int().min(1).nullable(),
    height: z.number().int().min(1).nullable(),
  }),
  crop: sourcePixelCropSchema.nullable(),
  cropImageId: z.string().min(1).nullable(),
  warningCodes: z.array(imageIdentityPackWarningCodeSchema),
  failureCode: imageIdentityPackFailureCodeSchema.nullable(),
  sourceContentHash: z.string().min(1).nullable(),
  updatedAt: z.string().min(1).nullable(),
});
export type IdentityPackSummaryWire = z.infer<typeof identityPackSummarySchema>;

/**
 * A write that never reached a revision, reported alongside the summary.
 *
 * `ensure` and `reset-automatic` answer 200 whatever happens — an unusable pack
 * is product feedback, not a server error — and they answer with the summary
 * read back afterwards. But a refusal that lands BEFORE anything is persisted
 * (no canonical portrait, a source still generating, unreadable bytes, another
 * derivation holding the character past the wait window) leaves no trace in that
 * summary at all: it still describes the previous pack, or `none`, and the owner
 * is told nothing they can act on. This is that outcome, in the same stable
 * vocabulary every other refusal uses.
 */
export const identityPackBlockedSchema = z.object({
  code: imageIdentityPackFailureCodeSchema,
  /** Whether asking again could change the answer — the service's own retry ruling, not a guess. */
  retryable: z.boolean(),
});
export type IdentityPackBlockedWire = z.infer<typeof identityPackBlockedSchema>;

/**
 * The body every identity-pack route sends.
 *
 * `blocked` is OPTIONAL and absent on success, so the plain `{ summary }` shape
 * the GET and the correction routes have always sent stays exactly valid: a
 * client that never looks at the field keeps working, and one that does gets the
 * actionable code instead of a silently unchanged panel.
 */
export const identityPackResponseSchema = z.object({
  summary: identityPackSummarySchema,
  blocked: identityPackBlockedSchema.optional().catch(undefined),
});
export type IdentityPackResponseWire = z.infer<typeof identityPackResponseSchema>;

/**
 * A rectangle as the crop editor draws it: fractions of the source, never
 * pixels. The `space` tag is not decoration — `{ left: 0.25 }` and
 * `{ left: 25 }` are both legal rectangles in their own space, and inferring
 * which one a client meant from the magnitude of its numbers would be a coin
 * flip that silently crops the wrong part of somebody's face. The server
 * resolves these to integer source pixels and persists THOSE.
 *
 * The sides are strictly positive: a zero-area rectangle is a malformed crop,
 * the same rule `sourcePixelCropSchema` applies one space down.
 */
export const identityPackNormalizedCropSchema = z.object({
  space: z.literal("normalized"),
  left: z.number().min(0).max(1),
  top: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});
export type IdentityPackNormalizedCropWire = z.infer<typeof identityPackNormalizedCropSchema>;

/**
 * A character owner's crop save, which creates a manual crop revision.
 *
 * `packId`, `revision`, and `sourceContentHash` are the editor's concurrency
 * guard, NEVER its authorization: the route re-authorizes from the character in
 * the URL, and these three only answer "is this still the thing I opened?". A
 * mismatch is a reload, not a save.
 */
export const identityPackManualCropRequestSchema = z.object({
  packId: z.string().min(1),
  revision: z.number().int().min(1),
  sourceContentHash: z.string().min(1),
  crop: identityPackNormalizedCropSchema,
  /** Optional note recorded on the revision. An owner correction needs no justification; an admin override does. */
  reason: z.string().trim().max(500).optional(),
});
export type IdentityPackManualCropRequest = z.infer<typeof identityPackManualCropRequestSchema>;

/**
 * One revision as the admin history surface reports it.
 *
 * Deliberately ids, versions, geometry, codes and review actors — the evidence
 * chain behind "why does this character's face look like that" — and deliberately
 * no image bytes and no URLs, which is the privacy boundary a bulk admin payload
 * is most likely to breach.
 */
export const identityPackAdminRevisionSchema = z.object({
  revision: z.number().int().min(1),
  status: imageIdentityPackStatusSchema,
  current: z.boolean(),
  method: imageIdentityCropMethodSchema.nullable(),
  derivationVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  detectorVersion: z.string().min(1).nullable(),
  confidence: z.number().nullable(),
  warningCodes: z.array(imageIdentityPackWarningCodeSchema),
  failureCode: imageIdentityPackFailureCodeSchema.nullable(),
  failureMessage: z.string().nullable(),
  crop: sourcePixelCropSchema.nullable(),
  cropImageId: z.string().min(1).nullable(),
  sourceImageId: z.string().min(1).nullable(),
  sourceContentHash: z.string().min(1),
  reviewedByUserId: z.string().min(1).nullable(),
  reviewReason: z.string().nullable(),
  reviewedAt: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
});
export type IdentityPackAdminRevision = z.infer<typeof identityPackAdminRevisionSchema>;

/**
 * A recorded admin override.
 *
 * The reason is required and non-empty because the override's whole value is the
 * audit row it leaves: a waived threshold with no stated reason is
 * indistinguishable from a mistake six months later.
 *
 * An absent `crop` means "re-approve the coordinates already on the current
 * revision" — the support case where the framing is right and only a reviewed
 * quality threshold is in the way. It never means "any crop will do": ownership,
 * missing bytes, geometry, and a stale hash stay hard checks whoever asks.
 */
export const identityPackAdminOverrideRequestSchema = z.object({
  packId: z.string().min(1),
  revision: z.number().int().min(1),
  sourceContentHash: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
  crop: identityPackNormalizedCropSchema.optional(),
});
export type IdentityPackAdminOverrideRequest = z.infer<typeof identityPackAdminOverrideRequestSchema>;

/**
 * A bounded admin preparation batch, for lazy backfill.
 *
 * Exactly one selector: explicit ids or a checked-in trial corpus. Accepting
 * both would make "which characters did this actually run against?" a question
 * the report could not answer, and accepting neither would run an empty batch
 * that reports success. `dryRun` defaults to TRUE — the safe answer for an
 * omitted field on a surface whose other mode does real work over up to 200
 * characters.
 *
 * `concurrency` is bounded here only to reject absurd input; the service clamps
 * it to its own reviewed ceiling, because parallelism is a fact about the
 * machine serving renders rather than about the request.
 */
export const identityPackBatchRequestSchema = z
  .object({
    characterIds: z.array(z.string().min(1)).min(1).max(200).optional(),
    corpusId: z.string().trim().min(1).max(120).optional(),
    dryRun: z.boolean().default(true),
    /** Re-derive even a current ready pack, for a derivation change under the same version. */
    regenerate: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
  })
  .refine((value) => (value.characterIds === undefined) !== (value.corpusId === undefined), {
    message: "supply exactly one of characterIds or corpusId",
    path: ["characterIds"],
  });
export type IdentityPackBatchRequest = z.infer<typeof identityPackBatchRequestSchema>;
