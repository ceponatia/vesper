import { describe, expect, it } from "vitest";
import { garmentBlueprintSchema, type GarmentBlueprint } from "./garment-blueprint";
import {
  garmentBlueprintDiagnostics,
  validateGarmentBlueprint,
  type GarmentBlueprintIssueCode,
} from "./garment-blueprint-validation";

/** A minimal VALID graph every rejection case mutates one field of. */
function base(): GarmentBlueprint {
  return garmentBlueprintSchema.parse({
    rootNodeId: "root",
    nodes: [
      { id: "root", kind: "root", baselineCoverage: ["shoulders"] },
      { id: "front_panel", kind: "panel", baselineCoverage: ["chest", "waist"] },
      { id: "sleeve_left", kind: "sleeve", side: "left", baselineCoverage: ["upper_arms", "forearms"] },
    ],
    edges: [
      { kind: "part_of", from: "front_panel", to: "root" },
      { kind: "part_of", from: "sleeve_left", to: "root" },
    ],
    behaviors: [
      { behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 6 },
      { behavior: "rollable_sleeve", partId: "sleeve_left" },
    ],
  });
}

function codes(blueprint: GarmentBlueprint): GarmentBlueprintIssueCode[] {
  return validateGarmentBlueprint(blueprint).issues.map((issue) => issue.code);
}

describe("garment blueprint validator — accept", () => {
  it("accepts the minimal valid graph", () => {
    const result = validateGarmentBlueprint(base());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts non-tree typed edges that cross the part_of spine", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      edges: [
        ...base().edges,
        { kind: "mirrors", from: "sleeve_left", to: "front_panel" },
        { kind: "constrains", from: "front_panel", to: "sleeve_left" },
        { kind: "fastens", from: "front_panel", targets: ["sleeve_left"] },
      ],
    });
    expect(codes(blueprint)).toEqual([]);
  });
});

describe("garment blueprint validator — one root", () => {
  it("rejects a rootNodeId that names no part", () => {
    const blueprint = garmentBlueprintSchema.parse({ ...base(), rootNodeId: "torso" });
    expect(codes(blueprint)).toContain("garment_blueprint.root_missing");
  });

  it("rejects a root node whose kind is not root", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      nodes: base().nodes.map((n) => (n.id === "root" ? { ...n, kind: "panel" } : n)),
    });
    expect(codes(blueprint)).toContain("garment_blueprint.root_kind");
  });

  it("rejects a second node claiming kind root", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      nodes: base().nodes.map((n) => (n.id === "front_panel" ? { ...n, kind: "root" } : n)),
    });
    expect(codes(blueprint)).toContain("garment_blueprint.multiple_roots");
  });

  it("rejects an empty graph", () => {
    const blueprint = garmentBlueprintSchema.parse({ nodes: [], edges: [], behaviors: [] });
    expect(codes(blueprint)).toContain("garment_blueprint.empty");
  });
});

describe("garment blueprint validator — ids and edges", () => {
  it("rejects duplicate node ids", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      nodes: [...base().nodes, { id: "front_panel", kind: "panel" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.duplicate_node_id");
  });

  it("rejects an edge endpoint that names no part", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      edges: [...base().edges, { kind: "mirrors", from: "sleeve_left", to: "sleeve_right" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.edge_endpoint_unknown");
  });

  it("rejects an unknown target inside a fastens edge", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      edges: [...base().edges, { kind: "fastens", from: "front_panel", targets: ["placket"] }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.edge_endpoint_unknown");
  });
});

describe("garment blueprint validator — part_of spine", () => {
  it("rejects a non-root node with no parent", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      edges: [{ kind: "part_of", from: "front_panel", to: "root" }],
    });
    const found = codes(blueprint);
    expect(found).toContain("garment_blueprint.part_of_missing");
    expect(found).toContain("garment_blueprint.part_of_unreachable");
  });

  it("rejects two owners for one part", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      edges: [...base().edges, { kind: "part_of", from: "sleeve_left", to: "front_panel" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.part_of_multiple_parents");
  });

  it("rejects a part_of edge leaving the root", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      edges: [...base().edges, { kind: "part_of", from: "root", to: "front_panel" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.root_has_parent");
  });

  it("rejects a part_of cycle", () => {
    const blueprint = garmentBlueprintSchema.parse({
      rootNodeId: "root",
      nodes: [
        { id: "root", kind: "root" },
        { id: "a", kind: "panel" },
        { id: "b", kind: "panel" },
      ],
      edges: [
        { kind: "part_of", from: "a", to: "b" },
        { kind: "part_of", from: "b", to: "a" },
      ],
      behaviors: [],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.part_of_cycle");
  });

  it("rejects a subtree the root cannot reach", () => {
    const blueprint = garmentBlueprintSchema.parse({
      rootNodeId: "root",
      nodes: [
        { id: "root", kind: "root" },
        { id: "a", kind: "panel" },
        { id: "b", kind: "panel" },
      ],
      edges: [{ kind: "part_of", from: "b", to: "a" }],
      behaviors: [],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.part_of_unreachable");
  });
});

describe("garment blueprint validator — registry ids", () => {
  it("rejects an unregistered body location", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      nodes: base().nodes.map((n) => (n.id === "front_panel" ? { ...n, baselineCoverage: ["midriff"] } : n)),
    });
    expect(codes(blueprint)).toContain("garment_blueprint.unknown_body_location");
  });

  it("rejects a non-coverage-relevant body location", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      nodes: base().nodes.map((n) => (n.id === "front_panel" ? { ...n, baselineCoverage: ["nipples"] } : n)),
    });
    expect(codes(blueprint)).toContain("garment_blueprint.unknown_body_location");
  });

  it("rejects an unregistered material (only reachable past the schema catch)", () => {
    const blueprint: GarmentBlueprint = {
      ...base(),
      nodes: base().nodes.map((n) =>
        n.id === "front_panel" ? { ...n, materialProfileId: "burlap" as never } : n,
      ),
    };
    expect(codes(blueprint)).toContain("garment_blueprint.unknown_material");
  });
});

describe("garment blueprint validator — behavior bindings", () => {
  it("rejects a behavior on an unknown part", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      behaviors: [...base().behaviors, { behavior: "rollable_sleeve", partId: "sleeve_right" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.behavior_node_unknown");
  });

  it("rejects rollable_sleeve on a node that is not a sleeve or cuff", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      behaviors: [{ behavior: "rollable_sleeve", partId: "front_panel" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.behavior_kind_illegal");
  });

  it("rejects adjustable_strap on a sleeve", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      behaviors: [{ behavior: "adjustable_strap", partId: "sleeve_left" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.behavior_kind_illegal");
  });

  it("rejects two behaviors on one part", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      behaviors: [...base().behaviors, { behavior: "rollable_sleeve", partId: "sleeve_left" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.behavior_duplicate");
  });
});

describe("garment blueprint validator — fastener count bounds", () => {
  it("rejects a fastener-series behavior with no count", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      behaviors: [{ behavior: "linear_front_closure", partId: "front_panel" }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.fastener_count_missing");
  });

  it("rejects a count on a continuous-channel behavior", () => {
    const blueprint = garmentBlueprintSchema.parse({
      ...base(),
      behaviors: [{ behavior: "zipper_closure", partId: "front_panel", fastenerCount: 4 }],
    });
    expect(codes(blueprint)).toContain("garment_blueprint.fastener_count_unsupported");
  });

  it("rejects an out-of-range count (only reachable past the schema bound)", () => {
    const blueprint: GarmentBlueprint = {
      ...base(),
      behaviors: [{ behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 99 }],
    };
    expect(codes(blueprint)).toContain("garment_blueprint.fastener_count_out_of_range");
  });

  it("accepts the bounds themselves", () => {
    for (const fastenerCount of [1, 24]) {
      const blueprint = garmentBlueprintSchema.parse({
        ...base(),
        behaviors: [{ behavior: "linear_front_closure", partId: "front_panel", fastenerCount }],
      });
      expect(codes(blueprint)).toEqual([]);
    }
  });
});

describe("garment blueprint diagnostics", () => {
  it("renders issues as diagnostics carrying the stable code and the part", () => {
    const blueprint = garmentBlueprintSchema.parse({ ...base(), rootNodeId: "torso" });
    const diagnostics = garmentBlueprintDiagnostics(validateGarmentBlueprint(blueprint), "chat.garments");
    expect(diagnostics[0]?.code).toBe("garment_blueprint.root_missing");
    expect(diagnostics[0]?.severity).toBe("warn");
    expect(diagnostics[0]?.path).toBe("chat.garments");
    expect(diagnostics[0]?.context?.partId).toBe("torso");
  });

  it("returns nothing for a clean blueprint", () => {
    expect(garmentBlueprintDiagnostics(validateGarmentBlueprint(base()))).toEqual([]);
  });
});
