import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  pinnedImageModelVersion,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { FULLY_COVERED } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { CharacterProfile } from "@/contracts/world/profile";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn() };
});
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>();
  return { ...actual, runImagePipeline: vi.fn() };
});
vi.mock("./model-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-profiles")>();
  return { ...actual, resolveImageProfileForTask: vi.fn() };
});
vi.mock("./render-intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-intent")>();
  return { ...actual, renderImageIntent: vi.fn() };
});
vi.mock("./standalone-subject-visual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./standalone-subject-visual")>();
  return { ...actual, buildStandaloneLaneCut: vi.fn(actual.buildStandaloneLaneCut) };
});

import { isDemoMode } from "../ai";
import { db } from "../db";
import { runImagePipeline } from "./assets";
import type { ImageRow } from "./asset-storage";
import {
  AVATAR_CUT_FAILED,
  AVATAR_PROGRAM_UNBOUND,
  defaultOutfitPhrase,
  generateAvatar,
  loadDefaultWardrobeWithRevisions,
  wardrobeOutfitText,
} from "./avatar";
import { AVATAR_REPLAY_REFUSAL_TEXT } from "./avatar-replay";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderImageIntent } from "./render-intent";
import { buildStandaloneLaneCut } from "./standalone-subject-visual";
import {
  attr,
  LANE_PROBE_PORTRAIT_PROFILE,
  laneProbeAvatarCut,
  laneProbeAvatarProgram,
  laneProbeProfile,
  laneProbeWardrobe,
  resolvedImageProfileFixture,
} from "@/server/test-support";
import { expectDiagnostic } from "@/test/diagnostics";

const { buildStandaloneLaneCut: actualBuildStandaloneLaneCut, portraitPerception } =
  await vi.importActual<typeof import("./standalone-subject-visual")>("./standalone-subject-visual");

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("wardrobeOutfitText (the chat scenario's Starting Outfit phrase)", () => {
  it("phrases visible garments description-primary, subtype-led, with appearance in parens", () => {
    const text = wardrobeOutfitText([
      {
        name: "Red Sundress",
        coverage: ["chest", "back", "waist", "pelvis", "thighs"],
        layer: 1,
        description: "a light red cotton sundress",
        appearance: "worn soft at the hem",
      },
      { name: "Thin Gold Hoop", coverage: ["nose"], layer: 1, subtype: "nose_ring" },
    ]);
    expect(text).toBe("a light red cotton sundress (worn soft at the hem), nose ring: Thin Gold Hoop");
  });

  it("omits hidden layers and hints sheer-covered pieces — never raw ids anywhere", () => {
    const text = wardrobeOutfitText([
      { name: "Lace Bralette", coverage: ["chest"], layer: 0 },
      { name: "Sheer Blouse", coverage: ["chest", "back", "waist"], layer: 1, opacity: "sheer" },
      { name: "Wool Coat", coverage: ["chest", "back", "waist", "upper_arms"], layer: 3 },
    ]);
    // The bralette is under a sheer layer AND an opaque coat → hidden entirely;
    // the blouse survives visible only where the coat doesn't cover.
    expect(text).toContain("Wool Coat");
    expect(text).not.toContain("Lace Bralette");
  });

  it("is empty for an empty wardrobe", () => {
    expect(wardrobeOutfitText([])).toBe("");
  });
});

describe("defaultOutfitPhrase degradation", () => {
  it("degrades to an empty phrase (composer inference) when the item lookup fails — never ids", async () => {
    mockDb.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const sink = new DiagnosticCollector();
    expect(await defaultOutfitPhrase("u-1", ["itemid1abc"], sink)).toBe("");
    expect(sink.items.some((d) => d.code === "images.avatar.outfit_load_failed")).toBe(true);
  });
});

/**
 * `generateAvatar`'s wiring of its ONLY prompt path, through the pipeline seam
 * (#251). The program's compile, the packs and the prompt's wording have their
 * own owners; what these prove is the ROUTE's half of the contract:
 *
 * - the row's stored `prompt` IS the prompt the provider receives — there is no
 *   second prompt system to disagree with it — and demo mode, which compiles
 *   nothing, stores the monogram's own label;
 * - every answer that is not a compiled program fails the row through the
 *   precondition path (so the provider is never reached) AND records its code:
 *   the compile's own refusal, the lane's `images.avatar.program_unbound`, and
 *   `images.avatar.visual_cut_failed` for a cut that would not assemble —
 *   degradation tests assert fallback and diagnostic code, per CLAUDE.md;
 * - `meta.visualState` lands at RESERVE time on every row that had a cut,
 *   refused or not, so the visual moment survives a failed render.
 */
describe("generateAvatar program wiring", () => {
  const characterRow = (profile: unknown, name = "Mira") => ({
    id: "chr-1",
    name,
    profile,
    authoringRevision: 4,
    updatedAt: new Date("2026-08-21T00:00:00Z"),
  });
  const bound = resolvedImageProfileFixture(LANE_PROBE_PORTRAIT_PROFILE);

  /** Linda's complete plain-human sheet, without the lane probe's non-human body morphology. */
  function lindaProfile(): CharacterProfile {
    const shared = laneProbeProfile();
    const core = new Set([
      "identity.apparent_age",
      "identity.gender",
      "skin.tone",
      "skin.undertone",
      "hair.color",
      "hair.length",
      "eyes.color",
      "face.shape",
      "build.frame",
      "build.weight_presentation",
      "build.height",
    ]);
    return {
      ...shared,
      bio: "A decisive woman with a quiet sense of humor.",
      personality: "Direct, observant, and warm.",
      age: "29",
      speciesId: "human",
      bodyFeatures: [],
      intimateRegions: [],
      attributes: shared.attributes.filter((attribute) => core.has(attribute.id)),
    };
  }

  function prime(options: { demo: boolean; profile: unknown; name?: string; picked?: ResolvedImageProfile }): void {
    vi.mocked(isDemoMode).mockReturnValue(options.demo);
    vi.mocked(resolveImageProfileForTask).mockResolvedValue(options.picked ?? null);
    vi.mocked(buildStandaloneLaneCut).mockImplementation(actualBuildStandaloneLaneCut);
    vi.mocked(renderImageIntent).mockResolvedValue({ ok: true, image: Buffer.from("png") });
    // The reserve → produce shell, minus the database: a failed precondition
    // never reaches produce, which is what "before provider spend" means here.
    vi.mocked(runImagePipeline).mockImplementation(async (opts) => {
      if ((opts.failedPrecondition ?? null) !== null) return { imageId: "img-1", status: "failed" };
      const produced = await opts.produce({ id: "img-1" } as unknown as ImageRow);
      return { imageId: "img-1", status: produced.ok ? "ready" : "failed" };
    });
    mockDb.mockImplementation(
      () =>
        ({
          select: () => ({
            from: () => ({
              where: () => ({ limit: () => Promise.resolve([characterRow(options.profile, options.name)]) }),
            }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );
  }

  const reserved = () => vi.mocked(runImagePipeline).mock.calls[0]?.[0];
  const generate = (sink: DiagnosticCollector) => generateAvatar({ characterId: "chr-1", userId: "u-1", sink });

  it("demo mode compiles nothing: the row reserves with meta.visualState, the monogram's label as its prompt and no refusal", async () => {
    prime({ demo: true, profile: {} });
    const sink = new DiagnosticCollector();
    await expect(generate(sink)).resolves.toEqual({ imageId: "img-1", imageIds: ["img-1"] });
    const opts = reserved();
    expect(opts?.failedPrecondition ?? null).toBeNull();
    expect(opts?.asset.prompt).toBe("Mira");
    expect(opts?.asset.meta).toMatchObject({ demo: true, style: "realistic", model: "demo" });
    // The provenance fragment lands at RESERVE time, so it survives a thrown produce.
    expect(opts?.asset.meta?.visualState).toMatchObject({ version: 1, scopeKey: "standalone_character:chr-1" });
    expect(vi.mocked(renderImageIntent)).not.toHaveBeenCalled();
    expect(sink.items.filter((d) => d.code.startsWith("images.avatar."))).toEqual([]);
  });

  it("sends the saved platinum hair and blue eyes in exactly the prompt the row stores", async () => {
    prime({ demo: false, profile: lindaProfile(), name: "Linda", picked: bound });
    const sink = new DiagnosticCollector();
    await expect(generate(sink)).resolves.toEqual({ imageId: "img-1", imageIds: ["img-1"] });
    const opts = reserved();
    expect(opts?.failedPrecondition ?? null).toBeNull();
    const intent = vi.mocked(renderImageIntent).mock.calls[0]?.[0];
    expect(intent?.prompt).toBe(opts?.asset.prompt);
    expect(intent?.prompt).toMatch(/late twenties/);
    // The registry's PROSE, not its label form (#547): an image-eligible
    // attribute that declares a phrase reaches every dialect as the noun
    // phrase it was authored as.
    expect(intent?.prompt).toMatch(/platinum hair/i);
    expect(intent?.prompt).toMatch(/blue eyes/i);
    expect(Object.keys(opts?.asset.meta ?? {})).toEqual(
      expect.arrayContaining(["visualState", IMAGE_PROMPT_PROGRAM_META_KEY, IMAGE_WORLD_STATE_META_KEY]),
    );
  });

  it("an unbound model fails the row before provider spend, naming the row to add", async () => {
    prime({
      demo: false,
      profile: laneProbeProfile(),
      picked: resolvedImageProfileFixture({ slug: "test-only/unbound-portrait", task: "portrait", key: "portrait-standard" }),
    });
    const sink = new DiagnosticCollector();
    await generate(sink);
    const opts = reserved();
    expect(opts?.failedPrecondition).toContain("test-only/unbound-portrait");
    expect(opts?.failedPrecondition).toContain("portrait-standard");
    expect(opts?.asset.prompt).toBe("");
    expect(vi.mocked(renderImageIntent)).not.toHaveBeenCalled();
    expectDiagnostic(sink, AVATAR_PROGRAM_UNBOUND);
  });

  it("a sheet the program cannot anchor fails the row before provider spend, with the compile's own code", async () => {
    // Linda's otherwise-complete sheet without one required core appearance
    // value: a reference-free portrait must not invent her hair color.
    const base = lindaProfile();
    prime({
      demo: false,
      profile: { ...base, attributes: base.attributes.filter((value) => value.id !== "hair.color") },
      picked: bound,
    });
    const sink = new DiagnosticCollector();
    await generate(sink);
    const opts = reserved();
    expect(opts?.failedPrecondition).toBeTruthy();
    expect(opts?.asset.prompt).toBe("");
    // The refused attempt still records WHICH visual moment it refused over.
    expect(opts?.asset.meta?.visualState).toMatchObject({ scopeKey: "standalone_character:chr-1" });
    expect(vi.mocked(renderImageIntent)).not.toHaveBeenCalled();
    // The compile's own refusal code (image-core `compile-program.ts`).
    expectDiagnostic(sink, "image_prompt_program.missing_required_fact");
  });

  it("a cut that will not assemble degrades to a failed row with the diagnostic, never a thrown request", async () => {
    prime({ demo: true, profile: {} });
    vi.mocked(buildStandaloneLaneCut).mockImplementation(() => {
      throw new Error("boom");
    });
    const sink = new DiagnosticCollector();
    await expect(generate(sink)).resolves.toEqual({ imageId: "img-1", imageIds: ["img-1"] });
    expect(reserved()?.failedPrecondition).toMatch(/could not be assembled/);
    expectDiagnostic(sink, AVATAR_CUT_FAILED);
  });

  /**
   * Best-of-two (issue #248 acceptance #1 and #5): two candidates from ONE
   * compiled program, as two independent `runImagePipeline` reserves — the
   * defect this kills is a shared row (one candidate silently overwriting the
   * other) or a claimed pointer nobody chose.
   */
  it("a two-candidate request renders both candidates of one group, with no explicit seed, and claims no pointer", async () => {
    prime({ demo: false, profile: lindaProfile(), name: "Linda", picked: bound });
    let call = 0;
    vi.mocked(runImagePipeline).mockImplementation(async (opts) => {
      call += 1;
      const id = `img-${call}`;
      if ((opts.failedPrecondition ?? null) !== null) return { imageId: id, status: "failed" };
      const produced = await opts.produce({ id } as unknown as ImageRow);
      return { imageId: id, status: produced.ok ? "ready" : "failed" };
    });
    const result = await generateAvatar({ characterId: "chr-1", userId: "u-1", candidates: 2 });
    expect(result).toEqual({ imageId: "img-1", imageIds: ["img-1", "img-2"] });
    expect(vi.mocked(runImagePipeline)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(renderImageIntent)).toHaveBeenCalledTimes(2);
    for (const intentCall of vi.mocked(renderImageIntent).mock.calls) {
      expect(intentCall[0]?.controls?.seed).toBeUndefined();
    }
    const [firstOpts, secondOpts] = vi.mocked(runImagePipeline).mock.calls.map((c) => c[0]);
    const group = (firstOpts?.asset.meta?.candidates as { group?: unknown } | undefined)?.group;
    expect(typeof group).toBe("string");
    expect(firstOpts?.asset.meta?.candidates).toEqual({ group, index: 1, of: 2 });
    expect(secondOpts?.asset.meta?.candidates).toEqual({ group, index: 2, of: 2 });
    // A two-candidate request claims NOTHING — no `onReady` at all, so there is
    // no pointer write to assert against.
    expect(firstOpts?.onReady).toBeUndefined();
    expect(secondOpts?.onReady).toBeUndefined();
  });

  /**
   * Same-composition retry (issue #248 acceptance #2): the eligibility table
   * lives in `avatar-replay.test.ts`; this proves `generateAvatar` actually
   * WIRES it — the current model/profile/version and the freshly compiled
   * program's own fingerprint, not a stand-in.
   */
  it("an eligible same-composition retry replays the source's exact seed and records the retry's lineage", async () => {
    prime({ demo: false, profile: lindaProfile(), name: "Linda", picked: bound });
    const source = { name: "Linda", profile: lindaProfile(), revision: "4" };

    // First, an ordinary generation establishes the REAL compiled fingerprint
    // for this exact character+profile — hand-picking one would test nothing
    // but the test's own guess.
    await generateAvatar({ characterId: "chr-1", userId: "u-1", source });
    const establishing = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    const programMeta = establishing?.asset.meta?.[IMAGE_PROMPT_PROGRAM_META_KEY] as { programFingerprint: string };
    expect(programMeta?.programFingerprint).toBeTruthy();

    vi.mocked(runImagePipeline).mockClear();
    vi.mocked(renderImageIntent).mockClear();
    mockDb.mockImplementation(
      () =>
        ({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      id: "img-source",
                      ownerId: "u-1",
                      entityKind: "character",
                      entityId: "chr-1",
                      kind: "avatar",
                      status: "ready",
                      meta: {
                        render: {
                          seed: 777,
                          modelSlug: bound.model.slug,
                          profileId: bound.profile.id,
                          executedVersionId: pinnedImageModelVersion(bound.model),
                        },
                        promptProgram: { programFingerprint: programMeta.programFingerprint },
                      },
                    },
                  ]),
              }),
            }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );

    const result = await generateAvatar({
      characterId: "chr-1",
      userId: "u-1",
      source,
      retry: { mode: "same_composition", sourceImageId: "img-source" },
    });
    expect(result).toEqual({ imageId: "img-1", imageIds: ["img-1"] });
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    expect(opts?.failedPrecondition ?? null).toBeNull();
    expect(opts?.asset.sourceImageId).toBe("img-source");
    expect(opts?.asset.meta?.retry).toEqual({ mode: "same_composition", sourceImageId: "img-source", seed: 777 });
    const intent = vi.mocked(renderImageIntent).mock.calls[0]?.[0];
    expect(intent?.controls?.seed).toBe(777);
  });

  it("a same-composition retry against a model-changed source fails the row before provider spend, with the reason code", async () => {
    prime({ demo: false, profile: lindaProfile(), name: "Linda", picked: bound });
    mockDb.mockImplementation(
      () =>
        ({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      id: "img-source",
                      ownerId: "u-1",
                      entityKind: "character",
                      entityId: "chr-1",
                      kind: "avatar",
                      status: "ready",
                      meta: {
                        render: { seed: 5, modelSlug: "replicate/some-other-model", profileId: bound.profile.id, executedVersionId: null },
                        promptProgram: { programFingerprint: "whatever" },
                      },
                    },
                  ]),
              }),
            }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );
    const sink = new DiagnosticCollector();
    const result = await generateAvatar({
      characterId: "chr-1",
      userId: "u-1",
      sink,
      source: { name: "Linda", profile: lindaProfile(), revision: "4" },
      retry: { mode: "same_composition", sourceImageId: "img-source" },
    });
    expect(result.imageIds).toHaveLength(1);
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    expect(opts?.failedPrecondition).toBe(AVATAR_REPLAY_REFUSAL_TEXT.model_changed);
    expect(vi.mocked(renderImageIntent)).not.toHaveBeenCalled();
    expectDiagnostic(sink, "images.avatar.replay_refused");
    // Correction round: a REFUSED replay must never write the named source
    // anywhere on the row — `images.source_image_id` carries no FK, so a
    // request naming another owner's (or a nonexistent) image id must not
    // leave that id on a failed row, nor let a caller probe its existence.
    expect(opts?.asset.sourceImageId).toBeUndefined();
    expect(opts?.asset.meta?.retry).toEqual({ mode: "same_composition" });
  });

  /**
   * THE `new_variation` LINEAGE POINTER, AND ITS SCOPE CHECK (issue #248).
   *
   * `new_variation` is the studio's MAIN regenerate button once a portrait
   * exists, so every ordinary regeneration now writes `images.source_image_id`
   * and `meta.retry` on an avatar row. Unlike `same_composition` it needs no
   * eligibility at all — a fresh seed is the whole point — so an id it cannot
   * vouch for is DROPPED rather than refused, and that silence is exactly what
   * makes the scope check untestable from the outside: a build that wrote the
   * id verbatim renders an identical picture and fails nothing.
   *
   * `images.source_image_id` carries no foreign key, so writing an id this
   * caller does not own would leave another owner's image id on the row and
   * let a caller probe whether that id exists at all — the same argument the
   * refused-replay case above makes, on the branch that never refuses.
   */
  function withSourceRow(row: Record<string, unknown>): void {
    mockDb.mockImplementation(
      () =>
        ({
          select: () => ({
            from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );
  }

  const sourceRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "img-source",
    ownerId: "u-1",
    entityKind: "character",
    entityId: "chr-1",
    kind: "avatar",
    status: "ready",
    meta: {},
    ...over,
  });

  it("records a new-variation retry's lineage when the named source is this owner's own portrait of this character", async () => {
    prime({ demo: false, profile: lindaProfile(), name: "Linda", picked: bound });
    withSourceRow(sourceRow());

    const result = await generateAvatar({
      characterId: "chr-1",
      userId: "u-1",
      source: { name: "Linda", profile: lindaProfile(), revision: "4" },
      retry: { mode: "new_variation", sourceImageId: "img-source" },
    });

    expect(result).toEqual({ imageId: "img-1", imageIds: ["img-1"] });
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    expect(opts?.failedPrecondition ?? null).toBeNull();
    expect(opts?.asset.sourceImageId).toBe("img-source");
    // No seed: a new variation is a DIFFERENT composition of the same subject,
    // so the lane leaves `resolveIntentSeed` to draw its own.
    expect(opts?.asset.meta?.retry).toEqual({ mode: "new_variation", sourceImageId: "img-source" });
    expect(vi.mocked(renderImageIntent).mock.calls[0]?.[0]?.controls?.seed).toBeUndefined();
  });

  /** Every way the named row fails the pointer's ownership/scope check. */
  const unvouchable: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["another owner's image", { ownerId: "u-2" }],
    ["another character's portrait", { entityId: "chr-2" }],
    ["a row that is not a character asset", { entityKind: null, entityId: null }],
    ["a kind that is neither an avatar nor a portrait variant", { kind: "scene" }],
  ];

  it.each(unvouchable)("drops a new-variation pointer at %s, and still renders", async (_label, over) => {
    prime({ demo: false, profile: lindaProfile(), name: "Linda", picked: bound });
    withSourceRow(sourceRow(over));
    const sink = new DiagnosticCollector();

    const result = await generateAvatar({
      characterId: "chr-1",
      userId: "u-1",
      sink,
      source: { name: "Linda", profile: lindaProfile(), revision: "4" },
      retry: { mode: "new_variation", sourceImageId: "img-source" },
    });

    expect(result.imageIds).toHaveLength(1);
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    // Dropped, not refused: the render proceeds and the provider is reached.
    expect(opts?.failedPrecondition ?? null).toBeNull();
    expect(vi.mocked(renderImageIntent)).toHaveBeenCalledTimes(1);
    // The unvouchable id appears NOWHERE on the row — not as the column, not
    // inside the retry bag.
    expect(opts?.asset.sourceImageId).toBeUndefined();
    expect(opts?.asset.meta?.retry).toEqual({ mode: "new_variation" });
    expect(JSON.stringify(opts?.asset.meta)).not.toContain("img-source");
  });
});

/**
 * The portrait studio's field policy, read off the compiled program — the one
 * prompt a portrait sends. The selection's consent gate, the adapter's
 * excluded-field and non-visual gates and the lane's decision not to project an
 * intimate reveal each have their own owner; this pins what they add up to for
 * THIS lane, including the one ordinary-route exception for a coverage-safe
 * bust silhouette. The defect is a one-line `intimateAllowed: true` or an
 * `intimateReveal` on the avatar program, and the picture it produces is a nude
 * portrait of a character whose sheet merely lists their anatomy.
 */
describe("the portrait program's field policy", () => {
  it("states ordinary visual identity while withholding intimate skin, non-visual senses and excluded fields", () => {
    const base = laneProbeProfile();
    const profile: CharacterProfile = {
      ...base,
      attributes: [...base.attributes, attr("identity.natal_sex", "female", "base")],
    };
    for (const wardrobe of [[], laneProbeWardrobe()]) {
      const program = laneProbeAvatarProgram({ profile, wardrobe });
      if (program.kind !== "compiled") throw new Error(`the avatar program did not compile: ${program.kind}`);
      expect(program.prompt).toMatch(/late twenties/); // the sheet does reach the prompt…
      expect(program.prompt).toMatch(/female/i);
      expect(program.prompt).toMatch(/brown/i);
      expect(program.prompt).toMatch(/platinum/i);
      // The one permitted intimate-region fact is a coverage-safe silhouette.
      expect(program.prompt).toMatch(/an ample bust/i);
      expect(program.prompt).not.toMatch(/\bpuffy\b/); // intimate surface detail remains gated
      expect(program.prompt).not.toMatch(/gravelly/); // voice.timbre never renders
      expect(program.prompt).not.toMatch(/natal/i); // identity.natal_sex is excludeFromPrompts
    }
  });

  it("names visible default wardrobe and omits garments outside the portrait frame", () => {
    const program = laneProbeAvatarProgram({ wardrobe: laneProbeWardrobe() });
    if (program.kind !== "compiled") throw new Error(`the avatar program did not compile: ${program.kind}`);
    expect(program.prompt).toContain("silk kimono");
    expect(program.prompt).not.toContain("slippers");
  });

  it("refuses a reference-free portrait whose applicable sheet identity is incomplete", () => {
    const base = laneProbeProfile();
    const profile = {
      ...base,
      attributes: base.attributes.filter((attribute) => attribute.id !== "face.shape"),
    };
    expect(laneProbeAvatarProgram({ profile })).toMatchObject({
      kind: "refused",
      code: "image_prompt_program.missing_required_fact",
      context: { keys: [`subject.probe-character.appearance.face.shape`] },
    });
  });
});

describe("loadDefaultWardrobe degradation", () => {
  /** One row of the loader's select, primed onto the db mock. */
  function primeItemRows(rows: ReadonlyArray<Record<string, unknown>>): void {
    mockDb.mockImplementation(
      () =>
        ({
          select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
        }) as unknown as ReturnType<typeof db>,
    );
  }

  it("degrades to no wardrobe AND records images.avatar.outfit_load_failed when the lookup throws", async () => {
    mockDb.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const sink = new DiagnosticCollector();
    const load = await loadDefaultWardrobeWithRevisions("u-1", ["item-1", "item-2"], sink);
    expect(load.wardrobe).toEqual([]); // degraded: coverage unknown
    const recorded = sink.items.filter((d) => d.code === "images.avatar.outfit_load_failed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.severity).toBe("warn");
    expect(recorded[0]?.context).toMatchObject({ itemIds: ["item-1", "item-2"] });
  });

  it("marks a thrown lookup as failed — unknown wardrobe, not a confirmed empty one", async () => {
    mockDb.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const load = await loadDefaultWardrobeWithRevisions("u-1", ["item-1"], new DiagnosticCollector());
    expect(load).toMatchObject({ wardrobe: [], revisions: [], failed: true });
  });

  // A malformed coverage column used to `.catch([])` into covers-nothing — a
  // positive bare claim off a row nobody could parse. It must load as
  // coverage-UNRELIABLE (exposure consumers degrade toward covered) with the
  // warn diagnostic; authored silence (no coverage field) keeps today's
  // covers-nothing read with no marker and no diagnostic.
  it.each([
    ["a non-array coverage value", { coverage: "chest" }],
    ["an array with a non-string element", { coverage: ["chest", 42] }],
    ["an unparseable definition wholesale", "not an object"],
  ])("reads %s as coverage-unreliable, never covers-nothing", async (_case, definition) => {
    primeItemRows([{ id: "item-1", name: "silk shirt", description: null, definition, updatedAt: new Date(0) }]);
    const sink = new DiagnosticCollector();
    const load = await loadDefaultWardrobeWithRevisions("u-1", ["item-1"], sink);
    expect(load.coverageUnreliableIds).toEqual(["item-1"]);
    expect(load.wardrobe[0]).toMatchObject({ name: "silk shirt", coverage: [] });
    expect(load.failed).toBeUndefined(); // the ROWS loaded; only their coverage is unknown
    expectDiagnostic(sink, "images.avatar.coverage_unreadable");
  });

  it("keeps an absent coverage field as authored covers-nothing — no marker, no diagnostic", async () => {
    primeItemRows([{ id: "item-1", name: "hairpin", description: null, definition: {}, updatedAt: new Date(0) }]);
    const sink = new DiagnosticCollector();
    const load = await loadDefaultWardrobeWithRevisions("u-1", ["item-1"], sink);
    expect(load.coverageUnreliableIds).toBeUndefined();
    expect(load.wardrobe[0]).toMatchObject({ coverage: [] });
    expect(sink.items).toEqual([]);
  });

  it("resolves each row's hair-occlusion band at the load: item override, else subtype default, sparse at none", async () => {
    // Every consumer (image cut, chat resolve, affordance read) takes the band
    // off the loaded row. A loader that dropped the override, or wrote `none`
    // explicitly, would put hair back into a prompt over a hijab.
    const row = (id: string, definition: Record<string, unknown>) => ({ id, name: id, description: null, definition, updatedAt: new Date(0) });
    primeItemRows([
      row("scarf", { subtype: "headscarf", hairOcclusion: "partial" }),
      row("hijab", { subtype: "hijab" }),
      row("shirt", { coverage: ["chest"] }),
    ]);
    const load = await loadDefaultWardrobeWithRevisions("u-1", ["scarf", "hijab", "shirt"], new DiagnosticCollector());
    expect(load.wardrobe.map((item) => item.hairOcclusion)).toEqual(["partial", "full", undefined]);
  });

  it("the standalone cut carries the worn headwear's band, independent of the coverage degrade", () => {
    const hijab = { name: "hijab", coverage: ["hair"], layer: 2 as const, opacity: "opaque" as const, hairOcclusion: "full" as const };
    expect(laneProbeAvatarCut([hijab]).hairOcclusion).toBe("full");
    // An unreadable coverage column still names its headwear: the band is not a coverage read.
    expect(laneProbeAvatarCut([hijab], laneProbeProfile(), { coverageUnreliable: true }).hairOcclusion).toBe("full");
    expect(laneProbeAvatarCut([]).hairOcclusion).toBe("none");
  });

  it("a failed wardrobe load never becomes exposure claims — a genuinely empty wardrobe still does", () => {
    // Kills the regression the Stage 3 review caught: a transient item-table
    // failure degraded to `[]`, which the cut then read as a confirmed
    // undressed character and rendered a topless portrait against the saved
    // outfit. Unknown coverage must read fully covered — the adapter's
    // exposure claims are silence for a covered region — and only CONFIRMED
    // bare states anything.
    const unavailable = laneProbeAvatarCut([], laneProbeProfile(), { wardrobeUnavailable: true });
    expect(unavailable.exposure).toEqual(FULLY_COVERED);
    expect(laneProbeAvatarCut([]).exposure.torso).toBe("bare");

    // Coverage-unreliable is the same degrade with the wardrobe LIST intact: a
    // malformed coverage column loaded the kimono with `coverage: []`, which
    // must not read as an undressed body.
    const kimono = { name: "silk kimono", coverage: [] as string[], layer: 1 as const, opacity: "opaque" as const };
    expect(laneProbeAvatarCut([kimono], laneProbeProfile(), { coverageUnreliable: true }).exposure).toEqual(FULLY_COVERED);

    // …and the compiled portrait over the degraded cut says nothing about a bare body.
    const program = laneProbeAvatarProgram({ wardrobeUnavailable: true });
    if (program.kind !== "compiled") throw new Error(`the degraded cut did not compile: ${program.kind}`);
    expect(program.prompt).not.toMatch(/\bbare\b|\btopless\b|\bnude\b/i);
  });

  it("the degraded perception hides what a fully-covering wardrobe hides — and only that", () => {
    // The perception half of the same degrade: the failed-empty worn list used
    // to read EVERY body location "visible", so optional digest facts at
    // covered locations (a chest tattoo under the saved outfit) were selected
    // and stated even while exposure claimed fully covered. Degraded, every
    // location an exposure region reaches answers hidden; the identity
    // locations a portrait requires stay in plain view (mandatory facts bypass
    // perception entirely — the program's own refusal pins that half).
    const degraded = portraitPerception([], true);
    // Wings and tail sit under back/pelvis in the registry, so a fully-covering
    // wardrobe hides them too — harmless, because morphology anchors are
    // mandatory facts and never consult perception.
    const hidden = ["chest", "breasts", "back", "waist", "groin", "buttocks", "thighs", "feet", "sole", "wings", "tail"];
    const visible = ["face", "hair", "hands", "forearms", "horns"];
    for (const location of hidden) expect(degraded.exposure[location], location).toBe("hidden");
    for (const location of visible) expect(degraded.exposure[location], location).toBe("visible");
    // The control is the bug: the same failed-empty list, un-degraded, puts the
    // whole body in the camera's plain view.
    expect(portraitPerception([], false).exposure["chest"]).toBe("visible");
  });

  it("an empty outfit skips the lookup entirely — no query, no diagnostic", async () => {
    const sink = new DiagnosticCollector();
    expect((await loadDefaultWardrobeWithRevisions("u-1", [], sink)).wardrobe).toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
    expect(sink.items).toEqual([]);
  });
});
