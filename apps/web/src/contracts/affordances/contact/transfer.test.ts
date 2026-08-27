import { describe, expect, it } from "vitest";
import { affordanceEvidence, toUnitInterval } from "../core";
import { contactEntityId } from "./identity";
import { commitContactResolution, emptyContactLifecycleState } from "./lifecycle";
import { resolveContactAttempt } from "./resolve";
import { surfaceTransferProposals, SURFACE_TRANSFER_MIN_AMOUNT, type ResolvedSurfaceTransferPath, type SurfaceTransferMaterialRead } from "./transfer";
import type { CommittedContactRead, ContactActionIntent } from "./types";
import { probeAttempt, probeBodySurface, PROBE_ACTOR, PROBE_EVENT, PROBE_TARGET } from "./test-support";

/**
 * The conserved-transfer producer: a pure derivation from a genuinely COMMITTED
 * contact plus two reads this layer is not allowed to author.
 *
 * Three claims are worth permanent protection here, and each names a defect a
 * plausible implementation would have:
 *
 * 1. **It fails closed on every axis**, including the two new ones the mark
 *    producer does not have — a source record that stands somewhere the contact
 *    never touched, and a path that ends somewhere the contact never reached.
 *    Either one would let contact move material off or onto a surface it has no
 *    committed authority over.
 * 2. **Motion qualifies only when it is RELATIVE** — no relative motion, no
 *    glide. Falsified against a producer that treated `pressing` as motion
 *    because it is a member of the motion vocabulary — a hand bearing down
 *    without travelling has wiped nothing off.
 * 3. **Two substances off one hand are two identities.** Falsified against a key
 *    built from the contact and event alone, where moving mud and then blood in
 *    one committed press made the second look like a retry of the first and
 *    silently transferred nothing.
 */

const MUD_LOCUS = probeBodySurface(PROBE_ACTOR, "hands");
const DESTINATION = probeBodySurface(PROBE_TARGET, "feet", "arch");

function committed(intent: Partial<ContactActionIntent> = {}): CommittedContactRead {
  const resolution = resolveContactAttempt(probeAttempt({ intent }));
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  const outcome = commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT });
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  return outcome.contact;
}

function material(overrides: Partial<SurfaceTransferMaterialRead> = {}): SurfaceTransferMaterialRead {
  return {
    depositId: "dep:mud:hands:0",
    kind: "mud",
    locus: MUD_LOCUS,
    amount: 8_000,
    evidence: [affordanceEvidence("state", "body_surface.deposit")],
    ...overrides,
  };
}

function path(overrides: Partial<ResolvedSurfaceTransferPath> = {}): ResolvedSurfaceTransferPath {
  return { layers: [], destination: DESTINATION, evidence: [], ...overrides };
}

describe("surfaceTransferProposals", () => {
  it("derives one proposal from firm sliding contact, keyed to the source record", () => {
    const proposals = surfaceTransferProposals({
      contact: committed({ requestedPressure: "firm", requestedMotion: { band: "sliding" } }),
      material: material(),
      path: path(),
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "surface_transfer", pressure: "firm", motionBand: "sliding" });
    // firm 5_000 + sliding 2_500 = 7_500 of 8_000 standing.
    expect(proposals[0]?.amount).toBe(6_000);
    expect(proposals[0]?.idempotencyKey).toContain("dep:mud:hands:0");
  });

  it.each([
    ["unstated pressure is not a light press", {}],
    ["a trace press moves nothing", { requestedPressure: "trace" as const }],
    ["a light press moves nothing", { requestedPressure: "light" as const }],
  ])("proposes nothing when %s", (_label, intent) => {
    expect(surfaceTransferProposals({ contact: committed(intent), material: material(), path: path() })).toEqual([]);
  });

  it.each([
    ["still", 4_000],
    ["pressing", 4_000],
    ["sliding", 6_000],
    ["rolling", 5_600],
    ["tapping", 4_800],
  ])("adds nothing for %s unless it is relative motion", (band, expected) => {
    const proposals = surfaceTransferProposals({
      contact: committed({ requestedPressure: "firm", requestedMotion: { band: band as "still" } }),
      material: material(),
      path: path(),
    });
    expect(proposals[0]?.amount).toBe(expected);
  });

  it("proposes nothing when the material stands somewhere the contact never touched", () => {
    const proposals = surfaceTransferProposals({
      contact: committed({ requestedPressure: "firm" }),
      material: material({ locus: probeBodySurface(PROBE_ACTOR, "forearms") }),
      path: path(),
    });
    expect(proposals).toEqual([]);
  });

  it("proposes nothing when the path ends somewhere the contact never reached", () => {
    const proposals = surfaceTransferProposals({
      contact: committed({ requestedPressure: "firm" }),
      material: material(),
      path: path({ destination: probeBodySurface(PROBE_TARGET, "shoulders") }),
    });
    expect(proposals).toEqual([]);
  });

  it("proposes nothing against an object, which has no surface owner", () => {
    const contact = committed({
      requestedPressure: "firm",
      target: { kind: "object", entityId: contactEntityId("probe_wall"), surfaceId: "face" },
    });
    expect(surfaceTransferProposals({ contact, material: material(), path: path() })).toEqual([]);
  });

  it("proposes nothing when the qualifying fraction is too little to be a beat", () => {
    // moderate on a nearly-clean surface: 2_500 of 900 is 225, under the floor.
    const proposals = surfaceTransferProposals({
      contact: committed({ requestedPressure: "moderate" }),
      material: material({ amount: 900 }),
      path: path(),
    });
    expect(proposals).toEqual([]);
    expect(SURFACE_TRANSFER_MIN_AMOUNT).toBeGreaterThan(225);
  });

  it("keys two substances off one committed press apart, so neither reads as the other's retry", () => {
    const contact = committed({ requestedPressure: "firm" });
    const mud = surfaceTransferProposals({ contact, material: material(), path: path() });
    const blood = surfaceTransferProposals({
      contact,
      material: material({ depositId: "dep:blood:hands:0", kind: "blood" }),
      path: path(),
    });
    expect(mud[0]?.idempotencyKey).not.toBe(blood[0]?.idempotencyKey);
  });

  it("re-derives the identical proposal from the identical committed read", () => {
    const contact = committed({ requestedPressure: "firm", requestedMotion: { band: "sliding" } });
    const first = surfaceTransferProposals({ contact, material: material(), path: path() });
    const second = surfaceTransferProposals({ contact, material: material(), path: path() });
    expect(second).toEqual(first);
  });

  it("orders path layers totally, so a resolver's list order is not a physical claim", () => {
    const layer = (layerId: string, order: number) => ({
      layerId,
      order,
      throughput: toUnitInterval(5_000),
      evidence: [],
    });
    const forward = surfaceTransferProposals({
      contact: committed({ requestedPressure: "firm" }),
      material: material(),
      path: path({ layers: [layer("b", 0), layer("a", 0)] }),
    });
    const reversed = surfaceTransferProposals({
      contact: committed({ requestedPressure: "firm" }),
      material: material(),
      path: path({ layers: [layer("a", 0), layer("b", 0)] }),
    });
    expect(forward[0]?.path.layers.map((entry) => entry.layerId)).toEqual(["a", "b"]);
    expect(reversed[0]?.path.layers).toEqual(forward[0]?.path.layers);
  });
});
