import type { ImageReferenceRole } from "../capabilities/image-model-capabilities";
import { joinImagePromptSegments, type ImagePromptSegment } from "../render-intent/prompt-segments";
import type { ImageAngleBand, ImageDistanceBand, ImageFramingBand, ImageLightingBand } from "./camera-bands";
import type { ImageStyleMedium } from "./conflict-keys";
import {
  angleSentence,
  capitalize,
  describe,
  describeChange,
  distanceSentence,
  framingSentence,
  label,
  lightingSentence,
  listOf,
  listWords,
  preservedMeanings,
  mediumSentence,
  prefixed,
  relationSentence,
  sentence,
  spatialWord,
  subjectCountSentence,
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

/**
 * `qwen/qwen-image-edit-2511` — the delta-first instruction-edit dialect.
 *
 * Three endpoint facts shape everything here:
 *
 * 1. **It is an EDIT model.** Its `prompt` is "Text instruction on how to edit
 *    the given image" (probed schema, drizzle/0119), its reference input is
 *    required, and it cannot generate from text alone. So the compile is
 *    delta-first, in the research doc's order: the identity lock, the numbered
 *    references and their roles, the one requested change, the limited
 *    preserve set, and any geometry/canvas permission — never a broad
 *    "preserve everything" clause, which is the wording the research blames
 *    for Qwen's squashed-figure geometry failure when it fights a requested
 *    pose or framing change. The lock leading the assignments is this
 *    dialect's own emission order (`compilePositive`): the multi-reference
 *    lock promises "as assigned below", so the assignments must actually be
 *    below it (owner correction 2026-08-29 #4).
 * 2. **Numbered references are a FAMILY behavior** (owner ruling 2026-08-24):
 *    Qwen Edit's own multi-image guidance asks callers to identify images by
 *    number and assign each an explicit purpose, so this dialect declares
 *    `numbered_images` and writes `Image N …` assignments from the final send
 *    order — never from the order a lane supplied.
 * 3. **The probed endpoint has NO negative field** (drizzle/0119: its inputs
 *    are prompt, image, aspect_ratio, seed, go_fast, lora_*, output_*,
 *    disable_safety_checker). Per the owner ruling of 2026-08-29 the dialect
 *    declares `unsupported` and every compiled exclusion drops with a recorded
 *    transport reason. No inline or positive-replacement transport is invented
 *    here: whether affirmative wording can do the field's job is an evidence
 *    question for a fixed trial, exactly as it was for 2512.
 *
 * The identity lock (owner ruling 2026-08-29): the compiled `subject.identity`
 * claim reproduces, byte for byte, the lock sentence the render kernel's
 * `qwen.numbered-reference-dialect` quirk writes today, chosen single vs multi
 * by reference count — so a shadow compile of this dialect is byte-checkable
 * against the shipping edit path. The kernel quirk is untouched this round and
 * retires per lane at cutover.
 */

const DIALECT_ID = "qwen_2511_delta_edit" as const;

/**
 * Byte-copies of `QWEN_SINGLE_REFERENCE_IDENTITY_LOCK` and
 * `QWEN_MULTI_REFERENCE_IDENTITY_LOCK` in `@vesper/image-models`
 * (`packages/image-models/src/families/qwen/shared.ts`).
 *
 * Duplicated, not imported: `@vesper/image-core` and `@vesper/image-models`
 * are peer packages that may not import each other, and the coupling is a
 * byte-level contract rather than a code dependency — the whole point is that
 * two independent layers spell the same sentence, so a shadow compile of this
 * dialect matches the kernel quirk's output exactly. The root tripwire
 * `scripts/qwen-identity-lock-parity.test.ts` imports both packages and fails
 * the build the moment either copy drifts.
 */
export const QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK =
  "Image 1 is the identity reference. Preserve the exact face, hair, skin tone, body proportions, and apparent age. Change only what this instruction requests.";

/** See {@link QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK} — same contract, multi-reference spelling. */
export const QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK =
  "Use numbered references as assigned below. Preserve each person's exact face, hair, skin tone, build, and apparent age; change only requested details.";

/**
 * The lock for a reference count, mirroring the kernel quirk's own choice: the
 * quirk rewrites on total reference count, blind to roles, so byte parity
 * requires the same rule. Zero references returns null — there is no image to
 * lock an identity to, and on an endpoint whose whole transport for identity IS
 * the reference, describing a face in prose instead would render a stranger.
 */
function identityLock(referenceCount: number): string | null {
  if (referenceCount <= 0) return null;
  return referenceCount === 1 ? QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK : QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK;
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

/**
 * Within-segment emission priorities for the operation band.
 *
 * The fitter orders segments of one kind by priority descending, and the
 * operation contract's claims all arrive at priority 100 — so these offsets are
 * how this dialect states the research doc's delta-first order (references,
 * then the change, then the preserve set, then geometry, then required
 * lettering) instead of inheriting the claim ids' alphabetical accident.
 * Fractions above 100 keep every operation claim ahead of a lab `raw.text`
 * claim and leave cross-kind trimming behavior untouched.
 */
const DELTA_PRIORITY = {
  reference: 100.5,
  change: 100.4,
  preserve: 100.3,
  geometry: 100.2,
  literalText: 100.1,
} as const;

/**
 * The lock's own priority: below the operation band, above every projection
 * claim. It matters only under a hard provider ceiling, where mandatory
 * segments compress weakest-first by whole sentences — the lock is three
 * sentences, and a squeeze should eat descriptive prose long before it
 * shortens the sentence contract the edit path depends on.
 */
const IDENTITY_LOCK_PRIORITY = 99;

/** Per-compile render state. Created fresh in `compilePositive`, never shared. */
interface RenderState {
  lockEmitted: boolean;
  /**
   * The claim id whose segment carries the lock bytes — how `compilePositive`
   * finds the lock again after fitting, structurally rather than by matching
   * text (the segments carry the claim id as `source`).
   */
  lockClaimId: string | null;
  readonly takenSlots: Set<number>;
}

/**
 * The final send slot a reference claim names, or null when planning trimmed it.
 *
 * Matched against `input.references` — the post-planning, post-trimming send
 * order — because the prompt must never number an image the payload does not
 * carry (plan step 12). Strict on `subjectRef`: falling back to "any slot with
 * this role" could bind the wrong person to a number, which is worse than the
 * refusal the null produces. Matched slots are consumed so two references
 * sharing a role and subject (a face crop and a body shot) each name their own
 * position.
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
 * One numbered assignment, in the family's "identify each image and its
 * purpose" shape. Null for the structural control roles: 2511's probed schema
 * has no structural input, so a mask or depth map could only travel through the
 * content `image` array — where the model would DEPICT it rather than obey it,
 * and a prompt claiming otherwise would assert a transport this endpoint does
 * not have. The null drops the claim, and the operation kind's mandatory floor
 * turns that into a refusal before provider spend.
 */
function referenceAssignment(role: ImageReferenceRole, position: number, subjectLabel: string | null): string | null {
  switch (role) {
    case "identity":
      return `Image ${position} shows ${subjectLabel ?? "the subject"}.`;
    case "before":
      return `Image ${position} is the image to edit.`;
    case "location":
      return subjectLabel === null
        ? `Image ${position} shows the place.`
        : `Image ${position} shows the place, ${subjectLabel}.`;
    case "style":
      // The style role promises "no subject or object", and saying so is what
      // keeps the model from importing the style image's content.
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
      // The neutral role makes no semantic claim, so neither does its sentence.
      return `Image ${position} is a reference image.`;
    case "mask":
    case "pose":
    case "depth":
    case "edge":
    case "control":
      return null;
  }
}

/**
 * How this endpoint says one claim.
 *
 * An exhaustive switch over the concept registry, so a new concept is a COMPILE
 * ERROR here rather than a claim that quietly never reaches a prompt. Most
 * descriptive concepts share the family's clause grammar with the 2512 dialect
 * (`./dialect-qwen-prose`); the operation band and `subject.identity` are where
 * an instruction editor genuinely differs from a describe-everything generator.
 */
function renderClaim(
  claim: ImagePositiveClaim,
  input: ImageDialectPositiveInput,
  state: RenderState,
): ImagePromptSegment | null {
  const say = (text: string, priority: number = claim.priority): ImagePromptSegment => ({
    kind: claim.segmentKind,
    text: sentence(text),
    mandatory: claim.required,
    priority,
  });
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);

  switch (claim.concept) {
    // --- Operation: the delta, in the research doc's order --------------------
    case "operation.change":
      // "One clear requested change" — the instruction this edit IS.
      return say(`Make exactly this change: ${describeChange(claim.value)}.`, DELTA_PRIORITY.change);
    case "operation.preserve": {
      // The LIMITED preserve set, named fact by fact. Deliberately no
      // "everything else stays" preamble: a blanket preserve fighting the
      // requested change is the documented squashed-figure failure, and the
      // lock already says "change only what this instruction requests".
      //
      // Named by what each fact IS, never by its key: the contract identifies
      // the preserved facts structurally and this is where that becomes
      // language (`preservedMeanings`). Nothing to say means no sentence — a
      // mandatory claim that renders nothing is a dropped claim, which the
      // compile refuses over rather than shipping an empty instruction.
      const preserved = preservedMeanings(input, claim.value);
      if (preserved.length === 0) return null;
      return say(`Keep ${listWords(preserved)} unchanged from the source.`, DELTA_PRIORITY.preserve);
    }
    case "operation.geometry":
      return say(
        value === "canvas_may_expand"
          ? "You may extend the canvas and paint in the newly required space rather than compressing the subject to fit."
          : "Recompose the frame as the new content requires.",
        DELTA_PRIORITY.geometry,
      );
    case "operation.subject_count":
      return say(subjectCountSentence(Number(claim.value)));
    case "operation.literal_text":
      // Quoted and letter-exact — the family's text rendering is an advertised
      // strength, and quoting is how its model cards ask for exact lettering.
      return say(
        object === null
          ? `The text "${value}" is rendered exactly, sharp and fully legible.`
          : `${capitalize(object)} carries the text "${value}", rendered exactly, sharp and fully legible.`,
        DELTA_PRIORITY.literalText,
      );
    case "operation.reference_role": {
      const slot = claimSlot(input, state, claim.value as ImageReferenceRole, claim.subjectRef);
      if (slot === null) return null;
      const assignment = referenceAssignment(slot.role, slot.position, subject);
      return assignment === null ? null : say(assignment, DELTA_PRIORITY.reference);
    }

    // --- Subject --------------------------------------------------------------
    case "subject.identity": {
      // The identity travels in the reference, so the identity claim compiles to
      // the lock — the exact bytes the kernel quirk writes today (owner ruling
      // 2026-08-29), emitted once however many subjects the render carries.
      // Bypasses `sentence()` so nothing can renormalize a character of it.
      const lock = identityLock(input.references.length);
      if (lock === null) return null;
      if (!state.lockEmitted) {
        state.lockEmitted = true;
        state.lockClaimId = claim.id;
        return { kind: claim.segmentKind, text: lock, mandatory: true, priority: IDENTITY_LOCK_PRIORITY };
      }
      // Further subjects: the multi lock already covers "each person", so their
      // identity claims anchor the NAME the numbered assignments bind.
      return say(subject === null ? `${capitalize(value)}.` : `${capitalize(subject)}: ${value}.`, IDENTITY_LOCK_PRIORITY);
    }
    case "subject.apparent_age":
      // Text-authoritative by owner ruling: age text must correct an
      // age-ambiguous reference rather than inherit drift from it.
      return say(prefixed(subject, `appears ${value}`));
    case "subject.morphology":
      return say(prefixed(subject, `has ${value}`));
    case "subject.absence":
      return say(prefixed(subject, `has ${value}, shown plainly and anatomically correctly`));
    case "subject.appearance":
      return say(prefixed(subject, `has ${value}`));
    case "subject.pose":
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
  // Fresh state per compile — the lock-once and slot-consumption rules are
  // per-render facts, and state leaking across compiles would make the second
  // compile of one digest differ from the first, which the determinism
  // guarantee forbids.
  const state: RenderState = { lockEmitted: false, lockClaimId: null, takenSlots: new Set<number>() };
  const compiled = compileDialectClaims({
    claims: input.claims,
    render: (claim) => renderClaim(claim, input, state),
    budget: input.budget,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });

  // This dialect's OWN emission order (the canonical segment order permits a
  // dialect reorder): the identity lock leads the compiled prompt, ahead of
  // the numbered `Image N` assignments the canonical operation-first order
  // would otherwise put in front of it. The multi-reference lock says "Use
  // numbered references as assigned below", and under the canonical order that
  // "below" was false in the compiled output (owner correction 2026-08-29 #4)
  // — the lock BYTES are frozen for kernel-quirk parity, so the order moves
  // instead. The requested change, the preserve set and the geometry
  // permission keep their delta-first order after the assignments; nothing
  // else moves. Reordering happens AFTER fitting, so what a budget squeeze
  // keeps or trims is unchanged by this.
  if (state.lockClaimId === null) return compiled;
  const lockIndex = compiled.segments.findIndex((segment) => segment.source === state.lockClaimId);
  const lock = compiled.segments[lockIndex];
  if (lock === undefined || lockIndex <= 0) return compiled;
  const segments = [lock, ...compiled.segments.slice(0, lockIndex), ...compiled.segments.slice(lockIndex + 1)];
  return { ...compiled, segments, text: joinImagePromptSegments(segments) };
}

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

/** The reason every exclusion drops on this endpoint. */
const NO_NEGATIVE_FIELD = "endpoint_has_no_negative_field";

/**
 * Compile the negative channel — which on this endpoint means dropping all of
 * it, because there is nowhere for it to go: the probed Replicate schema
 * (drizzle/0119) exposes no negative input of any kind. That distinguishes this
 * endpoint from its sibling 2512, whose field exists and is ignored — two
 * different facts, two different recorded reasons.
 *
 * Every constraint drops with the reason above and the drop is RECORDED, so an
 * operator can still see exactly what this render would have excluded on an
 * endpoint that could carry it. The version gate's own
 * `no_negative_field_on_version` never fires here — nothing is compiled as
 * `dedicated_field` for it to rewrite.
 *
 * What is deliberately NOT done (owner ruling 2026-08-29): no inline and no
 * positive-replacement transport. The research names replacement language as a
 * possibility for this endpoint, but whether affirmative wording achieves what
 * a field would is an evidence question only a fixed trial can answer, and
 * until one does this dialect states the honest `unsupported`.
 */
function compileNegative(input: ImageDialectNegativeInput): ImageCompiledNegativePrompt {
  return {
    text: null,
    replacementClaims: [],
    inlineText: [],
    outcomes: input.constraints.map((constraint) => ({
      constraintId: constraint.id,
      transport: { kind: "dropped", reason: NO_NEGATIVE_FIELD },
    })),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const qwenImageEdit2511Dialect: ImagePromptDialectDefinition = {
  id: DIALECT_ID,
  positiveSyntax: "natural_language",
  // No negative input exists on the probed schema — see `compileNegative`.
  negativeSyntax: "none",
  negativeTransport: "unsupported",
  // Numbered references are the Qwen Edit family's documented convention
  // (owner ruling 2026-08-24: a family behavior, never a single endpoint's).
  referenceSyntax: "numbered_images",
  supportsWeights: false,
  supportsLiteralQuotes: true,
  // Probed and there is nothing: no default negative (no field), no preprompt,
  // no upsampler, no refiner on the 0119 schema.
  hiddenPromptSources: [],
  compilePositive,
  compileNegative,
};

registerImagePromptDialect(qwenImageEdit2511Dialect);
