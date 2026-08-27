import { isImageControlReferenceRole, type ImageReferenceRole } from "../capabilities/image-model-capabilities";

/**
 * The general-role instruction compiler — the render-intent vocabulary's answer
 * to what `identity-reference-prompt.ts` does for the identity trial.
 *
 * It exists because `multi_reference_compose` could not be compiled on the
 * production arm at all: the strategy's defining semantic is that it names the
 * purpose and order of every reference, the render-intent vocabulary had no
 * wording for that, and the compiler refused rather than returning the base
 * prompt and letting a profile claim a strategy it was not sending. This is that
 * wording, and it is what unblocks a controlled Qwen recipe — an identity
 * portrait and a pose skeleton in one ordered list are indistinguishable to the
 * provider unless the text says which is which.
 *
 * The CONTROL roles are why this is not a table of nouns. A pose skeleton is not
 * a thing to depict; it is a constraint to obey, and a model handed one under
 * "Image 2: a pose reference" will cheerfully render a stick figure. So the
 * structural roles get imperative wording that says follow-this-do-not-draw-it,
 * and they get a closing clause that says the same thing once more about the
 * whole set — which is the difference between a control map working and a
 * control map appearing in the output.
 *
 * Pure and deterministic: same roles, same base prompt, same string. The text is
 * versioned by being code — it is hashed into `positivePromptHash`, so editing a
 * sentence here is a comparison-identity change, not a copy edit.
 */

/**
 * One reference to bind, as the compiler needs it: its role, and the subject it
 * depicts when naming that subject is what keeps two same-role references apart.
 *
 * A binding rather than a bare role because a role stopped being enough the day
 * two identity references could ride one render — see {@link
 * CompileReferenceRolePromptInput}.
 */
export interface CompileReferenceBinding {
  role: ImageReferenceRole;
  /**
   * Whose reference this is. Honoured on `identity` only, and deliberately so:
   * identity is the one role a render sends twice, so it is the one role whose
   * two slots need telling apart by name. A location, an outfit or a control map
   * is singular in every recipe that exists, and naming a subject on one would be
   * prompt text asserting a distinction the payload does not make.
   */
  subject?: string;
}

/**
 * The instruction line for one reference slot. The position is 1-based and is
 * the slot's index in the SEND order, which is the order
 * `planIntentReferences` resolved — not the order the lane happened to supply.
 *
 * The subject-bearing identity line is a SECOND wording rather than an
 * interpolation into the first, because the two say different things. Unnamed,
 * the honest instruction is "the person this render depicts" — there is one, and
 * this image is them. Named, the render has more than one person in it and the
 * line has to say which of them this image is, which is a different sentence and
 * not the same sentence with a word dropped in.
 */
function referenceRoleBinding(binding: CompileReferenceBinding, position: number): string {
  const { role, subject } = binding;
  if (role === "identity" && subject !== undefined) {
    return (
      `Image ${position}: the identity reference for ${subject} — one of the people this render depicts. ` +
      `Preserve ${subject}'s face, hair, build, and apparent age exactly as shown in this image.`
    );
  }
  switch (role) {
    case "identity":
      return `Image ${position}: the identity reference — the person this render depicts. Preserve their face, hair, build, and apparent age.`;
    case "location":
      return `Image ${position}: the location reference — the place this render is set. Preserve its architecture, furnishing, and lighting.`;
    case "style":
      return `Image ${position}: a style reference. Take its rendering style, palette, and finish; take no subject or object from it.`;
    case "object":
      return `Image ${position}: an object reference — an item that appears in the scene. Preserve its shape, material, and markings.`;
    case "outfit":
      return `Image ${position}: the wardrobe reference — dress the subject in exactly this clothing. Preserve its colour, cut, fabric, and details; take nothing else from it.`;
    case "product":
      return `Image ${position}: the product reference. Reproduce it exactly, including proportions, colour, and any text on it.`;
    case "before":
      return `Image ${position}: the "before" image — the starting state this render transforms.`;
    case "after_example":
      return `Image ${position}: an example of the finished result. Match the KIND of change it demonstrates, not its subject.`;
    case "reference":
      return `Image ${position}: a reference image.`;
    case "mask":
      return `Image ${position}: a mask. Edit only the white region; leave the black region untouched. Do not draw the mask itself.`;
    case "pose":
      return `Image ${position}: a pose skeleton. Place the subject in exactly this body position, limb by limb. Do not draw the skeleton.`;
    case "depth":
      return `Image ${position}: a depth map. Match its spatial layout and camera depth. Do not draw the depth map.`;
    case "edge":
      return `Image ${position}: an edge map. Follow its contours and composition. Do not draw the lines themselves.`;
    case "control":
      return `Image ${position}: a structural control map. Follow the layout it defines. Do not draw the map itself.`;
  }
}

/**
 * The closing reminder emitted whenever any structural control is present.
 *
 * Redundant with the per-slot "do not draw" lines on purpose. A control map is
 * the one reference a model gets catastrophically rather than subtly wrong — the
 * failure is a rendered skeleton, not a slightly-off pose — and the per-slot line
 * sits in the middle of a list the model may weight by position. Restating the
 * rule once at the end costs a sentence and removes the whole failure class.
 */
const CONTROL_REFERENCE_CLAUSE =
  "The structural reference images above define layout only. Reproduce the structure they describe using the " +
  "subject and setting from the other references; never render the control images themselves.";

/**
 * The cast clause, emitted when the identity references name two or more
 * DISTINCT subjects.
 *
 * It is the counterpart of {@link CONTROL_REFERENCE_CLAUSE} and exists for the
 * same reason: a per-slot line sits in the middle of a list the model may weight
 * by position, and the failure it guards against is catastrophic rather than
 * subtle. A multi-reference edit handed two faces has three ways to go wrong that
 * a viewer notices instantly — it renders one person twice, it renders one person
 * and drops the other, or it blends both into a stranger — and none of them is
 * prevented by two correct per-slot bindings, because each of those is a
 * statement about ONE image and the failure is a statement about the set.
 *
 * The count is stated as a number AND the subjects are named, because the two
 * halves fail differently: the number is what stops a duplicate or an extra
 * bystander, and the names are what tie each person back to the slot that
 * described them.
 *
 * DISTINCT SUBJECTS, not identity-reference count, is the trigger — and the
 * difference is load-bearing rather than pedantic. Two identity references are
 * not two people: the finishing recipe's policy already allows a second identity
 * slot so the pack's face-detail crop can join the canonical portrait, and those
 * are two images OF ONE PERSON. Counting references there would tell the model a
 * solo portrait depicts exactly two people and instruct it to render them both,
 * which is the very failure this sentence exists to prevent, aimed at a render
 * that was never at risk of it. Subjects are the only thing in the input that
 * says how many people there are, so they are what the clause counts.
 */
function subjectsClause(subjects: readonly string[]): string {
  return (
    `This render depicts exactly ${String(subjects.length)} people: ${joinSubjects(subjects)}. ` +
    "Render each person exactly once, matched to their own identity reference; never merge, swap, or duplicate them."
  );
}

/** `A and B`, `A, B, and C` — the Oxford comma from three up. */
function joinSubjects(subjects: readonly string[]): string {
  if (subjects.length <= 1) return subjects[0] ?? "";
  if (subjects.length === 2) return `${String(subjects[0])} and ${String(subjects[1])}`;
  return `${subjects.slice(0, -1).join(", ")}, and ${String(subjects[subjects.length - 1])}`;
}

export interface CompileReferenceRolePromptInput {
  basePrompt: string;
  /**
   * The references in SEND order — the same order the images are transported in.
   *
   * Bindings rather than bare roles because a role alone cannot describe a
   * two-character send: both references are `identity`, both would compile to the
   * same sentence, and the model would be told twice that one image is "the
   * person this render depicts" with nothing saying they are two different
   * people. A binding carries the name that resolves it.
   *
   * A subject-less binding compiles EXACTLY as its bare role did — the wording is
   * hashed into comparison identity, so every render that predates this field has
   * to keep producing the same bytes.
   */
  references: readonly CompileReferenceBinding[];
}

/**
 * The final prompt text, with a numbered role binding per reference prefixed.
 *
 * Binds from ONE reference upward rather than from two, which is what separates
 * this strategy from `instruction_edit`. That threshold is the opposite of the
 * identity compiler's default, and deliberately so: there, naming a lone image
 * would rewrite live single-reference renders for nothing; here, the only
 * profiles that select this strategy are ones whose whole configuration is "name
 * every reference", and a single-reference render that named nothing would be
 * `instruction_edit` wearing a second name.
 *
 * Zero references returns `basePrompt` unchanged — there is nothing to bind, and
 * a preamble about images that are not there is worse than no preamble.
 *
 * The two closing clauses are ordered cast-then-control, and the order is not
 * arbitrary. The cast clause is about the SUBJECTS the per-slot identity lines
 * just introduced, so it belongs beside them; the control clause is the last word
 * because it is a prohibition, and a prohibition read last is the one a model is
 * least likely to weigh against the descriptive lines above it. Putting the cast
 * clause after it would separate the control rule from the end of the preamble
 * for a sentence that has nothing to do with structure.
 */
export function compileReferenceRolePrompt(input: CompileReferenceRolePromptInput): string {
  const { basePrompt, references } = input;
  if (references.length === 0) return basePrompt;

  const lines = references.map((reference, index) => referenceRoleBinding(reference, index + 1));
  // Deduplicated in SEND order, so the clause names the cast in the order the
  // numbered bindings above just introduced them.
  const subjects = [
    ...new Set(
      references.flatMap((reference) =>
        reference.role === "identity" && reference.subject !== undefined ? [reference.subject] : [],
      ),
    ),
  ];
  if (subjects.length >= 2) lines.push(subjectsClause(subjects));
  if (references.some((reference) => isImageControlReferenceRole(reference.role))) lines.push(CONTROL_REFERENCE_CLAUSE);
  return `${lines.join("\n")}\n\n${basePrompt}`;
}
