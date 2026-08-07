import type { IdentityReferenceRole } from "@/contracts/images/identity-pack";

/**
 * The shared role-instruction compiler for multi-reference identity renders
 * (docs/developer-notes/image-identity-packs.spec.trial.md §"Fixed variables").
 *
 * When a render sends TWO reference images, the provider is handed an ordered
 * list and nothing else. Nothing in that transport says which image is the
 * canonical portrait and which is the tight facial crop, so a model asked to
 * "preserve the subject" from two unlabelled references has to guess — and the
 * strategies the trial exists to compare (`canonical_then_face_detail` vs
 * `face_detail_then_canonical`) differ ONLY in that order. Without a preamble
 * naming the images, the two strategies are a coin flip wearing two names, and
 * the grid measures noise.
 *
 * So the numbered bindings are compiled here, from the SAME ordered role list
 * the transport sends, and every lane that sends multiple references must
 * compile through this one function. Two copies of this wording would be two
 * copies that drift, and the day "Image 2" in the text stops meaning the second
 * image in the payload is the day every multi-reference comparison in the
 * archive becomes unreadable — silently, with no error anywhere.
 *
 * The wording is fixed and versioned by being code: the compiled text is what
 * `positivePromptHash` hashes, so editing a sentence here changes the identity
 * of every cell that would carry it. That is deliberate and correct — a
 * differently-worded instruction is a different experiment — but it means text
 * changes are comparison-identity changes, not copy edits.
 *
 * Pure and deterministic: same roles, same base prompt, same string.
 */

/**
 * The instruction preamble for one reference slot. The position is 1-based and
 * is the slot's index in the SEND order, not its index in any vocabulary — the
 * caller passes roles in the exact order the transport will place the images.
 */
function identityReferenceRoleBinding(role: IdentityReferenceRole, position: number): string {
  switch (role) {
    case "canonical_identity":
      return `Image ${position}: the canonical identity reference for the subject.`;
    case "face_detail":
      return `Image ${position}: a close facial-detail reference for the same subject.`;
  }
}

/**
 * Which reference wins when the two disagree. Emitted only when BOTH roles are
 * present, because it is the only case where a conflict can arise: the canonical
 * portrait carries hair, build and age that a tight face crop simply does not
 * show, and a model left to weigh them itself tends to let the crop's framing
 * pull the whole render toward a headshot.
 *
 * It says nothing about which image is first. Ordering is the strategy's job and
 * the numbered bindings above already encode it; repeating the order here would
 * make the authority clause differ between the two orderings and confound the
 * exact comparison it is meant to hold constant.
 */
const IDENTITY_REFERENCE_AUTHORITY_CLAUSE =
  "Preserve the subject's canonical identity, hair, build, and apparent age from the canonical identity reference. " +
  "Use the facial-detail reference only to reinforce facial likeness.";

export interface CompileIdentityReferencePromptInput {
  basePrompt: string;
  /** Roles in SEND order — the same order the reference images are transported in. */
  roles: readonly IdentityReferenceRole[];
}

/**
 * The final prompt text for a render, with numbered role bindings prefixed when
 * more than one reference is sent.
 *
 * Zero or one reference returns `basePrompt` UNCHANGED. That is not an
 * optimization: with a single image there is nothing to disambiguate, and
 * prefixing "Image 1: …" onto every single-reference render would rewrite the
 * prompt of every existing lane, changing renders that are working today for no
 * measurable gain. Single-reference cells stay exactly as simple as they are.
 */
export function compileIdentityReferencePrompt(input: CompileIdentityReferencePromptInput): string {
  const { basePrompt, roles } = input;
  if (roles.length < 2) return basePrompt;

  const lines = roles.map((role, index) => identityReferenceRoleBinding(role, index + 1));
  if (roles.includes("canonical_identity") && roles.includes("face_detail")) {
    lines.push(IDENTITY_REFERENCE_AUTHORITY_CLAUSE);
  }
  return `${lines.join("\n")}\n\n${basePrompt}`;
}
