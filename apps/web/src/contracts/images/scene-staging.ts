import type { RegionExposure } from "../items/visibility";
import type { ViewerBodyPartId } from "./viewer-body";
import type { SceneCameraSpec } from "./scene-camera";

/**
 * The **staging catalog** — one entry per stageable intimate configuration
 * (scene-composition.plan.md slice 2).
 *
 * During intimate play the picture and the text diverge worst: the narration describes a
 * specific act with a specific geometry, and the render comes back a nude portrait — right
 * person, right room, wrong moment. The cause is not prudishness in the image model but a
 * hole in the prompt. The character's explicit anatomy is already injected deterministically
 * (`intimateSceneAppearance`), while the **act** never is, because the only thing that could
 * write it is the small composing model — which runs in a safe configuration and answers
 * with "close to the viewer, intimate".
 *
 * So the registry owns every explicit word, and the composer owns nothing but an `id` and a
 * quote. That is a grounding decision before it is a moderation one: a bold composer cannot
 * invent an act the story never described, and a cautious one cannot water down an act it
 * did. The gates are code either way — evidence, subject exposure, and the uncensored route.
 *
 * ## Templates
 *
 * Geometry-first, positive phrasing, `{name}` for the subject, and **every limb noun
 * possessive-bound** — to `{name}` or to "the viewer's own". An unowned limb in a
 * first-person prompt is the phantom-limb scar (2026-07-29), and a registry test runs the
 * `BARE_LIMB` pattern over each template with `{name}` substituted so none can land here.
 *
 * **A staging template owns the viewer-limb phrasing for the parts it names.** The generic
 * viewer-body framing lines describe foreground limbs near the lens ("entering frame from
 * the lower edge, close to the lens…") — the right geometry for a hand reaching into shot,
 * the wrong one for a hand placed on somebody. `viewerParts` is therefore the **gate list**:
 * every id still passes `resolveViewerParts` (registry membership, route, player coverage),
 * while the staged sentence supplies the geometry. Unlike the composer, a staging may list
 * intimate parts directly — it is registry data, not model output — and the route and
 * coverage gates still decide whether they render at all.
 *
 * PURE. A new configuration is one entry; a phrasing fix is a data edit.
 */

export const sceneStagingIds = [
  "held_from_behind",
  "held_from_behind_bare",
  "kneeling_before_viewer",
  "kneeling_before_viewer_guided",
  "astride_viewer_facing",
  "astride_viewer_away",
  "bent_over_surface",
  "on_all_fours",
  "lying_beneath_viewer",
  "lying_face_down",
  "spooned_from_behind",
  "pressed_to_wall_facing",
  "pressed_to_wall_away",
] as const;
export type SceneStagingId = (typeof sceneStagingIds)[number];

export interface SceneStaging {
  id: SceneStagingId;
  /**
   * The camera the configuration implies. **Overrides the composer's camera proposal**
   * outright rather than being merged with it: the geometry is entailed by the act, so a
   * staging that survived its own evidence gate has already earned its shot.
   *
   * Away-facing entries carry orientation `away`, never `away_glance_back` — the glance is a
   * separate physical claim needing its own narration evidence (owner ruling 2026-08-10).
   * Glance-back variants would be their own entries, and there are none in v1.
   */
  camera: SceneCameraSpec;
  /** Viewer parts the configuration puts in frame — the gate list, resolved through the existing `resolveViewerParts`. */
  viewerParts: readonly ViewerBodyPartId[];
  /** Regions of the SUBJECT that must read bare/sheer for the template to be truthful; `[]` ⇒ clothed-capable staging. */
  requiresBare: readonly (keyof RegionExposure)[];
  /** True ⇒ emitted only when the route's `allowIntimate` is set, exactly like `intimateAppearance`. */
  intimate: boolean;
  /** The staging sentence. `{name}` is the subject. Written once, here, never by a model. */
  template: string;
  /**
   * Overrides the camera orientation's derived `faceVisibility` for the identity-lock
   * adaptation: a face can hide by head angle alone — a crown-of-the-head shot on a subject
   * who faces the viewer squarely. Absent ⇒ the orientation entry's value.
   */
  faceVisibility?: "full" | "partial" | "hidden";
  /**
   * How many present NPCs the entry can honestly stage (owner ruling, 2026-08-14).
   *
   * - `"solo"` — eligible only when EXACTLY ONE NPC is in the scene.
   * - `"multi"` — the entry explicitly supports more than one present NPC.
   *
   * Every initial entry is `"solo"`, and that is a statement about the templates rather than
   * a placeholder: each one describes a two-body geometry between the subject and the
   * viewer, and a second character standing in the room makes the sentence a lie about who
   * is where — the same class of self-contradiction the person-count assertion exists to
   * prevent. A multi-NPC staging is a new entry with its own wording, not a relaxed flag on
   * one of these. **The gate itself runs in `resolveScenePlan`**, where the present roster is
   * known; this field is the datum it reads.
   */
  cast: "solo" | "multi";
}

export const sceneStagings: readonly SceneStaging[] = [
  {
    id: "held_from_behind",
    camera: { orientation: "away", distance: "medium", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} standing with {name}'s back against the viewer's chest, the viewer's own arms closed around {name} from behind and the viewer's own hands resting on {name}'s stomach",
    cast: "solo",
  },
  {
    // The same hold, bare. Split into its own entry rather than made conditional, because a
    // clothed embrace and a bare one are different sentences, not one sentence with a flag.
    id: "held_from_behind_bare",
    camera: { orientation: "away", distance: "medium", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: ["torso"],
    intimate: true,
    template:
      "{name} standing bare-skinned with {name}'s back against the viewer's chest, the viewer's own arms closed around {name} from behind and the viewer's own hands cupping {name}'s bare breasts",
    cast: "solo",
  },
  {
    // Acceptance scene "Oral", composition A (owner-specified 2026-08-10): her face visible,
    // looking up, mid-act. `requiresBare` is empty on purpose — the bare anatomy this shot
    // needs is the VIEWER's, and that is gated by `viewerParts` against the player's own
    // coverage, not by the subject's.
    id: "kneeling_before_viewer",
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    viewerParts: ["genitals"],
    requiresBare: [],
    intimate: true,
    // "Below the camera" is the frame anchor for this entry's high angle (probe run
    // 2026-08-14, kneel/oral beats: stated camera height alone moved her gaze, never the
    // camera — she looked up at nothing from an eye-level shot).
    template:
      "{name} kneeling on the floor below the camera and facing up toward it, {name}'s face tilted up toward the viewer and {name}'s mouth on the viewer's own genitals, {name}'s eyes on the viewer",
    cast: "solo",
  },
  {
    // Composition B of the same acceptance scene: the shot looks down on the crown of her
    // head. `faceVisibility: "hidden"` is the whole reason the override field exists — the
    // orientation is `toward_viewer`, and the face is hidden by head angle alone, so the
    // lock adaptation's `hidden` branch has to fire off the staging rather than the camera.
    id: "kneeling_before_viewer_guided",
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    viewerParts: ["hands", "genitals"],
    requiresBare: [],
    intimate: true,
    template:
      "{name} kneeling before the viewer with {name}'s head bowed, the crown of {name}'s head toward the camera and {name}'s mouth on the viewer's own genitals, the viewer's own hand resting on top of {name}'s head",
    faceVisibility: "hidden",
    cast: "solo",
  },
  {
    id: "astride_viewer_facing",
    camera: { orientation: "toward_viewer", distance: "close", height: "low" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} astride the viewer facing the camera, {name}'s knees either side of the viewer and {name}'s bare pelvis lowered onto the viewer's own genitals in penetration, the viewer's own hands on {name}'s waist",
    cast: "solo",
  },
  {
    // Facing away, so the camera says `away` and the face is hidden. The subject's back is
    // NOT described as bare: over-claiming a region in the template would make `requiresBare`
    // demand a bare torso for a shot that only needs a bare pelvis.
    id: "astride_viewer_away",
    camera: { orientation: "away", distance: "close", height: "low" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} astride the viewer facing away from the camera, {name}'s back and hips filling the frame above the viewer, penetration where {name}'s bare pelvis meets the viewer's own genitals, the viewer's own hands on {name}'s hips",
    cast: "solo",
  },
  {
    id: "bent_over_surface",
    camera: { orientation: "away", distance: "medium", height: "high" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} bent forward over a waist-high surface with {name}'s back to the camera and {name}'s hips raised toward the viewer, penetration where the viewer's own genitals meet {name}'s bare pelvis from behind, the viewer's own hands entering frame from the lower edge and holding {name}'s hips",
    cast: "solo",
  },
  {
    // Acceptance scene "Doggy style" (owner-specified 2026-08-10). Graded on three visible
    // elements: on all fours, back to the camera with the face away from the lens, and the
    // viewer's own hands on her waist or hips. `viewerParts` is hands ONLY — the pinned
    // acceptance composition does not put the viewer's anatomy in this frame.
    id: "on_all_fours",
    camera: { orientation: "away", distance: "close", height: "high" },
    viewerParts: ["hands"],
    requiresBare: ["pelvis"],
    intimate: true,
    // "Entering frame from the lower edge" is the frame anchor that keeps these hands the
    // VIEWER's (probe run 2026-08-14: without it the model gave the hands to her — her own
    // hands on her own hips — and the viewer vanished from the shot entirely). The palms-
    // and-knees clause pins the actual all-fours pose, which the first draft's bare "on all
    // fours" let drift into a kneeling lean.
    template:
      "{name} on all fours with {name}'s palms and {name}'s knees planted, {name}'s back to the camera and {name}'s bare hips raised toward the viewer, {name}'s head lowered and facing away from the lens, the viewer's own hands entering frame from the lower edge and resting on {name}'s waist and hips",
    cast: "solo",
  },
  {
    // Acceptance scene "Missionary" (owner-specified 2026-08-10). Graded on: on her back
    // facing up at the camera, penetration visible at the bottom frame edge, and the
    // viewer's hands on her legs OR her waist — the template names both, since either hand
    // position passes.
    id: "lying_beneath_viewer",
    camera: { orientation: "toward_viewer", distance: "close", height: "high" },
    viewerParts: ["hands", "genitals"],
    requiresBare: ["pelvis"],
    intimate: true,
    template:
      "{name} on {name}'s back beneath the viewer with {name}'s face turned up toward the camera, the viewer's own genitals entering frame at the bottom edge in penetration with {name}'s bare pelvis, the viewer's own hands holding {name}'s legs and waist",
    cast: "solo",
  },
  {
    id: "lying_face_down",
    camera: { orientation: "away", distance: "medium", height: "high" },
    viewerParts: ["hands"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} lying face down along the bed with {name}'s back to the camera and {name}'s head turned to the side against the pillow, the viewer's own hands resting on {name}'s shoulders",
    cast: "solo",
  },
  {
    id: "spooned_from_behind",
    camera: { orientation: "away", distance: "close", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} lying on {name}'s side with {name}'s back curled against the viewer's chest, the viewer's own arm draped over {name}'s waist and the viewer's own hand resting on {name}'s stomach",
    cast: "solo",
  },
  {
    id: "pressed_to_wall_facing",
    camera: { orientation: "toward_viewer", distance: "close", height: "eye_level" },
    viewerParts: ["hands", "forearms"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} standing with {name}'s back against the wall facing the camera and {name}'s face tilted up toward the viewer, the viewer's own hands braced on the wall either side of {name}'s shoulders",
    cast: "solo",
  },
  {
    id: "pressed_to_wall_away",
    camera: { orientation: "away", distance: "close", height: "eye_level" },
    viewerParts: ["hands"],
    requiresBare: [],
    intimate: false,
    template:
      "{name} standing facing the wall with {name}'s back to the camera and {name}'s cheek turned against the wall, the viewer's own hands resting on {name}'s shoulders",
    cast: "solo",
  },
];

export function sceneStagingById(id: string): SceneStaging | undefined {
  return sceneStagings.find((entry) => entry.id === id);
}

// ---------------------------------------------------------------------------
// Contact as staging evidence
// ---------------------------------------------------------------------------

/**
 * The minimum a committed contact has to say for this table to read it: which surface acted,
 * which surface it met, and **which side is the player**. Direction is load-bearing — the
 * viewer's hands on the subject's hips and the subject's hands on the viewer's hips are two
 * different shots — so a pair without it could never ground a geometry.
 *
 * Deliberately a projection of `CommittedContactRead` rather than the record itself: this
 * table needs three facts, and taking the whole contact would tie the camera vocabulary to
 * the contact core's lifecycle shape for no gain. Body-to-body only — a hand braced on a
 * wall is a real contact and says nothing about how two bodies are arranged, so it never
 * becomes one of these.
 */
export interface SceneContactPairRead {
  /** `bodyLocationRegistry` id of the acting surface (the contact's `source`). */
  sourceLocationId: string;
  /** `bodyLocationRegistry` id of the touched surface. */
  targetLocationId: string;
  /** True when the acting body is the player's — the viewer is doing the touching. */
  sourceIsPlayer: boolean;
}

/** One row: this contact pair, in this direction, grounds this staging's geometry. */
export interface SceneStagingContactEvidenceRow {
  stagingId: SceneStagingId;
  sourceLocationId: string;
  targetLocationId: string;
  sourceIsPlayer: boolean;
}

/**
 * Committed contact that can stand in for a narration quote — **empty today, and typed so
 * the first honest row is a one-line data edit.**
 *
 * The spec allows an active contact on the focal pair to satisfy a staging's evidence
 * requirement when its location pair matches the staging's geometry, and says the table
 * "starts tiny (only unambiguous pairs)". Applied to the vocabulary that actually exists,
 * "only unambiguous pairs" comes out empty, and that is the finding rather than an omission:
 * the chat contact lane commits **affectionate touch only** — a hand (`hands`) meeting
 * `shoulders`, `upper_arms`, `arms`, `forearms`, `hands`, `back`, `head`, or `hair`
 * (`turns/chat-contact-vocabulary.ts`) — and every one of those pairs is consistent with
 * several stagings and with no staging at all. A hand on the back belongs to a face-to-face
 * embrace as readily as to a hold from behind; a hand on the head is as much a head-pat as
 * it is `kneeling_before_viewer_guided`. Writing either row would spend a provenance-carrying
 * fact on a guess, which is exactly what the propose-then-verify architecture exists to stop.
 *
 * What would populate it is the pairs the affectionate lexicon deliberately excludes — waist
 * and hips as targets of the viewer's hands, which are the unambiguous half of
 * `on_all_fours` and `bent_over_surface`. When an intimate contact domain commits those,
 * each becomes one row here and nothing else changes.
 */
export const sceneStagingContactEvidence: readonly SceneStagingContactEvidenceRow[] = [];

/**
 * Does any active contact on the focal pair ground this staging?
 *
 * The resolver's read of the table above: `true` means a provenance-carrying fact already
 * says the bodies are arranged this way, so the staging needs no narration quote. Because
 * the table is empty today this answers `false` for everything, which is the correct
 * degradation — every staging still has to earn its place with a verbatim quote.
 */
export function stagingEvidenceFromContacts(
  contacts: readonly SceneContactPairRead[],
  stagingId: string,
): boolean {
  return sceneStagingContactEvidence.some(
    (row) =>
      row.stagingId === stagingId &&
      contacts.some(
        (contact) =>
          contact.sourceLocationId === row.sourceLocationId &&
          contact.targetLocationId === row.targetLocationId &&
          contact.sourceIsPlayer === row.sourceIsPlayer,
      ),
  );
}
