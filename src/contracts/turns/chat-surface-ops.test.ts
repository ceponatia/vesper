import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import {
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  BODY_SURFACE_UNIT_ONE,
  emptyBodySurfaceState,
  setBodySurfaceWetness,
} from "../state/body-surface";
import { emptyChatEnvironment } from "../state/chat-environment";
import {
  applyEnvironmentProposal,
  applySurfaceWetnessProposals,
  chatEnvironmentProposalSchema,
  CHAT_SURFACE_LOCATION_UNKNOWN,
  CHAT_SURFACE_WETNESS_MAX,
  SURFACE_WETNESS_DEGREE_DELTA,
  surfaceWetnessProposalListSchema,
  type SurfaceWetnessProposal,
} from "./chat-surface-ops";

/**
 * The extraction proposals and their pure apply layer (body-attribute-affordances
 * slice 4). Same discipline as the garment proposals: the model speaks semantics,
 * the reducer owns the numbers, and an unownable target drops with a stable code
 * rather than minting state nothing reads.
 */

const HOUR = 60;
const wet = (over: Partial<SurfaceWetnessProposal> = {}): SurfaceWetnessProposal => ({
  location: "hair",
  direction: "increase",
  degree: 2,
  ...over,
});

describe("the proposal schemas are lenient per field and per item", () => {
  it("drops an out-of-vocabulary environment field, keeping the good ones", () => {
    expect(chatEnvironmentProposalSchema.parse({ wind: "typhoon", precipitation: "rain" })).toEqual({
      precipitation: "rain",
    });
    expect(chatEnvironmentProposalSchema.parse("weather")).toEqual({});
    expect(chatEnvironmentProposalSchema.parse(undefined)).toEqual({});
  });

  it("drops only the malformed wetness items", () => {
    const parsed = surfaceWetnessProposalListSchema.parse([
      { location: "hair", direction: "increase", degree: 3, cause: "rain" },
      { location: "hair", direction: "sideways", degree: 1 },
      "soaked",
      { location: "hair", direction: "decrease", degree: 9 },
    ]);
    expect(parsed).toEqual([
      { location: "hair", direction: "increase", degree: 3, cause: "rain" },
      // An out-of-range degree catches to the middle band; the proposal survives.
      { location: "hair", direction: "decrease", degree: 2 },
    ]);
  });

  it("caps the list and heals a non-array", () => {
    const many = Array.from({ length: CHAT_SURFACE_WETNESS_MAX + 3 }, () => wet());
    expect(surfaceWetnessProposalListSchema.parse(many)).toHaveLength(CHAT_SURFACE_WETNESS_MAX);
    expect(surfaceWetnessProposalListSchema.parse("nope")).toEqual([]);
  });
});

describe("applyEnvironmentProposal", () => {
  it("patches only the named keys — an absent key is 'unchanged', never 'reset'", () => {
    const standing = { ...emptyChatEnvironment(), wind: "windy" as const, indoors: false, updatedAtMinutes: 5 };
    const { environment, trace } = applyEnvironmentProposal({
      environment: standing,
      proposal: { precipitation: "rain" },
      atMinutes: 40,
    });
    expect(environment).toEqual({ wind: "windy", precipitation: "rain", indoors: false, updatedAtMinutes: 40 });
    expect(trace.map((t) => t.target)).toEqual(["precipitation"]);
  });

  it("a no-op patch leaves the stamp alone — it is the freshness anchor", () => {
    const standing = { ...emptyChatEnvironment(), wind: "breeze" as const, updatedAtMinutes: 5 };
    const same = applyEnvironmentProposal({ environment: standing, proposal: { wind: "breeze" }, atMinutes: 900 });
    expect(same.environment).toBe(standing);
    expect(same.trace).toEqual([]);
    const absent = applyEnvironmentProposal({ environment: standing, atMinutes: 900 });
    expect(absent.environment.updatedAtMinutes).toBe(5);
  });
});

describe("applySurfaceWetnessProposals", () => {
  it("maps degree onto the delta table and clamps at saturation", () => {
    const { surface, trace } = applySurfaceWetnessProposals({
      surface: emptyBodySurfaceState(),
      proposals: [wet({ degree: 1, cause: "splash" })],
      atMinutes: 10,
    });
    expect(bodySurfaceWetnessAt(surface, "hair", 10)).toBe(SURFACE_WETNESS_DEGREE_DELTA[1]);
    expect(bodySurfaceWetnessEntry(surface, "hair")?.cause).toBe("splash");
    expect(trace[0]?.outcome).toBe("applied");

    const saturated = applySurfaceWetnessProposals({
      surface: surface,
      proposals: [wet({ degree: 3, cause: "immersion" })],
      atMinutes: 10,
    });
    expect(bodySurfaceWetnessAt(saturated.surface, "hair", 10)).toBe(BODY_SURFACE_UNIT_ONE);
  });

  it("a decrease clamps at dry and drops the stale cause with the entry", () => {
    const soaked = setBodySurfaceWetness(emptyBodySurfaceState(), {
      locationId: "hair",
      level: BODY_SURFACE_UNIT_ONE,
      atMinutes: 0,
      cause: "rain",
    });
    const { surface } = applySurfaceWetnessProposals({
      surface: soaked,
      proposals: [wet({ direction: "decrease", degree: 3 })],
      atMinutes: 5,
    });
    expect(bodySurfaceWetnessAt(surface, "hair", 5)).toBe(0);
    expect(bodySurfaceWetnessEntry(surface, "hair")).toBeUndefined();
  });

  it("integrates drying FIRST, so the delta lands on the honest current value", () => {
    const soaked = setBodySurfaceWetness(emptyBodySurfaceState(), {
      locationId: "hair",
      level: BODY_SURFACE_UNIT_ONE,
      atMinutes: 0,
      cause: "rain",
    });
    // An hour later the hair is at 7_000; a "slight" towel takes 2_500 off THAT,
    // not off the stale 10_000 the column still held.
    const { surface } = applySurfaceWetnessProposals({
      surface: soaked,
      proposals: [wet({ direction: "decrease", degree: 1 })],
      atMinutes: HOUR,
    });
    expect(bodySurfaceWetnessAt(surface, "hair", HOUR)).toBe(7_000 - SURFACE_WETNESS_DEGREE_DELTA[1]);
  });

  it("rejects an unowned location with the stable code, and keeps going", () => {
    const sink = new DiagnosticCollector();
    const { surface, trace } = applySurfaceWetnessProposals({
      surface: emptyBodySurfaceState(),
      proposals: [wet({ location: "left_elbow" }), wet({ degree: 2, cause: "rain" })],
      atMinutes: 3,
      sink,
    });
    expect(trace[0]).toMatchObject({ target: "left_elbow", outcome: "rejected", code: CHAT_SURFACE_LOCATION_UNKNOWN });
    expect(surface.wetness.left_elbow).toBeUndefined();
    expect(bodySurfaceWetnessAt(surface, "hair", 3)).toBe(SURFACE_WETNESS_DEGREE_DELTA[2]);
    expect(sink.items.map((d) => d.code)).toContain(CHAT_SURFACE_LOCATION_UNKNOWN);
  });

  it("an empty list is an idempotent no-op on a surface with nothing dry to prune", () => {
    const surface = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 8_000, atMinutes: 0 });
    const once = applySurfaceWetnessProposals({ surface, proposals: [], atMinutes: 20 });
    const twice = applySurfaceWetnessProposals({ surface: once.surface, proposals: [], atMinutes: 20 });
    expect(once.surface).toEqual(surface);
    expect(twice.surface).toEqual(surface);
    expect(once.trace).toEqual([]);
    expect(twice.trace).toEqual([]);
  });

  it("an empty list still evicts an entry that has dried all the way out", () => {
    const surface = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 1_000, atMinutes: 0 });
    const { surface: pruned } = applySurfaceWetnessProposals({ surface, proposals: [], atMinutes: HOUR });
    expect(pruned.wetness.hair).toBeUndefined();
    // …which changes no read: absent and zero are the same answer.
    expect(bodySurfaceWetnessAt(pruned, "hair", HOUR)).toBe(bodySurfaceWetnessAt(surface, "hair", HOUR));
  });
});
