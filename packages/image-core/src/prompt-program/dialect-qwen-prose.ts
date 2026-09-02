import { diag } from "@vesper/contracts";
import type { ImagePromptSegment } from "../render-intent/prompt-segments";
import type { SceneCaptureMode, SceneViewerBodyPartId } from "../scene-ir";
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
import {
  imageSceneCaptureMode,
  imageScenePossessionOwners,
  imageViewerBodyParts,
  imageViewerDescriptors,
  type ImageObscuredFace,
} from "./scene-facts";

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

/**
 * The person count, as the positive form of "no third person".
 *
 * It counts the CAST and only the cast — the viewer is never a subject — so on
 * an embodied shot the plain form would be a contradiction the prompt has to
 * resolve on its own: "exactly one person is in frame" beside a sentence
 * describing the viewer's own hands. The retired prose builder's answer was the
 * word `fully`, and it is kept: the cast are the bodies the frame holds whole,
 * and a limb cropped by the frame edge is not one of them.
 *
 * `embodied` is a property of the shot rather than of the count, which is why it
 * arrives as a parameter instead of riding the claim: `operation.subject_count`
 * is an operation-contract member with no idea whose eyes the shot is through.
 * {@link viewerIsEmbodied} answers it from the compiled claim list.
 */
export function subjectCountSentence(count: number, embodied = false): string {
  if (!Number.isFinite(count) || count <= 0) return "No people are present anywhere in the frame.";
  if (embodied) {
    return count === 1 ? "Exactly one person is fully in frame." : `Exactly ${count} people are fully in frame.`;
  }
  if (count === 1) return "Exactly one person is in frame.";
  return `Exactly ${count} people are in frame.`;
}

/**
 * Whether THIS render's frame crops the viewer's own body into it.
 *
 * Read off the capture-mode claim rather than passed down, because the shot's
 * embodiment is already stated once as a fact and a second channel for it is a
 * second thing to keep in agreement. The claim is `required_visual` on every
 * scene the application lowers, so it is present whenever the answer is `true`.
 */
export function viewerIsEmbodied(input: ImageDialectPositiveInput): boolean {
  return input.claims.some(
    (claim) =>
      claim.concept === "scene.capture_mode" && imageSceneCaptureMode(claim.value) === "first_person_embodied",
  );
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
 * Two first-person forms, because a POV frame either holds the viewer's own body
 * or does not, and a prompt that gets that wrong contradicts itself. The
 * disembodied form is the measured one and asserts the viewer's absence; the
 * embodied form asserts only what stays out of frame — the face and head — and
 * says plainly that the rest may be cropped in, because `viewer.body_geometry`
 * is about to describe exactly which limbs those are. Saying "never visible"
 * beside that description is the self-contradiction this pair exists to prevent.
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

/**
 * One of the viewer's own parts, as frame geometry.
 *
 * Two things carry this wording and neither is decoration. **Possessive
 * binding** — "the viewer's own", never a bare noun and never a subject noun for
 * the viewer — and **frame geometry**: every phrase says where the limb meets
 * the frame edge and how hard it is foreshortened, because a limb the frame cuts
 * through and the lens looms over cannot be composed as somebody standing there.
 * Drop either half and the model paints a second person; that is the measured
 * failure the whole vocabulary is shaped around, and it is the same scar behind
 * the possession clause's abstraction.
 *
 * A dialect's wording rather than a registry's, for the reason a camera band's
 * is: the application decides WHICH parts the frame holds, and how an endpoint
 * should be told about a foreshortened forearm is this layer's question.
 * Exhaustive over the part vocabulary, so a new part is a compile error here
 * rather than a limb that silently never reaches a prompt.
 */
export function viewerPartPhrase(part: SceneViewerBodyPartId): string {
  switch (part) {
    case "hands":
      return "the viewer's own hands entering frame from the lower edge, close to the lens and strongly foreshortened";
    case "forearms":
      return "the viewer's own forearms entering frame from the lower edge, foreshortened, cropped where the frame cuts them";
    case "lap_thighs":
      return "the viewer's own thighs across the bottom of the frame, seen from above as they look down at their own lap";
    case "legs_feet":
      return "the viewer's own legs receding away from the lens toward the lower frame edge, feet at the far end";
    case "torso":
      return "the viewer's own chest and stomach along the bottom of the frame, foreshortened as they look down over themselves";
    case "genitals":
      return "the viewer's own genitals in the immediate foreground, close to the lens and cropped by the lower frame edge";
  }
}

/**
 * "Also in frame, in the viewer's immediate foreground: …" — the generic
 * geometry line.
 *
 * One sentence for every part the frame holds, not one per part: the foreground
 * is a single region of the picture, and a model handed three separate
 * statements about it has three chances to compose three separate things.
 *
 * The list carries only the parts NO staged sentence already places. That
 * filtering happens upstream, in the projection, because it is a fact about the
 * render rather than about this endpoint — a staged arrangement says where a
 * limb is on somebody and this says where it is relative to the lens, and both
 * at once puts the same two hands in two places in one prompt.
 *
 * An empty list yields null. A foreground clause naming no limb would be the
 * disembodied shot spelled at greater length.
 */
export function viewerGeometrySentence(value: unknown): string | null {
  const phrases = imageViewerBodyParts(value).map(viewerPartPhrase);
  if (phrases.length === 0) return null;
  return `Also in frame, in the viewer's immediate foreground: ${listWords(phrases)}.`;
}

/**
 * "The viewer's own body: …" — who those limbs belong to, as facts.
 *
 * It rides AFTER the geometry deliberately (the concept's `current_state`
 * segment kind emits later than `pose`): the model has to know the limbs are the
 * viewer's and cropped before it is told what they look like, or a described
 * body is an invitation to paint the whole person wearing it.
 *
 * Semicolons rather than a conjunction. These are registry label/value pairs
 * ("skin tone: olive"), and "and" between two of them reads as one phrase.
 */
export function viewerAppearanceSentence(value: unknown): string | null {
  const descriptors = imageViewerDescriptors(value);
  return descriptors.length === 0 ? null : `The viewer's own body: ${descriptors.join("; ")}.`;
}

/**
 * The viewer's own exposed anatomy, possessively bound.
 *
 * Bound where the retired prose builder left it bare: its line rode immediately
 * after the body line and borrowed that sentence's binding, which an ordered
 * claim list cannot promise. An unowned anatomy sentence in a two-body prompt is
 * the phantom-limb shape, so the binding is stated rather than inherited.
 */
export function viewerIntimateSentence(value: unknown): string | null {
  const descriptors = imageViewerDescriptors(value);
  return descriptors.length === 0 ? null : `The viewer's own exposed anatomy: ${descriptors.join("; ")}.`;
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

/**
 * Whether THIS subject has an identity image in the send list — the one question
 * that decides whether their adaptation may say "from the reference".
 *
 * Reference COUNT is the wrong question, and dangerously so on an ensemble. The
 * scene ladder's single-reference rung offers one surviving identity image, and
 * the resolved plan picks its focal independently — the focal is not required to
 * be the first cast member — so a render where Nyx is focal and turned away while
 * only Ilsa's reference survived has `references.length > 0` and no image of Nyx
 * at all. Anchoring her preservation set to "the reference" there points the
 * model at a photograph of somebody else and asks it to copy that person's hair,
 * build and skin tone onto her.
 *
 * The slot's `subjectRef` exists for exactly this: it is what keeps two identity
 * images apart. An identity image the lane could not attribute carries none, and
 * that answers "nothing" for everyone, which is the conservative reading — an
 * unattributed photograph is not evidence about any particular person.
 */
export function faceVisibilityAnchor(
  input: ImageDialectPositiveInput,
  claim: ImagePositiveClaim,
): "reference" | "nothing" {
  if (claim.subjectRef === undefined) return "nothing";
  const own = input.references.some(
    (slot) => slot.role === "identity" && slot.subjectRef === claim.subjectRef,
  );
  return own ? "reference" : "nothing";
}

/**
 * The one sentence a subject whose headwear fully hides their hair gets in
 * place of every authored hair fact — shared by the three prose-register
 * families so the meaning cannot drift between endpoints. Name-bound and
 * pronoun-free for the reason {@link faceVisibilitySentence} is, and the
 * possessive rather than `prefixed`'s "<subject> has …", because what is
 * being stated is a condition of the hair, not a feature the person has.
 */
export function hairConcealmentSentence(subject: string | null): string {
  return `${capitalize(subject ?? "the subject")}'s hair is fully covered by the headwear; no hair is visible.`;
}

/**
 * The identity lock's adaptation, for a shot whose subject's face is turned or
 * hidden — a sentence of its own, never spliced into the lock string.
 *
 * The lock and the camera pull against each other, and the lock wins by default:
 * the cheapest way for a model to prove it preserved a face is to show that face,
 * so "preserve the exact face" quietly rotates a character the shot just put
 * back-to-camera. Adapting means naming what to preserve when the face is not the
 * evidence — hair, build, skin tone — and saying outright that the turn is not on
 * the table.
 *
 * **A separate sentence, never woven into the lock.** Every family's lock string
 * is matched verbatim at the model boundary, so editing one here would silently
 * un-lock every adapted prompt. The lock also stays WHOLE rather than being
 * replaced: hair, build and tone still bind to the reference, which remains
 * authoritative for whatever the shot does show.
 *
 * The wording is the retired scene prose builder's, kept to the byte for a
 * subject whose own reference is in the payload, because it is the only version
 * of this sentence anything measured. `preserveFrom` is what every other render
 * loses: with no image of THIS person being sent there is nothing to preserve
 * "from the reference", and saying it anyway points the model at a photograph it
 * either was never given or was given of somebody else
 * ({@link faceVisibilityAnchor}).
 *
 * Name-bound and pronoun-free: the cast is any gender, and "her face"
 * mis-genders half of it the moment this sentence meets a character the phrasing
 * was not written for. An unlabelled subject degrades to "the subject" rather
 * than to no sentence at all — the claim is mandatory by kind, and a missing
 * label is not a reason to leave a turned-away render telling the model to
 * preserve a face it cannot see.
 */
export function faceVisibilitySentence(
  visibility: ImageObscuredFace,
  subject: string | null,
  preserveFrom: "reference" | "nothing",
): string {
  const name = subject ?? "the subject";
  const seen =
    visibility === "partial"
      ? `${name}'s face is partly turned from the camera; preserve the visible features, hair color and style, build and skin tone`
      : `${name}'s face is not visible in this shot; preserve the hair color and style, build and skin tone`;
  const anchor = preserveFrom === "reference" ? " exactly from the reference" : " exactly";
  return `${seen}${anchor} — do not rotate ${name} to face the camera.`;
}
