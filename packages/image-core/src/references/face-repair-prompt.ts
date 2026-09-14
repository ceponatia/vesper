/**
 * The face-repair action's numbered-reference instruction (issue #246).
 *
 * `apps/web/src/server/images/face-repair.ts` plans WHICH images a repair
 * sends and in what order, but authors no wording of its own: the census
 * (`scripts/image-reference-numbering.test.ts`) forbids any module under
 * `server/images` from writing a slot label like "Image 2" — a label is only
 * honest when the code that writes it also knows, and controls, what slot 2
 * of the payload actually carries. This package already owns that rule for
 * every other numbered-reference lane (`identity-reference-prompt.ts`,
 * `reference-role-prompt.ts`), so the face-repair instruction is worded here
 * too, beside them, rather than beside the plan that merely calls it.
 *
 * The instruction is a fixed, single-sentence edit description rather than a
 * per-slot binding preamble like its siblings in this folder: a face repair
 * always sends exactly one image to repair (Image 1) and one or more identity
 * references naming who it should look like (Image 2, or Images 2 through N),
 * so one sentence states the whole edit. `identityReferenceCount` is a count,
 * not a role list, because every identity reference here plays the same part
 * — evidence of the face to match — regardless of whether it is the canonical
 * portrait or the face-detail crop.
 */

const FACE_REPAIR_PRESERVE_CLAUSE =
  "keep the pose, clothing, background, lighting and composition of Image 1 unchanged";

/**
 * The repair instruction — the Generator's whole positive prompt for one
 * face-repair run. The Generator is a raw prompt/model bench with no dialect
 * compiler of its own (`docs/image-generator/README.md`), so this is plain
 * text rather than a compiled claim; it still follows the numbered-reference
 * wording `docs/image-models/models/qwen-image-edit-2511.md`
 * §Numbered-reference instruction policy sets for this family: name the
 * image, say what changes, say what stays fixed.
 */
export function faceRepairInstruction(identityReferenceCount: number): string {
  if (identityReferenceCount <= 0) {
    // Unreachable through the route — the caller refuses before this is ever
    // invoked with zero identity references — but a stray call still states a
    // coherent instruction rather than naming an image that was never sent.
    return `Repair the face in Image 1; ${FACE_REPAIR_PRESERVE_CLAUSE}.`;
  }
  const lastSlot = identityReferenceCount + 1;
  const referenceSpan = identityReferenceCount === 1 ? "Image 2" : `Images 2 through ${String(lastSlot)}`;
  return `Repair the face in Image 1 to match the person shown in ${referenceSpan}; ${FACE_REPAIR_PRESERVE_CLAUSE}.`;
}
