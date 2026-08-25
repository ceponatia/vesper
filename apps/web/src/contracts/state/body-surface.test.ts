import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { parseOr } from "@/lib/parse";
import {
  bodySurfaceDepositAt,
  bodySurfaceDepositIdFor,
  bodySurfaceDepositsAt,
  bodySurfaceMarkAt,
  bodySurfaceStateSchema,
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  BODY_SURFACE_DRY_RATE_PER_HOUR,
  BODY_SURFACE_INVALID_ENTRY,
  BODY_SURFACE_MAX_LOCATIONS,
  BODY_SURFACE_MAX_MARKS,
  BODY_SURFACE_UNIT_ONE,
  commitBodySurfaceDeposit,
  commitBodySurfaceMark,
  emptyBodySurfaceState,
  reduceBodySurfaceDeposits,
  pruneDryBodySurface,
  pruneFadedBodySurfaceMarks,
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

/**
 * The marks module (romantic-contact-affordances.spec.effects.md §8) — the same
 * owner, laws 6 and 7: a record keyed by idempotency identity so retry commits
 * nothing new, a fade anchored at creation and never restamped, quarantine over
 * repair (which is where a stored `"scratch"` is fenced out), and a `marks` key
 * that vanishes with its last mark so an effects-flag-off row stays
 * byte-identical to a pre-marks one.
 */
describe("marks", () => {
  const marked = commitBodySurfaceMark(emptyBodySurfaceState(), {
    markId: "evt_1",
    locationId: "forearms",
    kind: "pressure",
    band: "strong",
    atMinutes: 10,
  });

  it("commits at the exact locus and fades on the story clock — identity before creation, gone in 30 minutes", () => {
    expect(bodySurfaceMarkAt(marked, "evt_1", 5)).toMatchObject({ status: "known", magnitude: BODY_SURFACE_UNIT_ONE });
    const half = bodySurfaceMarkAt(marked, "evt_1", 25); // 15 min at 20_000/hour = 5_000 faded
    expect(half).toMatchObject({ status: "known", magnitude: 5_000 });
    if (half.status === "known") expect(half.mark.locationId).toBe("forearms");
    // Fully faded and absent are the SAME answer — no mark.
    expect(bodySurfaceMarkAt(marked, "evt_1", 10 + 30)).toEqual({ status: "none" });
    expect(bodySurfaceMarkAt(marked, "never_committed", 10)).toEqual({ status: "none" });
  });

  it("retry under the same idempotency identity commits nothing new", () => {
    const retried = commitBodySurfaceMark(marked, {
      markId: "evt_1",
      locationId: "forearms",
      kind: "pressure",
      band: "subtle", // even a DIFFERENT band: the standing commit wins
      atMinutes: 20,
    });
    expect(retried).toBe(marked);
  });

  it("quarantines a corrupt slot — a smuggled scratch kind included — and heals it only on a fresh commit", () => {
    const parsed = bodySurfaceStateSchema.parse({
      wetness: {},
      marks: {
        evt_ok: { locationId: "forearms", kind: "pressure", magnitude: 5_000, createdAtMinutes: 0 },
        evt_scratch: { locationId: "forearms", kind: "scratch", magnitude: 5_000, createdAtMinutes: 0 },
      },
    });
    expect(parsed.marks?.evt_scratch).toEqual(BODY_SURFACE_INVALID_ENTRY);
    expect(bodySurfaceMarkAt(parsed, "evt_scratch", 0)).toEqual({ status: "invalid" });
    expect(bodySurfaceMarkAt(parsed, "evt_ok", 0)).toMatchObject({ status: "known", magnitude: 5_000 });
    // The marker round-trips; only an authoritative commit under the key clears it.
    const reloaded = bodySurfaceStateSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reloaded.marks?.evt_scratch).toEqual(BODY_SURFACE_INVALID_ENTRY);
    const healed = commitBodySurfaceMark(parsed, {
      markId: "evt_scratch",
      locationId: "chest",
      kind: "pressure",
      band: "clear",
      atMinutes: 5,
    });
    expect(bodySurfaceMarkAt(healed, "evt_scratch", 5)).toMatchObject({ status: "known", magnitude: 5_000 });
  });

  it("a wholly corrupt marks record degrades to absent, and a missing one parses clean", () => {
    expect(bodySurfaceStateSchema.parse({ wetness: {} }).marks).toBeUndefined();
    expect(bodySurfaceStateSchema.parse({ wetness: {}, marks: "garbage" }).marks).toBeUndefined();
  });

  it("pruning drops only the fully faded, never a quarantined slot, and removes the empty key", () => {
    const quarantined = bodySurfaceStateSchema.parse({ wetness: {}, marks: { evt_bad: 42 } });
    expect(pruneFadedBodySurfaceMarks(quarantined, 1_000)).toBe(quarantined);
    expect(pruneFadedBodySurfaceMarks(marked, 15)).toBe(marked);
    const pruned = pruneFadedBodySurfaceMarks(marked, 10 + 30);
    // The LAST mark takes the key with it: the serialized row is byte-identical
    // to one that never held a mark, which is what keeps the effects flag's
    // off-state honest.
    expect(pruned.marks).toBeUndefined();
    expect(JSON.stringify(pruned)).toBe(JSON.stringify(emptyBodySurfaceState()));
  });

  it("wetness writes leave standing marks alone — the fold that dried the hair must not erase the mark", () => {
    const wet = setBodySurfaceWetness(marked, { locationId: "hair", level: 6_000, atMinutes: 12 });
    expect(bodySurfaceMarkAt(wet, "evt_1", 12)).toMatchObject({ status: "known" });
    const pruned = pruneDryBodySurface(setBodySurfaceWetness(marked, { locationId: "hair", level: 100, atMinutes: 10 }), 10 + HOUR);
    expect(bodySurfaceMarkAt(pruned, "evt_1", 12)).toMatchObject({ status: "known" });
  });

  it("refuses a commit past capacity rather than evicting a standing mark", () => {
    let full = emptyBodySurfaceState();
    for (let i = 0; i < BODY_SURFACE_MAX_MARKS; i++) {
      full = commitBodySurfaceMark(full, { markId: `evt_${i}`, locationId: "chest", kind: "pressure", band: "strong", atMinutes: 0 });
    }
    expect(Object.keys(full.marks ?? {})).toHaveLength(BODY_SURFACE_MAX_MARKS);
    expect(commitBodySurfaceMark(full, { markId: "evt_over", locationId: "chest", kind: "pressure", band: "strong", atMinutes: 0 })).toBe(full);
  });
});


/**
 * The deposits module (romantic-contact-affordances.spec.effects.md §7; owner
 * ruling 2026-08-25). Its whole reason to exist separately from the two modules
 * above is one asymmetry, and that asymmetry is what these pin: wetness dries
 * and marks fade because a surface is returning to its resting state, while a
 * DEPOSIT is material that has to go somewhere. A surface that quietly cleaned
 * itself would be an unowned sink, which is exactly what the conserved-transfer
 * proof this module was built to unblock must be able to rely on not existing.
 */
describe("deposits", () => {
  const WEEK = 7 * 24 * HOUR;
  const muddy = commitBodySurfaceDeposit(emptyBodySurfaceState(), {
    locationId: "hands",
    kind: "mud",
    amount: BODY_SURFACE_UNIT_ONE,
    atMinutes: 10,
    cause: "pushing the car free",
  });
  const mudId = bodySurfaceDepositIdFor("hands", "mud", 10);

  it("keeps every unit of material a story week later — only FRESHNESS moves with the clock", () => {
    // Falsified against a deposits module that reused the mark fade: material
    // that expires on a timer is material nobody removed, and the transfer
    // proof cannot conserve what the clock is allowed to delete.
    const now = bodySurfaceDepositAt(muddy, mudId, 10);
    expect(now).toMatchObject({ status: "known", amount: BODY_SURFACE_UNIT_ONE, freshness: "fresh" });
    const later = bodySurfaceDepositAt(muddy, mudId, 10 + WEEK);
    expect(later).toMatchObject({ status: "known", amount: BODY_SURFACE_UNIT_ONE, freshness: "set" });
    expect(bodySurfaceDepositAt(muddy, "never_committed", 10)).toEqual({ status: "none" });
  });

  it("removes only the substance a wipe names, and drops the entry once nothing is left to see", () => {
    // Falsified against a removal that ignored `kind`: washing blood off a
    // muddy forearm would have taken the mud with it.
    const both = commitBodySurfaceDeposit(muddy, {
      locationId: "hands",
      kind: "blood",
      amount: 5_000,
      atMinutes: 12,
    });
    const wiped = reduceBodySurfaceDeposits(both, { locationId: "hands", kind: "blood", amount: BODY_SURFACE_UNIT_ONE });
    expect(bodySurfaceDepositsAt(wiped, "hands", 20).map((row) => row.read.deposit.kind)).toEqual(["mud"]);
    // Unnamed takes everything at the location — "she scrubs her hands" does
    // not itemise what came off — and an emptied record loses the key entirely,
    // so a cleaned-up row persists byte-identically to one that never held
    // anything.
    const scrubbed = reduceBodySurfaceDeposits(wiped, { locationId: "hands", amount: BODY_SURFACE_UNIT_ONE });
    expect(scrubbed.deposits).toBeUndefined();
    expect(reduceBodySurfaceDeposits(muddy, { locationId: "face", amount: 5_000 })).toBe(muddy);
  });

  it("quarantines a corrupt slot rather than dropping it — absent means CLEAN, and unknown is not", () => {
    const parsed = bodySurfaceStateSchema.parse({
      wetness: {},
      deposits: {
        dep_ok: { locationId: "hands", kind: "mud", amount: 5_000, createdAtMinutes: 0 },
        dep_bad: { locationId: "hands", kind: "ectoplasm", amount: 5_000, createdAtMinutes: 0 },
      },
    });
    expect(parsed.deposits?.dep_bad).toEqual(BODY_SURFACE_INVALID_ENTRY);
    expect(bodySurfaceDepositAt(parsed, "dep_bad", 0)).toEqual({ status: "invalid" });
    // A quarantined slot is not material, so a place-scoped read cannot spend it.
    expect(bodySurfaceDepositsAt(parsed, "hands", 0).map((row) => row.depositId)).toEqual(["dep_ok"]);
    // A wholly corrupt record degrades to ABSENT, which claims nothing.
    expect(bodySurfaceStateSchema.parse({ wetness: {}, deposits: "rubbish" }).deposits).toBeUndefined();
  });

  it("survives the marks prune — one module emptying out must not take a sibling with it", () => {
    // Falsified against the prune that rebuilt the state as `{ wetness }` when
    // its last mark went: every deposit on that body disappeared with it, on an
    // ordinary quiet exchange, with nothing on the record to say so.
    const marked = commitBodySurfaceMark(muddy, {
      markId: "evt_1",
      locationId: "hands",
      kind: "pressure",
      band: "strong",
      atMinutes: 10,
    });
    const pruned = pruneFadedBodySurfaceMarks(marked, 10 + HOUR);
    expect(pruned.marks).toBeUndefined();
    expect(bodySurfaceDepositAt(pruned, mudId, 10 + HOUR)).toMatchObject({ status: "known" });
  });
});
