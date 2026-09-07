import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_PROMPT_PROGRAM_META_KEY, IMAGE_WORLD_STATE_META_KEY, type ResolvedImageProfile } from "@vesper/image-core";
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
  const characterRow = (profile: unknown) => ({
    id: "chr-1",
    name: "Mira",
    profile,
    updatedAt: new Date("2026-08-21T00:00:00Z"),
  });
  const bound = resolvedImageProfileFixture(LANE_PROBE_PORTRAIT_PROFILE);

  function prime(options: { demo: boolean; profile: unknown; picked?: ResolvedImageProfile }): void {
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
            from: () => ({ where: () => ({ limit: () => Promise.resolve([characterRow(options.profile)]) }) }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );
  }

  const reserved = () => vi.mocked(runImagePipeline).mock.calls[0]?.[0];
  const generate = (sink: DiagnosticCollector) => generateAvatar({ characterId: "chr-1", userId: "u-1", sink });

  it("demo mode compiles nothing: the row reserves with meta.visualState, the monogram's label as its prompt and no refusal", async () => {
    prime({ demo: true, profile: {} });
    const sink = new DiagnosticCollector();
    await expect(generate(sink)).resolves.toBe("img-1");
    const opts = reserved();
    expect(opts?.failedPrecondition ?? null).toBeNull();
    expect(opts?.asset.prompt).toBe("Mira");
    expect(opts?.asset.meta).toMatchObject({ demo: true, style: "realistic", model: "demo" });
    // The provenance fragment lands at RESERVE time, so it survives a thrown produce.
    expect(opts?.asset.meta?.visualState).toMatchObject({ version: 1, scopeKey: "standalone_character:chr-1" });
    expect(vi.mocked(renderImageIntent)).not.toHaveBeenCalled();
    expect(sink.items.filter((d) => d.code.startsWith("images.avatar."))).toEqual([]);
  });

  it("a bound model sends exactly the prompt the row stores, with the program's provenance beside the cut's", async () => {
    prime({ demo: false, profile: laneProbeProfile(), picked: bound });
    const sink = new DiagnosticCollector();
    await expect(generate(sink)).resolves.toBe("img-1");
    const opts = reserved();
    expect(opts?.failedPrecondition ?? null).toBeNull();
    const intent = vi.mocked(renderImageIntent).mock.calls[0]?.[0];
    expect(intent?.prompt).toBe(opts?.asset.prompt);
    expect(intent?.prompt).toMatch(/late twenties/);
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
    // A sheet that projects a subject but no apparent-age band: the age anchor
    // is mandatory and fails closed.
    const base = laneProbeProfile();
    prime({
      demo: false,
      profile: { ...base, attributes: base.attributes.filter((value) => value.id !== "identity.apparent_age") },
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
    await expect(generate(sink)).resolves.toBe("img-1");
    expect(reserved()?.failedPrecondition).toMatch(/could not be assembled/);
    expectDiagnostic(sink, AVATAR_CUT_FAILED);
  });
});

/**
 * The portrait studio's field policy, read off the compiled program — the one
 * prompt a portrait sends. The selection's consent gate, the adapter's
 * excluded-field and non-visual gates and the lane's decision not to project an
 * intimate reveal each have their own owner; this pins what they add up to for
 * THIS lane, because the defect is a one-line one — `intimateAllowed: true` or
 * an `intimateReveal` on the avatar program — and the picture it produces is a
 * nude portrait of a character whose sheet merely lists their anatomy.
 */
describe("the portrait program's field policy", () => {
  it("withholds intimate anatomy, non-visual senses and excluded fields — bare or dressed", () => {
    const base = laneProbeProfile();
    const profile: CharacterProfile = {
      ...base,
      attributes: [...base.attributes, attr("identity.natal_sex", "female", "base")],
    };
    for (const wardrobe of [[], laneProbeWardrobe()]) {
      const program = laneProbeAvatarProgram({ profile, wardrobe });
      if (program.kind !== "compiled") throw new Error(`the avatar program did not compile: ${program.kind}`);
      expect(program.prompt).toMatch(/late twenties/); // the sheet does reach the prompt…
      expect(program.prompt).not.toMatch(/\bample\b|\bpuffy\b/); // …minus breasts.size / breasts.nipples
      expect(program.prompt).not.toMatch(/gravelly/); // voice.timbre never renders
      expect(program.prompt).not.toMatch(/natal/i); // identity.natal_sex is excludeFromPrompts
    }
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
