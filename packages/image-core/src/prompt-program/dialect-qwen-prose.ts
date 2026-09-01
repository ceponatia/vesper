import { diag } from "@vesper/contracts";
import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type { ImageAngleBand, ImageDistanceBand, ImageFramingBand, ImageLightingBand } from "./camera-bands";
import type { ImageStyleMedium } from "./conflict-keys";
import type { ImageDialectPositiveInput } from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";

/**
 * Wording helpers shared by the Qwen-family dialects.
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

/** `a`, `a and b`, `a, b and c`. */
export function listWords(parts: readonly string[]): string {
  const clean = parts.filter((part) => part.length > 0);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
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
