import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  degradedGarmentBlueprint,
  garmentBehaviorBindingFor,
  garmentBlueprintHash,
  garmentBlueprintSchema,
  garmentPartNode,
  garmentRootNode,
  normalizeGarmentBlueprint,
  GARMENT_ROOT_PART_ID,
  type GarmentBlueprint,
} from "./garment-blueprint";
import { garmentTemplateForCategory } from "./garment-templates";
import { parseGarmentBlueprint } from "./garment-blueprint-validation";

function shirt(): GarmentBlueprint {
  return garmentBlueprintSchema.parse({
    rootNodeId: "root",
    nodes: [
      { id: "root", kind: "root", baselineCoverage: ["shoulders"] },
      { id: "front_panel", kind: "panel", baselineCoverage: ["chest", "waist"], aliases: ["front"] },
      { id: "sleeve_left", kind: "sleeve", side: "left", baselineCoverage: ["upper_arms"] },
    ],
    edges: [
      { kind: "part_of", from: "front_panel", to: "root" },
      { kind: "part_of", from: "sleeve_left", to: "root" },
    ],
    behaviors: [{ behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 6 }],
  });
}

describe("garment blueprint schema", () => {
  it("defaults every optional field so a partial row parses clean", () => {
    const parsed = garmentBlueprintSchema.parse({ nodes: [{ id: "root", kind: "root" }] });
    expect(parsed.rootNodeId).toBe(GARMENT_ROOT_PART_ID);
    expect(parsed.version).toBe(1);
    expect(parsed.edges).toEqual([]);
    expect(parsed.behaviors).toEqual([]);
    expect(parsed.nodes[0]?.materialProfileId).toBe("unknown");
    expect(parsed.nodes[0]?.baselineCoverage).toEqual([]);
    expect(parsed.nodes[0]?.aliases).toEqual([]);
  });

  it("catches a bad leaf enum instead of rejecting the node", () => {
    const parsed = garmentBlueprintSchema.parse({
      nodes: [{ id: "cuff", kind: "gusset", materialProfileId: "burlap" }],
    });
    expect(parsed.nodes[0]?.kind).toBe("panel");
    expect(parsed.nodes[0]?.materialProfileId).toBe("unknown");
  });

  it("dedupes and caps aliases and coverage", () => {
    const parsed = garmentBlueprintSchema.parse({
      nodes: [{ id: "root", kind: "root", aliases: ["a", "a", "b", "c", "d", "e"], baselineCoverage: ["chest", "chest"] }],
    });
    expect(parsed.nodes[0]?.aliases).toEqual(["a", "b", "c", "d"]);
    expect(parsed.nodes[0]?.baselineCoverage).toEqual(["chest"]);
  });

  it("degrades malformed JSON to a valid, coverage-free root without throwing", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseOr(garmentBlueprintSchema, "{not json", degradedGarmentBlueprint(), sink, "garment.blueprint");
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]?.id).toBe(GARMENT_ROOT_PART_ID);
    expect(parsed.nodes[0]?.baselineCoverage).toEqual([]);
    expect(parsed.behaviors).toEqual([]);
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("parseGarmentBlueprint degrades a structurally-broken graph and names the rule", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseGarmentBlueprint(
      { rootNodeId: "root", nodes: [{ id: "sleeve", kind: "sleeve", baselineCoverage: ["forearms"] }], edges: [] },
      sink,
    );
    expect(parsed).toEqual(degradedGarmentBlueprint());
    expectDiagnostic(sink, "garment_blueprint.root_missing");
  });

  it("parseGarmentBlueprint passes a valid graph through untouched", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseGarmentBlueprint(JSON.stringify(shirt()), sink);
    expect(garmentBlueprintHash(parsed)).toBe(garmentBlueprintHash(shirt()));
    expectCleanSink(sink);
  });
});

describe("garment blueprint accessors", () => {
  it("finds the root, a part, and a part's behavior binding", () => {
    const blueprint = shirt();
    expect(garmentRootNode(blueprint)?.kind).toBe("root");
    expect(garmentPartNode(blueprint, "sleeve_left")?.side).toBe("left");
    expect(garmentPartNode(blueprint, "nope")).toBeUndefined();
    expect(garmentBehaviorBindingFor(blueprint, "front_panel")?.fastenerCount).toBe(6);
    expect(garmentBehaviorBindingFor(blueprint, "sleeve_left")).toBeUndefined();
  });
});

describe("garment blueprint content hash (OQ2)", () => {
  it("is stable across repeated calls", () => {
    expect(garmentBlueprintHash(shirt())).toBe(garmentBlueprintHash(shirt()));
  });

  it("ignores node, edge, behavior, alias and coverage ORDER (dedup works)", () => {
    const a = shirt();
    const b = garmentBlueprintSchema.parse({
      rootNodeId: "root",
      nodes: [
        { id: "sleeve_left", kind: "sleeve", side: "left", baselineCoverage: ["upper_arms"] },
        { id: "front_panel", kind: "panel", baselineCoverage: ["waist", "chest"], aliases: ["front"] },
        { id: "root", kind: "root", baselineCoverage: ["shoulders"] },
      ],
      edges: [
        { kind: "part_of", from: "sleeve_left", to: "root" },
        { kind: "part_of", from: "front_panel", to: "root" },
      ],
      behaviors: [{ behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 6 }],
    });
    expect(garmentBlueprintHash(b)).toBe(garmentBlueprintHash(a));
  });

  it("normalization is idempotent and sorts node ids", () => {
    const once = normalizeGarmentBlueprint(shirt());
    expect(normalizeGarmentBlueprint(once)).toEqual(once);
    expect(once.nodes.map((n) => n.id)).toEqual(["front_panel", "root", "sleeve_left"]);
  });

  it("changes when construction changes", () => {
    const base = shirt();
    const withCount = garmentBlueprintSchema.parse({
      ...base,
      behaviors: [{ behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 5 }],
    });
    const withCoverage = garmentBlueprintSchema.parse({
      ...base,
      nodes: base.nodes.map((n) => (n.id === "front_panel" ? { ...n, baselineCoverage: ["chest"] } : n)),
    });
    expect(garmentBlueprintHash(withCount)).not.toBe(garmentBlueprintHash(base));
    expect(garmentBlueprintHash(withCoverage)).not.toBe(garmentBlueprintHash(base));
  });

  it("two instantiations of one template share one hash (F5's dedup premise)", () => {
    const first = garmentTemplateForCategory("top");
    const second = garmentTemplateForCategory("top");
    expect(first && second && garmentBlueprintHash(first)).toBe(second && garmentBlueprintHash(second));
  });

  it("distinct categories hash distinctly", () => {
    const hashes = new Set(
      ["top", "outerwear", "dress", "pants", "skirt", "bra"].map((id) => {
        const template = garmentTemplateForCategory(id);
        expect(template).toBeDefined();
        return template ? garmentBlueprintHash(template) : "";
      }),
    );
    expect(hashes.size).toBe(6);
  });
});
