import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector, FULLY_COVERED } from "@/contracts";
import { expectDiagnostic } from "@/test/diagnostics";

vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, isDemoMode: vi.fn(() => false) };
});
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});
vi.mock("../images", () => ({
  chatHasRenders: vi.fn(async () => true),
  chatLookKey: vi.fn(() => "look-key"),
  latestChatLook: vi.fn(async () => null),
  renderChatLookImage: vi.fn(async () => "img-1"),
  renderChatPlaceImage: vi.fn(async () => null),
}));
vi.mock("./chat-state", () => ({
  loadChatState: vi.fn(),
  loadChatScenario: vi.fn(async () => null),
  seedChatScenario: vi.fn(() => ({ garments: {}, clockMinutes: 0 })),
}));
vi.mock("./chat-wardrobe", () => ({
  resolveChatWardrobe: vi.fn(),
}));
// The look mint's digest cut rides the shared committed-cut factory since the
// Stage 4 cutover; mocked like every other collaborator so this unit stays
// hermetic (the factory itself is exercised by the visual-state suites).
vi.mock("./chat-pipeline", () => ({
  chatVisualStateShadowInput: vi.fn(() => ({ subjectId: "chr-1", cutId: "cut-1" })),
}));

import { db } from "../db";
import { renderChatLookImage } from "../images";
import { runChatLookImage } from "./chat-reference-images";
import { loadChatState } from "./chat-state";
import { resolveChatWardrobe } from "./chat-wardrobe";

/**
 * The look job over a degraded wardrobe resolve (docs/resilience.md §8 —
 * degradation without a record hides bugs). Falsified against the old job: a
 * transient failure during the detached run resolved a covered-degraded
 * wardrobe, whose DIFFERENT lookKey minted a wrong look ("Keep a simple,
 * casual outfit.") and then keep-latest PURGED the correct anchor — with no
 * sink anywhere, so nothing recorded why every scene now anchored on the
 * wrong clothes. Unreliable resolves must skip the mint entirely (no render,
 * no purge) and say so; the next outfit/appearance change retries.
 */
describe("runChatLookImage over a degraded wardrobe resolve", () => {
  const payload = { chatId: "chat-1", characterId: "chr-1" };
  const resolved = (unreliable: boolean) => ({
    garments: "a linen shirt",
    exposure: FULLY_COVERED,
    exposed: false,
    hairOcclusion: "none" as const,
    wornItemIds: ["def_shirt"],
    overlay: "",
    partVisibility: {},
    ...(unreliable ? { unreliable: true } : {}),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // loadRenderContext's two limited selects: the chat row, then the
    // character — then, past the unreliable-wardrobe gate, the participant row
    // the digest cut's `memoryGroupId` comes from.
    const rows = [
      [{ ownerId: "owner-1" }],
      [{ profile: {}, avatarImageId: "img-avatar" }],
      [{ memoryGroupId: "mg-1" }],
    ];
    vi.mocked(db).mockImplementation(
      () =>
        ({
          select: () => ({
            from: () => ({ where: () => ({ limit: () => Promise.resolve(rows.shift() ?? []) }) }),
          }),
        }) as unknown as ReturnType<typeof db>,
    );
    vi.mocked(loadChatState).mockResolvedValue({
      wornItemIds: ["def_shirt"],
      outfit: "",
      outfitExposed: false,
      attributeOverlays: [],
    } as unknown as Awaited<ReturnType<typeof loadChatState>>);
  });

  it("skips the mint — no render, no purge — and records the warn", async () => {
    vi.mocked(resolveChatWardrobe).mockResolvedValue(resolved(true));
    const sink = new DiagnosticCollector();
    await runChatLookImage(payload, sink);
    expect(renderChatLookImage).not.toHaveBeenCalled();
    expectDiagnostic(sink, "images.chat_look.wardrobe_unreliable");
  });

  it("a healthy resolve still mints — the skip is the degradation path, not the default", async () => {
    vi.mocked(resolveChatWardrobe).mockResolvedValue(resolved(false));
    const sink = new DiagnosticCollector();
    await runChatLookImage(payload, sink);
    expect(renderChatLookImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderChatLookImage).mock.calls[0]?.[0]).toMatchObject({
      lookKey: "look-key",
      outfit: "a linen shirt",
      // The digest cut travels with the mint since Stage 4 — a mint that lost
      // it would silently drop back to the route-owned prompt with no record.
      visual: { subjectId: "chr-1", cutId: "cut-1" },
    });
    expect(sink.items).toEqual([]);
  });
});
