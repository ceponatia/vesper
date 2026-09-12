import {
  type ImageModel,
  imageModelProfileSchema,
  imageModelSchema,
  type ImageModelProfile,
  type ImageRenderControls,
  type ImageRenderIntent,
  planImageRender,
  type PlannedImageRender,
  withReviewedImageQuality,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { buildPayload, previewRegistryModelInput } from "./payload";

/**
 * The FINAL WIRE for `fastMode`: an operator's accelerated-sampling choice
 * travels intent → compiled plan → the payload builder the transport POSTs, and
 * it beats the model row's own `extra_input` pin.
 *
 * It exists for the same class of defect as the LoRA wire suite beside it, and
 * is caught the same way — by holding a record against the bytes rather than
 * each layer against its neighbour. `imageRenderControlsSchema` declared
 * `fastMode`, `mapImageRenderControls` mapped it, and the probe bound it to
 * `go_fast`; the merge in `compileProfileRenderPlan` simply never listed it, so
 * a caller's value reached the mapper as `undefined` and vanished with no
 * `applied` entry and no `dropped` entry to show for it. Observed on Fly
 * release v249 against `black-forest-labs/flux-2-klein-4b-base` (2026-09-12):
 * runs asking for `fastMode: false` recorded `appliedControls: {seed, guidance}`
 * and `droppedControls: []` while their payload carried `go_fast: true` from
 * the row's pin, Replicate answered `metrics.model_variant: "go_fast"`, and two
 * Fast-OFF/Fast-ON pairs differing in nothing else returned byte-identical
 * images.
 *
 * The compile step's own half of the claim — what `controlInput`,
 * `appliedControls` and `droppedControls` say, and which layer outranks which —
 * is pinned in `@vesper/image-core`'s `compile-profile-plan.test.ts`. What this
 * suite adds is the half that package cannot see: the ORDER in the assembled
 * payload. `buildRegistryModelInput` writes `extraInput` and
 * `overlayControlInput` merges the mapped control over it afterwards, refusing
 * only `reservedImageInputFields` — which `go_fast` is not a member of. That is
 * a reading of two functions; this is a measurement of the result.
 *
 * No network, no database, no environment: both builders are pure, and
 * `previewRegistryModelInput` is the same assembly the Image Generator STORES
 * as its pre-spend record, so the first case proves the stored record and the
 * send agree about acceleration.
 */

/** The deployment posture every case plans and builds under; not what is under test. */
const SAFETY_CHECKER_DISABLED = true;

/** Stands in for the short-lived Replicate file URL an uploaded reference becomes. */
const REFERENCE_URI = "https://replicate.delivery/pbxt/bench-reference.webp";

/**
 * Every case is SEEDED, and for a reason that is about the drop list rather
 * than about reproducibility.
 *
 * The Generator's synthetic profile carries `seedPolicy: "caller"`, and
 * `compileProfileRenderPlan` records `{ seedPolicy, no_seed_transport }` for a
 * non-random policy no caller resolved — a true fact, and unrelated noise in a
 * suite whose whole subject is which entry `fastMode` leaves behind. Seeding
 * makes `droppedControls` say exactly one thing, and it is also what the live
 * runs did: the Fast-OFF evidence recorded `appliedControls: {seed, guidance}`.
 */
const BENCH_SEED = 20260912;

/**
 * The FLUX.2 klein 4B row migration 0136 seeds, in the parts that decide this
 * question: `go_fast` bound as a normalized `fastMode` control, and the
 * accelerated path PINNED ON in `extra_input` — which is the opposite of the
 * provider's own default, and the reason a dropped control was invisible rather
 * than merely inert.
 *
 * The DISTILLED row, while the live evidence above came from its `-base`
 * sibling. 0136 gives both the same `go_fast` binding and the same pin, and
 * `image-model-seeds.int.test.ts` is what holds that claim about the real rows;
 * the distilled shape is used here because `-base`'s extra `guidance` binding
 * would put a second applied control in every assertion for no added claim.
 */
const KLEIN_4B: ImageModel = imageModelSchema.parse({
  id: "imgmdlklein4baaaaaaaaaaa",
  slug: "black-forest-labs/flux-2-klein-4b",
  label: "FLUX.2 klein 4B",
  canGenerate: true,
  canEdit: true,
  // `unknown` is what migration 0136 wrote: the row is untried, and no edit
  // kind has been reviewed for it.
  editKind: "unknown",
  referenceField: "images",
  referenceArity: "array",
  referenceTransport: "file",
  maxReferences: 5,
  outputFormat: "webp",
  extraInput: { disable_safety_checker: true, output_quality: 95, go_fast: true },
  probedVersionId: "8e9c42d77b10a2a41af823ac4500f7545be6ebc4e745830fc3f3de10de200542",
  advancedCapabilities: {
    controls: {
      seed: { field: "seed", type: "integer" },
      fastMode: { field: "go_fast", type: "boolean" },
    },
    knownInputFields: ["go_fast", "images", "output_format", "output_megapixels", "output_quality", "prompt", "seed"],
  },
});

/** The Image Generator's synthetic profile, as `imageGeneratorProfile` builds it: no stored overrides of its own. */
const BENCH_PROFILE: ImageModelProfile = imageModelProfileSchema.parse({
  id: "image-generator/run",
  imageModelId: KLEIN_4B.id,
  key: "image-generator",
  label: "Image Generator",
  task: "item",
  operation: "edit",
  promptStrategy: "instruction_edit",
  referencePolicy: { allowedRoles: [], requiredRoles: [], roleOrder: [], identityStrategy: "canonical_only" },
  controlDefaults: { seedPolicy: "caller" },
});

/**
 * One bench request, planned and then assembled BOTH ways the Generator
 * assembles it: the body `runRegistryImageModel` posts, and the copy
 * `image-generator-provenance.ts` stores before spending. Returned together
 * because a run graded against a stored payload that disagrees with the sent
 * one is the same failure this suite exists to catch, one layer over.
 */
function wire(
  controls: ImageRenderControls,
  model: ImageModel = KLEIN_4B,
  profile: ImageModelProfile = BENCH_PROFILE,
): { plan: PlannedImageRender; sent: Record<string, unknown>; recorded: Record<string, unknown> } {
  const intent: ImageRenderIntent = {
    profile: { model, profile },
    prompt: "a bench render",
    references: [{ role: "reference", buffer: Buffer.from("bench-reference"), required: true }],
    target: { aspectRatio: null },
    // The seed first, so a case that wants its own still wins.
    controls: { seed: BENCH_SEED, ...controls },
  };
  const result = planImageRender(intent, { safetyCheckerDisabled: SAFETY_CHECKER_DISABLED });
  if (!result.ok) {
    throw new Error(`[fast-mode-final-wire] the plan was refused: ${result.refusal.code} — ${result.refusal.message}`);
  }
  const plan = result.plan;
  // The reviewed-quality seam is applied by the TRANSPORT, so both assemblies
  // below take the row through it exactly as `renderWithModel` does.
  const prepared = withReviewedImageQuality(plan.model);
  const sent = buildPayload(
    prepared,
    { prompt: plan.prompt, aspect: null, controlInput: plan.controlInput, policy: plan.policy },
    plan.references.map(() => REFERENCE_URI),
    [],
    SAFETY_CHECKER_DISABLED,
  );
  const recorded = previewRegistryModelInput({
    model: prepared,
    prompt: plan.prompt,
    referenceCount: plan.references.length,
    aspect: null,
    controlInput: plan.controlInput,
    policy: plan.policy,
    safetyCheckerDisabled: SAFETY_CHECKER_DISABLED,
  });
  return { plan, sent, recorded };
}

describe("a fastMode request reaching the Replicate payload", () => {
  it("sends go_fast: false over a row that pins the accelerated path on", () => {
    // Fixture honesty, not ceremony: the case only proves the control wins
    // while the row genuinely pins the opposite. Flip this pin and it stops
    // being a test.
    expect(KLEIN_4B.extraInput.go_fast).toBe(true);

    const { plan, sent, recorded } = wire({ fastMode: false });
    // The compile step's record first — the half that was silent, and the half
    // an operator reads when asking what a run was configured as.
    expect(plan.appliedControls.fastMode).toBe(false);
    expect(plan.droppedControls).toEqual([]);
    // Then the bytes, and then the pre-spend copy they are graded against.
    expect(sent.go_fast).toBe(false);
    expect(recorded.go_fast).toBe(false);
  });

  it("sends go_fast: true when the operator asks for acceleration", () => {
    const { plan, sent } = wire({ fastMode: true });
    expect(plan.appliedControls.fastMode).toBe(true);
    expect(sent.go_fast).toBe(true);
  });

  it("leaves the row's own pin standing when nothing asks", () => {
    // The control the first case needs to mean anything: `go_fast: false` must
    // come from the REQUEST, never from the binding existing. An unasked run
    // still ships the row's pin, exactly as it did before this merge carried
    // `fastMode` at all.
    const { plan, sent } = wire({});
    expect(plan.appliedControls.fastMode).toBeUndefined();
    expect(sent.go_fast).toBe(true);
  });

  it("writes no acceleration key at all on a row that neither pins nor binds one", () => {
    const unbound = imageModelSchema.parse({
      ...KLEIN_4B,
      id: "imgmdlklein4bnogofastaaa",
      slug: "vesper-test/no-go-fast",
      extraInput: { output_quality: 95 },
      advancedCapabilities: { controls: { seed: { field: "seed", type: "integer" } }, knownInputFields: ["seed"] },
    });
    const profile = imageModelProfileSchema.parse({ ...BENCH_PROFILE, imageModelId: unbound.id });
    const { plan, sent } = wire({ fastMode: false }, unbound, profile);
    // Refused VISIBLY — a request this version has nowhere to put is a fact the
    // run record carries, not a value that disappears on the way to a payload.
    expect(plan.droppedControls).toEqual([{ control: "fastMode", reason: "no_binding" }]);
    expect("go_fast" in sent).toBe(false);
  });
});
