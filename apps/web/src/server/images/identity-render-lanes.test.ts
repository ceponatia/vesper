import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageProfileTask, ResolvedImageProfile } from "@vesper/image-core";
import { FULLY_COVERED } from "@/contracts";
import { DiagnosticCollector, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  attr,
  identityCandidateFixture as candidate,
  identityProvenanceFixture as record,
  laneProbeShadowInput,
  makeProfile,
  resolvedImageProfileFixture,
} from "@/server/test-support";
import { expectDiagnostic } from "@/test/diagnostics";

/**
 * Lane wiring for the three identity-critical lanes (identity packs 5B,
 * unconditional since the slice-7 close-out removed the rollout flag): every
 * lane sources its identity reference through `identityPackRenderReferences`,
 * provenance lands on the row's meta, and an ineligible pack refuses the
 * render instead of substituting another image.
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
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./asset-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-storage")>();
  return { ...actual, readImageBytes: vi.fn() };
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
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { diag } from "@/contracts/diagnostics";
import { logDiagnostics } from "@/server/log";
import { hasReplicate, isDemoMode } from "../ai";
import { db } from "../db";
import { readImageBytes, type ImageRow } from "./asset-storage";
import { runImagePipeline, type ImagePipelineOptions } from "./assets";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderImageIntent } from "./render-intent";
import { composeSceneSpec, renderResolvedScene, type RenderResolvedSceneInput } from "./scene";
import { CHAT_LOOK_VISUAL_CUT_MISSING, latestChatLook, renderChatLookImage, type ChatLookVisualCut } from "./chat-look";
import { emptySceneRenderPlan } from "./prompts-scene-plan";
import { generateVariant, VARIANT_PROGRAM_UNBOUND } from "./variants";
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

/**
 * The bound Qwen 2511 profile for a task. Every character edit lane compiles
 * its prompt program on (slug, task, key) and fails the row when no row
 * exists, so an unbound slug would refuse before the identity seam these cases
 * are about is ever reached.
 */
const resolved = (task: ImageProfileTask): ResolvedImageProfile =>
  resolvedImageProfileFixture({
    slug: "qwen/qwen-image-edit-2511",
    task,
    key: task === "chat_look" ? "chat-look-standard" : `${task}-standard`,
    referencePolicy: { requiredRoles: ["identity"] },
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

beforeEach(() => {
  vi.resetAllMocks();
  rowQueue.length = 0;
  pipelineCalls.length = 0;
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

// `updatedAt` is load-bearing: the lane folds the character row's revision into
// the standalone read token that names the visual cut its prompt was compiled
// from. The adult apparent-age band is too — the program's age anchor is
// mandatory and fails closed without one, and these cases are about the
// identity seam, not the anchor.
const characterRow = {
  id: "charaaaaaaaaaaaaaaaaaaaa",
  name: "Mira",
  profile: makeProfile({ attributes: [attr("identity.apparent_age", "late_twenties", "base")] }),
  avatarImageId: "imgavatar",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("variant lane", () => {
  const run = (sink?: DiagnosticSink) =>
    generateVariant({
      characterId: "charaaaaaaaaaaaaaaaaaaaa",
      userId: "user1",
      kind: "pose",
      instruction: "arms crossed",
      ...(sink === undefined ? {} : { sink }),
    });

  it("sends the pack's candidates and records their provenance on the row", async () => {
    mockResolve.mockResolvedValue(resolved("variant"));
    rowQueue.push([characterRow]); // the character read is the lane's only direct row read
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

  it("an ineligible pack refuses the render — failed row, no provider call, no substitute read", async () => {
    mockResolve.mockResolvedValue(resolved("variant"));
    rowQueue.push([characterRow]);
    mockConsume.mockResolvedValue(packRefused());

    await run();
    expect(mockIntent).not.toHaveBeenCalled();
    expect(vi.mocked(readImageBytes)).not.toHaveBeenCalled();
    expect(pipelineCalls).toHaveLength(1); // the refusal is on record as this lane's failed row
    expect(pipelineCalls[0]?.asset.meta && "identityReferences" in pipelineCalls[0].asset.meta).toBe(false);
  });

  /**
   * The compiled program is this lane's only prompt (#251): a model with no
   * active binding fails the row before provider spend, naming the row to add,
   * and stores no prompt — never a prose stand-in.
   */
  it("an unbound model fails the row before provider spend, naming the row to add", async () => {
    mockResolve.mockResolvedValue(
      resolvedImageProfileFixture({ slug: "test-only/unbound-variant", task: "variant", key: "variant-standard" }),
    );
    rowQueue.push([characterRow]);
    mockConsume.mockResolvedValue(packOk());
    const sink = new DiagnosticCollector();

    await run(sink);
    expect(mockIntent).not.toHaveBeenCalled();
    expect(pipelineCalls[0]?.failedPrecondition).toContain("test-only/unbound-variant");
    expect(pipelineCalls[0]?.asset.prompt).toBe("");
    expectDiagnostic(sink, VARIANT_PROGRAM_UNBOUND);
  });
});

describe("chat_look lane", () => {
  /** The subject's committed cut, as the look job hands it over. */
  const lookCut = (): ChatLookVisualCut => ({ ...laneProbeShadowInput(), subjectId: characterRow.id });
  /** `null` mints with no committed cut — the corrupt-membership path. */
  const run = (visual: ChatLookVisualCut | null = lookCut()) =>
    renderChatLookImage({
      chatId: "chat1",
      userId: "user1",
      characterId: characterRow.id,
      lookKey: "key1",
      outfit: "a linen sundress",
      outfitExposed: false,
      exposure: FULLY_COVERED,
      ...(visual === null ? {} : { visual }),
    });

  it("the pack's references feed the edit, provenance rides the meta — no direct row reads", async () => {
    mockResolve.mockResolvedValue(resolved("chat_look"));
    mockConsume.mockResolvedValue(packOk());

    expect(await run()).toBe("imgnew");
    expect(vi.mocked(db)).not.toHaveBeenCalled(); // no direct avatar row read
    const intent = mockIntent.mock.calls[0]?.[0];
    expect(intent?.references.map((ref) => ref.buffer)).toEqual([packBuffer]);
    const meta = pipelineCalls[0]?.asset.meta;
    expect(meta?.lookKey).toBe("key1");
    expect(meta?.identityReferences).toEqual([record("canonical_identity", "imgportrait")]);
  });

  it("an ineligible pack refuses the mint before any row is reserved", async () => {
    mockResolve.mockResolvedValue(resolved("chat_look"));
    mockConsume.mockResolvedValue(packRefused());

    expect(await run()).toBeNull();
    expect(mockPipeline).not.toHaveBeenCalled();
    expect(mockIntent).not.toHaveBeenCalled();
  });

  /**
   * A mint with no committed cut has nothing to compile and no second prompt
   * system to fall back on (#251): it refuses before the pack's owned byte
   * reads and before any row is reserved, and the drained diagnostic says why.
   */
  it("a mint with no committed cut refuses before the pack is read or a row is reserved", async () => {
    mockResolve.mockResolvedValue(resolved("chat_look"));
    mockConsume.mockResolvedValue(packOk());

    expect(await run(null)).toBeNull();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
    expect(vi.mocked(logDiagnostics)).toHaveBeenCalledWith(
      "images.chat_look",
      expect.arrayContaining([expect.objectContaining({ code: CHAT_LOOK_VISUAL_CUT_MISSING })]),
      expect.objectContaining({ chatId: "chat1" }),
    );
  });

  it("a refusal's diagnostics drain into the process log — the detached job has no other record", async () => {
    mockResolve.mockResolvedValue(resolved("chat_look"));
    mockConsume.mockImplementation(async (input) => {
      input.sink?.push(diag("warn", "images.identity_pack.profile_ineligible", "no eligible roles"));
      return packRefused();
    });

    expect(await run()).toBeNull();
    expect(vi.mocked(logDiagnostics)).toHaveBeenCalledWith(
      "images.chat_look",
      expect.arrayContaining([expect.objectContaining({ code: "images.identity_pack.profile_ineligible" })]),
      expect.objectContaining({ chatId: "chat1", characterId: "charaaaaaaaaaaaaaaaaaaaa" }),
    );
  });
});

describe("scene (chat cast) lane", () => {
  const member = (overrides: Partial<Parameters<typeof renderCharacterSceneImage>[0]["cast"][number]> = {}) => ({
    characterId: "charaaaaaaaaaaaaaaaaaaaa",
    name: "Mira",
    profile: makeProfile(),
    identityImageId: "imgavatar" as string | null,
    ...overrides,
  });

  const run = (cast: Parameters<typeof renderCharacterSceneImage>[0]["cast"]) =>
    renderCharacterSceneImage({ characterId: "charaaaaaaaaaaaaaaaaaaaa", userId: "user1", cast, chatId: "chat1" });

  const sceneInput = (): RenderResolvedSceneInput | undefined => mockScene.mock.calls[0]?.[0];

  it("a minted chat look STAYS the identity reference — the pack is not asked (5B ruling)", async () => {
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

  it("the look-less member's anchor comes from the pack, with provenance for what was sent", async () => {
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

  it("a member with no ACCEPTED portrait renders from text — nothing to refuse", async () => {
    mockResolve.mockResolvedValue(resolved("scene"));

    // The cast carries the accepted pointer, so this is equally the character
    // whose newest portrait nobody has accepted: neither substitutes an image.
    await run([member({ identityImageId: null })]);
    expect(mockConsume).not.toHaveBeenCalled();
    const input = sceneInput();
    expect(input?.referenceBuffers.size).toBe(0);
    expect(input?.failedPrecondition).toBeNull();
  });

  it("an ineligible pack refuses the scene rather than dropping the reference", async () => {
    mockResolve.mockResolvedValue(resolved("scene"));
    mockConsume.mockResolvedValue(packRefused());

    await run([member()]);
    const input = sceneInput();
    expect(input?.failedPrecondition).toContain("Mira");
    expect(input?.failedPrecondition).toContain("identity references unavailable");
    expect(input?.identityProvenance).toBeUndefined();
  });

  it("a LATER member's refusal sends no provenance for the earlier member either — a refused row must not claim sends", async () => {
    mockResolve.mockResolvedValue(resolved("scene"));
    mockConsume.mockResolvedValueOnce(packOk()).mockResolvedValueOnce(packRefused());

    await run([member(), member({ characterId: "charbbbbbbbbbbbbbbbbbbbb", name: "Nadia" })]);
    expect(mockConsume).toHaveBeenCalledTimes(2);
    const input = sceneInput();
    expect(input?.failedPrecondition).toContain("Nadia");
    expect(input?.identityProvenance).toBeUndefined();
  });
});
