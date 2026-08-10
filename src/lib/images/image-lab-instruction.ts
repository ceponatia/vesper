import type { ImageLabControlKind } from "@/contracts";

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
export { imageLabControlRole } from "@/contracts";

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
