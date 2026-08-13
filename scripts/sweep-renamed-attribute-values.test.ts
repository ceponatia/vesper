import { describe, expect, it } from "vitest";
import { attributeRegistry } from "@/contracts/attributes";
import {
  ID_REMOVALS,
  ID_RENAMES,
  VALUE_RENAMES,
  isRemovedId,
  remapIdValue,
  sweepAttributeValueList,
  sweepConditionList,
  sweepParticipantState,
  sweepProfile,
} from "./sweep-renamed-attribute-values";

/**
 * Pure tests for the one-off stored-value sweep (attribute-narrator-guidance.plan.md
 * slice 3). The DB glue in `main()` is thin; the risk lives in the pure remap tables
 * and functions — chiefly that every rename TARGET is a real current registry value
 * (a typo would rewrite good data into a value that fails `parseValue`), and that the
 * sweep is id-scoped, provenance-preserving, and idempotent.
 */

describe("sweep rename tables target valid registry values", () => {
  it("every same-id value-rename target parses under its attribute", () => {
    for (const [id, map] of Object.entries(VALUE_RENAMES)) {
      for (const target of Object.values(map)) {
        const parsed = attributeRegistry.parseValue(id, target);
        expect(parsed.ok, `${id} → ${target}`).toBe(true);
      }
    }
  });

  it("every id-rename points at a real attribute and produces valid values", () => {
    for (const { newId, valueMap } of Object.values(ID_RENAMES)) {
      expect(attributeRegistry.byId(newId), newId).toBeDefined();
      for (const target of Object.values(valueMap ?? {})) {
        expect(attributeRegistry.parseValue(newId, target).ok, `${newId} → ${target}`).toBe(true);
      }
    }
  });

  it("labia carry-over values still parse under the new labia_minora id", () => {
    // tucked / even / asymmetric are not remapped, but the id move must land them
    // on a value that's still legal in the split attribute's vocabulary.
    for (const value of ["tucked", "even", "asymmetric"]) {
      expect(attributeRegistry.parseValue("vulva.labia_minora", value).ok, value).toBe(true);
    }
  });
});

describe("ID_REMOVALS", () => {
  it("lists only ids that are genuinely gone from the registry", () => {
    // The dangerous mistake is listing a LIVE id — the sweep would delete good
    // data. A removal is only legal once the definition is actually deleted.
    for (const id of ID_REMOVALS) {
      expect(attributeRegistry.byId(id), id).toBeUndefined();
    }
  });

  it("covers the retired hair.quality axis but not its successors", () => {
    expect(isRemovedId("hair.quality")).toBe(true);
    for (const id of ["hair.density", "hair.strand_thickness", "hair.condition", "hair.arrangement"]) {
      expect(attributeRegistry.byId(id), id).toBeDefined();
      expect(isRemovedId(id), id).toBe(false);
    }
  });

  it("never overlaps the rename tables — an id is renamed or removed, not both", () => {
    for (const id of ID_REMOVALS) {
      expect(ID_RENAMES[id], id).toBeUndefined();
      expect(VALUE_RENAMES[id], id).toBeUndefined();
    }
  });
});

describe("remapIdValue", () => {
  it("maps every old build.frame value to a canonical gauge", () => {
    expect(remapIdValue("build.frame", "willowy")).toEqual({ id: "build.frame", value: "slight", changed: true });
    expect(remapIdValue("build.frame", "lean")).toEqual({ id: "build.frame", value: "average", changed: true });
    expect(remapIdValue("build.frame", "athletic")).toEqual({ id: "build.frame", value: "average", changed: true });
    expect(remapIdValue("build.frame", "curvy")).toEqual({ id: "build.frame", value: "average", changed: true });
    expect(remapIdValue("build.frame", "stocky")).toEqual({ id: "build.frame", value: "sturdy", changed: true });
    expect(remapIdValue("build.frame", "broad")).toEqual({ id: "build.frame", value: "sturdy", changed: true });
    expect(remapIdValue("build.frame", "heavyset")).toEqual({ id: "build.frame", value: "heavy_boned", changed: true });
  });

  it("leaves surviving values untouched (idempotent)", () => {
    expect(remapIdValue("build.frame", "slight")).toEqual({ id: "build.frame", value: "slight", changed: false });
    expect(remapIdValue("build.frame", "average")).toEqual({ id: "build.frame", value: "average", changed: false });
    expect(remapIdValue("feet.smell", "cheesy")).toEqual({ id: "feet.smell", value: "cheesy", changed: false });
  });

  it("maps dropped build.musculature soft to untoned", () => {
    expect(remapIdValue("build.musculature", "soft")).toEqual({ id: "build.musculature", value: "untoned", changed: true });
  });

  it("maps the feet.smell palette swap", () => {
    expect(remapIdValue("feet.smell", "freshly washed")).toEqual({ id: "feet.smell", value: "clean", changed: true });
    expect(remapIdValue("feet.smell", "neutral")).toEqual({ id: "feet.smell", value: "clean", changed: true });
    expect(remapIdValue("feet.smell", "cheesy and vinegary")).toEqual({ id: "feet.smell", value: "cheesy", changed: true });
    expect(remapIdValue("feet.smell", "sour")).toEqual({ id: "feet.smell", value: "sour_sweat", changed: true });
    expect(remapIdValue("feet.smell", "erotically stinky")).toEqual({ id: "feet.smell", value: "thick_musk", changed: true });
  });

  it("moves the dead vulva.labia id to labia_minora (value remapped or carried)", () => {
    expect(remapIdValue("vulva.labia", "prominent")).toEqual({ id: "vulva.labia_minora", value: "protruding", changed: true });
    // Value unchanged but id still moves — counts as a change so the row is rewritten.
    expect(remapIdValue("vulva.labia", "tucked")).toEqual({ id: "vulva.labia_minora", value: "tucked", changed: true });
  });

  it("is id-scoped: a word dropped from one attribute stays valid on another", () => {
    // `sour` was dropped from feet.smell but is still valid on vulva.scent — the
    // sweep must not touch it there.
    expect(remapIdValue("vulva.scent", "sour")).toEqual({ id: "vulva.scent", value: "sour", changed: false });
    // `soft` dropped from musculature but valid on weight_presentation / skin.texture.
    expect(remapIdValue("build.weight_presentation", "soft")).toEqual({ id: "build.weight_presentation", value: "soft", changed: false });
  });

  it("leaves an unrenamed attribute id entirely alone", () => {
    expect(remapIdValue("eyes.color", "amber")).toEqual({ id: "eyes.color", value: "amber", changed: false });
  });
});

describe("sweepAttributeValueList", () => {
  it("remaps matching entries and preserves provenance fields", () => {
    const { next, changes } = sweepAttributeValueList([
      { id: "build.frame", value: "willowy", source: "manual", sourceId: "x", note: "keep me" },
      { id: "eyes.color", value: "green", source: "base" },
    ]);
    expect(changes).toBe(1);
    expect(next).toEqual([
      { id: "build.frame", value: "slight", source: "manual", sourceId: "x", note: "keep me" },
      { id: "eyes.color", value: "green", source: "base" },
    ]);
  });

  it("passes unknown-shaped elements through verbatim (never drops data)", () => {
    const raw = [{ nonsense: true }, "loose string", 42];
    const { next, changes } = sweepAttributeValueList(raw);
    expect(changes).toBe(0);
    expect(next).toBe(raw);
  });

  it("returns the input unchanged for non-arrays and empty results", () => {
    expect(sweepAttributeValueList(undefined)).toEqual({ next: undefined, changes: 0 });
    const clean = [{ id: "eyes.color", value: "blue", source: "base" }];
    expect(sweepAttributeValueList(clean).next).toBe(clean);
  });

  it("is idempotent — a second pass is a no-op", () => {
    const first = sweepAttributeValueList([{ id: "feet.smell", value: "sour", source: "creation" }]);
    expect(first.changes).toBe(1);
    const second = sweepAttributeValueList(first.next);
    expect(second.changes).toBe(0);
  });

  it("drops entries under a removed id and keeps the rest in order", () => {
    const { next, changes } = sweepAttributeValueList([
      { id: "hair.color", value: "auburn", source: "base" },
      { id: "hair.quality", value: "silky", source: "manual", note: "gone with the axis" },
      { id: "hair.texture", value: "wavy", source: "creation" },
    ]);
    expect(changes).toBe(1);
    expect(next).toEqual([
      { id: "hair.color", value: "auburn", source: "base" },
      { id: "hair.texture", value: "wavy", source: "creation" },
    ]);
  });

  it("a removal sweep is idempotent — nothing left to drop on a second pass", () => {
    const first = sweepAttributeValueList([{ id: "hair.quality", value: "coarse", source: "creation" }]);
    expect(first.changes).toBe(1);
    expect(first.next).toEqual([]);
    expect(sweepAttributeValueList(first.next).changes).toBe(0);
  });
});

describe("sweepConditionList", () => {
  it("remaps renamed values inside condition attributeEffects", () => {
    const { next, changes } = sweepConditionList([
      {
        id: "sweaty_feet",
        label: "Sweaty feet",
        attributeEffects: [{ attributeId: "feet.smell", value: "sour" }],
      },
      { id: "blindfolded", label: "Blindfolded", attributeEffects: [] },
    ]);
    expect(changes).toBe(1);
    expect(next).toEqual([
      { id: "sweaty_feet", label: "Sweaty feet", attributeEffects: [{ attributeId: "feet.smell", value: "sour_sweat" }] },
      { id: "blindfolded", label: "Blindfolded", attributeEffects: [] },
    ]);
  });

  it("drops an effect on a removed id but keeps the condition itself", () => {
    const { next, changes } = sweepConditionList([
      {
        id: "rain_soaked",
        label: "Rain-soaked",
        attributeEffects: [
          { attributeId: "hair.quality", value: "straw_like" },
          { attributeId: "skin.texture", value: "smooth" },
        ],
      },
    ]);
    expect(changes).toBe(1);
    expect(next).toEqual([
      {
        id: "rain_soaked",
        label: "Rain-soaked",
        attributeEffects: [{ attributeId: "skin.texture", value: "smooth" }],
      },
    ]);
  });
});

describe("sweepProfile / sweepParticipantState", () => {
  it("remaps a CharacterProfile base attributes array in place", () => {
    const { next, changes } = sweepProfile({
      speciesId: "human",
      intimateRegions: ["vulva"],
      attributes: [{ id: "build.frame", value: "heavyset", source: "base" }],
    });
    expect(changes).toBe(1);
    expect(next).toEqual({
      speciesId: "human",
      intimateRegions: ["vulva"],
      attributes: [{ id: "build.frame", value: "heavy_boned", source: "base" }],
    });
  });

  it("sweeps both overlays and condition effects of a ParticipantState", () => {
    const { changes } = sweepParticipantState({
      attributeOverlays: [{ id: "build.musculature", value: "soft", source: "narrative" }],
      conditions: [{ id: "c", label: "c", attributeEffects: [{ attributeId: "feet.smell", value: "neutral" }] }],
      meters: {},
    });
    expect(changes).toBe(2);
  });

  it("sweeps a persona-shaped profile through the same core (personas.profile site)", () => {
    // PersonaProfile is a narrow pick of CharacterProfile with the identical
    // top-level `attributes` array — one function serves both tables.
    const { next, changes } = sweepProfile({
      bio: "your own body",
      speciesId: "human",
      intimateRegions: [],
      outfits: [],
      attributes: [
        { id: "hair.quality", value: "glossy", source: "manual" },
        { id: "build.frame", value: "willowy", source: "manual" },
      ],
    });
    expect(changes).toBe(2);
    expect(next).toMatchObject({
      bio: "your own body",
      attributes: [{ id: "build.frame", value: "slight", source: "manual" }],
    });
  });

  it("leaves a clean profile untouched by reference", () => {
    const profile = { speciesId: "human", attributes: [{ id: "eyes.color", value: "brown", source: "base" }] };
    expect(sweepProfile(profile).next).toBe(profile);
  });
});
