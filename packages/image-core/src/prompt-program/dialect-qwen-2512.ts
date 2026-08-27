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
  type ImagePromptDialectDefinition,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";

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
