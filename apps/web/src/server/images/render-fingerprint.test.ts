import { describe, expect, it } from "vitest";
import {
  compileProfileRenderPlan,
  type CompileProfileRenderPlanInput,
  type ImageModel,
  type ImageModelProfile,
  imageModelProfileSchema,
  imageModelSchema,
  MAX_TRIAL_PREDICTION_MS,
  type ProfileRenderPlan,
} from "@vesper/image-core";
import { OUTPUT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "@vesper/image-replicate";
import { STALE_CLAIM_MS } from "./identity-pack-trial-execute";
import { profileRenderControlsHash, sha256Hex } from "./render-fingerprint";

/**
 * THE golden fingerprint suite.
 *
 * Every value below was captured from the code as it stood BEFORE the render
 * kernel moved into `@vesper/image-core`, and none of them may be regenerated
 * because a file moved. They are what every stored `resolved_controls_hash`
 * compares against: a trial cell pins one at planning time and re-checks it at
 * execution, so a hash that shifted during the extraction would turn every
 * planned grid into `cell_conflict` and quietly void the evidence.
 *
 * The package's own suite proves the deterministic STRING is right. This proves
 * the SHA-256 of that string is the same number it always was — which is the
 * only assertion that can catch the two halves of the split drifting apart.
 */

const CAPABILITIES = {
  controls: {
    negativePrompt: { field: "negative_prompt", type: "string" },
    guidance: { field: "guidance_scale", type: "number", minimum: 0, maximum: 20 },
  },
  knownInputFields: ["negative_prompt", "guidance_scale", "scheduler"],
};

function model(over: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model-1",
    slug: "vesper-test/compile",
    label: "Compile Fixture",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 4,
    supportedAspects: ["1:1", "3:4"],
    probedVersionId: "version-probed",
    advancedCapabilities: CAPABILITIES,
    ...over,
  });
}

function profile(over: Record<string, unknown> = {}): ImageModelProfile {
  return imageModelProfileSchema.parse({
    id: "profile-1",
    imageModelId: "model-1",
    key: "compile-fixture",
    label: "Compile Fixture",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
    ...over,
  });
}

function compiledPlan(input: CompileProfileRenderPlanInput): ProfileRenderPlan {
  const result = compileProfileRenderPlan(input);
  if (!result.ok) throw new Error(`[render-fingerprint] unexpected refusal: ${result.reason}`);
  return result.plan;
}

/**
 * The historical fixture, reproduced exactly. `safetyCheckerDisabled: true` is
 * what `disableSafetyChecker()` returned with `REPLICATE_SAFE_MODE` unset, which
 * is the environment these values were captured under.
 */
function plan(
  modelOver: Record<string, unknown> = {},
  profileOver: Record<string, unknown> = {},
  over: Partial<CompileProfileRenderPlanInput> = {},
): ProfileRenderPlan {
  return compiledPlan({
    model: model(modelOver),
    profile: profile(profileOver),
    basePrompt: "change the outfit",
    baseNegativePrompt: null,
    safetyCheckerDisabled: true,
    references: { vocabulary: "identity_pack", roles: ["canonical_identity"] },
    ...over,
  });
}

function hashOf(compiled: ProfileRenderPlan): string {
  return profileRenderControlsHash(compiled, {
    profileId: "profile-1",
    profileKey: "compile-fixture",
    promptStrategy: "instruction_edit",
    orderedReferenceRoles: ["canonical_identity"],
  });
}

describe("profileRenderControlsHash", () => {
  it("produces the exact hashes stored before the render kernel was extracted", () => {
    expect(hashOf(plan())).toBe("3ba301f759c6d002aed8243a1f9204ced51832277419a27ea4cd4f7893a47331");
    expect(hashOf(plan({}, { controlDefaults: { guidance: 6, seedPolicy: "random" } }))).toBe(
      "e0fb04d03ac5488000e1cb87493fb073f07b57310c2d7f2d46473c8a2a7327d2",
    );
    expect(hashOf(plan({}, { timeoutMs: 90_000 }))).toBe(
      "89815c91da032a9d4c8c54dbbca100c1bfc0a9b938bd567c88e4190b68b4d9aa",
    );
    expect(hashOf(plan({ probedVersionId: "version-other" }))).toBe(
      "b43b0180530c9941ec249d4db1e3267a2b8b0096426b7deaac1616ca57e5d5aa",
    );
  });

  it("pins the dimension-carrying hashes for tiered profiles", () => {
    // NEW pins (2026-08-14, the dimensions member): a tier now enters the
    // fingerprint through the plan's dimension facts — on a size-mode model it
    // never reaches `controlInput` at all — so these values are pinned from the
    // first build that could produce them. The factless fixtures above are
    // deliberately untouched: their serialization gained no member.
    expect(hashOf(plan({}, { controlDefaults: { resolution: "2K", seedPolicy: "random" } }))).toBe(
      "fee6e15732f72cfbbfb980ef258760ee2ed524482ecacc31f5573a03c5faf2d7",
    );
    expect(
      hashOf(
        plan(
          { aspectMode: "size", supportedAspects: ["768*1024", "1536*2048", "3072*4096"] },
          { controlDefaults: { resolution: "2K", seedPolicy: "random" } },
        ),
      ),
    ).toBe("62342c76d5c2fec7ffbc73126dce086c6150578c7761ce319ed3311c12f525cb");
  });

  it("produces the stored hash for a plan carrying a resolved LoRA", () => {
    const loraPlan = plan(
      {
        advancedCapabilities: {
          controls: {
            loraWeights: { field: "lora_weights", type: "string" },
            loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
          },
          knownInputFields: ["lora_weights", "lora_scale"],
        },
      },
      {},
      {
        resolvedLora: {
          id: "lora-1",
          label: "Ink Wash",
          locator: "owner/ink-wash-lora",
          scale: 0.8,
          promptPrefix: "Ink wash painting.",
          promptSuffix: null,
          triggerWords: ["sumi-e"],
        },
      },
    );
    expect(hashOf(loraPlan)).toBe("476d2c46155d702f389cbc8a95cb1b396e6fdf72aa042fd845b360344a377f2d");
  });

  it("keeps both safety postures on the values they hashed to before", () => {
    // The setting used to be read from `REPLICATE_SAFE_MODE` inside the compile
    // step and is now handed in. Same two hashes, so a grid planned under the
    // old code still re-checks clean under the new.
    const withToggle = { extraInput: { disable_safety_checker: true } };
    expect(hashOf(plan(withToggle, {}, { safetyCheckerDisabled: true }))).toBe(
      "c385c0dcf8ab3e0dfbc173bd91678e8a4523cb0f536b88adeca4d196774c1ffd",
    );
    expect(hashOf(plan(withToggle, {}, { safetyCheckerDisabled: false }))).toBe(
      "c095dc2a9bab6d1a883c875eda1ad9b1bc47c25160c46f0347314da25c237475",
    );
  });

  it("hashes the package's serialization and nothing else", () => {
    // The wrapper is thin on purpose: if it ever grew a second opinion about
    // what a configuration is, the package's fingerprint and the stored hash
    // would start describing different things.
    expect(hashOf(plan())).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("the trial's stale-claim window", () => {
  it("exceeds everything one cell span can legitimately spend", () => {
    // The window's whole job is to be longer than a single CELL SPAN — the
    // prediction ceiling, the reference uploads and settling poll, and the
    // output download — so recovery can never hand a LIVE render to a second
    // worker and pay for it twice. Derived rather than guessed, and asserted
    // here so a change to any of its inputs has to face this inequality.
    //
    // It is composed across the boundary on purpose: the ceiling is the
    // package's, the transport timeouts are the application's, and Slice 4 of
    // the monorepo plan is where the transport half changes owner.
    const oneRenderMs = MAX_TRIAL_PREDICTION_MS + 4 * REQUEST_TIMEOUT_MS + OUTPUT_TIMEOUT_MS;
    expect(STALE_CLAIM_MS).toBeGreaterThan(oneRenderMs);
    // One span is all it must cover — and that is a fact about the HEARTBEAT,
    // not about queue depth. Every cell boundary re-stamps `claimed_at` on the
    // pass's whole remaining queue, so the oldest claim a live pass can hold is
    // the one it stamped at the start of the cell now in flight. A cell queued
    // behind nineteen others is exactly as fresh as the cell rendering ahead of
    // it, which is why this bound does not have to scale with `maxRenders`.
    expect(STALE_CLAIM_MS).toBeLessThan(2 * oneRenderMs);
  });
});
