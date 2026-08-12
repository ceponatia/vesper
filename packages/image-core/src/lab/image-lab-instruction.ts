import type { ImageLabControlKind, ImageLabFinishingVariant } from "./image-lab";

/**
 * The Advanced Image Lab's numbered-role instruction template
 * (qwen-advanced-image-subsystem.spec.md §Algorithms step 4).
 *
 * Neither Qwen edit model exposes a `pose` or `depth` field: a control map is
 * sent as one of the numbered images, and the PROMPT is the only place that says
 * which numbered image carries identity and which carries structure. So the
 * instruction is not decoration around the experiment — it is half of the
 * experiment, and a probe whose wording let the model read a skeleton diagram as
 * a person would answer a question nobody asked.
 *
 * The text is composed here, pure and deterministic, for two reasons. It is
 * pre-filled in the UI and sent only as the admin approved it — the runner never
 * rewrites a prompt behind the reviewer's back, because a verdict is a ruling on
 * a specific sentence. And a template that lived inline in a form could not be
 * tested, while the whole point of Stage 0 is that the wording is a controlled
 * variable.
 *
 * Positions are 1-based and are the slot's place in the SEND order, matching
 * `imageLabInputSchema.position` — the contract's own reason for 1-basing.
 */

/**
 * The kind → reference-role mapping, re-exported from the contract that owns it.
 *
 * It used to be defined here, because the experiment form was its only caller.
 * The runner now validates against the same mapping — a probe must SEND the
 * fixture it declares, under a role a fixture may occupy — and a server-side
 * copy of a UI helper is exactly how the form and the runner would come to
 * disagree about which slot a skeleton occupies. So the definition moved into
 * `@/contracts` and this stays as its front door for the template's callers.
 */
export { imageLabControlRole } from "./image-lab";

/** How the instruction names the person being rendered. */
function subjectPhrase(identityPosition: number | null): string {
  return identityPosition === null ? "the person" : `the person from Image ${identityPosition}`;
}

/**
 * What the control image IS, and what obeying it means, per kind.
 *
 * Every kind repeats "not a person and not a style reference" because that is
 * the failure this probe most often has to rule out: a model that paints a
 * stick figure, or that copies the depth map's grey palette, has not ignored the
 * control — it has misread it, and the two must not be recorded as the same
 * verdict.
 */
function controlClause(kind: ImageLabControlKind, controlPosition: number, identityPosition: number | null): string {
  const subject = subjectPhrase(identityPosition);
  switch (kind) {
    case "pose":
      return (
        `Image ${controlPosition} is a pose skeleton diagram, not a person and not a style reference. ` +
        `Render ${subject} in exactly the body pose drawn in Image ${controlPosition} — same limb positions, ` +
        `same head angle, same weight distribution.`
      );
    case "depth":
      return (
        `Image ${controlPosition} is a depth map, not a person and not a style reference: brighter areas are ` +
        `nearer the camera and darker areas are further away. Render ${subject} in exactly the body pose, camera ` +
        `angle, and spatial arrangement that Image ${controlPosition} describes.`
      );
    case "edge":
      return (
        `Image ${controlPosition} is a white-on-black edge map, not a person and not a style reference. ` +
        `Render ${subject} so that the outline, limb placement, and composition follow exactly the lines drawn in ` +
        `Image ${controlPosition}.`
      );
  }
}

export interface ImageLabProbeInstructionInput {
  controlKind: ImageLabControlKind;
  /** 1-based send position of the control fixture. */
  controlPosition: number;
  /** 1-based send position of the identity reference, or null when the probe sends none. */
  identityPosition: number | null;
}

/**
 * The control-probe instruction: identity binding (when one is sent), the
 * control binding, and the structure-only clause.
 *
 * The last sentence exists because a control map that leaks its own colours into
 * the output looks, at a glance, exactly like a model honouring it. Saying
 * "structure only" out loud is what makes an honoured-control verdict readable
 * from the image.
 */
export function imageLabProbeInstruction(input: ImageLabProbeInstructionInput): string {
  const { controlKind, controlPosition, identityPosition } = input;
  const sentences: string[] = [];
  if (identityPosition !== null) {
    sentences.push(
      `Image ${identityPosition} is the identity reference — preserve the exact face, hair, skin tone, body ` +
        `proportions, and apparent age.`,
    );
  }
  sentences.push(controlClause(controlKind, controlPosition, identityPosition));
  sentences.push(
    `Take no colour, lighting, clothing, or artistic style from Image ${controlPosition}; it carries structure only.`,
  );
  return sentences.join(" ");
}

/**
 * The half of the finishing preamble that is the same in every arm — the whole
 * product rule's "and nothing else", written as the instruction the model is
 * given.
 *
 * The plan's promotion rule is that a finishing pass may be adopted only when it
 * "improves identity without materially changing structure, clothing, body,
 * camera, lighting, or setting". That sentence is not just how the result is
 * judged; it is what the run is asked to do, so the preamble names both halves
 * explicitly — what to correct ({@link finishingTargetClause}), and the list here
 * of everything that must survive untouched. Wording this half as a list rather
 * than as "change nothing else" is deliberate: a model told only to preserve
 * "everything else" reliably re-renders the scene it thinks it is improving, and
 * a re-rendered scene fails the rule no matter what it did to the face.
 *
 * Hair sits on the IDENTITY side, not the untouched side, because hair colour
 * and hairline are identity signal and a pass forbidden to touch them could not
 * fix the drift the Stage 1/2 trial recorded. Hair LENGTH is left unmentioned:
 * naming it on either side would either license a restyle or forbid a
 * correction, and neither is what this pass is for.
 *
 * Positions go unnamed on purpose. The compose strategy prefixes a numbered
 * binding per reference and the runner's send order decides those numbers, so a
 * preamble that also numbered them would be a second, independently-maintained
 * numbering — the exact drift {@link imageLabProbeInstruction}'s 1-basing exists
 * to prevent. This text says "the before image" and "the identity reference",
 * which are the words those bindings use.
 */
const FINISHING_UNCHANGED_CLAUSES = [
  "Change nothing else. Keep the pose, body proportions, hands, clothing, camera angle, framing, crop, lighting, " +
    "colour grade, and setting exactly as they are in the before image.",
  "Do not re-render the scene, do not restyle it, and do not move or reframe the subject. The before image is the " +
    "output except for the face.",
];

/**
 * The half of the preamble that names WHAT the face is corrected toward — the one
 * sentence the two arms cannot share.
 *
 * The identity arm sends an identity reference and says so. The LoRA-only arm
 * sends no such image, and a preamble that named one anyway would point the model
 * at a slot that does not exist: the likeness there comes from the loaded weights
 * (and the library row's own trigger words, woven in around this text by
 * `applyImageLoraPromptAdditions`), so the sentence says that instead, and says
 * out loud that no reference is coming. The list of identity features is
 * identical in both, because it is the definition of "the face" this pass is
 * allowed to touch and that definition does not depend on where the likeness
 * came from.
 */
function finishingTargetClause(variant: ImageLabFinishingVariant): string {
  const features =
    "bone structure, jaw and chin shape, brow, eyes, nose, mouth, skin tone, hairline and hair colour, and " +
    "apparent age";
  switch (variant) {
    case "identity":
      return `Refine only the identity in the before image: correct the face so it matches the identity reference — ${features}.`;
    case "lora_only":
      return (
        `Refine only the identity in the before image: correct the face — ${features} — so it is the character ` +
        `this prompt names. No identity reference image is supplied; do not look for one.`
      );
  }
}

/**
 * The finishing pass's full base prompt: the preamble for its arm, then the
 * admin's own instruction when they wrote one.
 *
 * The admin's text comes AFTER the rule rather than before it, and is optional
 * for the same reason the rule is fixed: the run's whole claim is that it
 * changed one thing, so the sentence making that claim cannot be something a
 * hurried admin can delete. What they add is a narrowing ("the left eye is
 * wrong"), never a replacement.
 *
 * A blank line separates the two, so an instruction written as a fragment reads
 * as its own remark rather than running into the last sentence of the rule.
 */
export function imageLabFinishingInstruction(ownerInstruction: string, variant: ImageLabFinishingVariant): string {
  const preamble = [finishingTargetClause(variant), ...FINISHING_UNCHANGED_CLAUSES].join(" ");
  const extra = ownerInstruction.trim();
  return extra === "" ? preamble : `${preamble}\n\n${extra}`;
}
