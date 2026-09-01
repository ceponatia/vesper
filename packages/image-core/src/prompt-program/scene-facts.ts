import {
  isSceneStagingId,
  sceneCaptureModes,
  type SceneCaptureMode,
  type SceneStagingSurfaceForm,
} from "../scene-ir";

/**
 * What a `scene.*` fact's value is allowed to be, and the readers that narrow it.
 *
 * Every other closed value in a digest arrives already typed: a camera band rides
 * a discriminated `ImageCameraFact`, so `claim.value as ImageFramingBand` inside a
 * dialect is a cast the compiler has already proved. A scene fact has no such
 * union — it is an ordinary `ImageWorldFact`, whose `value` is `unknown` — so the
 * same cast on a capture mode would be a dialect asserting a shape nothing
 * checked, and an unrecognized string would fall clean through an exhaustive
 * switch and return `undefined` where a sentence was promised.
 *
 * So the narrowing happens once, here, and a value that does not fit returns
 * null. A dialect handed null renders no segment, which the shared compile step
 * records as a dropped claim — the honest outcome for a fact whose value nothing
 * could read (docs/resilience.md §2: a degraded answer with a record, never a
 * throw inside a compile).
 *
 * These readers are also the app's contract. The application lowers a resolved
 * scene into facts, and what it may put in a value is exactly what one of these
 * accepts.
 *
 * PURE. No IO, no env, no provider.
 */

const CAPTURE_MODES: ReadonlySet<string> = new Set<string>(sceneCaptureModes);

/**
 * The capture mode a `scene.capture_mode` fact names, or null.
 *
 * Null rather than a `third_person` default: the default belongs to the layer
 * that RESOLVES a scene, and inventing one here would have a malformed fact
 * quietly assert an unowned camera on a shot the story staged through someone's
 * eyes — the loudest possible way to be wrong about a POV render.
 */
export function imageSceneCaptureMode(value: unknown): SceneCaptureMode | null {
  return typeof value === "string" && CAPTURE_MODES.has(value) ? (value as SceneCaptureMode) : null;
}

/**
 * The entity refs a `scene.possession` fact binds every visible body part to.
 *
 * Refs rather than names, for the reason every relation carries refs: a ref is
 * resolved to a label by the dialect, through the same label map that keeps
 * database ids out of a payload. A value that is not a list of refs yields an
 * empty list, and an empty list yields no clause — better silence than a
 * possession sentence that binds nothing, which is the phrasing that summons a
 * phantom limb.
 */
export function imageScenePossessionOwners(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * The registry-authored surface form a `scene.staging` fact carries, or null.
 *
 * A staging fact's value IS the form: the arrangement it names, the wording
 * revision the measurements apply to, and the digest proving which bytes that
 * revision meant. Nothing is duplicated alongside it, because the form already
 * answers every question a compiler has — and the wording itself has no name
 * outside `scene-ir`, so a dialect that wants the measured sentence has to say so
 * by calling `adoptSceneStagingSurfaceForm`.
 *
 * The check is over the three public identity fields. A form is reachable only
 * through `createSceneStagingSurfaceForms`, whose input is a table total over the
 * arrangement vocabulary, so an object carrying all three came from that
 * constructor unless somebody wrote a deliberate double type assertion — a
 * visible, greppable lie that `scene-ir` already names as the one thing no type
 * system prevents. Defending further would mean re-checking a door rather than
 * reading it.
 */
export function imageSceneStagingForm(value: unknown): SceneStagingSurfaceForm | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const stagingId = candidate["stagingId"];
  if (typeof stagingId !== "string" || !isSceneStagingId(stagingId)) return null;
  if (typeof candidate["revision"] !== "string" || typeof candidate["digest"] !== "string") return null;
  return value as SceneStagingSurfaceForm;
}
