import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type { ImageAngleBand, ImageDistanceBand, ImageFramingBand, ImageLightingBand } from "./camera-bands";
import type { ImageConflictKey, ImageStyleMedium } from "./conflict-keys";
import {
  compileDialectClaims,
  registerImagePromptDialect,
  type ImageCompiledNegativePrompt,
  type ImageCompiledPositivePrompt,
  type ImageDialectNegativeInput,
  type ImageDialectPositiveInput,
  type ImageNegativeTransportOutcome,
  type ImagePromptDialectDefinition,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";

/**
 * `qwen/qwen-image-2512` — the first implemented dialect
 * (model-aware-image-prompts.research.md §"Qwen Image 2512").
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
 * (docs/image-models/qwen-image-2512.md), so there is nothing to neutralize, and
 * recording that explicitly is what lets provenance distinguish "the provider
 * added nothing" from "nobody checked".
 *
 * The field is recorded here even though this dialect never writes it. It exists
 * on the endpoint schema, it is part of the effective prompt in the sense this
 * record tracks, and its measured inertness is exactly the kind of fact a future
 * reader needs — the entry is what stops somebody rediscovering the field and
 * assuming it works.
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
function renderClaim(claim: ImagePositiveClaim, input: ImageDialectPositiveInput): ImagePromptSegment | null {
  const say = (text: string): ImagePromptSegment => ({
    kind: claim.segmentKind,
    text: sentence(text),
    mandatory: claim.required,
    priority: claim.priority,
  });
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);

  switch (claim.concept) {
    // --- Operation ------------------------------------------------------------
    case "operation.change":
      return say(`Edit the supplied image: ${describeChange(claim.value)}.`);
    case "operation.preserve":
      // Named facts, never "preserve everything" — the research traces Qwen's
      // squashed-figure geometry failure to exactly that blanket wording fighting
      // a requested pose change.
      return say(`Everything else stays as it is in the source, including ${listOf(claim.value)}.`);
    case "operation.geometry":
      return say(
        value === "canvas_may_expand"
          ? "You may extend the canvas and paint in the newly required space rather than compressing the subject to fit."
          : "Recompose the frame as the new content requires.",
      );
    case "operation.subject_count":
      return say(subjectCountSentence(Number(claim.value)));
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

    // --- Subject --------------------------------------------------------------
    case "subject.identity":
      return say(subject === null ? `${capitalize(value)}.` : `${capitalize(subject)}: ${value}.`);
    case "subject.apparent_age":
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
  return compileDialectClaims({
    claims: input.claims,
    render: (claim) => renderClaim(claim, input),
    budget: input.budget,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

/**
 * How this endpoint states, AFFIRMATIVELY, the outcome an exclusion asks for.
 *
 * This dialect has no working negative channel. Qwen Image 2512's Replicate
 * endpoint exposes a `negative_prompt` field, and a controlled Vesper trial
 * (2026-08-19, `qwen-2512-negative-blocks.ts` trials A/A2) found it produces no
 * measurable semantic response: with positive prompt, seed, aspect and controls
 * held constant, a negative of "red apple, apple" left a requested red apple in
 * 10/10 renders on the default sampling path and 6/6 with `go_fast: false`. The
 * pixels differ between arms, so the string reaches the sampler — the CONTENT
 * does not move. A schema field is not a capability until a trial says so.
 *
 * So every constraint compiles to a positive claim instead: the outcome is
 * stated as something the image SHOULD contain rather than something it must
 * not. That is also how this model's own documentation asks to be instructed,
 * and it keeps the whole constraint system intact — the pack still owns which
 * blocks apply, the guards still decide applicability, and the collision linter
 * still prevents a replacement from contradicting world truth exactly as it
 * prevented a forbidden phrase from doing so. Only the TRANSPORT changed.
 *
 * Exhaustive over the conflict vocabulary for the same reason `renderClaim` is:
 * a new key must be worded deliberately rather than silently asserting nothing.
 * Returning null is legitimate — some outcomes have no honest affirmative
 * opposite, and claiming one would spend prompt budget on a sentence that does
 * not describe the picture.
 */
function affirmativePhrase(key: ImageConflictKey): string | null {
  switch (key) {
    // --- Marks and lettering --------------------------------------------------
    // One clause covers the family: the linter has already removed these keys
    // when the world authored lettering, so reaching here means the render wants
    // clean surfaces.
    case "text":
      return "every surface is clean and unmarked, carrying no lettering beyond what is described";
    case "letters":
    case "caption":
      return "any lettering that does appear is crisp and correctly formed";
    case "logo":
      return "surfaces carry no brand marks or logos";
    case "signature":
    case "watermark":
      return "the image is clean and unsigned, free of watermarks or overlaid marks";

    // --- Anatomy --------------------------------------------------------------
    // Affirmative anatomy statements, reached only after intended morphology and
    // authored absences have been subtracted by the guard.
    case "extra_limbs":
    case "extra_appendages":
      return "the figure has an ordinary, correct number of limbs";
    case "extra_digits":
    case "missing_digits":
      return "each hand has exactly five well-formed fingers";
    case "missing_limbs":
      return "the figure is whole and anatomically complete";
    case "malformed_hands":
      return "the hands are well-formed and naturally posed";
    case "duplicated_anatomy":
    case "disconnected_anatomy":
      return "the body is coherent, with every limb correctly attached";

    // --- Subject integrity ----------------------------------------------------
    case "multiple_people":
      return "only the named subjects are present";
    case "duplicate_face":
      return "each person appears exactly once";
    case "identity_drift":
      return "the face matches the reference image exactly";

    // --- Composition and camera -----------------------------------------------
    case "cropped":
    case "out_of_frame":
      return "the complete subject is visible from end to end with comfortable margin inside the frame";
    case "close_up":
      return "the framing keeps its stated distance from the subject";
    case "blur":
      return "the subject is sharp and in focus";
    case "confused_composition":
      return "the composition is clear and readable";
    case "impossible_overlap":
      return "objects sit in plausible physical relation to one another";

    // --- Surface, medium and fidelity -----------------------------------------
    case "synthetic_skin":
    case "excessive_smoothing":
      return "skin has natural texture and real pore detail";
    case "oversaturation":
      return "colour is natural and true to life";
    case "low_resolution":
    case "low_quality":
      return "the image is high resolution with fine detail throughout";
    // The medium keys say what the render is NOT in, and the style claim already
    // says what it IS. A second sentence asserting the same medium would be the
    // duplication the collision rules exist to prevent.
    case "photographic":
    case "illustration":
    case "anime":
    case "painting":
    case "render_3d":
      return null;

    // --- Scene ----------------------------------------------------------------
    case "background_clutter":
      return "the background is clean and empty";
    case "extra_objects":
      return "the target subject appears alone, with no additional objects";
  }
}

/**
 * The claim id one constraint's replacement carries.
 *
 * Prefixed so provenance can tell a projected fact from an exclusion that became
 * one, and so two blocks contributing the same conflict key cannot collide.
 */
function replacementClaimId(constraintId: string): string {
  return `negative.${constraintId}`;
}

/**
 * Compile every surviving exclusion as affirmative positive guidance.
 *
 * Returns no dedicated-field text at all: this endpoint's field is
 * behaviourally inert (see {@link affirmativePhrase}), and writing a string
 * nobody reads would put an unread payload in provenance and invite a future
 * reader to believe it worked.
 *
 * A keyless constraint is the provider-default override. It has no affirmative
 * opposite to state, and on this endpoint it has nothing to override either —
 * the wrapper's `negative_prompt` default is blank and inert — so it is dropped
 * with its own reason rather than silently disappearing.
 *
 * Claims land in `quality`, the last segment kind and the first a budget squeeze
 * gives up. That is deliberate: an exclusion is a preference about how the
 * render turns out, and it must never outrank a fact the world actually
 * asserted. The fitter enforces the ordering; this only has to file them
 * correctly.
 */
function compileNegative(input: ImageDialectNegativeInput): ImageCompiledNegativePrompt {
  const replacementClaims: ImagePositiveClaim[] = [];
  const outcomes: ImageNegativeTransportOutcome[] = [];
  const said = new Set<string>();

  for (const constraint of input.constraints) {
    if (constraint.conflictKeys.length === 0) {
      outcomes.push({
        constraintId: constraint.id,
        transport: { kind: "dropped", reason: "no_provider_default_to_override" },
      });
      continue;
    }
    const phrases: string[] = [];
    for (const key of constraint.conflictKeys) {
      const phrase = affirmativePhrase(key);
      // Deduplicated across the whole program: two blocks both asking for a
      // clean background would otherwise say it twice in one paragraph.
      if (phrase === null || said.has(phrase)) continue;
      said.add(phrase);
      phrases.push(phrase);
    }
    if (phrases.length === 0) {
      outcomes.push({ constraintId: constraint.id, transport: { kind: "dropped", reason: "no_affirmative_wording" } });
      continue;
    }
    const claim: ImagePositiveClaim = {
      id: replacementClaimId(constraint.id),
      concept: "style.quality",
      segmentKind: "quality",
      value: phrases,
      semanticTags: [],
      required: false,
      priority: constraint.priority,
      source: { owner: "image.negative_pack", key: constraint.id },
      fromConstraintId: constraint.id,
    };
    replacementClaims.push(claim);
    outcomes.push({ constraintId: constraint.id, transport: { kind: "positive_replacement", claims: [claim] } });
  }

  return { text: null, replacementClaims, inlineText: [], outcomes };
}

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

/**
 * A claim's value as prose.
 *
 * Values arrive from projections in three honest shapes — a string, a list of
 * strings, or a small record with a `label`/`text`/`value` member — and this
 * flattens all three. A record with none of those is rendered as its own values
 * joined, which is a last resort that at least says something true rather than
 * emitting `[object Object]` into a payload.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return listWords(value.map(describe).filter((entry) => entry.length > 0));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["label", "text", "value", "name"]) {
      const member = record[key];
      if (typeof member === "string" && member.trim().length > 0) return member.trim();
    }
    return listWords(Object.values(record).map(describe).filter((entry) => entry.length > 0));
  }
  return "";
}

/** The change contract's value, which carries the concept alongside the value. */
function describeChange(value: unknown): string {
  if (value !== null && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return describe((value as Record<string, unknown>)["value"]);
  }
  return describe(value);
}

/** A claim value that is a list of fact keys, as a readable phrase. */
function listOf(value: unknown): string {
  return Array.isArray(value) ? listWords(value.map((entry) => describe(entry))) : describe(value);
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(parts: readonly string[]): string {
  const clean = parts.filter((part) => part.length > 0);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** The label for an entity ref, or null when the ref is absent or unlabelled. */
function label(input: ImageDialectPositiveInput, ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const found = input.entityLabels[ref];
  return found === undefined || found.trim().length === 0 ? null : found.trim();
}

/**
 * A subject-scoped sentence.
 *
 * "The subject" when nothing names them, their label when something does. Never
 * a pronoun: a dialect that guessed one would be asserting a gender the world
 * digest did not state, and this text goes into a payload that renders a person.
 */
function prefixed(subject: string | null, predicate: string): string {
  return `${subject ?? "The subject"} ${predicate}.`;
}

function relationSentence(
  say: (text: string) => ImagePromptSegment,
  subject: string | null,
  verb: string,
  object: string | null,
): ImagePromptSegment | null {
  // Both ends or nothing. A half-bound relation ("she holds") is worse than
  // silence: it invites the model to invent the object the render was supposed to
  // specify.
  if (subject === null || object === null) return null;
  return say(`${capitalize(subject)} ${verb} ${object}.`);
}

function spatialWord(value: string): string {
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

function subjectCountSentence(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "No people are present anywhere in the frame.";
  if (count === 1) return "Exactly one person is in frame.";
  return `Exactly ${count} people are in frame.`;
}

function framingSentence(band: ImageFramingBand): string {
  switch (band) {
    case "close_up":
      return "Tight close-up framing.";
    case "portrait":
      return "Head-and-shoulders portrait framing.";
    case "waist_up":
      return "Waist-up framing.";
    case "full_figure":
      return "Full-figure framing, the whole body inside the frame.";
    case "wide":
      return "Wide shot, the subject small within the setting.";
  }
}

function distanceSentence(band: ImageDistanceBand): string {
  switch (band) {
    case "touching":
      return "The camera is intimately close.";
    case "close":
      return "The camera is close, within arm's reach.";
    case "near":
      return "The camera is a step away.";
    case "distant":
      return "The camera is well back from the subject.";
  }
}

function angleSentence(band: ImageAngleBand, subject: string | null): string {
  const who = subject ?? "The subject";
  switch (band) {
    case "toward":
      return `${capitalize(who)} faces the camera.`;
    case "side_on":
      return `${capitalize(who)} is seen in profile.`;
    case "away":
      return `${capitalize(who)} is seen from behind.`;
  }
}

function lightingSentence(band: ImageLightingBand): string {
  switch (band) {
    case "bright":
      return "Bright, even light.";
    case "dim":
      return "Dim, low light.";
    case "dark":
      return "Near-darkness, only the shape readable.";
    case "silhouette":
      return "Backlit silhouette, the outline reading against the light.";
  }
}

function mediumSentence(medium: ImageStyleMedium): string {
  switch (medium) {
    case "photographic":
      return "Rendered as a photograph, with real optics and natural surface detail.";
    case "illustration":
      return "Rendered as an illustration.";
    case "anime":
      return "Rendered in an anime style.";
    case "painting":
      return "Rendered as a painting, with visible brushwork.";
    case "render_3d":
      return "Rendered as a 3D render.";
    case "unspecified":
      // Unreachable through the selector, which only emits this claim for a known
      // medium. Answering honestly rather than throwing keeps the switch total.
      return "";
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

const SENTENCE_TAIL = /[\s.!?…]+$/u;

/**
 * One sentence, terminated exactly once.
 *
 * Every wording above ends its clause with a full stop, which is right for a
 * single-word value and wrong for the authored prose half of them carry: an item
 * description usually ends in its own stop, so the lane shipped "a worn leather
 * lanyard.." in every product prompt. A description long enough to be excerpted
 * was worse — the projection ends a truncation with an ellipsis, and the appended
 * stop made "…".
 *
 * Normalizing here rather than at twenty call sites, because the invariant is
 * about the SEGMENT that reaches a payload, not about any one concept's phrasing.
 * An authored `!` or `?` is kept: it is the author's sentence, and flattening it
 * to a stop would be this dialect editing prose it was only asked to place.
 */
function sentence(text: string): string {
  const tail = SENTENCE_TAIL.exec(text)?.[0] ?? "";
  const body = text.slice(0, text.length - tail.length);
  if (body.length === 0) return "";
  if (tail.includes("…")) return `${body}…`;
  return `${body}${tail.includes("!") ? "!" : tail.includes("?") ? "?" : "."}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const qwenImage2512Dialect: ImagePromptDialectDefinition = {
  id: DIALECT_ID,
  positiveSyntax: "natural_language",
  // No working negative channel on this endpoint. The schema exposes
  // `negative_prompt`; a controlled trial found it produces no semantic
  // response, so the constraints travel as affirmative positive guidance and
  // the field is not written at all.
  negativeSyntax: "none",
  negativeTransport: "positive_replacement",
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
