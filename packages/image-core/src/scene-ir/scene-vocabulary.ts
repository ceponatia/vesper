import { z } from "zod";

/**
 * The closed vocabularies a scene is named in.
 *
 * A chat scene image is *planned* in the application — its registries resolve where the
 * camera is, how much of a face the shot can hold, and which of the viewer's own body parts
 * enter frame — and *compiled* here, by a provider-neutral engine that can see nothing above
 * it. Between the two there has to be a vocabulary belonging to neither the registry nor any
 * one dialect, or the seam degrades to opaque strings: the compiler is handed
 * `kneeling_before_viewer` and can reason about it exactly as far as it can reason about any
 * other string, which is not at all.
 *
 * What lives here is deliberately **half of each registry**: the closed set of ids and the
 * typed facts they stand for. The application's `scene-camera.ts` and `viewer-body.ts` keep
 * every phrase, every evidence gate and every render-tuned adjective, because a phrase is
 * something a registry or a dialect owns and this module is neither. An id here means the
 * same thing on both sides of the seam and nothing in particular to any model.
 *
 * Member names mirror the application registries exactly, so the application adopts these by
 * re-exporting them rather than by translating between two spellings. Drift is caught by the
 * type system rather than by a parity test: a registry written against these unions stops
 * compiling the moment a member is added.
 *
 * PURE data and types.
 */

// ---------------------------------------------------------------------------
// Capture mode — who is holding the camera
// ---------------------------------------------------------------------------

/**
 * How the shot was taken, as one closed choice rather than a scatter of booleans.
 *
 * The three members are one concept because they answer one question — where the camera is
 * and who operates it — and because they are mutually exclusive in a way separate flags
 * could not express: a selfie is not a first-person shot with a flag set, it is a different
 * arrangement of the same two bodies, with the subject's own arm holding the lens.
 *
 * - `third_person` — an unowned observing camera. The default, and the only member that
 *   makes no claim about anybody's position.
 * - `first_person_pov` — the shot is through the viewer's eyes. A claim about the viewer's
 *   body, which is why the surrounding composite (the person count, the possession clause,
 *   the limb binding) exists at all: a POV frame that reads as a third body in the room is
 *   the failure this member is here to prevent.
 * - `selfie` — the subject holds the camera. Both a camera position and a composition, and
 *   the reason this is a mode rather than a boolean: it is as far from `first_person_pov` as
 *   it is from `third_person`.
 */
export const sceneCaptureModes = ["third_person", "first_person_pov", "selfie"] as const;

export const sceneCaptureModeSchema = z.enum(sceneCaptureModes);

export type SceneCaptureMode = (typeof sceneCaptureModes)[number];

/*
 * There is deliberately NO default capture mode here.
 *
 * A default in the shared vocabulary reads as "the mode a scene has when nothing established
 * another", and every lane would then fall back the same way. The lanes do not agree: a chat
 * scene with no explicit capture decision is first-person through the player's own eyes and
 * has been since before the prompt-program cutover, so a shared `third_person` fallback would
 * invert that lane rather than leave it unasserted. Which mode an absent decision means is a
 * fact about the lane that lowers it, and it is stated there.
 */

// ---------------------------------------------------------------------------
// The camera triple
// ---------------------------------------------------------------------------

/**
 * How the subject's body faces the lens.
 *
 * `away_glance_back` is a distinct member rather than a modifier on `away` because it is a
 * separate physical claim — the body is turned away AND the head has come back — and the
 * application gates it on its own evidence.
 */
export const sceneSubjectOrientationIds = [
  "toward_viewer",
  "three_quarter",
  "profile",
  "away_glance_back",
  "away",
] as const;

export const sceneSubjectOrientationIdSchema = z.enum(sceneSubjectOrientationIds);

export type SceneSubjectOrientationId = (typeof sceneSubjectOrientationIds)[number];

/**
 * How much of the figure the frame holds — a crop, never a statement about how physically
 * near the two bodies are standing. Those come apart constantly: a character close enough
 * to feel someone's breath is usually a `medium` two-body frame.
 */
export const sceneShotDistanceIds = ["close", "medium", "full_figure", "wide"] as const;

export const sceneShotDistanceIdSchema = z.enum(sceneShotDistanceIds);

export type SceneShotDistanceId = (typeof sceneShotDistanceIds)[number];

/**
 * Where the lens sits relative to the subject's eye line.
 *
 * A claim about where two bodies are, not a taste preference: `high` says one of them is
 * kneeling, sitting, lying or bent while the other is not.
 */
export const sceneCameraHeightIds = ["eye_level", "high", "low"] as const;

export const sceneCameraHeightIdSchema = z.enum(sceneCameraHeightIds);

export type SceneCameraHeightId = (typeof sceneCameraHeightIds)[number];

/**
 * The three shot facts as one value.
 *
 * All three together, because they are decided together and a consumer handed two of them
 * has to invent the third. The triple is ids only — the phrases that render each id stay in
 * the registry that tuned them, and the coarser bands a provider guard reasons over stay in
 * the compiler's own `camera-bands`, which is a projection of these rather than a rival copy.
 */
export const sceneCameraSpecSchema = z.object({
  orientation: sceneSubjectOrientationIdSchema,
  distance: sceneShotDistanceIdSchema,
  height: sceneCameraHeightIdSchema,
});

export type SceneCameraSpec = z.infer<typeof sceneCameraSpecSchema>;

// ---------------------------------------------------------------------------
// Face visibility
// ---------------------------------------------------------------------------

/**
 * How much of the subject's face the shot can show — what an identity lock has to work
 * with, and therefore whether it should be applied at full strength, softened, or skipped.
 *
 * Usually entailed by the orientation, but not always: a shot down onto the crown of a head
 * hides a face that is squarely toward the camera, which is why anything that resolves a
 * body arrangement may override the orientation's answer.
 */
export const sceneFaceVisibilities = ["full", "partial", "hidden"] as const;

export const sceneFaceVisibilitySchema = z.enum(sceneFaceVisibilities);

export type SceneFaceVisibility = (typeof sceneFaceVisibilities)[number];

// ---------------------------------------------------------------------------
// The viewer's own body
// ---------------------------------------------------------------------------

/**
 * The parts of the viewer's own body that may enter a first-person frame.
 *
 * A closed set because it is a gate list before it is a description: every id a scene claims
 * is checked against the route's permissions and the player's own coverage before anything
 * is said about it. An open vocabulary could not be checked at all.
 */
export const sceneViewerBodyPartIds = [
  "hands",
  "forearms",
  "lap_thighs",
  "legs_feet",
  "torso",
  "genitals",
] as const;

export const sceneViewerBodyPartIdSchema = z.enum(sceneViewerBodyPartIds);

export type SceneViewerBodyPartId = (typeof sceneViewerBodyPartIds)[number];

// ---------------------------------------------------------------------------
// Exposure regions
// ---------------------------------------------------------------------------

/**
 * The body regions whose coverage a scene may depend on.
 *
 * Coverage, never judgment: a region is a fact about what is worn, and the four members are
 * the ones worth stating to an image model, which dresses every subject unless told
 * otherwise. The values a region takes (covered, sheer, bare) and the garment reasoning that
 * derives them belong to the application; what crosses the seam is which regions exist, so a
 * scene fact can name one and be understood on the other side.
 */
export const sceneExposureRegionIds = ["torso", "pelvis", "legs", "feet"] as const;

export const sceneExposureRegionIdSchema = z.enum(sceneExposureRegionIds);

export type SceneExposureRegionId = (typeof sceneExposureRegionIds)[number];
