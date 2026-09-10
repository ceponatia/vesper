import type { DiagnosticSink } from "@vesper/contracts";
import type { ImageReferenceRole } from "../capabilities/image-model-capabilities";
import {
  joinImagePromptSegments,
  reportImagePromptEmissionTrim,
  weakestOptionalImagePromptSegment,
  type ImagePromptBudget,
  type ImagePromptSegment,
} from "../render-intent/prompt-segments";
import type { SceneCaptureMode } from "../scene-ir";
import {
  imageAppearanceIndefiniteArticle,
  imageAppearancePhrase,
  imageAppearancePhraseGroupNoun,
  imageAppearancePhraseGroupTakesArticle,
  type ImageAppearancePhraseGroup,
} from "./appearance-phrase";
import type {
  ImageAngleBand,
  ImageCameraHeightBand,
  ImageDistanceBand,
  ImageFramingBand,
  ImageLightingBand,
} from "./camera-bands";
import type { ImageConceptId } from "./concepts";
import type { ImageStyleMedium } from "./conflict-keys";
import {
  angleSentence,
  capitalize,
  captureModeSentence,
  describe,
  describeChange,
  distanceSentence,
  framingSentence,
  heightSentence,
  imagePronounWords,
  label,
  lightingSentence,
  listWords,
  preservedMeanings,
  mediumSentence,
  relationSentence,
  reportUnwordableClaimValue,
  sentence,
  spatialWord,
  stagingSentenceForVoice,
  unwordableImageClaimValue,
  viewerAppearanceSentence,
  viewerGeometrySentence,
  viewerIntimateSentence,
  viewerIsEmbodied,
  type ImagePronounWords,
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
  type ImagePromptRegister,
} from "./dialects";
import type { ImagePositiveClaim } from "./positive-claims";
import {
  imageSceneCaptureMode,
  imageSceneObscuredFace,
  imageScenePossessionOwners,
  imageSceneStagingForm,
  type ImageObscuredFace,
} from "./scene-facts";
import { createSceneStagingSurfaceLog, type SceneStagingSurfaceLog } from "./scene-staging-surfaces";
import type { ImageSubjectPronounSet } from "./world-digest";

/**
 * `qwen/qwen-image-edit-2511` — the delta-first instruction-edit dialect.
 *
 * Three endpoint facts shape everything here:
 *
 * 1. **It is an EDIT model.** Its `prompt` is "Text instruction on how to edit
 *    the given image" (probed schema, drizzle/0119), its reference input is
 *    required, and it cannot generate from text alone. So the compile is
 *    delta-first, in the research doc's order: the subject bound to its numbered
 *    image, the one requested change, the limited preserve set, and any
 *    geometry/canvas permission — never a broad "preserve everything" clause,
 *    which is the wording the research blames for Qwen's squashed-figure
 *    geometry failure when it fights a requested pose or framing change.
 * 2. **Numbered references are a FAMILY behavior** (owner ruling 2026-08-24):
 *    Qwen Edit's own multi-image guidance asks callers to identify images by
 *    number and assign each an explicit purpose, so this dialect declares
 *    `numbered_images` and writes `Image N …` assignments from the final send
 *    order — never from the order a lane supplied.
 * 3. **The probed endpoint has NO negative field** (drizzle/0119: its inputs
 *    are prompt, image, aspect_ratio, seed, go_fast, lora_*, output_*,
 *    disable_safety_checker). Per the owner ruling of 2026-08-29 the dialect
 *    declares `unsupported` and every compiled exclusion drops with a recorded
 *    transport reason.
 *
 * **The family's guidance is fluent prose, and this dialect writes it (#544).**
 * Qwen's own prompt guidance for the family asks for connected sentences in the
 * order subject, appearance, clothing and hair, pose, environment — not a list.
 * One claim per sentence produced the opposite: a representative scene compiled
 * 38 sentences that named the same character 28 times, and repetition plus a
 * display name beside a reference image are both identity cues competing with
 * the photograph the endpoint was given. So this dialect RENDERS per claim (the
 * fitter still decides what a budget squeeze keeps, over the same per-claim
 * segments as before) and then EMITS in groups: the subject is bound to its
 * image once, referred to by pronoun afterwards, and described in a few grouped
 * sentences. See {@link groupOf} for the order and {@link SubjectVoice} for the
 * naming rule.
 *
 * The identity lock (owner ruling 2026-08-29): the compiled `subject.identity`
 * claim is worded here and nowhere else — the render kernel's `@vesper/image-models`
 * quirk that once rewrote a lane-side sentence into frozen bytes retired with
 * the lane prose (#251), so a prompt reaches the provider exactly as it was
 * compiled and hashed, and the lock is free to merge into the binding sentence.
 */

const DIALECT_ID = "qwen_2511_delta_edit" as const;

/**
 * The single-reference binding's PRESERVE half — what the reference image is
 * authoritative for, and nothing else.
 *
 * Hair and body proportions left the lock (#544 F4, owner decision): the
 * photograph carries the face, the skin tone and the apparent age, and the TEXT
 * is authoritative for hair, build, wardrobe and pose. The old lock claimed hair
 * and proportions and was then followed by hair colour, length, arrangement and
 * musculature stated as bare facts, with nothing to tell a reminder from an
 * override.
 *
 * A CLAUSE rather than a whole sentence, because the sentence is no longer
 * constant: it names the subject, the image number and — once a pronoun set
 * reaches the digest — a possessive. What stays fixed, and what a test or a
 * downstream reader can pin, is the preserve set itself.
 */
export const QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK = "face, skin tone and apparent age exactly as shown.";

/**
 * See {@link QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK} — same contract, the
 * multi-reference spelling, which binds each person to their OWN numbered image.
 *
 * Deliberately NOT a superstring of the single clause. The two spellings are how
 * a reader tells which binding a render chose, and a single clause contained
 * inside the multi one would make "this render did not take the multi form"
 * unassertable.
 */
export const QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK =
  "keep each person's face, skin tone and apparent age exactly as their own image shows.";

/**
 * See {@link QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK} — same contract, the
 * spelling for ONE person shown in SEVERAL images (#546).
 *
 * "exactly as shown" cannot be said of two photographs: they show the same
 * woman from different angles, and asking for exactness against both is asking
 * for a contradiction the model resolves by picking one. Consistency across the
 * set is the honest instruction, and it is what a reference sheet is for.
 *
 * Contained in neither other clause and containing neither, for the same reason
 * they do not contain each other: which binding a render chose has to stay
 * assertable from the text.
 */
export const QWEN_2511_GROUPED_REFERENCE_IDENTITY_LOCK =
  "face, skin tone and apparent age consistent with these references.";

/**
 * Retained aliases. Hair is no longer in either preserve set, so a cast member
 * whose headwear hides their hair needs no separate spelling — the lock never
 * asks for hair back. `subject.hair_concealment` still states the concealment in
 * its own sentence, which is the claim that actually keeps hair off the render.
 *
 * @deprecated Use {@link QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK}; identical bytes.
 */
export const QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED = QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK;

/**
 * @deprecated Use {@link QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK}; identical bytes.
 */
export const QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK_HAIR_CONCEALED = QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK;

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
 *
 * They still order FITTING, which is the half that matters now: emission order
 * is {@link EMISSION_ORDER}'s, applied after the budget has had its say.
 */
const DELTA_PRIORITY = {
  reference: 100.5,
  change: 100.4,
  preserve: 100.3,
  geometry: 100.2,
  literalText: 100.1,
} as const;

/**
 * The binding sentence's own priority: below the operation band, above every
 * projection claim. It matters only under a hard provider ceiling, where
 * mandatory segments compress weakest-first by whole sentences — and the
 * binding is the one sentence an edit on this endpoint cannot do without.
 */
const IDENTITY_LOCK_PRIORITY = 99;

/**
 * The binding's adaptation for a face the shot cannot show: strictly under the
 * binding's priority, so a squeeze reaches it first, and emitted immediately
 * after it in {@link writeBinding} rather than by relying on the ordering.
 */
const FACE_VISIBILITY_PRIORITY = 98.9;

// ---------------------------------------------------------------------------
// Subject voice — how this dialect names a person, and how often (#544 F2)
// ---------------------------------------------------------------------------

/**
 * One subject's names: how the binding sentence introduces them, and how every
 * later sentence refers back.
 *
 * The old rule was "never a pronoun", on the sound reasoning that a dialect
 * guessing a gender would be asserting something the digest never stated. The
 * digest now states it — `entityPronouns`, derived by the application from the
 * character's own identity facts — so the rule can become "never GUESS a
 * pronoun", which is what the repetition defect needed: a representative scene
 * named one character 28 times, and the display name is, in the
 * fictional-celebrity workflow, a real person's name sitting beside a reference
 * photograph as a competing identity cue.
 *
 * Three ways to be named, in order:
 *
 * - the display LABEL, when the application supplied one;
 * - the reference BINDING — "the woman in Image 1" — when it did not, which is
 *   the ordinary scene case, because the scene lane omits labels for
 *   reference-anchored subjects;
 * - "the subject", when there is neither.
 *
 * `pronouns` is null in three cases, and each is a pronoun that would not
 * resolve. The digest stated NO SET, so any pronoun would be a guess. The set is
 * AMBIGUOUS: two `she_her` subjects in one cast make "she" unresolvable, so both
 * keep their introductions. Or nothing INTRODUCES them — a cast member with no
 * identity image of their own is never named by the binding sentence, and "she"
 * about a person the prompt never named refers to nobody. A prompt that binds
 * the wrong body to the wrong clause is worse than a repetitive one.
 */
interface SubjectVoice {
  /** How the binding sentence names them — the introduction plus their image. */
  readonly binding: string;
  /** How a later sentence names them when no pronoun may be used. */
  readonly introduction: string;
  /**
   * How an ASSIGNMENT names them — the label, or the indefinite noun their
   * pronoun set implies ("a woman", "a man", "a person").
   *
   * Separate from {@link SubjectVoice.introduction} because an assignment is the
   * one place the introduction cannot be used: for a label-less subject the
   * introduction IS "the woman in Image 1", so "Image 1 shows the woman in
   * Image 1" defines the image by itself. The indefinite form says what the
   * picture holds without pointing back at it, and every later sentence still
   * uses the definite introduction — unambiguous exactly when it matters, since
   * two subjects sharing a pronoun set is the case where `pronouns` is null and
   * both keep their introductions.
   */
  readonly indefinite: string;
  /**
   * The display name the projection supplied, or null where it supplied none —
   * the ordinary scene case, since the lane omits labels for reference-anchored
   * subjects.
   *
   * Carried beside the four rendered spellings because a sentence sometimes has
   * to know WHICH of them it is holding: "Use the woman shown in Images 1 and 2"
   * takes no comma and "Use Wren, shown in Images 1 and 2," takes two, and only
   * the presence of a name tells them apart ({@link bindingSentence}).
   */
  readonly name: string | null;
  /**
   * The bare noun the pronoun set implies — "woman", "man", "person" — with no
   * article and no image number.
   *
   * The one naming a grouped binding needs and none of the others give: the
   * definite "the woman" for the sentence that introduces one person shown in
   * several images, and "the same woman" for a view slot the lane described in
   * no words of its own.
   */
  readonly noun: string;
  /**
   * Null when the digest stated no set, when the set is shared in this cast, or
   * when no sentence in this prompt introduces them (see {@link subjectVoices}).
   */
  readonly pronouns: ImagePronounWords | null;
}

/**
 * The label the SUBJECT PROJECTION writes for a person the application named
 * nothing — a neutral noun rather than a database id, because
 * `ImageEntityDigest.label` is a required string and a handle may never reach a
 * provider (`apps/web` `contracts/images/subject-digest.ts`).
 *
 * Recognised here because the scene lane deliberately supplies no label for a
 * reference-anchored subject (`CHARACTER_LANE_SUBJECT_NAMING.scene`, #544 F2),
 * and the projection's placeholder then arrives at this dialect as though it
 * were a name — which is how a whole scene compiled "The subject standing with
 * the subject's back against the viewer's chest" beside a numbered photograph of
 * the person it had declined to name.
 *
 * A dialect reading a placeholder is a SEAM rather than a design: the honest
 * shape is a label the projection may leave unset, and this recognises the
 * convention that projection documents until there is one.
 */
const UNNAMED_SUBJECT_LABEL = "the subject";

/** The subject's own name, or null when the projection had none to give. */
function subjectName(input: ImageDialectPositiveInput, ref: string): string | null {
  const name = label(input, ref);
  return name === null || name.toLowerCase() === UNNAMED_SUBJECT_LABEL ? null : name;
}

/** The subject pronoun, or the introduction when none may be used. */
function they(voice: SubjectVoice | null): string {
  return voice?.pronouns?.subject ?? voice?.introduction ?? "the subject";
}

/** The possessive determiner: "her", or "Wren's" when no pronoun may be used. */
function their(voice: SubjectVoice | null): string {
  const pronouns = voice?.pronouns;
  if (pronouns !== null && pronouns !== undefined) return pronouns.possessive;
  return `${voice?.introduction ?? "the subject"}'s`;
}

/** The object pronoun, or the introduction. */
function them(voice: SubjectVoice | null): string {
  return voice?.pronouns?.object ?? voice?.introduction ?? "the subject";
}

/** The independent possessive: "hers", or "Wren's". */
function theirs(voice: SubjectVoice | null): string {
  return voice?.pronouns?.independent ?? `${voice?.introduction ?? "the subject"}'s`;
}

/**
 * Verb agreement. `they_them` takes the plural form for a single person, which
 * is the one place a pronoun set changes anything but a pronoun.
 */
function agree(voice: SubjectVoice | null, singular: string, plural: string): string {
  return voice?.pronouns?.plural === true ? plural : singular;
}

/**
 * The PRIMARY identity image of this subject — their first identity slot in
 * SEND order — or null when the payload carries none (#546).
 *
 * Send order rather than array order, because a lane may hand the compile its
 * slots in any order (the reference plan is a set of numbered positions, not a
 * list) and the number this returns is the one every later sentence cites: the
 * introduction "the woman in Image 1", and the face-visibility anchor's "from
 * Image N". A reference sheet's second view of one person is a support image,
 * never the picture the prompt points at for a face.
 */
function identitySlotFor(input: ImageDialectPositiveInput, ref: string | undefined): ImageDialectReference | null {
  if (ref === undefined) return null;
  let primary: ImageDialectReference | null = null;
  for (const slot of input.references) {
    if (slot.role !== "identity" || slot.subjectRef !== ref) continue;
    if (primary === null || slot.position < primary.position) primary = slot;
  }
  return primary;
}

/**
 * Every subject this compile may name, with the pronoun ambiguity already
 * resolved.
 *
 * Built from the CLAIMS rather than from `entityPronouns` alone: a subject the
 * program states facts about must be nameable whether or not the application
 * had a pronoun set for them, and a set for somebody with no claims names
 * nobody in this prompt.
 */
function subjectVoices(input: ImageDialectPositiveInput): Map<string, SubjectVoice> {
  const refs: string[] = [];
  for (const claim of input.claims) {
    if (claim.subjectRef === undefined || !claim.concept.startsWith("subject.")) continue;
    if (!refs.includes(claim.subjectRef)) refs.push(claim.subjectRef);
  }
  for (const slot of input.references) {
    if (slot.role !== "identity" || slot.subjectRef === undefined) continue;
    if (!refs.includes(slot.subjectRef)) refs.push(slot.subjectRef);
  }
  // A set two subjects share cannot resolve a pronoun back to one of them.
  const shared = new Set<ImageSubjectPronounSet>();
  const seen = new Set<ImageSubjectPronounSet>();
  for (const ref of refs) {
    const set = input.entityPronouns?.[ref];
    if (set === undefined) continue;
    if (seen.has(set)) shared.add(set);
    seen.add(set);
  }
  const voices = new Map<string, SubjectVoice>();
  for (const ref of refs) {
    const set = input.entityPronouns?.[ref];
    const words = set === undefined ? null : imagePronounWords(set);
    const name = subjectName(input, ref);
    const slot = identitySlotFor(input, ref);
    const noun = words?.noun ?? "person";
    const introduction = name ?? (slot === null ? UNNAMED_SUBJECT_LABEL : `the ${noun} in Image ${slot.position}`);
    voices.set(ref, {
      introduction,
      indefinite: name ?? (slot === null ? UNNAMED_SUBJECT_LABEL : `${/^[aeiou]/iu.test(noun) ? "an" : "a"} ${noun}`),
      binding: name !== null && slot !== null ? `${name} in Image ${slot.position}` : introduction,
      name,
      noun,
      // A pronoun needs an INTRODUCTION to refer back to, and on this endpoint
      // the introduction is the binding sentence — which introduces exactly the
      // subjects an identity image in the payload shows. A cast member with no
      // image of their own is never introduced by any sentence, so "she" there
      // would refer to somebody the prompt has not named; they keep their
      // display name, which is the one thing that can still tell them apart.
      pronouns: set !== undefined && !shared.has(set) && slot !== null ? words : null,
    });
  }
  return voices;
}

// ---------------------------------------------------------------------------
// Per-compile state
// ---------------------------------------------------------------------------

/** Per-compile render state. Created fresh in `compilePositive`, never shared. */
interface RenderState {
  lockEmitted: boolean;
  /**
   * The claim id whose segment carries the binding sentence — how the emission
   * pass finds it again after fitting, structurally rather than by matching text
   * (the segments carry the claim id as `source`).
   */
  lockClaimId: string | null;
  readonly takenSlots: Set<number>;
  /**
   * The send slot each `operation.reference_role` claim resolved to.
   *
   * Recorded during rendering because {@link claimSlot} CONSUMES a slot, so the
   * emission pass cannot ask the same question a second time and get the same
   * answer.
   */
  readonly slots: Map<string, ImageDialectReference>;
  readonly voices: Map<string, SubjectVoice>;
  /** The one subject, when there is exactly one — who a camera or count sentence means. */
  readonly soleVoice: SubjectVoice | null;
  /** Descriptive or imperative — resolved once per compile by {@link registerFor}. */
  readonly register: ImagePromptRegister;
}

/**
 * The register this compile speaks in: what the caller asked for, or the task's
 * own default (#549).
 *
 * IMPERATIVE on the scene task, because a scene rung carries no change contract
 * — the description IS the instruction — and this endpoint's `prompt` field is
 * documented as "an edit instruction, not merely a scene description". A
 * description of a woman in a lounge, handed to an edit model beside a
 * photograph of her, can be read as a reminder about the picture it was given
 * rather than as the picture to make.
 *
 * DESCRIPTIVE everywhere else, because every other task on this endpoint states
 * its own change contract ("Make exactly this change: …"), and a prompt whose
 * instruction is already explicit does not need a second imperative voice
 * competing with it: the rest of that prompt is the unchanged context the change
 * happens to.
 */
function registerFor(input: ImageDialectPositiveInput): ImagePromptRegister {
  return input.register ?? (input.operation.task === "scene" ? "imperative" : "descriptive");
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
 * One numbered assignment for a NON-identity role, in the family's "identify
 * each image and its purpose" shape.
 *
 * Identity slots are absent by design: they are named inside the binding
 * sentence now ({@link bindingSentence}), because "Image 1 is the identity
 * reference" followed by "Image 1 shows Katelyn Nacon" was two sentences saying
 * one thing, and the display name in the second was a competing identity cue.
 *
 * Null for the structural control roles: 2511's probed schema has no structural
 * input, so a mask or depth map could only travel through the content `image`
 * array — where the model would DEPICT it rather than obey it, and a prompt
 * claiming otherwise would assert a transport this endpoint does not have. The
 * null drops the claim, and the operation kind's mandatory floor turns that into
 * a refusal before provider spend.
 */
function referenceAssignment(
  role: ImageReferenceRole,
  position: number,
  subjectLabel: string | null,
  description: string | undefined,
): string | null {
  // The slot's own qualifier, when the lane supplied one — what keeps a second
  // image of one person from reading as a second person. Appended rather than
  // substituted so an undescribed slot compiles the sentence it always did.
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

// ---------------------------------------------------------------------------
// The sentences this dialect owns
// ---------------------------------------------------------------------------

/**
 * The cast bound to their images and the preserve set (F2/F4, #546).
 *
 * What this replaced was three sentences: a lock naming a reference, a second
 * sentence assigning that reference to a named person, and a blanket "change
 * only what this instruction requests" that the scene rung then never followed
 * with a change. The preserve set is now the honest one — face, skin tone,
 * apparent age — because those are what a photograph carries; hair, build,
 * wardrobe and pose are the text's, and the old lock claiming them left every
 * later hair or build fact ambiguous between a reminder and an override.
 *
 * Three forms, chosen over the PEOPLE the identity slots show rather than over
 * the slots themselves:
 *
 * - one person, one image — one sentence, "Use the woman in Image 1 as the sole
 *   subject; keep her …";
 * - one person, several images — the images named as a set, each given its own
 *   purpose, and a preserve set asking for consistency across them;
 * - several people — the assignment list, one clause per person, and the
 *   preserve set stated once for everybody.
 *
 * The middle form is why the grouping exists (#546). A reference view enters the
 * send list as a second `identity` slot for the same character, so a woman sent
 * with her anchor and her back view compiled "Image 1 shows a woman, Image 2
 * shows a woman … keep each person's face" — two people, said twice, in the one
 * sentence whose job is to say there is one.
 *
 * A cast member the payload carries NO image of gets a sentence of their own,
 * and the anchored person's clause stops claiming the whole picture. The scene
 * ladder's single-reference rung is exactly this shape — one identity image, two
 * voices — and it used to fall to the several-people form, which promises to
 * keep "each person's face … as their own image shows" about somebody with no
 * image at all: a false identity contract, and the invitation for the one
 * reference to bleed into the person it was never taken of. So the bound person
 * is bound, the rest are said to be described in text, and the count that closes
 * the prompt still says how many people the picture holds.
 *
 * Null when the payload carries no reference at all: this endpoint's whole
 * identity transport IS the reference, and describing a face in prose instead
 * would render a stranger. The null drops a mandatory claim, which refuses the
 * compile before spend.
 */
function bindingSentence(
  input: ImageDialectPositiveInput,
  state: RenderState,
  identityAssignments: readonly ImageDialectReference[],
): string | null {
  if (input.references.length === 0) return null;
  const groups = identityGroups(identityAssignments);
  const described = textDescribedVoices(state, groups);
  // ONE person, however many images of them the payload carries. Counted over
  // the people rather than over the slots (#546): a subject sent with an anchor
  // and a reference view is one woman in two photographs, and the several-person
  // binding said "each person" about her.
  const sole = groups.length <= 1 && state.voices.size <= 1 && described.length === 0;
  const first = groups[0];
  const open = state.register === "imperative" ? "Create a new scene using" : "Use";
  // One anchored person — alone in the picture, or beside cast members the
  // payload carries no image of. The two differ in ONE phrase: what the bound
  // person is in this picture. Everything else about the clause is the same
  // sentence, because binding one person to one photograph is the same act
  // whether or not somebody else is standing next to them.
  if (first !== undefined && groups.length === 1 && (sole || described.length > 0)) {
    const role = sole
      ? "as the sole subject"
      : `as one of the ${countWord(peopleInPicture(input, state))} people in the picture`;
    const bound = boundGroupSentence(state, first, open, role);
    // Unreachable: a group exists because a slot made it. Answered rather than
    // thrown, because a compile has nothing to gain from an exception here.
    if (bound === null) return null;
    return [bound, ...described.map(unanchoredSentence)].join(" ");
  }
  // The INDEFINITE naming, never the introduction (#544). A label-less subject's
  // introduction is "the woman in Image 1", so introducing them here compiled
  // "Image 1 shows the woman in Image 1" — a sentence that defines the image by
  // itself and tells the model nothing. The indefinite form says what the
  // picture holds; every later sentence still says "the woman in Image 1", which
  // is unambiguous even where two cast members share a pronoun set — that is
  // precisely the case where pronouns are withheld and the introductions stand.
  const assignments = groups.flatMap((group) => {
    const voice = group.subjectRef === undefined ? null : (state.voices.get(group.subjectRef) ?? null);
    const named = voice?.indefinite ?? "the subject";
    const primary = group.slots[0];
    if (primary === undefined) return [];
    if (group.slots.length === 1) {
      return [`Image ${primary.position} shows ${primary.description === undefined ? named : `${named}, ${primary.description}`}`];
    }
    // One clause per PERSON, listing that person's own images (#546). The
    // absolute "with …" rather than a second finite verb, because the clause
    // already carries the lane's own comma'd description and a comma splice
    // beside it would read as a further assignment.
    const purposes = [
      `Image ${primary.position} ${their(voice)} primary identity reference`,
      ...group.slots.slice(1).map((slot) => `Image ${slot.position} ${viewPurpose(slot, voice)}`),
    ];
    return [`Images ${listWords(group.slots.map((slot) => String(slot.position)))} show ${named}, with ${listWords(purposes)}`];
  });
  // A list whose entries carry commas of their own rises to semicolons, and the
  // one-image-each case — every ensemble before reference views existed — keeps
  // the comma list it always compiled.
  const separator = groups.some((group) => group.slots.length > 1) ? "; " : ", ";
  const list = assignments.length === 0 ? "" : `: ${assignments.join(separator)}`;
  const assigned = `${open} the numbered images as assigned${list}; ${QWEN_2511_MULTI_REFERENCE_IDENTITY_LOCK}`;
  // The preserve set above is scoped by its own wording — "their own image" is
  // said of the people who have one — and the sentences after it say who does
  // not, so nothing in the paragraph promises an image the payload never carried.
  return [assigned, ...described.map(unanchoredSentence)].join(" ");
}

/**
 * ONE anchored person's clause: bound to their image, with the preserve set a
 * photograph of them can carry.
 *
 * `role` is what this person IS in the picture — the sole subject, or one of
 * several people — and it is the only thing that separates a single-subject
 * render from the anchored half of a mixed cast. Passed in rather than derived
 * because only the caller knows about the other voices.
 *
 * Null when the group somehow holds no slot, which cannot happen: a group exists
 * because a slot made it. Answered rather than thrown, per docs/resilience.md.
 */
function boundGroupSentence(
  state: RenderState,
  group: IdentityGroup,
  open: string,
  role: string,
): string | null {
  const voice = group.subjectRef === undefined ? null : (state.voices.get(group.subjectRef) ?? null);
  const primary = group.slots[0];
  if (primary === undefined) return null;
  if (group.slots.length === 1) {
    const named = voice === null ? `the subject in Image ${primary.position}` : voice.binding;
    const qualified = primary.description === undefined ? named : `${named}, ${primary.description}`;
    const keep = `keep ${their(voice)} ${QWEN_2511_SINGLE_REFERENCE_IDENTITY_LOCK}`;
    return state.register === "imperative"
      ? `${open} ${qualified} ${role}. ${capitalize(keep)}`
      : `${open} ${qualified} ${role}; ${keep}`;
  }
  // SEVERAL images of one person. The images are named as a set, then each is
  // given its own purpose — the primary is the identity reference and every
  // other one is whatever the lane said it is — and the preserve set asks for
  // consistency ACROSS them, which is the only thing that can be true of two
  // photographs at once.
  const named = voice === null ? UNNAMED_SUBJECT_LABEL : (voice.name ?? `the ${voice.noun}`);
  const images = `Images ${listWords(group.slots.map((slot) => String(slot.position)))}`;
  const shown = voice?.name === null || voice === null ? `${named} shown in ${images}` : `${named}, shown in ${images},`;
  const purposes = [
    `Image ${primary.position} is ${their(voice)} primary identity reference`,
    ...group.slots.slice(1).map((slot) => `Image ${slot.position} ${viewClause(slot, voice)}`),
  ];
  return `${open} ${shown} ${role}. ${purposes.join("; ")}. Keep ${their(voice)} ${QWEN_2511_GROUPED_REFERENCE_IDENTITY_LOCK}`;
}

/**
 * The cast members no identity slot shows — the people this prompt describes in
 * words and binds to nothing.
 *
 * Empty whenever any identity slot is UNATTRIBUTED. Such a slot shows somebody
 * and this compile cannot say who, so "X has no reference image" beside it might
 * be a lie about the very person the photograph holds; saying nothing is the
 * honest answer, and it keeps the binding this dialect compiled before the
 * unattributed case existed.
 */
function textDescribedVoices(state: RenderState, groups: readonly IdentityGroup[]): SubjectVoice[] {
  if (groups.some((group) => group.subjectRef === undefined)) return [];
  const anchored = new Set(groups.map((group) => group.subjectRef));
  const described: SubjectVoice[] = [];
  for (const [ref, voice] of state.voices) {
    if (!anchored.has(ref)) described.push(voice);
  }
  return described;
}

/**
 * One cast member the payload carries no image of, said plainly.
 *
 * The name is what tells them apart, and the naming seam guarantees one: a lane
 * withholds a display name only for a subject the payload actually shows
 * (`CHARACTER_LANE_SUBJECT_NAMING`), so an unanchored member keeps theirs. The
 * nameless fallback is for a digest that arrived without either, where "the
 * other person" is still true and still tells the model where to look for them.
 */
function unanchoredSentence(voice: SubjectVoice): string {
  return `${voice.name ?? "The other person"} has no reference image and is described below.`;
}

/**
 * How many people this instruction says the picture holds — the number the
 * closing sentence states, so the binding cannot contradict it.
 *
 * The operation's own count leads, and the voices are the floor: a digest whose
 * contract undercounts its own cast would otherwise compile "one of the one
 * people in the picture".
 */
function peopleInPicture(input: ImageDialectPositiveInput, state: RenderState): number {
  const stated = input.operation.subjectCount;
  return Number.isFinite(stated) && stated > state.voices.size ? stated : state.voices.size;
}

/**
 * A small count as a word — what a sentence takes, where the closing count
 * sentence takes a numeral ("Exactly 3 people are in the picture").
 *
 * Deliberately different: the close is an ASSERTION about a quantity and reads
 * as one, while "one of the three people in the picture" is a phrase inside a
 * sentence about a person. Beyond the list a numeral is the honest fallback; a
 * cast that large is not a case this endpoint renders.
 */
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const;

function countWord(count: number): string {
  if (!Number.isInteger(count) || count < 0) return String(count);
  return COUNT_WORDS[count] ?? String(count);
}

/** One person's identity images, primary first — the unit a binding form is chosen over. */
interface IdentityGroup {
  readonly subjectRef: string | undefined;
  readonly slots: ImageDialectReference[];
}

/**
 * The identity slots grouped by the person they show, in send order (#546).
 *
 * An UNATTRIBUTED slot is its own group and never merges with another: two
 * identity images nobody assigned to a subject are not evidence that one person
 * is in both, and the whole point of the grouping is that the prompt stops
 * counting photographs as people.
 */
function identityGroups(slots: readonly ImageDialectReference[]): IdentityGroup[] {
  const groups: IdentityGroup[] = [];
  for (const slot of [...slots].sort((left, right) => left.position - right.position)) {
    const found =
      slot.subjectRef === undefined ? undefined : groups.find((group) => group.subjectRef === slot.subjectRef);
    if (found === undefined) groups.push({ subjectRef: slot.subjectRef, slots: [slot] });
    else found.slots.push(slot);
  }
  return groups;
}

/**
 * What a NON-primary identity image is, in the lane's own words.
 *
 * The lane's `description` is the only text a view carries and is quoted
 * verbatim: the vocabulary that rendered the image is the only thing that can
 * describe it honestly, and a dialect inventing a clause from a role would be
 * guessing at an angle. With no description there is still something true to
 * say — that this is another picture of the same person — which is the whole
 * ambiguity a second identity image creates.
 */
function viewPurpose(slot: ImageDialectReference, voice: SubjectVoice | null): string {
  return slot.description ?? `another reference image of the same ${voice?.noun ?? "person"}`;
}

/**
 * The same purpose as a FINITE clause about the image — what the grouped
 * binding's assignment list says.
 *
 * "Image 2 is seen from behind, the same person." makes the IMAGE the thing
 * seen from behind, which is a sentence about a photograph rather than about
 * the woman in it; the model is being told where to look for her back, and the
 * clause has to name her. So the image SHOWS her, and the lane's own
 * description follows verbatim — the vocabulary that rendered the view is still
 * the only thing that can describe it honestly, and nothing here paraphrases it.
 *
 * With no description the subject drops back out of the clause: the fallback
 * says the image is another reference of the same person, which is a fact about
 * the picture and takes "is".
 */
function viewClause(slot: ImageDialectReference, voice: SubjectVoice | null): string {
  return slot.description === undefined
    ? `is ${viewPurpose(slot, voice)}`
    : `shows ${them(voice)} ${slot.description}`;
}

/**
 * The binding's adaptation for a shot whose subject's face is turned or hidden.
 *
 * The binding and the camera pull against each other, and the binding wins by
 * default: the cheapest way for a model to prove it preserved a face is to show
 * that face, so "keep her face exactly as shown" quietly rotates a character the
 * shot just put back-to-camera. Adapting means naming what to keep when the face
 * is not the evidence, and saying outright that the turn is not on the table.
 *
 * The anchor is per SUBJECT, not per payload — a numbered render can carry
 * Ilsa's identity image and none of Nyx's, and "from Image 2" would then aim
 * Nyx's preservation set at a photograph of Ilsa. With no image of this person
 * in the payload the clause simply drops its "from Image N".
 */
function faceVisibilitySentence(
  visibility: ImageObscuredFace,
  voice: SubjectVoice | null,
  slot: ImageDialectReference | null,
): string {
  const from = slot === null ? "" : ` from Image ${slot.position}`;
  const opening =
    visibility === "partial"
      ? `${capitalize(their(voice))} face is partly turned from the camera; keep the visible features and skin tone exactly${from}`
      : `${capitalize(their(voice))} face is not visible in this shot; keep ${their(voice)} build and skin tone exactly${from}`;
  return `${opening} and do not rotate ${them(voice)} to face the camera.`;
}

/**
 * Who is holding the camera, and therefore where the frame is standing.
 *
 * The disembodied first person is this dialect's own (#544 F3) and the rest are
 * the family's. "First-person POV through the viewer's own eyes; the viewer is
 * never visible in the image" put a PERSON in the room and then forbade drawing
 * them — a noun the model has to resolve, in a prompt whose composer was
 * separately writing "her attention fixed on the viewer across the room". The
 * replacement names the camera and nothing else: there is no viewer to leave out
 * of the frame, so there is no second body to compose.
 *
 * The embodied and selfie forms keep the family's measured wording. They are
 * different, separately measured cases: an embodied frame really does hold the
 * camera-holder's own limbs, and the possessive binding is the half that was
 * proven.
 */
function captureSentence(mode: SceneCaptureMode, subject: string | null): string {
  return mode === "first_person_disembodied"
    ? "Seen from the camera's own eye-level point of view."
    : captureModeSentence(mode, subject);
}

/**
 * The person count, as the sentence that CLOSES the instruction (#544 F3/D10).
 *
 * It sat third in the compiled prompt, thirty sentences before the end, which is
 * the one place a "nobody else is here" assertion cannot do its job. Stated last
 * it is the reader's final instruction, and the added clause is the positive
 * form of the failure it exists to prevent: an empty foreground rather than the
 * phantom second body a POV frame invites.
 *
 * `embodied` is a property of the SHOT rather than of the count, so it arrives
 * as a parameter — `operation.subject_count` has no idea whose eyes the frame is
 * through. The word "fully" is the retired prose builder's and is kept: on an
 * embodied frame the cast are the bodies the frame holds whole, and the
 * camera-holder's cropped forearm is not one of them.
 */
function closingSentence(count: number, embodied: boolean, voice: SubjectVoice | null): string {
  if (!Number.isFinite(count) || count <= 0) return "No people are present anywhere in the frame.";
  if (count === 1) {
    // No voice means no cast member this prompt can point at — an item render,
    // or a subject the projection never named. The impersonal form still makes
    // the assertion; it simply has nobody to make it about.
    if (voice === null) {
      return embodied
        ? "Exactly one person is fully in frame."
        : "Exactly one person is in the picture and nobody else; the foreground is clear.";
    }
    const who = capitalize(they(voice));
    const is = agree(voice, "is", "are");
    return embodied
      ? `${who} ${is} the only person fully in frame.`
      : `${who} ${is} the only person in the picture; the foreground is clear.`;
  }
  return embodied
    ? `Exactly ${count} people are fully in frame.`
    : `Exactly ${count} people are in the picture and nobody else; the foreground is clear.`;
}

/**
 * "Every visible body part is hers." — the total-possession binding.
 *
 * **Deliberately ABSTRACT, and it must stay that way.** The first draft of this
 * clause enumerated the limbs and the A/B run painted a phantom viewer hand
 * anyway: a limb noun summons a limb even when it is possessively bound. The
 * abstraction is the half doing the work. What changes here is only WHO it binds
 * to — a pronoun set makes the independent possessive available, which is the
 * shortest form of the same binding.
 *
 * No owner this prompt can name means no clause at all: silence beats a
 * possession sentence that binds nothing.
 */
function possessionSentence(
  input: ImageDialectPositiveInput,
  state: RenderState,
  value: unknown,
): string | null {
  const refs = imageScenePossessionOwners(value);
  const only = refs.length === 1 ? refs[0] : undefined;
  const sole = only === undefined ? null : (state.voices.get(only) ?? null);
  if (sole !== null && sole.pronouns !== null) return `Every visible body part is ${theirs(sole)}.`;
  const owners: string[] = [];
  for (const ref of refs) {
    // A voiceless owner falls back to their NAME and not to the projection's
    // neutral placeholder: "every visible body part belongs to the subject"
    // binds nothing, and silence is what this clause does with nothing to bind.
    const named = state.voices.get(ref)?.introduction ?? subjectName(input, ref);
    if (named !== null && !owners.includes(named)) owners.push(named);
  }
  if (owners.length === 0) return null;
  return `Every visible body part belongs to ${listWords(owners, "or")}.`;
}

/**
 * The rendering medium as an INSTRUCTION (#549).
 *
 * Stated rather than transformed, for the same reason {@link BAND_FRAMES} states
 * both spellings: "Rendered as a photograph" and "Render it as a photograph" are
 * one fact said to two readers, and a rule that turned one into the other would
 * be a grammar engine nobody asked for. The shared `mediumSentence` keeps the
 * measured descriptive wording for every other family.
 *
 * `unspecified` words nothing, which the claim selector already guarantees never
 * happens — the claim is only built for a known medium. Answering it honestly
 * keeps the switch total.
 */
function imperativeMediumSentence(medium: ImageStyleMedium): string {
  switch (medium) {
    case "photographic":
      return "Render it as a photograph, with real optics and natural surface detail.";
    case "illustration":
      return "Render it as an illustration.";
    case "anime":
      return "Render it in an anime style.";
    case "painting":
      return "Render it as a painting, with visible brushwork.";
    case "render_3d":
      return "Render it as a 3D render.";
    case "unspecified":
      return "";
  }
}

/**
 * A registry label/value descriptor, folded into a list mid-sentence.
 *
 * Only the leading character, and only when the word is sentence-cased rather
 * than an acronym or a proper noun in caps: these are registry labels ("Hair
 * color: dark brown"), and their capital is a rendering convention rather than
 * part of the value.
 */
function lowerLead(text: string): string {
  const first = text[0];
  const second = text[1];
  if (first === undefined || first !== first.toUpperCase()) return text;
  if (second !== undefined && second === second.toUpperCase() && second !== second.toLowerCase()) return text;
  return `${first.toLowerCase()}${text.slice(1)}`;
}

/**
 * The semantic tag the character adapter puts on the appearance fact projected
 * from the character's stated gender — the same attribute the pronoun set is
 * derived from. A tag rather than a concept: the concept is `subject.appearance`
 * like every other sheet value, and only the tag says which one this is.
 */
const GENDER_ATTRIBUTE_TAG = "attribute:identity.gender";

/**
 * Whether a fact describes hair — the locus a projection files hair facts under.
 *
 * Both spellings a projection can produce. The character adapter files a
 * registry appearance attribute under its bare body-location id (`hair`), while
 * a visual-state fact carries `visualStateLocusKey`'s rendering of its locus,
 * which for a body locus is `bodyLocationId[:side][:detail]` — so a hair
 * presentation arrives as `hair` and a sided one would arrive as `hair:left`.
 * Accepting only the bare id would file a sided hair fact in the build list.
 */
function isHairLocus(claim: ImagePositiveClaim): boolean {
  return typeof claim.locus === "string" && /^hair(?:$|[\s.:_-])/iu.test(claim.locus);
}

/**
 * A current-state value the character adapter wrote as a TRAILING CLAUSE.
 *
 * The adapter renders every garment- and part-scoped reading as a fragment that
 * names its own garment or part — "with the sweater tucked in", "with the hair
 * worn loose", "with a bindi" (#544 F1) — because an unbound "tucked in" would
 * describe the person rather than the cloth. Wrapped in this dialect's ordinary
 * subject frame those compile "She is with the sweater tucked in", so a value
 * that opens with `with ` joins the sentence it qualifies instead of getting one.
 *
 * Detected from the VALUE rather than from the kind, because the kind is the
 * application's vocabulary and this layer has none of it — and because the same
 * kind renders both shapes: wetness at a body part says "damp at the hair",
 * which is a predicate and keeps the "She is …" frame.
 */
function isTrailingClause(claim: ImagePositiveClaim): boolean {
  return /^with\s/iu.test(describe(claim.value).trim());
}

/** "… , with the sweater tucked in and with a bindi" — the tail a band appends. */
function trailingClause(parts: readonly string[]): string {
  return parts.length === 0 ? "" : `, ${listWords(parts)}`;
}

/**
 * A phrase as a WORD-BOUNDED pattern — "is this phrase actually said here",
 * rather than "do these letters occur".
 *
 * The escape covers exactly the regex syntax characters, and no more: under the
 * `u` flag an escape of an ordinary character (`\-`) is a syntax error, so the
 * usual belt-and-braces escape list would turn a hyphenated posture into a
 * thrown `SyntaxError` on schema-legal input.
 */
function wordPattern(phrase: string): RegExp {
  return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu");
}

// ---------------------------------------------------------------------------
// Rendering — one claim, one segment, exactly as before fitting
// ---------------------------------------------------------------------------

/**
 * How this endpoint says one claim.
 *
 * An exhaustive switch over the concept registry, so a new concept is a COMPILE
 * ERROR here rather than a claim that quietly never reaches a prompt.
 *
 * Still one segment per claim, deliberately: the fitter decides what a budget
 * squeeze keeps over exactly the units it always did, and the grouped emission
 * ({@link groupedSegments}) runs afterwards over the survivors. A claim whose
 * group rewrites it — a wardrobe list, a build sentence, a pose — renders here
 * anyway, because its length is what the budget is spent on.
 */
function renderClaim(
  claim: ImagePositiveClaim,
  input: ImageDialectPositiveInput,
  state: RenderState,
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
  // A record no renderer understands words NOTHING (#544 D1). Declining it here
  // rather than interpolating a blank is what makes the drop visible: `"<subject>
  // is "` is not an empty segment, so a mutilated clause would have travelled in
  // place of the flattened structure this replaced. The shared compile step
  // records the claim as dropped, and a mandatory one refuses before spend.
  if (unwordableImageClaimValue(claim.value)) {
    reportUnwordableClaimValue(claim, input.sink);
    return null;
  }
  const value = describe(claim.value);
  const subject = label(input, claim.subjectRef);
  const object = label(input, claim.objectRef);
  const voice = claim.subjectRef === undefined ? null : (state.voices.get(claim.subjectRef) ?? null);
  /** A relation's subject end: the cast member's own pronoun, or a non-person's label. */
  const end = voice === null ? subject : they(voice);
  /** "<She> <verb> …" — the ordinary subject-scoped clause. */
  const of = (singular: string, plural: string, predicate: string): string =>
    `${capitalize(they(voice))} ${agree(voice, singular, plural)} ${predicate}.`;

  switch (claim.concept) {
    // --- Operation: the delta, in the research doc's order --------------------
    case "operation.change":
      // "One clear requested change" — the instruction this edit IS.
      return say(`Make exactly this change: ${describeChange(claim.value)}.`, DELTA_PRIORITY.change);
    case "operation.preserve": {
      // The LIMITED preserve set, named fact by fact. Deliberately no
      // "everything else stays" preamble: a blanket preserve fighting the
      // requested change is the documented squashed-figure failure.
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
      return say(closingSentence(Number(claim.value), viewerIsEmbodied(input), state.soleVoice));
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
      state.slots.set(claim.id, slot);
      // An identity slot names a PERSON, and how this dialect names one is the
      // voice's ({@link SubjectVoice.indefinite}) — the label where there is one,
      // "a woman" where there is not, never the introduction, which would compile
      // "Image 1 shows the woman in Image 1". Every other role names a place or a
      // thing, whose label is the only name it has. This sentence is normally
      // ABSORBED into the binding; it is written only where the program stated no
      // identity claim for the slot to be merged into.
      const named = slot.role === "identity" ? (voice?.indefinite ?? subject) : subject;
      const assignment = referenceAssignment(slot.role, slot.position, named, slot.description);
      return assignment === null ? null : say(assignment, DELTA_PRIORITY.reference);
    }

    // --- Scene ----------------------------------------------------------------
    case "scene.mood":
      // ATMOSPHERE rather than mood (#550). "Mood" reads as a person's mood
      // beside a subject the prompt has just described, and this claim is the
      // room's: the composer's own label for how the scene FEELS, which a model
      // spends on light, colour and distance rather than on a face.
      return say(
        state.register === "imperative" ? `Keep the atmosphere ${value}.` : `The atmosphere is ${value}.`,
      );
    case "scene.capture_mode": {
      const mode = imageSceneCaptureMode(claim.value);
      // Only the selfie form names anybody, and it names the person whose arm the
      // camera is on — through the voice, so a scene lane that withheld the
      // display name gets "a phone selfie the woman in Image 1 is taking" rather
      // than one "the subject" is.
      return mode === null ? null : say(captureSentence(mode, voice?.introduction ?? subject));
    }
    case "scene.possession":
      return sayOrNull(possessionSentence(input, state, claim.value));
    case "scene.staging": {
      const form = imageSceneStagingForm(claim.value);
      if (form === null) return null;
      // ADOPTS the registry's wording, and this is the endpoint with the strongest
      // claim on it: the intimate scene route renders on 2511, and the templates
      // were tuned against exactly those renders on the Qwen edit family. The
      // measured residue is model behavior rather than scene meaning, so no typed
      // semantics could regenerate it and a rival sentence here would throw away
      // the only evidence there is.
      //
      // What is bound to `{name}` is this dialect's decision, and it is the VOICE
      // rather than the label: the scene lane offers a reference-anchored subject
      // no display name, so binding the label compiled "The subject standing with
      // the subject's back against the viewer's chest" on every intimate
      // arrangement. The template's own words are untouched either way —
      // `stagingSentenceForVoice` substitutes and nothing else — so the adopted
      // bytes are still the measured ones.
      return sayOrNull(
        stagingSentenceForVoice(
          surfaces.adopt(claim.id, form),
          voice?.introduction ?? subject ?? "the subject",
          voice?.pronouns ?? null,
        ),
      );
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
      // The identity travels in the reference, so the identity claim compiles to
      // the binding sentence — emitted once however many subjects the render
      // carries, and merged with the identity slots' own assignments.
      if (!state.lockEmitted) {
        // Every reference claim has already resolved its slot: `operation.*`
        // claims sit in the `operation` segment kind and this one in `identity`,
        // and the canonical claim order runs kinds in that sequence.
        const identitySlots = [...state.slots.values()].filter((slot) => slot.role === "identity");
        const binding = bindingSentence(input, state, identitySlots);
        if (binding === null) return null;
        state.lockEmitted = true;
        state.lockClaimId = claim.id;
        return say(binding, IDENTITY_LOCK_PRIORITY);
      }
      // Further subjects: the multi binding already covers "each person", so
      // their identity claims carry whatever the projection stated about them.
      return say(
        voice === null ? `${capitalize(value)}.` : `${capitalize(they(voice))}: ${value}.`,
        IDENTITY_LOCK_PRIORITY,
      );
    }
    case "subject.face_visibility": {
      const visibility = imageSceneObscuredFace(claim.value);
      if (visibility === null) return null;
      return say(
        faceVisibilitySentence(visibility, voice, identitySlotFor(input, claim.subjectRef)),
        FACE_VISIBILITY_PRIORITY,
      );
    }
    case "subject.apparent_age":
      // Text-authoritative by owner ruling: age text must correct an
      // age-ambiguous reference rather than inherit drift from it.
      return say(of("appears", "appear", value));
    case "subject.morphology":
      return say(of("has", "have", value));
    case "subject.absence":
      return say(of("has", "have", `${value}, shown plainly and anatomically correctly`));
    case "subject.appearance":
    case "subject.intimate_anatomy":
      return say(of("has", "have", value));
    case "subject.pose":
      return say(of("is", "are", value));
    case "subject.activity":
      // Same clause shape as a pose. The pose/activity split is a distinction in
      // the world rather than in English — different composer fields, different
      // provenance — and a dialect that invented a lexical difference would be
      // asserting something the value does not carry.
      return say(of("is", "are", value));
    case "subject.expression":
      return say(of("wears", "wear", `a ${value} expression`));
    case "subject.body_language":
    case "subject.current_state":
      return say(of("is", "are", value));
    case "subject.wardrobe":
      return say(of("wears", "wear", value));
    case "subject.hair_concealment":
      // The shared families' meaning, worded through this dialect's voice: the
      // possessive is the subject's own, which is their name where they have one
      // — byte-identical to `hairConcealmentSentence` there — and their pronoun
      // where the scene lane withheld it, instead of "the subject's hair is fully
      // covered" beside a prompt that otherwise says "she".
      //
      // It is the sentence that keeps hair off a render whose reference shows it,
      // and this dialect's binding no longer preserves hair at all — so nothing
      // here has to be adapted for a covered head.
      return say(`${capitalize(their(voice))} hair is fully covered by the headwear; no hair is visible.`);
    case "subject.exposure":
      return say(of("is", "are", value));

    // --- Camera ---------------------------------------------------------------
    case "camera.framing":
      return say(framingSentence(claim.value as ImageFramingBand));
    case "camera.distance":
      return say(distanceSentence(claim.value as ImageDistanceBand));
    case "camera.angle":
      // A camera fact carries no subject ref, so the person it is about is the
      // one this render has. With a cast, the band is stated without a pronoun
      // it could not resolve.
      return say(angleSentence(claim.value as ImageAngleBand, state.soleVoice === null ? null : they(state.soleVoice)));
    case "camera.height":
      return say(heightSentence(claim.value as ImageCameraHeightBand));
    case "camera.motion":
      // A still camera has nothing to say; saying it anyway spends budget on a
      // sentence that describes the absence of an effect.
      return value === "still" ? null : say(`Motion blur from ${value} movement.`);
    case "camera.lighting":
      return say(lightingSentence(claim.value as ImageLightingBand));

    // --- Relations ------------------------------------------------------------
    // Every relation band emits after the binding, so a relation whose subject is
    // a CAST MEMBER refers to them the way the rest of the prompt does — by
    // pronoun, or by the introduction where no pronoun may be used. `end` falls
    // back to the label for the ends that are not people: an item, a garment, a
    // place, none of which has a voice.
    //
    // The verb AGREES with that end for the same reason every subject clause
    // does: `they_them` takes the plural form for a single person, so a verb
    // stated in the singular compiled "They holds the cup" and "They is in
    // contact with …" for exactly the subjects whose pronoun set this dialect
    // now knows. A non-person end has no voice and `agree` gives it the
    // singular, which is what an item, a garment or a place takes.
    case "relation.wears":
      return relationSentence(say, end, agree(voice, "wears", "wear"), object);
    case "relation.holds":
      return relationSentence(say, end, agree(voice, "holds", "hold"), object);
    case "relation.contains":
      return relationSentence(say, end, agree(voice, "contains", "contain"), object);
    case "relation.attached_to":
      return relationSentence(say, end, agree(voice, "is attached to", "are attached to"), object);
    case "relation.located_at":
      return relationSentence(say, end, agree(voice, "is at", "are at"), object);
    case "relation.placement":
      return relationSentence(say, end, `${agree(voice, "is", "are")} ${spatialWord(value)}`, object);
    case "relation.contact":
      return relationSentence(say, end, agree(voice, "is in contact with", "are in contact with"), object);
    case "relation.acts_on":
      return relationSentence(say, end, agree(voice, "acts on", "act on"), object);

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
      return say(state.register === "imperative" ? `Light the scene with ${value}.` : `Lit by ${value}.`);
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
      return say(
        state.register === "imperative"
          ? imperativeMediumSentence(claim.value as ImageStyleMedium)
          : mediumSentence(claim.value as ImageStyleMedium),
      );
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

// ---------------------------------------------------------------------------
// Grouped emission (#544 F10) — what the provider actually reads
// ---------------------------------------------------------------------------

/**
 * The bands this dialect emits in, in order.
 *
 * Reading order for an EDIT instruction: who the subject is and which image
 * carries them, what is being changed, what they look like, what they are
 * wearing, what they are doing, where the camera is, where they are, how it
 * should be rendered, and — last, where a "nobody else" assertion can do its job
 * — how many people the picture holds.
 */
const EMISSION_ORDER = [
  "binding",
  "change",
  "build",
  "wardrobe",
  "exposure",
  "pose",
  "capture",
  "setting",
  "mood",
  "style",
  "close",
] as const;
type EmissionGroup = (typeof EMISSION_ORDER)[number];

/**
 * Which band a concept is said in.
 *
 * Exhaustive over the concept registry for the same reason `renderClaim` is: a
 * new concept must be PLACED deliberately rather than landing wherever its
 * segment kind happened to sort it. The two are different questions — a kind
 * says what a piece of prompt text is, a band says which sentence of this
 * endpoint's instruction it belongs to — which is why an item's identity is
 * `identity` by kind and setting by band.
 */
function groupOf(concept: ImageConceptId): EmissionGroup {
  switch (concept) {
    case "operation.reference_role":
    case "subject.identity":
    case "subject.face_visibility":
      return "binding";
    case "operation.change":
    case "operation.preserve":
    case "operation.geometry":
    case "operation.literal_text":
    case "raw.text":
      return "change";
    case "subject.apparent_age":
    case "subject.morphology":
    case "subject.absence":
    case "subject.appearance":
      return "build";
    case "subject.wardrobe":
    case "subject.current_state":
    case "subject.hair_concealment":
    case "relation.wears":
      return "wardrobe";
    case "subject.exposure":
    case "subject.intimate_anatomy":
      return "exposure";
    case "subject.pose":
    case "subject.activity":
    case "subject.expression":
    case "subject.body_language":
    case "scene.possession":
    case "scene.staging":
    case "relation.holds":
    case "relation.contact":
    case "relation.acts_on":
      return "pose";
    case "scene.capture_mode":
    case "camera.framing":
    case "camera.distance":
    case "camera.angle":
    case "camera.height":
    case "camera.motion":
    case "viewer.body_geometry":
    case "viewer.appearance":
    case "viewer.intimate_anatomy":
      return "capture";
    case "camera.lighting":
    case "relation.contains":
    case "relation.attached_to":
    case "relation.located_at":
    case "relation.placement":
    case "item.identity":
    case "item.form":
    case "item.material":
    case "item.color":
    case "item.part":
    case "item.marking":
    case "item.condition":
    case "item.contents":
    case "item.configuration":
    case "item.presentation":
    case "location.identity":
    case "location.kind":
    case "location.geometry":
    case "location.presentation":
    case "location.contents":
    case "location.signage":
    case "location.lighting":
    case "location.occupancy":
      return "setting";
    case "scene.mood":
    case "location.weather":
    case "location.time":
    case "location.condition":
    case "location.atmosphere":
      return "mood";
    case "style.medium":
    case "style.descriptor":
    case "style.quality":
      return "style";
    case "operation.subject_count":
      return "close";
  }
}

/**
 * Which band THIS claim is said in — {@link groupOf} plus the one exception a
 * concept id cannot express.
 *
 * A hairstyle and a garment's tuck are the same concept (`subject.current_state`)
 * and belong in different sentences: the hairstyle qualifies the head the build
 * band just described, the tuck qualifies the garment list. The concept says
 * neither; the claim's LOCUS and the shape of its value say both. Kept as a
 * wrapper rather than folded into `groupOf` so that switch stays exhaustive over
 * the concept registry — a new concept is still a compile error there — and so
 * the exception is one readable rule instead of a special case inside a
 * 60-branch switch.
 */
function groupOfClaim(claim: ImagePositiveClaim): EmissionGroup {
  if (claim.concept === "subject.current_state" && isHairLocus(claim) && isTrailingClause(claim)) return "build";
  return groupOf(claim.concept);
}

/** One emitted sentence and the claims it speaks for. */
interface GroupSentence {
  readonly text: string;
  readonly claims: readonly ImagePositiveClaim[];
}

/**
 * What every band writer may read: the per-compile state (voices, resolved
 * slots, which claim carries the binding) and each surviving claim's own
 * rendered sentence. Deliberately not the whole dialect input — a writer that
 * could reach the claim list again could emit a claim the budget removed.
 */
interface EmitContext {
  readonly state: RenderState;
  /** The fitted segment each surviving claim rendered, by claim id. */
  readonly rendered: ReadonlyMap<string, ImagePromptSegment>;
}

/** One claim as the sentence it already rendered — fitting's own text, compression included. */
function asRendered(context: EmitContext, claim: ImagePositiveClaim): GroupSentence | null {
  const segment = context.rendered.get(claim.id);
  return segment === undefined ? null : { text: segment.text, claims: [claim] };
}

/** Claims of one concept, in the order the program stated them. */
function withConcept(claims: readonly ImagePositiveClaim[], ...concepts: ImageConceptId[]): ImagePositiveClaim[] {
  return claims.filter((claim) => concepts.includes(claim.concept));
}

/** The claim values of one concept, as list entries. */
function valuesOf(claims: readonly ImagePositiveClaim[]): string[] {
  return claims.map((claim) => lowerLead(describe(claim.value))).filter((entry) => entry.length > 0);
}

/** The subjects a band speaks about, in first-stated order — an ensemble keeps its people apart. */
function bySubject(claims: readonly ImagePositiveClaim[]): { ref: string | undefined; claims: ImagePositiveClaim[] }[] {
  const groups: { ref: string | undefined; claims: ImagePositiveClaim[] }[] = [];
  for (const claim of claims) {
    const found = groups.find((group) => group.ref === claim.subjectRef);
    if (found === undefined) groups.push({ ref: claim.subjectRef, claims: [claim] });
    else found.claims.push(claim);
  }
  return groups;
}

/** The voice for a band's subject group. */
function voiceOf(context: EmitContext, ref: string | undefined): SubjectVoice | null {
  return ref === undefined ? null : (context.state.voices.get(ref) ?? null);
}

/**
 * The two spellings of one merged band's frame (#549).
 *
 * A band is not a verb: "wears" and "Dress … in" are the same band said to two
 * different readers, and the expression band takes "wears" in the descriptive
 * voice and "Give" in the imperative one — nothing derivable from the other
 * half. So the pairs are stated, once, rather than transformed.
 *
 * The imperative binds to the OBJECT pronoun ("Dress her in …"), which is what
 * an instruction about a person takes, and falls back to the introduction where
 * no pronoun may be used, exactly as the descriptive frame does.
 */
const BAND_FRAMES = {
  /** What the body is: "She has a slim build." / "Give her a slim build." */
  build: { singular: "has", plural: "have", imperative: "Give", preposition: "" },
  /** The garment list: "She wears …" / "Dress her in …" */
  garments: { singular: "wears", plural: "wear", imperative: "Dress", preposition: "in " },
  /** A state or an action: "She is …" / "Show her …" */
  state: { singular: "is", plural: "are", imperative: "Show", preposition: "" },
  /** A homeless trailing clause: "She is seen with …" / "Show her with …" */
  seen: { singular: "is seen", plural: "are seen", imperative: "Show", preposition: "" },
  /** The face: "She wears a wary expression." / "Give her a wary expression." */
  expression: { singular: "wears", plural: "wear", imperative: "Give", preposition: "" },
} as const;
type BandFrame = keyof typeof BAND_FRAMES;

/** "<She> <verb> a, b and c." / "<Verb> her a, b and c." — one merged band's sentence. */
function bandSentence(
  register: ImagePromptRegister,
  voice: SubjectVoice | null,
  frame: BandFrame,
  body: string,
): string {
  const form = BAND_FRAMES[frame];
  if (register === "imperative") return sentence(`${form.imperative} ${them(voice)} ${form.preposition}${body}.`);
  return sentence(`${capitalize(they(voice))} ${agree(voice, form.singular, form.plural)} ${body}.`);
}

/**
 * The binding band: one sentence naming the subject and their image, the
 * adaptation for a face the shot cannot show, and the non-identity slots.
 *
 * The identity slots' own assignment claims are ABSORBED — the binding sentence
 * is where they are stated — and they still carry their own segment through
 * fitting, so a slot the payload lost still refuses the compile.
 */
function writeBinding(claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] {
  const sentences: GroupSentence[] = [];
  const references = withConcept(claims, "operation.reference_role");
  const identityRefs = references.filter((claim) => context.state.slots.get(claim.id)?.role === "identity");
  const lock = claims.find((claim) => claim.id === context.state.lockClaimId);
  const bound = lock === undefined ? null : asRendered(context, lock);
  // Every other subject's identity claim is ABSORBED as well: the multi
  // binding already introduces each person by their own image, and "They: the
  // same person shown in the reference image." beside it would be a second,
  // worse sentence about a payload of two images. The claim still rendered its
  // own segment for fitting; only its text is discarded here.
  const furtherIdentity = withConcept(claims, "subject.identity").filter(
    (claim) => claim.id !== context.state.lockClaimId,
  );
  if (lock !== undefined && bound !== null) {
    sentences.push({ text: bound.text, claims: [lock, ...identityRefs, ...furtherIdentity] });
  } else {
    // No binding sentence — an identity claim this program never stated. The
    // slots then speak for themselves rather than going unmentioned.
    for (const claim of identityRefs) {
      const rendered = asRendered(context, claim);
      if (rendered !== null) sentences.push(rendered);
    }
  }
  for (const claim of withConcept(claims, "subject.face_visibility")) {
    const rendered = asRendered(context, claim);
    if (rendered !== null) sentences.push(rendered);
  }
  if (lock === undefined || bound === null) {
    for (const claim of furtherIdentity) {
      const rendered = asRendered(context, claim);
      if (rendered !== null) sentences.push(rendered);
    }
  }
  for (const claim of references) {
    if (identityRefs.includes(claim)) continue;
    const rendered = asRendered(context, claim);
    if (rendered !== null) sentences.push(rendered);
  }
  return sentences;
}

/**
 * The order one sentence about a body states its features in (#547).
 *
 * Whole-figure first, then the head from the outside in — the order a person is
 * taken in, and the order the issue's acceptance sentence is written in. Stated
 * rather than derived from claim order, because claim order is the projection's
 * (alphabetical by attribute id, then priority) and would put an eye colour
 * before a build for no reason a reader could see.
 *
 * `other` is deliberately absent: it has no group noun, so its members have no
 * shared clause to join and are listed standalone ({@link composeAppearance}).
 */
const APPEARANCE_CLAUSE_ORDER = [
  "build",
  "hair",
  "face",
  "skin",
  "eyes",
] as const satisfies readonly ImageAppearancePhraseGroup[];

/** One fragment, and where the registry placed it among its group's pieces. */
interface AppearancePiece {
  readonly fragment: string;
  readonly order: number;
}

/** One group's pieces, kept apart by the role each plays in its clause. */
interface AppearanceGroupPieces {
  readonly adjectives: AppearancePiece[];
  readonly withs: AppearancePiece[];
  readonly trailers: AppearancePiece[];
}

/**
 * One role's fragments in the order the clause states them.
 *
 * Ascending by the position the registry declared, ties keeping the order the
 * claims arrived in — `Array.prototype.sort` is stable, so an undeclared
 * position falls back to the projection's own order rather than to an arbitrary
 * one. The positions are the registry's because they are a property of the
 * WORDS: "healthy dark-brown hair" and "a slim, lightly toned build" are the
 * English orders, and nothing about a claim says so.
 */
function orderedFragments(pieces: readonly AppearancePiece[]): string[] {
  return [...pieces].sort((left, right) => left.order - right.order).map((piece) => piece.fragment);
}

/**
 * One feature group as a clause: `[article ]<adjectives> <noun> <trailers> with
 * <with-phrases>`.
 *
 * The adjective join is the group's, and it is grammar rather than taste. A
 * build's adjectives are COORDINATE — "slim" and "lightly toned" each modify the
 * build independently, and English separates those with commas ("a slim, lightly
 * toned build"). Hair, skin and eye adjectives are CUMULATIVE: each modifies the
 * phrase to its right, so they stack unpunctuated ("healthy dark-brown hair"),
 * and a comma there would read as a list of two different heads of hair.
 *
 * A group with `with`-phrases and no noun-bearing piece states them alone: "a
 * build with slender arms" says nothing the arms did not, and the article would
 * be asserting a build nobody described.
 *
 * Within each role the pieces are the registry's own order
 * ({@link orderedFragments}), not the claim order: English puts a colour against
 * its noun and a length after an arrangement, and the projection's alphabetical
 * claim order knows neither.
 */
function appearanceClause(group: ImageAppearancePhraseGroup, pieces: AppearanceGroupPieces): string {
  const noun = imageAppearancePhraseGroupNoun(group);
  if (noun === null) return "";
  const adjectives = orderedFragments(pieces.adjectives);
  const trailers = orderedFragments(pieces.trailers);
  const withs = orderedFragments(pieces.withs);
  if (adjectives.length === 0 && trailers.length === 0) return listWords(withs);
  const join = group === "build" || group === "face" ? ", " : " ";
  const stem = adjectives.length === 0 ? noun : `${adjectives.join(join)} ${noun}`;
  const headed = imageAppearancePhraseGroupTakesArticle(group)
    ? `${imageAppearanceIndefiniteArticle(stem)} ${stem}`
    : stem;
  const body = [headed, ...trailers].join(" ");
  return withs.length === 0 ? body : `${body} with ${listWords(withs)}`;
}

/**
 * The clause list — an Oxford comma wherever a bare "and" would be read as part
 * of the clause before it.
 *
 * A clause may carry conjunctions of its own ("a slim build with slender arms
 * and a subtle waist"), and joining two of those with nothing but "and" hands
 * the reader "slender arms and dark-brown hair" as one list of things the build
 * has. The serial comma is what closes the first clause before the next one
 * opens. Two clauses that contain no conjunction take the ordinary "and",
 * because a comma there would be punctuation with nothing to disambiguate.
 */
function appearanceList(parts: readonly string[]): string {
  const clean = parts.filter((part) => part.length > 0);
  if (clean.length <= 1) return clean[0] ?? "";
  const conjoined = clean.some((part) => /\s(?:and|with)\s/u.test(part));
  if (clean.length === 2 && !conjoined) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
}

/**
 * Several appearance claims as ONE description of a person (#547).
 *
 * The registry hands each fact over already taken apart — which feature group it
 * belongs to, what grammatical role its piece plays, and the piece itself
 * ({@link imageAppearancePhrase}) — and this is the grammar half: bucket by
 * group and role, order each bucket by the position the registry declared, write
 * each group's clause, and list the clauses. No attribute id is read and no
 * wording is invented; a fragment that reaches a prompt was authored beside the
 * values it words.
 *
 * A claim whose value carries NO phrase keeps exactly what it compiled before:
 * its own descriptor, lower-led into the list ("gender: female"). That is the
 * honest answer for an attribute the registry gives no prose form, and it is
 * also what every non-registry projection sends, so the fallback is the ordinary
 * path rather than an error case.
 */
function composeAppearance(claims: readonly ImagePositiveClaim[]): string {
  const buckets = new Map<ImageAppearancePhraseGroup, AppearanceGroupPieces>();
  const standalone: string[] = [];
  for (const claim of claims) {
    const phrased = imageAppearancePhrase(claim.value);
    // `other` names a fact no group noun covers — a stature, a personal style —
    // so it is stated as the noun phrase the registry wrote for it.
    if (phrased === null || phrased.phrase.group === "other") {
      const text = lowerLead(describe(claim.value));
      if (text.length > 0) standalone.push(text);
      continue;
    }
    const group = phrased.phrase.group;
    const pieces = buckets.get(group) ?? { adjectives: [], withs: [], trailers: [] };
    // An undeclared position is 0, which is what keeps claim order the answer
    // wherever the registry expressed no preference.
    const piece: AppearancePiece = { fragment: phrased.phrase.fragment, order: phrased.phrase.order ?? 0 };
    if (phrased.phrase.role === "adjective") pieces.adjectives.push(piece);
    else if (phrased.phrase.role === "with") pieces.withs.push(piece);
    else pieces.trailers.push(piece);
    buckets.set(group, pieces);
  }
  const clauses = APPEARANCE_CLAUSE_ORDER.map((group) => {
    const pieces = buckets.get(group);
    return pieces === undefined ? "" : appearanceClause(group, pieces);
  });
  return appearanceList([...clauses, ...standalone]);
}

/**
 * The build band: the age anchor, ONE sentence describing the person — and the
 * hair's own trailing clauses, riding it.
 *
 * One sentence rather than a build sentence and a hair sentence, because the
 * registry's phrases compose (#547): "She has a slim, lightly toned build with
 * slender arms and a subtle waist, and healthy dark-brown hair worn loose to
 * mid-back" is one description of one person, where the two sentences it
 * replaced were two registry listings in a sentence's shape. The group ORDER is
 * {@link APPEARANCE_CLAUSE_ORDER}'s, and the LOCUS is no longer consulted at
 * all: which clause a fact belongs in is the registry's own declaration, where
 * splitting the band by body location could only ever separate hair from
 * everything else.
 *
 * A hairstyle is a `subject.current_state` fact, which the wardrobe band owns by
 * concept; `groupOfClaim` re-files the `with …` shape of it here because it is a
 * statement about the head this sentence just described, and the garment
 * sentence is the wrong host for it. Anything the re-filing did not send here is
 * not a hair fragment.
 *
 * A re-filed state that carries a PHRASE joins the description as a piece of it
 * rather than trailing the finished sentence: a committed hairstyle replaces the
 * sheet's own hair trailer upstream, so it belongs exactly where that trailer
 * would have sat — "dark-brown hair worn loose to mid-back", not "dark-brown
 * hair to mid-back, with the hair worn loose". A state with no phrase is a
 * fragment nobody took apart, and it keeps the trailing clause it always had.
 */
function writeBuild(claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] {
  const sentences: GroupSentence[] = [];
  const register = context.state.register;
  for (const group of bySubject(claims)) {
    const voice = voiceOf(context, group.ref);
    for (const claim of withConcept(group.claims, "subject.apparent_age")) {
      const rendered = asRendered(context, claim);
      if (rendered !== null) sentences.push(rendered);
    }
    const described = withConcept(group.claims, "subject.morphology", "subject.appearance");
    const worn = withConcept(group.claims, "subject.current_state");
    // Told apart by the VALUE, like every other shape question this dialect
    // asks: a phrased state has pieces to compose with, an unphrased one has
    // only the clause its owner wrote.
    const composed = worn.filter((claim) => imageAppearancePhrase(claim.value) !== null);
    const trailed = worn.filter((claim) => imageAppearancePhrase(claim.value) === null);
    // A stated gender is what a GENDERED pronoun set already says, so beside one
    // it is a fact the sentence has spent on "She" — absorbed into the build
    // sentence rather than listed as "gender: female" inside it. It is kept
    // whenever no pronoun carries it: a shared set, none stated at all, or
    // `they_them`, which the application supplies for every androgynous and
    // nonbinary value while the gender attribute keeps the natal build
    // distinction those values still carry ({@link ImagePronounWords.carriesGender}).
    // "They" conveys neither variant, and this family's reference no longer
    // preserves build, so absorbing it would leave nothing saying which body.
    const carriedByPronoun = (claim: ImagePositiveClaim): boolean =>
      voice?.pronouns?.carriesGender === true && claim.semanticTags.includes(GENDER_ATTRIBUTE_TAG);
    const spoken = described.filter((claim) => !carriedByPronoun(claim));
    const body = composeAppearance([...(spoken.length > 0 ? spoken : described), ...composed]);
    const wornParts = valuesOf(trailed);
    if (body.length > 0) {
      sentences.push({
        // Every claim the sentence absorbed is attributed to it — the gender the
        // pronoun carried and the hairstyle clause included. A claim folded into
        // another's sentence is not a dropped claim, and recording it anywhere
        // else would say the render lost it.
        text: bandSentence(register, voice, "build", `${body}${trailingClause(wornParts)}`),
        claims: [...described, ...worn],
      });
    } else if (wornParts.length > 0) {
      sentences.push({ text: bandSentence(register, voice, "seen", listWords(wornParts)), claims: trailed });
    }
    // An absence keeps its own sentence: the "shown plainly and anatomically
    // correctly" half is an instruction about how to draw it, not another
    // feature to list beside a waist and an arm.
    for (const claim of withConcept(group.claims, "subject.absence")) {
      const rendered = asRendered(context, claim);
      if (rendered !== null) sentences.push(rendered);
    }
  }
  return sentences;
}

/**
 * The wardrobe band: every garment in ONE sentence, in the order the projection
 * stated them, with each garment-scoped reading trailing that sentence rather
 * than becoming a second statement about the same cloth.
 *
 * The fold this replaced matched a presentation to a garment by LOCUS, and in
 * production the two loci never match: a garment fact is filed at
 * `item:<instanceId>` and the reading about it at `garment_part:<instance>:<part>`
 * (`apps/web` `visual-state/locus.ts`). So every reading fell through to the
 * "She is …" branch and compiled "She is with the sweater tucked in". The
 * adapter already names the garment inside its own fragment (#544 F1), so the
 * clause needs no matching at all — it needs a sentence to hang on, and the
 * garment list is it.
 *
 * A reading that is NOT a trailing clause keeps the subject frame: "She is damp
 * at the hair, blindfolded" is a statement about the person, and the two shapes
 * are told apart by the value rather than by the kind ({@link isTrailingClause}).
 */
function writeWardrobe(claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] {
  const sentences: GroupSentence[] = [];
  const register = context.state.register;
  for (const group of bySubject(claims)) {
    const voice = voiceOf(context, group.ref);
    const garments = withConcept(group.claims, "subject.wardrobe");
    const states = withConcept(group.claims, "subject.current_state");
    const trailing = states.filter(isTrailingClause);
    const plain = states.filter((state) => !isTrailingClause(state));
    const wornParts = valuesOf(garments);
    const trailingParts = valuesOf(trailing);
    if (wornParts.length > 0) {
      sentences.push({
        text: bandSentence(register, voice, "garments", `${listWords(wornParts)}${trailingClause(trailingParts)}`),
        // The absorbed readings are attributed to the sentence that carries
        // them: a clause folded into another claim's sentence is not a dropped
        // claim, and recording it anywhere else would say the render lost it.
        claims: [...garments, ...trailing],
      });
    } else if (trailingParts.length > 0) {
      sentences.push({ text: bandSentence(register, voice, "seen", listWords(trailingParts)), claims: trailing });
    }
    const plainParts = valuesOf(plain);
    if (plainParts.length > 0) {
      // A predicate reading is an ASSERTION in either register. "Show her damp
      // at the hair" instructs the model to make her wet; "She is damp at the
      // hair" tells it she already is, which is what the state fact says — the
      // wetness is a condition of the person the render is of, not an edit to
      // perform on her. The imperative register exists because this endpoint
      // reads its prompt as an edit instruction, and stating a condition it
      // must honour is not the same as commanding a change.
      sentences.push({ text: bandSentence("descriptive", voice, "state", listWords(plainParts)), claims: plain });
    }
    for (const claim of withConcept(group.claims, "subject.hair_concealment", "relation.wears")) {
      const rendered = asRendered(context, claim);
      if (rendered !== null) sentences.push(rendered);
    }
  }
  return sentences;
}

/** The exposure band: what is bare, and the anatomy that is then visible. */
function writeExposure(claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] {
  const sentences: GroupSentence[] = [];
  const register = context.state.register;
  for (const group of bySubject(claims)) {
    const voice = voiceOf(context, group.ref);
    const exposure = withConcept(group.claims, "subject.exposure");
    const anatomy = withConcept(group.claims, "subject.intimate_anatomy");
    const bare = valuesOf(exposure);
    if (bare.length > 0) {
      sentences.push({ text: bandSentence(register, voice, "state", listWords(bare)), claims: exposure });
    }
    const shown = valuesOf(anatomy);
    if (shown.length > 0) {
      sentences.push({ text: bandSentence(register, voice, "build", listWords(shown)), claims: anatomy });
    }
  }
  return sentences;
}

/**
 * The pose band: UP TO TWO grammatical sentences — the pose, and the activity
 * (#548).
 *
 * One sentence per band is not a goal and never was; two short grammatical
 * sentences beat one malformed one. Joined under a single "She is …" frame, two
 * composer phrases fused into "She is standing at the craft services table,
 * turned slightly toward the camera, a small smile playing at her lips as she
 * looks into the lens and reaching for a cup of coffee, her attention on the
 * camera across the room." — a sentence no structural assertion could see was
 * broken, because every property it was asked about was true of it. The POSE is
 * where the body is, the ACTIVITY is what it is doing, and English gives each
 * its own subject.
 *
 * The expression folds into whichever sentence comes first: it qualifies the
 * face, not the verb, and a sentence of its own is a third statement about one
 * moment. It keeps that sentence only when there is no pose and no activity to
 * ride.
 *
 * A posture fact is dropped when another phrase in the BAND already CONTAINS it:
 * a cut states "standing" as a committed fact and the composer writes "standing
 * at the craft services table", and a prompt saying both has told the model to
 * compose the same body twice (#544 D10). Compared against every other phrase in
 * the band rather than against the composer's action text alone, because the
 * scene lowering files the composer's POSE under `subject.body_language` too —
 * the same concept as the cut's posture (`apps/web` `scene-lowering.ts`
 * `actionFacts`) — so a rule that only looked at `subject.pose`/`subject.activity`
 * never saw the phrase that actually repeats it. Containment is the whole test,
 * and it can only ever drop the SHORTER of two phrases: the composer's sentence
 * is not contained in a one-word posture, and two identical values are each
 * other's equal rather than each other's container, so neither is lost.
 */
function writePose(claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] {
  const sentences: GroupSentence[] = [];
  const register = context.state.register;
  for (const claim of withConcept(claims, "scene.possession", "scene.staging")) {
    const rendered = asRendered(context, claim);
    if (rendered !== null) sentences.push(rendered);
  }
  for (const group of bySubject(claims)) {
    const voice = voiceOf(context, group.ref);
    const posture = withConcept(group.claims, "subject.body_language");
    const posing = withConcept(group.claims, "subject.pose");
    const acting = withConcept(group.claims, "subject.activity");
    const expressions = withConcept(group.claims, "subject.expression");
    const posingParts = valuesOf(posing);
    const actingParts = valuesOf(acting);
    const spoken = [...valuesOf(posture), ...posingParts, ...actingParts].map((entry) => entry.toLowerCase());
    const kept = posture.filter((claim) => {
      const word = lowerLead(describe(claim.value)).toLowerCase();
      if (word.length === 0) return false;
      // WORD boundaries, not letters. A substring test read "sitting" out of
      // "babysitting a child" and "standing" out of "understanding the
      // assignment", dropped the required posture as already expressed, and
      // attributed it to a sentence that never said it — so the render lost the
      // posture and reported it as carried.
      const stated = wordPattern(word);
      return !spoken.some((entry) => entry !== word && stated.test(entry));
    });
    const poseParts = [...valuesOf(kept), ...posingParts];
    const worn = valuesOf(expressions).map((entry) => `a ${entry} expression`);
    const tail = worn.length === 0 ? "" : `, with ${listWords(worn)}`;
    // The pose leads where there is one; with nothing but an activity, the
    // activity is the first sentence and carries the expression instead.
    const leading = poseParts.length > 0 ? poseParts : actingParts;
    if (leading.length > 0) {
      sentences.push({
        text: bandSentence(register, voice, "state", `${listWords(leading)}${tail}`),
        // Every posture claim, skipped ones included: a posture the composer's
        // own text already contains is ABSORBED by this sentence, not lost, and
        // recording it anywhere else would say the render dropped it. The
        // activity claims belong to whichever sentence actually spoke them, so
        // each claim is attributed exactly once.
        claims: poseParts.length > 0 ? [...posture, ...posing, ...expressions] : [...posture, ...acting, ...expressions],
      });
    } else if (worn.length > 0) {
      sentences.push({ text: bandSentence(register, voice, "expression", listWords(worn)), claims: expressions });
    }
    if (poseParts.length > 0 && actingParts.length > 0) {
      sentences.push({ text: bandSentence(register, voice, "state", listWords(actingParts)), claims: acting });
    }
  }
  for (const claim of withConcept(claims, "relation.holds", "relation.contact", "relation.acts_on")) {
    const rendered = asRendered(context, claim);
    if (rendered !== null) sentences.push(rendered);
  }
  return sentences;
}

/**
 * The setting band's own order: the place, then what is in it, then the light on
 * it — lighting last, because it is a fact about everything the sentences before
 * it just described.
 */
const SETTING_ORDER: readonly ImageConceptId[] = [
  "location.identity",
  "location.kind",
  "location.geometry",
  "location.presentation",
  "location.contents",
  "location.occupancy",
  "location.signage",
  "item.identity",
  "item.form",
  "item.material",
  "item.color",
  "item.part",
  "item.marking",
  "item.condition",
  "item.contents",
  "item.configuration",
  "item.presentation",
  "relation.located_at",
  "relation.placement",
  "relation.contains",
  "relation.attached_to",
  "location.lighting",
  "camera.lighting",
];

/**
 * The concepts a "Place her in …" sentence may be built from: the ones that name
 * the PLACE itself.
 *
 * An item on the table and a sign on the wall are in the setting band and are
 * not somewhere a person is put, so they keep their own sentences; so does the
 * occupancy, which describes who else the room holds.
 */
const PLACE_CONCEPTS: readonly ImageConceptId[] = [
  "location.identity",
  "location.kind",
  "location.geometry",
  "location.contents",
];

/** Whether a setting phrase opens with an article, which is what "Place her in …" needs. */
const OPENS_WITH_ARTICLE = /^(?:an?|the)\s/iu;

/**
 * The setting band: the place, and then everything standing in it (#549).
 *
 * In the imperative register the FIRST place sentence becomes the instruction
 * that puts the subject there — "Place her in a warm lounge …" — and every later
 * one keeps its descriptive form, because two "Place her in …" sentences would
 * put one person in two rooms. Where the phrase does not open with an article,
 * or where there is no sole subject to place, the band labels the setting
 * instead: "The setting: a lamplit study, rain streaking the tall window."
 *
 * The descriptive register emits exactly what each claim rendered, as it always
 * did.
 */
function writeSetting(claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] {
  const ranked = [...claims].sort(
    (left, right) => rankOf(SETTING_ORDER, left.concept) - rankOf(SETTING_ORDER, right.concept),
  );
  // The PLACE is a claim about the location entity, which carries no subject
  // ref. A `location.contents` claim filed on a subject is scenery beside that
  // person — a coat over the chair the projection routed to the setting band —
  // and "The setting: grey wool coat." would put the whole scene inside a coat.
  // Such a claim keeps its own sentence, whichever sorts first.
  const place =
    context.state.register === "imperative"
      ? (ranked.find((claim) => claim.subjectRef === undefined && PLACE_CONCEPTS.includes(claim.concept)) ?? null)
      : null;
  const voice = context.state.soleVoice;
  const sentences: GroupSentence[] = [];
  for (const claim of ranked) {
    if (claim === place) {
      const text = lowerLead(describe(claim.value).trim());
      sentences.push({
        text: sentence(
          voice !== null && OPENS_WITH_ARTICLE.test(text) ? `Place ${them(voice)} in ${text}.` : `The setting: ${text}.`,
        ),
        claims: [claim],
      });
      continue;
    }
    const rendered = asRendered(context, claim);
    if (rendered !== null) sentences.push(rendered);
  }
  return sentences;
}

/** A band that emits its claims one sentence each, in a stated concept order. */
function writeOrdered(order: readonly ImageConceptId[]) {
  return (claims: readonly ImagePositiveClaim[], context: EmitContext): GroupSentence[] => {
    const ranked = [...claims].sort((left, right) => rankOf(order, left.concept) - rankOf(order, right.concept));
    const sentences: GroupSentence[] = [];
    for (const claim of ranked) {
      const rendered = asRendered(context, claim);
      if (rendered !== null) sentences.push(rendered);
    }
    return sentences;
  };
}

/** A concept's place in a band's own order; anything unlisted keeps the program's order, last. */
function rankOf(order: readonly ImageConceptId[], concept: ImageConceptId): number {
  const found = order.indexOf(concept);
  return found === -1 ? order.length : found;
}

/** Every band's writer. Bands not listed here emit their claims in program order. */
const BAND_WRITERS: Readonly<Record<EmissionGroup, (claims: readonly ImagePositiveClaim[], context: EmitContext) => GroupSentence[]>> = {
  binding: writeBinding,
  // The delta reads change, then what the change may not touch, then the
  // canvas permission, then any lettering the render must spell.
  change: writeOrdered([
    "operation.change",
    "operation.preserve",
    "operation.geometry",
    "operation.literal_text",
    "raw.text",
  ]),
  build: writeBuild,
  wardrobe: writeWardrobe,
  exposure: writeExposure,
  pose: writePose,
  // Where the camera stands, then what its own frame holds.
  capture: writeOrdered([
    "scene.capture_mode",
    "camera.framing",
    "camera.distance",
    "camera.angle",
    "camera.height",
    "camera.motion",
    "viewer.body_geometry",
    "viewer.appearance",
    "viewer.intimate_anatomy",
  ]),
  setting: writeSetting,
  mood: writeOrdered(["scene.mood"]),
  style: writeOrdered(["style.medium", "style.descriptor", "style.quality"]),
  close: writeOrdered(["operation.subject_count"]),
};

/**
 * The surviving claims as grouped prose (#544 F10).
 *
 * Runs AFTER fitting, over the claims whose segments survived it, so what a
 * budget squeeze keeps or drops is decided over the same per-claim units as
 * before and grouping only changes how the survivors are said. A band that
 * merges claims rebuilds its sentence from their values; every other band reuses
 * the text its claims already rendered, which is what keeps a segment the hard
 * ceiling COMPRESSED from being silently restored to full length.
 *
 * Each emitted sentence becomes one segment carrying the claims it absorbed, so
 * `joinImagePromptSegments(segments)` is still exactly the compiled text and
 * `source` still names the semantic units behind every sentence a provider
 * receives. Kind, mandatory and priority are inherited from the absorbed
 * segments — the strongest claim wins, because a sentence containing a mandatory
 * clause is mandatory.
 */
function groupedSegments(
  claims: readonly ImagePositiveClaim[],
  state: RenderState,
  fitted: readonly ImagePromptSegment[],
): ImagePromptSegment[] {
  const rendered = new Map<string, ImagePromptSegment>();
  for (const segment of fitted) {
    if (segment.source !== undefined) rendered.set(segment.source, segment);
  }
  const kept = claims.filter((claim) => rendered.has(claim.id));
  const context: EmitContext = { state, rendered };
  const segments: ImagePromptSegment[] = [];
  for (const band of EMISSION_ORDER) {
    const banded = kept.filter((claim) => groupOfClaim(claim) === band);
    if (banded.length === 0) continue;
    for (const written of BAND_WRITERS[band](banded, context)) {
      const parts = written.claims.flatMap((claim) => {
        const part = rendered.get(claim.id);
        return part === undefined ? [] : [part];
      });
      const first = parts[0];
      if (first === undefined || written.text.trim().length === 0) continue;
      segments.push({
        kind: first.kind,
        text: written.text,
        mandatory: parts.some((part) => part.mandatory),
        priority: Math.max(...parts.map((part) => part.priority)),
        source: written.claims.map((claim) => claim.id).join("+"),
      });
    }
  }
  return segments;
}

/** One whole compile of this dialect: render, fit, and emit as grouped prose. */
interface EmissionPass {
  readonly compiled: ImageCompiledPositivePrompt;
  /** The grouped sentences — what the provider receives. */
  readonly segments: ImagePromptSegment[];
  readonly text: string;
}

/**
 * Render every claim this pass still affords, fit the per-claim segments to
 * `budget`, and emit the survivors as grouped prose.
 *
 * State is created HERE and never escapes: the emit-once and slot-consumption
 * rules are per-render facts, and state leaking across passes would make the
 * second pass over one claim list differ from the first — which is the same
 * determinism guarantee that forbids it leaking across compiles.
 *
 * A claim id in `surrendered` renders NOTHING, which is how the advisory loop
 * spends one: the shared compile step records an unrendered claim as dropped,
 * with the claim id every other drop carries, so a squeeze is visible in
 * `droppedClaimIds` exactly as the fitter's own removals are. Only optional
 * claims are ever named, so the mandatory floor is untouched.
 */
function emissionPass(
  input: ImageDialectPositiveInput,
  surrendered: ReadonlySet<string>,
  budget: ImagePromptBudget,
  sink: DiagnosticSink | undefined,
): EmissionPass {
  const voices = subjectVoices(input);
  const soleVoice = voices.size === 1 ? ([...voices.values()][0] ?? null) : null;
  const state: RenderState = {
    lockEmitted: false,
    lockClaimId: null,
    takenSlots: new Set<number>(),
    slots: new Map<string, ImageDialectReference>(),
    voices,
    soleVoice,
    register: registerFor(input),
  };
  const surfaces = createSceneStagingSurfaceLog();
  const compiled = compileDialectClaims({
    claims: input.claims,
    render: (claim) => (surrendered.has(claim.id) ? null : renderClaim(claim, input, state, surfaces)),
    surfaces,
    budget,
    ...(sink === undefined ? {} : { sink }),
  });
  const segments = groupedSegments(input.claims, state, compiled.segments);
  return { compiled, segments, text: joinImagePromptSegments(segments) };
}

/**
 * Compile, fitting the prose this dialect ACTUALLY EMITS rather than the
 * per-claim form it renders on the way there.
 *
 * The two lengths are far apart, and always in the same direction: a dozen
 * one-fact sentences ("She has hair color: dark brown." "She has hair length:
 * mid back.") become one clause list inside one sentence, and the scene fixture
 * loses roughly a third of its characters to the regrouping. Fitting the
 * expanded form against the row's 1300-character advisory therefore trimmed
 * optional appearance and setting claims out of prompts that fit comfortably
 * once grouped — a real loss of detail, paid for a length the provider never saw.
 *
 * So the advisory is measured where it means something. A pass with NO budget
 * gives the grouped text; if it fits, nothing is dropped at all. If it does not,
 * the weakest optional claim is surrendered — by
 * {@link weakestOptionalImagePromptSegment}, the fitter's own rule, so a squeeze
 * chooses the same victim it always would — and the prose is regrouped, until it
 * fits or no optional claim is left. Each surrender is recorded as a dropped
 * claim and reported once.
 *
 * The HARD ceiling keeps the existing path. It is a provider error rather than a
 * quality hint, it is the only limit that may compress a mandatory segment, and
 * that compression is defined over the per-claim segments — so the final pass
 * hands the fitter the ceiling and nothing else, after the advisory loop has
 * already decided what optional material there is to spend. No Qwen row declares
 * one today.
 *
 * Deterministic: the loop reads only the input and its own accumulated set, and
 * every pass starts from fresh state, so two compiles of one digest agree.
 */
function compilePositive(input: ImageDialectPositiveInput): ImageCompiledPositivePrompt {
  const advisory = input.budget.recommendedCharacters;
  const surrendered = new Set<string>();
  const spent: ImagePromptSegment[] = [];
  if (advisory !== undefined) {
    // Bounded by construction: every round adds one claim id to a set it never
    // removes from, and stops as soon as no optional segment is left to name.
    // The diagnostics of a trial pass are discarded — an operator wants the
    // events of the compile that shipped, not one per attempt — so the sink is
    // withheld until the final pass below.
    for (;;) {
      const trial = emissionPass(input, surrendered, {}, undefined);
      if (trial.text.length <= advisory) break;
      const weakest = weakestOptionalImagePromptSegment(trial.compiled.segments);
      if (weakest === null) break;
      const claimId = weakest.source;
      if (claimId === undefined || surrendered.has(claimId)) break;
      surrendered.add(claimId);
      spent.push(weakest);
    }
  }
  const ceiling = input.budget.maxCharacters;
  const emitted = emissionPass(
    input,
    surrendered,
    ceiling === undefined ? {} : { maxCharacters: ceiling },
    input.sink,
  );
  reportImagePromptEmissionTrim(spent, emitted.text.length, input.budget, input.sink);
  return { ...emitted.compiled, segments: emitted.segments, text: emitted.text };
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
