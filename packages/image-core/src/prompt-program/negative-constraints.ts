import type { ImageProfileTask, ImagePromptStrategy } from "../models/image-model-profiles";
import {
  imageFramingIsCropped,
  imageFramingShowsHands,
  imageMotionImpliesBlur,
  type ImageFramingBand,
} from "./camera-bands";
import type { ImageConflictKey, ImageStyleMedium } from "./conflict-keys";
import type { ImagePositiveClaim } from "./positive-claims";
import type { ImageWorldDigest } from "./world-digest";

/**
 * The negative channel: named, guarded blocks over one shared conflict
 * vocabulary (model-aware-image-prompts.plan.md §"Negative prompt system").
 *
 * The thing this replaces is a universal negative string. Vesper's models render
 * portraits, product shots of a single garment, empty rooms, androids, signage
 * and stylized illustration, and the official Qwen cleanup example — malformed
 * fingers, waxy skin, blurry text, over-smoothing — is wrong for at least one of
 * those in every clause. Copying it wholesale forbids the lettering an EXIT sign
 * needs, the smooth surface an android needs, and the extra appendages a
 * non-human character needs.
 *
 * So a constraint here says only what OUTCOME is unacceptable, in conflict keys.
 * Three things then happen to it that a string could not survive:
 *
 * - a **guard** decides whether the block applies to this render at all;
 * - the **linter** subtracts every key the world digest requires;
 * - the **dialect** spells whatever survives, in its own syntax and transport.
 *
 * A block is code and its activation is pack data. That split is the plan's
 * "what belongs in data versus code": an operator may turn a block on for a
 * profile and reorder it, but may not author a new exclusion whose guard nobody
 * wrote.
 */

/** What kind of failure a constraint is about — the plan's category vocabulary. */
export const imageNegativeCategories = [
  "artifact",
  "anatomy",
  "identity_drift",
  "subject_count",
  "literal_text_artifact",
  "watermark_or_signature",
  "composition",
  "framing",
  "style_conflict",
  "background_clutter",
  "task_specific",
  "provider_default_override",
] as const;
export type ImageNegativeCategory = (typeof imageNegativeCategories)[number];

/**
 * One selected exclusion, ready for linting and transport.
 *
 * `conflictKeys` is what the linter subtracts against; `concepts` is the
 * human-readable roster a dialect turns into words. They are separate because a
 * dialect may spell one key as three phrases, and the linter must not have to
 * count phrases to decide whether an exclusion survived.
 */
export interface ImageNegativeConstraint {
  readonly id: ImageNegativeBlockId;
  readonly category: ImageNegativeCategory;
  readonly conflictKeys: readonly ImageConflictKey[];
  /**
   * When true, a render that cannot express this exclusion is REFUSED rather
   * than run without it. Reserved for exclusions whose absence makes the render
   * pointless — a provider default that contradicts Vesper state is the live
   * example. Ordinary cleanup blocks are optional and drop with a diagnostic.
   */
  readonly required: boolean;
  /** Higher survives a negative-length budget longer. */
  readonly priority: number;
  /** The pack version that selected this block — provenance, never prompt text. */
  readonly sourcePackVersionId: string;
  /** Evidence ids backing the block, from the pack's manifest. */
  readonly evidenceIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Everything a block's applicability rule may consult, derived once from the
 * digest.
 *
 * A flat record rather than the digest itself, and that is the important part:
 * a guard that received the digest could reach any fact it liked, and the rules
 * would drift into unwritten dependencies on world shape. This record is the
 * complete list of questions a guard is allowed to ask, and widening it is a
 * visible edit.
 */
export interface ImageNegativeGuard {
  readonly task: ImageProfileTask;
  readonly strategy: ImagePromptStrategy;
  /** How many people the image must contain. Zero for a product or empty-room shot. */
  readonly subjectCount: number;
  readonly medium: ImageStyleMedium;
  /** Any literal text, label, logo or sign the render must render. */
  readonly literalTextRequested: boolean;
  /** Whether hands are in frame or load-bearing for the action. */
  readonly handsVisible: boolean;
  /** The frame deliberately cuts the figure — a portrait or a close-up. */
  readonly croppedFramingRequested: boolean;
  /** Motion the render asked for, which a blur exclusion would fight. */
  readonly blurRequested: boolean;
  /** A deliberately clean or seamless backdrop — a catalog shot, an avatar. */
  readonly cleanBackgroundIntended: boolean;
  /** An identity reference is being sent, so identity drift is a real risk here. */
  readonly identityReferenced: boolean;
  /** The render edits an existing image rather than generating one. */
  readonly isEdit: boolean;
}

/**
 * Tasks whose whole point is an isolated subject on an empty ground.
 *
 * An exhaustive switch rather than a set so a new task is a compile error here:
 * "does this task want a clean backdrop" is a real product question, and
 * defaulting a new task to "no" silently is how a catalog lane ends up with a
 * cluttered background nobody asked for.
 */
function taskIntendsCleanBackground(task: ImageProfileTask): boolean {
  switch (task) {
    case "item":
      return true;
    case "portrait":
    case "variant":
    case "scene":
    case "location":
    case "chat_look":
    case "chat_place":
    case "text_repair":
    case "example_transform":
    case "image_set":
      return false;
  }
}

/**
 * Read one digest into the guard record.
 *
 * Everything here is a READ of facts the digest already carries; nothing is
 * inferred from prose and nothing is defaulted optimistically. Where the digest
 * is silent the guard says so, and a block that needs the answer stays off —
 * failing closed on an exclusion costs a little image quality, while failing open
 * costs the feature the exclusion was about to forbid.
 */
export function imageNegativeGuardOf(digest: ImageWorldDigest): ImageNegativeGuard {
  const { operation } = digest;
  const framing = digest.camera.find((fact) => fact.component === "framing");
  const motion = digest.camera.find((fact) => fact.component === "motion");
  const framingBand: ImageFramingBand | null = framing?.component === "framing" ? framing.band : null;
  // Hands are in play when the frame contains them OR when a relation puts
  // something in one. A `holds` relation on a portrait crop is exactly the case
  // where the framing alone would say no and be wrong.
  const holds = digest.relations.some((relation) => relation.kind === "holds" || relation.kind === "contact");
  return {
    task: operation.task,
    strategy: operation.strategy,
    subjectCount: operation.subjectCount,
    medium: operation.style.medium,
    literalTextRequested:
      operation.literalText.length > 0 ||
      digest.items.some((item) => item.facts.some((fact) => fact.concept === "item.marking")) ||
      (digest.location?.facts.some((fact) => fact.concept === "location.signage") ?? false),
    handsVisible: operation.subjectCount > 0 && (holds || (framingBand !== null && imageFramingShowsHands(framingBand))),
    croppedFramingRequested: framingBand !== null && imageFramingIsCropped(framingBand),
    blurRequested: motion?.component === "motion" && imageMotionImpliesBlur(motion.band),
    cleanBackgroundIntended: taskIntendsCleanBackground(operation.task) && digest.location === null,
    identityReferenced: digest.references.some((reference) => reference.role === "identity"),
    isEdit: operation.kind === "edit",
  };
}

// ---------------------------------------------------------------------------
// The block registry
// ---------------------------------------------------------------------------

/** One named exclusion: what it forbids, and when it is safe to ask for it. */
export interface ImageNegativeBlockDefinition {
  readonly id: ImageNegativeBlockId;
  readonly category: ImageNegativeCategory;
  readonly conflictKeys: readonly ImageConflictKey[];
  readonly priority: number;
  readonly required: boolean;
  /** Whether this block applies to this render at all, before any linting. */
  applicable(guard: ImageNegativeGuard): boolean;
}

/**
 * The ten named blocks (plan §"Named blocks").
 *
 * Small and composable on purpose. A single "quality" block would be one guard
 * for a dozen unrelated exclusions, so the first render that legitimately wanted
 * one of them would lose all twelve — which is how universal negative strings
 * become universal by accident.
 *
 * The guards below encode the plan's minimum collision rules at their SOURCE.
 * The linter enforces them again from the positive side, and the redundancy is
 * intended: a guard is about whether the block makes sense for the job, while the
 * linter is about whether this particular world contradicts it.
 */
const BLOCK_TABLE = [
  {
    id: "generated_text_artifacts",
    category: "literal_text_artifact",
    conflictKeys: ["text", "letters", "caption"],
    priority: 90,
    required: false,
    // Off entirely when anything must be legible. A render that has to spell EXIT
    // cannot spend a clause forbidding letters and expect the sign to survive.
    applicable: (guard: ImageNegativeGuard) => !guard.literalTextRequested,
  },
  {
    id: "watermark_and_signature",
    category: "watermark_or_signature",
    conflictKeys: ["watermark", "signature", "logo"],
    priority: 95,
    required: false,
    // Watermarks are never authored, so this one applies to every render; the
    // linter still removes `logo` when an item's marking asks for one.
    applicable: () => true,
  },
  {
    id: "photoreal_surface_artifacts",
    category: "artifact",
    conflictKeys: ["synthetic_skin", "excessive_smoothing", "oversaturation"],
    priority: 70,
    required: false,
    // Only for photoreal renders WITH a person in them. A photographed teacup has
    // no skin to go waxy, and a painted portrait is supposed to look painted.
    applicable: (guard: ImageNegativeGuard) => guard.medium === "photographic" && guard.subjectCount > 0,
  },
  {
    id: "anatomy_duplication",
    category: "anatomy",
    // Both directions of anatomy failure, because both are in the official Qwen
    // example and both are correct morphology for somebody: extra appendages are
    // a species fact for a winged or tailed character, and missing ones are an
    // authored amputation or prosthetic. The linter subtracts each against the
    // subject's own morphology tags and absences before any of it is emitted.
    conflictKeys: [
      "extra_limbs",
      "extra_digits",
      "extra_appendages",
      "missing_limbs",
      "missing_digits",
      "duplicated_anatomy",
      "disconnected_anatomy",
    ],
    priority: 85,
    required: false,
    applicable: (guard: ImageNegativeGuard) => guard.subjectCount > 0,
  },
  {
    id: "hand_artifacts",
    category: "anatomy",
    conflictKeys: ["malformed_hands", "extra_digits"],
    priority: 80,
    required: false,
    applicable: (guard: ImageNegativeGuard) => guard.handsVisible,
  },
  {
    id: "single_subject_integrity",
    category: "subject_count",
    conflictKeys: ["multiple_people", "duplicate_face"],
    priority: 88,
    required: false,
    // Exactly one person. Zero would make "no duplicate faces" meaningless, and
    // two or more makes it actively wrong.
    applicable: (guard: ImageNegativeGuard) => guard.subjectCount === 1,
  },
  {
    id: "identity_drift",
    category: "identity_drift",
    conflictKeys: ["identity_drift"],
    priority: 75,
    required: false,
    // Only where there is an identity to drift FROM. Without a reference the term
    // is aspirational, and the research is explicit that negative-transport
    // identity terms are endpoint-specific rather than universally useful.
    applicable: (guard: ImageNegativeGuard) => guard.identityReferenced,
  },
  {
    id: "composition_artifacts",
    category: "composition",
    conflictKeys: ["out_of_frame", "confused_composition", "impossible_overlap", "cropped"],
    priority: 60,
    required: false,
    // Off when the camera asked for a crop. A portrait framing IS a cut-off
    // figure, so forbidding one argues with the shot.
    applicable: (guard: ImageNegativeGuard) => !guard.croppedFramingRequested,
  },
  {
    id: "background_clutter",
    category: "background_clutter",
    conflictKeys: ["background_clutter", "extra_objects"],
    priority: 50,
    required: false,
    applicable: (guard: ImageNegativeGuard) => guard.cleanBackgroundIntended,
  },
  {
    id: "style_exclusions",
    category: "style_conflict",
    conflictKeys: ["illustration", "anime", "painting", "render_3d", "low_resolution", "low_quality"],
    priority: 55,
    required: false,
    // Only when a medium was actually stated. An unspecified medium has no
    // opposite, and guessing one is how a deliberately illustrated render gets
    // told not to look illustrated.
    applicable: (guard: ImageNegativeGuard) => guard.medium !== "unspecified",
  },
  {
    id: "provider_default_override",
    category: "provider_default_override",
    conflictKeys: [],
    priority: 100,
    // The one REQUIRED block. A wrapper default that contradicts Vesper's
    // authoritative state is not a quality preference: shipping the render with
    // it still in place produces an image of a different world.
    required: true,
    applicable: () => false,
  },
] as const satisfies readonly {
  id: string;
  category: ImageNegativeCategory;
  conflictKeys: readonly ImageConflictKey[];
  priority: number;
  required: boolean;
  applicable: (guard: ImageNegativeGuard) => boolean;
}[];

export type ImageNegativeBlockId = (typeof BLOCK_TABLE)[number]["id"];

/** Every block id, in registry order. */
export const imageNegativeBlockIds: readonly ImageNegativeBlockId[] = BLOCK_TABLE.map((entry) => entry.id);

const blockById: ReadonlyMap<string, ImageNegativeBlockDefinition> = new Map(
  BLOCK_TABLE.map((entry) => [entry.id, entry as ImageNegativeBlockDefinition]),
);

/** A block's definition, or null when the id is not registered. */
export function imageNegativeBlock(id: string): ImageNegativeBlockDefinition | null {
  return blockById.get(id) ?? null;
}

/** Whether an arbitrary string names a registered block. */
export function isImageNegativeBlockId(id: string): id is ImageNegativeBlockId {
  return blockById.has(id);
}

/**
 * `provider_default_override` is the one block a pack cannot simply enable: it
 * carries no fixed keys, because what it neutralizes is whatever the wrapper
 * injects. The compiler synthesizes it from the endpoint's declared hidden
 * prompt sources, so its guard answers false and this constant is how the
 * compiler names it.
 */
export const IMAGE_PROVIDER_DEFAULT_OVERRIDE_BLOCK: ImageNegativeBlockId = "provider_default_override";

/**
 * Select the blocks a pack enables that this render's guard permits.
 *
 * Order is priority descending then id, so a negative budget trims the weakest
 * exclusion rather than whichever the pack happened to list last, and two
 * compiles of the same render produce byte-equal constraint lists.
 */
export function selectImageNegativeConstraints(input: {
  readonly enabledBlockIds: readonly ImageNegativeBlockId[];
  readonly guard: ImageNegativeGuard;
  readonly packVersionId: string;
  readonly evidenceIds: Readonly<Partial<Record<ImageNegativeBlockId, readonly string[]>>>;
  readonly priorityOverrides?: Readonly<Partial<Record<ImageNegativeBlockId, number>>>;
}): readonly ImageNegativeConstraint[] {
  const selected: ImageNegativeConstraint[] = [];
  for (const id of input.enabledBlockIds) {
    const block = imageNegativeBlock(id);
    if (block === null || !block.applicable(input.guard)) continue;
    selected.push({
      id: block.id,
      category: block.category,
      conflictKeys: block.conflictKeys,
      required: block.required,
      priority: input.priorityOverrides?.[block.id] ?? block.priority,
      sourcePackVersionId: input.packVersionId,
      evidenceIds: input.evidenceIds[block.id] ?? [],
    });
  }
  return selected.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

/**
 * The exclusion that neutralizes one provider-injected default.
 *
 * Synthesized rather than authored because its content is the ENDPOINT's, not a
 * pack's: the plan's Pony example is the shape — clearing an injected
 * `nsfw, naked` and leaving the wrapper's preprompt enabled are two different
 * actions, and the effective-prompt record has to show them separately.
 */
export function providerDefaultOverrideConstraint(input: {
  readonly packVersionId: string;
  readonly evidenceIds: readonly string[];
  /**
   * Whether the endpoint exposes a field Vesper can write the override into.
   *
   * This decides `required`, and the asymmetry is deliberate. When the default IS
   * overridable, failing to send the override means shipping an image of a
   * different world, so the render refuses. When it is NOT, refusing would take
   * the endpoint out of service over a wrapper behavior nobody can change — so
   * the constraint is optional, drops with a recorded reason, and the operator
   * sees the injected text in the effective-prompt record instead.
   */
  readonly overridable: boolean;
}): ImageNegativeConstraint {
  const block = imageNegativeBlock(IMAGE_PROVIDER_DEFAULT_OVERRIDE_BLOCK);
  return {
    id: IMAGE_PROVIDER_DEFAULT_OVERRIDE_BLOCK,
    category: "provider_default_override",
    conflictKeys: [],
    required: input.overridable,
    priority: block?.priority ?? 100,
    sourcePackVersionId: input.packVersionId,
    evidenceIds: input.evidenceIds,
  };
}

/**
 * Whether any positive claim already asserts one of a constraint's keys — the
 * cheap pre-check the compiler runs before assembling a full protection set.
 *
 * Exposed for tests and for the admin preview, which wants to explain a dropped
 * constraint by naming the claim that displaced it rather than only reporting
 * that something did.
 */
export function claimsAssertingKey(
  claims: readonly ImagePositiveClaim[],
  key: ImageConflictKey,
  protectionsOf: (claim: ImagePositiveClaim) => readonly ImageConflictKey[],
): readonly ImagePositiveClaim[] {
  return claims.filter((claim) => protectionsOf(claim).includes(key));
}
