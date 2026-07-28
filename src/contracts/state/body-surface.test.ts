import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { parseOr } from "@/lib/parse";
import {
  bodySurfaceStateSchema,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  BODY_SURFACE_DRY_RATE_PER_HOUR,
  BODY_SURFACE_MAX_LOCATIONS,
  BODY_SURFACE_UNIT_ONE,
  emptyBodySurfaceState,
  pruneDryBodySurface,
  setBodySurfaceWetness,
} from "./body-surface";

/**
 * The body-surface owner (body-attribute-affordances slice 4).
 *
 * Two things are worth pinning: the schema degrades toward DRY (a corrupt level
 * must never invent a soaking), and the drying law is monotone, clamped, and
 * never negative — because the affordance read divides by it and a retake has to
 * reproduce it exactly.
 */

const HOUR = 60;

describe("the schema heals toward dry", () => {
  it("parses an empty / absent value to the empty state", () => {
    expect(bodySurfaceStateSchema.parse({})).toEqual(emptyBodySurfaceState());
    expect(bodySurfaceStateSchema.parse({ wetness: {} })).toEqual(emptyBodySurfaceState());
  });

  it("catches a corrupt level and a corrupt stamp per FIELD, keeping the entry", () => {
    const parsed = bodySurfaceStateSchema.parse({
      wetness: { hair: { level: "soaked", updatedAtMinutes: -3, cause: "typhoon" } },
    });
    // Level degrades to dry, the stamp to zero, the unknown cause drops — and the
    // entry survives, because one bad field is not a reason to forget the location.
    expect(parsed.wetness.hair).toEqual({ level: 0, updatedAtMinutes: 0 });
  });

  it("drops only the entries that fail, never the whole record", () => {
    const parsed = bodySurfaceStateSchema.parse({
      wetness: { hair: { level: 6_000, updatedAtMinutes: 10, cause: "rain" }, chest: 42 },
    });
    expect(parsed.wetness.hair?.level).toBe(6_000);
    expect(parsed.wetness.chest).toBeUndefined();
  });

  it("clamps the record size", () => {
    const wetness: Record<string, unknown> = {};
    for (let i = 0; i < BODY_SURFACE_MAX_LOCATIONS + 10; i++) wetness[`loc_${i}`] = { level: 1_000, updatedAtMinutes: 0 };
    expect(Object.keys(bodySurfaceStateSchema.parse({ wetness }).wetness)).toHaveLength(BODY_SURFACE_MAX_LOCATIONS);
  });

  it("a rubbish blob degrades to the empty state WITH the boundary diagnostic", () => {
    const sink = new DiagnosticCollector();
    const healed = parseOr(bodySurfaceStateSchema, "not a surface", emptyBodySurfaceState(), sink, "character_chat_state.body_surface");
    expect(healed).toEqual(emptyBodySurfaceState());
    const failure = sink.items.find((d) => d.code === "parse.boundary_failed");
    expect(failure?.path).toBe("character_chat_state.body_surface");
  });
});

describe("the drying law", () => {
  const soaked = setBodySurfaceWetness(emptyBodySurfaceState(), {
    locationId: "hair",
    level: BODY_SURFACE_UNIT_ONE,
    atMinutes: 0,
    cause: "rain",
  });

  it("is the identity at or before the last write", () => {
    expect(bodySurfaceWetnessAt(soaked, "hair", 0)).toBe(BODY_SURFACE_UNIT_ONE);
    expect(bodySurfaceWetnessAt(soaked, "hair", -50)).toBe(BODY_SURFACE_UNIT_ONE);
  });

  it("is monotone non-increasing in elapsed time and never goes negative", () => {
    let previous = BODY_SURFACE_UNIT_ONE;
    for (let minutes = 0; minutes <= 8 * HOUR; minutes += 7) {
      const value = bodySurfaceWetnessAt(soaked, "hair", minutes);
      expect(value).toBeLessThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      previous = value;
    }
  });

  it("dries a saturated surface out in the documented 3-4 story hours", () => {
    expect(bodySurfaceWetnessAt(soaked, "hair", HOUR)).toBe(BODY_SURFACE_UNIT_ONE - BODY_SURFACE_DRY_RATE_PER_HOUR);
    expect(bodySurfaceWetnessAt(soaked, "hair", 3 * HOUR)).toBeGreaterThan(0);
    expect(bodySurfaceWetnessAt(soaked, "hair", 4 * HOUR)).toBe(0);
  });

  it("an unrecorded location is dry, and reading never mutates", () => {
    const before = JSON.stringify(soaked);
    expect(bodySurfaceWetnessAt(soaked, "chest", 5)).toBe(0);
    expect(bodySurfaceWetnessAt(soaked, "hair", 10 * HOUR)).toBe(0);
    expect(JSON.stringify(soaked)).toBe(before);
  });
});

describe("writes", () => {
  it("clamps into range and stamps the change minute", () => {
    const over = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 99_999, atMinutes: 12 });
    expect(bodySurfaceWetnessEntry(over, "hair")).toEqual({ level: BODY_SURFACE_UNIT_ONE, updatedAtMinutes: 12 });
  });

  it("a level of zero DROPS the entry — dry is the absence default", () => {
    const wet = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 5_000, atMinutes: 0 });
    const dried = setBodySurfaceWetness(wet, { locationId: "hair", level: -100, atMinutes: 30 });
    expect(dried.wetness.hair).toBeUndefined();
  });

  it("pruning removes only what has dried to nothing, and never restamps the rest", () => {
    let surface = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 1_000, atMinutes: 0, cause: "splash" });
    surface = setBodySurfaceWetness(surface, { locationId: "chest", level: BODY_SURFACE_UNIT_ONE, atMinutes: 0 });
    const pruned = pruneDryBodySurface(surface, HOUR);
    expect(pruned.wetness.hair).toBeUndefined();
    // The still-wet entry keeps its ORIGINAL stamp — that stamp is the cause's
    // freshness anchor, and restamping it would make old weather read as new.
    expect(pruned.wetness.chest?.updatedAtMinutes).toBe(0);
  });

  it("pruning nothing returns the same reference, so a caller can skip the write", () => {
    const surface = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 9_000, atMinutes: 0 });
    expect(pruneDryBodySurface(surface, 10)).toBe(surface);
    expect(pruneDryBodySurface(emptyBodySurfaceState(), 10)).toEqual(emptyBodySurfaceState());
  });
});
