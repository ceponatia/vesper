import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageModelProfileSchema,
  imageModelSchema,
  imageReferencePolicySchema,
  type ImageProfileTask,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import {
  identityCandidateFixture as candidate,
  identityProvenanceFixture as record,
  makeProfile,
} from "@/server/test-support";

/**
 * Flag wiring for the three identity-critical lanes (identity packs slice 5B):
 * with `IMAGE_IDENTITY_PACK_REFERENCES` off every lane sources its identity
 * reference exactly as before and no pack code runs; with it on, the reference
 * comes from `identityPackRenderReferences`, provenance lands on the row's
 * meta, and an ineligible pack refuses the render instead of substituting.
 */

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(), hasReplicate: vi.fn(), classifyImageFailure: vi.fn() };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("../events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events")>();
  return { ...actual, logEvent: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn(), readImageBytes: vi.fn() };
});
vi.mock("./model-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-profiles")>();
  return { ...actual, resolveImageProfileForTask: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("./identity-pack-consume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity-pack-consume")>();
  return { ...actual, identityPackRenderReferences: vi.fn() };
});
vi.mock("./scene", () => ({ composeSceneSpec: vi.fn(), renderResolvedScene: vi.fn() }));
vi.mock("./chat-look", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-look")>();
  return { ...actual, latestChatLook: vi.fn() };
});

import { hasReplicate, isDemoMode } from "../ai";
import { db } from "../db";
import { readImageBytes, runImagePipeline, type ImagePipelineOptions, type ImageRow } from "./assets";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderImageIntent } from "./render-intent";
import { composeSceneSpec, renderResolvedScene, type RenderResolvedSceneInput } from "./scene";
import { latestChatLook, renderChatLookImage } from "./chat-look";
import { emptySceneRenderPlan } from "./prompts-scene-plan";
import { generateVariant } from "./variants";
import { renderCharacterSceneImage } from "./character-scene";

const mockConsume = vi.mocked(identityPackRenderReferences);
const mockIntent = vi.mocked(renderImageIntent);
const mockPipeline = vi.mocked(runImagePipeline);
const mockResolve = vi.mocked(resolveImageProfileForTask);
const mockLook = vi.mocked(latestChatLook);
const mockScene = vi.mocked(renderResolvedScene);

/** Sequential row reads: each entry answers one `db().select()...` await. */
const rowQueue: unknown[][] = [];
/** Every pipeline reservation, in call order — meta assertions read these. */
const pipelineCalls: ImagePipelineOptions[] = [];

const resolved = (task: ImageProfileTask): ResolvedImageProfile => ({
  model: imageModelSchema.parse({
    id: "mdl",
    slug: "vendor/model",
    label: "Model",
    canGenerate: false,
    canEdit: true,
    editKind: "instruction_edit",
    identityPreservation: "strong",
  }),
  profile: imageModelProfileSchema.parse({
    id: "prf",
    imageModelId: "mdl",
    key: `${task}-standard`,
    label: task,
    task,
    operation: "edit",
    promptStrategy: "instruction_edit",
    referencePolicy: imageReferencePolicySchema.parse({ requiredRoles: ["identity"] }),
  }),
});

const packBuffer = Buffer.from("pack-bytes");

const packOk = (): Extract<IdentityPackRenderReferencesResult, { ok: true }> => ({
  ok: true,
  references: [
    {
      reference: { role: "identity", required: true, priority: 1, sourceImageId: "imgportrait", buffer: packBuffer },
      provenance: record("canonical_identity", "imgportrait"),
      candidate: candidate("canonical_identity", true, "imgportrait"),
      source: "uploaded",
    },
  ],
  provenance: [record("canonical_identity", "imgportrait")],
});

const packRefused = (): IdentityPackRenderReferencesResult => ({
  ok: false,
  code: "profile_ineligible",
  error: "identity references unavailable (images.identity_pack.profile_ineligible.no_roles)",
});

const setFlag = (on: boolean): void => {
  if (on) process.env.IMAGE_IDENTITY_PACK_REFERENCES = "on";
  else delete process.env.IMAGE_IDENTITY_PACK_REFERENCES;
};

beforeEach(() => {
  vi.resetAllMocks();
  rowQueue.length = 0;
  pipelineCalls.length = 0;
  setFlag(false);
  vi.mocked(isDemoMode).mockReturnValue(false);
  vi.mocked(hasReplicate).mockReturnValue(true);
  vi.mocked(db).mockImplementation(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rowQueue.shift() ?? []),
    };
    return chain as unknown as ReturnType<typeof db>;
  });
  // The reserve → produce → settle shell, minus the database: precondition
  // failures reserve-and-fail, produce failures fail, successes read ready.
  mockPipeline.mockImplementation(async (opts) => {
    pipelineCalls.push(opts);
    if ((opts.failedPrecondition ?? null) !== null) return { imageId: "imgnew", status: "failed" };
    const produced = await opts.produce({ id: "imgnew" } as unknown as ImageRow);
    return { imageId: "imgnew", status: produced.ok ? "ready" : "failed" };
  });
  mockIntent.mockResolvedValue({ ok: true, image: Buffer.from("rendered") });
  mockScene.mockResolvedValue("imgscene");
  vi.mocked(composeSceneSpec).mockResolvedValue(emptySceneRenderPlan());
});

afterEach(() => {
  setFlag(false);
});

const characterRow = { id: "charaaaaaaaaaaaaaaaaaaaa", name: "Mira", profile: {}, avatarImageId: "imgavatar" };
const avatarRow = { id: "imgavatar", status: "ready", meta: {} };

describe("variant lane", () => {
  const run = () =>
    generateVariant({ characterId: "charaaaaaaaaaaaaaaaaaaaa", userId: "user1", kind: "pose", instruction: "arms crossed" });

  it("flag off: reads the avatar directly, sends the legacy single reference, and never touches the pack", async () => {
    mockResolve.mockResolvedValue(resolved("variant"));
    rowQueue.push([characterRow], [avatarRow]);
    const avatarBytes = Buffer.from("avatar");
    vi.mocked(readImageBytes).mockResolvedValue(avatarBytes);

    await run();
    expect(mockConsume).not.toHaveBeenCalled();
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.references).toEqual([
      { role: "identity", required: true, buffer: avatarBytes, sourceImageId: "imgavatar" },
    ]);
    const asset = pipelineCalls[0]?.asset;
    expect(asset?.sourceImageId).toBe("imgavatar");
    expect(asset?.meta && "identityReferences" in asset.meta).toBe(false);
  });

  it("flag on: sends the pack's candidates and records their provenance on the row", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("variant"));
    rowQueue.push([characterRow]); // no direct avatar read follows
    mockConsume.mockResolvedValue(packOk());

    await run();
    expect(mockConsume).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "user1", characterId: "charaaaaaaaaaaaaaaaaaaaa" }),
    );
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.references.map((ref) => ref.buffer)).toEqual([packBuffer]);
    expect(intent?.references[0]?.sourceImageId).toBe("imgportrait");
    const asset = pipelineCalls[0]?.asset;
    expect(asset?.sourceImageId).toBe("imgportrait");
    expect(asset?.meta?.identityReferences).toEqual([record("canonical_identity", "imgportrait")]);
  });

  it("flag on: an ineligible pack refuses the render — failed row, no provider call, no avatar substitute", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("variant"));
    rowQueue.push([characterRow]);
    mockConsume.mockResolvedValue(packRefused());

    await run();
    expect(mockIntent).not.toHaveBeenCalled();
    expect(vi.mocked(readImageBytes)).not.toHaveBeenCalled();
    expect(pipelineCalls).toHaveLength(1); // the refusal is on record as this lane's failed row
    expect(pipelineCalls[0]?.asset.meta && "identityReferences" in pipelineCalls[0].asset.meta).toBe(false);
  });
});

describe("chat_look lane", () => {
  const run = () =>
    renderChatLookImage({
      chatId: "chat1",
      userId: "user1",
      characterId: "charaaaaaaaaaaaaaaaaaaaa",
      avatarImageId: "imgavatar",
      lookKey: "key1",
      outfit: "a linen sundress",
      outfitExposed: false,
    });

  it("flag off: the owned avatar read feeds the exact legacy reference shape — no pack calls", async () => {
    mockResolve.mockResolvedValue(resolved("chat_look"));
    rowQueue.push([avatarRow]);
    const avatarBytes = Buffer.from("avatar");
    vi.mocked(readImageBytes).mockResolvedValue(avatarBytes);

    expect(await run()).toBe("imgnew");
    expect(mockConsume).not.toHaveBeenCalled();
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.references).toEqual([{ role: "identity", required: true, buffer: avatarBytes }]);
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta?.lookKey).toBe("key1");
    expect(meta && "identityReferences" in meta).toBe(false);
  });

  it("flag on: the pack's references replace the avatar read, provenance rides the meta", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("chat_look"));
    mockConsume.mockResolvedValue(packOk());

    expect(await run()).toBe("imgnew");
    expect(vi.mocked(db)).not.toHaveBeenCalled(); // no direct avatar row read
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.references.map((ref) => ref.buffer)).toEqual([packBuffer]);
    expect(pipelineCalls[0]?.asset.meta?.identityReferences).toEqual([record("canonical_identity", "imgportrait")]);
  });

  it("flag on: an ineligible pack refuses the mint before any row is reserved", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("chat_look"));
    mockConsume.mockResolvedValue(packRefused());

    expect(await run()).toBeNull();
    expect(mockPipeline).not.toHaveBeenCalled();
    expect(mockIntent).not.toHaveBeenCalled();
  });
});

describe("scene (chat cast) lane", () => {
  const member = (overrides: Partial<Parameters<typeof renderCharacterSceneImage>[0]["cast"][number]> = {}) => ({
    characterId: "charaaaaaaaaaaaaaaaaaaaa",
    name: "Mira",
    profile: makeProfile(),
    avatarImageId: "imgavatar" as string | null,
    ...overrides,
  });

  const run = (cast: Parameters<typeof renderCharacterSceneImage>[0]["cast"]) =>
    renderCharacterSceneImage({ characterId: "charaaaaaaaaaaaaaaaaaaaa", userId: "user1", cast, chatId: "chat1" });

  const sceneInput = (): RenderResolvedSceneInput | undefined => mockScene.mock.calls[0]?.[0];

  it("flag on: a minted chat look STAYS the identity reference — the pack is not asked (5B ruling)", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("scene"));
    const lookBytes = Buffer.from("look");
    mockLook.mockResolvedValue({ imageId: "imglook", buffer: lookBytes });

    await run([member({ lookKey: "fresh" })]);
    expect(mockConsume).not.toHaveBeenCalled();
    const input = sceneInput();
    expect(input?.referenceBuffers.get("imglook")).toBe(lookBytes);
    expect(input?.identityProvenance).toBeUndefined();
    expect(input?.failedPrecondition).toBeNull();
  });

  it("flag on: the avatar-fallback anchor comes from the pack, with provenance for what was sent", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("scene"));
    mockConsume.mockResolvedValue(packOk());

    await run([member()]);
    expect(mockConsume).toHaveBeenCalledTimes(1);
    const input = sceneInput();
    expect(input?.referenceBuffers.get("imgportrait")).toBe(packBuffer);
    expect(input?.identityProvenance).toEqual([record("canonical_identity", "imgportrait")]);
    const castRef = input?.references.find((ref) => ref.kind === "character");
    expect(castRef?.imageId).toBe("imgportrait");
    expect(castRef?.source).toBe("uploaded");
    expect(input?.failedPrecondition).toBeNull();
  });

  it("flag on: a member with no portrait renders from text, as before — nothing to refuse", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("scene"));

    await run([member({ avatarImageId: null })]);
    expect(mockConsume).not.toHaveBeenCalled();
    const input = sceneInput();
    expect(input?.referenceBuffers.size).toBe(0);
    expect(input?.failedPrecondition).toBeNull();
  });

  it("flag on: an ineligible pack refuses the scene rather than dropping the reference", async () => {
    setFlag(true);
    mockResolve.mockResolvedValue(resolved("scene"));
    mockConsume.mockResolvedValue(packRefused());

    await run([member()]);
    const input = sceneInput();
    expect(input?.failedPrecondition).toContain("Mira");
    expect(input?.failedPrecondition).toContain("identity references unavailable");
    expect(input?.identityProvenance).toBeUndefined();
  });

  it("flag off: the direct avatar read anchors the member and no pack code runs", async () => {
    mockResolve.mockResolvedValue(resolved("scene"));
    rowQueue.push([avatarRow]);
    const avatarBytes = Buffer.from("avatar");
    vi.mocked(readImageBytes).mockResolvedValue(avatarBytes);

    await run([member()]);
    expect(mockConsume).not.toHaveBeenCalled();
    const input = sceneInput();
    expect(input?.referenceBuffers.get("imgavatar")).toBe(avatarBytes);
    expect(input?.identityProvenance).toBeUndefined();
    expect(input?.failedPrecondition).toBeNull();
  });
});
