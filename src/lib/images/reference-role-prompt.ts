import { isImageControlReferenceRole, type ImageReferenceRole } from "@/contracts/images/image-model-capabilities";

/**
 * The general-role instruction compiler — the render-intent vocabulary's answer
 * to what `identity-reference-prompt.ts` does for the identity trial
 * (image-model-capabilities.spec.md §"Prompt strategies").
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
 * The instruction line for one reference slot. The position is 1-based and is
 * the slot's index in the SEND order, which is the order
 * `planIntentReferences` resolved — not the order the lane happened to supply.
 */
function referenceRoleBinding(role: ImageReferenceRole, position: number): string {
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

export interface CompileReferenceRolePromptInput {
  basePrompt: string;
  /** Roles in SEND order — the same order the reference images are transported in. */
  roles: readonly ImageReferenceRole[];
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
 */
export function compileReferenceRolePrompt(input: CompileReferenceRolePromptInput): string {
  const { basePrompt, roles } = input;
  if (roles.length === 0) return basePrompt;

  const lines = roles.map((role, index) => referenceRoleBinding(role, index + 1));
  if (roles.some(isImageControlReferenceRole)) lines.push(CONTROL_REFERENCE_CLAUSE);
  return `${lines.join("\n")}\n\n${basePrompt}`;
}
