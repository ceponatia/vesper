import { z } from "zod";
import type { SceneFaceVisibility } from "@vesper/image-core";
import type { CharacterProfile } from "../world/profile";
import { imageApparentAgeValue } from "./character-adapter";
import { VISUAL_IMAGE_AGE_ATTRIBUTE_ID } from "./visual-digest";
import { sceneSubjectOrientationById, type SceneCameraSpec } from "./scene-camera";

/**
 * **THE REFERENCE VIEW SET** — the small, fixed sheet of the accepted portrait
 * seen from somewhere other than the front.
 *
 * A portrait answers one question about a character: what does this person's
 * face look like from the front. Every later render that needs a back, a side,
 * or a full-length body has to invent the rest, and it invents it differently
 * each time — which is why the same character comes back with a different
 * silhouette the moment the camera moves. The view set makes those answers
 * durable: they are rendered once, from the accepted portrait, reviewed by the
 * owner, and reused.
 *
 * **A registry, not free text**, on the `scene-camera.ts` model, and held to the
 * same three phrasing rules that file holds itself to (its own header states
 * why each one exists, and its test suite is the pin):
 *
 * 1. **No limb nouns.** A limb noun summons a limb, and an unowned one becomes a
 *    second person. Back- and side-region words are the useful exception, made
 *    safe by possessive binding — which is why every line here is a `{name}`
 *    template rather than a sentence about "her".
 * 2. **No gendered pronouns.** The cast is not all one gender.
 * 3. **Positive phrasing only.** State the geometry that IS. "Not facing the
 *    camera" anchors on facing the camera.
 *
 * ## The two axes
 *
 * A view is the pair `{ angle, wardrobe }`, and the SET is the cross product —
 * every angle in both wardrobe states. Nothing in the app counts the set by
 * hand: the cost text, the studio grid and the quota charge all read
 * {@link referenceViewAngles}.length × {@link referenceViewWardrobes}.length, so
 * a fifth angle is one entry here and no arithmetic anywhere else.
 *
 * ## Which side is which
 *
 * `side_left` and `side_right` are **subject-relative**: `side_left` turns the
 * character's OWN left side toward the camera. The camera vocabulary has no
 * left/right of its own — `profile` says side-on and stops there — so the
 * instruction has to fix the handedness itself or the two side views are one
 * view rendered twice. Subject-relative rather than camera-relative because the
 * consumer is a body: a scar on the character's left shoulder is on the
 * character's left in both the reference sheet and the scene that anchors to it.
 *
 * PURE. Tuning a phrase is a data edit here; adding an angle is one entry.
 */

// ---------------------------------------------------------------------------
// The two axes
// ---------------------------------------------------------------------------

export const referenceViewAngleIds = ["front_full", "back_full", "side_left", "side_right"] as const;
export const referenceViewAngleIdSchema = z.enum(referenceViewAngleIds);
export type ReferenceViewAngleId = z.infer<typeof referenceViewAngleIdSchema>;

export const referenceViewWardrobes = ["clothed", "bare"] as const;
export const referenceViewWardrobeSchema = z.enum(referenceViewWardrobes);
export type ReferenceViewWardrobe = z.infer<typeof referenceViewWardrobeSchema>;

/** One slot of the sheet: an angle in a wardrobe state. */
export const referenceViewSchema = z.object({
  angle: referenceViewAngleIdSchema,
  wardrobe: referenceViewWardrobeSchema,
});
export type ReferenceView = z.infer<typeof referenceViewSchema>;

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

export interface ReferenceViewAngle {
  readonly id: ReferenceViewAngleId;
  /** The viewpoint the cut is built under — a fixed lane camera, never a committed scene camera. */
  readonly camera: SceneCameraSpec;
  /** The camera id the digest selection fingerprints (the `VARIANT_EDIT_CAMERA_ID` device). */
  readonly cameraId: string;
  /** The edit asked of the model. A `{name}` template, bound at assembly. */
  readonly instruction: string;
  /** The studio tile's label. */
  readonly label: string;
}

/**
 * Every angle is `full_figure` at `eye_level`; only the orientation moves. The
 * framing is fixed because that is what a reference view IS — below-waist
 * morphology (a tail, digitigrade legs, a prosthetic) is exactly the thing a
 * later render has to stop inventing, and a waist-up frame would cut it.
 */
export const REFERENCE_VIEW_FRAMING = "full_figure" as const;

export const referenceViewAngles: readonly ReferenceViewAngle[] = [
  {
    id: "front_full",
    camera: { orientation: "toward_viewer", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_front_full",
    instruction: "{name} standing squarely facing the camera, the whole of {name} inside the frame",
    label: "Front, full length",
  },
  {
    id: "back_full",
    camera: { orientation: "away", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_back_full",
    instruction:
      "{name} standing with {name}'s back to the camera, {name}'s head turned away from the lens, the whole of {name} inside the frame",
    label: "Back, full length",
  },
  {
    // The handedness is stated in the instruction because the camera vocabulary
    // cannot state it — see this file's header, under "Which side is which".
    id: "side_left",
    camera: { orientation: "profile", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_side_left",
    instruction:
      "{name} standing turned a quarter-turn so the left side of {name}'s body faces the camera, {name}'s head side-on to the lens, the whole of {name} inside the frame",
    label: "Left side",
  },
  {
    id: "side_right",
    camera: { orientation: "profile", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_side_right",
    instruction:
      "{name} standing turned a quarter-turn so the right side of {name}'s body faces the camera, {name}'s head side-on to the lens, the whole of {name} inside the frame",
    label: "Right side",
  },
];

export function referenceViewAngleById(id: string): ReferenceViewAngle | undefined {
  return referenceViewAngles.find((entry) => entry.id === id);
}

/**
 * How much of the face this angle can show, read from the camera vocabulary
 * rather than restated: the identity lock adapts to it at assembly, and a second
 * copy of the mapping would let the sheet and the scene lane disagree about
 * whether a back view has a face in it.
 *
 * `hidden` for an orientation the registry does not recognize — an angle whose
 * camera fell out of the vocabulary promises no face, which is the fail-closed
 * answer for a lock that has nothing to lock onto.
 */
export function referenceViewFaceVisibility(angle: ReferenceViewAngle): SceneFaceVisibility {
  return sceneSubjectOrientationById(angle.camera.orientation)?.faceVisibility ?? "hidden";
}

// ---------------------------------------------------------------------------
// Wardrobe states
// ---------------------------------------------------------------------------

export interface ReferenceViewWardrobeEntry {
  readonly id: ReferenceViewWardrobe;
  readonly label: string;
  /** The wardrobe clause of the edit instruction. A `{name}` template. */
  readonly instruction: string;
  /**
   * The single gate. `intimate` decides three things and nothing else decides
   * them: a view is never built on a character whose image age band is not a
   * recognized adult one, the render carries the intimate reveal, and a lane
   * running without intimate allowance never receives it.
   */
  readonly intimate: boolean;
}

export const referenceViewWardrobeEntries: readonly ReferenceViewWardrobeEntry[] = [
  {
    id: "clothed",
    label: "As dressed",
    // The reference image already shows the garments; naming them would invite
    // the model to redesign them. The clause only pins them in place.
    instruction: "{name} wearing exactly the clothing the reference shows, changing nothing else about the garments",
    intimate: false,
  },
  {
    id: "bare",
    label: "Undressed",
    instruction: "{name} undressed, wearing nothing at all, {name}'s bare skin in plain view",
    intimate: true,
  },
];

export function referenceViewWardrobeById(id: string): ReferenceViewWardrobeEntry | undefined {
  return referenceViewWardrobeEntries.find((entry) => entry.id === id);
}

/**
 * The reference sheet's setting, stated once: there isn't one.
 *
 * A view anchors a body, not a place. A view rendered in the portrait's kitchen
 * carries that kitchen into every scene it later anchors, so the sheet is shot
 * against a blank surface — phrased positively, like every line in this file,
 * because "no setting" anchors on settings.
 */
export const REFERENCE_VIEW_BACKGROUND_CLAUSE =
  "set against a plain, even, neutral studio backdrop, an empty seamless surface behind {name}";

/**
 * Bumped when instruction wording, the background clause, or the way the three
 * are assembled changes. A stored row whose version is behind the current one
 * projects `stale`: it depicts an edit this code no longer asks for.
 */
export const REFERENCE_VIEW_GENERATION_VERSION = 1;

/** The whole sheet: every angle in every wardrobe state, in registry order. */
export function allReferenceViews(): readonly ReferenceView[] {
  return referenceViewAngles.flatMap((angle) =>
    referenceViewWardrobeEntries.map((wardrobe) => ({ angle: angle.id, wardrobe: wardrobe.id })),
  );
}

// ---------------------------------------------------------------------------
// The age gate
// ---------------------------------------------------------------------------

/**
 * The views an accept will actually build for this character — the full sheet,
 * minus every intimate view when the character's image age band is not a
 * recognized adult one.
 *
 * PURE and exported so the accept route charges the budget for exactly the
 * number of renders the build job will make. Two counts derived separately
 * would be two counts that drift, and the direction they drift in is billing
 * for renders that were refused.
 *
 * The test is the image age vocabulary's own floor
 * ({@link imageApparentAgeValue}), not merely the withheld-by-ruling
 * classification: a minor band is refused, and so is a band the vocabulary
 * cannot value at all. Those two differ only for a band nothing recognizes,
 * where the render fails its mandatory age anchor anyway — so the stricter
 * reading costs nothing and cannot be wrong in the expensive direction.
 *
 * This is a GATE, never a prompt instruction. Nothing about the character's age
 * reaches the model as a refusal; the view is simply not built.
 */
export function plannedReferenceViews(profile: Pick<CharacterProfile, "attributes">): readonly ReferenceView[] {
  const band = profile.attributes.find((entry) => entry.id === VISUAL_IMAGE_AGE_ATTRIBUTE_ID)?.value;
  const intimateAllowed = imageApparentAgeValue(band) !== null;
  return allReferenceViews().filter((view) => {
    if (!intimateAllowed) return referenceViewWardrobeById(view.wardrobe)?.intimate !== true;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Stored vocabulary
// ---------------------------------------------------------------------------

/**
 * A stored row's lifecycle position.
 *
 * `stale` and `superseded` are both terminal and both mean "this row no longer
 * describes the accepted portrait", but they say it about different things:
 * `superseded` is a row a newer reservation retired, `stale` is a row whose
 * render finished after the accepted pointer had already moved on. Both are kept
 * — re-accepting the earlier portrait revives what was rendered from it.
 */
export const referenceViewStatuses = ["pending", "ready", "rejected", "failed", "stale", "superseded"] as const;
export const referenceViewStatusSchema = z.enum(referenceViewStatuses);
export type ReferenceViewStatus = z.infer<typeof referenceViewStatusSchema>;

/** How a view's bytes came to exist. An upload is the owner's own answer when the render cannot give one. */
export const referenceViewMethods = ["rendered", "uploaded"] as const;
export const referenceViewMethodSchema = z.enum(referenceViewMethods);
export type ReferenceViewMethod = z.infer<typeof referenceViewMethodSchema>;

/**
 * What one slot IS, as the studio and every consumer read it — a PROJECTION over
 * the stored row, never a stored value.
 *
 * `missing` is a first-class state rather than an absent entry: the sheet always
 * reports every slot, so a grid with a hole in it is a hole the owner can act on
 * rather than a tile that failed to load.
 */
export const referenceViewStates = ["missing", "pending", "unreviewed", "approved", "rejected", "failed", "stale"] as const;
export const referenceViewStateSchema = z.enum(referenceViewStates);
export type ReferenceViewState = z.infer<typeof referenceViewStateSchema>;

export const referenceViewSummarySchema = z.object({
  angle: referenceViewAngleIdSchema,
  wardrobe: referenceViewWardrobeSchema,
  state: referenceViewStateSchema,
  /** The rendered or uploaded asset, when there is one. Null while pending and after a failure. */
  imageId: z.string().nullable(),
  method: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /**
   * This view may be sent to a render. The four conditions behind it live in
   * exactly one function ({@link isConsumableReferenceView}); nothing else
   * recomputes them, because a second reading of "usable" is how an unreviewed
   * or stale view reaches a scene.
   */
  consumable: z.boolean(),
});
export type ReferenceViewSummary = z.infer<typeof referenceViewSummarySchema>;

export const referenceViewSetSummarySchema = z.object({
  /** The portrait the whole sheet is measured against; null when nothing is accepted. */
  acceptedImageId: z.string().nullable(),
  /** A build job is in flight for this character. */
  building: z.boolean(),
  /** Always every `angles × wardrobes` slot, `missing` where no row exists. */
  views: z.array(referenceViewSummarySchema),
});
export type ReferenceViewSetSummary = z.infer<typeof referenceViewSetSummarySchema>;

/** Nothing built, nothing accepted — what a failed read degrades to. */
export function emptyReferenceViewSetSummary(): ReferenceViewSetSummary {
  return {
    acceptedImageId: null,
    building: false,
    views: allReferenceViews().map((view) => ({
      angle: view.angle,
      wardrobe: view.wardrobe,
      state: "missing" as const,
      imageId: null,
      method: null,
      reviewedAt: null,
      failureCode: null,
      failureMessage: null,
      updatedAt: null,
      consumable: false,
    })),
  };
}

/**
 * The stored facts a projection reads. Deliberately the narrowest shape that
 * decides the answer, so the rule can be exercised without a database.
 */
export interface ReferenceViewProjectionInput {
  /** The row is the slot's current one. A retired row can never be consumable. */
  readonly current: boolean;
  readonly status: ReferenceViewStatus;
  /** The portrait this row was rendered from. */
  readonly sourceImageId: string | null;
  /** The produced asset. */
  readonly imageId: string | null;
  /** The asset row's own status — a reserved-but-unwritten file is not a view. */
  readonly imageStatus: string | null;
  readonly generationVersion: number;
  readonly reviewedAt: Date | string | null;
  /** The character's accepted portrait right now. */
  readonly acceptedImageId: string | null;
}

/**
 * **The one consumability rule.** A view may be sent to a render iff all four
 * hold: it is the slot's current row and `ready` under the current generation
 * version, it was rendered from the portrait the character has accepted right
 * now, its asset exists and is itself `ready`, and the owner has reviewed it.
 *
 * The last condition is the point of the whole review step. A render the owner
 * has not looked at is a guess about what this character's back looks like, and
 * a guess that anchors every later scene is worse than no anchor at all.
 */
export function isConsumableReferenceView(row: ReferenceViewProjectionInput): boolean {
  return projectReferenceViewState(row) === "approved";
}

/**
 * One slot's state from its current row.
 *
 * Staleness is decided HERE, at read time, by comparing the row's source against
 * the character's accepted pointer — never by a background write. Re-accepting
 * the earlier portrait makes the same rows current again, which is only possible
 * because nothing rewrote them when the pointer moved.
 */
export function projectReferenceViewState(row: ReferenceViewProjectionInput): ReferenceViewState {
  if (row.status === "rejected") return "rejected";
  if (row.status === "failed") return "failed";
  if (row.status === "pending") return "pending";
  // A retired row, a row whose source is gone or is no longer what the character
  // accepted, a row with no asset or an asset that never became readable, and a
  // row built by wording this code no longer emits: all one answer, because the
  // owner's action is the same in every case — build this slot again.
  if (
    !row.current ||
    row.status === "stale" ||
    row.status === "superseded" ||
    row.sourceImageId === null ||
    row.acceptedImageId === null ||
    row.sourceImageId !== row.acceptedImageId ||
    row.imageId === null ||
    row.imageStatus !== "ready" ||
    row.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION
  ) {
    return "stale";
  }
  return row.reviewedAt === null ? "unreviewed" : "approved";
}

// ---------------------------------------------------------------------------
// The accept response's view outcome
// ---------------------------------------------------------------------------

/** Why an accept queued no build. Every one of them still ACCEPTED the portrait. */
export const referenceViewQueueRefusals = ["budget", "storage", "busy"] as const;
export const referenceViewQueueRefusalSchema = z.enum(referenceViewQueueRefusals);
export type ReferenceViewQueueRefusal = z.infer<typeof referenceViewQueueRefusalSchema>;

/**
 * What an accept (or a later build) did about the views.
 *
 * `queued: false` is never an error and never undoes the acceptance — the
 * pointer is already committed by the time this is decided. The studio offers to
 * build them later; the character is accepted either way.
 */
export const referenceViewQueueOutcomeSchema = z.object({
  queued: z.boolean(),
  reason: referenceViewQueueRefusalSchema.nullable().default(null),
  /** How many views the request would build — the registry count after the age gate. */
  planned: z.number(),
});
export type ReferenceViewQueueOutcome = z.infer<typeof referenceViewQueueOutcomeSchema>;
