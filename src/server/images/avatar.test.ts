import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});

import { db } from "../db";
import { loadDefaultWardrobe } from "./avatar";

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.resetAllMocks();
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

  it("an empty outfit skips the lookup entirely — no query, no diagnostic", async () => {
    const sink = new DiagnosticCollector();
    expect(await loadDefaultWardrobe("u-1", [], sink)).toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
    expect(sink.items).toEqual([]);
  });
});
