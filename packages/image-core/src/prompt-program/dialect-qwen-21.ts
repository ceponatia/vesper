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
  currentStatePredicate,
  describe,
  describeChange,
  distanceSentence,
  faceVisibilityAnchor,
  faceVisibilitySentence,
  hairConcealedForSubject,
  hairConcealmentSentence,
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
  reportUnwordableClaimValue,
  relationSentence,
  sentence,
  spatialWord,
  stagingSentence,
  subjectCountSentence,
  unwordableImageClaimValue,
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
  type ImageDialectReference,
  type ImagePromptDialectDefinition,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";
import { imageSceneCaptureMode, imageSceneObscuredFace, imageSceneStagingForm } from "./scene-facts";
import { createSceneStagingSurfaceLog, type SceneStagingSurfaceLog } from "./scene-staging-surfaces";

/**
 * `civitai/qwen-image-2.1` — a 7B single-stream DiT with a Qwen3-VL text
 * encoder that generates from a bare prompt or edits from one to ten
 * references in one checkpoint (`docs/image-models/models/civitai-qwen-image-2-1.md`,
 * probed 2026-09-30; owner bench verdict 2026-10-01).
 *
 * **Based on `dialect-qwen-2512.ts`, informed by `dialect-qwen-2511.ts`'s
 * evidence.** Two existing compilers were candidates and neither fits whole:
 *
 * - `dialect-qwen-2511.ts` (the delta editor) is the closer match for WHAT
 *   this endpoint is — an edit model taking "natural-language instruction
 *   edits" (model page), which is exactly 2511's own framing — and for HOW
 *   Qwen wants its references said: numbered images are a Qwen-FAMILY
 *   convention (owner ruling 2026-08-24, `docs/images/prompt-programs.md`
 *   §Families), not a single endpoint's choice, and 2.1 is a Qwen checkpoint.
 *   This dialect therefore declares `numbered_images` and writes an
 *   identity-preserve lock modelled on 2511's (face, skin tone and apparent
 *   age from the photograph; hair, build, wardrobe and pose from the text).
 * - But 2511 REFUSES at zero references (`bindingSentence` returns null,
 *   because Qwen Edit 2511 cannot generate from text alone), and this
 *   endpoint's own `scene-standard` binding needs BOTH strategies the scene
 *   chain's last rung states — `instruction_edit` over 1-10 references AND
 *   `text_to_image_description` over zero (acceptance #2) — because 2.1, like
 *   2512, is one checkpoint that both generates and edits. 2511's elaborate
 *   multi-person grouping, pronoun voicing and current-look-lock scoping
 *   (`IdentityGroup`, `SubjectVoice`, `currentLookLockScope`) are each a
 *   MEASURED refinement from 2511's own trials; none of that evidence exists
 *   for 2.1, and both of this endpoint's bound lanes (`variant-standard`,
 *   `scene-standard`) are single-subject, so reproducing that apparatus here
 *   would assert refinements this endpoint has never earned.
 *
 * So the base is 2512's architecture — one claim renders one segment via a
 * plain exhaustive switch, no per-compile voice/grouping state beyond the
 * reference-slot bookkeeping numbering needs — reusing every wording helper
 * `dialect-qwen-2512.ts` and `dialect-qwen-2511.ts` already share
 * (`./dialect-qwen-prose`), with three endpoint-specific additions:
 *
 * 1. `operation.reference_role` numbers the send slots (Qwen family
 *    convention) instead of 2512's "no reference syntax" stub.
 * 2. `subject.identity` compiles to the identity-preserve lock when the
 *    payload carries a reference of that subject, and to 2512's plain
 *    descriptive sentence when it does not (the zero-reference rung).
 * 3. `subject.exposure` states nudity explicitly when the render's route
 *    permits intimate content (`intimatePermitted`) AND the subject's own
 *    computed coverage is fully bare (see {@link isFullyBareSubject}) —
 *    acceptance #4, the owner's nudity-reinforcement ruling (2026-10-01):
 *    2.1 carries no LoRA to assert nudity, so the prompt has to say it. The
 *    permission is the RENDER's own intimate allowance, behind its age gate
 *    (owner ruling 2026-10-01) — in a chat scene that is the rung's
 *    `allowIntimate` (`scene.ts` `allowIntimateFor`), true on an edit rung for
 *    an adult cast WHATEVER the staging, so an ordinary chat scene with a bare
 *    adult subject gets the clause exactly like a staged one does. Bare
 *    coverage alone never earns it: a minor's wardrobe, a `clothed` reference
 *    view, or an ordinary (non-`nsfw test`) variant reads the same bare
 *    coverage without the permission and states only the exposure sentences.
 *
 * **No negative channel at all** (acceptance #3): the probed schema exposes
 * `negativePrompt`, but every bound profile runs at the blank `cfgScale` (1),
 * and the model page records that a negative prompt is REFUSED outright at
 * `cfgScale` 1 or below (the pipeline only applies it under true CFG). Sending
 * one would not merely waste budget the way 2512's silently-ignored field
 * does — it would fail the render. So this dialect declares `none`/
 * `unsupported` and `compileNegative` always drops every constraint with a
 * recorded reason, exactly like 2511 and 2512 already do for their own
 * reasons; see {@link compileNegative}.
 */

const DIALECT_ID = "qwen_21_instruction_edit" as const;

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

/** Per-compile render state: only the reference-slot bookkeeping numbering needs. */
interface RenderState {
  readonly takenSlots: Set<number>;
}

/**
 * The send slot a reference claim names, or null when planning trimmed it.
 *
 * Matched against `input.references` — the final, post-planning send order —
 * exactly as `dialect-qwen-2511.ts`'s own `claimSlot` matches: strict on
 * `subjectRef`, and matched slots are consumed so two references sharing a
 * role and subject (an identity anchor and a reference view) each resolve
 * their own position rather than both claiming the first.
 */
function claimSlot(
  input: ImageDialectPositiveInput,
  state: RenderState,
  role: ImageReferenceRole,
  subjectRef: string | undefined,
): ImageDialectReference | null {
  for (const slot of input.references) {
    if (state.takenSlots.has(slot.position)) continue;
    if (slot.role !== role || slot.subjectRef !== subjectRef) continue;
    state.takenSlots.add(slot.position);
    return slot;
  }
  return null;
}

/**
 * One numbered assignment, in the Qwen family's "identify each image and its
 * purpose" shape (owner ruling 2026-08-24). Adapted from
 * `dialect-qwen-2511.ts`'s `referenceAssignment`: identity is INCLUDED here
 * (unlike 2511, which absorbs it into its multi-person binding sentence) —
 * this dialect states the identity reference's own sentence independently of
 * the identity-preserve lock {@link identityLockSentence} renders for the
 * `subject.identity` claim, since neither claim may render nothing (a
 * required claim with no wording refuses the compile) and this endpoint earns
 * no trial evidence yet that fusing the two reads better.
 *
 * Null for the structural control roles: the probed schema carries no mask,
 * pose, depth or edge input, so such an image could only ride the content
 * list — where the model would DEPICT it rather than obey it. The null drops
 * the claim, and the operation's mandatory floor turns that into a refusal
 * before spend.
 */
function referenceIntroduction(
  role: ImageReferenceRole,
  position: number,
  subjectLabel: string | null,
  description: string | undefined,
): string | null {
  const qualified = (subject: string): string => (description === undefined ? subject : `${subject}, ${description}`);
  switch (role) {
    case "identity":
      return `Image ${position} shows ${qualified(subjectLabel ?? "the subject")}.`;
    case "before":
      return `Image ${position} is the image to edit.`;
    case "location":
      return subjectLabel === null
        ? `Image ${position} shows the place.`
        : `Image ${position} shows the place, ${subjectLabel}.`;
    case "style":
      return `Image ${position} is the style reference; take only its rendering style.`;
    case "object":
      return `Image ${position} shows ${subjectLabel ?? "an object in the scene"}.`;
    case "outfit":
      return subjectLabel === null
        ? `Image ${position} shows the outfit to wear.`
        : `Image ${position} shows the outfit to wear: ${subjectLabel}.`;
    case "product":
      return subjectLabel === null
        ? `Image ${position} shows the product.`
        : `Image ${position} shows the product, ${subjectLabel}.`;
    case "after_example":
      return `Image ${position} is an example of the desired result, not content to copy.`;
    case "reference":
      return `Image ${position} is a reference image.`;
    case "mask":
    case "pose":
    case "depth":
    case "edge":
    case "control":
      return null;
  }
}

/** Every identity slot this subject's payload carries, in send order. */
function identitySlotsFor(input: ImageDialectPositiveInput, ref: string | undefined): readonly ImageDialectReference[] {
  if (ref === undefined) return [];
  return input.references
    .filter((slot) => slot.role === "identity" && slot.subjectRef === ref)
    .slice()
    .sort((left, right) => left.position - right.position);
}

/**
 * The identity-preserve lock for a subject the payload carries a photograph
 * of: face, skin tone and apparent age exactly as the reference(s) show; hair,
 * build, wardrobe and pose stay the TEXT's. Modelled on
 * `dialect-qwen-2511.ts`'s own single/grouped identity locks (see the module
 * doc) — the closest reviewed evidence for what a Qwen reference is
 * authoritative for — without that dialect's per-subject current-look-scope
 * refinement, which is a 2511-specific trial finding this endpoint has not
 * earned.
 *
 * Several images of ONE subject (an identity anchor beside a reference view)
 * ask for consistency ACROSS them rather than exactness against any single
 * one, exactly as 2511's grouped lock does — two photographs of one person are
 * two claims about when she was photographed, and demanding exactness against
 * both at once is demanding a contradiction.
 */
function identityLockSentence(subject: string | null, slots: readonly ImageDialectReference[]): string {
  const positions = slots.map((slot) => String(slot.position));
  const images = positions.length === 1 ? `Image ${positions[0]}` : `Images ${listWords(positions)}`;
  const named = subject ?? "the subject";
  const exactly = positions.length === 1 ? "exactly as shown" : "consistent with these references";
  return `Use ${images} for ${named}'s face, skin tone and apparent age, ${exactly}; ${named}'s hair, build, wardrobe and pose follow this prompt's own description.`;
}

/**
 * Whether EVERY region `wardrobeFor` (`apps/web` `contracts/images/reference-views.ts`
 * — the function `selectReferenceView` uses to decide the `bare` reference-view
 * wardrobe) requires reads bare for this subject, from the data every dialect
 * already receives.
 *
 * Reimplemented from the claims rather than imported: `wardrobeFor` lives in
 * `apps/web`, which `@vesper/image-core` may not depend on. The THRESHOLD is
 * the same one, restated over the one structural handle a claim may be read by
 * beyond its diagnostic-only `source` — `claim.id`, which `positive-claims.ts`'s
 * `factClaim` sets to the fact's own key. `apps/web`'s `character-adapter.ts`
 * `exposureFacts` writes that key as `<ref>.exposure.<region>` and tags the
 * claim `coverage:<covered|sheer|bare>`, so the region and the coverage state
 * both survive to this dialect without reading anything the package's own
 * "source is diagnostic only" rule forbids.
 */
function bareExposureRegions(claims: readonly ImagePositiveClaim[], ref: string): ReadonlySet<string> {
  const regions = new Set<string>();
  for (const claim of claims) {
    if (claim.concept !== "subject.exposure" || claim.subjectRef !== ref) continue;
    if (!claim.semanticTags.includes("coverage:bare")) continue;
    const region = claim.id.split(".").pop();
    if (region !== undefined && region.length > 0) regions.add(region);
  }
  return regions;
}

/** See {@link bareExposureRegions} — `wardrobeFor`'s own rule: torso AND pelvis both bare. */
function isFullyBareSubject(claims: readonly ImagePositiveClaim[], ref: string): boolean {
  const bare = bareExposureRegions(claims, ref);
  return bare.has("torso") && bare.has("pelvis");
}

/**
 * Whether `claim` is the LAST `subject.exposure` claim this program states for
 * its subject — the one site the nudity-reinforcement clause attaches to, so a
 * fully bare subject with both a torso and a pelvis claim gets the
 * reinforcement exactly once rather than once per region.
 */
function isLastExposureClaimForSubject(claims: readonly ImagePositiveClaim[], claim: ImagePositiveClaim): boolean {
  let last: ImagePositiveClaim | undefined;
  for (const candidate of claims) {
    if (candidate.concept === "subject.exposure" && candidate.subjectRef === claim.subjectRef) last = candidate;
  }
  return last?.id === claim.id;
}

/**
 * Whether this subject's payload states a worn garment at all — any
 * `subject.wardrobe` claim, whatever it names (stockings, heels, a single
 * accessory). Read beside {@link everyExposureRegionBare} to decide whether
 * "no clothes" is true of this render rather than merely "fully bare where
 * exposure was stated": a subject can read bare at the torso and pelvis and
 * still wear stockings the wardrobe claim names, and a clause saying she has
 * no clothes on at all would contradict the stockings sentence sitting right
 * beside it.
 */
function hasWardrobeClaim(claims: readonly ImagePositiveClaim[], ref: string): boolean {
  return claims.some((claim) => claim.concept === "subject.wardrobe" && claim.subjectRef === ref);
}

/**
 * Whether EVERY `subject.exposure` claim this subject's payload states reads
 * `coverage:bare` — not only the torso and pelvis {@link isFullyBareSubject}
 * requires, but every region this shot's framing stated at all (legs, feet).
 * A region reading `covered` or `sheer` is itself worn coverage, the same
 * contradiction a wardrobe claim is.
 */
function everyExposureRegionBare(claims: readonly ImagePositiveClaim[], ref: string): boolean {
  let stated = false;
  for (const claim of claims) {
    if (claim.concept !== "subject.exposure" || claim.subjectRef !== ref) continue;
    stated = true;
    if (!claim.semanticTags.includes("coverage:bare")) return false;
  }
  return stated;
}

/**
 * Whether this subject has literally nothing worn anywhere this program
 * states — the one condition under which "no clothes" is true rather than an
 * overclaim beside a wardrobe or partial-coverage sentence this same prompt
 * also carries.
 */
function wearsNothingAtAll(claims: readonly ImagePositiveClaim[], ref: string): boolean {
  return !hasWardrobeClaim(claims, ref) && everyExposureRegionBare(claims, ref);
}

/**
 * The nudity-reinforcement clause (acceptance #4, owner ruling 2026-10-01):
 * 2.1 renders every reference-view wardrobe and every intimate chat scene
 * WITHOUT a LoRA, so the prompt itself has to state nudity rather than lean on
 * weights trained to assert it. "Naked" and "nude" are said whenever the
 * trigger holds — reinforcement through repetition, not one dense clause —
 * ALONGSIDE the body attributes the exposure and intimate-reveal facts
 * already state, never replacing them. "No clothes" is said only when
 * {@link wearsNothingAtAll} is true: the torso/pelvis threshold that TRIGGERS
 * this clause ({@link isFullyBareSubject}) says nothing about stockings, heels
 * or a region outside that threshold that still reads covered or sheer, and a
 * prompt claiming no clothes beside a sentence naming one is a contradiction a
 * model has to resolve by ignoring one of them.
 *
 * Emitted only on a route that permits intimate content
 * (`input.intimatePermitted`) and only where {@link isFullyBareSubject} is
 * true. Both are required. The permission is the RENDER's own intimate
 * allowance — in a chat scene, the rung's `allowIntimate` (`scene.ts`
 * `allowIntimateFor`), true on an edit rung for an adult cast whatever the
 * staging, so an ORDINARY scene gets this clause exactly like a staged one
 * once its subject reads fully bare. It does NOT depend on any
 * `subject.intimate_anatomy` claim being present: a permitted bare view of a
 * subject with no intimate attributes authored still reinforces. Without the
 * permission — a minor's wardrobe, a `clothed` reference view, an ordinary
 * (non-`nsfw test`) variant — a fully bare subject states only the exposure
 * sentences every dialect states; so does a partial undress either way. This
 * function is never called for any of them.
 */
function nudityReinforcementClause(subject: string | null, nothingWorn: boolean): string {
  const naked = nothingWorn
    ? prefixed(subject, "is completely naked, with no clothes left anywhere on the body")
    : prefixed(subject, "is completely naked");
  return `${naked} ${prefixed(subject, "is fully nude")}`;
}

/**
 * How this endpoint says one claim — an exhaustive switch over the concept
 * registry, so a new concept is a compile error here rather than a claim that
 * quietly never reaches this endpoint's prompt.
 */
function renderClaim(
  claim: ImagePositiveClaim,
  input: ImageDialectPositiveInput,
  state: RenderState,
  surfaces: SceneStagingSurfaceLog,
): ImagePromptSegment | null {
  const say = (text: string): ImagePromptSegment => ({
    kind: claim.segmentKind,
    text: sentence(text),
    mandatory: claim.required,
    priority: claim.priority,
  });
  const sayOrNull = (text: string | null): ImagePromptSegment | null => (text === null ? null : say(text));
  if (unwordableImageClaimValue(claim.value)) {
    reportUnwordableClaimValue(claim, input.sink);
    return null;
  }
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);

  switch (claim.concept) {
    // --- Operation ------------------------------------------------------------
    case "operation.change":
      return say(`Edit the supplied image: ${describeChange(claim.value)}.`);
    case "operation.preserve": {
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
      return say(
        object === null
          ? `The text "${value}" is rendered exactly, sharp and fully legible.`
          : `${capitalize(object)} carries the text "${value}", rendered exactly, sharp and fully legible.`,
      );
    case "operation.reference_role": {
      // Qwen-family numbered references (owner ruling 2026-08-24): unlike 2512
      // this endpoint HAS a numbered reference syntax, so every resolved role
      // gets its own "Image N …" sentence rather than 2512's before/product stub.
      const slot = claimSlot(input, state, claim.value as ImageReferenceRole, claim.subjectRef);
      if (slot === null) return null;
      const introduction = referenceIntroduction(slot.role, slot.position, subject, slot.description);
      return introduction === null ? null : say(introduction);
    }

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
      // ADOPTS the registry's wording, for the same reason the prose family and
      // 2512 do (see their module docs): the templates are a measured artifact
      // in the register this endpoint also speaks, and no 2.1-specific evidence
      // exists to replace it with.
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
      const slots = identitySlotsFor(input, claim.subjectRef);
      if (slots.length === 0) {
        // No photograph of this subject rode this payload (the zero-reference
        // bare-prompt rung, or a cast member the lane sent no image of) — the
        // same plain descriptive sentence 2512 compiles unconditionally.
        return say(subject === null ? `${capitalize(value)}.` : `${capitalize(subject)}: ${value}.`);
      }
      return say(identityLockSentence(subject, slots));
    }
    case "subject.face_visibility": {
      const visibility = imageSceneObscuredFace(claim.value);
      if (visibility === null) return null;
      return say(
        faceVisibilitySentence(
          visibility,
          subject,
          faceVisibilityAnchor(input, claim),
          hairConcealedForSubject(input, claim.subjectRef),
        ),
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
      return say(prefixed(subject, `is ${value}`));
    case "subject.expression":
      return say(prefixed(subject, `wears a ${value} expression`));
    case "subject.body_language":
    case "subject.current_state":
      return say(prefixed(subject, currentStatePredicate(value)));
    case "subject.wardrobe":
      return say(prefixed(subject, `wears ${value}`));
    case "subject.hair_concealment":
      return say(hairConcealmentSentence(subject));
    case "subject.exposure": {
      // Acceptance #4: 2.1 carries no LoRA to assert nudity, so on a route that
      // permits intimate content a fully bare subject (both torso and pelvis
      // reading bare — the same threshold `selectReferenceView` uses for its
      // `bare` wardrobe) gets the clause stated explicitly, alongside this
      // claim's own attribute wording rather than in place of it. Attached to
      // the LAST exposure claim for this subject so it fires exactly once
      // whatever regions this shot's framing carries. "No clothes" is further
      // gated on `wearsNothingAtAll` — a wardrobe claim (stockings, heels) or
      // any other exposure region reading covered/sheer would make it a lie.
      const base = prefixed(subject, `is ${value}`);
      const reinforced =
        input.intimatePermitted === true &&
        claim.subjectRef !== undefined &&
        isLastExposureClaimForSubject(input.claims, claim) &&
        isFullyBareSubject(input.claims, claim.subjectRef)
          ? `${base} ${nudityReinforcementClause(subject, wearsNothingAtAll(input.claims, claim.subjectRef))}`
          : base;
      return say(reinforced);
    }

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
      return say(value);
  }
}

function compilePositive(input: ImageDialectPositiveInput): ImageCompiledPositivePrompt {
  const surfaces = createSceneStagingSurfaceLog();
  const state: RenderState = { takenSlots: new Set() };
  return compileDialectClaims({
    claims: input.claims,
    render: (claim) => renderClaim(claim, input, state, surfaces),
    surfaces,
    budget: input.budget,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

/**
 * The reason every exclusion drops on this endpoint: the probed `negativePrompt`
 * field is real, but the official pipeline applies it only under true CFG, and
 * every profile this dialect binds (`variant-standard`, `scene-standard`) runs
 * at the blank `cfgScale` of 1 — where the lane REFUSES a negative prompt
 * outright rather than silently ignoring it
 * (`docs/image-models/models/civitai-qwen-image-2-1.md` §Generation settings,
 * probed 2026-09-30). Sending one is therefore not merely wasted budget, the
 * way an ignored field is on 2512 — it would fail the render. So this dialect
 * makes it impossible at the source: `negativeSyntax`/`negativeTransport`
 * below declare no channel, and `compileNegative` drops every constraint with
 * this recorded reason, whatever the bound pack enables.
 */
const NEGATIVE_REFUSED_AT_OPERATING_CFG = "endpoint_negative_refused_at_operating_cfg";

function compileNegative(input: ImageDialectNegativeInput): ImageCompiledNegativePrompt {
  return {
    text: null,
    replacementClaims: [],
    inlineText: [],
    outcomes: input.constraints.map((constraint) => ({
      constraintId: constraint.id,
      transport: { kind: "dropped", reason: NEGATIVE_REFUSED_AT_OPERATING_CFG },
    })),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const qwenImage21Dialect: ImagePromptDialectDefinition = {
  id: DIALECT_ID,
  positiveSyntax: "natural_language",
  // The field exists on the probed schema but is REFUSED at this dialect's
  // operating cfgScale; see `compileNegative`.
  negativeSyntax: "none",
  negativeTransport: "unsupported",
  // Qwen-family numbered references (owner ruling 2026-08-24): the checkpoint
  // takes 1-10 ordered references for its edit operation.
  referenceSyntax: "numbered_images",
  supportsWeights: false,
  supportsLiteralQuotes: true,
  // Nothing probed injects a default on this endpoint; a blank negativePrompt
  // simply sends nothing (model page §Generation settings).
  hiddenPromptSources: [],
  compilePositive,
  compileNegative,
};

registerImagePromptDialect(qwenImage21Dialect);
