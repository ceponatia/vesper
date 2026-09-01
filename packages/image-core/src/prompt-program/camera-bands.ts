/**
 * The camera vocabulary a prompt program reasons over.
 *
 * These bands mirror the application's viewing vocabulary member for member, and
 * that is a deliberate copy rather than an import. The application's bands are a
 * GAME fact — how much of a character an observer can make out from where they
 * are standing — while these are an IMAGE fact used by two things that must not
 * depend on the game: a dialect deciding how to phrase a waist-up crop, and the
 * negative composition block deciding whether `cropped`, `close_up` and `blur`
 * are outcomes this render actually asked for.
 *
 * Keeping a copy means a game-side vocabulary change surfaces as a compile error
 * in the application's adapter, where somebody has to decide what the new band
 * means to an image, instead of arriving here as a string no negative guard
 * recognizes.
 */

/** How much of the figure the frame contains. */
export const imageFramingBands = ["close_up", "portrait", "waist_up", "full_figure", "wide"] as const;
export type ImageFramingBand = (typeof imageFramingBands)[number];

/** How far the camera is from the subject. */
export const imageDistanceBands = ["touching", "close", "near", "distant"] as const;
export type ImageDistanceBand = (typeof imageDistanceBands)[number];

/** How the subject faces the camera. */
export const imageAngleBands = ["toward", "side_on", "away"] as const;
export type ImageAngleBand = (typeof imageAngleBands)[number];

/**
 * Where the lens sits relative to the subject's eye line.
 *
 * A claim about where two bodies are rather than a taste preference: `high` says
 * one of them is kneeling, sitting, lying or bent while the other is not.
 *
 * Member-for-member the same set as `sceneCameraHeightId` in `scene-ir`, which
 * coarsens nothing — and it is still declared here rather than imported, because
 * what this vocabulary buys is that `ImageCameraFact` speaks ONE language.
 * A union whose other five arms are bands and whose sixth was a scene id would
 * force every non-scene lane — an item shot, a location plate, a portrait — to
 * reach into the scene IR to say where its camera stands.
 */
export const imageCameraHeightBands = ["eye_level", "high", "low"] as const;
export type ImageCameraHeightBand = (typeof imageCameraHeightBands)[number];

/** Whole-subject motion relative to the camera — the source of intended blur. */
export const imageMotionBands = ["still", "slow", "fast"] as const;
export type ImageMotionBand = (typeof imageMotionBands)[number];

/** Light on the subject. `silhouette` is backlit shape-only. */
export const imageLightingBands = ["bright", "dim", "dark", "silhouette"] as const;
export type ImageLightingBand = (typeof imageLightingBands)[number];

/**
 * Framings that put hands in the picture, or leave whether they are there to the
 * pose.
 *
 * Read by the hand-artifact negative block, which the research warns is one of
 * the most commonly over-applied exclusions: a head-and-shoulders portrait has no
 * hands to malform, and spending negative budget defending them there crowds out
 * a term that would have helped.
 */
export function imageFramingShowsHands(band: ImageFramingBand): boolean {
  switch (band) {
    case "close_up":
    case "portrait":
      return false;
    case "waist_up":
    case "full_figure":
    case "wide":
      return true;
  }
}

/**
 * Whether a framing band is itself a requested crop.
 *
 * `close_up` and `portrait` ARE crops — the frame deliberately cuts the figure —
 * so a negative block that forbids `cropped` or `close_up` would be arguing with
 * the camera. Wider framings make both exclusions safe again.
 */
export function imageFramingIsCropped(band: ImageFramingBand): boolean {
  switch (band) {
    case "close_up":
    case "portrait":
      return true;
    case "waist_up":
    case "full_figure":
    case "wide":
      return false;
  }
}

/** Whether a motion band asks for blur that a `blur` exclusion would fight. */
export function imageMotionImpliesBlur(band: ImageMotionBand): boolean {
  return band !== "still";
}
