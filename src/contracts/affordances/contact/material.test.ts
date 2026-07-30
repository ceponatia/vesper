import { describe, expect, it } from "vitest";
import { AFFORDANCE_UNIT_ONE, toUnitInterval } from "../core";
import { composeContactMaterial, sortContactMaterialLayers } from "./material";
import { probeLayer, probeSheerLayer } from "./test-support";

describe("material between two surfaces", () => {
  it("reports direct contact only when nothing is between", () => {
    const composed = composeContactMaterial([]);
    expect(composed.directSkinContact).toBe(true);
    expect(composed.tactileTransmission).toBe(AFFORDANCE_UNIT_ONE);
    expect(composed.layerIds).toEqual([]);
  });

  it("does not call a fully transparent layer direct contact", () => {
    const composed = composeContactMaterial([probeSheerLayer("stocking")]);
    expect(composed.directSkinContact).toBe(false);
    expect(composed.tactileTransmission).toBe(AFFORDANCE_UNIT_ONE);
    expect(composed.visibleThrough).toBe(true);
  });

  it("damps every channel through each further layer, and never raises one", () => {
    const one = composeContactMaterial([probeLayer("sock")]);
    const two = composeContactMaterial([probeLayer("sock"), probeLayer("boot", 1)]);
    expect(two.tactileTransmission).toBeLessThan(one.tactileTransmission);
    expect(two.thermalTransmission).toBeLessThan(one.thermalTransmission);
    expect(two.scentTransmission).toBeLessThan(one.scentTransmission);
    expect(two.moistureTransmission).toBeLessThan(one.moistureTransmission);
  });

  it("multiplies proportionally", () => {
    const half = { ...probeSheerLayer("a"), tactileTransmission: toUnitInterval(5_000) };
    const quarter = { ...probeSheerLayer("b", 1), tactileTransmission: toUnitInterval(5_000) };
    expect(composeContactMaterial([half, quarter]).tactileTransmission).toBe(2_500);
  });

  it("is independent of the order the adapter happened to return", () => {
    const forwards = composeContactMaterial([probeLayer("sock"), probeLayer("boot", 1)]);
    const backwards = composeContactMaterial([probeLayer("boot", 1), probeLayer("sock")]);
    expect(backwards).toEqual(forwards);
    expect(forwards.layerIds).toEqual(["sock", "boot"]);
  });

  it("breaks ties on layer id so two layers at one offset still order totally", () => {
    const ordered = sortContactMaterialLayers([probeLayer("zebra"), probeLayer("aardvark")]);
    expect(ordered.map((layer) => layer.layerId)).toEqual(["aardvark", "zebra"]);
  });

  it("stays visible-through only while every layer is", () => {
    expect(composeContactMaterial([probeSheerLayer("a"), probeSheerLayer("b", 1)]).visibleThrough).toBe(true);
    expect(composeContactMaterial([probeSheerLayer("a"), probeLayer("b", 1)]).visibleThrough).toBe(false);
  });

  it("keeps each layer's provenance without repeating it", () => {
    const composed = composeContactMaterial([probeLayer("sock"), probeLayer("sock", 1)]);
    expect(composed.evidence).toHaveLength(1);
    expect(composed.evidence[0]?.ref).toBe("probe.layer.sock");
  });
});
