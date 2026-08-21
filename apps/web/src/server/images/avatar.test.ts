import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

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
vi.mock("./avatar-segments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./avatar-segments")>();
  return { ...actual, buildAvatarSegments: vi.fn(actual.buildAvatarSegments) };
});

import { isDemoMode } from "../ai";
import { db } from "../db";
import { runImagePipeline } from "./assets";
import {
  AVATAR_DIGEST_INELIGIBLE,
  defaultOutfitPhrase,
  generateAvatar,
  loadDefaultWardrobe,
  loadDefaultWardrobeWithRevisions,
  wardrobeOutfitText,
} from "./avatar";
import { buildAvatarSegments } from "./avatar-segments";
import { laneProbeProfile, LANE_PROBE_NAME, LANE_PROBE_SUBJECT_ID } from "@/server/test-support";

const { buildAvatarSegments: actualBuildAvatarSegments } =
  await vi.importActual<typeof import("./avatar-segments")>("./avatar-segments");

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
 * The Stage 3 digest wiring in `generateAvatar` (image-lane-consolidation
 * spec.prompts.md §Failure behavior). The assembly's own refusal semantics are
 * owned by `contracts/images/visual-segments.test.ts`; what these prove is the
 * ROUTE's half of the contract, through the pipeline seam:
 *
 * - an ELIGIBLE assembly reaches the reserve with `meta.visualState` beside
 *   style/model/demo and no precondition failure — and an EMPTY digest (a
 *   sparse human sheet) is eligible, killing the "empty digest refuses every
 *   plain human" defect;
 * - an ineligible or failed assembly fails the row via the precondition path
 *   (so the provider is never reached) AND records
 *   `images.avatar.visual_digest_ineligible` — degradation tests assert
 *   fallback and diagnostic code, per CLAUDE.md.
 */
describe("generateAvatar digest wiring", () => {
  const characterRow = {
    id: "chr-1",
    name: "Mira",
    profile: {},
    updatedAt: new Date("2026-08-21T00:00:00Z"),
  };

  function primeDb(): void {
    mockDb.mockImplementation(
      () =>
        ({
          select: () => ({
            from: () => ({ where: () => ({ limit: () => Promise.resolve([characterRow]) }) }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );
  }

  function primePipeline(): void {
    vi.mocked(isDemoMode).mockReturnValue(true);
    vi.mocked(runImagePipeline).mockResolvedValue({ imageId: "img-1", status: "ready" });
    primeDb();
  }

  it("reserves with meta.visualState and no refusal — an empty digest is still eligible", async () => {
    primePipeline();
    vi.mocked(buildAvatarSegments).mockImplementation(actualBuildAvatarSegments);
    const sink = new DiagnosticCollector();
    await expect(generateAvatar({ characterId: "chr-1", userId: "u-1", sink })).resolves.toBe("img-1");
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    expect(opts?.failedPrecondition ?? null).toBeNull();
    expect(opts?.asset.prompt).toContain("Subject: Mira");
    expect(opts?.asset.meta).toMatchObject({ demo: true, style: "realistic" });
    // The provenance fragment lands at RESERVE time, so it survives a thrown produce.
    expect(opts?.asset.meta?.visualState).toMatchObject({ version: 1, scopeKey: "standalone_character:chr-1" });
    expect(sink.items.some((d) => d.code === AVATAR_DIGEST_INELIGIBLE)).toBe(false);
  });

  it("fails the row before provider spend when required facts are missing, with the diagnostic", async () => {
    primePipeline();
    vi.mocked(buildAvatarSegments).mockReturnValue({
      segments: [],
      prompt: "",
      digestMeta: { visualState: { refused: true } },
      missingRequired: ["chr-1/wings"],
      suppressions: [],
    });
    const sink = new DiagnosticCollector();
    await generateAvatar({ characterId: "chr-1", userId: "u-1", sink });
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    expect(opts?.failedPrecondition).toMatch(/missing required facts/);
    // The refused attempt still records WHICH visual moment it refused over.
    expect(opts?.asset.meta?.visualState).toEqual({ refused: true });
    const recorded = sink.items.filter((d) => d.code === AVATAR_DIGEST_INELIGIBLE);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.context).toMatchObject({ missingRequired: ["chr-1/wings"] });
  });

  it("degrades an assembly failure to a failed row with the diagnostic, never a thrown request", async () => {
    primePipeline();
    vi.mocked(buildAvatarSegments).mockImplementation(() => {
      throw new Error("boom");
    });
    const sink = new DiagnosticCollector();
    await expect(generateAvatar({ characterId: "chr-1", userId: "u-1", sink })).resolves.toBe("img-1");
    const opts = vi.mocked(runImagePipeline).mock.calls[0]?.[0];
    expect(opts?.failedPrecondition).toMatch(/could not be assembled/);
    expect(sink.items.some((d) => d.code === AVATAR_DIGEST_INELIGIBLE)).toBe(true);
  });
});

describe("loadDefaultWardrobe degradation", () => {
  it("degrades to no wardrobe AND records images.avatar.outfit_load_failed when the lookup throws", async () => {
    mockDb.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const sink = new DiagnosticCollector();
    const wardrobe = await loadDefaultWardrobe("u-1", ["item-1", "item-2"], sink);
    expect(wardrobe).toEqual([]); // degraded: attributes-only prompt
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

  it("a failed wardrobe load never becomes exposure claims — a genuinely empty wardrobe still does", () => {
    // Kills the regression the Stage 3 review caught: a transient item-table
    // failure degraded to `[]`, which the digest path then read as a confirmed
    // undressed character and rendered a topless portrait against the saved
    // outfit. Unknown coverage must stay silent; only CONFIRMED bare states it.
    const base = {
      characterId: LANE_PROBE_SUBJECT_ID,
      name: LANE_PROBE_NAME,
      profile: laneProbeProfile(),
      style: "realistic" as const,
      wardrobe: [],
      readToken: "unavailable-wardrobe-token",
    };
    const unavailable = actualBuildAvatarSegments({ ...base, wardrobeUnavailable: true });
    expect(unavailable.segments.some((s) => s.kind === "exposure")).toBe(false);
    expect(unavailable.prompt).not.toMatch(/\bbare\b|\btopless\b|\bnude\b/i);
    expect(unavailable.missingRequired).toEqual([]); // degraded, still render-eligible

    const confirmedBare = actualBuildAvatarSegments(base);
    expect(confirmedBare.segments.some((s) => s.kind === "exposure")).toBe(true);
  });

  it("an empty outfit skips the lookup entirely — no query, no diagnostic", async () => {
    const sink = new DiagnosticCollector();
    expect(await loadDefaultWardrobe("u-1", [], sink)).toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
    expect(sink.items).toEqual([]);
  });
});
