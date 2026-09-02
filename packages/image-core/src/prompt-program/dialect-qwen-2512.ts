import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type {
  ImageAngleBand,
  ImageCameraHeightBand,
  ImageDistanceBand,
  ImageFramingBand,
  ImageLightingBand,
} from "./camera-bands";
import type { ImageConflictKey, ImageStyleMedium } from "./conflict-keys";
import {
  angleSentence,
  capitalize,
  captureModeSentence,
  describe,
  describeChange,
  distanceSentence,
  faceVisibilityAnchor,
  faceVisibilitySentence,
  framingSentence,
  heightSentence,
  label,
  lightingSentence,
  listWords,
  possessionOwners,
  possessionSentence,
  preservedMeanings,
  mediumSentence,
  prefixed,
  relationSentence,
  sentence,
  spatialWord,
  stagingSentence,
  subjectCountSentence,
  viewerAppearanceSentence,
  viewerGeometrySentence,
  viewerIntimateSentence,
  viewerIsEmbodied,
} from "./dialect-qwen-prose";
import {
  compileDialectClaims,
  registerImagePromptDialect,
  type ImageCompiledNegativePrompt,
  type ImageCompiledPositivePrompt,
  type ImageDialectNegativeInput,
  type ImageDialectPositiveInput,
  type ImagePromptDialectDefinition,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";
import { imageSceneCaptureMode, imageSceneObscuredFace, imageSceneStagingForm } from "./scene-facts";
import { createSceneStagingSurfaceLog, type SceneStagingSurfaceLog } from "./scene-staging-surfaces";

/**
 * `qwen/qwen-image-2512` — the first implemented dialect.
 *
 * Two endpoint facts shape everything here, and both are evidence rather than
 * family folklore:
 *
 * 1. **It wants long, concrete prose.** The official model card's example is a
 *    paragraph that names the person, their age, face, hair, clothing, setting,
 *    lighting, camera feel and composition — not comma-tag shorthand. So every
 *    claim compiles to a SENTENCE, and the existing prompt-segment fitter (which
 *    trims by whole sentences and never cuts through one) is exactly the right
 *    budget behavior for it.
 * 2. **It has a real `negative_prompt` field.** That makes it the endpoint worth
 *    proving the architecture on: both halves of the system have somewhere to go,
 *    so a mistake in the negative design shows up as text in a payload rather
 *    than as a silently-dropped abstraction.
 *
 * What this dialect deliberately does NOT do is copy the model card's negative
 * example. That example forbids text, waxy skin, unusual limbs, blur and
 * low-resolution media — and this endpoint serves item catalog shots, empty rooms,
 * signage, androids and stylized renders, so at least one of those clauses is
 * wrong for almost every render. The wording below is derived from the example
 * clause by clause, but each clause reaches a payload only through a guarded
 * block that the world digest did not veto.
 */

const DIALECT_ID = "qwen_2512_description" as const;

/**
 * Everything the provider contributes on its own.
 *
 * One entry, and its value is the empty string — which is a probed fact, not a
 * placeholder. Qwen 2512's `negative_prompt` default is blank
 * (docs/image-models/models/qwen-image-2512.md), so there is nothing to neutralize, and
 * recording that explicitly is what lets provenance distinguish "the provider
 * added nothing" from "nobody checked".
 */
const HIDDEN_SOURCES = [
  { kind: "provider_default_negative", field: "negative_prompt", value: "", overridable: true },
] as const;

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

/**
 * How this endpoint says one claim.
 *
 * An exhaustive switch over the concept registry, so a new concept is a COMPILE
 * ERROR here rather than a claim that quietly never reaches a prompt. That is the
 * cost the closed registry was chosen to impose: adding a world fact means
 * deciding, per endpoint, how that endpoint should say it.
 *
 * Returning null is a legitimate answer meaning "this endpoint has no wording for
 * that", and the shared compile step records it as a dropped claim — a refusal if
 * the claim was mandatory.
 */
function renderClaim(
  claim: ImagePositiveClaim,
  input: ImageDialectPositiveInput,
  surfaces: SceneStagingSurfaceLog,
): ImagePromptSegment | null {
  const say = (text: string): ImagePromptSegment => ({
    kind: claim.segmentKind,
    text: sentence(text),
    mandatory: claim.required,
    priority: claim.priority,
  });
  /** A sentence a helper may decline to write — null in, null out, never an empty segment. */
  const sayOrNull = (text: string | null): ImagePromptSegment | null => (text === null ? null : say(text));
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);

  switch (claim.concept) {
    // --- Operation ------------------------------------------------------------
    case "operation.change":
      return say(`Edit the supplied image: ${describeChange(claim.value)}.`);
    case "operation.preserve": {
      // Named facts, never "preserve everything" — the research traces Qwen's
      // squashed-figure geometry failure to exactly that blanket wording fighting
      // a requested pose change. Named by MEANING, never by fact key: see
      // `preservedMeanings`.
      const preserved = preservedMeanings(input, claim.value);
      if (preserved.length === 0) return null;
      return say(`Everything else stays as it is in the source, including ${listWords(preserved)}.`);
    }
    case "operation.geometry":
      return say(
        value === "canvas_may_expand"
          ? "You may extend the canvas and paint in the newly required space rather than compressing the subject to fit."
          : "Recompose the frame as the new content requires.",
      );
    case "operation.subject_count":
      return say(subjectCountSentence(Number(claim.value), viewerIsEmbodied(input)));
    case "operation.literal_text":
      // Quoted and letter-exact: 2512's text rendering is one of its advertised
      // strengths, and quoting is how the model card asks for exact lettering.
      return say(
        object === null
          ? `The text "${value}" is rendered exactly, sharp and fully legible.`
          : `${capitalize(object)} carries the text "${value}", rendered exactly, sharp and fully legible.`,
      );
    case "operation.reference_role":
      // 2512's single `image` input is strength-based image-to-image, not a
      // numbered composition slot, so there is nothing honest to number. Only the
      // starting-point role has a meaning here; anything else would be prompt text
      // asserting a transport this endpoint does not have.
      return value === "before" || value === "product" ? say("The supplied image is this render's starting point.") : null;

    // --- Scene ----------------------------------------------------------------
    case "scene.mood":
      return say(`The mood is ${value}.`);
    case "scene.capture_mode": {
      const mode = imageSceneCaptureMode(claim.value);
      return mode === null ? null : say(captureModeSentence(mode, subject));
    }
    case "scene.possession":
      return sayOrNull(possessionSentence(possessionOwners(input, claim.value)));
    case "scene.staging": {
      const form = imageSceneStagingForm(claim.value);
      if (form === null) return null;
      // ADOPTS the registry's wording. The evidence is one generation over — the
      // templates were tuned on the edit sibling, not here — and adopting anyway
      // is the deliberate call: this endpoint wants exactly the long concrete
      // prose those templates are written in, the measured residue is model
      // behavior that no typed semantics can regenerate, and a rival sentence
      // authored here would make the two Qwen endpoints incomparable the moment
      // the owed re-measurement runs.
      return sayOrNull(stagingSentence(surfaces.adopt(claim.id, form), subject));
    }

    // --- Viewer ---------------------------------------------------------------
    case "viewer.body_geometry":
      return sayOrNull(viewerGeometrySentence(claim.value));
    case "viewer.appearance":
      return sayOrNull(viewerAppearanceSentence(claim.value));
    case "viewer.intimate_anatomy":
      return sayOrNull(viewerIntimateSentence(claim.value));

    // --- Subject --------------------------------------------------------------
    case "subject.identity":
      return say(subject === null ? `${capitalize(value)}.` : `${capitalize(subject)}: ${value}.`);
    case "subject.face_visibility": {
      // This endpoint speaks no identity lock — its identity claim is a
      // descriptor — but the adaptation is still earned: a described face is the
      // same pull toward the lens, and the sentence is what says the turn is not
      // on the table. Reference-free unless an identity image OF THIS SUBJECT is
      // being sent: 2512's single `image` input is a strength-based starting
      // point rather than a guaranteed identity slot, so the count says nothing
      // about whose face it holds.
      const visibility = imageSceneObscuredFace(claim.value);
      if (visibility === null) return null;
      return say(faceVisibilitySentence(visibility, subject, faceVisibilityAnchor(input, claim)));
    }
    case "subject.apparent_age":
      return say(prefixed(subject, `appears ${value}`));
    case "subject.morphology":
      return say(prefixed(subject, `has ${value}`));
    case "subject.absence":
      return say(prefixed(subject, `has ${value}, shown plainly and anatomically correctly`));
    case "subject.appearance":
    case "subject.intimate_anatomy":
      return say(prefixed(subject, `has ${value}`));
    case "subject.pose":
      return say(prefixed(subject, `is ${value}`));
    case "subject.activity":
      // Same clause shape as a pose. The split is a distinction in the world
      // rather than in English — different composer fields, different provenance
      // — and inventing a lexical difference would assert something the value
      // does not carry.
      return say(prefixed(subject, `is ${value}`));
    case "subject.expression":
      return say(prefixed(subject, `wears a ${value} expression`));
    case "subject.body_language":
    case "subject.current_state":
      return say(prefixed(subject, `is ${value}`));
    case "subject.wardrobe":
      return say(prefixed(subject, `wears ${value}`));
    case "subject.exposure":
      return say(prefixed(subject, `is ${value}`));

    // --- Camera ---------------------------------------------------------------
    case "camera.framing":
      return say(framingSentence(claim.value as ImageFramingBand));
    case "camera.distance":
      return say(distanceSentence(claim.value as ImageDistanceBand));
    case "camera.angle":
      return say(angleSentence(claim.value as ImageAngleBand, subject));
    case "camera.height":
      return say(heightSentence(claim.value as ImageCameraHeightBand));
    case "camera.motion":
      // A still camera has nothing to say; saying it anyway spends budget on a
      // sentence that describes the absence of an effect.
      return value === "still" ? null : say(`Motion blur from ${value} movement.`);
    case "camera.lighting":
      return say(lightingSentence(claim.value as ImageLightingBand));

    // --- Relations ------------------------------------------------------------
    case "relation.wears":
      return relationSentence(say, subject, "wears", object);
    case "relation.holds":
      return relationSentence(say, subject, "holds", object);
    case "relation.contains":
      return relationSentence(say, subject, "contains", object);
    case "relation.attached_to":
      return relationSentence(say, subject, "is attached to", object);
    case "relation.located_at":
      return relationSentence(say, subject, "is at", object);
    case "relation.placement":
      return relationSentence(say, subject, `is ${spatialWord(value)}`, object);
    case "relation.contact":
      return relationSentence(say, subject, "is in contact with", object);
    case "relation.acts_on":
      return relationSentence(say, subject, "acts on", object);

    // --- Item -----------------------------------------------------------------
    case "item.identity":
      return say(`${capitalize(value)}.`);
    case "item.form":
      // Bare, because this is where a projection files an authored description —
      // prose written for a reader, which any "Its form:" scaffolding would
      // wrap in a label the model then has to see past.
      return say(`${capitalize(value)}.`);
    case "item.material":
      return say(`Made of ${value}.`);
    case "item.color":
      return say(`Coloured ${value}.`);
    case "item.part":
      return say(`It has ${value}.`);
    case "item.marking":
      return say(`It carries the marking "${value}", rendered exactly and legibly.`);
    case "item.condition":
      return say(`Its condition: ${value}.`);
    case "item.contents":
      return say(`It contains ${value}.`);
    case "item.configuration":
      return say(`${capitalize(value)}.`);
    case "item.presentation":
      return say(`${capitalize(value)}.`);

    // --- Location -------------------------------------------------------------
    case "location.identity":
      return say(`${capitalize(value)}.`);
    case "location.kind":
      return say(`${capitalize(value)}.`);
    case "location.geometry":
    case "location.presentation":
      return say(`${capitalize(value)}.`);
    case "location.contents":
      // Bare for the same reason as `item.form`: a location's authored
      // description is already a sentence about the space.
      return say(`${capitalize(value)}.`);
    case "location.signage":
      return say(`A sign reads "${value}", rendered exactly and legibly.`);
    case "location.lighting":
      return say(`Lit by ${value}.`);
    case "location.weather":
      return say(`The weather is ${value}.`);
    case "location.time":
      return say(`It is ${value}.`);
    case "location.condition":
      return say(`The place is ${value}.`);
    case "location.atmosphere":
      return say(`${capitalize(value)}.`);
    case "location.occupancy":
      return say(`${capitalize(value)}.`);

    // --- Style ----------------------------------------------------------------
    case "style.medium":
      return say(mediumSentence(claim.value as ImageStyleMedium));
    case "style.descriptor":
    case "style.quality":
      return say(`${capitalize(value)}.`);

    // --- Raw ------------------------------------------------------------------
    case "raw.text":
      // Verbatim, deliberately. A lab caller has opted out of the fact-completeness
      // and collision guarantees, and rewriting their words would be the worst of
      // both worlds: no guarantee, and not what they typed either.
      return say(value);
  }
}

function compilePositive(input: ImageDialectPositiveInput): ImageCompiledPositivePrompt {
  // Fresh per compile, like every other per-render record: a log shared across
  // compiles would attribute one render's wording decision to the next.
  const surfaces = createSceneStagingSurfaceLog();
  return compileDialectClaims({
    claims: input.claims,
    render: (claim) => renderClaim(claim, input, surfaces),
    surfaces,
    budget: input.budget,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

/**
 * How this endpoint spells one forbidden outcome.
 *
 * Short noun phrases joined by commas, which is the shape of the official model
 * card's own negative example. Exhaustive over the conflict vocabulary for the
 * same reason `renderClaim` is: a new key must be worded deliberately rather than
 * silently forbidden by nothing.
 */
export function qwenImage2512NegativePhrase(key: ImageConflictKey): string {
  switch (key) {
    case "text":
      return "unintended text";
    case "letters":
      return "garbled letters";
    case "caption":
      return "captions";
    case "logo":
      return "logos";
    case "signature":
      return "artist signature";
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
      return "malformed hands";
    case "duplicated_anatomy":
      return "duplicated body parts";
    case "disconnected_anatomy":
      return "disconnected limbs";
    case "multiple_people":
      return "additional people";
    case "duplicate_face":
      return "duplicated faces";
    case "identity_drift":
      return "a different face from the reference";
    case "cropped":
      return "awkward cropping";
    case "close_up":
      return "extreme close-up";
    case "blur":
      return "blurry";
    case "out_of_frame":
      return "subject cut off by the frame";
    case "confused_composition":
      return "confused composition";
    case "impossible_overlap":
      return "impossible overlapping geometry";
    case "synthetic_skin":
      return "waxy plastic skin";
    case "excessive_smoothing":
      return "excessive skin smoothing";
    case "oversaturation":
      return "oversaturated colour";
    case "low_resolution":
      return "low resolution";
    case "low_quality":
      return "low quality";
    case "photographic":
      return "photographic realism";
    case "illustration":
      return "illustration";
    case "anime":
      return "anime style";
    case "painting":
      return "painterly brushwork";
    case "render_3d":
      return "3D render look";
    case "background_clutter":
      return "cluttered background";
    case "extra_objects":
      return "unrelated objects";
  }
}

/** The reason every exclusion drops on this endpoint. */
const IGNORES_NEGATIVE_FIELD = "endpoint_ignores_negative_field";

/**
 * Compile the negative channel — which on this endpoint means dropping all of it.
 *
 * The Replicate schema exposes `negative_prompt` and Qwen Image does not act on
 * it. Vesper's own canary is the direct measurement: a render asked for a red
 * apple with `red apple, apple` in the negative field kept the apple in 16 of 16
 * paired renders, across the accelerated and non-accelerated sampling paths
 * (`scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts`, trials A and A2,
 * 2026-08-19). Upstream reporting gives the mechanism: the model was not trained
 * on negative conditioning, the parameter exists for pipeline compatibility, and
 * the official examples pass a single space.
 *
 * So this is the "endpoint/version behavior outranks model-family assumptions"
 * rule doing its job. A field the wrapper offers does not exist
 * for Vesper until the endpoint proves it works, and this one proved the
 * opposite. Sending exclusions anyway would spend prompt budget on text that
 * changes nothing while letting provenance claim the render excluded something.
 *
 * Every constraint therefore drops with a reason, and the drop is RECORDED —
 * an operator can still see exactly what this render would have excluded on an
 * endpoint that could carry it. The constraints themselves are not wrong; this
 * endpoint simply has no channel for them.
 *
 * What is deliberately NOT done here: inventing an inline or positive-replacement
 * transport. Whether affirmative wording inside the positive prompt achieves what
 * the field could not is an evidence question only a fixed trial can
 * answer, and until that trial says so this dialect states the honest `unsupported`
 * rather than a capability it has not earned.
 */
function compileNegative(input: ImageDialectNegativeInput): ImageCompiledNegativePrompt {
  return {
    text: null,
    replacementClaims: [],
    inlineText: [],
    outcomes: input.constraints.map((constraint) => ({
      constraintId: constraint.id,
      transport: { kind: "dropped", reason: IGNORES_NEGATIVE_FIELD },
    })),
  };
}

// Wording helpers live in `./dialect-qwen-prose`, shared with the 2511
// delta-edit dialect. The concept switch above stays THIS endpoint's own.

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const qwenImage2512Dialect: ImagePromptDialectDefinition = {
  id: DIALECT_ID,
  positiveSyntax: "natural_language",
  // The schema exposes `negative_prompt`; the model does not act on it, measured
  // 16/16 against a contradictory canary. See `compileNegative`.
  negativeSyntax: "none",
  negativeTransport: "unsupported",
  // The single `image` input is strength-based image-to-image rather than a
  // numbered composition slot, so this endpoint has no reference syntax to speak.
  referenceSyntax: "none",
  supportsWeights: false,
  supportsLiteralQuotes: true,
  hiddenPromptSources: HIDDEN_SOURCES,
  compilePositive,
  compileNegative,
};

registerImagePromptDialect(qwenImage2512Dialect);
