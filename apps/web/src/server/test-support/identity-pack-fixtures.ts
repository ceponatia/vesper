import type {
  IdentityReferenceCandidate,
  IdentityReferenceProvenance,
  IdentityReferenceRole,
} from "@vesper/image-core";

/**
 * Schema-complete identity-pack render fixtures, shared by the consume-helper
 * and lane-wiring suites. Every measurement is null on purpose — "not measured"
 * is the honest state for a fixture, and a numeric default here would quietly
 * assert an evaluation nobody ran (the identity-pack schema rule).
 */

/** One evaluated candidate as `evaluateIdentityPackForProfile` emits it. */
export function identityCandidateFixture(
  role: IdentityReferenceRole,
  required: boolean,
  imageId: string,
): IdentityReferenceCandidate {
  return {
    role,
    imageId,
    packId: "packaaaaaaaaaaaaaaaaaaaa",
    packRevision: 3,
    sourceImageId: "imgsourceaaaaaaaaaaaaaaa",
    sourceContentHash: "hash",
    required,
    warningCodes: [],
    evaluation: {
      policyVersion: "identity_pack_policy_v1",
      effectiveReferenceWidthPx: null,
      effectiveReferenceHeightPx: null,
      effectiveFaceWidthPx: null,
      effectiveFaceHeightPx: null,
    },
  };
}

/** The candidate-parallel provenance record for the same pack revision. */
export function identityProvenanceFixture(
  role: IdentityReferenceRole,
  imageId: string,
): IdentityReferenceProvenance {
  return {
    characterId: "charaaaaaaaaaaaaaaaaaaaa",
    packId: "packaaaaaaaaaaaaaaaaaaaa",
    packRevision: 3,
    packSchemaVersion: 1,
    derivationVersion: "identity_pack_derivation_v1",
    policyVersion: "identity_pack_policy_v1",
    role,
    imageId,
    sourceImageId: "imgsourceaaaaaaaaaaaaaaa",
    sourceContentHash: "hash",
    cropMethod: null,
    crop: null,
    warningCodes: [],
    adminOverride: false,
    effectiveReferenceWidthPx: null,
    effectiveReferenceHeightPx: null,
    effectiveFaceWidthPx: null,
    effectiveFaceHeightPx: null,
  };
}
