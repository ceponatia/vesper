import { describe, expect, it } from "vitest";
import {
  imageModelProfileCreateRequestSchema,
  imageModelProfileUpdateRequestSchema,
  validateImageProfileConfiguration,
  type ImageModelProfileCreateRequest,
  type ImageProfileConfigurationIssue,
} from "./image-model-profile-admin";
import { withReviewedProfileDefaults } from "./reviewed-profile-controls";
import { imageModelAdvancedCapabilitiesSchema } from "../capabilities/image-model-capabilities";
import { emptyImageReferencePolicy, type ImageModelProfile } from "./image-model-profiles";
import { imageModelSchema, type ImageModel } from "./image-models";

// The same parse-through-schema factories the profile contract tests use: every
// field past the identity ones is defaulted, so a short literal exercises the
// defaults a stored row relies on instead of restating them.
const model = (overrides: Partial<ImageModel> = {}): ImageModel =>
  imageModelSchema.parse({
    id: "mdl",
    slug: "vendor/model",
    label: "Model",
    canGenerate: true,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    ...overrides,
  });

/** The slice `validateImageProfileConfiguration` reads, with inert defaults. */
type ValidatedProfile = Pick<ImageModelProfile, "task" | "operation" | "providerOverrides" | "controlDefaults">;
const profile = (overrides: Partial<ValidatedProfile> = {}): ValidatedProfile => ({
  task: "scene",
  operation: "edit",
  providerOverrides: {},
  controlDefaults: { seedPolicy: "random" },
  ...overrides,
});

const kinds = (issues: ImageProfileConfigurationIssue[]): string[] => issues.map((issue) => issue.kind);

/** Advanced capabilities carrying only a probed known-field list. */
const probedFields = (fields: string[]) => imageModelAdvancedCapabilitiesSchema.parse({ knownInputFields: fields });

/** Advanced capabilities carrying probed CONTROL bindings, and their fields as known. */
const probedControls = (controls: Record<string, { field: string; type: string }>) =>
  imageModelAdvancedCapabilitiesSchema.parse({
    controls,
    knownInputFields: Object.values(controls).map((binding) => binding.field),
  });

describe("imageModelProfileCreateRequestSchema", () => {
  it("defaults a minimal request to the inert seeded-row values", () => {
    const parsed = imageModelProfileCreateRequestSchema.parse({
      key: "scene-standard",
      label: "Scene Standard",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
    });
    expect(parsed.referencePolicy).toEqual(emptyImageReferencePolicy());
    expect(parsed.controlDefaults).toEqual({ seedPolicy: "random" });
    expect(parsed.providerOverrides).toEqual({});
    expect(parsed.timeoutMs).toBeNull();
    expect(parsed.enabled).toBe(true);
    expect(parsed.isDefault).toBe(false);
    expect(parsed.sort).toBe(0);
  });

  it("keeps the defaulted objects unshared between two parsed requests", () => {
    const base = { key: "a", label: "A", task: "scene", operation: "edit", promptStrategy: "instruction_edit" };
    const first = imageModelProfileCreateRequestSchema.parse(base);
    const second = imageModelProfileCreateRequestSchema.parse(base);
    first.referencePolicy.allowedRoles.push("identity");
    first.providerOverrides["go_fast"] = true;
    expect(second.referencePolicy.allowedRoles).toEqual([]);
    expect(second.providerOverrides).toEqual({});
  });

  it("refuses a free-text key — the key is compared, never displayed", () => {
    const request = { label: "X", task: "scene", operation: "edit", promptStrategy: "instruction_edit" };
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, key: "Scene Standard" }).success).toBe(false);
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, key: "-leading" }).success).toBe(false);
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, key: "scene_standard-2" }).success).toBe(true);
  });

  it("bounds the timeout to the table's own check constraint", () => {
    const request = { key: "k", label: "X", task: "scene", operation: "edit", promptStrategy: "instruction_edit" };
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, timeoutMs: 29_999 }).success).toBe(false);
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, timeoutMs: 900_001 }).success).toBe(false);
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, timeoutMs: 30_000 }).success).toBe(true);
    expect(imageModelProfileCreateRequestSchema.safeParse({ ...request, timeoutMs: null }).success).toBe(true);
  });
});

describe("imageModelProfileUpdateRequestSchema", () => {
  it("accepts an empty edit and any single field", () => {
    expect(imageModelProfileUpdateRequestSchema.safeParse({}).success).toBe(true);
    expect(imageModelProfileUpdateRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(imageModelProfileUpdateRequestSchema.safeParse({ timeoutMs: null }).success).toBe(true);
  });

  it("keeps the field rails of the create schema", () => {
    expect(imageModelProfileUpdateRequestSchema.safeParse({ key: "Not A Key" }).success).toBe(false);
    expect(imageModelProfileUpdateRequestSchema.safeParse({ timeoutMs: 1 }).success).toBe(false);
    expect(imageModelProfileUpdateRequestSchema.safeParse({ label: "" }).success).toBe(false);
  });
});

describe("validateImageProfileConfiguration", () => {
  it("passes an eligible profile with no overrides", () => {
    expect(validateImageProfileConfiguration(profile(), model())).toEqual([]);
  });

  it("refuses a generate profile on a model that cannot generate", () => {
    const issues = validateImageProfileConfiguration(
      profile({ operation: "generate" }),
      model({ canGenerate: false }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "ineligible", reason: "operation_unsupported" });
  });

  it("refuses an edit profile on a model that cannot edit, and on a reviewed edit kind of none", () => {
    expect(validateImageProfileConfiguration(profile(), model({ canEdit: false }))[0]).toMatchObject({
      kind: "ineligible",
      reason: "operation_unsupported",
    });
    expect(validateImageProfileConfiguration(profile(), model({ editKind: "none" }))[0]).toMatchObject({
      kind: "ineligible",
      reason: "edit_kind_none",
    });
  });

  it("screens identity-critical tasks on the reviewed rating and mechanism", () => {
    expect(
      validateImageProfileConfiguration(profile({ task: "variant" }), model({ identityPreservation: "weak" }))[0],
    ).toMatchObject({ kind: "ineligible", reason: "identity_too_weak" });
    expect(
      validateImageProfileConfiguration(profile({ task: "chat_look" }), model({ editKind: "img2img" }))[0],
    ).toMatchObject({ kind: "ineligible", reason: "img2img_identity_task" });
    // The same model is fine for a non-identity task: the rating gates the
    // task, not the model.
    expect(
      validateImageProfileConfiguration(profile({ task: "item", operation: "generate" }), model({ editKind: "img2img" })),
    ).toEqual([]);
  });

  it("stays permissive for unknown reviewed ratings", () => {
    expect(
      validateImageProfileConfiguration(
        profile({ task: "scene" }),
        model({ editKind: "unknown", identityPreservation: "unknown" }),
      ),
    ).toEqual([]);
  });

  it("fails CLOSED on overrides when the model has no probed input fields", () => {
    const issues = validateImageProfileConfiguration(profile({ providerOverrides: { go_fast: true } }), model());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "override_rejected", field: "go_fast", reason: "unknown_field" });
    expect(issues[0]?.message).toContain("re-probe");
  });

  it("accepts an override the probed version declares and refuses one it does not", () => {
    const probed = model({ advancedCapabilities: probedFields(["go_fast", "prompt"]) });
    expect(validateImageProfileConfiguration(profile({ providerOverrides: { go_fast: true } }), probed)).toEqual([]);
    const issues = validateImageProfileConfiguration(profile({ providerOverrides: { nope: 1 } }), probed);
    expect(issues[0]).toMatchObject({ kind: "override_rejected", field: "nope", reason: "unknown_field" });
  });

  it("refuses a reserved field even when the probe declares it", () => {
    const probed = model({ advancedCapabilities: probedFields(["prompt", "image", "aspect_ratio", "version"]) });
    const issues = validateImageProfileConfiguration(
      profile({ providerOverrides: { prompt: "x", image: "y", aspect_ratio: "1:1", disable_safety_checker: true } }),
      probed,
    );
    expect(issues.every((issue) => issue.kind === "override_rejected")).toBe(true);
    expect(issues.map((issue) => (issue.kind === "override_rejected" ? issue.reason : ""))).toEqual([
      "reserved",
      "reserved",
      // `disable_safety_checker` is not probed here, but reserved is judged first.
      "reserved",
      "reserved",
    ]);
  });

  it("reports every issue rather than the first, so one save round-trip names them all", () => {
    const issues = validateImageProfileConfiguration(
      profile({ operation: "generate", providerOverrides: { a: 1, b: 2 } }),
      model({ canGenerate: false }),
    );
    expect(kinds(issues)).toEqual(["ineligible", "override_rejected", "override_rejected"]);
  });

  it("empty overrides never fail, whatever the probe state — the fail-closed rule needs an override to close on", () => {
    expect(validateImageProfileConfiguration(profile(), model())).toEqual([]);
  });
});

/**
 * The two pure steps `createImageModelProfile` runs, in its order: seed the
 * model's reviewed settings onto the request, then judge the SEEDED row.
 *
 * The defect the order kills: seeding after validation — or not seeding at all —
 * stores a profile for a reviewed model whose reviewed override the version
 * cannot validate. Nothing refuses it, every render silently drops the setting
 * with a reason nobody reads, and the admin sees a saved profile that quietly
 * runs the wrapper's own preset. Seeding first turns that into the existing
 * save-time refusal, which names the field and the fix.
 */
describe("a created profile's reviewed settings, as the save path composes them", () => {
  const request = (overrides: Record<string, unknown> = {}): ImageModelProfileCreateRequest =>
    imageModelProfileCreateRequestSchema.parse({
      key: "scene-standard",
      label: "Scene Standard",
      task: "scene",
      operation: "edit",
      promptStrategy: "instruction_edit",
      ...overrides,
    });

  const saved = (subject: ImageModel, created: ImageModelProfileCreateRequest) => {
    const seeded = { ...created, ...withReviewedProfileDefaults(subject, created) };
    return { seeded, issues: validateImageProfileConfiguration(seeded, subject) };
  };

  /** SDXL PuLID's production capabilities: guidance on `cfg`, the pair, the two raw keys. */
  const pulidProbed = imageModelAdvancedCapabilitiesSchema.parse({
    controls: {
      guidance: { field: "cfg", type: "number" },
      customWidth: { field: "width", type: "integer" },
      customHeight: { field: "height", type: "integer" },
    },
    knownInputFields: ["cfg", "face_weight", "height", "method", "width"],
  });

  /** The reviewed controls an issue list says this version cannot carry. */
  const unbound = (issues: ImageProfileConfigurationIssue[]): string[] =>
    issues.flatMap((issue) => (issue.kind === "reviewed_control_unbound" ? [issue.control] : []));

  it("carries the reviewed settings of a probed reviewed model, with no issues", () => {
    const { seeded, issues } = saved(
      model({ slug: "nsfw-api/sdxl-pulid:83bea6", advancedCapabilities: pulidProbed }),
      request(),
    );
    expect(seeded.providerOverrides).toEqual({ method: "fidelity", face_weight: 1 });
    expect(seeded.controlDefaults).toMatchObject({ guidance: 7, resolution: "custom", width: 832, height: 1216 });
    expect(issues).toEqual([]);
  });

  it("carries Qwen Edit's accelerated-path ruling as a control, never as an override", () => {
    // A raw override would outrank the caller's own `fastMode` request at the
    // compile step's final merge, so the ruling is a control.
    const { seeded, issues } = saved(
      model({
        slug: "qwen/qwen-image-edit-2511",
        advancedCapabilities: probedControls({ fastMode: { field: "go_fast", type: "boolean" } }),
      }),
      request(),
    );
    expect(seeded.controlDefaults).toMatchObject({ fastMode: false });
    expect(seeded.providerOverrides).toEqual({});
    expect(issues).toEqual([]);
  });

  it("refuses a reviewed control this version declares no binding for", () => {
    // Acceptance 3 for the control channel. Spelling a reviewed setting as a
    // control takes it out of the override validator's reach, and the task
    // profile is now the only thing carrying it: a row saved against a version
    // with no `fastMode` binding would drop it at every render and leave an
    // identity-critical model on the provider's own speed preset.
    const { issues } = saved(model({ slug: "qwen/qwen-image-edit-2511" }), request());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "reviewed_control_unbound", control: "fastMode" });
    expect(issues[0]?.message).toContain("re-probe it first");
  });

  it("says nothing about an ordinary profile's own controls on an unprobed model", () => {
    // The narrowing that keeps this from becoming a second, stricter contract:
    // only a REVIEWED model's REVIEWED controls are asked. A curated profile is
    // free to state a control the version does not bind — the render path drops
    // it with a recorded reason, which is the long-standing answer.
    const issues = validateImageProfileConfiguration(
      profile({ controlDefaults: { seedPolicy: "random", steps: 50, guidance: 3 } }),
      model({ slug: "operator/added-yesterday" }),
    );
    expect(issues).toEqual([]);
  });

  it("refuses an unprobed reviewed model on both channels, and says to re-probe", () => {
    // Acceptance 3: an unprobed configuration fails the EXISTING validation
    // rather than being stored with settings every render would drop. Both
    // channels answer — the two raw keys through the override validator, the
    // three bindable controls through the reviewed-control check.
    const { issues } = saved(model({ slug: "nsfw-api/sdxl-pulid:83bea6" }), request());
    expect(kinds(issues).filter((kind) => kind === "override_rejected")).toHaveLength(2);
    // `resolution` is deliberately absent: it is the gate for the width/height
    // pair and sends no field, so no version binds it and no save may wait on it.
    expect(unbound(issues)).toEqual(["guidance", "width", "height"]);
    for (const issue of issues) expect(issue.message).toContain("re-probe it first");
  });

  it("adds nothing to a request for an unreviewed model", () => {
    const { seeded, issues } = saved(model({ slug: "operator/added-yesterday" }), request());
    expect(seeded.providerOverrides).toEqual({});
    expect(seeded.controlDefaults).toEqual({ seedPolicy: "random" });
    expect(issues).toEqual([]);
  });
});
