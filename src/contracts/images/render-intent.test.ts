import { describe, expect, it } from "vitest";
import { imageLabControlRoles } from "./image-lab";
import { imageControlReferenceRoles, isImageControlReferenceRole } from "./image-model-capabilities";
import { imageModelSchema, type ImageModel } from "./image-models";
import { emptyImageReferencePolicy, type ImageReferencePolicy } from "./image-model-profiles";
import {
  controlReferenceTransport,
  missingRequiredControlInputs,
  planIntentReferences,
  type ImageRenderReferenceSpec,
} from "./render-intent";

/**
 * The pure reference rules: which images are sent, in what order, on which
 * field. `server/images/render-intent.test.ts` asserts the same machinery
 * through a whole compiled plan; these cases pin the parts that have no
 * server-side observable — the two role vocabularies staying in step, and the
 * binding resolver's reading of a probed capability record.
 */

const model = (overrides: Record<string, unknown> = {}): ImageModel =>
  imageModelSchema.parse({
    id: "mdl",
    slug: "vendor/model",
    label: "Model",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    ...overrides,
  });

const policy = (overrides: Partial<ImageReferencePolicy> = {}): ImageReferencePolicy => ({
  ...emptyImageReferencePolicy(),
  ...overrides,
});

const ref = (role: ImageRenderReferenceSpec["role"], name: string): ImageRenderReferenceSpec => ({ role, name });

const names = (references: readonly ImageRenderReferenceSpec[]): (string | undefined)[] =>
  references.map((reference) => reference.name);

describe("control reference roles", () => {
  it("keeps every lab fixture role inside the structural vocabulary", () => {
    // The lab's roles are the image of `imageLabControlRole` over its three
    // fixture kinds, plus the legacy generic. If one ever fell outside this list,
    // a fixture would be ordered as ordinary content and rendered rather than
    // obeyed — the exact failure the split vocabularies exist to prevent.
    for (const role of imageLabControlRoles) {
      expect(isImageControlReferenceRole(role)).toBe(true);
    }
  });

  it("treats content roles as content", () => {
    expect(imageControlReferenceRoles).not.toContain("identity");
    expect(isImageControlReferenceRole("identity")).toBe(false);
    expect(isImageControlReferenceRole("style")).toBe(false);
    // Wardrobe is drawn FROM, never obeyed — an outfit routed to a control
    // field would stop competing for the reference slot it belongs in.
    expect(isImageControlReferenceRole("outfit")).toBe(false);
  });
});

describe("controlReferenceTransport", () => {
  const withInput = (roleHint: string, binding: Record<string, unknown>) =>
    model({ advancedCapabilities: { additionalImageInputs: [{ roleHint, binding: { required: false, ...binding } }] } });

  it("sends a control as a numbered image when no version declares a field for it", () => {
    // Every seeded model, and the live Stage 1 path: Qwen Image Edit 2511 takes a
    // pose map as an ordinary numbered image.
    expect(controlReferenceTransport(model(), "pose")).toEqual({ kind: "numbered_reference" });
  });

  it("binds to the declared field, carrying its arity", () => {
    const resolved = controlReferenceTransport(withInput("pose", { field: "pose_image", arity: "single" }), "pose");
    expect(resolved).toEqual({ kind: "dedicated_input", field: "pose_image", arity: "single", maxItems: 1 });
  });

  it("caps a single-arity field at one image whatever maxItems claims", () => {
    const resolved = controlReferenceTransport(
      withInput("depth", { field: "depth_image", arity: "single", maxItems: 4 }),
      "depth",
    );
    expect(resolved).toMatchObject({ maxItems: 1 });
  });

  it("leaves an array field's ceiling to maxItems, unbounded when it declares none", () => {
    const capped = controlReferenceTransport(withInput("edge", { field: "edges", arity: "array", maxItems: 2 }), "edge");
    const open = controlReferenceTransport(withInput("edge", { field: "edges", arity: "array" }), "edge");
    expect(capped).toMatchObject({ maxItems: 2 });
    expect(open).toMatchObject({ maxItems: Number.POSITIVE_INFINITY });
  });

  it("reads a binding onto the primary reference field as the numbered array", () => {
    const resolved = controlReferenceTransport(withInput("pose", { field: "image", arity: "array" }), "pose");
    expect(resolved).toEqual({ kind: "numbered_reference" });
  });

  it("never binds a content role, however the record was probed", () => {
    const resolved = controlReferenceTransport(withInput("identity", { field: "face_image", arity: "single" }), "identity");
    expect(resolved).toEqual({ kind: "numbered_reference" });
  });
});

describe("planIntentReferences", () => {
  it("is a no-op under the empty policy every generate profile carries", () => {
    // The payload-neutrality guarantee, stated where it is decided: no allowlist,
    // no order, no priorities means the caller's own order reaches the provider.
    const references = [ref("style", "a"), ref("identity", "b"), ref("location", "c")];
    const planned = planIntentReferences(model(), emptyImageReferencePolicy(), references);
    expect(names(planned.primary)).toEqual(["a", "b", "c"]);
    expect(planned.dropped).toEqual([]);
    expect(planned.renumbered).toBe(false);
  });

  it("implicitly allows a role the policy requires but forgot to list", () => {
    // A policy that required a role it did not allow would be unsatisfiable: the
    // reference is dropped, then the required-role gate refuses the render it was
    // just dropped from. Reading `requiredRoles` as allowed removes the trap.
    const planned = planIntentReferences(
      model(),
      policy({ allowedRoles: ["style"], requiredRoles: ["identity"] }),
      [ref("identity", "face")],
    );
    expect(names(planned.primary)).toEqual(["face"]);
  });

  it("groups two controls onto one declared field in caller order", () => {
    const withEdges = model({
      advancedCapabilities: {
        additionalImageInputs: [{ roleHint: "edge", binding: { field: "edges", arity: "array", required: false } }],
      },
    });
    const planned = planIntentReferences(withEdges, emptyImageReferencePolicy(), [
      ref("edge", "first"),
      ref("identity", "face"),
      ref("edge", "second"),
    ]);
    expect(planned.dedicated).toHaveLength(1);
    expect(names(planned.dedicated[0]?.references ?? [])).toEqual(["first", "second"]);
    expect(names(planned.primary)).toEqual(["face"]);
  });

  it("reports a dedicated-field overflow in caller order alongside a primary drop", () => {
    // Two drop sources, one ordering guarantee. The dedicated grouping runs last
    // internally, so this is the case that catches an append-after-sort bug.
    const withPose = model({
      maxReferences: 1,
      advancedCapabilities: {
        additionalImageInputs: [{ roleHint: "pose", binding: { field: "pose_image", arity: "single", required: false } }],
      },
    });
    const planned = planIntentReferences(withPose, emptyImageReferencePolicy(), [
      ref("pose", "skeleton-a"),
      ref("identity", "face"),
      ref("pose", "skeleton-b"),
      ref("location", "room"),
    ]);
    expect(names(planned.dropped.map((entry) => entry.reference))).toEqual(["skeleton-b", "room"]);
    expect(planned.dropped.map((entry) => entry.reason)).toEqual(["role_cap", "model_capacity"]);
  });
});

describe("renumbering", () => {
  const three = () => [ref("identity", "a"), ref("location", "b"), ref("style", "c")];

  it("stays quiet when the trim comes off the tail", () => {
    // The common capacity case. Slots 1 and 2 still hold what the lane put there,
    // so a prompt numbering them is still correct.
    const planned = planIntentReferences(model({ maxReferences: 2 }), emptyImageReferencePolicy(), three());
    expect(names(planned.primary)).toEqual(["a", "b"]);
    expect(planned.renumbered).toBe(false);
  });

  it("fires when a removal from the middle shifts a later reference up a slot", () => {
    // The lane's prompt calls "c" Image 3; it now arrives as image 2. Ordering is
    // untouched, which is why an inversion check alone missed this.
    const planned = planIntentReferences(
      model(),
      policy({ allowedRoles: ["identity", "style"] }),
      three(),
    );
    expect(names(planned.primary)).toEqual(["a", "c"]);
    expect(planned.renumbered).toBe(true);
  });

  it("fires when a dedicated control vacates a slot ahead of a kept reference", () => {
    const withPose = model({
      advancedCapabilities: {
        additionalImageInputs: [{ roleHint: "pose", binding: { field: "pose_image", arity: "single", required: false } }],
      },
    });
    const planned = planIntentReferences(withPose, emptyImageReferencePolicy(), [
      ref("identity", "a"),
      ref("pose", "skeleton"),
      ref("location", "c"),
    ]);
    expect(names(planned.primary)).toEqual(["a", "c"]);
    expect(planned.renumbered).toBe(true);
  });

  it("fires when policy ordering moves an image", () => {
    const planned = planIntentReferences(
      model(),
      policy({ allowedRoles: ["identity", "location"], roleOrder: ["location", "identity"] }),
      [ref("identity", "a"), ref("location", "b")],
    );
    expect(names(planned.primary)).toEqual(["b", "a"]);
    expect(planned.renumbered).toBe(true);
  });
});

describe("missingRequiredControlInputs", () => {
  const required = (roleHint: string, field: string) =>
    model({
      advancedCapabilities: {
        additionalImageInputs: [{ roleHint, binding: { field, arity: "single", required: true } }],
      },
    });

  it("names a required control field this render has nothing to put in", () => {
    // A version that refuses to run without its pose input rejects the prediction;
    // the round trip is refused before it is spent.
    const subject = required("pose", "pose_image");
    const planned = planIntentReferences(subject, emptyImageReferencePolicy(), [ref("identity", "face")]);
    expect(missingRequiredControlInputs(subject, planned.dedicated)).toEqual([
      { field: "pose_image", roleHint: "pose" },
    ]);
  });

  it("is satisfied once the role is bound", () => {
    const subject = required("pose", "pose_image");
    const planned = planIntentReferences(subject, emptyImageReferencePolicy(), [
      ref("identity", "face"),
      ref("pose", "skeleton"),
    ]);
    expect(missingRequiredControlInputs(subject, planned.dedicated)).toEqual([]);
  });

  it("ignores an optional declared input", () => {
    const subject = model({
      advancedCapabilities: {
        additionalImageInputs: [{ roleHint: "depth", binding: { field: "depth_image", arity: "single", required: false } }],
      },
    });
    const planned = planIntentReferences(subject, emptyImageReferencePolicy(), []);
    expect(missingRequiredControlInputs(subject, planned.dedicated)).toEqual([]);
  });

  it("ignores a required binding that resolves to the numbered array", () => {
    // It names the primary reference field, so it has no field of its own to be
    // empty — demanding one would refuse every render on such a model.
    const subject = model({
      advancedCapabilities: {
        additionalImageInputs: [{ roleHint: "pose", binding: { field: "image", arity: "array", required: true } }],
      },
    });
    const planned = planIntentReferences(subject, emptyImageReferencePolicy(), [ref("identity", "face")]);
    expect(missingRequiredControlInputs(subject, planned.dedicated)).toEqual([]);
  });

  it("is empty on a model that declares no extra image inputs at all", () => {
    const planned = planIntentReferences(model(), emptyImageReferencePolicy(), [ref("identity", "face")]);
    expect(missingRequiredControlInputs(model(), planned.dedicated)).toEqual([]);
  });
});
