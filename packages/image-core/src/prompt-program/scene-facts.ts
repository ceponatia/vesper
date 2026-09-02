import {
  isSceneStagingId,
  sceneCaptureModes,
  sceneViewerBodyPartIds,
  type SceneCaptureMode,
  type SceneFaceVisibility,
  type SceneStagingSurfaceForm,
  type SceneViewerBodyPartId,
} from "../scene-ir";

/**
 * What a `scene.*` or `viewer.*` fact's value is allowed to be, and the readers
 * that narrow it.
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
 * scene — and the viewer's own body in its foreground — into facts, and what it
 * may put in a value is exactly what one of these accepts.
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
 * outside `scene-ir`, so a dialect that wants the measured sentence has to ask
 * for it through the recorder in `./scene-staging-surfaces`, which is what puts
 * the decision in the render's provenance.
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

/**
 * The face visibilities that ADAPT an identity lock, and nothing else.
 *
 * `full` is absent on purpose. A shot that can show the whole face needs no
 * adaptation, so there is nothing for a dialect to word, and admitting the value
 * here would give the concept a legal value every dialect had to answer with
 * silence — a claim that renders nothing is a dropped claim, and this one sits in
 * a mandatory segment kind. Stating the fact at all IS the statement that the
 * face is not the evidence.
 */
export type ImageObscuredFace = Exclude<SceneFaceVisibility, "full">;

/**
 * How much of a subject's face a `subject.face_visibility` fact says the shot can
 * show, or null when the value names neither adaptable answer.
 *
 * Null is the honest outcome for a value nothing could read, and the compile
 * records it as a dropped claim (docs/resilience.md §2). Because the concept sits
 * in the mandatory `identity` kind, a malformed value refuses the render rather
 * than shipping a lock nothing corrected — the same call `scene.staging` makes,
 * and for the same reason: the claim exists precisely because the prompt is wrong
 * without it.
 */
export function imageSceneObscuredFace(value: unknown): ImageObscuredFace | null {
  return value === "partial" || value === "hidden" ? value : null;
}

const VIEWER_BODY_PART_IDS: ReadonlySet<string> = new Set<string>(sceneViewerBodyPartIds);

/**
 * The viewer's own parts a `viewer.body_geometry` fact puts in the foreground,
 * in the order the projection listed them.
 *
 * Ids, never phrases. The registry that decides WHEN a part is in frame lives in
 * the application and the geometry sentence belongs to the endpoint, so what
 * crosses the seam is the closed vocabulary both sides already share — exactly
 * as a camera band does. An unknown id drops rather than travelling as a word
 * nothing checked; an empty list yields no clause, because a foreground
 * statement naming no limb is the disembodied shot with extra steps.
 *
 * Order is the projection's and is preserved: it lists the parts in registry
 * order, so two renders of the same frame word the foreground identically.
 */
export function imageViewerBodyParts(value: unknown): readonly SceneViewerBodyPartId[] {
  if (!Array.isArray(value)) return [];
  const known: SceneViewerBodyPartId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim() as SceneViewerBodyPartId;
    if (VIEWER_BODY_PART_IDS.has(id) && !known.includes(id)) known.push(id);
  }
  return known;
}

/**
 * The descriptor list a `viewer.appearance` or `viewer.intimate_anatomy` fact
 * carries, cleaned of blanks.
 *
 * Attribute-derived values, the same class `subject.appearance` and
 * `subject.intimate_anatomy` already carry — a registry label and its semantic
 * value, never a sentence somebody wrote for a model. A value that is not a list
 * of strings yields an empty list, and an empty list yields no clause.
 */
export function imageViewerDescriptors(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
