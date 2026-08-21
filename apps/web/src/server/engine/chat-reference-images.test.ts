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
}));
vi.mock("./chat-wardrobe", () => ({
  resolveChatWardrobe: vi.fn(),
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
    wornItemIds: ["def_shirt"],
    overlay: "",
    partVisibility: {},
    ...(unreliable ? { unreliable: true } : {}),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // loadRenderContext's two limited selects: the chat row, then the character.
    const rows = [[{ ownerId: "owner-1" }], [{ profile: {}, avatarImageId: "img-avatar" }]];
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
    });
    expect(sink.items).toEqual([]);
  });
});
