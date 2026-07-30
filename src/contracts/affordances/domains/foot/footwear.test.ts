import { describe, expect, it } from "vitest";
import { toUnitInterval } from "../../core";
import { footwearFixture } from "./fixtures";
import {
  bareFootwearContact,
  compileFootwearContact,
  footwearCovers,
  footwearFilterTagAt,
  footwearHidesDeformation,
  footwearLayersAt,
  footwearPartIds,
  footwearPartSurfaces,
  footwearPermitsHeelSlip,
  footwearRestrictsArticulation,
  footwearTransmissionAt,
} from "./footwear";
import { footSurfaceIds } from "./topology";

/** A full sock: cuff, heel, sole, toes. */
const sock = () => footwearFixture();

/** A peep-toe pump: everything but the toe box. */
const peepToe = () =>
  footwearFixture({
    layerId: "peep_toe",
    kind: "shoe",
    parts: ["upper", "insole", "heel_counter", "closure", "outsole"],
    filterTag: "leather",
    rigidity: toUnitInterval(5_000),
    closureState: "secured",
  });

/** An unfastened boot that still contains the toes. */
const looseBoot = () =>
  footwearFixture({
    layerId: "loose_boot",
    kind: "shoe",
    parts: ["upper", "toe_box", "tongue", "closure", "heel_counter", "insole", "outsole"],
    filterTag: "leather",
    rigidity: toUnitInterval(7_000),
    closureState: "loose",
    tactileTransmission: toUnitInterval(500),
    shapeTransmission: toUnitInterval(400),
  });

describe("part → surface mapping", () => {
  it("expands a part's roots through the topology", () => {
    expect(footwearPartSurfaces("sole_section")).toEqual([
      "plantar_surface",
      "heel_pad",
      "arch",
      "medial_arch",
      "lateral_arch",
      "ball",
      "inner_edge",
      "outer_edge",
    ]);
    expect(footwearPartSurfaces("toe_box")).toEqual([
      "toes",
      "toe_tops",
      "toe_pads",
      "interdigital_spaces",
      "toenails",
    ]);
  });

  it("maps the outsole onto nothing — it touches the ground, not the wearer", () => {
    expect(footwearPartSurfaces("outsole")).toEqual([]);
  });

  it("never lets one part reach the whole foot", () => {
    for (const partId of footwearPartIds) {
      expect(footwearPartSurfaces(partId).length, partId).toBeLessThan(footSurfaceIds.length);
    }
  });
});

describe("footwear blocks direct skin where it covers, and only there", () => {
  it("blocks direct skin under a sock", () => {
    const read = compileFootwearContact([sock()]);
    expect(footwearTransmissionAt(read, "arch").directSkinContact).toBe(false);
    expect(footwearTransmissionAt(read, "heel_pad").directSkinContact).toBe(false);
  });

  it("still transmits filtered touch through flexible fabric", () => {
    const read = compileFootwearContact([sock()]);
    const transmission = footwearTransmissionAt(read, "arch");
    expect(transmission.tactileTransmission).toBeGreaterThan(0);
    expect(transmission.tactileTransmission).toBeLessThan(10_000);
    expect(footwearFilterTagAt(read, "arch")).toBe("ribbed_sock");
  });

  it("leaves the dorsal surface bare under a sock that has no upper", () => {
    const read = compileFootwearContact([sock()]);
    expect(footwearCovers(read, "dorsal_surface")).toBe(false);
    expect(footwearTransmissionAt(read, "dorsal_surface").directSkinContact).toBe(true);
    expect(footwearLayersAt(read, "dorsal_surface")).toEqual([]);
    expect(footwearFilterTagAt(read, "dorsal_surface")).toBeUndefined();
  });

  it("exposes the toes of an open-toed shoe but not its sole or heel", () => {
    const read = compileFootwearContact([peepToe()]);
    expect(footwearCovers(read, "toes")).toBe(false);
    expect(footwearCovers(read, "toenails")).toBe(false);
    expect(footwearCovers(read, "plantar_surface")).toBe(true);
    expect(footwearCovers(read, "heel_pad")).toBe(true);
    expect(footwearTransmissionAt(read, "toe_pads").directSkinContact).toBe(true);
    expect(footwearTransmissionAt(read, "heel_pad").directSkinContact).toBe(false);
  });

  it("stacks a boot over a sock without either losing its own surfaces", () => {
    const read = compileFootwearContact([sock(), { ...looseBoot(), order: 1 }]);
    expect(footwearLayersAt(read, "arch").map((layer) => layer.layerId)).toEqual(["fixture_sock", "loose_boot"]);
    // The dorsal surface is the boot's alone: the sock has no upper.
    expect(footwearLayersAt(read, "dorsal_surface").map((layer) => layer.layerId)).toEqual(["loose_boot"]);
    expect(footwearFilterTagAt(read, "arch")).toBe("leather");
  });
});

describe("what footwear does to movement", () => {
  it("restricts articulation when it is rigid, tight, or short in the toe box", () => {
    expect(footwearRestrictsArticulation(compileFootwearContact([looseBoot()]))).toBe(true);
    expect(footwearRestrictsArticulation(compileFootwearContact([sock()]))).toBe(false);
    const tightSock = compileFootwearContact([footwearFixture({ toeBoxVolume: toUnitInterval(2_000) })]);
    expect(footwearRestrictsArticulation(tightSock)).toBe(true);
  });

  it("hides deformation inside rigid footwear even where the fabric would transmit", () => {
    const read = compileFootwearContact([looseBoot()]);
    expect(footwearHidesDeformation(read, "toe_tops")).toBe(true);
    // Flexible fabric transmits a movement rather than hiding it...
    const socked = compileFootwearContact([sock()]);
    expect(footwearHidesDeformation(socked, "arch")).toBe(false);
    // ...and an uncovered surface hides nothing, because nothing is over it.
    expect(footwearCovers(socked, "dorsal_surface")).toBe(false);
    expect(footwearHidesDeformation(socked, "dorsal_surface")).toBe(false);
  });

  it("lets the heel slip out of a loose shoe that still contains the toes", () => {
    expect(footwearPermitsHeelSlip(compileFootwearContact([looseBoot()]))).toBe(true);
    expect(footwearPermitsHeelSlip(compileFootwearContact([{ ...looseBoot(), closureState: "secured" }]))).toBe(false);
    // An open-toed shoe does not contain the toes, so nothing slips within it.
    expect(footwearPermitsHeelSlip(compileFootwearContact([{ ...peepToe(), closureState: "loose" }]))).toBe(false);
  });

  it("refuses to call an unreadable closure loose", () => {
    const read = compileFootwearContact([{ ...looseBoot(), closureState: "unknown" }]);
    expect(read.closureState).toBe("unknown");
    expect(footwearPermitsHeelSlip(read)).toBe(false);
  });

  it("takes the most restrictive term across a stack and the product of permeability", () => {
    const read = compileFootwearContact([sock(), { ...looseBoot(), order: 1 }]);
    expect(read.rigidity).toBe(7_000);
    expect(read.compression).toBe(3_000);
    expect(read.permeability).toBeLessThan(sock().permeability);
    expect(read.toeBoxVolume).toBe(7_000);
  });
});

describe("footwear state changes only with the payload", () => {
  it("reads a bare foot as covering nothing", () => {
    const bare = compileFootwearContact([]);
    expect(bare).toEqual(bareFootwearContact());
    expect(bare.containedSurfaces).toEqual([]);
    for (const surfaceId of footSurfaceIds) {
      expect(footwearTransmissionAt(bare, surfaceId).directSkinContact, surfaceId).toBe(true);
    }
  });

  it("is a pure function of the worn stack, in any order the wardrobe reports it", () => {
    const stack = [sock(), { ...looseBoot(), order: 1 }];
    expect(compileFootwearContact(stack)).toEqual(compileFootwearContact([...stack].reverse()));
  });

  it("never blinds a covered surface when the wardrobe repeats a layer id", () => {
    // Two rows sharing a lane-supplied id. Last-write-wins left the sole covered
    // in `containedSurfaces` while `surfacesByLayer` held only the second row's
    // surfaces, so `footwearLayersAt` returned nothing for a covered surface and
    // the texture read lost its filtered register.
    const read = compileFootwearContact([
      footwearFixture({ layerId: "same", parts: ["sole_section"] }),
      footwearFixture({ layerId: "same", parts: ["toe_section"], order: 1 }),
    ]);
    expect(footwearCovers(read, "plantar_surface")).toBe(true);
    expect(footwearCovers(read, "toes")).toBe(true);
    for (const surfaceId of read.containedSurfaces) {
      expect(footwearLayersAt(read, surfaceId).length, surfaceId).toBeGreaterThan(0);
      expect(footwearTransmissionAt(read, surfaceId).directSkinContact, surfaceId).toBe(false);
      expect(footwearFilterTagAt(read, surfaceId), surfaceId).toBeDefined();
    }
  });

  it("uncovers a surface only by the part list changing, never by a call", () => {
    const shod = compileFootwearContact([sock()]);
    const barefoot = compileFootwearContact([{ ...sock(), parts: [] }]);
    expect(footwearCovers(shod, "arch")).toBe(true);
    expect(footwearCovers(barefoot, "arch")).toBe(false);
    // Reading it again cannot have changed it: the affordance layer keeps no
    // memory of a removal, because removal is a committed wardrobe action.
    expect(compileFootwearContact([sock()])).toEqual(shod);
  });
});
