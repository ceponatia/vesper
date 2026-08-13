import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { parseOr } from "@/lib/parse";
import {
  bodySurfaceStateSchema,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  BODY_SURFACE_DRY_RATE_PER_HOUR,
  BODY_SURFACE_INVALID_ENTRY,
  BODY_SURFACE_MAX_LOCATIONS,
  BODY_SURFACE_UNIT_ONE,
  emptyBodySurfaceState,
  pruneDryBodySurface,
  setBodySurfaceWetness,
  type BodySurfaceReadOptions,
  type BodySurfaceState,
} from "./body-surface";

/**
 * The body-surface owner (body-attribute-affordances slice 4).
 *
 * Three things are worth pinning: a corrupt entry is QUARANTINED rather than
 * healed to dry (healing it would be the convenient default that buys dry hair's
 * extra mobility off a bad jsonb blob), the drying law is monotone, clamped, and
 * never negative — because the affordance read divides by it and a retake has to
 * reproduce it exactly — and standing rain HOLDS wetness instead of drying it.
 */

const HOUR = 60;

/** The read, collapsed for assertions: a level, or the literal "invalid". */
function level(state: BodySurfaceState, locationId: string, atMinutes: number, options?: BodySurfaceReadOptions) {
  const read = bodySurfaceWetnessAt(state, locationId, atMinutes, options);
  return read.status === "known" ? read.level : "invalid";
}

describe("the schema quarantines rather than healing", () => {
  it("parses an empty / absent value to the empty state", () => {
    expect(bodySurfaceStateSchema.parse({})).toEqual(emptyBodySurfaceState());
    expect(bodySurfaceStateSchema.parse({ wetness: {} })).toEqual(emptyBodySurfaceState());
  });

  it("quarantines a corrupt level or stamp — it never reads as dry", () => {
    const parsed = bodySurfaceStateSchema.parse({
      wetness: { hair: { level: "soaked", updatedAtMinutes: -3, cause: "typhoon" } },
    });
    expect(parsed.wetness.hair).toEqual(BODY_SURFACE_INVALID_ENTRY);
    // The distinction the whole marker exists for: absent is DRY, this is UNKNOWN.
    expect(level(parsed, "hair", 0)).toBe("invalid");
    expect(level(parsed, "chest", 0)).toBe(0);
  });

  it("quarantines only the entries that fail, never the whole record", () => {
    const parsed = bodySurfaceStateSchema.parse({
      wetness: { hair: { level: 6_000, updatedAtMinutes: 10, cause: "rain" }, chest: 42 },
    });
    expect(level(parsed, "hair", 10)).toBe(6_000);
    expect(level(parsed, "chest", 10)).toBe("invalid");
  });

  it("round-trips the marker: persisting 'we lost this' is the honest record", () => {
    const quarantined = bodySurfaceStateSchema.parse({ wetness: { hair: 42 } });
    const reloaded = bodySurfaceStateSchema.parse(JSON.parse(JSON.stringify(quarantined)));
    expect(reloaded).toEqual(quarantined);
    expect(level(reloaded, "hair", 900)).toBe("invalid");
  });

  it("an authoritative write HEALS a quarantined location", () => {
    const quarantined = bodySurfaceStateSchema.parse({ wetness: { hair: 42 } });
    const healed = setBodySurfaceWetness(quarantined, { locationId: "hair", level: 4_000, atMinutes: 5, cause: "splash" });
    expect(level(healed, "hair", 5)).toBe(4_000);
    expect(bodySurfaceWetnessEntry(healed, "hair")).toEqual({ level: 4_000, updatedAtMinutes: 5, cause: "splash" });
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
    expect(level(soaked, "hair", 0)).toBe(BODY_SURFACE_UNIT_ONE);
    expect(level(soaked, "hair", -50)).toBe(BODY_SURFACE_UNIT_ONE);
  });

  it("is monotone non-increasing in elapsed time and never goes negative", () => {
    let previous: number = BODY_SURFACE_UNIT_ONE;
    for (let minutes = 0; minutes <= 8 * HOUR; minutes += 7) {
      const value = bodySurfaceWetnessAt(soaked, "hair", minutes);
      expect(value.status).toBe("known");
      if (value.status !== "known") return;
      expect(value.level).toBeLessThanOrEqual(previous);
      expect(value.level).toBeGreaterThanOrEqual(0);
      previous = value.level;
    }
  });

  it("dries a saturated surface out in the documented 3-4 story hours", () => {
    expect(level(soaked, "hair", HOUR)).toBe(BODY_SURFACE_UNIT_ONE - BODY_SURFACE_DRY_RATE_PER_HOUR);
    expect(level(soaked, "hair", 3 * HOUR)).toBeGreaterThan(0);
    expect(level(soaked, "hair", 4 * HOUR)).toBe(0);
  });

  it("an unrecorded location is dry, and reading never mutates", () => {
    const before = JSON.stringify(soaked);
    expect(level(soaked, "chest", 5)).toBe(0);
    expect(level(soaked, "hair", 10 * HOUR)).toBe(0);
    expect(JSON.stringify(soaked)).toBe(before);
  });

  it("suspendDrying HOLDS the committed level and never raises it", () => {
    // Ten story hours of standing in the rain: she is exactly as wet as the last
    // committed write said, not drier — and not wetter either.
    expect(level(soaked, "hair", 10 * HOUR, { suspendDrying: true })).toBe(BODY_SURFACE_UNIT_ONE);
    const damp = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 3_000, atMinutes: 0 });
    expect(level(damp, "hair", 10 * HOUR, { suspendDrying: true })).toBe(3_000);
    // …and it is not a latch: drop the suspension and the same state dries as before.
    expect(level(damp, "hair", 10 * HOUR)).toBe(0);
  });

  it("suspendDrying cannot resurrect a quarantined entry", () => {
    const quarantined = bodySurfaceStateSchema.parse({ wetness: { hair: 42 } });
    expect(level(quarantined, "hair", 5, { suspendDrying: true })).toBe("invalid");
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
    expect(bodySurfaceWetnessEntry(pruned, "chest")).toEqual({ level: BODY_SURFACE_UNIT_ONE, updatedAtMinutes: 0 });
  });

  it("pruning nothing returns the same reference, so a caller can skip the write", () => {
    const surface = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 9_000, atMinutes: 0 });
    expect(pruneDryBodySurface(surface, 10)).toBe(surface);
    expect(pruneDryBodySurface(emptyBodySurfaceState(), 10)).toEqual(emptyBodySurfaceState());
  });

  it("pruning never evicts a quarantined entry — that would launder unknown into dry", () => {
    const quarantined = bodySurfaceStateSchema.parse({ wetness: { hair: 42 } });
    expect(pruneDryBodySurface(quarantined, 100 * HOUR)).toBe(quarantined);
    expect(level(quarantined, "hair", 100 * HOUR)).toBe("invalid");
  });

  it("pruning under suspended drying keeps a still-wet entry alive", () => {
    const damp = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 1_000, atMinutes: 0 });
    expect(pruneDryBodySurface(damp, HOUR).wetness.hair).toBeUndefined();
    expect(pruneDryBodySurface(damp, HOUR, { suspendDrying: true })).toBe(damp);
  });
});
