import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostics } from "@/test/diagnostics";
import { affordanceEvidence, affordanceSubjectId, toUnitInterval } from "../affordances/core";
import type { SurfaceTransferProposal } from "../affordances/contact";
import { DiagnosticCollector } from "../diagnostics";
import { garmentBlueprintHash, type GarmentBlueprint } from "../items/garment-blueprint";
import { templateFor } from "../items/garment-test-fixtures";
import {
  emptyGarmentCueState,
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type ChatGarmentStore,
  type GarmentLocus,
} from "../items/garment-instance";
import { garmentInstanceById } from "../items/garment-store";
import {
  bodySurfaceDepositIdFor,
  bodySurfaceDepositSlot,
  bodySurfaceTransferCommitted,
  commitBodySurfaceDeposit,
  emptyBodySurfaceState,
  isInvalidDepositSlot,
  type BodySurfaceState,
} from "../state/body-surface";
import {
  applySurfaceTransferProposal,
  applySurfaceTransferProposals,
  SURFACE_TRANSFER_DESTINATION_REFUSED,
  SURFACE_TRANSFER_LAYER_REFUSED,
  SURFACE_TRANSFER_LAYER_UNRESOLVED,
  SURFACE_TRANSFER_SOURCE_STALE,
  type SurfaceTransferOwners,
} from "./chat-contact-transfer";

/**
 * The conserved-transfer transaction — the second effect proof.
 *
 * This is the file that owns the conservation law, and the law is one sentence: **what
 * leaves the source arrives somewhere, exactly, or nothing moves at all.** Every
 * case below is written as a whole-world statement rather than a spot check,
 * because the defects that matter here are all leaks — a unit lost to rounding,
 * a unit destroyed by a cleanup floor that belongs to washing, a debit that
 * survives a refused credit. A test that only asserted "the destination got
 * some mud" would pass against all three.
 *
 * Falsified against three implementations that look right:
 *
 * - one that credited the destination through `commitBodySurfaceDeposit`, whose
 *   raise-to-max is correct for the fiction and silently absorbs nothing when
 *   the destination is already dirtier;
 * - one that debited through `reduceBodySurfaceDeposits`, whose removal floor is
 *   washing's cleanup policy and destroys up to 1,000 units the destination
 *   never receives;
 * - one that composed the path coefficients first and applied the amount once,
 *   which floors differently from stepping the real units through each layer and
 *   loses the remainder into nowhere.
 */

const SOURCE = affordanceSubjectId("c:mara");
const TARGET = affordanceSubjectId("c:wren");
const AT = 12;

const SLEEVE: GarmentBlueprint = templateFor("top");
const WORN: GarmentLocus = { kind: "worn", actorId: "c:wren" };

/** A store holding one worn garment the path can be resolved onto. */
function layerStore(): ChatGarmentStore {
  return {
    seeded: true,
    blueprints: { [garmentBlueprintHash(SLEEVE)]: SLEEVE },
    instances: [
      {
        id: "g_top",
        blueprintHash: garmentBlueprintHash(SLEEVE),
        name: "g_top",
        locus: WORN,
        presentation: emptyGarmentPresentationState(),
        condition: pristineGarmentConditionState(),
        lastChange: { kind: "mint", atMinutes: 0 },
      },
    ],
    cues: emptyGarmentCueState(),
    coverage: {},
  };
}

const SOURCE_DEPOSIT_ID = bodySurfaceDepositIdFor("hands", "mud", 0);

function dirtyHands(amount: number): BodySurfaceState {
  return commitBodySurfaceDeposit(emptyBodySurfaceState(), {
    locationId: "hands",
    kind: "mud",
    amount,
    atMinutes: 0,
  });
}

function owners(overrides: Partial<SurfaceTransferOwners> = {}): SurfaceTransferOwners {
  return { source: dirtyHands(8_000), destination: emptyBodySurfaceState(), layers: layerStore(), ...overrides };
}

function proposal(overrides: Partial<SurfaceTransferProposal> = {}): SurfaceTransferProposal {
  return {
    kind: "surface_transfer",
    idempotencyKey: "surface_transferc1e1" + SOURCE_DEPOSIT_ID,
    sourceSubjectId: SOURCE,
    targetSubjectId: TARGET,
    material: {
      depositId: SOURCE_DEPOSIT_ID,
      kind: "mud",
      locus: { kind: "body", subjectId: SOURCE, locationId: "hands" },
      amount: 4_000,
      evidence: [affordanceEvidence("state", "body_surface.deposit")],
    },
    path: { layers: [], destination: { kind: "body", subjectId: TARGET, locationId: "forearms" }, evidence: [] },
    amount: 4_000,
    pressure: "firm",
    storyTime: AT,
    evidence: [],
    ...overrides,
  };
}

const resolveLayer = (layerId: string) =>
  layerId === "sleeve" ? { instanceId: "g_top", partIds: [] as readonly string[] } : undefined;

/** Everything of one substance standing anywhere in this world, so conservation can be stated as a total. */
function worldTotal(state: SurfaceTransferOwners): number {
  const surfaceTotal = (surface: BodySurfaceState) => {
    let total = 0;
    for (const slot of Object.values(surface.deposits ?? {})) {
      if (!isInvalidDepositSlot(slot) && slot.kind === "mud") total += slot.amount;
    }
    return total;
  };
  const instance = garmentInstanceById(state.layers, "g_top");
  const layerTotal = (instance?.condition.deposits ?? [])
    .filter((deposit) => deposit.kind === "mud")
    .reduce((sum, deposit) => sum + deposit.intensity, 0);
  return surfaceTotal(state.source) + surfaceTotal(state.destination) + layerTotal;
}

function run(input: { proposal?: SurfaceTransferProposal; owners?: SurfaceTransferOwners } = {}) {
  const sink = new DiagnosticCollector();
  const before = input.owners ?? owners();
  const settlement = applySurfaceTransferProposal({
    proposal: input.proposal ?? proposal(),
    owners: before,
    resolveLayer,
    atMinutes: AT,
    sink,
  });
  return { settlement, before, sink };
}

describe("applySurfaceTransferProposal — conservation", () => {
  it("moves exactly what left the source onto the destination, skin to skin", () => {
    const { settlement, before, sink } = run();
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expectCleanSink(sink);
    expect(settlement.ledger.debited).toBe(4_000);
    expect(settlement.ledger.credits.reduce((sum, credit) => sum + credit.amount, 0)).toBe(4_000);
    expect(worldTotal(settlement.owners)).toBe(worldTotal(before));
  });

  it("leaves a sub-floor remainder standing, because the removal floor is washing's policy and not a transfer's", () => {
    const start = owners({ source: dirtyHands(1_400) });
    const { settlement } = run({ owners: start, proposal: proposal({ amount: 1_000 }) });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    const remaining = bodySurfaceDepositSlot(settlement.owners.source, SOURCE_DEPOSIT_ID);
    expect(remaining).toMatchObject({ amount: 400 });
    expect(settlement.ledger.debited).toBe(1_000);
    expect(worldTotal(settlement.owners)).toBe(1_400);
  });

  it("adds to a destination that already carries the same substance, rather than raising to the larger", () => {
    // The raise-to-max commit would leave the destination at 6_000 and lose 4_000.
    const start = owners({
      destination: commitBodySurfaceDeposit(emptyBodySurfaceState(), {
        locationId: "forearms",
        kind: "mud",
        amount: 6_000,
        atMinutes: AT,
      }),
    });
    const { settlement } = run({ owners: start });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(worldTotal(settlement.owners)).toBe(worldTotal(start));
    expect(worldTotal(settlement.owners)).toBe(14_000);
  });

  it("sizes the equation from what actually left, not from what was asked for", () => {
    const start = owners({ source: dirtyHands(1_200) });
    const { settlement } = run({ owners: start, proposal: proposal({ amount: 4_000 }) });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(settlement.ledger.debited).toBe(1_200);
    expect(worldTotal(settlement.owners)).toBe(1_200);
  });

  it("conserves across ONE surface when a body moves material over itself", () => {
    // Wiping a muddy hand on your own thigh. The debit and the credit land on
    // the same value, and an implementation that folded them onto two copies of
    // it independently keeps only the one it wrote last — which reads as either
    // material that never left or material that never arrived.
    // The `destination` owner is deliberately left empty: with one body on both
    // ends there is only one surface, and the transaction must take it from the
    // debited value rather than from the argument.
    const self = owners();
    const across = proposal({
      targetSubjectId: SOURCE,
      path: { layers: [], destination: { kind: "body", subjectId: SOURCE, locationId: "thighs" }, evidence: [] },
    });
    const { settlement } = run({ owners: self, proposal: across });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(settlement.owners.source).toBe(settlement.owners.destination);
    const hands = bodySurfaceDepositSlot(settlement.owners.source, SOURCE_DEPOSIT_ID);
    expect(hands).toMatchObject({ amount: 4_000 });
    const thigh = bodySurfaceDepositSlot(
      settlement.owners.source,
      bodySurfaceDepositIdFor("thighs", "mud", AT),
    );
    expect(thigh).toMatchObject({ amount: 4_000 });
  });
});

describe("applySurfaceTransferProposal — the path", () => {
  const through = (throughput: number) =>
    proposal({
      path: {
        layers: [{ layerId: "sleeve", order: 0, throughput: toUnitInterval(throughput), evidence: [] }],
        destination: { kind: "body", subjectId: TARGET, locationId: "forearms" },
        evidence: [],
      },
    });

  it("gives a fully blocking layer everything, and the skin beneath it nothing", () => {
    const { settlement, before } = run({ proposal: through(0) });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    // Both halves are the same statement: material blocked
    // by a layer cannot teleport to skin BECAUSE the layer received it.
    expect(settlement.ledger.credits).toEqual([{ target: "sleeve", amount: 4_000 }]);
    expect(settlement.owners.destination.deposits).toBeUndefined();
    expect(worldTotal(settlement.owners)).toBe(worldTotal(before));
  });

  it("gives a fully open layer nothing, and the skin beneath it everything", () => {
    const { settlement } = run({ proposal: through(10_000) });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(settlement.ledger.credits).toEqual([{ target: "forearms", amount: 4_000 }]);
  });

  it("splits a partial crossing exactly, with the integer remainder staying on the layer", () => {
    // 4_000 through 3_333/10_000 passes 1_333 and retains 2_667. A composed
    // coefficient applied once would floor elsewhere and lose a unit.
    const { settlement, before } = run({ proposal: through(3_333) });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(settlement.ledger.credits).toEqual([
      { target: "sleeve", amount: 2_667 },
      { target: "forearms", amount: 1_333 },
    ]);
    expect(worldTotal(settlement.owners)).toBe(worldTotal(before));
  });

  it("steps real units through every layer in order, so two crossings conserve like one", () => {
    const twoLayers = proposal({
      path: {
        layers: [
          { layerId: "sleeve", order: 0, throughput: toUnitInterval(3_333), evidence: [] },
          { layerId: "sleeve", order: 1, throughput: toUnitInterval(3_333), evidence: [] },
        ],
        destination: { kind: "body", subjectId: TARGET, locationId: "forearms" },
        evidence: [],
      },
    });
    const { settlement, before } = run({ proposal: twoLayers });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(settlement.ledger.credits.reduce((sum, credit) => sum + credit.amount, 0)).toBe(
      settlement.ledger.debited,
    );
    expect(worldTotal(settlement.owners)).toBe(worldTotal(before));
  });

  it("refuses when a path layer addresses nothing the lane can validate, and moves nothing", () => {
    const unknown = proposal({
      path: {
        layers: [{ layerId: "not_a_layer", order: 0, throughput: toUnitInterval(5_000), evidence: [] }],
        destination: { kind: "body", subjectId: TARGET, locationId: "forearms" },
        evidence: [],
      },
    });
    const { settlement, before, sink } = run({ proposal: unknown });
    expect(settlement.status).toBe("refused");
    expectDiagnostics(sink, [SURFACE_TRANSFER_LAYER_UNRESOLVED]);
    expect(worldTotal(before)).toBe(8_000);
  });
});

describe("applySurfaceTransferProposal — all or nothing", () => {
  it("discards the whole settlement when the destination refuses its leg", () => {
    // A destination already at saturation for this identity cannot take the
    // credit, and a clamped credit would be the silent discard conservation forbids.
    const start = owners({
      destination: commitBodySurfaceDeposit(emptyBodySurfaceState(), {
        locationId: "forearms",
        kind: "mud",
        amount: 10_000,
        atMinutes: AT,
      }),
    });
    const { settlement, sink } = run({ owners: start });
    expect(settlement.status).toBe("refused");
    if (settlement.status !== "refused") return;
    expect(settlement.code).toBe(SURFACE_TRANSFER_DESTINATION_REFUSED);
    expectDiagnostics(sink, [SURFACE_TRANSFER_DESTINATION_REFUSED]);
    // A failed transaction exposes no result. The debit was computed and
    // then thrown away, and a refusal must carry no trace of it — an
    // implementation that handed back the half-folded owners "for the caller to
    // decide about" is exactly how a discarded debit reaches a database.
    expect("owners" in settlement).toBe(false);
    expect("ledger" in settlement).toBe(false);
  });

  it("discards the whole settlement when a layer owner does not credit exactly what it was given", () => {
    // The layer is already carrying as much of this substance as it can hold,
    // so the exact-credit operation refuses. The transaction reads the owner
    // back rather than trusting it, which is what makes this independent of any
    // owner's merge or capacity policy.
    let saturated = layerStore();
    const instance = saturated.instances[0];
    if (instance === undefined) throw new Error("fixture has no instance");
    saturated = {
      ...saturated,
      instances: [
        {
          ...instance,
          condition: {
            ...instance.condition,
            deposits: [
              {
                // The identity the credit will compute for this scope and beat,
                // already at saturation — so the exact-credit operation has to
                // refuse rather than clamp.
                id: `dep:mud:root:${AT}`,
                kind: "mud",
                partIds: [],
                intensity: 10_000,
                extent: 10_000,
                freshness: 10_000,
                atMinutes: AT,
              },
            ],
          },
        },
      ],
    };
    const start = owners({ layers: saturated });
    const blocked = proposal({
      path: {
        layers: [{ layerId: "sleeve", order: 0, throughput: toUnitInterval(0), evidence: [] }],
        destination: { kind: "body", subjectId: TARGET, locationId: "forearms" },
        evidence: [],
      },
    });
    const { settlement } = run({ owners: start, proposal: blocked });
    expect(settlement.status).toBe("refused");
    if (settlement.status !== "refused") return;
    expect(settlement.code).toBe(SURFACE_TRANSFER_LAYER_REFUSED);
    expect(worldTotal(start)).toBe(18_000);
  });

  it("refuses a proposal whose source record no longer holds what it read", () => {
    const start = owners({ source: emptyBodySurfaceState() });
    const { settlement, sink } = run({ owners: start });
    expect(settlement.status).toBe("refused");
    expectDiagnostics(sink, [SURFACE_TRANSFER_SOURCE_STALE]);
  });
});

describe("applySurfaceTransferProposal — retry and retake", () => {
  it("does not transfer twice for one causal identity", () => {
    const { settlement } = run();
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    const second = applySurfaceTransferProposal({
      proposal: proposal(),
      owners: settlement.owners,
      resolveLayer,
      atMinutes: AT,
    });
    expect(second.status).toBe("no_change");
    expect(worldTotal(settlement.owners)).toBe(8_000);
  });

  it("takes the receipt back with the debit when the source surface is restored", () => {
    // The retake law. The receipt rides the debited surface for
    // exactly this reason: restoring that surface from its pre-exchange anchor
    // removes the material AND the record that it moved, together, with no
    // second thing to remember to undo.
    const anchor = owners();
    const { settlement } = run({ owners: anchor });
    expect(settlement.status).toBe("committed");
    if (settlement.status !== "committed") return;
    expect(bodySurfaceTransferCommitted(settlement.owners.source, proposal().idempotencyKey)).toBe(true);
    expect(bodySurfaceTransferCommitted(anchor.source, proposal().idempotencyKey)).toBe(false);
    const replay = applySurfaceTransferProposal({
      proposal: proposal(),
      owners: anchor,
      resolveLayer,
      atMinutes: AT,
    });
    expect(replay.status).toBe("committed");
  });
});

describe("applySurfaceTransferProposals", () => {
  it("threads the owners forward, so the second transfer sees what the first one left", () => {
    const first = proposal({ idempotencyKey: "k1", amount: 4_000 });
    const second = proposal({ idempotencyKey: "k2", amount: 4_000 });
    const start = owners();
    const result = applySurfaceTransferProposals({
      proposals: [first, second],
      owners: start,
      resolveLayer,
      atMinutes: AT,
    });
    expect(result.committed).toBe(2);
    expect(result.ledgers.map((ledger) => ledger.debited)).toEqual([4_000, 4_000]);
    expect(worldTotal(result.owners)).toBe(worldTotal(start));
  });

  it("carries on past a refusal with the owners the previous settlement left", () => {
    const good = proposal({ idempotencyKey: "k1" });
    const stale = proposal({ idempotencyKey: "k2", material: { ...proposal().material, depositId: "dep:mud:gone:0" } });
    const start = owners();
    const result = applySurfaceTransferProposals({
      proposals: [stale, good],
      owners: start,
      resolveLayer,
      atMinutes: AT,
    });
    expect(result.committed).toBe(1);
    expect(worldTotal(result.owners)).toBe(worldTotal(start));
  });
});
