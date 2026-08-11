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

  it("names every reference by role under the composing strategy, and only under it", () => {
    // `multi_reference_compose` means "name the purpose and order of each
    // reference", which is what slice 3's general-role wording finally lets this
    // vocabulary say. The comparison against `instruction_edit` is the point: the
    // two strategies must produce genuinely different text, or the enum is
    // describing a difference nothing downstream makes.
    const references = [reference("identity", "avatar"), reference("pose", "skeleton")];
    const composed = planned(intent({ profile: resolved({}, { promptStrategy: "multi_reference_compose" }), references }));
    const plain = planned(intent({ references }));

    expect(composed.prompt).toContain("Image 1: the identity reference");
    expect(composed.prompt).toContain("Image 2: a pose skeleton");
    expect(composed.prompt).toContain("a scene in a warm room");
    expect(plain.prompt).toBe("a scene in a warm room");
  });

  it("tells the model not to draw a control map it is only meant to obey", () => {
    // The failure this wording exists to prevent is not subtle: a model handed a
    // depth map as ordinary content renders the grey gradient.
    const composed = planned(
      intent({
        profile: resolved({}, { promptStrategy: "multi_reference_compose" }),
        references: [reference("identity", "avatar"), reference("depth", "depthmap")],
      }),
    );
    expect(composed.prompt).toContain("Do not draw the depth map.");
    expect(composed.prompt).toContain("never render the control images themselves");
  });

  it("adds no control clause when every reference is ordinary content", () => {
    const composed = planned(
      intent({
        profile: resolved({}, { promptStrategy: "multi_reference_compose" }),
        references: [reference("identity", "avatar"), reference("location", "room")],
      }),
    );
    expect(composed.prompt).not.toContain("never render the control images themselves");
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
    expect(plan.dropped.map((dropped) => dropped.reference.role)).toEqual(["style"]);
    expect(plan.dropped.map((dropped) => dropped.reason)).toEqual(["model_capacity"]);
    expect(plan.referencesRenumbered).toBe(false);
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

  it("drops what matters least rather than whatever arrived last", () => {
    // Slice 3's whole reason for existing. The lane offers style first and the
    // identity anchor last; the profile ranks identity first. The positional trim
    // this replaced would have sent the mood board and dropped the face.
    const policy = {
      referencePolicy: {
        allowedRoles: ["identity", "location", "style"],
        requiredRoles: [],
        roleOrder: ["identity", "location", "style"],
      },
    };
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 2 }, policy),
        references: [reference("style", "mood"), reference("location", "room"), reference("identity", "avatar")],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar", "room"]);
    expect(plan.dropped.map((dropped) => dropped.reference.role)).toEqual(["style"]);
    // The order MOVED, and the flag says so — a lane that numbered these in its
    // prompt would now be describing the wrong images.
    expect(plan.referencesRenumbered).toBe(true);
  });

  it("sorts a required reference ahead of a better-ranked optional one", () => {
    const policy = {
      referencePolicy: {
        allowedRoles: ["identity", "location"],
        requiredRoles: [],
        roleOrder: ["location", "identity"],
      },
    };
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 1 }, policy),
        references: [reference("location", "room"), { ...reference("identity", "avatar"), required: true }],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar"]);
  });

  it("breaks a same-role tie on priority, and leaves unset priorities behind the set ones", () => {
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 2 }),
        references: [
          reference("style", "unranked"),
          { ...reference("style", "weak"), priority: 1 },
          { ...reference("style", "strong"), priority: 9 },
        ],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["strong", "weak"]);
  });

  it("refuses a role the profile does not allow, and says so distinctly from capacity", () => {
    // Three drop reasons exist because they ask three different things of an
    // operator. "The profile never allowed a style reference" is not a bigger
    // model away from being fixed.
    const policy = {
      referencePolicy: { allowedRoles: ["identity"], requiredRoles: ["identity"], roleOrder: ["identity"] },
    };
    const plan = planned(
      intent({
        profile: resolved({}, policy),
        references: [reference("identity", "avatar"), reference("style", "mood")],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar"]);
    expect(plan.dropped).toEqual([
      expect.objectContaining({ reason: "role_not_allowed" }),
    ]);
  });

  it("honours a per-role cap without touching other roles", () => {
    const policy = {
      referencePolicy: {
        allowedRoles: ["identity", "style"],
        requiredRoles: [],
        roleOrder: ["identity", "style"],
        maxPerRole: { style: 1 },
      },
    };
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 3 }, policy),
        references: [reference("identity", "avatar"), reference("style", "mood"), reference("style", "extra")],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar", "mood"]);
    expect(plan.dropped.map((dropped) => dropped.reason)).toEqual(["role_cap"]);
  });

  it("reports drops in caller order however the comparator visited them", () => {
    const policy = {
      referencePolicy: {
        allowedRoles: ["identity", "location"],
        requiredRoles: [],
        roleOrder: ["identity", "location"],
      },
    };
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 1 }, policy),
        references: [reference("style", "mood"), reference("location", "room"), reference("identity", "avatar")],
      }),
    );
    expect(plan.dropped.map((dropped) => dropped.reference.name)).toEqual(["mood", "room"]);
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
    // Checked against what will be SENT, not what was supplied: an identity
    // anchor trimmed away is exactly as absent as one that never arrived.
    //
    // Reaching this state now takes a profile that ranks something ABOVE the role
    // it requires, because priority selection removed the accident that used to
    // cause it — a required identity supplied last no longer loses its slot to a
    // location supplied first. That is the fix, not a gap in the check.
    const contradictory = {
      referencePolicy: {
        allowedRoles: ["identity", "location"],
        requiredRoles: ["identity"],
        roleOrder: ["location", "identity"],
      },
    };
    const result = planImageRender(
      intent({
        profile: resolved({ maxReferences: 1 }, contradictory),
        references: [reference("location", "room"), reference("identity", "avatar")],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("image_profile.required_reference_missing");
  });

  it("no longer loses a required anchor just because the lane supplied it last", () => {
    // The regression this slice exists to prevent, stated as its own case: the
    // exact input above, under a policy that ranks the role it requires.
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 1 }, requiresIdentity),
        references: [reference("location", "room"), reference("identity", "avatar")],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar"]);
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

  it("carries an already-resolved LoRA into the payload it was resolved for", () => {
    // `planImageRender` is pure, so it can only THREAD a binding — the library read
    // that produces one happens in `renderImageIntent` (or in the lab, which
    // pre-resolves so a refusal settles onto its own row). What this proves is that
    // the thread is connected: a binding on the intent reaches the provider fields
    // this version declared.
    const plan = planned(
      intent({
        profile: resolved({
          advancedCapabilities: {
            controls: {
              loraWeights: { field: "lora_weights", type: "string" },
              loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
            },
          },
        }),
        resolvedLora: {
          id: "lora-1",
          label: "Ink Wash",
          locator: "owner/ink-wash-lora",
          scale: 0.8,
          promptPrefix: null,
          promptSuffix: null,
          triggerWords: ["sumi-e"],
        },
      }),
    );
    expect(plan.controlInput).toEqual({ lora_weights: "owner/ink-wash-lora", lora_scale: 0.8 });
    expect(plan.prompt).toBe("a scene in a warm room\n\nsumi-e");
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

describe("control-image roles", () => {
  /** A version that declares its own ControlNet-style input for one role. */
  function withControlInput(
    roleHint: string,
    field: string,
    binding: { arity?: "single" | "array"; maxItems?: number } = {},
  ) {
    return {
      advancedCapabilities: {
        ...CAPABILITIES,
        additionalImageInputs: [
          { roleHint, binding: { field, arity: binding.arity ?? "single", required: false, ...binding } },
        ],
        knownInputFields: [...CAPABILITIES.knownInputFields, field],
      },
    };
  }

  it("rides the numbered references when the version declares no field for the role", () => {
    // Today's live path, and the one Stage 0 proved: Qwen Image Edit 2511 takes a
    // pose map as an ordinary numbered image, so the control is scarce like any
    // other reference and is ordered with them.
    const plan = planned(
      intent({ references: [reference("identity", "avatar"), reference("pose", "skeleton")] }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar", "skeleton"]);
    expect(plan.controlReferences).toEqual([]);
  });

  it("binds a declared control input to its own field, off the primary array", () => {
    const plan = planned(
      intent({
        profile: resolved(withControlInput("pose", "pose_image")),
        references: [reference("identity", "avatar"), reference("pose", "skeleton")],
      }),
    );
    expect(plan.references.map((buffer) => buffer.toString())).toEqual(["avatar"]);
    expect(plan.controlReferences).toEqual([
      { field: "pose_image", arity: "single", buffers: [Buffer.from("skeleton")] },
    ]);
  });

  it("does not spend a primary slot on a control that has its own field", () => {
    // The reason binding happens BEFORE selection: a one-reference model can carry
    // an identity anchor AND a pose map when the pose map is not competing for the
    // array. Computing capacity first would have dropped one of them.
    const plan = planned(
      intent({
        profile: resolved({ maxReferences: 1, ...withControlInput("depth", "depth_image") }),
        references: [reference("identity", "avatar"), reference("depth", "depthmap")],
      }),
    );
    expect(plan.references).toHaveLength(1);
    expect(plan.controlReferences).toHaveLength(1);
    expect(plan.dropped).toEqual([]);
  });

  it("treats a binding that names the primary reference field as a numbered image", () => {
    // "pose goes in `image`" is the numbered array described twice, not a second
    // field. Honoring it literally would overwrite the whole reference list.
    const plan = planned(
      intent({
        profile: resolved(withControlInput("pose", "image")),
        references: [reference("identity", "avatar"), reference("pose", "skeleton")],
      }),
    );
    expect(plan.references).toHaveLength(2);
    expect(plan.controlReferences).toEqual([]);
  });

  it("fills a single-arity control field once and drops the rest", () => {
    const plan = planned(
      intent({
        profile: resolved(withControlInput("pose", "pose_image")),
        references: [reference("pose", "first"), reference("pose", "second")],
      }),
    );
    expect(plan.controlReferences[0]?.buffers).toEqual([Buffer.from("first")]);
    expect(plan.dropped.map((dropped) => dropped.reason)).toEqual(["role_cap"]);
  });

  it("counts a control on its own field as satisfying a required role", () => {
    // It never entered the primary contest, so a required-role check that looked
    // only at the array would refuse a render whose control was sent correctly.
    const policy = {
      referencePolicy: { allowedRoles: ["identity", "pose"], requiredRoles: ["pose"], roleOrder: ["identity", "pose"] },
    };
    const result = planImageRender(
      intent({
        profile: resolved(withControlInput("pose", "pose_image"), policy),
        references: [reference("identity", "avatar"), reference("pose", "skeleton")],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("required control inputs", () => {
  it("refuses before spend when the version demands a control image the render has not got", () => {
    // The version's own demand, as against the profile's. A model that refuses to
    // run without `pose_image` rejects the prediction, so the round trip is
    // refused rather than spent discovering that.
    const result = planImageRender(
      intent({
        profile: resolved({
          advancedCapabilities: {
            ...CAPABILITIES,
            additionalImageInputs: [
              { roleHint: "pose", binding: { field: "pose_image", arity: "single", required: true } },
            ],
          },
        }),
        references: [reference("identity", "avatar")],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("image_profile.required_control_input_missing");
    expect(result.refusal.context.missing).toEqual([{ field: "pose_image", roleHint: "pose" }]);
  });

  it("plans normally once that input is filled", () => {
    const plan = planned(
      intent({
        profile: resolved({
          advancedCapabilities: {
            ...CAPABILITIES,
            additionalImageInputs: [
              { roleHint: "pose", binding: { field: "pose_image", arity: "single", required: true } },
            ],
          },
        }),
        references: [reference("identity", "avatar"), reference("pose", "skeleton")],
      }),
    );
    expect(plan.controlReferences).toHaveLength(1);
  });
});
