import { describe, expect, it } from "vitest";
import { garmentReadout, type GarmentReadout } from "./garment-effective-coverage";
import { GARMENT_DEGREE_BAND_VALUES, GARMENT_UNIT_ONE } from "./garment-material";
import { templateFor, wornGarment } from "./garment-test-fixtures";
import { emptyGarmentCueState } from "./garment-instance";
import {
  garmentObservations,
  garmentPreviousBands,
  garmentSceneNotes,
  splitGarmentCues,
  GARMENT_CUES_PER_EXCHANGE,
  type GarmentObservationActor,
} from "./garment-observation";

/**
 * The bounded cue block (clothing-state-graph slice 6): the six families, the
 * perception gate, and the repeat gate.
 *
 * The acceptance criterion under test throughout is the plan's: *"Unchanged
 * clothing produces no fresh cue; a meaningful change may produce one."*
 */

const TOP = templateFor("top");
const OUTERWEAR = templateFor("outerwear");
const BRA = templateFor("bra");
const SKIRT = templateFor("skirt");

/** One actor wearing the given readouts, referred to as "Wren's". */
const wren = (readouts: readonly GarmentReadout[], visibility?: Record<string, "visible" | "hinted" | "hidden">): GarmentObservationActor => ({
  possessive: "Wren's",
  readouts,
  ...(visibility === undefined ? {} : { visibility }),
});

const rolledShirt = () =>
  garmentReadout(wornGarment({ presentation: { roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } } }), TOP);

describe("the six families", () => {
  it("closure_open — partly, then fully", () => {
    const partly = garmentObservations([
      wren([
        garmentReadout(
          wornGarment({ presentation: { closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1] } } } }),
          TOP,
        ),
      ]),
    ]).filter((entry) => entry.family === "closure_open");
    expect(partly).toHaveLength(1);
    expect(partly[0]?.repeatKey).toBe("g_shirt:front_panel:closure_open:partly_open");
    expect(partly[0]?.phrase).toBe("Wren's linen shirt sits partly unfastened at the front");

    const open = garmentObservations([
      wren([
        garmentReadout(
          wornGarment({ presentation: { closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } } } }),
          TOP,
        ),
      ]),
    ]).filter((entry) => entry.family === "closure_open");
    expect(open[0]?.intensityBand).toBe("open");
    expect(open[0]?.phrase).toBe("Wren's linen shirt hangs open at the front");
  });

  it("part_rolled — one side only, tagged with its degree", () => {
    const cues = garmentObservations([wren([rolledShirt()])]);
    expect(cues.filter((entry) => entry.family === "part_rolled")).toHaveLength(1);
    const rolled = cues.find((entry) => entry.family === "part_rolled");
    expect(rolled?.partId).toBe("sleeve_left");
    expect(rolled?.semanticTags).toEqual(["substantial"]);
    expect(rolled?.phrase).toBe("Wren's linen shirt is rolled back at the left sleeve");
  });

  it("part_displaced — a fallen strap and a lifted hem", () => {
    const strap = garmentObservations([
      wren([
        garmentReadout(
          wornGarment({
            id: "g_bra",
            name: "bra",
            presentation: {
              displacement: [{ partId: "strap_left", kind: "off_shoulder", degree: GARMENT_DEGREE_BAND_VALUES.substantial }],
            },
          }),
          BRA,
        ),
      ]),
    ]);
    expect(strap[0]?.family).toBe("part_displaced");
    expect(strap[0]?.phrase).toBe("the left strap of Wren's bra has slipped off the shoulder");

    const hem = garmentObservations([
      wren([
        garmentReadout(
          wornGarment({
            id: "g_skirt",
            name: "wool skirt",
            presentation: {
              displacement: [{ partId: "panel", kind: "lifted", degree: GARMENT_DEGREE_BAND_VALUES.extreme }],
            },
          }),
          SKIRT,
        ),
      ]),
    ]);
    expect(hem[0]?.intensityBand).toBe("lifted");
    expect(hem[0]?.phrase).toBe("the skirt of Wren's wool skirt is riding up");
  });

  it("surface_damp_or_wet — a soaked hem speaks for itself, not for the whole shirt", () => {
    const readout = garmentReadout(
      wornGarment({
        condition: {
          base: { wetness: 2_000, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 },
          regionOverrides: { hem: { wetness: GARMENT_UNIT_ONE } },
        },
      }),
      TOP,
    );
    // The whole-garment band is the WORST reading, so "soaked" here is the hem's
    // doing — the located read replaces it rather than doubling it.
    expect(readout.condition.wetness).toBe("soaked");
    const wet = garmentObservations([wren([readout])]).filter((entry) => entry.family === "surface_damp_or_wet");
    expect(wet).toHaveLength(1);
    expect(wet[0]?.phrase).toBe("the shirttail of Wren's linen shirt is soaked");
    expect(wet[0]?.repeatKey).toBe("g_shirt:hem:surface_damp_or_wet:soaked");
  });

  it("surface_damp_or_wet — a garment wet all over keeps its one whole-garment cue", () => {
    const readout = garmentReadout(
      wornGarment({ condition: { base: { wetness: 6_000, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } } }),
      TOP,
    );
    const wet = garmentObservations([wren([readout])]);
    expect(wet).toHaveLength(1);
    expect(wet[0]?.phrase).toBe("Wren's linen shirt is wet through");
    expect(wet[0]?.semanticTags).toEqual(["whole_garment"]);
  });

  it("deposit_visible and damage_visible — located, and phrased by freshness", () => {
    const readout = garmentReadout(
      wornGarment({
        condition: {
          deposits: [
            { id: "d1", kind: "mud", partIds: ["hem"], intensity: 7_500, extent: 5_000, freshness: 0, atMinutes: 0 },
          ],
          damageMarks: [{ id: "m1", kind: "tear", partId: "cuff_left", severity: 7_500, extent: 2_000, atMinutes: 0 }],
        },
      }),
      TOP,
    );
    const cues = garmentObservations([wren([readout])]);
    const deposit = cues.find((entry) => entry.family === "deposit_visible");
    expect(deposit?.repeatKey).toBe("g_shirt:hem:deposit_visible:mud_substantial");
    expect(deposit?.phrase).toBe("mud has dried into the shirttail of Wren's linen shirt");
    const damage = cues.find((entry) => entry.family === "damage_visible");
    expect(damage?.phrase).toBe("there is a tear at the left cuff of Wren's linen shirt");
    // A tear outranks a stain outranks a roll — ranking is by family, then depth.
    expect(cues[0]?.family).toBe("damage_visible");
  });

  it("emits nothing for a garment that is simply worn as made", () => {
    expect(garmentObservations([wren([garmentReadout(wornGarment({}), TOP)])])).toEqual([]);
  });
});

describe("perception — hidden parts cannot produce visual cues (F12)", () => {
  it("drops a buried part's read, and keeps a visible one on the same garment", () => {
    const readout = garmentReadout(
      wornGarment({
        condition: {
          deposits: [
            { id: "d1", kind: "blood", partIds: ["front_panel"], intensity: 7_500, extent: 4_000, freshness: GARMENT_UNIT_ONE, atMinutes: 0 },
            { id: "d2", kind: "mud", partIds: ["hem"], intensity: 7_500, extent: 4_000, freshness: 0, atMinutes: 0 },
          ],
        },
      }),
      TOP,
    );
    const hidden = garmentObservations([
      wren([readout], { "g_shirt:front_panel": "hidden", "g_shirt:hem": "visible" }),
    ]);
    expect(hidden.map((entry) => entry.partId)).toEqual(["hem"]);
    // Nothing was deleted — the same state reads normally once it is uncovered.
    expect(garmentObservations([wren([readout])]).map((entry) => entry.partId).sort()).toEqual(["front_panel", "hem"]);
  });

  it("falls back to the garment's verdict, then to visible — never guessing something into hiding", () => {
    const readout = rolledShirt();
    expect(garmentObservations([wren([readout], { g_shirt: "hidden" })])).toEqual([]);
    expect(garmentObservations([wren([readout], {})])).toHaveLength(1);
  });
});

describe("the repeat gate — changes surface, standing state does not", () => {
  it("a change beats standing state, and unchanged state produces NO fresh cue", () => {
    const observations = garmentObservations([wren([rolledShirt()])]);
    const first = splitGarmentCues({ observations, readouts: [rolledShirt()], atMinutes: 10 });
    expect(first.selected.map((entry) => entry.phrase)).toEqual([
      "Wren's linen shirt is rolled back at the left sleeve",
    ]);

    // Second exchange, nothing moved: the same read is now standing, not fresh.
    const second = splitGarmentCues({
      observations,
      readouts: [rolledShirt()],
      previous: first.next,
      atMinutes: 20,
    });
    expect(second.selected).toEqual([]);
    expect(second.standing).toHaveLength(1);
    // …and the last-changed stamp did not move with it.
    const key = "g_shirt:sleeve_left:part_rolled";
    expect(first.next.changedAt[key]).toBe(10);
    expect(second.next.changedAt[key]).toBe(10);

    // A deepening band IS a change — the key is the same, the band is not.
    const openedToo = garmentObservations([
      wren([
        garmentReadout(
          wornGarment({
            presentation: {
              roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial },
              closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1] } },
            },
          }),
          TOP,
        ),
      ]),
    ]);
    const third = splitGarmentCues({ observations: openedToo, readouts: [rolledShirt()], previous: second.next, atMinutes: 30 });
    expect(third.selected.map((entry) => entry.family)).toEqual(["closure_open"]);
  });

  it("caps the block at two cues, most salient first, and carries the rest as standing", () => {
    const loud = garmentReadout(
      wornGarment({
        presentation: {
          roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial },
          closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } },
        },
        condition: {
          base: { wetness: GARMENT_UNIT_ONE, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 },
          deposits: [{ id: "d1", kind: "mud", partIds: ["hem"], intensity: 7_500, extent: 4_000, freshness: 0, atMinutes: 0 }],
          damageMarks: [{ id: "m1", kind: "tear", partId: "cuff_left", severity: 7_500, extent: 2_000, atMinutes: 0 }],
        },
      }),
      TOP,
    );
    const split = splitGarmentCues({ observations: garmentObservations([wren([loud])]), readouts: [loud] });
    expect(split.selected).toHaveLength(GARMENT_CUES_PER_EXCHANGE);
    expect(split.selected.map((entry) => entry.family)).toEqual(["damage_visible", "deposit_visible"]);
    expect(split.standing.length).toBeGreaterThan(0);
  });

  it("records the reported condition bands so hysteresis has a durable home", () => {
    const damp = garmentReadout(
      wornGarment({ condition: { base: { wetness: 4_600, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } } }),
      TOP,
    );
    const split = splitGarmentCues({ observations: garmentObservations([wren([damp])]), readouts: [damp] });
    expect(split.next.bands.g_shirt?.wetness).toBe("wet");
    expect(garmentPreviousBands(split.next, "g_shirt").wetness).toBe("wet");
    expect(garmentPreviousBands(emptyGarmentCueState(), "g_shirt")).toEqual({});

    // A read just under the boundary keeps saying "wet" (slice 4's hysteresis),
    // which is only possible because the previous band was persisted here.
    const settling = garmentReadout(
      wornGarment({ condition: { base: { wetness: 4_200, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } } }),
      TOP,
      { previousBands: garmentPreviousBands(split.next, "g_shirt") },
    );
    expect(settling.condition.wetness).toBe("wet");
  });
});

describe("the per-scene image notes", () => {
  it("hand the whole current frame over, un-gated by repetition", () => {
    const readout = garmentReadout(
      wornGarment({
        presentation: { roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } },
        condition: { base: { wetness: GARMENT_UNIT_ONE, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } },
      }),
      OUTERWEAR,
    );
    const notes = garmentSceneNotes([wren([readout])]);
    expect(notes).toContain("Wren's linen shirt is soaked through");
    expect(notes).toContain("Wren's linen shirt is rolled back at the left sleeve");
    expect(notes.join(" ")).not.toMatch(/\d/u);
  });
});
