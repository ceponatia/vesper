import { referenceCapacity, type ImageModel } from "./image-models";
import type { ImageReferenceRole } from "./image-model-capabilities";
import type { ImageReferencePolicy, ImageRenderControls } from "./image-model-profiles";

/**
 * The normalized render request every image lane speaks
 * (image-model-capabilities.spec.md §"Normalized render intent").
 *
 * Before this existed, each lane called the provider its own way: the portrait
 * lane sent a prompt, the variant lane a prompt and one buffer, the scene lane a
 * prompt and up to three buffers whose meaning was their POSITION. A reference
 * was the first, second or third image and nothing more, so nothing downstream
 * could tell the character's face from the room it stands in — which is why
 * capacity trimming could drop the identity anchor and keep the location.
 *
 * An intent says what the render WANTS in terms no model knows about: the
 * prompt, the shape, the optional controls, and references that carry a ROLE.
 * The profile and model translate that into provider fields.
 *
 * This module is the serializable half — vocabulary and pure rules only. The
 * buffer-bearing request and the orchestration live in
 * `server/images/render-intent.ts`, because bytes never cross into `contracts`.
 */

/**
 * One reference a lane wants to send, minus its bytes.
 *
 * `role` is the point of the whole type. `required` and `priority` exist for the
 * role-aware selector (slice 3), which sorts required references ahead of
 * optional ones and profile role order ahead of numeric priority; until it
 * lands, {@link selectIntentReferences} keeps caller order and only enforces the
 * required roles a profile declares.
 *
 * `sourceImageId` and `name` are provenance, not payload: they let a diagnostic
 * say which stored asset was dropped rather than "reference 3".
 */
export interface ImageRenderReferenceSpec {
  role: ImageReferenceRole;
  /** Fail the render rather than send it without this reference. */
  required?: boolean;
  /** Tie-break within a role band; higher wins. Unset sorts after any set value. */
  priority?: number;
  /** The `images.id` these bytes came from, when they came from a stored asset. */
  sourceImageId?: string;
  /** A human label for diagnostics — a character or place name, never sent. */
  name?: string;
}

/**
 * The shape a lane wants back, as a width/height ratio.
 *
 * An object rather than a bare number because this is where the quality tier and
 * explicit resolution join it in slice 4. They are deliberately absent now: a
 * `quality: "fast" | "balanced" | "quality"` field would be a claim about the
 * render that nothing in the payload honors until quality profiles and the
 * control transports exist.
 */
export interface ImageRenderTarget {
  aspectRatio: number;
}

/**
 * What a lane asks for, independent of which model will answer.
 *
 * The task is deliberately NOT here: an intent is always accompanied by the
 * profile it resolved to, and that profile names its own task. Carrying both
 * would let them disagree.
 */
export interface ImageRenderIntentCore {
  /** The lane's prompt, BEFORE the profile's prompt strategy compiles it. */
  prompt: string;
  target: ImageRenderTarget;
  /**
   * Per-render control overrides, merged over the profile's stored defaults. No
   * lane sends any today, which is what keeps the migration payload-neutral.
   */
  controls?: ImageRenderControls;
}

/**
 * Reference roles a profile requires that this intent does not supply.
 *
 * Empty means the intent satisfies the policy — including the common case of a
 * policy that requires nothing, which is what the seeded scene profiles carry
 * (their `generate` rung legitimately runs with no references at all).
 *
 * Checked BEFORE any provider work, because a variant profile that requires an
 * identity reference and receives none cannot produce a variant of anybody: it
 * would render a stranger and bill for it.
 */
export function missingRequiredReferenceRoles(
  policy: ImageReferencePolicy,
  references: readonly ImageRenderReferenceSpec[],
): ImageReferenceRole[] {
  const present = new Set(references.map((reference) => reference.role));
  return policy.requiredRoles.filter((role) => !present.has(role));
}

/** References the model will actually receive, and the ones capacity left behind. */
export interface SelectedImageReferences<T extends ImageRenderReferenceSpec> {
  selected: T[];
  /** Dropped in caller order, so a diagnostic can name the roles that did not fit. */
  dropped: T[];
}

/**
 * Trim an intent's references to what the model can accept.
 *
 * Caller order is preserved and nothing is reordered. That is the current
 * behavior of every lane — the scene chain already slices to
 * `attemptReferenceCount`, and the single-reference lanes send exactly one — and
 * preserving it is what makes routing the lanes through the intent a change of
 * plumbing rather than a change of renders.
 *
 * Priority selection by role is slice 3's job, and it is a real behavior change:
 * it is what stops a three-reference scene on a two-reference model from
 * dropping whichever reference happened to be last, rather than whichever
 * matters least. The `dropped` half of this result is already reported so that
 * change arrives with the diagnostic that explains it.
 */
export function selectIntentReferences<T extends ImageRenderReferenceSpec>(
  model: ImageModel,
  references: readonly T[],
): SelectedImageReferences<T> {
  const { max } = referenceCapacity(model);
  if (max <= 0) return { selected: [], dropped: [...references] };
  return { selected: references.slice(0, max), dropped: references.slice(max) };
}
