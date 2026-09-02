import type { ImagePromptSegmentKind } from "../render-intent/prompt-segments";
import type { ImageConflictKey } from "./conflict-keys";

/**
 * The closed semantic vocabulary both prompt channels compile from.
 *
 * A concept is what a fact MEANS, stated once, in a form no model owns. "This
 * character's hair is auburn" is `subject.appearance` — not the sentence "auburn
 * hair falls past her shoulders", and not the tag `auburn_hair`. The sentence and
 * the tag are dialect output; the concept is the input both are compiled from.
 *
 * Why a closed registry rather than free strings: three things downstream have to
 * be decidable without reading prose.
 *
 * 1. **Order.** Every concept declares the prompt-segment kind its prose belongs
 *    to, so the existing canonical order and mandatory floor apply to claims for
 *    free — a claim never has to restate where it goes in a prompt.
 * 2. **Protection.** Every concept declares which conflict keys asserting it puts
 *    beyond a negative constraint's reach. That is the entire safety property of
 *    the negative system, and a free-string concept could not participate in it.
 * 3. **Coverage.** A projection has to say what happened to every image-eligible
 *    field it owns, and "which concept did you project it as" is the question a
 *    classification check can actually ask.
 *
 * Adding a concept is a deliberate edit here plus a dialect decision about how to
 * spell it. That cost is the point: it is what stops a new world field from being
 * patched into four model templates separately.
 */

/**
 * Which side of the world a concept describes.
 *
 * Read by the positive selector, which walks the channels in the canonical fact
 * selection order (operation, then the scene, then subjects, then camera, then
 * relations, then items, then location, then style) rather than trusting
 * whatever order an adapter happened to build its facts in.
 *
 * `scene` is the odd one to read: it describes the SHOT rather than anybody or
 * anything in it — what the moment feels like, whose eyes it is through, how two
 * bodies are arranged. It sits second because a scene fact frames every subject
 * standing in it, so when a scene claim and a subject claim land in the same
 * prompt segment the frame is stated first. Channel is not segment kind: nothing
 * in this channel emits into a "scene" segment, because there is none — mood
 * lands in `atmosphere`, capture mode in `framing`, staging in `pose`.
 *
 * `viewer` is the person holding the camera, and it is its own channel because
 * they are neither a subject nor a place. The viewer is deliberately absent from
 * the digest's entities — no ref for a relation to bind, no label a sentence
 * could call them by, and never a member of `operation.subjectCount`, which
 * counts the cast — yet an embodied first-person shot crops their own hands,
 * forearms, lap, legs or torso into the foreground and has to say so. Filing
 * those claims as `subject` facts would enter the viewer into the cast; filing
 * them as `scene` facts would say the shot has a mood-like property rather than
 * that a body is in frame. It sits between the two for the same reason `scene`
 * sits before `subject`: the foreground the lens is looking past frames every
 * subject standing behind it.
 */
export const imageConceptChannels = [
  "operation",
  "scene",
  "viewer",
  "subject",
  "camera",
  "relation",
  "item",
  "location",
  "style",
  "raw",
] as const;
export type ImageConceptChannel = (typeof imageConceptChannels)[number];

/** One concept's fixed meaning: where its prose goes, and what it defends. */
export interface ImageConceptDefinition {
  readonly id: ImageConceptId;
  readonly channel: ImageConceptChannel;
  /** The prompt-segment kind this concept's compiled prose belongs to. */
  readonly segmentKind: ImagePromptSegmentKind;
  /**
   * Conflict keys this concept protects WHENEVER it is asserted, regardless of
   * its value.
   *
   * Value-sensitive protections (which medium, which camera band, how many
   * people) are deliberately NOT here — they are derived in
   * `imageProtectedConflictKeys`, because a table cannot express "protects
   * close_up only when the framing band is a portrait".
   */
  readonly protects: readonly ImageConflictKey[];
}

/**
 * Every concept Vesper can state about an image, grouped by channel.
 *
 * The groups below are that fact-selection order read top to bottom, which
 * is also the order `orderImagePositiveClaims` emits them in when two claims
 * share a segment kind.
 *
 * Three entries carry no static protection where a reader might expect one, and
 * all three are deliberate. `subject.morphology` protects nothing on its own: an
 * ordinary pair of arms must not switch off the duplicated-anatomy exclusion, so
 * protection comes from the fact's own tags instead — a tail protects appendages,
 * a human shoulder protects nothing. `style.medium` and `scene.capture_mode`
 * likewise protect nothing here, because which key either defends depends
 * entirely on which medium or which capture mode it names.
 *
 * ## Why optional detail never lands in a mandatory segment kind
 *
 * `identity`, `morphology`, `age`, `wardrobe` and `exposure` are kinds the
 * segment vocabulary protects from fitting, and that protection is applied by
 * KIND. So a concept that carries optional detail must not be routed into one:
 * an item's authored description filed under `identity` would be a paragraph no
 * budget squeeze could ever remove, and the fitter would start compressing the
 * sentences a render actually depends on instead.
 *
 * That is why `subject.appearance` sits in `current_state` rather than
 * `identity` — the same call the visual digest already makes for presentation
 * facts, for the same reason — while `item.identity` and `location.identity` DO
 * sit in `identity`, because an item render's subject is the item and a location
 * render's subject is the place. Each of those carries exactly one required fact
 * (the name); every optional detail about them is a different concept.
 *
 * The rule binds the whole `scene` channel absolutely (owner ruling
 * 2026-09-01): no scene concept may be filed into a mandatory kind, because a
 * scene is the layer that should give way under a squeeze before a character
 * stops being recognizable — and a scene concept that could never be dropped
 * would make the fitter compress the identity anchor instead.
 */
const CONCEPT_TABLE = [
  // --- Operation and change contract ------------------------------------------
  // What this render is FOR. An edit's delta leads the prompt; a generation's
  // subject count and required text are facts about the job rather than about
  // anyone in it.
  { id: "operation.change", channel: "operation", segmentKind: "operation", protects: [] },
  { id: "operation.preserve", channel: "operation", segmentKind: "operation", protects: [] },
  { id: "operation.geometry", channel: "operation", segmentKind: "operation", protects: [] },
  { id: "operation.subject_count", channel: "operation", segmentKind: "identity", protects: [] },
  // Requested lettering is the canonical collision case: a render that must spell
  // EXIT cannot also forbid text, letters or captions.
  {
    id: "operation.literal_text",
    channel: "operation",
    segmentKind: "operation",
    protects: ["text", "letters", "caption"],
  },
  { id: "operation.reference_role", channel: "operation", segmentKind: "operation", protects: [] },

  // --- Scene ------------------------------------------------------------------
  // What the SHOT is, as distinct from who is in it. Every one of these emits
  // into an existing segment kind, and none may use a mandatory one: `identity`,
  // `morphology`, `age`, `wardrobe` and `exposure` are unfittable BY KIND, so a
  // scene concept routed into one would be a sentence no budget squeeze could
  // ever drop — and a scene is exactly the layer that should give way before a
  // character stops being recognizable (owner ruling 2026-09-01).
  //
  // A required scene fact is still expressible: the projection marks it
  // `required_visual` and the claim carries the mandatory flag itself, which is
  // the lever that belongs to the owner of the fact rather than to the segment.
  { id: "scene.mood", channel: "scene", segmentKind: "atmosphere", protects: [] },
  // Third-person, first-person POV or a selfie — one closed choice, because they
  // are three arrangements of the same two bodies rather than flags on one.
  // Protects nothing HERE for the reason `style.medium` does not: which key a
  // capture mode puts beyond reach depends entirely on which mode it names, and
  // a table that cannot see the value cannot express "a selfie is a requested
  // arm's-length crop".
  { id: "scene.capture_mode", channel: "scene", segmentKind: "framing", protects: [] },
  // The abstract possession clause of the POV composite. `pose` because it is a
  // statement about the bodies in frame, and it protects NOTHING on purpose: the
  // clause asserts that every visible limb has a named owner, which agrees with
  // the anatomy exclusions rather than contradicting them.
  { id: "scene.possession", channel: "scene", segmentKind: "pose", protects: [] },
  // A staged two-body arrangement. It protects `multiple_people` whatever it
  // says, because every arrangement in the vocabulary puts the viewer's own body
  // in frame alongside the subject's — the single-subject exclusion would be the
  // prompt arguing with the geometry the story described. The same call
  // `location.occupancy` makes for a crowded market.
  { id: "scene.staging", channel: "scene", segmentKind: "pose", protects: ["multiple_people"] },

  // --- Viewer -----------------------------------------------------------------
  // The person holding the camera, whose own body an embodied first-person shot
  // crops into the foreground. Never a subject: the viewer has no entity slice,
  // no ref a relation could bind, and no place in `operation.subjectCount`.
  //
  // Both kinds are droppable BY KIND, for the reason the whole `scene` channel
  // is: the viewer's own forearm is the layer that should give way under a
  // budget squeeze before a character stops being recognizable.
  //
  // The geometry claim protects `multiple_people` for exactly the reason
  // `scene.staging` does — it puts a second body's anatomy in frame beside the
  // subject's, so the single-subject exclusion would be the prompt arguing with
  // the frame the story described. What keeps that limb from becoming a whole
  // person is not the exclusion but the positive composite around it: the
  // possessive binding in the wording, the frame geometry it always states, and
  // the person count the operation contract asserts over the cast.
  { id: "viewer.body_geometry", channel: "viewer", segmentKind: "pose", protects: ["multiple_people"] },
  // The viewer's own skin and build for the parts in frame — what keeps a
  // foreground arm the same person's arm from one render to the next.
  { id: "viewer.appearance", channel: "viewer", segmentKind: "current_state", protects: [] },
  // The viewer's own exposed anatomy, stated by a ROUTE that permits it, exactly
  // as `subject.intimate_anatomy` is for the cast. `current_state` for the same
  // reason: a squeeze sheds it before anything a body is recognized by.
  { id: "viewer.intimate_anatomy", channel: "viewer", segmentKind: "current_state", protects: [] },

  // --- Subject ----------------------------------------------------------------
  { id: "subject.identity", channel: "subject", segmentKind: "identity", protects: [] },
  { id: "subject.apparent_age", channel: "subject", segmentKind: "age", protects: [] },
  { id: "subject.morphology", channel: "subject", segmentKind: "morphology", protects: [] },
  // An authored amputation, a congenital absence or a prosthetic. Stated at all,
  // it takes both "missing" exclusions off the table for the whole render.
  {
    id: "subject.absence",
    channel: "subject",
    segmentKind: "morphology",
    protects: ["missing_limbs", "missing_digits"],
  },
  { id: "subject.appearance", channel: "subject", segmentKind: "current_state", protects: [] },
  // Intimate anatomy a ROUTE states beside the cut. The visual-state selection
  // keeps its consent gate shut in every lane, so these facts arrive only from
  // the scene route's own reveal projection, on a rung whose references permit
  // intimate detail. `current_state` — droppable by kind, like appearance detail
  // — because a budget squeeze must be able to shed it before a morphology
  // anchor or the coverage statement. Protects nothing: the anatomy exclusions
  // guard malformed anatomy, and stating a body part plainly agrees with them.
  { id: "subject.intimate_anatomy", channel: "subject", segmentKind: "current_state", protects: [] },
  { id: "subject.pose", channel: "subject", segmentKind: "pose", protects: [] },
  // What the person is DOING, which is not how they are held. "Sitting
  // cross-legged" is a pose and "pouring coffee" is an activity, and a composer
  // produces the two as separate fields — collapsing them into `subject.pose`
  // would make the distinction unrecoverable and leave the acting half of a
  // scene with no concept of its own. Same segment kind, because both are things
  // the pose sentence of a prompt says.
  //
  // Not a relation: `relation.acts_on` needs an object ref naming an entity the
  // digest actually carries, and a dangling one is dropped — so "pouring coffee"
  // has no coffee to point at until item projection populates `digest.items`.
  { id: "subject.activity", channel: "subject", segmentKind: "pose", protects: [] },
  { id: "subject.expression", channel: "subject", segmentKind: "current_state", protects: [] },
  // `pose`, not `current_state`: how a body is HELD is what the pose segment
  // says, and the application's visual digest already classifies its
  // body-language layer as `pose`. Two vocabularies disagreeing here would have
  // meant a posture claim silently emitting later in the prompt than the
  // classification asked for — the character adapter's translation is supposed
  // to preserve a fact's segment kind, not re-file it somewhere cheaper. An
  // expression stays `current_state`: a face is not a posture.
  { id: "subject.body_language", channel: "subject", segmentKind: "pose", protects: [] },
  { id: "subject.current_state", channel: "subject", segmentKind: "current_state", protects: [] },
  { id: "subject.wardrobe", channel: "subject", segmentKind: "wardrobe", protects: [] },
  { id: "subject.exposure", channel: "subject", segmentKind: "exposure", protects: [] },
  // How much of this subject's FACE the shot can show, when the answer is not
  // "all of it" — `partial` or `hidden`. A front-facing shot states nothing.
  //
  // This is the identity lock's ADAPTATION, as a fact. The cheapest way for an
  // edit model to prove it preserved a face is to SHOW that face, so a lock
  // reading "preserve the exact face" quietly rotates a subject the shot just
  // put back-to-camera; what a dialect has to say instead is what to preserve
  // when the face is not the evidence, and that the turn is not on the table.
  // The lock string itself is matched verbatim at the model boundary, so the
  // adaptation is a separate claim and never an edit to those bytes.
  //
  // `identity`, deliberately: the sentence corrects the lock, so it belongs in
  // the lock's own segment kind — adjacent to it by priority, and unfittable by
  // kind for the same reason the lock is. An adaptation a budget squeeze dropped
  // while the lock survived would leave the render with exactly the failure this
  // concept exists to end. That is also why it is a SUBJECT concept rather than
  // a scene one: the scene channel's absolute ban on mandatory kinds is a
  // statement about the layer that should give way, and this claim may not.
  //
  // Protects nothing. It states what to preserve, which agrees with the
  // identity-drift exclusion rather than contradicting it, and a turned head
  // asks for no crop.
  { id: "subject.face_visibility", channel: "subject", segmentKind: "identity", protects: [] },

  // --- Camera -----------------------------------------------------------------
  // Bands, not sentences. Their protections are value-sensitive and derived.
  { id: "camera.framing", channel: "camera", segmentKind: "framing", protects: [] },
  { id: "camera.distance", channel: "camera", segmentKind: "framing", protects: [] },
  { id: "camera.angle", channel: "camera", segmentKind: "framing", protects: [] },
  // A row `positive-claims` cannot do without: it assembles camera concepts as
  // `camera.${fact.component}` through a cast, so a component with no entry here
  // raises no compile error and falls back to the MANDATORY `operation` kind,
  // where the claim becomes unfittable. The row is what makes the claim correct.
  { id: "camera.height", channel: "camera", segmentKind: "framing", protects: [] },
  { id: "camera.motion", channel: "camera", segmentKind: "pose", protects: [] },
  { id: "camera.lighting", channel: "camera", segmentKind: "lighting", protects: [] },

  // --- Relations --------------------------------------------------------------
  // The glue that binds a person to an object and an object to a place. These are
  // facts, not prose connectives: without them a two-character scene has no way
  // to say WHICH woman holds the umbrella.
  { id: "relation.wears", channel: "relation", segmentKind: "wardrobe", protects: [] },
  { id: "relation.holds", channel: "relation", segmentKind: "pose", protects: [] },
  { id: "relation.contains", channel: "relation", segmentKind: "setting", protects: [] },
  { id: "relation.attached_to", channel: "relation", segmentKind: "setting", protects: [] },
  { id: "relation.located_at", channel: "relation", segmentKind: "setting", protects: [] },
  { id: "relation.placement", channel: "relation", segmentKind: "setting", protects: [] },
  { id: "relation.contact", channel: "relation", segmentKind: "pose", protects: [] },
  { id: "relation.acts_on", channel: "relation", segmentKind: "pose", protects: [] },

  // --- Item -------------------------------------------------------------------
  { id: "item.identity", channel: "item", segmentKind: "identity", protects: [] },
  { id: "item.form", channel: "item", segmentKind: "setting", protects: [] },
  { id: "item.material", channel: "item", segmentKind: "setting", protects: [] },
  { id: "item.color", channel: "item", segmentKind: "setting", protects: [] },
  { id: "item.part", channel: "item", segmentKind: "setting", protects: [] },
  // A branded label, an embroidered monogram, a printed slogan. Same collision as
  // operation.literal_text, reached from the item side.
  {
    id: "item.marking",
    channel: "item",
    segmentKind: "setting",
    protects: ["text", "letters", "logo", "caption"],
  },
  { id: "item.condition", channel: "item", segmentKind: "setting", protects: [] },
  { id: "item.contents", channel: "item", segmentKind: "setting", protects: [] },
  { id: "item.configuration", channel: "item", segmentKind: "setting", protects: [] },
  { id: "item.presentation", channel: "item", segmentKind: "framing", protects: [] },

  // --- Location ---------------------------------------------------------------
  { id: "location.identity", channel: "location", segmentKind: "identity", protects: [] },
  { id: "location.kind", channel: "location", segmentKind: "setting", protects: [] },
  { id: "location.geometry", channel: "location", segmentKind: "setting", protects: [] },
  { id: "location.presentation", channel: "location", segmentKind: "framing", protects: [] },
  // Furniture, clutter, crowd, stock on shelves. A room described down to its
  // contents must not also be told to keep its background clean.
  {
    id: "location.contents",
    channel: "location",
    segmentKind: "setting",
    protects: ["background_clutter", "extra_objects"],
  },
  {
    id: "location.signage",
    channel: "location",
    segmentKind: "setting",
    protects: ["text", "letters", "logo", "caption"],
  },
  { id: "location.lighting", channel: "location", segmentKind: "lighting", protects: [] },
  { id: "location.weather", channel: "location", segmentKind: "atmosphere", protects: [] },
  { id: "location.time", channel: "location", segmentKind: "atmosphere", protects: [] },
  { id: "location.condition", channel: "location", segmentKind: "atmosphere", protects: [] },
  { id: "location.atmosphere", channel: "location", segmentKind: "atmosphere", protects: [] },
  // "A busy market" is people. The single-subject block must not fire on it.
  {
    id: "location.occupancy",
    channel: "location",
    segmentKind: "setting",
    protects: ["multiple_people"],
  },

  // --- Style ------------------------------------------------------------------
  { id: "style.medium", channel: "style", segmentKind: "style", protects: [] },
  { id: "style.descriptor", channel: "style", segmentKind: "style", protects: [] },
  { id: "style.quality", channel: "style", segmentKind: "quality", protects: [] },

  // --- Raw --------------------------------------------------------------------
  // The lab/admin escape hatch: operator prose that bypasses fact completeness
  // and collision guarantees by design. It protects
  // NOTHING, because nothing can be known about what it says — which is exactly
  // why a raw caller is labelled unguaranteed rather than quietly trusted.
  { id: "raw.text", channel: "raw", segmentKind: "operation", protects: [] },
] as const satisfies readonly {
  id: string;
  channel: ImageConceptChannel;
  segmentKind: ImagePromptSegmentKind;
  protects: readonly ImageConflictKey[];
}[];

export type ImageConceptId = (typeof CONCEPT_TABLE)[number]["id"];

/** Every concept id, in registry order. */
export const imageConceptIds: readonly ImageConceptId[] = CONCEPT_TABLE.map((entry) => entry.id);

const conceptById: ReadonlyMap<string, ImageConceptDefinition> = new Map(
  CONCEPT_TABLE.map((entry) => [entry.id, entry as ImageConceptDefinition]),
);

/** A concept's definition, or null when the id is not in the closed registry. */
export function imageConcept(id: string): ImageConceptDefinition | null {
  return conceptById.get(id) ?? null;
}

/** Whether an arbitrary string names a registered concept. */
export function isImageConceptId(id: string): id is ImageConceptId {
  return conceptById.has(id);
}

/**
 * The channel order the positive selector walks — the fact-selection steps,
 * collapsed to their channels.
 *
 * Selection order is not emission order — emission is the segment vocabulary's
 * canonical order, which the fitter already owns. This decides which claim is
 * BUILT first, and therefore which one wins a tie when two claims land in the
 * same segment kind with the same priority.
 */
export const imageConceptChannelOrder: readonly ImageConceptChannel[] = [
  "operation",
  "scene",
  "viewer",
  "subject",
  "camera",
  "relation",
  "item",
  "location",
  "style",
  "raw",
];

/** A channel's position in selection order; every channel has one. */
export function imageConceptChannelRank(channel: ImageConceptChannel): number {
  return imageConceptChannelOrder.indexOf(channel);
}
