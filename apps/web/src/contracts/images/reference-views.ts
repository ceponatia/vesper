import { z } from "zod";
import { fnv1a32 } from "@vesper/contracts";
import type { SceneFaceVisibility } from "@vesper/image-core";
import type { AttributeValue } from "../attributes/value";
import type { RegionExposure } from "../items/visibility";
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
 * The instruction states the same handedness twice, subject-relative first and
 * then the camera-relative consequence it forces, because an edit model resolves
 * a frame direction far more reliably than a possessive one: a subject who
 * starts facing the lens and turns until that own left side is toward it ends up
 * facing the frame's LEFT edge, with the own right side turned away from the
 * camera — and `side_right` is that geometry mirrored. Both halves are stated so
 * a model that reads only one of them still lands the same picture, and each
 * side entry is the other's exact left/right mirror so a half-finished edit to
 * one of them is visible rather than silently self-contradictory.
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
  /**
   * How a SCENE that sends this view introduces it — the clause appended to the
   * sentence that already names whose image it is ("Image 2 shows Mira, seen
   * from behind, the same person").
   *
   * Separate from {@link instruction}, which asks a model to MAKE the view. This
   * one tells a later render what the extra image already is, and it exists
   * because a second identity image of one person is otherwise a second person:
   * the model is told twice that an image shows Mira, and the honest reading of
   * two photographs is two women.
   *
   * No `{name}` template here, unlike every other phrase in this file: the
   * sentence it joins has already named the subject, so there is no unowned
   * region word for a possessive to bind. The other two rules still hold — no
   * limb nouns, positive phrasing only.
   */
  readonly sceneBinding: string;
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

/**
 * The head-to-ground clause every angle ends with, stated once.
 *
 * The camera vocabulary already asks for `full_figure`, and the compiler already
 * emits a framing line from it — yet a delta-edit model handed a portrait-shaped
 * reference will happily return another portrait-shaped crop, because the
 * strongest thing in the picture it is editing is a head. So the edit itself
 * names the two ends of the body it must keep, and it names them as places (the
 * top of the head, the floor underfoot) rather than as parts, since a limb noun
 * summons a limb. Positive throughout, like every line in this file: "uncropped"
 * would anchor on cropping.
 */
export const REFERENCE_VIEW_FULL_LENGTH_CLAUSE =
  "the whole of {name} inside the frame, from the top of {name}'s head down to the floor {name} stands on, with clear space above and below";

export const referenceViewAngles: readonly ReferenceViewAngle[] = [
  {
    id: "front_full",
    camera: { orientation: "toward_viewer", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_front_full",
    sceneBinding: "seen at full length, the same person",
    instruction: `{name} standing squarely facing the camera, ${REFERENCE_VIEW_FULL_LENGTH_CLAUSE}`,
    label: "Front, full length",
  },
  {
    id: "back_full",
    camera: { orientation: "away", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_back_full",
    sceneBinding: "seen from behind, the same person",
    instruction: `{name} standing with {name}'s back to the camera, {name}'s head turned away from the lens, ${REFERENCE_VIEW_FULL_LENGTH_CLAUSE}`,
    label: "Back, full length",
  },
  {
    // The handedness is stated in the instruction because the camera vocabulary
    // cannot state it, and it is stated subject-relative AND camera-relative
    // because a model resolves a frame direction more reliably than a possessive
    // one — see this file's header, under "Which side is which". The two side
    // entries are exact left/right mirrors of each other; the registry's test
    // suite is the pin.
    id: "side_left",
    camera: { orientation: "profile", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_side_left",
    sceneBinding: "seen in profile, the same person",
    instruction:
      "{name} standing in a full side-on profile, {name}'s own left side toward the camera and " +
      "{name}'s own right side turned away from it, {name} facing toward the left edge of the frame, " +
      `{name}'s head side-on to the lens and turned the same way as {name}'s body, ${REFERENCE_VIEW_FULL_LENGTH_CLAUSE}`,
    label: "Left side",
  },
  {
    id: "side_right",
    camera: { orientation: "profile", distance: REFERENCE_VIEW_FRAMING, height: "eye_level" },
    cameraId: "reference_view_side_right",
    sceneBinding: "seen in profile, the same person",
    instruction:
      "{name} standing in a full side-on profile, {name}'s own right side toward the camera and " +
      "{name}'s own left side turned away from it, {name} facing toward the right edge of the frame, " +
      `{name}'s head side-on to the lens and turned the same way as {name}'s body, ${REFERENCE_VIEW_FULL_LENGTH_CLAUSE}`,
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
  /**
   * The wardrobe of the SAME angle's view this one is built from, or null for a
   * view built from the root angle's view in its own wardrobe — see
   * {@link referenceViewUpstream}. `bare` builds from its own angle dressed, so
   * the body an undressed view shows is the body that angle already shows.
   */
  readonly buildsFrom: ReferenceViewWardrobe | null;
  /**
   * How a view in this wardrobe introduces its same-angle upstream view — the
   * clause woven into the sentence that already names whose image it is, the
   * way {@link ReferenceViewAngle.sceneBinding} is for a scene. Null exactly
   * when {@link buildsFrom} is. No `{name}` template, for `sceneBinding`'s
   * reason; the other two phrasing rules hold.
   */
  readonly buildsFromBinding: string | null;
}

export const referenceViewWardrobeEntries: readonly ReferenceViewWardrobeEntry[] = [
  {
    id: "clothed",
    label: "As dressed",
    // The reference image already shows the garments; naming them would invite
    // the model to redesign them. The clause only pins them in place.
    instruction: "{name} wearing exactly the clothing the reference shows, changing nothing else about the garments",
    intimate: false,
    buildsFrom: null,
    buildsFromBinding: null,
  },
  {
    id: "bare",
    label: "Undressed",
    instruction: "{name} undressed, wearing nothing at all, {name}'s bare skin in plain view",
    intimate: true,
    // The upstream image shows this same angle dressed. The clause says what
    // that image IS and which body it carries; the wardrobe instruction above
    // says what this render does to it.
    buildsFrom: "clothed",
    buildsFromBinding: "seen from this same angle while dressed, the same person with the same body to show undressed",
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
 * Bumped when instruction wording, the shared full-length clause, the background
 * clause, or the way the parts are assembled changes. A stored row whose version
 * is behind the current one projects `stale`: it depicts an edit this code no
 * longer asks for.
 */
export const REFERENCE_VIEW_GENERATION_VERSION = 1;

/** The whole sheet: every angle in every wardrobe state, in registry order. */
export function allReferenceViews(): readonly ReferenceView[] {
  return referenceViewAngles.flatMap((angle) =>
    referenceViewWardrobeEntries.map((wardrobe) => ({ angle: angle.id, wardrobe: wardrobe.id })),
  );
}

// ---------------------------------------------------------------------------
// Build order
// ---------------------------------------------------------------------------

/**
 * **THE BUILD ORDER** — which approved view each view's body is rendered from.
 *
 * Rendered independently, the views are separate guesses at one body below the
 * waist, and they disagree. So the sheet has a ROOT — the root angle, dressed —
 * and every other view renders with an approved view of the same person beside
 * the portrait: each other angle from the root angle in its own wardrobe, and
 * each undressed view from its own angle dressed, so the body it undresses is
 * the body that angle already shows. A pure function of the registries: a new
 * angle builds from the root, and a wardrobe states what it builds from
 * ({@link ReferenceViewWardrobeEntry.buildsFrom}).
 *
 * The studio's controls and the server's queue both read it — which slots may
 * build now, what an approval builds — so the count an owner is shown and the
 * count the budget is charged come from one rule.
 */
export const REFERENCE_VIEW_ROOT_ANGLE: ReferenceViewAngleId = "front_full";

/**
 * How a view built from the root angle's view introduces it — the cross-angle
 * counterpart of {@link ReferenceViewWardrobeEntry.buildsFromBinding}, held to
 * the same phrasing rules.
 */
export const REFERENCE_VIEW_ROOT_ANGLE_BINDING = "seen from the front in the same clothing, the same person with the same body";

/** Two slots are the same slot. */
export function sameReferenceView(left: ReferenceView, right: ReferenceView): boolean {
  return left.angle === right.angle && left.wardrobe === right.wardrobe;
}

/**
 * The view this one is built from, or null for a root view.
 *
 * A wardrobe that names a `buildsFrom` builds from its own angle in that
 * wardrobe; every other view builds from the root angle in its own wardrobe,
 * and the root angle's own view in such a wardrobe is a root. Null too for a
 * wardrobe the registry has dropped — a view nothing can render builds from
 * nothing.
 */
export function referenceViewUpstream(view: ReferenceView): ReferenceView | null {
  const wardrobe = referenceViewWardrobeById(view.wardrobe);
  if (wardrobe === undefined) return null;
  if (wardrobe.buildsFrom !== null) return { angle: view.angle, wardrobe: wardrobe.buildsFrom };
  return view.angle === REFERENCE_VIEW_ROOT_ANGLE ? null : { angle: REFERENCE_VIEW_ROOT_ANGLE, wardrobe: view.wardrobe };
}

/** The views built directly from this one, in registry order. */
export function referenceViewDependents(view: ReferenceView): readonly ReferenceView[] {
  return allReferenceViews().filter((candidate) => {
    const upstream = referenceViewUpstream(candidate);
    return upstream !== null && sameReferenceView(upstream, view);
  });
}

/**
 * Every view this one is built from, nearest first: its upstream, that view's
 * upstream, and on to the root. Empty for a root view.
 */
export function referenceViewAncestors(view: ReferenceView): ReferenceView[] {
  const bound = allReferenceViews().length;
  const ancestors: ReferenceView[] = [];
  let upstream = referenceViewUpstream(view);
  // Bounded by the sheet's size, so a registry edit that made the graph cyclic
  // stops here instead of looping; such a view simply never has an approved
  // upstream, and waits.
  while (upstream !== null && ancestors.length < bound) {
    ancestors.push(upstream);
    upstream = referenceViewUpstream(upstream);
  }
  return ancestors;
}

/** Every view built from this one, directly or through another view, in registry order. */
export function referenceViewDescendants(view: ReferenceView): ReferenceView[] {
  return allReferenceViews().filter((candidate) =>
    referenceViewAncestors(candidate).some((ancestor) => sameReferenceView(ancestor, view)),
  );
}

/** Every view, each one after the view it is built from; registry order within a level. */
export function referenceViewBuildOrder(): readonly ReferenceView[] {
  return [...allReferenceViews()].sort(
    (left, right) => referenceViewAncestors(left).length - referenceViewAncestors(right).length,
  );
}

/**
 * The targets of ONE request that are built — directly or through another
 * view — from another target of that same request.
 *
 * Such a target cannot be rendered by that request: its upstream is about to
 * be replaced by the request's own new attempt, so its worker would either
 * find no approved upstream and render nothing, or render from the attempt
 * being superseded and land stale — either way a charge with nothing usable to
 * show for it. It waits instead, and the new upstream's approval builds it.
 * The regenerate route refuses a request that names one, and the studio leaves
 * it out of a selection, by this one rule. PURE.
 */
export function referenceViewsWaitingInBatch(targets: readonly ReferenceView[]): ReferenceView[] {
  return targets
    .filter((target) =>
      referenceViewAncestors(target).some((ancestor) => targets.some((other) => sameReferenceView(other, ancestor))),
    )
    .map((target) => ({ angle: target.angle, wardrobe: target.wardrobe }));
}

/**
 * How this view's render introduces the upstream view it is built from, or
 * null for a root view.
 *
 * The clause is the registry's, never the lane's: a second identity image of
 * one person reads as a second person unless something says why it is there,
 * and the vocabulary that orders the build is the only thing that can say it
 * honestly. Each dialect weaves it into its own sentence for the slot
 * (`docs/images/prompt-programs.md` §Reference slots).
 */
export function referenceViewUpstreamBinding(view: ReferenceView): string | null {
  const upstream = referenceViewUpstream(view);
  if (upstream === null) return null;
  if (upstream.angle !== view.angle) return REFERENCE_VIEW_ROOT_ANGLE_BINDING;
  return referenceViewWardrobeById(view.wardrobe)?.buildsFromBinding ?? null;
}

// ---------------------------------------------------------------------------
// The age gate
// ---------------------------------------------------------------------------

/**
 * THE image age gate for intimate work: whether a character's
 * `identity.apparent_age` resolves to a value the image age vocabulary carries
 * — the adult floor ({@link imageApparentAgeValue}).
 *
 * One rule for every lane that renders intimate content: the `bare` reference
 * views ({@link plannedReferenceViews}), the portrait studio's `nsfw_test`
 * bench, and an intimate chat scene, where any subject failing it takes the
 * whole render off the intimate route. A minor band fails, and so does a band
 * the vocabulary cannot value or no band at all — the stricter reading, which
 * cannot be wrong in the expensive direction.
 *
 * EVERY `identity.apparent_age` entry must value as an adult, and at least one
 * must exist. A profile may carry the attribute more than once — authored,
 * manual, magic — and `resolveAttributes` picks one by source precedence; the
 * value a cut states is always one of those entries, so requiring all of them
 * is at least as strict as resolving and cannot be wrong in the expensive
 * direction, however the precedence rule moves. Reading only the first entry
 * could pass an adult while the cut's own age anchor resolved a minor.
 *
 * Takes any attribute list, so a lane can ask it of the authored sheet and of
 * the resolved attributes a render actually states. PURE.
 */
export function imageAgeAllowsIntimate(profile: { readonly attributes: readonly AttributeValue[] }): boolean {
  const bands = profile.attributes.filter((entry) => entry.id === VISUAL_IMAGE_AGE_ATTRIBUTE_ID);
  return bands.length > 0 && bands.every((entry) => imageApparentAgeValue(entry.value) !== null);
}

/**
 * The views an explicit full-sheet build will create for this character,
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
  const intimateAllowed = imageAgeAllowsIntimate(profile);
  return allReferenceViews().filter((view) => {
    if (!intimateAllowed) return referenceViewWardrobeById(view.wardrobe)?.intimate !== true;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Target normalization
// ---------------------------------------------------------------------------

/** One slot as a comparable string. Private: the wire spellings are the pair, never this. */
function slotKey(view: ReferenceView): string {
  return `${view.angle}:${view.wardrobe}`;
}

/** What a requested list of slots actually resolves to. */
export interface NormalizedReferenceViewTargets {
  /** The slots to build: deduplicated, restricted to the plan, in the order they were first named. */
  readonly targets: readonly ReferenceView[];
  /** The requested slots the plan has no entry for — age-gated or unknown — deduplicated the same way. */
  readonly refused: readonly ReferenceView[];
}

/**
 * The slots a request may actually build, and the ones nothing can.
 *
 * PURE, and the single normalization every caller shares: the routes decide what
 * to answer a client with, and the build job runs it again over whatever it was
 * handed, so a duplicate slot cannot be charged twice by one path and rendered
 * twice by another.
 *
 * Two rules, both of which are silent money when they break:
 *
 * 1. **One attempt per slot.** A request naming the same slot twice is one
 *    target. Two simultaneous attempts on one slot would supersede each other
 *    mid-render, so the second render's only product is a charge.
 * 2. **The plan is the boundary.** {@link plannedReferenceViews} has already
 *    spent the age gate, so a slot outside it is refused here rather than
 *    dropped quietly: an owner who asked for a view by name is told it does not
 *    exist, and nothing about the character's age reaches a model.
 */
export function normalizeReferenceViewTargets(
  requested: readonly ReferenceView[],
  planned: readonly ReferenceView[],
): NormalizedReferenceViewTargets {
  const allowed = new Set(planned.map(slotKey));
  const seen = new Set<string>();
  const targets: ReferenceView[] = [];
  const refused: ReferenceView[] = [];
  for (const view of requested) {
    const key = slotKey(view);
    if (seen.has(key)) continue;
    seen.add(key);
    (allowed.has(key) ? targets : refused).push({ angle: view.angle, wardrobe: view.wardrobe });
  }
  return { targets, refused };
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
export const referenceViewStates = ["missing", "pending", "unreviewed", "approved", "rejected", "failed", "stale", "ineligible"] as const;
export const referenceViewStateSchema = z.enum(referenceViewStates);
export type ReferenceViewState = z.infer<typeof referenceViewStateSchema>;

/** Optional owner feedback; recorded as provenance, never a generation instruction. */
export const referenceViewFeedbackReasons = ["wrong_outfit", "wrong_angle", "identity_mismatch", "image_defect"] as const;
export const referenceViewFeedbackSchema = z.object({
  reasons: z.array(z.enum(referenceViewFeedbackReasons)).max(referenceViewFeedbackReasons.length),
  correction: z.string().trim().max(1000),
});
export type ReferenceViewFeedback = z.infer<typeof referenceViewFeedbackSchema>;

export const referenceViewReviewRequestSchema = z.object({
  attemptId: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  verdict: z.enum(["approve", "reject", "undo"]),
  feedback: referenceViewFeedbackSchema.optional(),
});
export type ReferenceViewReviewRequest = z.infer<typeof referenceViewReviewRequestSchema>;

export const referenceViewRestoreRequestSchema = z.object({
  attemptId: z.string().min(1).max(128),
  expectedCurrentAttemptId: z.string().min(1).max(128).nullable(),
  expectedCurrentRevision: z.number().int().nonnegative(),
});

export const referenceViewSummarySchema = z.object({
  angle: referenceViewAngleIdSchema,
  wardrobe: referenceViewWardrobeSchema,
  state: referenceViewStateSchema,
  attemptId: z.string().nullable().default(null),
  reviewRevision: z.number().int().nonnegative().default(0),
  feedback: referenceViewFeedbackSchema.nullable().default(null),
  /** The rendered or uploaded asset, when there is one. Null while pending and after a failure. */
  imageId: z.string().nullable(),
  method: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /**
   * This view may be sent to a render. The conditions behind it live in
   * exactly one function ({@link isConsumableReferenceView}); nothing else
   * recomputes them, because a second reading of "usable" is how an unreviewed
   * or stale view reaches a scene.
   */
  consumable: z.boolean(),
  /**
   * The upstream slot this one is built from ({@link referenceViewUpstream})
   * while that slot has no approved current attempt. Nothing may build this
   * slot until it does, so the studio shows a waiting state in place of a build
   * control. Null for a root view and for a slot whose upstream is approved.
   */
  waitingOn: referenceViewSchema.nullable().default(null),
  /**
   * What approving this slot's current attempt would build right now — its
   * dependents that would then be missing, failed or stale. Empty unless the
   * slot is `unreviewed`. The Approve control states it, and the review route
   * charges the same rule's answer after the write.
   */
  approvalBuilds: z.array(referenceViewSchema).max(32).default([]),
  /**
   * What installing an upload in this slot would build right now — an upload
   * arrives approved, so it builds what an approval of a NEW attempt would.
   */
  uploadBuilds: z.array(referenceViewSchema).max(32).default([]),
});
export type ReferenceViewSummary = z.infer<typeof referenceViewSummarySchema>;

export const referenceViewSetSummarySchema = z.object({
  /** The portrait the whole sheet is measured against; null when nothing is accepted. */
  acceptedImageId: z.string().nullable(),
  /** A build job is in flight for this character. */
  building: z.boolean(),
  /** Always every `angles × wardrobes` slot; a plan-withheld slot is `ineligible`. */
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
      attemptId: null,
      reviewRevision: 0,
      feedback: null,
      imageId: null,
      method: null,
      reviewedAt: null,
      failureCode: null,
      failureMessage: null,
      updatedAt: null,
      consumable: false,
      waitingOn: null,
      approvalBuilds: [],
      uploadBuilds: [],
    })),
  };
}

/**
 * The stored facts a projection reads. Deliberately the narrowest shape that
 * decides the answer, so the rule can be exercised without a database.
 */
export interface ReferenceViewProjectionInput {
  /** The slot is present in the character's current age-gated plan. */
  readonly eligible: boolean;
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
  /**
   * The upstream attempt this row was rendered from ({@link referenceViewUpstream}),
   * or null/absent for a row rendered from no upstream view: a root view, an
   * upload, a render whose model had no room for the upstream image, and every
   * row built before the build order existed.
   */
  readonly upstreamViewId?: string | null;
  /** The upstream slot's approved current attempt right now, or null/absent when it has none. */
  readonly approvedUpstreamId?: string | null;
  /**
   * How the row's bytes came to exist (`referenceViewMethods`). An upload was
   * rendered from no body image, so the body-image rule never applies to it,
   * exactly as the upstream rule never applies to a row that records none.
   */
  readonly method?: string | null;
  /**
   * The body-image set this row was rendered against (`bodyReferenceSetKey`,
   * `contracts/images/body-references.ts`). Null or absent is the EMPTY set —
   * every row rendered before body images existed — never "unknown".
   */
  readonly bodyReferenceSet?: string | null;
  /** The character's body-image set right now; null or absent when it has none. */
  readonly currentBodyReferenceSet?: string | null;
}

/**
 * **The one consumability rule.** A view may be sent to a render iff all seven
 * hold: it is the slot's current row and `ready` under the current generation
 * version, it was rendered from the portrait the character has accepted right
 * now, a view rendered from an upstream view was rendered from that slot's
 * approved current attempt, a rendered view was rendered against the
 * character's current body-image set, its asset exists and is itself `ready`,
 * the owner has reviewed it, and the slot remains in the character's current
 * age-gated plan.
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
 *
 * The build order is held to the same rule: a view rendered from an upstream
 * view is stale once that view is no longer its slot's approved current
 * attempt — superseded, undone, or itself stale — and a row that records no
 * upstream is never stale by it.
 *
 * So are the body images (#671): a RENDERED view is stale once the set it was
 * rendered against differs from the character's set now — an image added,
 * replaced, removed or re-tagged. A row that records none was rendered against
 * the empty set, so a character's first body image makes the sheet stale and a
 * character who never adds one sees no change. An upload is exempt: it was
 * rendered from nothing.
 */
export function projectReferenceViewState(row: ReferenceViewProjectionInput): ReferenceViewState {
  // Eligibility outranks the row's old verdict. An approved bare attempt must
  // stop being usable as soon as the character's apparent age becomes minor or
  // unresolved, even though its stored review provenance remains intact.
  if (!row.eligible) return "ineligible";
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
    row.generationVersion !== REFERENCE_VIEW_GENERATION_VERSION ||
    ((row.upstreamViewId ?? null) !== null && row.upstreamViewId !== (row.approvedUpstreamId ?? null)) ||
    referenceViewBodySetMoved(row)
  ) {
    return "stale";
  }
  return row.reviewedAt === null ? "unreviewed" : "approved";
}

/**
 * Whether a view was rendered against a body-image set other than the
 * character's set now — the one comparison the projection, review and
 * restoration share. An uploaded view never moves by it.
 */
export function referenceViewBodySetMoved(row: {
  readonly method?: string | null;
  readonly bodyReferenceSet?: string | null;
  readonly currentBodyReferenceSet?: string | null;
}): boolean {
  if (row.method === "uploaded") return false;
  return (row.bodyReferenceSet ?? null) !== (row.currentBodyReferenceSet ?? null);
}

// ---------------------------------------------------------------------------
// The whole sheet, projected in build order
// ---------------------------------------------------------------------------

/** One slot's current attempt as the sheet projection reads it. */
export interface ReferenceViewSlotRow extends Omit<ReferenceViewProjectionInput, "eligible" | "approvedUpstreamId"> {
  readonly attemptId: string;
}

/** One slot's stored facts: whether the plan holds it, and its current attempt if it has one. */
export interface ReferenceViewSlotFacts {
  readonly view: ReferenceView;
  readonly eligible: boolean;
  readonly row: ReferenceViewSlotRow | null;
}

/** One slot as the sheet projection answers it. */
export interface ReferenceViewSlotProjection extends ReferenceView {
  readonly state: ReferenceViewState;
  readonly consumable: boolean;
  /** The upstream slot this one waits on — see {@link ReferenceViewSummary.waitingOn}. */
  readonly waitingOn: ReferenceView | null;
}

/**
 * An attempt to treat as approved in a what-if projection: an approval about to
 * be written, or — with `attemptId` null — an upload about to be installed, a
 * new attempt no stored row was rendered from.
 */
export interface ReferenceViewAssumedApproval {
  readonly view: ReferenceView;
  readonly attemptId: string | null;
}

/**
 * Every slot's state, waiting status and consumability, in the caller's order.
 *
 * Projected in {@link referenceViewBuildOrder} because a slot's staleness reads
 * its upstream's projected answer: a bare view whose clothed view went stale
 * because the front moved is stale with it, and nothing but the order of
 * evaluation carries that down. PURE.
 *
 * `assume` answers "what would this sheet be if that attempt were approved",
 * which is the question the Approve control and the upload dialog ask before
 * the write and the review route asks again after it — one projection, so the
 * disclosed count and the charged count cannot be computed two ways.
 */
export function projectReferenceViewSlots(
  slots: readonly ReferenceViewSlotFacts[],
  assume?: ReferenceViewAssumedApproval,
): ReferenceViewSlotProjection[] {
  const factsBySlot = new Map(slots.map((slot) => [slotKey(slot.view), slot]));
  // A slot is here iff it has an approved current attempt (or the assumption
  // gives it one); the value is that attempt, null for an assumed new one.
  const approved = new Map<string, string | null>();
  const projected = new Map<string, ReferenceViewSlotProjection>();
  for (const view of referenceViewBuildOrder()) {
    const key = slotKey(view);
    const facts = factsBySlot.get(key);
    if (facts === undefined) continue;
    const upstream = referenceViewUpstream(view);
    const upstreamKey = upstream === null ? null : slotKey(upstream);
    const upstreamApproved = upstreamKey !== null && approved.has(upstreamKey);
    const input: ReferenceViewProjectionInput | null =
      facts.row === null
        ? null
        : {
            ...facts.row,
            eligible: facts.eligible,
            approvedUpstreamId: upstreamKey === null ? null : (approved.get(upstreamKey) ?? null),
          };
    const state: ReferenceViewState =
      input === null ? (facts.eligible ? "missing" : "ineligible") : projectReferenceViewState(input);
    if (assume !== undefined && sameReferenceView(assume.view, view)) approved.set(key, assume.attemptId);
    else if (state === "approved" && facts.row !== null) approved.set(key, facts.row.attemptId);
    projected.set(key, {
      angle: view.angle,
      wardrobe: view.wardrobe,
      state,
      consumable: input !== null && isConsumableReferenceView(input),
      waitingOn: upstream !== null && !upstreamApproved ? upstream : null,
    });
  }
  return slots.flatMap((slot) => {
    const entry = projected.get(slotKey(slot.view));
    return entry === undefined ? [] : [entry];
  });
}

/** What a build re-renders. Never `rejected`: the owner said no to that view. */
const BUILDABLE_STATES: ReadonlySet<ReferenceViewState> = new Set<ReferenceViewState>(["missing", "failed", "stale"]);

/** The slot-and-state shape both a projection and a wire summary carry. */
export type ReferenceViewBuildFacts = ReferenceView & {
  readonly state: ReferenceViewState;
  readonly waitingOn: ReferenceView | null;
};

/**
 * The slots a build may start now: missing, failed or stale, and not waiting on
 * an upstream view nobody has approved. On a fresh character that is the root
 * view alone. `rejected` is never rebuilt in bulk, and a plan-withheld slot is
 * `ineligible` rather than missing.
 */
export function referenceViewsReadyToBuild(views: readonly ReferenceViewBuildFacts[]): ReferenceView[] {
  return views
    .filter((view) => BUILDABLE_STATES.has(view.state) && view.waitingOn === null)
    .map((view) => ({ angle: view.angle, wardrobe: view.wardrobe }));
}

/**
 * What approving `approved` builds: its direct dependents that are ready to
 * build once it is approved. Asked of the sheet AFTER the approval, it is the
 * review route's queue; asked of a what-if projection BEFORE it
 * ({@link referenceViewBuildsOnApproval}), it is the Approve control's count.
 */
export function referenceViewDependentsToBuild(
  views: readonly ReferenceViewBuildFacts[],
  approved: ReferenceView,
): ReferenceView[] {
  return referenceViewsReadyToBuild(views).filter((view) => {
    const upstream = referenceViewUpstream(view);
    return upstream !== null && sameReferenceView(upstream, approved);
  });
}

/** {@link referenceViewDependentsToBuild} over the sheet as it would be with `approval` written. */
export function referenceViewBuildsOnApproval(
  slots: readonly ReferenceViewSlotFacts[],
  approval: ReferenceViewAssumedApproval,
): ReferenceView[] {
  return referenceViewDependentsToBuild(projectReferenceViewSlots(slots, approval), approval.view);
}

// ---------------------------------------------------------------------------
// Reference-view queue outcomes
// ---------------------------------------------------------------------------

/** Why an explicit reference-view request queued no build. */
export const referenceViewQueueRefusals = ["budget", "storage", "busy"] as const;
export const referenceViewQueueRefusalSchema = z.enum(referenceViewQueueRefusals);
export type ReferenceViewQueueRefusal = z.infer<typeof referenceViewQueueRefusalSchema>;

export const referenceViewTargetQueueStates = ["queued", "busy", "budget", "storage"] as const;
export const referenceViewTargetQueueStateSchema = z.enum(referenceViewTargetQueueStates);
export const referenceViewTargetQueueOutcomeSchema = referenceViewSchema.extend({
  state: referenceViewTargetQueueStateSchema,
});
export type ReferenceViewTargetQueueOutcome = z.infer<typeof referenceViewTargetQueueOutcomeSchema>;

/**
 * What an explicit build or regeneration request did about the views.
 * `queued: false` is a recoverable admission outcome rather than a failed
 * portrait-selection write.
 */
export const referenceViewQueueOutcomeSchema = z.object({
  queued: z.boolean(),
  reason: referenceViewQueueRefusalSchema.nullable().default(null),
  /** How many views the request would build — the registry count after the age gate. */
  planned: z.number(),
  /** How many requested slots this call newly leased and charged. */
  admitted: z.number().int().nonnegative().default(0),
  /** One exact outcome per normalized requested target, in request order. */
  targets: z.array(referenceViewTargetQueueOutcomeSchema).max(32).default([]),
});
export type ReferenceViewQueueOutcome = z.infer<typeof referenceViewQueueOutcomeSchema>;

// ---------------------------------------------------------------------------
// Selection — which view a resolved shot wants
// ---------------------------------------------------------------------------

/**
 * The two axes a render resolves independently, and the caller's tie-breaker.
 *
 * The camera is the RESOLVED one (`SceneRenderPlan.camera`, after
 * `resolveScenePlan` has spent every evidence gate), never a proposal: a
 * staging entry that survived has already overwritten it, so nothing else needs
 * to be consulted about where the shot is taken from.
 *
 * `exposure` is the subject's OWN computed coverage — the same `RegionExposure`
 * the prompt derives its exposure claims from — because "is this character
 * undressed in this scene" is a fact about their worn items, never a flag
 * somebody set. Null (a lane that computes no coverage) counts as covered.
 */
export interface ReferenceViewSelectionInput {
  readonly camera: SceneCameraSpec;
  readonly exposure: RegionExposure | null;
  /** The lane's intimate permission — the gate `bare` may never cross. */
  readonly allowIntimate: boolean;
  /**
   * What the side of a profile shot is decided from. The caller passes
   * `characterId + chatId` (or the character id alone outside a chat) so one
   * character keeps ONE side for a whole conversation — see
   * {@link selectReferenceView}.
   */
  readonly sideKey: string;
}

/**
 * Which view this shot wants, or why none does.
 *
 * `no_rule` is the ordinary answer, not a failure: three of the five
 * orientations and most distances have no exact match in a four-angle sheet,
 * and the front-facing portrait keeps anchoring all of them.
 */
export type ReferenceViewSelection =
  | { readonly view: ReferenceView; readonly faceVisibility: SceneFaceVisibility }
  | { readonly view: null; readonly reason: "no_rule" };

const NO_RULE: ReferenceViewSelection = { view: null, reason: "no_rule" };

/**
 * Which side of a profile shot this character shows, decided from the caller's
 * key rather than picked.
 *
 * The camera vocabulary says `profile` and stops — side-on, with no handedness —
 * so something has to choose, and a random choice flips the same character
 * between her left and her right in two consecutive scenes of one conversation.
 * A hash parity over a key the caller keeps stable is the cheapest thing that
 * cannot flip: the same character in the same chat resolves to the same side
 * forever, and two different characters land on the two sides independently.
 *
 * Even ⇒ `side_left`, odd ⇒ `side_right`. The mapping is pinned by golden
 * values in this file's test, because both halves of the promise — stability
 * and the actual side — are invisible until someone compares two renders.
 */
function profileAngleFor(sideKey: string): ReferenceViewAngleId {
  return fnv1a32(sideKey) % 2 === 0 ? "side_left" : "side_right";
}

/**
 * The angle a resolved shot wants, or null when the sheet has no exact match.
 *
 * FOUR angles, not six (owner ruling): a three-quarter turn is a shot the sheet
 * cannot answer honestly — neither the front nor a side depicts it — and
 * anchoring it on an approximation would make the render argue with itself.
 * It falls through to the front-facing portrait, exactly as it does today.
 *
 * `away_glance_back` takes the back view with `away`: the body is turned away in
 * both, and the glance is a fact about the head that the scene's own camera
 * phrase states. The full-length front view is claimed only by a shot that
 * actually frames the whole body — a medium or close front shot is what the
 * portrait already is.
 */
function angleFor(camera: SceneCameraSpec, sideKey: string): ReferenceViewAngleId | null {
  switch (camera.orientation) {
    case "away":
    case "away_glance_back":
      return "back_full";
    case "profile":
      return profileAngleFor(sideKey);
    case "toward_viewer":
      return camera.distance === "full_figure" || camera.distance === "wide" ? "front_full" : null;
    case "three_quarter":
      return null;
  }
}

/**
 * The wardrobe state this scene has the character in.
 *
 * **Default-shut in both directions.** `bare` needs the torso AND the pelvis
 * both reading `bare` on the subject's own coverage readout, and it needs the
 * lane's intimate permission; anything else — a partial undress, a `sheer`
 * region, coverage nobody computed, or a route that may not carry intimate
 * content — is `clothed`. Missing coverage counts as covered, which is the
 * conservative direction: an undressed scene anchored on the clothed view is a
 * render that under-states, and a clothed scene anchored on the bare view is a
 * render nobody asked for.
 *
 * The partial-undress threshold lives HERE and nowhere else, so moving it is one
 * edit rather than an archaeology exercise.
 */
function wardrobeFor(exposure: RegionExposure | null, allowIntimate: boolean): ReferenceViewWardrobe {
  if (!allowIntimate || exposure === null) return "clothed";
  return exposure.torso === "bare" && exposure.pelvis === "bare" ? "bare" : "clothed";
}

/**
 * The view a resolved shot wants, PURE.
 *
 * The two axes resolve independently — the angle from the camera, the wardrobe
 * from the subject's coverage — and neither can veto the other: a back shot of
 * an undressed character asks for the bare back view, and the same shot on a
 * lane without intimate permission asks for the clothed one.
 *
 * Selecting a view is not the same as having one. Whether the selected slot has
 * been built, reviewed and is still current is the store's question
 * ({@link isConsumableReferenceView}), and every answer but yes degrades to the
 * front-anchored render this function's `no_rule` already produces.
 */
export function selectReferenceView(input: ReferenceViewSelectionInput): ReferenceViewSelection {
  const angleId = angleFor(input.camera, input.sideKey);
  if (angleId === null) return NO_RULE;
  const angle = referenceViewAngleById(angleId);
  // Unreachable while `angleFor` names registry ids, and written as a degrade
  // anyway: an angle the registry dropped is a view nothing can consume, which
  // is the same outcome as no rule at all.
  if (angle === undefined) return NO_RULE;
  return {
    view: { angle: angle.id, wardrobe: wardrobeFor(input.exposure, input.allowIntimate) },
    faceVisibility: referenceViewFaceVisibility(angle),
  };
}

// ---------------------------------------------------------------------------
// The recorded verdict, and one slot's history
// ---------------------------------------------------------------------------

/**
 * The owner's ruling on one attempt, STORED — a fact about a moment, not a
 * status.
 *
 * `status` cannot carry it. A retired row's status is overwritten with
 * `superseded` the instant the next attempt claims the slot, so a rejection and
 * an approval read identically the moment either is replaced, and a history
 * built from `status` would tell the owner nothing about what they already
 * ruled. Review or upload records it; explicit Undo clears the last verdict on
 * the current attempt. Supersession never clears it.
 */
export const referenceViewVerdicts = ["approved", "rejected"] as const;
export const referenceViewVerdictSchema = z.enum(referenceViewVerdicts);
export type ReferenceViewVerdict = z.infer<typeof referenceViewVerdictSchema>;

/**
 * What a history entry says happened to one attempt: the stored verdict, or
 * `unreviewed` for an attempt that was replaced before anybody ruled on it.
 *
 * A third member rather than a nullable verdict, because "nobody looked at this
 * one" is a real and common outcome — a regenerate fired the moment a render
 * landed — and a hole in a list reads as missing data rather than as an answer.
 */
export const referenceViewHistoryVerdicts = ["approved", "rejected", "unreviewed"] as const;
export const referenceViewHistoryVerdictSchema = z.enum(referenceViewHistoryVerdicts);
export type ReferenceViewHistoryVerdict = z.infer<typeof referenceViewHistoryVerdictSchema>;

/**
 * **The one history-verdict rule.** PURE, and read by every surface that shows a
 * past attempt.
 *
 * Two sources, because rows written before the verdict column existed have only
 * the status: a `rejected` status IS a rejection, and a `ready` row with a
 * review stamp IS an approval. The stored verdict wins wherever it is present,
 * and it is the only source that survives supersession — which is exactly why a
 * reading built on `status` alone is wrong for every retired row.
 */
export function referenceViewHistoryVerdict(row: {
  readonly status: ReferenceViewStatus;
  readonly verdict: ReferenceViewVerdict | null;
  readonly reviewedAt: Date | string | null;
}): ReferenceViewHistoryVerdict {
  if (row.verdict === "rejected" || row.status === "rejected") return "rejected";
  if (row.verdict === "approved" || (row.status === "ready" && row.reviewedAt !== null)) return "approved";
  return "unreviewed";
}

/**
 * One attempt as the studio's history list reads it.
 *
 * Only attempts that still HAVE something to look at reach this shape: a row
 * whose render failed never had bytes, and a retired row whose asset the
 * retention sweep collected no longer does. Both are dropped rather than listed
 * as blanks — the list exists to compare pictures, and a row with no picture is
 * not evidence.
 */
export const referenceViewHistoryEntrySchema = z.object({
  id: z.string(),
  /** Never null: an entry with no readable asset is not listed at all. */
  imageId: z.string(),
  method: referenceViewMethodSchema.nullable(),
  verdict: referenceViewHistoryVerdictSchema,
  feedback: referenceViewFeedbackSchema.nullable().default(null),
  restoreUnavailable: z.enum(["current", "expired", "incompatible", "ineligible", "busy", "unavailable"]).nullable().default("unavailable"),
  /** This attempt is the slot's current one — what the studio tile shows. */
  current: z.boolean(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  generationVersion: z.number(),
  /** The accepted portrait this attempt was rendered from. */
  sourceImageId: z.string().nullable(),
});
export type ReferenceViewHistoryEntry = z.infer<typeof referenceViewHistoryEntrySchema>;
