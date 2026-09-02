import { diag } from "@vesper/contracts";
import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type { SceneCaptureMode } from "../scene-ir";
import type {
  ImageAngleBand,
  ImageCameraHeightBand,
  ImageDistanceBand,
  ImageFramingBand,
  ImageLightingBand,
} from "./camera-bands";
import type { ImageStyleMedium } from "./conflict-keys";
import type { ImageDialectPositiveInput } from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";
import { imageScenePossessionOwners } from "./scene-facts";

/**
 * Wording helpers shared by the Qwen-family dialects — and, for the
 * value-reading plumbing rather than the sentences, by every other family too.
 *
 * Extracted verbatim from `dialect-qwen-2512.ts` when the 2511 delta-edit
 * dialect arrived, because both endpoints speak the same natural-language
 * clause grammar and a second copy of `describe`/`sentence` would be a second
 * answer to "how does a claim value become prose".
 *
 * The caveat the plan attaches to sharing: helpers are shared, WORDING
 * DECISIONS are not. Each dialect keeps its own exhaustive concept switch, its
 * own registry entry and its own trial verdict, so a per-endpoint wording fix
 * belongs in that dialect's switch — editing a helper here changes every Qwen
 * endpoint at once, and should only do so deliberately.
 *
 * Not exported from the package barrel: these are dialect internals, not API.
 */

/**
 * A claim's value as prose.
 *
 * Values arrive from projections in three honest shapes — a string, a list of
 * strings, or a small record with a `label`/`text`/`value` member — and this
 * flattens all three. A record with none of those is rendered as its own values
 * joined, which is a last resort that at least says something true rather than
 * emitting `[object Object]` into a payload.
 */
export function describe(value: unknown): string {
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
export function describeChange(value: unknown): string {
  if (value !== null && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return describe((value as Record<string, unknown>)["value"]);
  }
  return describe(value);
}

/** A claim value that is a list of fact keys, as a readable phrase. */
export function listOf(value: unknown): string {
  return Array.isArray(value) ? listWords(value.map((entry) => describe(entry))) : describe(value);
}

/**
 * The preserve set's fact keys, as the visual things they name.
 *
 * A preserve entry identifies a fact STRUCTURALLY — `<subject>/horns/species.
 * feature_group`, `subject.<id>.apparent_age` — because that is what makes the
 * set derivable, fingerprintable and checkable against the digest. None of it is
 * language. Rendering those strings would put a character's database id, a
 * projection source key and a registry kind id into prose a provider receives
 * and a model is asked to act on: unusable as instruction, and a private
 * identifier leaving the system as a side effect of a prompt.
 *
 * So the structural half stays in the contract and the wording happens here. The
 * key is resolved against the program's own claims — every preserved fact is
 * itself a claim, since only required facts are preserved — and rendered as the
 * thing it names: its locus ("horns", "hair"), or the concept's own noun when a
 * fact carries no locus. The fact's VALUE is deliberately not repeated; its own
 * claim states it elsewhere in the same prompt, and "keep the horns" plus "the
 * horns are spiraled" says everything "keep the spiraled horns" would.
 *
 * An entry nothing in this program can word is DROPPED rather than degraded back
 * to its key, and reported: a preserved anchor that quietly stopped reaching the
 * prompt is the silent loss `docs/resilience.md` exists to prevent. A caller
 * left with nothing at all gets an empty list and must decide what that means —
 * for a mandatory preserve claim that is a dropped claim, which the compile
 * already refuses over before any provider spend.
 *
 * An entry goes unresolved when the preserve set names a fact this program does
 * not state: a concept the bound pack suppresses, a fact the digest could not
 * carry, or a contract naming something the digest never had.
 */
export function preservedMeanings(
  input: ImageDialectPositiveInput,
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map(input.claims.map((claim) => [claim.id, claim]));
  const words: string[] = [];
  const unworded: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const claim = byId.get(entry);
    const noun = claim === undefined ? null : preservedNoun(claim);
    if (noun === null) {
      unworded.push(entry);
      continue;
    }
    if (!words.includes(noun)) words.push(noun);
  }
  if (unworded.length > 0) {
    input.sink?.push(
      diag("warn", IMAGE_PROMPT_PRESERVE_UNWORDED, "a preserved fact could not be named in the prompt", {
        path: "image.prompt_program.preserve",
        context: { keys: unworded },
      }),
    );
  }
  return words;
}

/** A preserve entry the program cannot state, dropped from the sentence rather than keyed into it. */
export const IMAGE_PROMPT_PRESERVE_UNWORDED = "image_prompt_program.preserve_unworded";

/**
 * One preserved claim as a noun phrase.
 *
 * `locus` first: it is the projection's own word for the body part or slot the
 * fact describes, which is exactly the noun a preserve instruction wants. A fact
 * with none falls back to the last segment of its concept id — `subject.
 * apparent_age` becomes "apparent age" — which is registry vocabulary rather
 * than an internal handle: no id, no source key, no fingerprint.
 */
function preservedNoun(claim: ImagePositiveClaim): string | null {
  const locus = typeof claim.locus === "string" ? humanize(claim.locus) : "";
  if (locus.length > 0) return `the ${locus}`;
  const member = claim.concept.split(".").slice(1).join(" ");
  const noun = humanize(member);
  return noun.length === 0 ? null : `the ${noun}`;
}

/** Registry vocabulary as words: separators become spaces, nothing else changes. */
function humanize(token: string): string {
  return token.replace(/[_\-.]+/g, " ").trim();
}

/**
 * `a`, `a and b`, `a, b and c` — or the same with `or`, which is a different
 * claim rather than a stylistic choice: "belongs to Mira or Wren" says each part
 * has exactly one owner, where "and" would read as shared ownership.
 */
export function listWords(parts: readonly string[], conjunction: "and" | "or" = "and"): string {
  const clean = parts.filter((part) => part.length > 0);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} ${conjunction} ${clean[clean.length - 1]}`;
}

/** The label for an entity ref, or null when the ref is absent or unlabelled. */
export function label(input: ImageDialectPositiveInput, ref: string | undefined): string | null {
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
export function prefixed(subject: string | null, predicate: string): string {
  return `${subject ?? "The subject"} ${predicate}.`;
}

export function relationSentence(
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

export function spatialWord(value: string): string {
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

export function subjectCountSentence(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "No people are present anywhere in the frame.";
  if (count === 1) return "Exactly one person is in frame.";
  return `Exactly ${count} people are in frame.`;
}

export function framingSentence(band: ImageFramingBand): string {
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

export function distanceSentence(band: ImageDistanceBand): string {
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

export function angleSentence(band: ImageAngleBand, subject: string | null): string {
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

/**
 * Where the lens stands relative to the eye line.
 *
 * Subject-free, like the framing and distance sentences and unlike the angle one:
 * a height is a fact about the camera, and naming the subject in it would invite
 * the model to read it as something they are doing.
 *
 * `eye_level` still says so rather than falling silent the way a `still` motion
 * band does. A level lens is a real compositional statement, not the absence of
 * an effect — and suppressing a DEFAULT camera is upstream work: the application
 * simply does not lower a component that matched the registry default, so a
 * height that reaches a dialect was asserted on purpose.
 */
export function heightSentence(band: ImageCameraHeightBand): string {
  switch (band) {
    case "eye_level":
      return "The camera sits at eye level.";
    case "high":
      return "The camera sits above the eye line, angled down.";
    case "low":
      return "The camera sits below the eye line, angled up.";
  }
}

/**
 * Who is holding the camera, and therefore where the frame is standing.
 *
 * The POV wording mirrors the measured scene rule the application's retired
 * prose builder opened every render with, read one layer down: `player` becomes
 * `viewer`, because a provider-neutral dialect has no players. Everything else about it is load
 * bearing and measured. It names NO limb in any polarity — "the player is the
 * camera" had models painting hands gripping one, "no hands in frame" summoned
 * disembodied foreground hands, and even a possessively-bound enumeration
 * summoned what it named. What held up 3/3 is this shape.
 *
 * It is the DISEMBODIED rule, which is the only shot Vesper can compile today:
 * the viewer's own visible body is a deliberate follow-up (owner ruling
 * 2026-09-01), and until a concept carries it, "the viewer is never visible" is
 * true of every POV render this vocabulary can describe. An embodied shot needs
 * the measured embodied variant, which belongs with the concept that puts a limb
 * in frame.
 *
 * The selfie is worded here rather than copied from the retired builder's selfie
 * framing, whose sentence said "of herself" — a dialect may not assert a gender the world
 * digest did not state. What is kept is what that framing was built out of: the
 * subject's own camera, arm's length or a mirror, awareness of the lens, and the
 * close-quarters perspective of a phone.
 */
export function captureModeSentence(mode: SceneCaptureMode, subject: string | null): string {
  const who = subject ?? "the subject";
  switch (mode) {
    case "third_person":
      return "The shot is taken by an observing camera, from outside the scene.";
    case "first_person_disembodied":
      return "First-person POV through the viewer's own eyes; the viewer is never visible in the image.";
    case "first_person_embodied":
      return "First-person POV through the viewer's own eyes; the viewer's face and head are never in frame, though the viewer's own body may be cropped into the frame.";
    case "selfie":
      return `A phone selfie ${who} is taking: the camera held at arm's length or shot in a mirror, ${who} aware of the lens and composing the frame, in the close-quarters perspective of a phone camera.`;
  }
}

/** The labels a possession claim's refs name, in the order the projection listed them. */
export function possessionOwners(input: ImageDialectPositiveInput, value: unknown): readonly string[] {
  const names: string[] = [];
  for (const ref of imageScenePossessionOwners(value)) {
    const name = label(input, ref);
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * "Every visible body part belongs to Mira." — the total-possession binding.
 *
 * **Deliberately ABSTRACT, and it must stay that way.** The first draft of this
 * clause enumerated the limbs — "every hand, arm, leg and foot belongs to
 * Mira" — and the A/B run painted a phantom viewer hand anyway: a limb noun
 * summons a limb even when it is possessively bound. The abstraction is the half
 * doing the work, and "improving" this into something specific reopens a measured
 * failure. Binding a NAMED limb is the pose text's job, where the limb is in the
 * shot on purpose.
 *
 * The names are the other half. An anonymous form ("belongs to one of them")
 * keeps the abstraction and drops the binding, which is what was proven. So no
 * names means no clause at all — silence beats a possession sentence that binds
 * nothing.
 */
export function possessionSentence(owners: readonly string[]): string | null {
  if (owners.length === 0) return null;
  return `Every visible body part belongs to ${listWords(owners, "or")}.`;
}

/** `{name}`, the one substitution a staging template carries. */
const STAGING_SUBJECT_PLACEHOLDER = /\{name\}/gu;

/**
 * One adopted staging template, bound to the subject it describes.
 *
 * The template arrives verbatim, `{name}` intact, because a content digest is only
 * meaningful over a stable artifact — substituting before the form was created
 * would give every render different bytes and make the revision mechanism
 * meaningless. Binding is therefore an explicit step at the adoption call site,
 * and this is that step.
 *
 * "The subject" when nothing names them, never a pronoun, for the same reason
 * {@link prefixed} refuses one: a guessed pronoun asserts a gender the world
 * digest did not state, into text that renders a person. The retired prose
 * builder refused the arrangement outright when it had no name, and this does
 * not: an unlabelled subject is a projection bug rather than a fact about the
 * scene, and dropping the claim would render an intimate scene as an ordinary
 * portrait — which is the failure class this whole vocabulary exists to end. The
 * possessive binding survives either way, and that is the half that was measured.
 *
 * A template that binds to nothing at all yields null rather than an empty
 * sentence, because the arrangement is the whole content of the claim.
 */
export function stagingSentence(template: string, subject: string | null): string | null {
  const bound = template.replace(STAGING_SUBJECT_PLACEHOLDER, subject ?? "the subject").trim();
  return bound.length === 0 ? null : capitalize(bound);
}

export function lightingSentence(band: ImageLightingBand): string {
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

export function mediumSentence(medium: ImageStyleMedium): string {
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

export function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

const SENTENCE_TAIL = /[\s.!?…]+$/u;

/**
 * One sentence, terminated exactly once.
 *
 * Every wording in the Qwen dialects ends its clause with a full stop, which is
 * right for a single-word value and wrong for the authored prose half of them
 * carry: an item description usually ends in its own stop, so the lane shipped
 * "a worn leather lanyard.." in every product prompt. A description long enough
 * to be excerpted was worse — the projection ends a truncation with an ellipsis,
 * and the appended stop made "…".
 *
 * Normalizing here rather than at twenty call sites, because the invariant is
 * about the SEGMENT that reaches a payload, not about any one concept's phrasing.
 * An authored `!` or `?` is kept: it is the author's sentence, and flattening it
 * to a stop would be this dialect editing prose it was only asked to place.
 */
export function sentence(text: string): string {
  const tail = SENTENCE_TAIL.exec(text)?.[0] ?? "";
  const body = text.slice(0, text.length - tail.length);
  if (body.length === 0) return "";
  if (tail.includes("…")) return `${body}…`;
  return `${body}${tail.includes("!") ? "!" : tail.includes("?") ? "?" : "."}`;
}
