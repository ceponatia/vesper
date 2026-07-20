import { describe, expect, it } from "vitest";
import { bodyInitializedEventSchema } from "@/contracts/simulation/bodies";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import type { PrincipalKind } from "@/contracts/simulation/envelopes";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  adjustMaterialLotCommandSchema,
  compareMeansBands,
  createHouseholdCommandSchema,
  householdMembershipSchema,
  lotLocusSchema,
  materialKindRegistryVersion,
  materialLotStateSchema,
  meansBandKeys,
  meansBandRegistryVersion,
  meansBandStateSchema,
  meansSubjectSchema,
  setHouseholdMembershipCommandSchema,
  setMeansBandCommandSchema,
  simulationHouseholdSchema,
  transferLotQuantityCommandSchema,
  type AdjustMaterialLotCommandInput,
  type CreateHouseholdCommandInput,
  type HouseholdMembership,
  type LotLocus,
  type MaterialLotState,
  type MeansBandState,
  type MeansSubject,
  type SetHouseholdMembershipCommandInput,
  type SetMeansBandCommandInput,
  type SimulationHousehold,
  type TransferLotQuantityCommandInput,
} from "@/contracts/simulation/households";
import { simulationHash, sortedUnique } from "./hash";
import {
  applyHouseholdEvent,
  applyLotDelta,
  applyLotTransfer,
  assertConservedDeltasBalance,
  buildMaterialLotInitializedEvent,
  deriveMeansRead,
  emptyHouseholdsSeed,
  householdStockAccessAllowed,
  initializeLot,
  lotLocusReachableFrom,
  replayHouseholdsHistory,
  resolveAdjustMaterialLotFromView,
  resolveCreateHouseholdFromView,
  resolveQuantityKind,
  resolveSetHouseholdMembershipFromView,
  resolveSetMeansBandFromView,
  resolveTransferLotQuantityFromView,
  type HouseholdsResolutionView,
} from "./households";

/**
 * E5.4 slice 1 — households, fungible lots, conservation, and means bands
 * (engine.spec §26.8–26.10). Mirrors materials.test.ts's shape: pure view
 * builders + command builders, no IO.
 */

const WORLD = "world-e5-4";
const BRANCH = "branch-e5-4";
const RULESET = "e5-4-test-v1";
const ZONE_A = "zone-a";
const ZONE_B = "zone-b";
const HOUSEHOLD = "household-vance";

function principal(kind: PrincipalKind, controlled: string[] = []) {
  return { kind, principalId: "principal-1", controlledActorIds: sortedUnique(controlled) };
}

function lotOf(locus: LotLocus, materialKindKey: string, quantityRaw = 0): MaterialLotState {
  return materialLotStateSchema.parse({
    locus,
    materialKindKey,
    quantityKind: resolveQuantityKind(materialKindKey),
    quantityRaw,
    registryVersion: materialKindRegistryVersion,
  });
}

// Locus/subject constructors go through their schemas (like materials.test.ts's
// `heldBy`/`atZone`) so a plain-string id is properly branded — a raw object
// literal type-annotated as `LotLocus`/`MeansSubject` would require the caller
// to already hold branded ids, which these tests deliberately don't carry.
const zoneLotLocus = (zoneId: string): LotLocus => lotLocusSchema.parse({ kind: "zone", zoneId });
const actorLotLocus = (actorId: string): LotLocus => lotLocusSchema.parse({ kind: "actor", actorId });
const householdLotLocus = (householdId: string): LotLocus => lotLocusSchema.parse({ kind: "household", householdId });
const actorSubject = (actorId: string): MeansSubject => meansSubjectSchema.parse({ kind: "actor", actorId });
const householdSubject = (householdId: string): MeansSubject =>
  meansSubjectSchema.parse({ kind: "household", householdId });

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

function createHouseholdCmd(
  payload: CreateHouseholdCommandInput["payload"],
  overrides: Partial<Omit<CreateHouseholdCommandInput, "payload">> = {},
) {
  return createHouseholdCommandSchema.parse({
    id: "cmd-create-household",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-create-household",
    principal: principal("storyteller"),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "create_household",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function setHouseholdMembershipCmd(
  payload: SetHouseholdMembershipCommandInput["payload"],
  overrides: Partial<Omit<SetHouseholdMembershipCommandInput, "payload">> = {},
) {
  return setHouseholdMembershipCommandSchema.parse({
    id: "cmd-membership",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-membership",
    principal: principal("storyteller"),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "set_household_membership",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function adjustMaterialLotCmd(
  payload: AdjustMaterialLotCommandInput["payload"],
  overrides: Partial<Omit<AdjustMaterialLotCommandInput, "payload">> = {},
) {
  return adjustMaterialLotCommandSchema.parse({
    id: "cmd-adjust",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-adjust",
    principal: principal("storyteller"),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "adjust_material_lot",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function transferLotQuantityCmd(
  payload: TransferLotQuantityCommandInput["payload"],
  overrides: Partial<Omit<TransferLotQuantityCommandInput, "payload">> = {},
) {
  return transferLotQuantityCommandSchema.parse({
    id: "cmd-transfer-lot",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-transfer-lot",
    principal: principal("player", [payload.actorId]),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "transfer_lot_quantity",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

function setMeansBandCmd(
  payload: SetMeansBandCommandInput["payload"],
  overrides: Partial<Omit<SetMeansBandCommandInput, "payload">> = {},
) {
  return setMeansBandCommandSchema.parse({
    id: "cmd-band",
    branchId: BRANCH,
    expectedVersion: 0,
    idempotencyKey: "idem-band",
    principal: principal("storyteller"),
    submittedAtWallClock: "2026-07-19T10:00:00.000Z",
    type: "set_means_band",
    schemaVersion: 1,
    correlationId: "corr-1",
    payload,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// View builders
// ---------------------------------------------------------------------------

function createHouseholdView(
  overrides: Partial<{ householdExists: boolean; zoneIds: string[]; headSequence: number; storySecond: number }> = {},
) {
  const zoneIds = new Set(overrides.zoneIds ?? [ZONE_A, ZONE_B]);
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    headSequence: overrides.headSequence ?? 0,
    storySecond: overrides.storySecond ?? 10_000,
    householdExists: overrides.householdExists ?? false,
    zoneExists: (zoneId: string) => zoneIds.has(zoneId),
  };
}

function membershipView(
  overrides: Partial<{
    householdExists: boolean;
    actorExists: boolean;
    currentMembership: HouseholdMembership;
    headSequence: number;
    storySecond: number;
  }> = {},
) {
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    headSequence: overrides.headSequence ?? 0,
    storySecond: overrides.storySecond ?? 10_000,
    householdExists: overrides.householdExists ?? true,
    actorExists: overrides.actorExists ?? true,
    currentMembership: overrides.currentMembership,
  };
}

function adjustView(
  overrides: Partial<{ localeExists: boolean; lot: MaterialLotState; headSequence: number; storySecond: number }> = {},
) {
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    headSequence: overrides.headSequence ?? 0,
    storySecond: overrides.storySecond ?? 10_000,
    localeExists: overrides.localeExists ?? true,
    lot: overrides.lot ?? lotOf(householdLotLocus(HOUSEHOLD), "food", 10),
  };
}

interface HouseholdsFixture {
  households: SimulationHousehold[];
  memberships: HouseholdMembership[];
  actorZones: Record<string, string>;
}

function resolutionView(fixture: HouseholdsFixture): HouseholdsResolutionView {
  const householdsById = new Map<string, SimulationHousehold>(
    fixture.households.map((household) => [household.id, household]),
  );
  const membershipsByKey = new Map<string, HouseholdMembership>(
    fixture.memberships.map((membership) => [`${membership.householdId}:${membership.actorId}`, membership]),
  );
  return {
    householdById: (householdId) => householdsById.get(householdId),
    activeMembership: (householdId, actorId) => membershipsByKey.get(`${householdId}:${actorId}`),
    actorZoneId: (actorId) => fixture.actorZones[actorId] ?? null,
  };
}

function transferView(input: {
  fixture: HouseholdsFixture;
  actors?: Record<string, { id: string; name: string }>;
  fromLot: MaterialLotState;
  toLot: MaterialLotState;
  headSequence?: number;
  storySecond?: number;
}) {
  const actors = input.actors ?? {};
  return {
    ...resolutionView(input.fixture),
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    headSequence: input.headSequence ?? 0,
    storySecond: input.storySecond ?? 10_000,
    actorById: (actorId: string) => actors[actorId],
    fromLot: input.fromLot,
    toLot: input.toLot,
  };
}

function meansBandView(
  overrides: Partial<{ subjectExists: boolean; currentBand: MeansBandState; headSequence: number; storySecond: number }> = {},
) {
  return {
    worldId: WORLD,
    branchId: BRANCH,
    rulesetVersion: RULESET,
    headSequence: overrides.headSequence ?? 0,
    storySecond: overrides.storySecond ?? 10_000,
    subjectExists: overrides.subjectExists ?? true,
    currentBand: overrides.currentBand,
  };
}

// ---------------------------------------------------------------------------
// Lot arithmetic
// ---------------------------------------------------------------------------

describe("E5.4 slice 1 lot arithmetic", () => {
  it("applies a positive delta, accepts an exact drain to zero, and rejects going below zero", () => {
    const lot = lotOf(zoneLotLocus(ZONE_A), "food", 5);
    expect(applyLotDelta(lot, 3)).toEqual({ ok: true, resultingQuantityRaw: 8 });
    expect(applyLotDelta(lot, -5)).toEqual({ ok: true, resultingQuantityRaw: 0 });
    expect(applyLotDelta(lot, -6)).toEqual({ ok: false, code: "insufficient_balance" });
  });

  it("transfers between two lots, rejects an over-drain, and accepts an exact drain", () => {
    const from = lotOf(zoneLotLocus(ZONE_A), "food", 5);
    const to = lotOf(actorLotLocus("mara"), "food", 2);
    expect(applyLotTransfer(from, to, 6)).toEqual({ ok: false, code: "insufficient_balance" });
    const exact = applyLotTransfer(from, to, 5);
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.from.quantityRaw).toBe(0);
      expect(exact.to.quantityRaw).toBe(7);
    }
  });

  it("initializeLot always starts at zero at the current registry version", () => {
    const lot = initializeLot(zoneLotLocus(ZONE_A), RESERVED_CURRENCY_MATERIAL_KIND);
    expect(lot.quantityRaw).toBe(0);
    expect(lot.quantityKind).toBe("fixed_point");
    expect(lot.registryVersion).toBe(materialKindRegistryVersion);
  });
});

describe("E5.4 slice 1 material-kind registry (§26.9)", () => {
  it("resolves the reserved currency kind to fixed_point and every unregistered kind to count", () => {
    expect(resolveQuantityKind(RESERVED_CURRENCY_MATERIAL_KIND)).toBe("fixed_point");
    expect(resolveQuantityKind("food")).toBe("count");
    expect(resolveQuantityKind("anything-unregistered")).toBe("count");
  });
});

describe("E5.4 slice 1 conservation (§26.9)", () => {
  it("conserves total same-kind quantity across many interleaved transfers between three lots", () => {
    let lots = [
      lotOf(zoneLotLocus(ZONE_A), "food", 100),
      lotOf(actorLotLocus("mara"), "food", 0),
      lotOf(householdLotLocus(HOUSEHOLD), "food", 0),
    ];
    const deltas: { materialKindKey: string; deltaRaw: number }[] = [];
    let seed = 42;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed;
    };
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const fromIndex = next() % 3;
      const toIndex = (fromIndex + 1 + (next() % 2)) % 3;
      const amount = next() % 11;
      if (amount === 0) continue;
      const from = lots[fromIndex];
      const to = lots[toIndex];
      if (!from || !to) continue;
      const result = applyLotTransfer(from, to, amount);
      if (!result.ok) continue;
      lots = lots.map((lot, index) => (index === fromIndex ? result.from : index === toIndex ? result.to : lot));
      deltas.push({ materialKindKey: "food", deltaRaw: -amount }, { materialKindKey: "food", deltaRaw: amount });
    }
    const total = lots.reduce((sum, lot) => sum + lot.quantityRaw, 0);
    expect(total).toBe(100);
    expect(() => assertConservedDeltasBalance(deltas)).not.toThrow();
  });

  it("throws when a kind's deltas do not sum to zero", () => {
    expect(() => assertConservedDeltasBalance([{ materialKindKey: "food", deltaRaw: 5 }])).toThrow(
      /Conservation violated/u,
    );
  });
});

// ---------------------------------------------------------------------------
// §26.8 stock access + reachability
// ---------------------------------------------------------------------------

describe("E5.4 slice 1 household stock access (§26.8)", () => {
  function household(policy: { kind: "members_only" } | { kind: "allow_list"; actorIds: string[] }): SimulationHousehold {
    return simulationHouseholdSchema.parse({
      id: HOUSEHOLD,
      name: "The Vance House",
      residenceZoneIds: [ZONE_A],
      stockAccessPolicy: policy,
    });
  }

  function membership(actorId: string, status: "active" | "ended" = "active"): HouseholdMembership {
    return householdMembershipSchema.parse({
      householdId: HOUSEHOLD,
      actorId,
      role: "resident",
      status,
      ...(status === "ended" ? { endedAtStorySecond: 9_000 } : {}),
    });
  }

  it("members_only admits an active member and rejects an ended member or a non-member", () => {
    const view = resolutionView({
      households: [household({ kind: "members_only" })],
      memberships: [membership("mara")],
      actorZones: {},
    });
    expect(householdStockAccessAllowed(view, HOUSEHOLD, "mara")).toBe(true);
    expect(householdStockAccessAllowed(view, HOUSEHOLD, "iris")).toBe(false);

    const endedView = resolutionView({
      households: [household({ kind: "members_only" })],
      memberships: [membership("mara", "ended")],
      actorZones: {},
    });
    expect(householdStockAccessAllowed(endedView, HOUSEHOLD, "mara")).toBe(false);
  });

  it("allow_list admits only named actors regardless of membership", () => {
    const view = resolutionView({
      households: [household({ kind: "allow_list", actorIds: ["iris"] })],
      memberships: [membership("mara")],
      actorZones: {},
    });
    expect(householdStockAccessAllowed(view, HOUSEHOLD, "iris")).toBe(true);
    expect(householdStockAccessAllowed(view, HOUSEHOLD, "mara")).toBe(false);
  });

  it("rejects an unknown household outright", () => {
    const view = resolutionView({ households: [], memberships: [], actorZones: {} });
    expect(householdStockAccessAllowed(view, HOUSEHOLD, "mara")).toBe(false);
  });
});

describe("E5.4 slice 1 lot locus reachability (§26.8/§26.9)", () => {
  it("a zone locus requires an exact zone match", () => {
    const view = resolutionView({ households: [], memberships: [], actorZones: {} });
    expect(lotLocusReachableFrom(view, zoneLotLocus(ZONE_A), ZONE_A)).toBe(true);
    expect(lotLocusReachableFrom(view, zoneLotLocus(ZONE_A), ZONE_B)).toBe(false);
  });

  it("a household locus admits any of its residence zones and rejects an unknown household", () => {
    const household = simulationHouseholdSchema.parse({
      id: HOUSEHOLD,
      name: "House",
      residenceZoneIds: [ZONE_A, ZONE_B],
      stockAccessPolicy: { kind: "members_only" },
    });
    const view = resolutionView({ households: [household], memberships: [], actorZones: {} });
    expect(lotLocusReachableFrom(view, householdLotLocus(HOUSEHOLD), ZONE_A)).toBe(true);
    expect(lotLocusReachableFrom(view, householdLotLocus(HOUSEHOLD), ZONE_B)).toBe(true);
    expect(lotLocusReachableFrom(view, householdLotLocus(HOUSEHOLD), "zone-c")).toBe(false);
    expect(lotLocusReachableFrom(view, householdLotLocus("ghost"), ZONE_A)).toBe(false);
  });

  it("an actor locus is always reachable (the OTHER-actor giving case is checked elsewhere)", () => {
    const view = resolutionView({ households: [], memberships: [], actorZones: {} });
    expect(lotLocusReachableFrom(view, actorLotLocus("mara"), ZONE_A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §26.10 means read + band ordering
// ---------------------------------------------------------------------------

describe("E5.4 slice 1 means read (§26.10)", () => {
  it("prefers a lot-tracked read over a band when both exist for the same subject", () => {
    const subject = actorSubject("mara");
    const lot = lotOf(actorLotLocus("mara"), RESERVED_CURRENCY_MATERIAL_KIND, 4_200);
    const band = meansBandStateSchema.parse({
      subject,
      bandKey: "modest",
      registryVersion: meansBandRegistryVersion,
      setAtStorySecond: 10_000,
    });
    const view = { currencyLot: () => lot, band: () => band };
    expect(deriveMeansRead(subject, view)).toEqual({
      kind: "lot_tracked",
      quantityRaw: 4_200,
      quantityKind: "fixed_point",
    });
  });

  it("falls back to the band when no lot exists", () => {
    const subject = householdSubject(HOUSEHOLD);
    const band = meansBandStateSchema.parse({
      subject,
      bandKey: "struggling",
      registryVersion: meansBandRegistryVersion,
      setAtStorySecond: 10_000,
    });
    const view = { currencyLot: () => undefined, band: () => band };
    expect(deriveMeansRead(subject, view)).toEqual({ kind: "band_tracked", bandKey: "struggling" });
  });

  it("is unknown when neither a lot nor a band exists", () => {
    const subject = actorSubject("iris");
    const view = { currencyLot: () => undefined, band: () => undefined };
    expect(deriveMeansRead(subject, view)).toEqual({ kind: "unknown" });
  });
});

describe("E5.4 slice 1 means band ordering", () => {
  it("orders bands least to most means, matching meansBandKeys array order", () => {
    expect(compareMeansBands("destitute", "opulent")).toBeLessThan(0);
    expect(compareMeansBands("opulent", "destitute")).toBeGreaterThan(0);
    expect(compareMeansBands("modest", "modest")).toBe(0);
    const sorted = [...meansBandKeys].sort(compareMeansBands);
    expect(sorted).toEqual([...meansBandKeys]);
  });
});

// ---------------------------------------------------------------------------
// Command resolvers
// ---------------------------------------------------------------------------

describe("E5.4 slice 1 resolveCreateHouseholdFromView", () => {
  it("accepts a well-formed household and stamps the event", () => {
    const command = createHouseholdCmd({
      householdId: HOUSEHOLD,
      name: "The Vance House",
      residenceZoneIds: [ZONE_A],
      stockAccessPolicy: { kind: "members_only" },
    });
    const result = resolveCreateHouseholdFromView(createHouseholdView(), command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe("household_created");
      expect(result.event.payload.householdId).toBe(HOUSEHOLD);
      expect(result.event.sequence).toBe(1);
    }
  });

  it("rejects an already-existing household, an unresolved residence zone, and a non-privileged principal", () => {
    const command = createHouseholdCmd({
      householdId: HOUSEHOLD,
      name: "x",
      residenceZoneIds: [ZONE_A],
      stockAccessPolicy: { kind: "members_only" },
    });
    const existing = resolveCreateHouseholdFromView(createHouseholdView({ householdExists: true }), command);
    expect(existing).toMatchObject({ ok: false, code: "household_already_exists" });

    const ghostZone = resolveCreateHouseholdFromView(createHouseholdView({ zoneIds: [] }), command);
    expect(ghostZone).toMatchObject({ ok: false, code: "zone_not_found" });

    const unauthorized = resolveCreateHouseholdFromView(
      createHouseholdView(),
      createHouseholdCmd(command.payload, { principal: principal("player", []) }),
    );
    expect(unauthorized).toMatchObject({ ok: false, code: "unauthorized_principal" });
  });
});

describe("E5.4 slice 1 resolveSetHouseholdMembershipFromView", () => {
  it("accepts a first-time membership grant", () => {
    const command = setHouseholdMembershipCmd({
      householdId: HOUSEHOLD,
      actorId: "mara",
      role: "resident",
      status: "active",
    });
    const result = resolveSetHouseholdMembershipFromView(membershipView(), command);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.payload.status).toBe("active");
  });

  it("rejects an unknown household, an unknown actor, and a redundant re-set", () => {
    const payload = { householdId: HOUSEHOLD, actorId: "mara", role: "resident" as const, status: "active" as const };
    const noHousehold = resolveSetHouseholdMembershipFromView(
      membershipView({ householdExists: false }),
      setHouseholdMembershipCmd(payload),
    );
    expect(noHousehold).toMatchObject({ ok: false, code: "household_not_found" });

    const noActor = resolveSetHouseholdMembershipFromView(
      membershipView({ actorExists: false }),
      setHouseholdMembershipCmd(payload),
    );
    expect(noActor).toMatchObject({ ok: false, code: "actor_not_found" });

    const current = householdMembershipSchema.parse(payload);
    const noOp = resolveSetHouseholdMembershipFromView(
      membershipView({ currentMembership: current }),
      setHouseholdMembershipCmd(payload, { id: "cmd-m-2", idempotencyKey: "idem-m-2" }),
    );
    expect(noOp).toMatchObject({ ok: false, code: "no_op" });
  });

  it("accepts ending a membership with a matching endedAtStorySecond", () => {
    const current = householdMembershipSchema.parse({
      householdId: HOUSEHOLD,
      actorId: "mara",
      role: "resident",
      status: "active",
    });
    const command = setHouseholdMembershipCmd(
      { householdId: HOUSEHOLD, actorId: "mara", role: "resident", status: "ended", endedAtStorySecond: 12_000 },
      { id: "cmd-m-end", idempotencyKey: "idem-m-end" },
    );
    const result = resolveSetHouseholdMembershipFromView(membershipView({ currentMembership: current }), command);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.payload.endedAtStorySecond).toBe(12_000);
  });

  it("rejects an inconsistent ended/basis pair at the schema layer", () => {
    expect(() =>
      setHouseholdMembershipCommandSchema.parse({
        id: "cmd-bad",
        branchId: BRANCH,
        expectedVersion: 0,
        idempotencyKey: "idem-bad",
        principal: principal("storyteller"),
        submittedAtWallClock: "2026-07-19T10:00:00.000Z",
        type: "set_household_membership",
        schemaVersion: 1,
        correlationId: "corr-1",
        payload: { householdId: HOUSEHOLD, actorId: "mara", role: "resident", status: "ended" },
      }),
    ).toThrow();
  });
});

describe("E5.4 slice 1 resolveAdjustMaterialLotFromView", () => {
  const locus = zoneLotLocus(ZONE_A);

  it("accepts a positive authoring adjustment and stamps the resulting quantity", () => {
    const command = adjustMaterialLotCmd({ locus, materialKindKey: "food", deltaRaw: 15 });
    const result = resolveAdjustMaterialLotFromView(adjustView({ lot: lotOf(locus, "food", 5) }), command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.payload.resultingQuantityRaw).toBe(20);
      expect(result.event.payload.reason).toBe("authoring");
      expect(result.nextLot.quantityRaw).toBe(20);
    }
  });

  it("rejects a zero delta, an unresolved locus, a non-privileged principal, and an over-drain", () => {
    const zero = resolveAdjustMaterialLotFromView(
      adjustView({ lot: lotOf(locus, "food", 5) }),
      adjustMaterialLotCmd({ locus, materialKindKey: "food", deltaRaw: 0 }),
    );
    expect(zero).toMatchObject({ ok: false, code: "non_zero_delta_required" });

    const ghost = resolveAdjustMaterialLotFromView(
      adjustView({ localeExists: false }),
      adjustMaterialLotCmd({ locus, materialKindKey: "food", deltaRaw: 5 }),
    );
    expect(ghost).toMatchObject({ ok: false, code: "locus_not_found" });

    const unauthorized = resolveAdjustMaterialLotFromView(
      adjustView({ lot: lotOf(locus, "food", 5) }),
      adjustMaterialLotCmd({ locus, materialKindKey: "food", deltaRaw: 5 }, { principal: principal("player", []) }),
    );
    expect(unauthorized).toMatchObject({ ok: false, code: "unauthorized_principal" });

    const drained = resolveAdjustMaterialLotFromView(
      adjustView({ lot: lotOf(locus, "food", 5) }),
      adjustMaterialLotCmd({ locus, materialKindKey: "food", deltaRaw: -6 }),
    );
    expect(drained).toMatchObject({ ok: false, code: "insufficient_balance" });
  });
});

describe("E5.4 slice 1 resolveTransferLotQuantityFromView", () => {
  it("accepts a household-to-actor transfer by an active member at the residence zone", () => {
    const household = simulationHouseholdSchema.parse({
      id: HOUSEHOLD,
      name: "House",
      residenceZoneIds: [ZONE_A],
      stockAccessPolicy: { kind: "members_only" },
    });
    const membership = householdMembershipSchema.parse({
      householdId: HOUSEHOLD,
      actorId: "mara",
      role: "resident",
      status: "active",
    });
    const fromLocus = householdLotLocus(HOUSEHOLD);
    const toLocus = actorLotLocus("mara");
    const view = transferView({
      fixture: { households: [household], memberships: [membership], actorZones: { mara: ZONE_A } },
      actors: { mara: { id: "mara", name: "Mara" } },
      fromLot: lotOf(fromLocus, "food", 10),
      toLot: lotOf(toLocus, "food", 0),
    });
    const command = transferLotQuantityCmd({
      actorId: "mara",
      fromLocus,
      toLocus,
      materialKindKey: "food",
      quantityRaw: 4,
    });
    const result = resolveTransferLotQuantityFromView(view, command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextFromLot.quantityRaw).toBe(6);
      expect(result.nextToLot.quantityRaw).toBe(4);
      expect(result.event.payload.resultingFromQuantityRaw).toBe(6);
      expect(result.event.payload.resultingToQuantityRaw).toBe(4);
    }
  });

  it("rejects an unembodied actor", () => {
    const fromLocus = zoneLotLocus(ZONE_A);
    const toLocus = actorLotLocus("mara");
    const view = transferView({
      fixture: { households: [], memberships: [], actorZones: {} },
      actors: { mara: { id: "mara", name: "Mara" } },
      fromLot: lotOf(fromLocus, "food", 10),
      toLot: lotOf(toLocus, "food", 0),
    });
    const command = transferLotQuantityCmd({ actorId: "mara", fromLocus, toLocus, materialKindKey: "food", quantityRaw: 2 });
    const result = resolveTransferLotQuantityFromView(view, command);
    expect(result).toMatchObject({ ok: false, code: "actor_not_embodied" });
  });

  it("rejects a same-locus transfer as a no-op", () => {
    const locus = actorLotLocus("mara");
    const view = transferView({
      fixture: { households: [], memberships: [], actorZones: { mara: ZONE_A } },
      actors: { mara: { id: "mara", name: "Mara" } },
      fromLot: lotOf(locus, "food", 10),
      toLot: lotOf(locus, "food", 10),
    });
    const command = transferLotQuantityCmd({
      actorId: "mara",
      fromLocus: locus,
      toLocus: locus,
      materialKindKey: "food",
      quantityRaw: 2,
    });
    const result = resolveTransferLotQuantityFromView(view, command);
    expect(result).toMatchObject({ ok: false, code: "same_locus" });
  });

  it("rejects a household transfer by a non-member under members_only", () => {
    const household = simulationHouseholdSchema.parse({
      id: HOUSEHOLD,
      name: "House",
      residenceZoneIds: [ZONE_A],
      stockAccessPolicy: { kind: "members_only" },
    });
    const fromLocus = householdLotLocus(HOUSEHOLD);
    const toLocus = actorLotLocus("iris");
    const view = transferView({
      fixture: { households: [household], memberships: [], actorZones: { iris: ZONE_A } },
      actors: { iris: { id: "iris", name: "Iris" } },
      fromLot: lotOf(fromLocus, "food", 10),
      toLot: lotOf(toLocus, "food", 0),
    });
    const command = transferLotQuantityCmd(
      { actorId: "iris", fromLocus, toLocus, materialKindKey: "food", quantityRaw: 2 },
      { principal: principal("player", ["iris"]) },
    );
    const result = resolveTransferLotQuantityFromView(view, command);
    expect(result).toMatchObject({ ok: false, code: "household_access_denied" });
  });

  it("rejects a transfer exceeding the source balance", () => {
    const fromLocus = zoneLotLocus(ZONE_A);
    const toLocus = actorLotLocus("mara");
    const view = transferView({
      fixture: { households: [], memberships: [], actorZones: { mara: ZONE_A } },
      actors: { mara: { id: "mara", name: "Mara" } },
      fromLot: lotOf(fromLocus, "food", 3),
      toLot: lotOf(toLocus, "food", 0),
    });
    const command = transferLotQuantityCmd({ actorId: "mara", fromLocus, toLocus, materialKindKey: "food", quantityRaw: 4 });
    const result = resolveTransferLotQuantityFromView(view, command);
    expect(result).toMatchObject({ ok: false, code: "insufficient_balance" });
  });
});

describe("E5.4 slice 1 resolveSetMeansBandFromView", () => {
  it("accepts a first-time band set for an existing subject", () => {
    const subject = householdSubject(HOUSEHOLD);
    const command = setMeansBandCmd({ subject, bandKey: "modest" });
    const result = resolveSetMeansBandFromView(meansBandView({ subjectExists: true }), command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.payload.bandKey).toBe("modest");
      expect(result.event.payload.registryVersion).toBe(meansBandRegistryVersion);
    }
  });

  it("rejects an unknown subject and a redundant re-set", () => {
    const subject = actorSubject("mara");
    const missing = resolveSetMeansBandFromView(
      meansBandView({ subjectExists: false }),
      setMeansBandCmd({ subject, bandKey: "modest" }),
    );
    expect(missing).toMatchObject({ ok: false, code: "subject_not_found" });

    const currentBand = meansBandStateSchema.parse({
      subject,
      bandKey: "modest",
      registryVersion: meansBandRegistryVersion,
      setAtStorySecond: 9_000,
    });
    const noOp = resolveSetMeansBandFromView(
      meansBandView({ subjectExists: true, currentBand }),
      setMeansBandCmd({ subject, bandKey: "modest" }, { id: "cmd-band-2", idempotencyKey: "idem-band-2" }),
    );
    expect(noOp).toMatchObject({ ok: false, code: "no_op" });
  });
});

// ---------------------------------------------------------------------------
// Projector, replay, and seed
// ---------------------------------------------------------------------------

describe("E5.4 slice 1 projector, replay, and seed", () => {
  function lifecycleEvents(): SimulationBranchEvent[] {
    const seed = emptyHouseholdsSeed(BRANCH, 10_000);

    const create = resolveCreateHouseholdFromView(
      {
        worldId: WORLD,
        branchId: BRANCH,
        rulesetVersion: RULESET,
        headSequence: seed.headSequence,
        storySecond: seed.storySecond,
        householdExists: false,
        zoneExists: (zoneId) => zoneId === ZONE_A,
      },
      createHouseholdCmd({
        householdId: HOUSEHOLD,
        name: "The Vance House",
        residenceZoneIds: [ZONE_A],
        stockAccessPolicy: { kind: "members_only" },
      }),
    );
    if (!create.ok) throw new Error("expected create acceptance");
    const afterCreate = applyHouseholdEvent(seed, create.event);

    const membership = resolveSetHouseholdMembershipFromView(
      {
        worldId: WORLD,
        branchId: BRANCH,
        rulesetVersion: RULESET,
        headSequence: afterCreate.headSequence,
        storySecond: afterCreate.storySecond,
        householdExists: true,
        actorExists: true,
        currentMembership: undefined,
      },
      setHouseholdMembershipCmd({ householdId: HOUSEHOLD, actorId: "mara", role: "resident", status: "active" }),
    );
    if (!membership.ok) throw new Error("expected membership acceptance");
    const afterMembership = applyHouseholdEvent(afterCreate, membership.event);

    const lotLocus = householdLotLocus(HOUSEHOLD);
    const initEvent = buildMaterialLotInitializedEvent({
      view: {
        worldId: WORLD,
        branchId: BRANCH,
        rulesetVersion: RULESET,
        headSequence: afterMembership.headSequence,
        storySecond: afterMembership.storySecond,
      },
      command: { id: "cmd-adjust", correlationId: "corr-1", submittedAtWallClock: "2026-07-19T10:00:00.000Z" },
      locus: lotLocus,
      materialKindKey: "food",
      quantityKind: "count",
      sequence: afterMembership.headSequence + 1,
    });
    const afterInit = applyHouseholdEvent(afterMembership, initEvent);

    const adjust = resolveAdjustMaterialLotFromView(
      {
        worldId: WORLD,
        branchId: BRANCH,
        rulesetVersion: RULESET,
        headSequence: afterInit.headSequence,
        storySecond: afterInit.storySecond,
        localeExists: true,
        lot: lotOf(lotLocus, "food", 0),
      },
      adjustMaterialLotCmd({ locus: lotLocus, materialKindKey: "food", deltaRaw: 20 }),
    );
    if (!adjust.ok) throw new Error("expected adjust acceptance");

    return [create.event, membership.event, initEvent, adjust.event];
  }

  it("folds a household lifecycle live and via replay to the same projection (store parity)", () => {
    const seed = emptyHouseholdsSeed(BRANCH, 10_000);
    const events = lifecycleEvents();
    let live = seed;
    for (const event of events) live = applyHouseholdEvent(live, event);

    expect(live.households).toHaveLength(1);
    expect(live.memberships).toHaveLength(1);
    expect(live.lots.find((lot) => lot.materialKindKey === "food")?.quantityRaw).toBe(20);

    const replayed = replayHouseholdsHistory({ seed, events });
    expect(replayed.headSequence).toBe(4);
    // Three distinct command ids: cmd-create-household, cmd-membership, cmd-adjust
    // (the lazy init event shares cmd-adjust's commandId with the adjustment event).
    expect(replayed.version).toBe(3);

    const normalizedLive = { ...live, version: seed.version + 3 };
    expect(simulationHash(replayed)).toBe(simulationHash(normalizedLive));
  });

  it("rejects a non-contiguous event", () => {
    const seed = emptyHouseholdsSeed(BRANCH, 10_000);
    const events = lifecycleEvents();
    const gapped = events.map((event) => (event.sequence === 2 ? { ...event, sequence: 5 } : event));
    expect(() => replayHouseholdsHistory({ seed, events: gapped })).toThrow(/sequence gap/u);
  });

  it("passes a non-household event through as a bare boundary advance", () => {
    const seed = emptyHouseholdsSeed(BRANCH, 10_000);
    const bodyEvent = bodyInitializedEventSchema.parse({
      id: "event-body",
      worldId: WORLD,
      branchId: BRANCH,
      sequence: seed.headSequence + 1,
      storySecond: 10_500,
      type: "body_initialized",
      schemaVersion: 1,
      rulesetVersion: RULESET,
      correlationId: "corr-1",
      actorIds: ["mara"],
      entityIds: ["mara"],
      recordedAtWallClock: "2026-07-19T10:00:00.000Z",
      payload: {
        actorId: "mara",
        registryVersion: "body-v1",
        meters: [{ meterKey: "energy", valueFixedPoint: 5_000, baselineFixedPoint: 5_000 }],
      },
    });
    const next = applyHouseholdEvent(seed, bodyEvent);
    expect(next.headSequence).toBe(seed.headSequence + 1);
    expect(next.storySecond).toBe(10_500);
    expect(next.households).toEqual(seed.households);
  });

  it("produces the same projection whether replayed as one batch or several smaller batches (partition invariance)", () => {
    const seed = emptyHouseholdsSeed(BRANCH, 10_000);
    const events = lifecycleEvents();
    const whole = replayHouseholdsHistory({ seed, events });

    const firstHalf = events.slice(0, 2);
    const secondHalf = events.slice(2);
    const partial = replayHouseholdsHistory({ seed, events: firstHalf });
    const stepwise = replayHouseholdsHistory({ seed: partial, events: secondHalf });

    expect(simulationHash({ ...whole, version: 0 })).toBe(simulationHash({ ...stepwise, version: 0 }));
  });
});
