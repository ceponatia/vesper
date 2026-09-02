import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type { SceneCaptureMode, SceneStagingId } from "../scene-ir";
import type {
  ImageAngleBand,
  ImageCameraHeightBand,
  ImageDistanceBand,
  ImageFramingBand,
  ImageLightingBand,
} from "./camera-bands";
import type { ImageConflictKey, ImageStyleMedium } from "./conflict-keys";
import { describe, describeChange, label, listWords, possessionOwners, preservedMeanings } from "./dialect-qwen-prose";
import {
  compileDialectClaims,
  registerImagePromptDialect,
  type HiddenPromptSource,
  type ImageCompiledNegativePrompt,
  type ImageCompiledPositivePrompt,
  type ImageDialectNegativeInput,
  type ImageDialectPositiveInput,
  type ImageNegativeTransportOutcome,
  type ImagePromptDialectDefinition,
  type ImagePromptDialectId,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";
import { imageSceneCaptureMode, imageSceneObscuredFace, imageSceneStagingForm } from "./scene-facts";
import { createSceneStagingSurfaceLog, type SceneStagingSurfaceLog } from "./scene-staging-surfaces";

/**
 * THE TAG FAMILY — one comma-tag implementation, registered under the two
 * SDXL-lineage endpoints whose reviewed prompt format is Danbooru-style tags
 * rather than prose: `aisha-ai-official/likereality-pony-v1` (Compel weighting
 * syntax) and `nsfw-api/sdxl-pulid`.
 *
 * Sharing one implementation is the registry's sanctioned shape, exactly as the
 * prose family does it: each endpoint keeps its own id, pack pair and binding,
 * so promoting a wording finding on Pony moves nothing on PuLID.
 *
 * ## Why tags and not the prose family
 *
 * These are SDXL checkpoints trained on tag corpora. The reviewed Pony page
 * records the endpoint's `prompt` field as taking Compel weighting syntax and
 * the wrapper prepending its own `score_9, score_8_up, score_7_up,` preamble —
 * a tag-space convention that a paragraph of English sits badly beside. So a
 * claim compiles to a short comma phrase here, and the segments are joined with
 * a comma rather than a space.
 *
 * ## Neither endpoint sends a negative
 *
 * Pony's field is real and its channel is selective, and PuLID's field is live
 * but measurably UNSELECTIVE — negating a concept there removed the subject
 * along with it. Neither fact makes any BLOCK's wording earned, so both packs
 * ship with an empty enabled-block list and this dialect drops whatever it is
 * handed, with the endpoint's own reason recorded. Enabling a block later is a
 * data edit behind that block's own trial, on one endpoint at a time.
 *
 * Pony still declares `dedicated_field` rather than `unsupported`, because the
 * declaration describes the ENDPOINT (a working, selective channel exists) while
 * the pack describes what Vesper currently chooses to send through it (nothing).
 * Conflating the two would make "we have not authored a block yet" indis-
 * tinguishable from "this endpoint cannot carry exclusions".
 */

/**
 * The provider-neutral identity lock, as a tag phrase.
 *
 * Not the prose family's sentence: on a tag endpoint an English paragraph is
 * off-distribution, and PuLID's identity transport is a face EMBEDDING rather
 * than a described likeness — the adapter does the work and the prompt only has
 * to avoid fighting it. So the tag states the intent compactly and leaves the
 * mechanism to the endpoint.
 */
const IDENTITY_LOCK_TAG = "same face and likeness as the reference image, consistent facial structure, consistent apparent age";

/** Emitted when two or more identity references ride one request. */
const CAST_INTEGRITY_TAG = "each person rendered exactly once, no merged faces, no duplicated people";

/** Below the operation band (100+), above every projection claim. */
const IDENTITY_LOCK_PRIORITY = 99;

/** One step under the lock, so the adaptation reads as part of the lock's phrase. */
const FACE_VISIBILITY_PRIORITY = 98.9;

const TAG_PRIORITY = {
  change: 100.4,
  preserve: 100.3,
  geometry: 100.2,
  literalText: 100.1,
} as const;

interface RenderState {
  lockEmitted: boolean;
}

/** A tag phrase: lowercase, no terminal punctuation, internal commas stripped. */
function tag(text: string): string {
  return text
    .replace(/[.!?…]+\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * How this family says one claim.
 *
 * Exhaustive over the concept registry for the same reason every dialect's
 * switch is: a new world concept must be worded deliberately per endpoint family
 * rather than silently never reaching a payload.
 */
function renderClaim(
  claim: ImagePositiveClaim,
  input: ImageDialectPositiveInput,
  state: RenderState,
  spec: TagDialectSpec,
  surfaces: SceneStagingSurfaceLog,
): ImagePromptSegment | null {
  const say = (text: string, priority: number = claim.priority): ImagePromptSegment | null => {
    const phrase = tag(text);
    return phrase.length === 0
      ? null
      : { kind: claim.segmentKind, text: phrase, mandatory: claim.required, priority };
  };
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);
  /** `subject, predicate` — or the bare predicate when nobody is named. */
  const of = (predicate: string): string => (subject === null ? predicate : `${subject} ${predicate}`);

  switch (claim.concept) {
    // --- Operation ------------------------------------------------------------
    case "operation.change":
      return say(describeChange(claim.value), TAG_PRIORITY.change);
    case "operation.preserve": {
      const preserved = preservedMeanings(input, claim.value);
      if (preserved.length === 0) return null;
      return say(`unchanged from the source: ${listWords(preserved)}`, TAG_PRIORITY.preserve);
    }
    case "operation.geometry":
      return say(
        value === "canvas_may_expand" ? "extended canvas, uncompressed subject" : "recomposed frame",
        TAG_PRIORITY.geometry,
      );
    case "operation.subject_count": {
      const count = Number(claim.value);
      if (!Number.isFinite(count) || count <= 0) return say("no people");
      return say(count === 1 ? "solo, 1girl or 1boy as appropriate, exactly one person" : `${count} people`);
    }
    case "operation.literal_text":
      // Quoted so the lettering is legible as a unit; `supportsLiteralQuotes` is
      // false on both endpoints, so this is a best-effort tag rather than a
      // capability claim — an SDXL checkpoint's text rendering is unreliable and
      // nothing here pretends otherwise.
      return say(object === null ? `text reading "${value}"` : `${object} with text reading "${value}"`, TAG_PRIORITY.literalText);
    case "operation.reference_role":
      // Neither endpoint has a composition slot to introduce: Pony publishes no
      // image input at all, and PuLID's single `reference_image` is a face
      // embedding rather than an image the prompt composes with. The identity
      // lock below is the whole of what a reference means here.
      return null;

    // --- Scene ----------------------------------------------------------------
    case "scene.mood":
      return say(`${value} mood`);
    case "scene.capture_mode": {
      const mode = imageSceneCaptureMode(claim.value);
      return mode === null ? null : say(captureModeTag(mode, subject));
    }
    case "scene.possession": {
      // The abstract binding, in tag space. It names NO limb on purpose: an
      // enumerated version ("every hand, arm, leg and foot belongs to Mira")
      // measured worse and painted a phantom viewer hand anyway, because a limb
      // noun summons a limb even when it is possessively bound. `or`, because
      // each part belongs to exactly one of them. No owners, no tag — a
      // possession phrase that binds nothing is the shape that was falsified.
      const owners = possessionOwners(input, claim.value);
      return owners.length === 0 ? null : say(`every visible body part belongs to ${listWords(owners, "or")}`);
    }
    case "scene.staging": {
      const form = imageSceneStagingForm(claim.value);
      // REPLACES the registry's wording, and says so. The measured templates are
      // prose, and prose in a comma-tag payload is the thing this family exists
      // to avoid — but declining is a decision a render has to record, or a
      // reader finds `on_all_fours@3` in this endpoint's provenance and credits
      // the measurements behind it to an image that never contained those words.
      return form === null ? null : say(stagingTag(surfaces.replace(claim.id, form), subject ?? "the subject"));
    }

    // --- Subject --------------------------------------------------------------
    case "subject.identity": {
      if (spec.referenceIsIdentityAdapter && input.references.length > 0) {
        if (!state.lockEmitted) {
          state.lockEmitted = true;
          const cast = input.references.filter((slot) => slot.role === "identity").length >= 2;
          return {
            kind: claim.segmentKind,
            text: cast ? `${IDENTITY_LOCK_TAG}, ${CAST_INTEGRITY_TAG}` : IDENTITY_LOCK_TAG,
            mandatory: true,
            priority: IDENTITY_LOCK_PRIORITY,
          };
        }
        return say(of(value), IDENTITY_LOCK_PRIORITY);
      }
      return say(of(value));
    }
    case "subject.face_visibility": {
      // The lock's adaptation, in tag space — this family's own phrasing rather
      // than the prose sentence, for the reason the lock is a tag here: an
      // English clause is off-distribution on an SDXL checkpoint. The negative
      // half stays negative, as `CAST_INTEGRITY_TAG`'s already does, because "do
      // not rotate" is the whole instruction and there is no positive spelling of
      // it that does not re-describe the pose the shot already stated.
      const visibility = imageSceneObscuredFace(claim.value);
      if (visibility === null) return null;
      const who = subject ?? "the subject";
      const preserved =
        visibility === "partial"
          ? `${who} face partly turned from the camera, visible features, hair, build and skin tone preserved`
          : `${who} face not visible, hair, build and skin tone preserved`;
      return say(`${preserved}, do not rotate ${who} to face the camera`, FACE_VISIBILITY_PRIORITY);
    }
    case "subject.apparent_age":
      return say(of(`appears ${value}`));
    case "subject.morphology":
    case "subject.appearance":
    case "subject.intimate_anatomy":
      return say(of(value));
    case "subject.absence":
      return say(of(`${value}, anatomically correct`));
    case "subject.pose":
    case "subject.activity":
    case "subject.body_language":
    case "subject.current_state":
      // Activity shares the pose arm: in tag space both are the same
      // `<subject> <phrase>` shape, and the distinction between being held one
      // way and doing one thing is upstream in the world rather than in these
      // words.
      return say(of(value));
    case "subject.expression":
      return say(of(`${value} expression`));
    case "subject.wardrobe":
      return say(of(`wearing ${value}`));
    case "subject.exposure":
      return say(of(value));

    // --- Camera ---------------------------------------------------------------
    case "camera.framing":
      return say(framingTag(claim.value as ImageFramingBand));
    case "camera.distance":
      return say(distanceTag(claim.value as ImageDistanceBand));
    case "camera.angle":
      return say(angleTag(claim.value as ImageAngleBand));
    case "camera.height":
      return say(heightTag(claim.value as ImageCameraHeightBand));
    case "camera.motion":
      return value === "still" ? null : say(`motion blur, ${value} movement`);
    case "camera.lighting":
      return say(lightingTag(claim.value as ImageLightingBand));

    // --- Relations ------------------------------------------------------------
    case "relation.wears":
      return relationTag(say, subject, "wearing", object);
    case "relation.holds":
      return relationTag(say, subject, "holding", object);
    case "relation.contains":
      return relationTag(say, subject, "containing", object);
    case "relation.attached_to":
      return relationTag(say, subject, "attached to", object);
    case "relation.located_at":
      return relationTag(say, subject, "at", object);
    case "relation.placement":
      return relationTag(say, subject, placementTag(value), object);
    case "relation.contact":
      return relationTag(say, subject, "touching", object);
    case "relation.acts_on":
      return relationTag(say, subject, "acting on", object);

    // --- Item -----------------------------------------------------------------
    case "item.identity":
    case "item.form":
    case "item.configuration":
    case "item.presentation":
      return say(value);
    case "item.material":
      return say(`made of ${value}`);
    case "item.color":
      return say(`${value} coloured`);
    case "item.part":
      return say(`with ${value}`);
    case "item.marking":
      return say(`marked "${value}"`);
    case "item.condition":
      return say(value);
    case "item.contents":
      return say(`containing ${value}`);

    // --- Location -------------------------------------------------------------
    case "location.identity":
    case "location.kind":
    case "location.geometry":
    case "location.presentation":
    case "location.contents":
    case "location.condition":
    case "location.atmosphere":
    case "location.occupancy":
      return say(value);
    case "location.signage":
      return say(`sign reading "${value}"`);
    case "location.lighting":
      return say(`lit by ${value}`);
    case "location.weather":
      return say(value);
    case "location.time":
      return say(value);

    // --- Style ----------------------------------------------------------------
    case "style.medium":
      return say(mediumTag(claim.value as ImageStyleMedium));
    case "style.descriptor":
    case "style.quality":
      return say(value);

    // --- Raw ------------------------------------------------------------------
    case "raw.text":
      // Verbatim: a lab caller opted out of the guarantees, and rewriting their
      // words would be the worst of both worlds.
      return say(value);
  }
}

/** Both ends or nothing — a half-bound relation invites an invented object. */
function relationTag(
  say: (text: string, priority?: number) => ImagePromptSegment | null,
  subject: string | null,
  verb: string,
  object: string | null,
): ImagePromptSegment | null {
  if (subject === null || object === null) return null;
  return say(`${subject} ${verb} ${object}`);
}

function placementTag(value: string): string {
  switch (value) {
    case "left_of":
      return "to the left of";
    case "right_of":
      return "to the right of";
    case "in_front_of":
      return "in front of";
    case "behind":
      return "behind";
    default:
      return "positioned relative to";
  }
}

function framingTag(band: ImageFramingBand): string {
  switch (band) {
    case "close_up":
      return "close-up";
    case "portrait":
      return "portrait framing, head and shoulders";
    case "waist_up":
      return "upper body, waist up";
    case "full_figure":
      return "full body, whole figure in frame";
    case "wide":
      return "wide shot, small in frame";
  }
}

function distanceTag(band: ImageDistanceBand): string {
  switch (band) {
    case "touching":
      return "intimate camera distance";
    case "close":
      return "close camera distance";
    case "near":
      return "medium camera distance";
    case "distant":
      return "distant camera";
  }
}

function angleTag(band: ImageAngleBand): string {
  switch (band) {
    case "toward":
      return "facing viewer";
    case "side_on":
      return "profile view";
    case "away":
      return "from behind, back turned";
  }
}

function heightTag(band: ImageCameraHeightBand): string {
  switch (band) {
    case "eye_level":
      return "eye-level shot";
    case "high":
      return "high angle, camera above the eye line looking down";
    case "low":
      return "low angle, camera below the eye line looking up";
  }
}

/**
 * Who holds the camera, as tags.
 *
 * Positive phrasings only. A tag endpoint responds to what a phrase NAMES, and
 * the scar behind the app's own POV rule is exactly that: "the player is the
 * camera" had models painting hands gripping one, and "no hands in frame"
 * summoned foreground hands. So the POV tag states whose eyes the shot is
 * through and stops, and the selfie tag states the arrangement rather than
 * denying the alternative.
 */
function captureModeTag(mode: SceneCaptureMode, subject: string | null): string {
  const who = subject ?? "the subject";
  switch (mode) {
    case "third_person":
      return "third-person camera, observed from outside the scene";
    case "first_person_disembodied":
      return "first-person pov, the shot seen through the viewer's own eyes, the viewer not visible";
    case "first_person_embodied":
      return "first-person pov, the shot seen through the viewer's own eyes, the viewer's own body cropped into frame, their face and head out of frame";
    case "selfie":
      return `phone selfie taken by ${who}, camera at arm's length or in a mirror, ${who} looking into the lens`;
  }
}

/**
 * One staged arrangement, in this family's own words.
 *
 * **REPLACES the registry's surface form rather than adopting it**, and the
 * decision is a wording one rather than a doubt about the measurements. Those
 * templates are long possessive-bound English clauses tuned against prose
 * endpoints; these are SDXL checkpoints trained on tag corpora, where a paragraph
 * sits as badly as it does for the identity lock this family already rewrote.
 *
 * The phrases are deliberately SHORT, and stay short. What makes the registry's
 * wording worth preserving is a residue of measured anchors — a named forearm,
 * the frame's lower corners, a foreshortening clause — that carries nearly all of
 * its behavioral delta on the endpoints it was measured on. Reproducing those
 * here would be adopting the wording without the call site that records the
 * adoption, and provenance would then read `replaced` over bytes that were not.
 * So this states the geometry and nothing else, and earns anchors of its own only
 * from a trial on these endpoints.
 *
 * Every limb noun is bound to an owner — to the subject or to "the viewer's
 * own" — because an unowned limb in a two-body prompt is the phantom-limb scar,
 * and it is no less true in tag space than in prose. Exhaustive over the
 * arrangement vocabulary: a new staging is a compile error here rather than a
 * shot these endpoints silently render as an ordinary portrait.
 */
function stagingTag(id: SceneStagingId, who: string): string {
  switch (id) {
    case "held_from_behind":
      return `${who} standing, ${who}'s back against the viewer's chest, the viewer's own arms closed around ${who} from behind`;
    case "held_from_behind_bare":
      return `${who} standing bare-skinned, ${who}'s back against the viewer's chest, the viewer's own hands on ${who}'s bare breasts`;
    case "kneeling_before_viewer":
      return `${who} kneeling below the camera, ${who}'s face tilted up, ${who}'s mouth on the viewer's own genitals`;
    case "kneeling_before_viewer_guided":
      return `${who} kneeling with ${who}'s head bowed, ${who}'s mouth on the viewer's own genitals, the viewer's own hand flat on top of ${who}'s head`;
    case "astride_viewer_facing":
      return `${who} astride the viewer facing the camera, penetration at ${who}'s bare pelvis, the viewer's own hands on ${who}'s waist`;
    case "astride_viewer_away":
      return `${who} astride the viewer facing away, ${who}'s back to the camera, penetration at ${who}'s bare pelvis, the viewer's own hands on ${who}'s hips`;
    case "bent_over_surface":
      return `${who} bent forward over a waist-high surface, ${who}'s back to the camera, penetration from behind at ${who}'s bare pelvis, the viewer's own hands on ${who}'s hips`;
    case "on_all_fours":
      return `${who} on all fours, ${who}'s back to the camera and ${who}'s bare hips raised toward the viewer, the viewer's own hands on ${who}'s waist`;
    case "lying_beneath_viewer":
      return `${who} on ${who}'s back beneath the viewer, ${who}'s face turned up to the camera, penetration at ${who}'s bare pelvis, the viewer's own hands on ${who}'s legs`;
    case "lying_face_down":
      return `${who} lying face down, ${who}'s back to the camera and ${who}'s head turned to the side, the viewer's own hands on ${who}'s shoulders`;
    case "spooned_from_behind":
      return `${who} lying on ${who}'s side, ${who}'s back curled against the viewer's chest, the viewer's own arm draped over ${who}'s waist`;
    case "pressed_to_wall_facing":
      return `${who} standing with ${who}'s back to the wall facing the camera, the viewer's own hands braced on the wall either side of ${who}`;
    case "pressed_to_wall_away":
      return `${who} standing facing the wall, ${who}'s back to the camera, the viewer's own hands on ${who}'s shoulders`;
  }
}

function lightingTag(band: ImageLightingBand): string {
  switch (band) {
    case "bright":
      return "bright even lighting";
    case "dim":
      return "dim low light";
    case "dark":
      return "near darkness, shape only";
    case "silhouette":
      return "backlit silhouette";
  }
}

function mediumTag(medium: ImageStyleMedium): string {
  switch (medium) {
    case "photographic":
      return "photorealistic, real optics, natural skin detail";
    case "illustration":
      return "illustration";
    case "anime":
      return "anime style";
    case "painting":
      return "painting, visible brushwork";
    case "render_3d":
      return "3d render";
    case "unspecified":
      // Unreachable through the selector, which emits this claim only for a
      // known medium. Answering honestly keeps the switch total.
      return "";
  }
}

/**
 * One forbidden outcome as a tag phrase.
 *
 * Exported and exhaustive so a new conflict key is a compile error rather than
 * a key silently forbidden by nothing — even though nothing is sent today, the
 * wording has to exist before a block trial can grade it.
 */
export function tagFamilyNegativePhrase(key: ImageConflictKey): string {
  switch (key) {
    case "text":
      return "text";
    case "letters":
      return "garbled letters";
    case "caption":
      return "caption";
    case "logo":
      return "logo";
    case "signature":
      return "signature";
    case "watermark":
      return "watermark";
    case "extra_limbs":
      return "extra limbs";
    case "extra_digits":
      return "extra fingers";
    case "extra_appendages":
      return "extra appendages";
    case "missing_limbs":
      return "missing limbs";
    case "missing_digits":
      return "missing fingers";
    case "malformed_hands":
      return "bad hands";
    case "duplicated_anatomy":
      return "duplicated body parts";
    case "disconnected_anatomy":
      return "disconnected limbs";
    case "multiple_people":
      return "multiple people";
    case "duplicate_face":
      return "duplicated face";
    case "identity_drift":
      return "different face from reference";
    case "cropped":
      return "cropped";
    case "close_up":
      return "extreme close-up";
    case "blur":
      return "blurry";
    case "out_of_frame":
      return "out of frame";
    case "confused_composition":
      return "confused composition";
    case "impossible_overlap":
      return "impossible geometry";
    case "synthetic_skin":
      return "plastic skin";
    case "excessive_smoothing":
      return "oversmoothed skin";
    case "oversaturation":
      return "oversaturated";
    case "low_resolution":
      return "low resolution";
    case "low_quality":
      return "low quality";
    case "photographic":
      return "photorealistic";
    case "illustration":
      return "illustration";
    case "anime":
      return "anime";
    case "painting":
      return "painterly";
    case "render_3d":
      return "3d render";
    case "background_clutter":
      return "cluttered background";
    case "extra_objects":
      return "unrelated objects";
  }
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** What one tag endpoint states about itself. Everything else is shared. */
export interface TagDialectSpec {
  readonly id: ImagePromptDialectId;
  readonly positiveSyntax: "compact_tags" | "compel_tags";
  readonly negativeSyntax: "compact_tags" | "compel_tags" | "none";
  readonly negativeTransport: "dedicated_field" | "unsupported";
  /**
   * True when this endpoint carries identity through a reference image at all.
   * PuLID does, through its face-embedding adapter; Pony publishes no image
   * input, so an identity lock there would name a reference the payload cannot
   * contain.
   */
  readonly referenceIsIdentityAdapter: boolean;
  /** Why every exclusion drops today — an endpoint fact, recorded per endpoint. */
  readonly negativeDropReason: string;
  readonly hiddenPromptSources: readonly HiddenPromptSource[];
}

/**
 * Tags join with `", "`, not the segment vocabulary's space.
 *
 * Done by re-joining the FITTED segments rather than by having each claim emit
 * its own trailing comma: fitting, the mandatory floor, the compress-then-remove
 * order and the dropped-claim record are `@vesper/image-core`'s tested behavior
 * and stay untouched, and only the separator — which is genuinely this family's
 * own business — changes.
 *
 * The one consequence worth stating: `fitImagePromptSegments` measures the
 * budget against space joining, so a fitted tag prompt is one character per
 * segment boundary longer than the fitter believed. The direction is safe
 * (the budget is under-spent, never over-run by more than the segment count) and
 * the budgets these endpoints carry have far more headroom than that.
 */
function joinTags(segments: readonly ImagePromptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(", ");
}

function compilePositiveFor(spec: TagDialectSpec) {
  return (input: ImageDialectPositiveInput): ImageCompiledPositivePrompt => {
    const state: RenderState = { lockEmitted: false };
    const surfaces = createSceneStagingSurfaceLog();
    const compiled = compileDialectClaims({
      claims: input.claims,
      render: (claim) => renderClaim(claim, input, state, spec, surfaces),
      surfaces,
      budget: input.budget,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
    return { ...compiled, text: joinTags(compiled.segments) };
  };
}

/**
 * Drop every exclusion, with this endpoint's reason.
 *
 * Both endpoints' packs enable no blocks, so `input.constraints` is empty on
 * every production compile today and this loop produces nothing. It is written
 * for the day a block trial promotes one: the outcome record is what an operator
 * reads to see that a constraint was selected and then not sent, and a dialect
 * that returned an empty outcome list would make an unsent block look like a
 * block nobody selected.
 */
function compileNegativeFor(spec: TagDialectSpec) {
  return (input: ImageDialectNegativeInput): ImageCompiledNegativePrompt => ({
    text: null,
    replacementClaims: [],
    inlineText: [],
    outcomes: input.constraints.map((constraint): ImageNegativeTransportOutcome => ({
      constraintId: constraint.id,
      transport: { kind: "dropped", reason: spec.negativeDropReason },
    })),
  });
}

function tagDialect(spec: TagDialectSpec): ImagePromptDialectDefinition {
  const definition: ImagePromptDialectDefinition = {
    id: spec.id,
    positiveSyntax: spec.positiveSyntax,
    negativeSyntax: spec.negativeSyntax,
    negativeTransport: spec.negativeTransport,
    // Neither endpoint composes from numbered or role-labelled slots — see
    // `operation.reference_role` above.
    referenceSyntax: "none",
    supportsWeights: spec.positiveSyntax === "compel_tags",
    supportsLiteralQuotes: false,
    hiddenPromptSources: spec.hiddenPromptSources,
    compilePositive: compilePositiveFor(spec),
    compileNegative: compileNegativeFor(spec),
  };
  registerImagePromptDialect(definition);
  return definition;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** No block has earned its wording on either endpoint yet — see the module doc. */
const NO_BLOCK_TRIAL = "no_negative_block_trial_on_endpoint";

/**
 * `aisha-ai-official/likereality-pony-v1` — Compel weighting syntax, no image
 * input of any kind, and a real `negative_prompt` whose provider default
 * (`"nsfw, naked"`) Vesper clears.
 *
 * Two hidden sources, both probed facts. The wrapper's `prepend_preprompt`
 * defaults true and prepends the Pony score-tag preamble to the positive prompt
 * AND its own preamble to the negative one — a channel Vesper contributes to
 * without authoring, which is exactly what `hiddenPromptSources` exists to
 * record. Neither is overridable through the prompt; the boolean is.
 */
export const likeRealityPonyDialect = tagDialect({
  id: "pony_compel_tags",
  positiveSyntax: "compel_tags",
  negativeSyntax: "compel_tags",
  negativeTransport: "dedicated_field",
  referenceIsIdentityAdapter: false,
  negativeDropReason: NO_BLOCK_TRIAL,
  hiddenPromptSources: [
    { kind: "quality_preamble", field: "prepend_preprompt", value: "score_9, score_8_up, score_7_up,", overridable: true },
    { kind: "provider_default_negative", field: "negative_prompt", value: "nsfw, naked", overridable: true },
  ],
});

/**
 * `nsfw-api/sdxl-pulid` — an identity-adapter pipeline over an SDXL checkpoint.
 * Its single `reference_image` is a face embedding rather than a composition
 * slot, which is why `referenceIsIdentityAdapter` is true and the reference
 * syntax is still `none`.
 *
 * `negativeTransport` is `unsupported` despite a live field, and that is the
 * measured answer rather than a deferral: the fruit-bowl canary (2026-08-29)
 * found the channel unselective — negating a concept removed the subject with
 * it in every ON render at both guidance levels. No lane adopts the field until
 * a block trial proves a wording selective enough to trust, and such a trial
 * must grade collateral damage as a first-class metric.
 */
export const sdxlPulidDialect = tagDialect({
  id: "sdxl_pulid_tags",
  positiveSyntax: "compact_tags",
  negativeSyntax: "none",
  negativeTransport: "unsupported",
  referenceIsIdentityAdapter: true,
  negativeDropReason: "endpoint_negative_field_measured_unselective",
  hiddenPromptSources: [],
});
