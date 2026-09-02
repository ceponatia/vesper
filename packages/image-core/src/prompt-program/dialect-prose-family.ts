import type { ImageReferenceRole } from "../capabilities/image-model-capabilities";
import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type {
  ImageAngleBand,
  ImageCameraHeightBand,
  ImageDistanceBand,
  ImageFramingBand,
  ImageLightingBand,
} from "./camera-bands";
import type { ImageStyleMedium } from "./conflict-keys";
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
  mediumSentence,
  possessionOwners,
  possessionSentence,
  preservedMeanings,
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
  type HiddenPromptSource,
  type ImageCompiledNegativePrompt,
  type ImageCompiledPositivePrompt,
  type ImageDialectNegativeInput,
  type ImageDialectPositiveInput,
  type ImagePromptDialectDefinition,
  type ImagePromptDialectId,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";
import { imageSceneCaptureMode, imageSceneObscuredFace, imageSceneStagingForm } from "./scene-facts";
import { createSceneStagingSurfaceLog, type SceneStagingSurfaceLog } from "./scene-staging-surfaces";

/**
 * THE PROSE FAMILY — one natural-language implementation, registered under the
 * six endpoint ids whose reviewed behavior is "long concrete prose, no usable
 * negative channel": Seedream 4.5, Seedream 5 Lite, Wan 2.7 Image Pro, Stable
 * Diffusion 3.5 Large, NSFW FLUX Dev and P-Image.
 *
 * Sharing one implementation is the registry's own sanctioned shape ("two
 * entries may delegate to one implementation without becoming permanently
 * coupled"): each endpoint keeps its OWN id, its own pack pair and its own
 * binding, so a wording finding for Seedream 4.5 is promoted by editing that
 * endpoint's pack — and an endpoint that eventually earns wording of its own
 * forks out of this module without moving the other five an inch.
 *
 * What is deliberately NOT shared with the Qwen dialects is the concept switch.
 * The clause grammar in `./dialect-qwen-prose` is family-neutral sentence
 * plumbing — "how does a claim value become English" — and every prose endpoint
 * uses it. The switch below is this family's own wording decision and lives
 * here.
 *
 * ## No endpoint here speaks numbered slots
 *
 * `numbered_images` is a Qwen-family convention (owner ruling 2026-08-24: a
 * family behavior, never a single endpoint's). Seedream and Wan take an ordered
 * reference ARRAY, which is a transport fact, not a documented prompt
 * convention — none of their model cards asks callers to write "Image 2". So
 * this family names references by ROLE and by the person or place they show,
 * which is what the legacy multi-reference builder already sends these
 * endpoints, and never asserts a slot number.
 *
 * That is also why the renumbering hazard #256 §4 names cannot arise here: a
 * prompt that never says "Image 2" cannot say it about the wrong image.
 */

/**
 * The provider-neutral identity lock this family compiles a `subject.identity`
 * anchor into — the sentence every non-Qwen character endpoint has always
 * received, kept byte for byte so cutting a lane over to the program changed
 * its PROVENANCE rather than its instruction. This dialect is now the
 * sentence's only source: the lane-side prose builders that once emitted it
 * are gone, and the Qwen family speaks its own numbered lock from the same
 * claim (`dialect-qwen-2511.ts`). `prompt-program.test.ts` pins these bytes.
 */
export const PROSE_FAMILY_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

/**
 * The cast-integrity clause, emitted only when two or more identity references
 * ride the same request.
 *
 * A byte-copy of the clause the application's retired scene prose builder
 * emitted on its multi-reference path (git history), for the reason above. The
 * lock states what must be preserved about each person; this states what must
 * not happen to the SET, which is a different failure and is not prevented by
 * correct per-person wording.
 */
export const PROSE_FAMILY_CAST_INTEGRITY =
  "Render each person exactly once, matched to their own reference image; never merge, swap, or duplicate them.";

/**
 * The lock's priority: below the operation band (100+), above every projection
 * claim. It matters only under a hard provider ceiling, where mandatory
 * segments compress weakest-first — a squeeze should eat descriptive prose long
 * before it shortens the sentence the identity of the render depends on.
 */
const IDENTITY_LOCK_PRIORITY = 99;

/**
 * The lock adaptation's priority: strictly under the lock's, which is what makes
 * a turned-away shot's "do not rotate" sentence FOLLOW the lock it corrects
 * instead of preceding it. Ordering, not adjacency — further subjects' identity
 * claims share the lock's priority and may land between the two — and ordering
 * plus the identity band plus the mandatory kind is the whole guarantee the
 * adaptation needs.
 */
const FACE_VISIBILITY_PRIORITY = 98.9;

/**
 * Within-band emission offsets for the operation claims, which all arrive at
 * priority 100. Reference introductions come first — a later sentence that says
 * "the woman in the photograph" is meaningless until the photographs have been
 * introduced — then the requested change, the preserve set and the geometry
 * permission, which is the same delta-first order the 2511 dialect states.
 */
const PROSE_PRIORITY = {
  reference: 100.5,
  change: 100.4,
  preserve: 100.3,
  geometry: 100.2,
  literalText: 100.1,
} as const;

/** Per-compile render state. Created fresh in every compile, never shared. */
interface RenderState {
  lockEmitted: boolean;
  readonly takenSlots: Set<number>;
}

/**
 * How many of the SENT references depict a person. Decides the cast-integrity
 * clause, and it is counted over `input.references` — the post-planning send
 * order — so the clause describes the payload rather than a lane's wish list.
 */
function identityReferenceCount(input: ImageDialectPositiveInput): number {
  return input.references.filter((slot) => slot.role === "identity").length;
}

/**
 * The send slot a reference claim names, or null when planning trimmed it.
 *
 * Identical matching rule to the 2511 dialect's: strict on `subjectRef`, and
 * matched slots are consumed so two references sharing a role and subject each
 * get their own sentence. The POSITION is not used in the wording — this family
 * speaks role labels — but the match still has to happen, because a claim about
 * a reference the payload does not carry must produce no sentence at all.
 */
function claimSlot(
  input: ImageDialectPositiveInput,
  state: RenderState,
  role: ImageReferenceRole,
  subjectRef: string | undefined,
): { readonly role: ImageReferenceRole } | null {
  for (const slot of input.references) {
    if (state.takenSlots.has(slot.position)) continue;
    if (slot.role !== role || slot.subjectRef !== subjectRef) continue;
    state.takenSlots.add(slot.position);
    return slot;
  }
  return null;
}

/**
 * One reference introduced by what it IS, never by a slot number.
 *
 * Null for the structural control roles: none of these endpoints publishes a
 * mask, pose, depth or edge input, so such an image could only ride the content
 * array — where the model would DEPICT it rather than obey it, and a sentence
 * claiming otherwise would assert a transport the endpoint does not have. The
 * null drops the claim, which the operation's mandatory floor turns into a
 * refusal before provider spend.
 */
function referenceIntroduction(role: ImageReferenceRole, subjectLabel: string | null): string | null {
  switch (role) {
    case "identity":
      return subjectLabel === null
        ? "A reference photograph of the person to depict is provided."
        : `A reference photograph of ${subjectLabel} is provided.`;
    case "before":
      return "A reference image is provided as this render's starting point.";
    case "location":
      return subjectLabel === null
        ? "A reference photograph of the place is provided."
        : `A reference photograph of the place, ${subjectLabel}, is provided.`;
    case "style":
      // The style role promises "no subject or object", and saying so is what
      // keeps the model from importing the style image's content.
      return "A style reference is provided; take only its rendering style, none of its content.";
    case "object":
      return subjectLabel === null
        ? "A reference photograph of an object in the scene is provided."
        : `A reference photograph of ${subjectLabel} is provided.`;
    case "outfit":
      return subjectLabel === null
        ? "A reference photograph of the outfit to wear is provided."
        : `A reference photograph of the outfit to wear, ${subjectLabel}, is provided.`;
    case "product":
      return subjectLabel === null
        ? "A reference photograph of the product is provided."
        : `A reference photograph of the product, ${subjectLabel}, is provided.`;
    case "after_example":
      return "A reference image shows an example of the desired result; it is not content to copy.";
    case "reference":
      // The neutral role makes no semantic claim, so neither does its sentence.
      return "A reference image is provided.";
    case "mask":
    case "pose":
    case "depth":
    case "edge":
    case "control":
      return null;
  }
}

/**
 * How this family says one claim.
 *
 * An exhaustive switch over the concept registry, so a new concept is a COMPILE
 * ERROR here rather than a claim that quietly never reaches six endpoints'
 * prompts. Returning null means "this family has no wording for that", and the
 * shared compile step records it as a dropped claim — a refusal when the claim
 * was mandatory.
 */
function renderClaim(
  claim: ImagePositiveClaim,
  input: ImageDialectPositiveInput,
  state: RenderState,
  spec: ProseDialectSpec,
  surfaces: SceneStagingSurfaceLog,
): ImagePromptSegment | null {
  const say = (text: string, priority: number = claim.priority): ImagePromptSegment => ({
    kind: claim.segmentKind,
    text: sentence(text),
    mandatory: claim.required,
    priority,
  });
  /** A sentence a helper may decline to write — null in, null out, never an empty segment. */
  const sayOrNull = (text: string | null): ImagePromptSegment | null => (text === null ? null : say(text));
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);

  switch (claim.concept) {
    // --- Operation ------------------------------------------------------------
    case "operation.change":
      return say(`Edit the supplied image: ${describeChange(claim.value)}.`, PROSE_PRIORITY.change);
    case "operation.preserve": {
      // Named facts, never "preserve everything" — the blanket wording is what
      // the research blames for squashed-figure geometry failures, and it is
      // just as wrong on a Seedream edit as on a Qwen one. Named by MEANING,
      // never by fact key (`preservedMeanings`).
      const preserved = preservedMeanings(input, claim.value);
      if (preserved.length === 0) return null;
      return say(`Everything else stays as it is in the source, including ${listWords(preserved)}.`, PROSE_PRIORITY.preserve);
    }
    case "operation.geometry":
      return say(
        value === "canvas_may_expand"
          ? "You may extend the canvas and paint in the newly required space rather than compressing the subject to fit."
          : "Recompose the frame as the new content requires.",
        PROSE_PRIORITY.geometry,
      );
    case "operation.subject_count":
      return say(subjectCountSentence(Number(claim.value), viewerIsEmbodied(input)));
    case "operation.literal_text":
      return say(
        object === null
          ? `The text "${value}" is rendered exactly, sharp and fully legible.`
          : `${capitalize(object)} carries the text "${value}", rendered exactly, sharp and fully legible.`,
        PROSE_PRIORITY.literalText,
      );
    case "operation.reference_role": {
      // An endpoint with no reference transport has nothing to introduce: SD 3.5
      // Large's single `image` is strength-based img2img rather than a
      // composition slot, and FLUX Dev and P-Image publish no image input at
      // all. Saying "a reference photograph is provided" on those would be the
      // prompt asserting a transport the payload does not have.
      if (spec.referenceSyntax === "none") return null;
      const slot = claimSlot(input, state, claim.value as ImageReferenceRole, claim.subjectRef);
      if (slot === null) return null;
      const introduction = referenceIntroduction(slot.role, subject);
      return introduction === null ? null : say(introduction, PROSE_PRIORITY.reference);
    }

    // --- Scene ----------------------------------------------------------------
    case "scene.mood":
      // Bare of scaffolding beyond the copula: a mood arrives as the composer's
      // own phrase for how the moment feels, and it describes the SHOT rather
      // than the room — the same bedroom is cheerful in one render and
      // threatening in the next.
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
      // ADOPTS the registry's wording. The templates are measured artifacts
      // rather than opinions — one rewrite that replaced a contact verb took the
      // viewer's anatomy from present in three renders of three to absent in
      // three of three, and naming a forearm and the frame's lower corners held
      // the viewer's hands where a plainer phrasing lost them — and that residue
      // is model behavior no typed semantics could regenerate.
      //
      // The measurements were taken through the retired prose BUILDER, against
      // the Qwen edit endpoint the intimate route runs on, so their evidence
      // reaches this family through the shared natural-language register rather
      // than from these endpoints directly. Adopting is still the call: this is
      // the register the templates are written in, and a rival sentence authored
      // here would throw the evidence away and buy nothing measured back.
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
    case "subject.identity": {
      // With references in the payload the identity travels in the IMAGE, and
      // this claim compiles to the lock — the exact provider-neutral bytes these
      // endpoints already receive. Emitted once however many subjects ride the
      // render; a second identity claim falls through to naming its subject, so
      // the per-person descriptors the lock's "each person" covers still land.
      if (spec.referenceSyntax !== "none" && input.references.length > 0) {
        if (!state.lockEmitted) {
          state.lockEmitted = true;
          const cast = identityReferenceCount(input) >= 2 ? ` ${PROSE_FAMILY_CAST_INTEGRITY}` : "";
          // Bypasses `sentence()` so nothing renormalizes a character of the
          // frozen wording.
          return {
            kind: claim.segmentKind,
            text: `${PROSE_FAMILY_IDENTITY_LOCK}${cast}`,
            mandatory: true,
            priority: IDENTITY_LOCK_PRIORITY,
          };
        }
        return say(subject === null ? `${capitalize(value)}.` : `${capitalize(subject)}: ${value}.`, IDENTITY_LOCK_PRIORITY);
      }
      // Text-to-image: there is no reference to lock to, so the projection's own
      // identity descriptors are the only thing that can carry a likeness.
      return say(subject === null ? `${capitalize(value)}.` : `${capitalize(subject)}: ${value}.`);
    }
    case "subject.face_visibility": {
      // The lock's adaptation, under the lock's priority so it follows the
      // sentence it corrects. Emitted on the text-to-image path too: there the
      // descriptors carry the likeness and the same pull toward the lens applies,
      // so what changes is only what the preservation is anchored to — and that
      // anchor is decided per SUBJECT, because this family's role labels can
      // introduce one person's reference on a render whose focal has none.
      const visibility = imageSceneObscuredFace(claim.value);
      if (visibility === null) return null;
      return say(
        faceVisibilitySentence(visibility, subject, faceVisibilityAnchor(input, claim)),
        FACE_VISIBILITY_PRIORITY,
      );
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
      // The same clause shape as a pose, and that is the honest answer rather
      // than a missing distinction: "is sitting cross-legged" and "is pouring
      // coffee" are both what an English sentence does with the value it was
      // given. What separates the two is upstream — different composer fields,
      // different provenance, different scrubbing — and inventing a lexical
      // difference here would be this dialect asserting something the value
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
      // Bare: this is where a projection files an authored description — prose
      // written for a reader, which any "Its form:" scaffolding would wrap in a
      // label the model then has to see past.
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
    case "location.kind":
    case "location.geometry":
    case "location.presentation":
      return say(`${capitalize(value)}.`);
    case "location.contents":
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
      // Verbatim, deliberately. A lab caller has opted out of the
      // fact-completeness and collision guarantees, and rewriting their words
      // would be the worst of both worlds.
      return say(value);
  }
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** What one prose endpoint states about itself. Everything else is shared. */
export interface ProseDialectSpec {
  readonly id: ImagePromptDialectId;
  /**
   * `role_labels` for the endpoints that take an ordered reference array,
   * `none` for the ones whose only image input is strength-based img2img or
   * which publish no image input at all.
   */
  readonly referenceSyntax: "none" | "role_labels";
  /** Why every exclusion drops here — an endpoint fact, recorded per endpoint. */
  readonly negativeDropReason: string;
  /** What the provider contributes on its own. Empty means probed and nothing. */
  readonly hiddenPromptSources: readonly HiddenPromptSource[];
  readonly supportsLiteralQuotes: boolean;
}

function compilePositiveFor(spec: ProseDialectSpec) {
  return (input: ImageDialectPositiveInput): ImageCompiledPositivePrompt => {
    // Fresh state per compile: emit-the-lock-once and slot consumption are
    // per-render facts, and state leaking across compiles would make the second
    // compile of one digest differ from the first, which determinism forbids.
    const state: RenderState = { lockEmitted: false, takenSlots: new Set<number>() };
    const surfaces = createSceneStagingSurfaceLog();
    return compileDialectClaims({
      claims: input.claims,
      render: (claim) => renderClaim(claim, input, state, spec, surfaces),
      surfaces,
      budget: input.budget,
      ...(input.sink === undefined ? {} : { sink: input.sink }),
    });
  };
}

/**
 * Compile the negative channel — which across this whole family means dropping
 * all of it, with the endpoint's own recorded reason.
 *
 * Three different facts land in the same place, which is why the reason is per
 * endpoint rather than a family constant:
 *
 * - **No field exists.** FLUX Dev, P-Image, Seedream 4.5, Seedream 5 Lite and
 *   Wan 2.7 publish no negative input on their probed schemas.
 * - **A field exists and is inert.** SD 3.5 Large publishes `negative_prompt`
 *   and Vesper's own canary measured it suppressing nothing at either guidance
 *   level, which is why the reviewed ruling states that adapters treat the field
 *   as carrying no useful negative transport and leave it for manual, opt-in
 *   curation on `stylized-portrait-high-guidance`.
 *
 * Every constraint drops with its reason RECORDED, so an operator can still see
 * exactly what a render would have excluded on an endpoint that could carry it.
 *
 * What is deliberately NOT done — including on `flux_dev_positive_replacement`,
 * whose id names the transport its cutover was expected to earn — is inventing
 * an inline or positive-replacement channel. Whether affirmative wording
 * achieves what a field would is an evidence question only a fixed trial can
 * answer (owner ruling 2026-08-29, applied by both Qwen dialects), and until one
 * runs, `unsupported` is the honest statement. Earning it is a pack-and-dialect
 * edit on that one endpoint, not a change to the other five.
 */
function compileNegativeFor(spec: ProseDialectSpec) {
  return (input: ImageDialectNegativeInput): ImageCompiledNegativePrompt => ({
    text: null,
    replacementClaims: [],
    inlineText: [],
    outcomes: input.constraints.map((constraint) => ({
      constraintId: constraint.id,
      transport: { kind: "dropped", reason: spec.negativeDropReason },
    })),
  });
}

/** Build and register one prose endpoint's dialect. */
function proseDialect(spec: ProseDialectSpec): ImagePromptDialectDefinition {
  const definition: ImagePromptDialectDefinition = {
    id: spec.id,
    positiveSyntax: "natural_language",
    negativeSyntax: "none",
    negativeTransport: "unsupported",
    referenceSyntax: spec.referenceSyntax,
    supportsWeights: false,
    supportsLiteralQuotes: spec.supportsLiteralQuotes,
    hiddenPromptSources: spec.hiddenPromptSources,
    compilePositive: compilePositiveFor(spec),
    compileNegative: compileNegativeFor(spec),
  };
  registerImagePromptDialect(definition);
  return definition;
}

// ---------------------------------------------------------------------------
// Registration — one entry per endpoint
// ---------------------------------------------------------------------------

const NO_NEGATIVE_FIELD = "endpoint_has_no_negative_field";
/** The field exists and was measured to suppress nothing — see `compileNegativeFor`. */
const NEGATIVE_FIELD_MEASURED_INERT = "endpoint_negative_field_measured_inert";

/** `bytedance/seedream-4.5` — `image_input`, an ordered array of up to 14. */
export const seedream45Dialect = proseDialect({
  id: "seedream_45_prose",
  referenceSyntax: "role_labels",
  negativeDropReason: NO_NEGATIVE_FIELD,
  hiddenPromptSources: [],
  supportsLiteralQuotes: true,
});

/** `bytedance/seedream-5-lite` — the same `image_input` array, up to 14. */
export const seedream5LiteDialect = proseDialect({
  id: "seedream_5_lite_prose",
  referenceSyntax: "role_labels",
  negativeDropReason: NO_NEGATIVE_FIELD,
  hiddenPromptSources: [],
  supportsLiteralQuotes: true,
});

/** `wan-video/wan-2.7-image-pro` — `images`, an ordered array of up to 9. */
export const wan27Dialect = proseDialect({
  id: "wan_27_prose",
  referenceSyntax: "role_labels",
  negativeDropReason: NO_NEGATIVE_FIELD,
  hiddenPromptSources: [],
  supportsLiteralQuotes: true,
});

/**
 * `stability-ai/stable-diffusion-3.5-large` — a single `image` input that is
 * conventional strength-based img2img, so it has no composition slot to
 * introduce, and a `negative_prompt` the reviewed ruling records as inert.
 *
 * The provider default for that field is the empty string, which is a probed
 * fact rather than a placeholder: recording it lets provenance distinguish "the
 * provider added nothing" from "nobody looked".
 */
export const sd35LargeDialect = proseDialect({
  id: "sd35_large_prose",
  referenceSyntax: "none",
  negativeDropReason: NEGATIVE_FIELD_MEASURED_INERT,
  hiddenPromptSources: [
    { kind: "provider_default_negative", field: "negative_prompt", value: "", overridable: true },
  ],
  supportsLiteralQuotes: true,
});

/**
 * `aisha-ai-official/nsfw-flux-dev` — a bare wrapper: no negative prompt, no
 * sampler choice, no LoRA input, no safety toggle, and no URI-typed input of any
 * kind, so its reference capacity is zero.
 */
export const nsfwFluxDevDialect = proseDialect({
  id: "flux_dev_positive_replacement",
  referenceSyntax: "none",
  negativeDropReason: NO_NEGATIVE_FIELD,
  hiddenPromptSources: [],
  supportsLiteralQuotes: true,
});

/** `prunaai/p-image` — text-to-image only; no negative input, no image input. */
export const pImageDialect = proseDialect({
  id: "p_image_prose",
  referenceSyntax: "none",
  negativeDropReason: NO_NEGATIVE_FIELD,
  hiddenPromptSources: [],
  supportsLiteralQuotes: true,
});
