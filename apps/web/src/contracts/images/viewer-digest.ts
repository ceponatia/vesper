import type { ImageWorldFact } from "@vesper/image-core";
import { attributeRegistry, formatAttribute, type AttributeValue } from "../attributes";
import { isIntimateAttributeCategory } from "../body/locations";
import type { RegionExposure } from "../items/visibility";
import type { RealizedBody } from "../species";
import { REVEAL_EXPOSURE_REGION, revealSurfaces } from "./subject-reveal";
import { VIEWER_SKIN_ATTRIBUTE_IDS, type ViewerBodyPart, type ViewerBodyPartId } from "./viewer-body";

/**
 * The VIEWER's own body as typed facts — the carrier an embodied first-person
 * scene states its foreground through.
 *
 * The viewer is deliberately not a subject. The world digest's subjects are the
 * cast, `operation.subjectCount` counts the cast, and a relation needs entity
 * refs on both ends, so there was no binding for the one body every POV shot is
 * shot from. These facts are that binding: they ride the digest's flat scene
 * list on their own `viewer` channel, which is neither a subject slice nor a
 * location — so the count assertion is untouched, no relation can dangle at
 * them, and nothing here enters the cast.
 *
 * Three claims, and the split is the same one the cast already makes:
 *
 * - **`viewer.body_geometry`** — which of the viewer's own parts the frame
 *   crops in, as ids. The geometry sentence is the endpoint dialect's, exactly
 *   as a camera band's is; what crosses the seam is the closed part vocabulary.
 * - **`viewer.appearance`** — the skin and build of those parts. Without it the
 *   viewer's arms change colour between shots and read as a different person
 *   reaching in, which is why `skin.tone` and `build.frame` ride ANY embodied
 *   frame while each part contributes only its own descriptors on top.
 * - **`viewer.intimate_anatomy`** — the exposed half, stated only by a route
 *   that permits it, and only for a region an in-frame part actually shows. The
 *   coverage rule is the cast's ({@link revealSurfaces}); the framing rule is
 *   the viewer's alone, because the camera is their own eyes and a POV shot
 *   holds a few cropped limbs rather than a whole figure.
 *
 * ## What this does NOT decide
 *
 * Route and coverage. Every part reaching {@link viewerBodyFacts} has already
 * passed `resolveViewerParts` — unknown id, then the intimate route, then a
 * `requiresBare` region that must read bare or sheer, with missing coverage
 * counting as covered. This projection states what it is handed; a part the
 * gate dropped never enters it, so there is no prompt text to leak and nothing
 * to talk a model out of. What it DOES decide is which regions the surviving
 * parts put on screen, because that is a question about the frame rather than
 * about the wardrobe, and no coverage readout can answer it.
 *
 * PURE: values in, facts out. No IO, no env, no registry writes.
 */

/** The projection owner every viewer fact's source names. */
export const IMAGE_VIEWER_BODY_OWNER = "images.viewer_body";

/**
 * Beside the possession clause's own priority, because the two are the same half
 * of one composite: whichever of them the shot earns is what tells the model who
 * the limbs in frame belong to.
 */
const VIEWER_GEOMETRY_PRIORITY = 0.95;
/** Below the geometry it describes: whose body this is matters before what it looks like. */
const VIEWER_APPEARANCE_PRIORITY = 0.7;
/** Shed first under a squeeze, exactly as the cast's intimate detail is. */
const VIEWER_INTIMATE_PRIORITY = 0.5;

export interface ViewerBodyFactsInput {
  /**
   * The viewer's parts in frame — **already through `resolveViewerParts`**, so
   * the route and coverage gates have run and every entry is renderable.
   */
  readonly parts: readonly ViewerBodyPart[];
  /**
   * The parts whose geometry a staged sentence already places.
   *
   * They stay in frame and they still get their skin and build stated — the
   * staging owns geometry, not whose body this is — but they are dropped from
   * the generic geometry claim. A staged sentence says where a limb is on
   * somebody and the geometry claim says where it is relative to the lens, and
   * both at once puts the same two hands in two places in one prompt, which is
   * the self-contradiction that makes a model paint a third party's arms rather
   * than choose.
   */
  readonly stagedParts: readonly ViewerBodyPartId[];
  /** The viewer persona's resolved attributes. Absent ⇒ the frame states no body facts. */
  readonly attributes?: readonly AttributeValue[];
  /** Applicability: a body without the region states nothing about it. */
  readonly realizedBody?: RealizedBody;
  /** The viewer's own garment coverage readout — the intimate half's gate. */
  readonly exposure?: RegionExposure;
  /** Whether THIS rung's route permits intimate anatomy. */
  readonly allowIntimate: boolean;
}

/**
 * The viewer's own body as digest facts, in emission order.
 *
 * Empty for a frame with no viewer part in it: a disembodied POV states nothing
 * about a body it has asserted is not there.
 */
export function viewerBodyFacts(input: ViewerBodyFactsInput): ImageWorldFact[] {
  if (input.parts.length === 0) return [];
  const facts: ImageWorldFact[] = [];

  const geometry = input.parts.filter((part) => !input.stagedParts.includes(part.id));
  if (geometry.length > 0) {
    facts.push({
      key: "viewer.body_geometry",
      concept: "viewer.body_geometry",
      value: geometry.map((part) => part.id),
      semanticTags: ["viewer:geometry", ...geometry.map((part) => `viewer_part:${part.id}`)],
      disposition: "optional_visual",
      priority: VIEWER_GEOMETRY_PRIORITY,
      source: { owner: IMAGE_VIEWER_BODY_OWNER, key: "geometry" },
    });
  }

  // The facts cover every part in frame, STAGED OR NOT: a staged sentence owns
  // the geometry of the limb it places, never the colour of the skin on it.
  const appearance = viewerDescriptors(input, [
    ...VIEWER_SKIN_ATTRIBUTE_IDS,
    ...input.parts.flatMap((part) => part.attributeIds),
  ]);
  if (appearance.length > 0) {
    facts.push({
      key: "viewer.appearance",
      concept: "viewer.appearance",
      value: appearance,
      semanticTags: ["viewer:appearance"],
      disposition: "optional_visual",
      priority: VIEWER_APPEARANCE_PRIORITY,
      source: { owner: IMAGE_VIEWER_BODY_OWNER, key: "appearance" },
    });
  }

  const intimate = viewerIntimateDescriptors(input);
  if (intimate.length > 0) {
    facts.push({
      key: "viewer.intimate_anatomy",
      concept: "viewer.intimate_anatomy",
      value: intimate,
      semanticTags: ["viewer:intimate"],
      disposition: "optional_visual",
      priority: VIEWER_INTIMATE_PRIORITY,
      source: { owner: IMAGE_VIEWER_BODY_OWNER, key: "intimate_anatomy" },
    });
  }

  return facts;
}

/**
 * The named attributes as descriptor values, in the order asked for.
 *
 * Registry label/value pairs, lower-cased into a clause — the same shape the
 * cast's own reveal facts carry, so the two paths state one kind of fact one
 * way. An id the registry does not know is IGNORED rather than guessed at: the
 * part registry lists them as plain strings and a typo there is a data mistake,
 * not a reason to fail a render.
 */
function viewerDescriptors(input: ViewerBodyFactsInput, ids: readonly string[]): string[] {
  const byId = new Map((input.attributes ?? []).map((value) => [value.id as string, value]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const value = byId.get(id);
    if (value === undefined) continue;
    const def = attributeRegistry.byId(value.id);
    if (def === undefined || def.excludeFromPrompts === true) continue;
    if (input.realizedBody && !input.realizedBody.isAttributeApplicable(def)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted.length === 0) continue;
    out.push(formatted.charAt(0).toLowerCase() + formatted.slice(1));
  }
  return out;
}

/**
 * The viewer's exposed anatomy, or nothing.
 *
 * **Coverage and framing are two different questions, and both must answer yes.**
 * `revealSurfaces` — the cast's rule, reused rather than restated — asks what the
 * clothes leave uncovered anywhere on the body. It cannot ask what the frame is
 * pointed at, and for the viewer that is the half that decides: the camera is
 * their own eyes, so a POV shot holds a few cropped limbs rather than a whole
 * figure. Asking coverage alone got both errors at once — a shirtless torso in
 * frame stated nothing because the pelvis was covered, and a shot of the
 * viewer's own lap stated their bare chest because the chest happened to be
 * bare somewhere off-camera.
 *
 * So an attribute is stated only when its region is one an in-frame part
 * actually shows ({@link ViewerBodyPart.revealsIntimateRegions}) AND the
 * coverage readout uncovers it. The region map is the cast's own
 * ({@link REVEAL_EXPOSURE_REGION}), so the two paths cannot come to disagree
 * about which region a category belongs to; a category the map does not name —
 * the deliberately omitted `anus`/`perineum` — is stated by neither path.
 *
 * The route is the third condition and the coarsest: `allowIntimate` is the
 * rung's permission, and no readout is not permission either — with no coverage
 * there is no reveal.
 */
function viewerIntimateDescriptors(input: ViewerBodyFactsInput): string[] {
  const exposure = input.exposure;
  if (!input.allowIntimate || exposure === undefined) return [];
  const inFrame = new Set<string>(input.parts.flatMap((part) => part.revealsIntimateRegions));
  if (inFrame.size === 0) return [];
  const out: string[] = [];
  for (const value of input.attributes ?? []) {
    const def = attributeRegistry.byId(value.id);
    if (def === undefined || def.excludeFromPrompts === true) continue;
    if (!isIntimateAttributeCategory(def.category)) continue;
    const region = REVEAL_EXPOSURE_REGION[def.category];
    if (region === undefined || !inFrame.has(region)) continue;
    if (input.realizedBody && !input.realizedBody.isAttributeApplicable(def)) continue;
    if (!revealSurfaces(def, exposure, true)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted.length === 0) continue;
    out.push(formatted.charAt(0).toLowerCase() + formatted.slice(1));
  }
  return out;
}
