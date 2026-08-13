import type { IdentityReferenceCandidate } from "../identity/identity-pack";
import type { ImageRenderReferenceSpec } from "./render-intent";

/**
 * One identity-pack candidate as the shared render intent speaks it — the
 * generic `identity` role with the pack's ids attached
 * (image-identity-packs.spec.integration.md §"Shared render intent").
 *
 * The two vocabularies stay separate on purpose: `canonical_identity` and
 * `face_detail` are pack roles that say WHICH reference this is, and both become
 * the capabilities layer's single `identity` role, which says what the reference
 * is FOR. The pack role survives in the provenance record, not in the spec.
 */
export interface IdentityReferenceSpec extends ImageRenderReferenceSpec {
  role: "identity";
  required: boolean;
  priority: number;
  sourceImageId: string;
}

/**
 * Map an eligible evaluation's candidates into render-intent reference specs, in
 * the order the strategy planned them.
 *
 * `priority` descends with plan position so `planIntentReferences` keeps the
 * strategy's order inside the identity role band — the caller adds nothing and
 * reorders nothing, which is the "no lane may reorder identity roles after
 * profile resolution" rule made mechanical. The planner's required-before-
 * optional sort still outranks priority, deliberately: under capacity pressure
 * the required identity takes the slot and the optional face detail is what
 * gives way, exactly the spec's "required identities before optional face
 * detail" ruling.
 *
 * `sourceImageId` names the stored asset actually sent (the portrait for the
 * canonical role, the hidden crop for face detail) so drop diagnostics can name
 * it. `subject`, when given, is the character's name for multi-identity compose
 * wording; single-identity lanes omit it and their compiled prompt is unchanged.
 */
export function identityCandidateReferenceSpecs(
  candidates: readonly IdentityReferenceCandidate[],
  subject?: string,
): IdentityReferenceSpec[] {
  return candidates.map((candidate, index) => ({
    role: "identity",
    required: candidate.required,
    priority: candidates.length - index,
    sourceImageId: candidate.imageId,
    ...(subject ? { subject } : {}),
  }));
}
