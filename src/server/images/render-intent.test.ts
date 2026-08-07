import { describe, expect, it } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  type ImageModel,
  type ImageModelProfile,
  type ResolvedImageProfile,
} from "@/contracts";
import { planImageRender, type ImageRenderIntent, type ImageRenderReference } from "./render-intent";

/**
 * The intent's contract, asserted where it is cheapest: rows and buffers in, the
 * exact provider-bound plan out. No database, no provider.
 *
 * The property most of these cases defend is PAYLOAD NEUTRALITY. Slice 2 moved
 * seven lanes off `resolveSurfaceModel` + `renderWithModel` and onto this path,
 * and the seeded profiles were written so that move changes which row the
 * configuration came from and nothing about what the provider receives. A case
 * here that starts failing means a lane's renders moved.
 */

const CAPABILITIES = {
  controls: {
    negativePrompt: { field: "negative_prompt", type: "string" },
    guidance: { field: "guidance_scale", type: "number", minimum: 0, maximum: 20 },
  },
  knownInputFields: ["negative_prompt", "guidance_scale"],
};

function model(over: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model-1",
    slug: "vesper-test/intent",
    label: "Intent Fixture",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    supportedAspects: ["1:1", "3:4"],
    advancedCapabilities: CAPABILITIES,
    ...over,
  });
}

function profile(over: Record<string, unknown> = {}): ImageModelProfile {
  return imageModelProfileSchema.parse({
    id: "profile-1",
    imageModelId: "model-1",
    key: "scene-standard",
    label: "Scene Standard",
    task: "scene",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...over,
  });
}

function resolved(modelOver: Record<string, unknown> = {}, profileOver: Record<string, unknown> = {}): ResolvedImageProfile {
  return { model: model(modelOver), profile: profile(profileOver) };
}

function reference(role: ImageRenderReference["role"], name: string): ImageRenderReference {
  return { role, name, buffer: Buffer.from(name) };
}

function intent(over: Partial<ImageRenderIntent> = {}): ImageRenderIntent {
  return {
    profile: resolved(),
    prompt: "a scene in a warm room",
    references: [],
    target: { aspectRatio: 3 / 4 },
    ...over,
  };
}

/** Plan and UNWRAP — a refusal in a case that wants a plan is a broken fixture. */
function planned(input: ImageRenderIntent) {
  const result = planImageRender(input);
  if (!result.ok) throw new Error(`[render-intent] unexpected refusal: ${result.refusal.code}`);
  return result.plan;
}

describe("prompt neutrality", () => {
  it("sends the lane's prompt unchanged, however many references it carries", () => {
    // The property the whole migration rests on. The identity-pack vocabulary
    // prefixes numbered "Image N:" bindings at two or more references; production
    // must NOT, because the lane's own builder already named them — the scene
    // builder writes its multi-reference bindings, and adding a second set would
    // describe the same images twice, in two conventions, on every multi-reference
    // scene that renders today.
    const one = planned(intent({ references: [reference("identity", "avatar")] }));
    const two = planned(intent({ references: [reference("identity", "avatar"), reference("location", "room")] }));
    expect(one.prompt).toBe("a scene in a warm room");
    expect(two.prompt).toBe("a scene in a warm room");
  });

  it("refuses a strategy this path has no wording for, rather than sending a lesser one", () => {
    // `multi_reference_compose` means "name the purpose and order of each
    // reference". The general role vocabulary has no such wording yet (slice 3),
    // and returning the base prompt would let a profile claim the composing
    // strategy while sending text identical to `instruction_edit`.
    const result = planImageRender(
      intent({ profile: resolved({}, { promptStrategy: "multi_reference_compose" }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("image_profile.prompt_strategy_unsupported");
    expect(result.refusal.context.promptStrategy).toBe("multi_reference_compose");
  });

  it("refuses the four strategies that have no implementation anywhere", () => {
    for (const promptStrategy of ["text_repair", "example_transform", "style_render", "coherent_set"] as const) {
      expect(planImageRender(intent({ profile: resolved({}, { promptStrategy }) })).ok).toBe(false);
    }
  });
});

describe("reference selection", () => {
  it("keeps caller order and reports what capacity left behind", () => {
    const refs = [reference("identity", "avatar"), reference("location", "room"), reference("style", "mood")];
    const plan = planned(intent({ profile: resolved({ maxReferences: 2 }), references: refs }));
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar", "room"]);
    expect(plan.dropped.map((dropped) => dropped.role)).toEqual(["style"]);
  });

  it("sends nothing to a model that cannot take references at all", () => {
    const plan = planned(
      intent({
        profile: resolved({ canEdit: false }, { operation: "generate", promptStrategy: "text_to_image_description" }),
        references: [reference("identity", "avatar")],
      }),
    );
    expect(plan.references).toEqual([]);
    expect(plan.dropped).toHaveLength(1);
  });

  it("never reports more than one reference for a single-arity model", () => {
    const plan = planned(
      intent({
        profile: resolved({ referenceArity: "single" }),
        references: [reference("identity", "avatar"), reference("location", "room")],
      }),
    );
    expect(plan.references).toHaveLength(1);
  });
});

describe("required reference roles", () => {
  const requiresIdentity = { referencePolicy: { allowedRoles: ["identity"], requiredRoles: ["identity"], roleOrder: ["identity"] } };

  it("refuses before any provider work when a required role was never supplied", () => {
    // A variant profile requires an identity reference. Rendering without one
    // would produce a stranger and bill for it, so this fails at planning.
    const result = planImageRender(intent({ profile: resolved({}, requiresIdentity), references: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("image_profile.required_reference_missing");
    expect(result.refusal.context.missing).toEqual(["identity"]);
  });

  it("refuses when capacity pushed the required role out", () => {
    // Checked against the SELECTED references, not the supplied ones: an identity
    // anchor trimmed away is exactly as absent as one that never arrived.
    const result = planImageRender(
      intent({
        profile: resolved({ maxReferences: 1 }, requiresIdentity),
        references: [reference("location", "room"), reference("identity", "avatar")],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("image_profile.required_reference_missing");
  });

  it("passes a policy that requires nothing, which is what every seeded scene profile carries", () => {
    // The scene ladder's `generate` rung legitimately runs with zero references.
    expect(planImageRender(intent({ references: [] })).ok).toBe(true);
  });
});

describe("controls and budget", () => {
  it("maps the profile's defaults onto the version's real field names", () => {
    const plan = planned(
      intent({ profile: resolved({}, { controlDefaults: { negativePrompt: "blurry", guidance: 6, seedPolicy: "random" } }) }),
    );
    expect(plan.controlInput).toEqual({ negative_prompt: "blurry", guidance_scale: 6 });
  });

  it("sends no control keys at all for the inert defaults every seeded profile carries", () => {
    // This is payload neutrality in one line: 17 seeded profiles store `{}`, so
    // routing a lane through the intent adds nothing to its payload.
    expect(planned(intent()).controlInput).toEqual({});
  });

  it("merges a per-render control over the profile's stored default", () => {
    const plan = planned(
      intent({
        profile: resolved({}, { controlDefaults: { guidance: 6, negativePrompt: "blurry", seedPolicy: "random" } }),
        controls: { guidance: 9 },
      }),
    );
    expect(plan.controlInput).toEqual({ negative_prompt: "blurry", guidance_scale: 9 });
  });

  it("leaves the prediction budget to the environment when the profile declares none", () => {
    // A compiled plan always carries a NUMBER so a trial cell can hash its own
    // deadline. Production must not inherit that: all 17 seeded profiles store
    // null, and honoring the compile step's five-minute fallback here would
    // silently replace REPLICATE_PREDICTION_TIMEOUT_MS for every lane.
    expect(planned(intent()).timeoutMs).toBeNull();
    expect(planned(intent({ profile: resolved({}, { timeoutMs: 90_000 }) })).timeoutMs).toBe(90_000);
  });
});

describe("target shape", () => {
  it("carries the lane's requested ratio through untouched", () => {
    // The entity and place lanes are the reason this is not a constant: items are
    // square and establishing shots are 3:2.
    expect(planned(intent({ target: { aspectRatio: 1 } })).targetRatio).toBe(1);
    expect(planned(intent({ target: { aspectRatio: 3 / 2 } })).targetRatio).toBe(3 / 2);
  });
});
