import {
  sceneCameraHeightIds,
  sceneShotDistanceIds,
  sceneSubjectOrientationIds,
  type SceneCameraHeightId,
  type SceneCameraSpec,
  type SceneFaceVisibility,
  type SceneShotDistanceId,
  type SceneSubjectOrientationId,
} from "@vesper/image-core";

/**
 * The **camera vocabulary** for scene images.
 *
 * Every chat scene image today comes back front-facing, whatever the story says, and the
 * reason is not that the model misbehaves: nothing in the prompt has ever stated where the
 * player's eyes are relative to the subject. An image model handed no camera fills the gap
 * with its strongest prior — a subject squarely facing the lens — so a character the
 * narration just put her back to the room gets turned around.
 *
 * **A registry, not free text**, exactly as `viewer-body.ts` established: the phrasing IS
 * the feature. Three properties every line here has to hold at once:
 *
 * 1. **No limb nouns in an orientation phrase.** The phantom-limb scar (2026-07-29): a limb
 *    noun in a first-person POV prompt summons a limb, and an unowned one becomes a whole
 *    second person. Back- and shoulder-region words are the useful exception — they are
 *    what "seen from behind" is made of — and they are made safe the same way the composer's
 *    pose text is, by **possessive binding** to the subject, which is why every phrase here
 *    is a `{name}` template rather than a sentence about "her".
 * 2. **No gendered pronouns.** A character can be any gender; a phrase that says "her back"
 *    is a phrase that mis-genders half the cast the moment the registry is reused.
 * 3. **Positive phrasing only.** "Not facing the camera" anchors on *facing the camera*,
 *    the same way the literal "no camera" once anchored on cameras (the scar recorded on
 *    `SCENE_POV_RULE`). State the geometry that IS, never the one that is not.
 *
 * The default entries still carry phrases, but **the render layer emits nothing for the
 * default camera** (`toward_viewer` + `medium` + `eye_level` ⇒ no shot line at all), which
 * keeps today's prompts byte-identical when no evidence moved the camera — the slice's
 * no-regression anchor. The default phrases exist so the registry is total: every id has a
 * phrase, and a future caller that wants to state the default explicitly does not have to
 * invent one.
 *
 * PURE. Tuning a phrase is a data edit here; adding a member is one entry.
 *
 * ## What this file no longer declares
 *
 * The three id unions and the shot triple they compose are `@vesper/image-core`'s, and they
 * are re-exported below under the names every call site already uses. A camera id is protocol
 * — the registry names a shot and the compiler reasons over it — so declaring it twice would
 * let the two sides disagree while both kept compiling. Everything a phrase, a hint or an
 * evidence gate says is app-side and stays here, because none of it is decidable without
 * reading English.
 */

export { sceneCameraHeightIds, sceneShotDistanceIds, sceneSubjectOrientationIds };
export type { SceneCameraHeightId, SceneCameraSpec, SceneShotDistanceId, SceneSubjectOrientationId };

// ---------------------------------------------------------------------------
// Subject orientation
// ---------------------------------------------------------------------------

export interface SceneSubjectOrientation {
  id: SceneSubjectOrientationId;
  /** The shot-line fragment. A `{name}` template — substituted with the subject's name at emission. */
  phrase: string;
  /** How much of the face the shot can show — drives the identity-lock adaptation at render assembly. */
  faceVisibility: SceneFaceVisibility;
  /**
   * Non-default orientations require a verbatim narration quote (the anti-eagerness gate,
   * the same shape as `viewerBodyEvidence`). A camera that wanders on a whim contradicts
   * the fiction just as loudly as a camera that never moves.
   */
  evidenceRequired: boolean;
}

export const sceneSubjectOrientations: readonly SceneSubjectOrientation[] = [
  {
    id: "toward_viewer",
    phrase: "{name} facing the camera, turned toward the viewer",
    faceVisibility: "full",
    evidenceRequired: false,
  },
  {
    id: "three_quarter",
    phrase: "{name} turned three-quarters toward the camera, {name}'s face angled part-way toward the lens",
    faceVisibility: "full",
    evidenceRequired: true,
  },
  {
    id: "profile",
    phrase: "{name} seen in profile, {name}'s head side-on to the camera",
    faceVisibility: "partial",
    evidenceRequired: true,
  },
  {
    // The glance carries its own second gate on top of `evidenceRequired`: the quote must
    // itself contain glance language (`GLANCE_WORDS`, owner ruling 2026-08-10), so a quote
    // that grounds only the behind-position resolves to `away` instead.
    id: "away_glance_back",
    // "{name}'s body still turned away" anchors the torso (probe run 2026-08-14: one of two
    // renders over-rotated into a three-quarter turn — the identity lock pulls the face out,
    // and with it the shoulders, unless the body is pinned separately from the glance).
    phrase:
      "{name} seen from behind with {name}'s back to the camera and {name}'s body still turned away, glancing back over {name}'s shoulder toward the viewer",
    faceVisibility: "partial",
    evidenceRequired: true,
  },
  {
    id: "away",
    phrase: "{name} seen fully from behind, {name}'s back to the camera, {name}'s head facing away from the lens",
    faceVisibility: "hidden",
    evidenceRequired: true,
  },
];

export function sceneSubjectOrientationById(id: string): SceneSubjectOrientation | undefined {
  return sceneSubjectOrientations.find((entry) => entry.id === id);
}

// ---------------------------------------------------------------------------
// Shot distance
// ---------------------------------------------------------------------------

/**
 * How much of the subject the frame holds.
 *
 * **Deliberately ungated** — there is no `evidenceRequired` field here at all, because a
 * wrong distance is a taste miss and a wrong orientation is a contradiction. A medium shot
 * where the beat wanted a close one still illustrates the scene; a front-facing shot of a
 * character with her back to the room does not. So the composer is simply asked to match
 * the beat, and nothing degrades it.
 */
export interface SceneShotDistance {
  id: SceneShotDistanceId;
  /** The shot-line fragment; a `{name}` template like every phrase in this file. */
  phrase: string;
  /**
   * What the id MEANS, for the composer choosing between them — see {@link SceneCameraHeight.hint}
   * for why the two audiences get two fields.
   *
   * Stated as how much of the body the frame holds, never as how physically near the viewer
   * is standing. That is the confusion the bare id list invited: "he stops right behind her,
   * close enough to feel the heat off the pan" reads as `close`, and the shot that beat wants
   * is a medium two-body frame.
   */
  hint: string;
}

export const sceneShotDistances: readonly SceneShotDistance[] = [
  {
    id: "close",
    phrase: "a close shot of {name}, tight in the frame",
    hint: "head and shoulders fill the frame; one body, little room around it",
  },
  {
    id: "medium",
    phrase: "a medium shot of {name}, head and torso in the frame",
    hint: "head to roughly the waist — the default, and what two bodies in contact usually need",
  },
  {
    id: "full_figure",
    phrase: "a full-figure shot with the whole of {name} inside the frame",
    hint: "the whole body head to foot, when the pose is the point",
  },
  {
    id: "wide",
    phrase: "a wide shot with {name} small in the frame and the surrounding space open around {name}",
    hint: "the body small in the frame with the room around it, when the place is the point",
  },
];

export function sceneShotDistanceById(id: string): SceneShotDistance | undefined {
  return sceneShotDistances.find((entry) => entry.id === id);
}

// ---------------------------------------------------------------------------
// Camera height
// ---------------------------------------------------------------------------

export interface SceneCameraHeight {
  id: SceneCameraHeightId;
  /** The shot-line fragment; a `{name}` template. */
  phrase: string;
  /**
   * A looking-down or looking-up camera is a claim about where the two bodies are, so it is
   * gated like an orientation rather than like a distance.
   *
   * **The posture waiver is deliberately NOT here.** `high` is also permitted with no quote
   * when the focal character's own pose text already entails it (she is kneeling, the viewer
   * is not) — that derivation needs the resolved pose and the committed postures, neither of
   * which a registry entry can see, so it lives in `resolveScenePlan`. This field states the
   * rule; the resolver states the one exception to it.
   */
  evidenceRequired: boolean;
  /**
   * What the id MEANS, for the composer choosing between them — the recognition cue, stated
   * as the bodily arrangement that makes this the right answer.
   *
   * Separate from {@link phrase} because the two have different audiences and different
   * jobs. `phrase` is render text, tuned against what image models obey (frame-anchored,
   * "high-angle shot", where the subject sits in the frame — see the note above this array);
   * a hint is read by a planner deciding which id the story establishes. Tuning one for its
   * own audience must not silently retrain the other, and keeping both in the registry is
   * what stops the composer prompt and the render vocabulary drifting apart.
   */
  hint: string;
}

/*
 * Height phrases are FRAME-ANCHORED, and that wording is load-bearing (probe run
 * 2026-08-14, kneel beat): the first draft said "the camera looking down at {name} from the
 * viewer's standing height", and the model satisfied it by moving {name}'s GAZE — she looked
 * up while the camera stayed level, or even dropped into a low-angle hero shot. Abstract
 * camera language barely steers these models; what they follow is photographic caption
 * vocabulary ("high-angle shot") plus where the subject sits IN THE FRAME. The same probe's
 * staged beats proved the converse: a downward shot landed exactly when frame-edge content
 * (an arm entering from the top edge, a body receding from the bottom) anchored it.
 */
export const sceneCameraHeights: readonly SceneCameraHeight[] = [
  {
    id: "eye_level",
    phrase: "the camera at eye level with {name}",
    evidenceRequired: false,
    hint: "the two are level — standing together, sitting together, lying together",
  },
  {
    id: "high",
    phrase:
      "a high-angle shot from above, the camera looking down on {name} from the viewer's standing height, {name} framed below the camera in the lower half of the frame",
    evidenceRequired: true,
    hint: "the viewer is above her, looking down — she is kneeling, sitting, lying, or bent while they are not",
  },
  {
    id: "low",
    phrase:
      "a low-angle shot from below, the camera under {name}'s eye line looking up, {name} rising above the camera toward the top of the frame",
    evidenceRequired: true,
    hint: "the viewer is below her, looking up — she is above them, astride or standing over",
  },
];

export function sceneCameraHeightById(id: string): SceneCameraHeight | undefined {
  return sceneCameraHeights.find((entry) => entry.id === id);
}

// ---------------------------------------------------------------------------
// The camera as one fact
// ---------------------------------------------------------------------------

/**
 * Today's shot, named.
 *
 * Every degradation in the resolution chain lands here — an unknown id, an ungrounded
 * quote, a lane with no evidence at all — because the front-facing default is the fallback,
 * not a casualty. `isDefaultSceneCamera` is what the render layer asks before emitting a
 * shot line, so an unmoved camera adds no prompt text whatsoever.
 */
export const DEFAULT_SCENE_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
};

export function isDefaultSceneCamera(camera: SceneCameraSpec): boolean {
  return (
    camera.orientation === DEFAULT_SCENE_CAMERA.orientation &&
    camera.distance === DEFAULT_SCENE_CAMERA.distance &&
    camera.height === DEFAULT_SCENE_CAMERA.height
  );
}

/**
 * The lexical backstop for `away_glance_back` (owner ruling 2026-08-10): **away means fully
 * away, and the glance back is itself evidence-gated.**
 *
 * A character established as behind-facing renders full back-to-camera. The glance is a
 * separate physical claim — she looked back — and quoting the behind-position does not
 * establish it. So an `away_glance_back` proposal must carry a quote that contains the
 * glance itself, and one that does not degrades to `away` rather than all the way to the
 * default: the behind-position stands, the glance does not.
 *
 * In the `BLUSH_WORDS` / `BARE_LIMB` family — a deliberately blunt lexical check standing in
 * for a judgment call no second model call would make more reliably.
 */
export const GLANCE_WORDS = /\b(glanc\w*|look\w*\s+(back|over)|over\s+(her|his|their)\s+shoulder|peek\w*)\b/i;
