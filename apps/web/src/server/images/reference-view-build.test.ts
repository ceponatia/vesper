import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImageLoraRenderBinding,
  type ImageModel,
  imageModelProfileSchema,
  imageModelSchema,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import {
  allReferenceViews,
  referenceViewAngles,
  referenceViewUpstream,
  referenceViewUpstreamBinding,
  type ReferenceView,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG } from "@/contracts/images/intimate-scene-lora";
import {
  identityCandidateFixture as candidate,
  identityProvenanceFixture as record,
  laneProbeProfile,
  resolvedImageProfileFixture,
} from "@/server/test-support";

/*
 * The lane cases further down drive `buildReferenceViews` with its IO mocked:
 * the database, the reference-view store, the consumable-view seam, the
 * wardrobe read, the profile resolver, the identity pack, the prompt compiler,
 * the pipeline shell and the render seam. The intimate route itself (`nsfw-lora.ts`) and the plan's age
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
vi.mock("./body-reference-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./body-reference-store")>();
  return { ...actual, loadBodyReferencesForBuild: vi.fn() };
});
vi.mock("./reference-view-consume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reference-view-consume")>();
  return { ...actual, loadConsumableReferenceView: vi.fn() };
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
import { loadBodyReferencesForBuild, type LoadedBodyReference } from "./body-reference-store";
import {
  buildCharacterPromptProgram,
  type CharacterPromptProgram,
  IMAGE_CHARACTER_PROMPT_NON_ADULT_EXPOSED,
} from "./character-prompt-program";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { resolveImageLoraForRender } from "./image-loras";
import { resolveImageProfileForTask } from "./model-profiles";
import { loadImageModels } from "./models";
import {
  buildReferenceViews,
  REFERENCE_VIEW_BODY_REFERENCE_DROPPED,
  REFERENCE_VIEW_UPSTREAM_UNAPPROVED,
  referenceViewBodyRoutes,
  runReferenceViewBuilds,
} from "./reference-view-build";
import { loadConsumableReferenceView, REFERENCE_VIEW_DROPPED_FOR_CAPACITY } from "./reference-view-consume";
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
 * profile it is asked to compile for, and with what reveal and references, is.
 * It sends every reference it was handed, as a model with room for all of them
 * would; the capacity case overrides that.
 */
function compiledFrom(input: Parameters<typeof buildCharacterPromptProgram>[0]): CharacterPromptProgram {
  return {
    kind: "compiled",
    prompt: "the compiled view prompt",
    negativePrompt: null,
    meta: {},
    sentReferences: input.references.map((entry) => entry.reference),
    droppedReferences: [],
  } as unknown as CharacterPromptProgram;
}

/** The approved upstream view the consumable seam hands over, named after its slot. */
function upstreamFor(view: ReferenceView) {
  return {
    ok: true as const,
    attemptId: `rv-${view.angle}-${view.wardrobe}`,
    // A restored copy's lineage differs from its attempt id; the row records the lineage.
    lineageId: `lineage-${view.angle}-${view.wardrobe}`,
    imageId: `img-rv-${view.angle}-${view.wardrobe}`,
    buffer: Buffer.from("upstream-bytes"),
    sourceImageId: "img-accepted",
    faceVisibility: "full" as const,
    appearanceRevision: "v1:upstream",
  };
}

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
  // No body images unless a case gives the character some.
  vi.mocked(loadBodyReferencesForBuild).mockResolvedValue({ sendable: [], loaded: [] });
  mockReserve.mockImplementation(async (input) => `view-${input.view.angle}-${input.view.wardrobe}`);
  vi.mocked(finalizeReferenceView).mockResolvedValue("ready");
  vi.mocked(failReferenceView).mockResolvedValue("failed");
  mockResolveProfile.mockResolvedValue(QWEN21_VARIANT);
  vi.mocked(identityPackRenderReferences).mockResolvedValue(packOk());
  mockProgram.mockImplementation(compiledFrom);
  vi.mocked(loadConsumableReferenceView).mockImplementation(async (input) => upstreamFor(input.view));
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

/**
 * NO NON-ADULT IS DRAWN UNDRESSED, NOT EVEN ON A `clothed` VIEW (owner ruling
 * 2026-10-01). A character with no saved outfit reads bare on the clothed axis
 * too, and exposure facts are stated on every route — so a minor's `clothed`
 * view would describe them bare on any model. The prompt seam refuses it; this
 * runs the REAL compiler (the suite stubs it elsewhere) to pin that the view's
 * row fails before spend with the seam's words, which name the fix.
 */
describe("a minor's clothed view with no saved outfit", () => {
  const FRONT_CLOTHED: ReferenceView = { angle: "front_full", wardrobe: "clothed" };

  it("fails that view before spend, saying a saved outfit is needed", async () => {
    const actual = await vi.importActual<typeof import("./character-prompt-program")>("./character-prompt-program");
    mockProgram.mockImplementation(actual.buildCharacterPromptProgram);
    stubCharacter(profileWithAge("teen"));
    const sink = new DiagnosticCollector();

    const report = await buildReferenceViews({
      jobId: "job-1",
      characterId: "chr-nyx",
      ownerId: "usr-1",
      targets: [FRONT_CLOTHED],
      sink,
    });

    expect(report).toMatchObject({ built: 0, failed: 1 });
    expect(mockIntent).not.toHaveBeenCalled();
    const failure = vi.mocked(failReferenceView).mock.calls[0]?.[0].failureMessage;
    expect(failure).toContain("does not resolve to an adult");
    expect(failure).toContain("saved outfit");
    expect(sink.items.some((item) => item.code === IMAGE_CHARACTER_PROMPT_NON_ADULT_EXPOSED)).toBe(true);
  });
});

/**
 * **A view renders from the approved view it is built from** (#670).
 *
 * The sheet shares one body because each dependent view renders with its
 * upstream view beside the identity pack. Four claims, each silent in a
 * passing render:
 *
 * 1. The upstream rides as an OPTIONAL identity reference AFTER the pack's
 *    required anchors, introduced in the registry's own words and stamped with
 *    the upstream asset's appearance revision. A lane that put it first, or
 *    sent it required, would let a view stand in for the portrait's face.
 * 2. The row records the upstream attempt it was rendered from, which is what
 *    lets the view go stale when that attempt is replaced.
 * 3. An upstream that is not approved reserves and renders NOTHING: a view of
 *    an unapproved body is the exact failure the order exists to stop.
 * 4. A model with no room for the upstream records no upstream, because the
 *    view never depended on it.
 */
describe("a dependent view's upstream reference", () => {
  const ROOT_VIEW: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
  const BACK_CLOTHED: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
  const BACK_BARE: ReferenceView = { angle: "back_full", wardrobe: "bare" };

  it.each([
    ["another angle dressed, from the front dressed", BACK_CLOTHED],
    ["an undressed view, from its own angle dressed", BACK_BARE],
  ])("sends %s behind the pack, and records it", async (_label, view) => {
    const upstream = referenceViewUpstream(view);
    if (upstream === null) throw new Error("fixture view has no upstream");
    const loaded = upstreamFor(upstream);

    const report = await build([view]);

    expect(report).toMatchObject({ built: 1, failed: 0 });
    expect(vi.mocked(loadConsumableReferenceView).mock.calls[0]?.[0]).toMatchObject({ view: upstream });
    expect(mockReserve.mock.calls[0]?.[0]).toMatchObject({ view, upstreamViewId: loaded.lineageId });

    const references = mockProgram.mock.calls[0]?.[0].references ?? [];
    expect(references).toHaveLength(2);
    expect(references[0]?.reference).toMatchObject({ role: "identity", required: true, sourceImageId: "img-accepted" });
    expect(references[1]).toMatchObject({
      reference: { role: "identity", required: false, sourceImageId: loaded.imageId },
      subjectId: "chr-nyx",
      description: referenceViewUpstreamBinding(view),
      appearanceRevision: loaded.appearanceRevision,
    });
    // The renderer receives the same list in the same order the prompt numbered.
    expect(mockIntent.mock.calls[0]?.[0].references).toEqual(references.map((entry) => entry.reference));

    expect(vi.mocked(finalizeReferenceView).mock.calls[0]?.[0]).toMatchObject({ upstreamViewId: loaded.lineageId });
    expect(reservedMeta().referenceView).toMatchObject({
      upstream: {
        angle: upstream.angle, wardrobe: upstream.wardrobe, attemptId: loaded.attemptId, lineageId: loaded.lineageId, imageId: loaded.imageId,
      },
    });
  });

  it("sends no upstream for the root view, and records none", async () => {
    await build([ROOT_VIEW]);

    expect(loadConsumableReferenceView).not.toHaveBeenCalled();
    expect(mockReserve.mock.calls[0]?.[0]).toMatchObject({ upstreamViewId: null });
    expect(mockProgram.mock.calls[0]?.[0].references).toHaveLength(1);
    expect(vi.mocked(finalizeReferenceView).mock.calls[0]?.[0]).toMatchObject({ upstreamViewId: null });
    expect(reservedMeta().referenceView).not.toHaveProperty("upstream");
  });

  it("reserves and renders nothing when the view it is built from is not approved", async () => {
    vi.mocked(loadConsumableReferenceView).mockResolvedValue({ ok: false, reason: "unreviewed" });
    const sink = new DiagnosticCollector();

    const report = await buildReferenceViews({
      jobId: "job-1",
      characterId: "chr-nyx",
      ownerId: "usr-1",
      targets: [BACK_CLOTHED],
      sink,
    });

    expect(report).toMatchObject({ built: 0, failed: 1 });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
    expect(mockIntent).not.toHaveBeenCalled();
    expect(sink.items.some((item) => item.code === REFERENCE_VIEW_UPSTREAM_UNAPPROVED)).toBe(true);
  });

  it("records no upstream when the model had no room to send it", async () => {
    mockProgram.mockImplementation((input) => ({
      ...compiledFrom(input),
      // A one-slot model: the pack's required anchor took the only slot.
      sentReferences: input.references.slice(0, 1).map((entry) => entry.reference),
    }));
    const sink = new DiagnosticCollector();

    const report = await buildReferenceViews({
      jobId: "job-1",
      characterId: "chr-nyx",
      ownerId: "usr-1",
      targets: [BACK_CLOTHED],
      sink,
    });

    expect(report).toMatchObject({ built: 1, failed: 0 });
    expect(vi.mocked(finalizeReferenceView).mock.calls[0]?.[0]).toMatchObject({ upstreamViewId: null });
    expect(reservedMeta().referenceView).not.toHaveProperty("upstream");
    expect(sink.items.some((item) => item.code === REFERENCE_VIEW_DROPPED_FOR_CAPACITY)).toBe(true);
  });
});

/**
 * **A view renders with the character's body images** (#671).
 *
 * Four claims, each silent in a passing render:
 *
 * 1. Routing: a dressed view sends every body image, dressed ones first; an
 *    undressed view sends the undressed ones only — after the pack's required
 *    anchors and the upstream view, as OPTIONAL `body` references of the
 *    character. A lane that sent one as an identity reference would let a body
 *    photograph's face into the identity lock.
 * 2. The reservation carries the set the worker read, so the store can refuse
 *    a render of a set the owner has since changed.
 * 3. Only the images the program actually sends are recorded, and the renderer
 *    receives exactly the program's send list.
 * 4. A body image the program could not send is said, with the program's own
 *    reason, and the view still renders.
 */
describe("the character's body images", () => {
  const ROOT_VIEW: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
  const BACK_BARE: ReferenceView = { angle: "back_full", wardrobe: "bare" };
  const UNCLOTHED: LoadedBodyReference = { slot: 1, imageId: "img-body-1", tag: "unclothed", buffer: Buffer.from("body-1") };
  const CLOTHED: LoadedBodyReference = { slot: 2, imageId: "img-body-2", tag: "clothed", buffer: Buffer.from("body-2") };
  const SET_KEY = "img-body-1:unclothed,img-body-2:clothed";

  beforeEach(() => {
    vi.mocked(loadBodyReferencesForBuild).mockResolvedValue({ sendable: [UNCLOTHED, CLOTHED], loaded: [UNCLOTHED, CLOTHED] });
  });

  /** The body references one compile was handed, by image id, in send order. */
  const bodyImagesSent = (call = 0): (string | undefined)[] =>
    (mockProgram.mock.calls[call]?.[0].references ?? [])
      .filter((entry) => entry.reference.role === "body")
      .map((entry) => entry.reference.sourceImageId);

  it("sends every body image to a dressed view, dressed first, behind the pack, and records the set it read", async () => {
    const report = await build([ROOT_VIEW]);

    expect(report).toMatchObject({ built: 1, failed: 0 });
    const references = mockProgram.mock.calls[0]?.[0].references ?? [];
    expect(references.map((entry) => entry.reference.role)).toEqual(["identity", "body", "body"]);
    expect(bodyImagesSent()).toEqual([CLOTHED.imageId, UNCLOTHED.imageId]);
    for (const entry of references.slice(1)) {
      expect(entry).toMatchObject({ reference: { role: "body", required: false }, subjectId: "chr-nyx" });
      // Never a reference-authority input: a body image does not supersede the text.
      expect(entry.appearanceRevision).toBeUndefined();
      expect(entry.description).toBeUndefined();
    }
    expect(mockReserve.mock.calls[0]?.[0]).toMatchObject({ bodyReferenceSet: SET_KEY });
    expect(reservedMeta().referenceView).toMatchObject({
      bodyReferences: [
        { slot: CLOTHED.slot, imageId: CLOTHED.imageId, tag: "clothed" },
        { slot: UNCLOTHED.slot, imageId: UNCLOTHED.imageId, tag: "unclothed" },
      ],
    });
    expect(mockIntent.mock.calls[0]?.[0].references).toEqual(references.map((entry) => entry.reference));
  });

  it("sends only the undressed body images to an undressed view, after its own angle's dressed view", async () => {
    await build([BACK_BARE]);

    const references = mockProgram.mock.calls[0]?.[0].references ?? [];
    expect(references.map((entry) => [entry.reference.role, entry.reference.required])).toEqual([
      ["identity", true],
      ["identity", false],
      ["body", false],
    ]);
    expect(bodyImagesSent()).toEqual([UNCLOTHED.imageId]);
    // The set routed to THIS view — the unclothed image alone — is what the row records.
    expect(mockReserve.mock.calls[0]?.[0]).toMatchObject({ bodyReferenceSet: `${UNCLOTHED.imageId}:unclothed` });
  });

  it("records and renders only what the program sends, and says why the rest stayed behind", async () => {
    mockProgram.mockImplementation((input) => {
      const dropped = input.references.find((entry) => entry.reference.sourceImageId === UNCLOTHED.imageId);
      return {
        ...compiledFrom(input),
        sentReferences: input.references.filter((entry) => entry !== dropped).map((entry) => entry.reference),
        droppedReferences: dropped === undefined ? [] : [{ reference: dropped.reference, reason: "role_not_allowed" }],
      } as unknown as CharacterPromptProgram;
    });
    const sink = new DiagnosticCollector();

    const report = await buildReferenceViews({ jobId: "job-1", characterId: "chr-nyx", ownerId: "usr-1", targets: [ROOT_VIEW], sink });

    expect(report).toMatchObject({ built: 1, failed: 0 });
    expect(reservedMeta().referenceView).toMatchObject({
      bodyReferences: [{ slot: CLOTHED.slot, imageId: CLOTHED.imageId, tag: "clothed" }],
    });
    const sent = mockIntent.mock.calls[0]?.[0].references ?? [];
    expect(sent.map((reference) => reference.sourceImageId)).not.toContain(UNCLOTHED.imageId);
    const dropped = sink.items.filter((item) => item.code === REFERENCE_VIEW_BODY_REFERENCE_DROPPED);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.severity).toBe("info");
    expect(dropped[0]?.context).toMatchObject({ imageId: UNCLOTHED.imageId, reason: "role_not_allowed" });
  });

  it("sends and records no body image for a character with none", async () => {
    vi.mocked(loadBodyReferencesForBuild).mockResolvedValue({ sendable: [], loaded: [] });

    await build([ROOT_VIEW]);

    expect(bodyImagesSent()).toEqual([]);
    expect(mockReserve.mock.calls[0]?.[0]).toMatchObject({ bodyReferenceSet: null });
    expect(reservedMeta().referenceView).not.toHaveProperty("bodyReferences");
  });
});

/**
 * **What the studio is told about the body images' route** (#671): whether a
 * build started now would send them to dressed and to undressed views, from the
 * profile and the bare route the build itself resolves, by the prompt seam's own
 * rule. The implementation this kills tells the owner their images are used on
 * a model that drops every one of them.
 */
describe("the body images' route, as a sheet read reports it", () => {
  it("sends to every view on the Qwen Image 2.1 default, whose dialect words the role", async () => {
    mockResolveProfile.mockResolvedValue(QWEN21_VARIANT);
    expect(await referenceViewBodyRoutes()).toEqual({ clothed: true, bare: true });
  });

  it("sends to no view when the variant default's dialect cannot word a body image", async () => {
    mockResolveProfile.mockResolvedValue(QWEN2511_VARIANT);
    expect(await referenceViewBodyRoutes()).toEqual({ clothed: false, bare: false });
  });

  it("sends to no view when the profile's policy does not allow the role", async () => {
    mockResolveProfile.mockResolvedValue({
      ...QWEN21_VARIANT,
      profile: { ...QWEN21_VARIANT.profile, referencePolicy: { ...QWEN21_VARIANT.profile.referencePolicy, allowedRoles: ["identity", "style"] } },
    });
    expect(await referenceViewBodyRoutes()).toEqual({ clothed: false, bare: false });
  });

  it("sends to no view when no variant profile resolves", async () => {
    mockResolveProfile.mockResolvedValue(null);
    expect(await referenceViewBodyRoutes()).toEqual({ clothed: false, bare: false });
  });
});
