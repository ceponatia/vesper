import { describe, expect, it } from "vitest";
import type { IdentityReferenceCandidate, IdentityReferenceRole } from "../identity/identity-pack";
import { imageModelSchema, type ImageModel } from "../models/image-models";
import { imageReferencePolicySchema } from "../models/image-model-profiles";
import { identityCandidateReferenceSpecs } from "./identity-references";
import { planIntentReferences } from "./render-intent";

const candidate = (
  role: IdentityReferenceRole,
  required: boolean,
  imageId: string,
): IdentityReferenceCandidate => ({
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
});

describe("identityCandidateReferenceSpecs", () => {
  it("maps both pack roles onto the generic identity role, in plan order, naming each candidate's own asset", () => {
    const specs = identityCandidateReferenceSpecs([
      candidate("canonical_identity", true, "imgportrait"),
      candidate("face_detail", false, "imgfacecrop"),
    ]);
    expect(specs.map((spec) => spec.role)).toEqual(["identity", "identity"]);
    // The bytes sent are the candidate's — the portrait for canonical, the
    // hidden crop for face detail — never the pack's source id restated.
    expect(specs.map((spec) => spec.sourceImageId)).toEqual(["imgportrait", "imgfacecrop"]);
    expect(specs.map((spec) => spec.required)).toEqual([true, false]);
    // Priority descends with plan position, keeping strategy order inside the
    // identity band without the caller sorting anything.
    expect(specs.map((spec) => spec.priority)).toEqual([2, 1]);
    expect(specs.every((spec) => spec.subject === undefined)).toBe(true);
  });

  it("carries a subject only when one is given (single-identity lanes stay byte-identical)", () => {
    const [spec] = identityCandidateReferenceSpecs([candidate("canonical_identity", true, "img1")], "Mira");
    expect(spec?.subject).toBe("Mira");
    const [bare] = identityCandidateReferenceSpecs([candidate("canonical_identity", true, "img1")]);
    expect(bare && "subject" in bare).toBe(false);
  });
});

/** The planner's judgment over mapped specs — the ordering rules 5B relies on. */
describe("identityCandidateReferenceSpecs under planIntentReferences", () => {
  const model = (maxReferences: number): ImageModel =>
    imageModelSchema.parse({
      id: "mdl",
      slug: "vendor/model",
      label: "Model",
      canGenerate: false,
      canEdit: true,
      editKind: "instruction_edit",
      identityPreservation: "strong",
      referenceArity: "array",
      maxReferences,
    });
  const policy = imageReferencePolicySchema.parse({
    allowedRoles: ["identity"],
    requiredRoles: ["identity"],
    roleOrder: ["identity"],
  });

  it("keeps canonical-then-face-detail order when both fit", () => {
    const specs = identityCandidateReferenceSpecs([
      candidate("canonical_identity", true, "imgportrait"),
      candidate("face_detail", false, "imgfacecrop"),
    ]);
    const planned = planIntentReferences(model(3), policy, specs);
    expect(planned.primary.map((spec) => spec.sourceImageId)).toEqual(["imgportrait", "imgfacecrop"]);
    expect(planned.dropped).toEqual([]);
    expect(planned.renumbered).toBe(false);
  });

  it("gives a scarce slot to the required identity, dropping optional face detail — never the reverse", () => {
    // face_detail_then_canonical plans the optional crop first; with one slot,
    // the spec's "required identities before optional face detail" must win.
    const specs = identityCandidateReferenceSpecs([
      candidate("face_detail", false, "imgfacecrop"),
      candidate("canonical_identity", true, "imgportrait"),
    ]);
    const planned = planIntentReferences(model(1), policy, specs);
    expect(planned.primary.map((spec) => spec.sourceImageId)).toEqual(["imgportrait"]);
    expect(planned.dropped.map((drop) => drop.reference.sourceImageId)).toEqual(["imgfacecrop"]);
  });
});
