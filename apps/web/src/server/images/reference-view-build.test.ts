import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImageLoraRenderBinding,
  type ImageModel,
  imageModelProfileSchema,
  imageModelSchema,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import { allReferenceViews, referenceViewAngles, type ReferenceView } from "@/contracts";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG } from "@/contracts/images/intimate-scene-lora";
import {
  identityCandidateFixture as candidate,
  identityProvenanceFixture as record,
  laneProbeProfile,
  resolvedImageProfileFixture,
} from "@/server/test-support";

/*
 * The lane cases further down drive `buildReferenceViews` with its IO mocked:
 * the database, the reference-view store, the wardrobe read, the profile
 * resolver, the identity pack, the prompt compiler, the pipeline shell and the
 * render seam. The intimate route itself (`nsfw-lora.ts`) and the plan's age
 * gate run for real; the route's two IO collaborators — the model registry and
 * the LoRA library — are mocked where they live. The fan-out cases directly
 * below touch none of this.
 */
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return {
    ...actual,
    isDemoMode: vi.fn(() => false),
    hasAnyImageProvider: vi.fn(() => true),
    hasImageProviderForModel: vi.fn(() => true),
  };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("./reference-view-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reference-view-store")>();
  return {
    ...actual,
    readAcceptedPortraitSource: vi.fn(),
    reserveReferenceView: vi.fn(),
    finalizeReferenceView: vi.fn(),
    failReferenceView: vi.fn(),
  };
});
vi.mock("./avatar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./avatar")>();
  return { ...actual, loadDefaultWardrobeWithRevisions: vi.fn() };
});
vi.mock("./model-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-profiles")>();
  return { ...actual, resolveImageProfileForTask: vi.fn() };
});
vi.mock("./identity-pack-consume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity-pack-consume")>();
  return { ...actual, identityPackRenderReferences: vi.fn() };
});
vi.mock("./character-prompt-program", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./character-prompt-program")>();
  return { ...actual, buildCharacterPromptProgram: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./asset-deletion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-deletion")>();
  return { ...actual, deleteOwnedImage: vi.fn() };
});
vi.mock("./models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models")>();
  return { ...actual, loadImageModels: vi.fn() };
});
vi.mock("./image-loras", () => ({ resolveImageLoraForRender: vi.fn() }));
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { qualifiedImageModelIdentity } from "../ai";
import { db } from "../db";
import type { ImageRow } from "./asset-storage";
import { runImagePipeline, type ImagePipelineOptions } from "./assets";
import { loadDefaultWardrobeWithRevisions } from "./avatar";
import { buildCharacterPromptProgram, type CharacterPromptProgram } from "./character-prompt-program";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { resolveImageLoraForRender } from "./image-loras";
import { resolveImageProfileForTask } from "./model-profiles";
import { loadImageModels } from "./models";
import { buildReferenceViews, runReferenceViewBuilds } from "./reference-view-build";
import {
  failReferenceView,
  finalizeReferenceView,
  readAcceptedPortraitSource,
  reserveReferenceView,
} from "./reference-view-store";
import { renderImageIntent } from "./render-intent";

/**
 * **One admitted batch renders all at once.**
 *
 * The build used to walk its target list with two workers on a shared cursor,
 * so an eight-view sheet reached the provider in four waves and the owner
 * watched a grid fill two tiles at a time. Nothing about spend was being
 * protected — the daily image budget, backpressure and the per-user job cap all
 * decide that upstream, and the batch is admitted and charged once before this
 * function is reached — so the only thing the throttle bought was latency.
 *
 * Three claims, all invisible in a passing render and cheap to lose again:
 *
 * 1. **Every target starts before any target settles.** The deferred builds
 *    below never resolve until the assertion has run, so a worker pool of any
 *    fixed width fails: it can only have its own width in flight. This is the
 *    concurrency proof the outcome asks for, stated against the fan-out rather
 *    than against a database.
 * 2. **Settlement stays per-slot.** A refusal — a moderated `bare` view is the
 *    expected instance — is one `false` among the results. It may not cancel,
 *    delay or miscount the targets beside it, because each one has already
 *    settled its own row.
 * 3. **A thrown defect fails only after sibling settlement.** Fulfilled workers
 *    must finish their finalization and lease release before the batch reports
 *    the rejection to its shared job.
 *
 * The build of a single view is not re-proven here; `buildOneReferenceView`
 * owns expected failures. The rejection case pins the batch cleanup boundary
 * when a defect breaches that never-throwing contract.
 */

/** A build that hangs until the test releases it, so "started" and "settled" are distinguishable. */
function deferred(): { promise: Promise<boolean>; resolve: (ok: boolean) => void; reject: (reason: unknown) => void } {
  let resolve: (ok: boolean) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<boolean>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("runReferenceViewBuilds", () => {
  it("starts every target before any of them settles, and counts what each one returned", async () => {
    const targets = allReferenceViews();
    const started: string[] = [];
    const pending: Array<ReturnType<typeof deferred>> = [];

    const run = runReferenceViewBuilds(targets, (target) => {
      started.push(`${target.angle}:${target.wardrobe}`);
      const gate = deferred();
      pending.push(gate);
      return gate.promise;
    });

    // Nothing has been allowed to finish yet: a two-worker cursor would show 2.
    expect(started).toHaveLength(targets.length);
    expect(new Set(started).size).toBe(targets.length);

    // The refusal lands first and alone. The rest are still in flight, which is
    // the failure mode worth pinning: one moderated view may not take the sheet.
    pending[0]?.resolve(false);
    for (const gate of pending.slice(1)) gate.resolve(true);

    await expect(run).resolves.toEqual({ built: targets.length - 1, failed: 1 });
  });

  it("waits for every worker to settle before propagating a rejection", async () => {
    const targets = allReferenceViews().slice(0, 2);
    const rejected = deferred();
    const sibling = deferred();
    const finalized: string[] = [];
    let call = 0;
    const failure = new Error("worker defect");

    const run = runReferenceViewBuilds(targets, () => {
      if (call++ === 0) return rejected.promise;
      return sibling.promise.then((ok) => {
        finalized.push("sibling");
        return ok;
      });
    });
    let propagated: unknown;
    const observed = run.then(
      () => "resolved" as const,
      (error: unknown) => { propagated = error; return "rejected" as const; },
    );
    const rejectionObserved = rejected.promise.catch(() => undefined);

    rejected.reject(failure);
    // Wait through the rejected worker and the batch's own reaction turn. A
    // fail-fast Promise.all has propagated by now; this batch must stay pending
    // because its sibling has not finalized yet.
    await rejectionObserved;
    await Promise.resolve();
    expect(propagated).toBeUndefined();
    expect(finalized).toEqual([]);

    sibling.resolve(true);
    await expect(observed).resolves.toBe("rejected");
    expect(finalized).toEqual(["sibling"]);
    expect(propagated).toBe(failure);
  });
});

// ---------------------------------------------------------------------------
// One bare view's intimate route, and the age gate in front of it
// ---------------------------------------------------------------------------

const mockProgram = vi.mocked(buildCharacterPromptProgram);
const mockIntent = vi.mocked(renderImageIntent);
const mockPipeline = vi.mocked(runImagePipeline);
const mockReserve = vi.mocked(reserveReferenceView);
const mockResolveProfile = vi.mocked(resolveImageProfileForTask);
const mockModels = vi.mocked(loadImageModels);
const mockResolveLora = vi.mocked(resolveImageLoraForRender);

const pipelineCalls: ImagePipelineOptions[] = [];

const FRONT_BARE: ReferenceView = { angle: "front_full", wardrobe: "bare" };

/** The deployment's `variant` default on Civitai Qwen Image 2.1 — the owner's 2026-10-01 default. */
const QWEN21_VARIANT: ResolvedImageProfile = {
  model: imageModelSchema.parse({
    id: "imgmdlcivqwen21aaaaaaaa",
    slug: CIVITAI_QWEN_IMAGE_21_SLUG,
    label: "Qwen Image 2.1 (Civitai)",
    canGenerate: true,
    canEdit: true,
    editKind: "multi_reference_compose",
    identityPreservation: "strong",
    referenceField: "images",
    referenceArity: "array",
    maxReferences: 10,
    probedVersionId: "3352534",
  }),
  profile: imageModelProfileSchema.parse({
    id: "imgprfqwen21variantaaaa",
    imageModelId: "imgmdlcivqwen21aaaaaaaa",
    key: "variant-standard",
    label: "Variant Standard",
    task: "variant",
    operation: "edit",
    promptStrategy: "instruction_edit",
  }),
};

/** A `variant` default on 2511 itself — a model the intimate-route policy does not list. */
const QWEN2511_VARIANT = resolvedImageProfileFixture({
  slug: INTIMATE_SCENE_LORA_MODEL_SLUG,
  task: "variant",
  key: "variant-standard",
});

/** The intimate model's REGISTERED row, carrying the two probed LoRA controls. */
function intimateModel(): ImageModel {
  return imageModelSchema.parse({
    id: "imgmdlqwen2511aaaaaaaaaa",
    slug: INTIMATE_SCENE_LORA_MODEL_SLUG,
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    probedVersionId: "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729",
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "lora_weights", type: "string" },
        loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      },
    },
  });
}

const BINDING_2511: ImageLoraRenderBinding = {
  id: INTIMATE_SCENE_LORA_ID,
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
};

/** The probe sheet with its apparent-age band replaced, or removed when `band` is null. */
function profileWithAge(band: string | null) {
  const base = laneProbeProfile();
  return {
    ...base,
    attributes:
      band === null
        ? base.attributes.filter((entry) => entry.id !== "identity.apparent_age")
        : base.attributes.map((entry) => (entry.id === "identity.apparent_age" ? { ...entry, value: band } : entry)),
  };
}

/** The character row the build reads, owned and with an accepted portrait. */
function stubCharacter(profile: ReturnType<typeof profileWithAge>): void {
  const row = {
    id: "chr-nyx",
    ownerId: "usr-1",
    name: "Nyx",
    profile,
    acceptedAvatarImageId: "img-accepted",
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  };
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([row]),
    };
    return chain as unknown as ReturnType<typeof db>;
  });
}

function packOk(): Extract<IdentityPackRenderReferencesResult, { ok: true }> {
  return {
    ok: true,
    references: [
      {
        reference: {
          role: "identity",
          required: true,
          priority: 1,
          sourceImageId: "img-accepted",
          buffer: Buffer.from("pack-bytes"),
        },
        provenance: record("canonical_identity", "img-accepted"),
        candidate: candidate("canonical_identity", true, "img-accepted"),
        source: "uploaded",
        appearanceRevision: null,
      },
    ],
    provenance: [record("canonical_identity", "img-accepted")],
  };
}

/**
 * A compiled program stand-in. The compiler is not under test here — which
 * profile it is asked to compile for, and with what reveal, is.
 */
const COMPILED = {
  kind: "compiled",
  prompt: "the compiled view prompt",
  negativePrompt: null,
  meta: {},
} as unknown as CharacterPromptProgram;

function build(targets?: readonly ReferenceView[]) {
  return buildReferenceViews({
    jobId: "job-1",
    characterId: "chr-nyx",
    ownerId: "usr-1",
    ...(targets === undefined ? {} : { targets }),
  });
}

/** The meta the one reserved view row was written with. */
function reservedMeta(): Record<string, unknown> {
  const meta = pipelineCalls[0]?.asset.meta;
  if (meta === undefined) throw new Error("no view row was reserved");
  return meta;
}

let savedToken: string | undefined;

beforeEach(() => {
  // Cleared, not reset: the `../ai` stubs keep their deployment answers.
  vi.clearAllMocks();
  pipelineCalls.length = 0;
  savedToken = process.env.CIVITAI_API_TOKEN;
  process.env.CIVITAI_API_TOKEN = "civitai-test-token-value";
  stubCharacter(profileWithAge("late_twenties"));
  vi.mocked(readAcceptedPortraitSource).mockResolvedValue({ ok: true, imageId: "img-accepted", contentHash: "hash-1" });
  vi.mocked(loadDefaultWardrobeWithRevisions).mockResolvedValue({ wardrobe: [], revisions: [] });
  mockReserve.mockImplementation(async (input) => `view-${input.view.angle}-${input.view.wardrobe}`);
  vi.mocked(finalizeReferenceView).mockResolvedValue("ready");
  vi.mocked(failReferenceView).mockResolvedValue("failed");
  mockResolveProfile.mockResolvedValue(QWEN21_VARIANT);
  vi.mocked(identityPackRenderReferences).mockResolvedValue(packOk());
  mockProgram.mockReturnValue(COMPILED);
  mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
  // The shell's own order: a precondition fails the row before `produce` runs.
  mockPipeline.mockImplementation(async (opts) => {
    pipelineCalls.push(opts);
    if ((opts.failedPrecondition ?? null) !== null) return { imageId: "img-view", status: "failed" };
    const produced = await opts.produce({ id: "img-view" } as unknown as ImageRow);
    return { imageId: "img-view", status: produced.ok ? "ready" : "failed" };
  });
  mockModels.mockResolvedValue([intimateModel()]);
  mockResolveLora.mockResolvedValue({ ok: true, binding: BINDING_2511 });
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.CIVITAI_API_TOKEN;
  else process.env.CIVITAI_API_TOKEN = savedToken;
});

describe("a bare view's intimate route (#663)", () => {
  it("renders on the resolved Qwen Image 2.1 variant profile, with no LoRA and no 2511", async () => {
    const report = await build([FRONT_BARE]);

    expect(report).toMatchObject({ status: "built", built: 1, failed: 0 });
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.profile).toBe(QWEN21_VARIANT);
    expect(intent && "resolvedLora" in intent).toBe(false);
    // Compiled for the model it renders on, with the anatomy the bare view states.
    expect(mockProgram.mock.calls[0]?.[0]).toMatchObject({ profile: QWEN21_VARIANT, intimateReveal: true });
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockResolveLora).not.toHaveBeenCalled();

    const meta = reservedMeta();
    expect(meta.model).toBe(qualifiedImageModelIdentity(QWEN21_VARIANT.model));
    expect("lora" in meta).toBe(false);
    expect(meta.intimateRoute).toEqual({ lora: null, reason: "no_anatomy_lora_curated" });
  });

  it("keeps the anatomy LoRA on the intimate model when the variant default is a model the policy does not list", async () => {
    mockResolveProfile.mockResolvedValue(QWEN2511_VARIANT);

    await build([FRONT_BARE]);

    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.profile.model.id).toBe("imgmdlqwen2511aaaaaaaaaa");
    expect(intent?.profile.profile).toBe(QWEN2511_VARIANT.profile);
    expect(intent?.resolvedLora).toEqual(BINDING_2511);
    const meta = reservedMeta();
    expect(meta.lora).toBe(INTIMATE_SCENE_LORA_ID);
    expect(meta.intimateRoute).toEqual({ lora: INTIMATE_SCENE_LORA_ID, reason: "anatomy_lora" });
  });

  it("still fails that one view, before spend, when the intimate-model pairing misses a leg", async () => {
    mockResolveProfile.mockResolvedValue(QWEN2511_VARIANT);
    mockModels.mockResolvedValue([]);

    const report = await build([FRONT_BARE]);

    expect(report).toMatchObject({ built: 0, failed: 1 });
    expect(pipelineCalls[0]?.failedPrecondition).toMatch(/^the anatomy LoRA is unavailable \(model\)/);
    expect(mockIntent).not.toHaveBeenCalled();
    expect(vi.mocked(failReferenceView).mock.calls[0]?.[0].failureMessage).toMatch(/\(model\)/);
  });
});

/**
 * THE AGE GATE IS UNCHANGED BY THE ROUTE (#663). The plan drops every bare slot
 * for a character whose apparent age is a minor band or does not resolve, before
 * anything is reserved — so on a deployment whose `variant` default is Qwen
 * Image 2.1 no bare row is ever reserved, no intimate route is ever resolved,
 * and nothing reaches a model, whichever slots the caller asks for.
 */
describe("the age gate in front of the intimate route", () => {
  it.each([
    ["a minor apparent-age band", "teen"],
    ["no resolvable apparent age", null],
  ])("builds no bare view for %s, even when one is asked for by name", async (_label, band) => {
    stubCharacter(profileWithAge(band));

    const report = await build([FRONT_BARE]);

    // The plan is the clothed half of the sheet, one view per angle.
    expect(report).toEqual({ status: "built", planned: referenceViewAngles.length, built: 0, failed: 0 });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockResolveProfile).not.toHaveBeenCalled();
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expect(mockIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["a minor apparent-age band", "teen"],
    ["no resolvable apparent age", null],
  ])("builds only clothed views, with no intimate reveal, for %s's whole sheet", async (_label, band) => {
    stubCharacter(profileWithAge(band));

    await build();

    expect(mockReserve.mock.calls.length).toBeGreaterThan(0);
    expect(mockReserve.mock.calls.every(([input]) => input.view.wardrobe === "clothed")).toBe(true);
    expect(mockProgram.mock.calls.every(([input]) => input.intimateReveal !== true)).toBe(true);
    expect(mockModels).not.toHaveBeenCalled();
    expect(mockResolveLora).not.toHaveBeenCalled();
    expect(pipelineCalls.every((call) => !("intimateRoute" in (call.asset.meta ?? {})))).toBe(true);
  });
});
