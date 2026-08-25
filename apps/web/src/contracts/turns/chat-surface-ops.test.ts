import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import {
  bodySurfaceDepositIdFor,
  bodySurfaceDepositsAt,
  bodySurfaceStateSchema,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  BODY_SURFACE_INVALID_ENTRY,
  BODY_SURFACE_UNIT_ONE,
  commitBodySurfaceDeposit,
  emptyBodySurfaceState,
  setBodySurfaceWetness,
  type BodySurfaceState,
} from "../state/body-surface";
import { emptyChatEnvironment, type ChatEnvironment } from "../state/chat-environment";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  applyEnvironmentProposal,
  applySurfaceDepositProposals,
  applySurfaceWetnessProposals,
  chatEnvironmentProposalSchema,
  CHAT_SURFACE_DEPOSIT_CAPACITY,
  CHAT_SURFACE_LOCATION_UNKNOWN,
  CHAT_SURFACE_PROPOSAL_INVALID,
  CHAT_SURFACE_WETNESS_MAX,
  parseSurfaceDepositProposals,
  parseSurfaceWetnessProposals,
  SURFACE_DEPOSIT_DEGREE_DELTA,
  SURFACE_WETNESS_DEGREE_DELTA,
  surfaceDryingSuspended,
  type SurfaceDepositProposal,
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

const DOWNPOUR: ChatEnvironment = { wind: "none", precipitation: "downpour", indoors: false, updatedAtMinutes: 0 };

/** The read, collapsed for assertions: a level, or the literal "invalid". */
function level(state: BodySurfaceState, locationId: string, atMinutes: number) {
  const read = bodySurfaceWetnessAt(state, locationId, atMinutes);
  return read.status === "known" ? read.level : "invalid";
}

describe("the proposal schemas are lenient per field and per item", () => {
  it("drops an out-of-vocabulary environment field, keeping the good ones", () => {
    expect(chatEnvironmentProposalSchema.parse({ wind: "typhoon", precipitation: "rain" })).toEqual({
      precipitation: "rain",
    });
    expect(chatEnvironmentProposalSchema.parse("weather")).toEqual({});
    expect(chatEnvironmentProposalSchema.parse(undefined)).toEqual({});
  });

  it("drops the malformed wetness items and REPORTS the drop", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseSurfaceWetnessProposals(
      [
        { location: "hair", direction: "increase", degree: 3, cause: "rain" },
        { location: "hair", direction: "sideways", degree: 1 },
        "soaked",
        // A hallucinated magnitude is NOT repaired to the middle band — repairing
        // it would commit a 50% change nobody proposed.
        { location: "hair", direction: "decrease", degree: 999 },
      ],
      sink,
      "chat_archivist.surfaceWetness",
    );
    expect(parsed).toEqual([{ location: "hair", direction: "increase", degree: 3, cause: "rain" }]);
    const dropped = sink.items.find((d) => d.code === CHAT_SURFACE_PROPOSAL_INVALID);
    expect(dropped?.severity).toBe("warn");
    expect(dropped?.path).toBe("chat_archivist.surfaceWetness");
    expect(dropped?.context).toMatchObject({ dropped: 3, kept: 1 });
  });

  it("keeps a bad CAUSE, which is provenance only, and stays silent about it", () => {
    const sink = new DiagnosticCollector();
    expect(parseSurfaceWetnessProposals([{ location: "hair", direction: "increase", degree: 1, cause: "typhoon" }], sink)).toEqual([
      { location: "hair", direction: "increase", degree: 1 },
    ]);
    expect(sink.items).toEqual([]);
  });

  it("caps the list and heals a non-array", () => {
    const many = Array.from({ length: CHAT_SURFACE_WETNESS_MAX + 3 }, () => wet());
    expect(parseSurfaceWetnessProposals(many)).toHaveLength(CHAT_SURFACE_WETNESS_MAX);
    expect(parseSurfaceWetnessProposals("nope")).toEqual([]);
    expect(parseSurfaceWetnessProposals(undefined)).toEqual([]);
  });
});

describe("a malformed degree never becomes state", () => {
  it("degree 999 changes nothing and files the diagnostic", () => {
    const sink = new DiagnosticCollector();
    const proposals = parseSurfaceWetnessProposals(
      [
        { location: "hair", direction: "increase", degree: 999, cause: "rain" },
        { location: "hair", direction: "increase", degree: 1, cause: "splash" },
      ],
      sink,
    );
    const { surface } = applySurfaceWetnessProposals({
      surface: emptyBodySurfaceState(),
      proposals,
      atMinutes: 4,
      sink,
    });
    // The good sibling in the SAME list still applies — item-lenient, not list-lenient.
    expect(level(surface, "hair", 4)).toBe(SURFACE_WETNESS_DEGREE_DELTA[1]);
    expect(sink.items.map((d) => d.code)).toContain(CHAT_SURFACE_PROPOSAL_INVALID);
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
    expect(level(surface, "hair", 10)).toBe(SURFACE_WETNESS_DEGREE_DELTA[1]);
    expect(bodySurfaceWetnessEntry(surface, "hair")).toMatchObject({ cause: "splash" });
    expect(trace[0]?.outcome).toBe("applied");

    const saturated = applySurfaceWetnessProposals({
      surface: surface,
      proposals: [wet({ degree: 3, cause: "immersion" })],
      atMinutes: 10,
    });
    expect(level(saturated.surface, "hair", 10)).toBe(BODY_SURFACE_UNIT_ONE);
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
    expect(level(surface, "hair", 5)).toBe(0);
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
    expect(level(surface, "hair", HOUR)).toBe(7_000 - SURFACE_WETNESS_DEGREE_DELTA[1]);
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
    expect(level(surface, "hair", 3)).toBe(SURFACE_WETNESS_DEGREE_DELTA[2]);
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
    expect(level(pruned, "hair", HOUR)).toBe(level(surface, "hair", HOUR));
  });
});

describe("standing outdoor rain holds wetness instead of drying it", () => {
  const soaked = setBodySurfaceWetness(emptyBodySurfaceState(), {
    locationId: "hair",
    level: BODY_SURFACE_UNIT_ONE,
    atMinutes: 0,
    cause: "rain",
  });

  it("suspends drying only outdoors, and only while something is falling", () => {
    expect(surfaceDryingSuspended(DOWNPOUR)).toBe(true);
    expect(surfaceDryingSuspended({ ...DOWNPOUR, indoors: true })).toBe(false);
    expect(surfaceDryingSuspended({ ...DOWNPOUR, precipitation: "none" })).toBe(false);
    expect(surfaceDryingSuspended(emptyChatEnvironment())).toBe(false);
  });

  it("a quiet exchange in a downpour holds the soaking; the same exchange indoors dries it", () => {
    // Three story hours of rain and no proposal at all: she is still soaked, and
    // the entry is not pruned out from under the next read either.
    const held = applySurfaceWetnessProposals({
      surface: soaked,
      proposals: [],
      atMinutes: 3 * HOUR,
      environment: DOWNPOUR,
    });
    expect(held.surface).toBe(soaked);
    expect(bodySurfaceWetnessAt(held.surface, "hair", 3 * HOUR, { suspendDrying: true })).toEqual({
      status: "known",
      level: BODY_SURFACE_UNIT_ONE,
    });

    // Under cover, the identical fold dries exactly as it always did.
    const dried = applySurfaceWetnessProposals({
      surface: soaked,
      proposals: [],
      atMinutes: 3 * HOUR,
      environment: { ...DOWNPOUR, indoors: true },
    });
    expect(level(dried.surface, "hair", 3 * HOUR)).toBe(BODY_SURFACE_UNIT_ONE - 3 * 3_000);
    // …and an absent environment is the pre-review behaviour: no suspension.
    const noEnvironment = applySurfaceWetnessProposals({ surface: soaked, proposals: [], atMinutes: 3 * HOUR });
    expect(noEnvironment.surface).toEqual(dried.surface);
  });

  it("holding never RAISES the level — only a proposal can", () => {
    const damp = setBodySurfaceWetness(emptyBodySurfaceState(), { locationId: "hair", level: 3_000, atMinutes: 0 });
    const { surface } = applySurfaceWetnessProposals({
      surface: damp,
      proposals: [],
      atMinutes: 5 * HOUR,
      environment: DOWNPOUR,
    });
    expect(bodySurfaceWetnessAt(surface, "hair", 5 * HOUR, { suspendDrying: true })).toEqual({ status: "known", level: 3_000 });
  });

  it("a decrease in the rain still lands on the HELD level, not a dried one", () => {
    const { surface } = applySurfaceWetnessProposals({
      surface: soaked,
      proposals: [wet({ direction: "decrease", degree: 1 })],
      atMinutes: 3 * HOUR,
      environment: DOWNPOUR,
    });
    // 10_000 held (not dried to 1_000) minus the "slight" band.
    expect(level(surface, "hair", 3 * HOUR)).toBe(BODY_SURFACE_UNIT_ONE - SURFACE_WETNESS_DEGREE_DELTA[1]);
  });
});

describe("a quarantined location", () => {
  const quarantined = bodySurfaceStateSchema.parse({ wetness: { hair: 42 } });

  it("survives a quiet exchange — the fold never launders it into dry", () => {
    const { surface } = applySurfaceWetnessProposals({ surface: quarantined, proposals: [], atMinutes: 500 });
    expect(surface.wetness.hair).toEqual(BODY_SURFACE_INVALID_ENTRY);
    expect(level(surface, "hair", 500)).toBe("invalid");
  });

  it("is HEALED by a proposal — a fresh authoritative write replaces the marker", () => {
    const { surface, trace } = applySurfaceWetnessProposals({
      surface: quarantined,
      proposals: [wet({ degree: 2, cause: "rain" })],
      atMinutes: 12,
    });
    expect(level(surface, "hair", 12)).toBe(SURFACE_WETNESS_DEGREE_DELTA[2]);
    expect(bodySurfaceWetnessEntry(surface, "hair")).toEqual({ level: 5_000, updatedAtMinutes: 12, cause: "rain" });
    expect(trace[0]).toMatchObject({ target: "hair", outcome: "applied", detail: "invalid → 5000 (rain)" });
  });
});


/**
 * The deposit proposals and their fold. Two things here are NOT the wetness
 * lane's rules and are the reason this block exists: an unrecognised substance
 * is admitted rather than dropped (the vocabulary already carries `unknown` as
 * a real answer, so refusing the item would lose a true fact to protect a list
 * that has already made room for the case), and a refusal to commit is reported
 * as a refusal rather than as "nothing changed".
 */
describe("applySurfaceDepositProposals", () => {
  const deposit = (overrides: Partial<SurfaceDepositProposal> = {}): SurfaceDepositProposal => ({
    location: "hands",
    substance: "mud",
    direction: "add",
    degree: 2,
    ...overrides,
  });

  it("maps degree onto the delta table, and a remove of the same degree clears it", () => {
    const added = applySurfaceDepositProposals({
      surface: emptyBodySurfaceState(),
      proposals: [deposit()],
      atMinutes: 30,
    });
    expect(bodySurfaceDepositsAt(added.surface, "hands", 30)[0]?.read.amount).toBe(SURFACE_DEPOSIT_DEGREE_DELTA[2]);
    expect(added.trace).toEqual([
      { kind: "deposit", target: "hands", outcome: "applied", code: "", detail: "add mud 2" },
    ]);
    const removed = applySurfaceDepositProposals({
      surface: added.surface,
      proposals: [deposit({ direction: "remove" })],
      atMinutes: 40,
    });
    expect(removed.surface.deposits).toBeUndefined();
    // Nothing left to take off is a no-op, not a rejection — the fiction wiping
    // clean hands is not a failure of anything.
    const again = applySurfaceDepositProposals({
      surface: removed.surface,
      proposals: [deposit({ direction: "remove" })],
      atMinutes: 41,
    });
    expect(again.surface).toBe(removed.surface);
    expect(again.trace[0]?.outcome).toBe("no_change");
  });

  it("admits an unnamed substance as `unknown` rather than losing the fact", () => {
    // Falsified against a strict substance field: "she comes back with something
    // on her hands" is TRUE, and refusing the item to protect the vocabulary
    // would record that her hands are clean.
    const parsed = parseSurfaceDepositProposals([{ ...deposit(), substance: "glitter" }]);
    expect(parsed[0]?.substance).toBe("unknown");
    // The magnitude and the sign stay strict, because those are what move state.
    const sink = new DiagnosticCollector();
    expect(parseSurfaceDepositProposals([{ ...deposit(), degree: 9 }], sink)).toEqual([]);
    expectDiagnostic(sink, CHAT_SURFACE_PROPOSAL_INVALID, { times: 1 });
  });

  it("refuses a location outside the owned set — the intimate tree is excluded by construction", () => {
    // The list is everyday surfaces only. Intimate anatomy is gated per
    // character, and recording material there would need that gate honoured on
    // every read before the fold could accept it at all.
    const sink = new DiagnosticCollector();
    const fold = applySurfaceDepositProposals({
      surface: emptyBodySurfaceState(),
      proposals: [deposit({ location: "groin" }), deposit({ location: "forearms" })],
      atMinutes: 30,
      sink,
    });
    expect(fold.trace.map((entry) => entry.outcome)).toEqual(["rejected", "applied"]);
    expect(fold.trace[0]?.code).toBe(CHAT_SURFACE_LOCATION_UNKNOWN);
    expectDiagnostic(sink, CHAT_SURFACE_LOCATION_UNKNOWN, { times: 1 });
  });

  it("reports a full record as a refusal, never as `no_change`", () => {
    // Falsified against a fold that read "the owner returned the same surface"
    // as "nothing needed doing": a body already carrying its maximum would then
    // silently swallow every new deposit with nothing on the record to say the
    // material was dropped.
    let surface = emptyBodySurfaceState();
    for (let index = 0; index < 12; index += 1) {
      surface = commitBodySurfaceDeposit(surface, {
        locationId: "hands",
        kind: "dust",
        amount: 5_000,
        atMinutes: index,
      });
    }
    const sink = new DiagnosticCollector();
    const fold = applySurfaceDepositProposals({ surface, proposals: [deposit()], atMinutes: 100, sink });
    expect(fold.surface).toBe(surface);
    expect(fold.trace[0]).toMatchObject({ outcome: "rejected", code: CHAT_SURFACE_DEPOSIT_CAPACITY });
    expectDiagnostic(sink, CHAT_SURFACE_DEPOSIT_CAPACITY, { times: 1 });
    // Restating standing material IS the designed no-op, and it must stay
    // distinguishable from the refusal above.
    const standing = commitBodySurfaceDeposit(emptyBodySurfaceState(), {
      locationId: "hands",
      kind: "mud",
      amount: SURFACE_DEPOSIT_DEGREE_DELTA[3],
      atMinutes: 30,
    });
    const restated = applySurfaceDepositProposals({ surface: standing, proposals: [deposit()], atMinutes: 30 });
    expect(restated.surface).toBe(standing);
    expect(restated.trace[0]?.outcome).toBe("no_change");
    expect(bodySurfaceDepositIdFor("hands", "mud", 30) in (restated.surface.deposits ?? {})).toBe(true);
  });

  it("an empty list is a no-op by reference — nothing leaves a surface on the clock", () => {
    const surface = commitBodySurfaceDeposit(emptyBodySurfaceState(), {
      locationId: "hands",
      kind: "mud",
      amount: 5_000,
      atMinutes: 0,
    });
    const fold = applySurfaceDepositProposals({ surface, proposals: [], atMinutes: 10_000 });
    expect(fold.surface).toBe(surface);
    expect(fold.trace).toEqual([]);
  });
});
