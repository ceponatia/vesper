import { parseOr } from "@/lib/parse";
import { diag, type Diagnostic, type DiagnosticSink } from "../diagnostics";
import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";
import { isGarmentMaterialProfileId } from "./garment-material";
import {
  degradedGarmentBlueprint,
  garmentBlueprintSchema,
  GARMENT_BEHAVIOR_NODE_KINDS,
  GARMENT_FASTENER_COUNT_MAX,
  GARMENT_FASTENER_COUNT_MIN,
  GARMENT_FASTENER_SERIES_BEHAVIORS,
  type GarmentBlueprint,
} from "./garment-blueprint";

/**
 * Blueprint structural validation (clothing-state-graph.plan.md §"Definitions
 * are not instances"; slice-0 audit OQ1/OQ6). Returns typed issues with STABLE
 * codes and NEVER throws — a bad graph degrades to the conservative root-only
 * default and records a diagnostic (docs/resilience.md §§1–2).
 */

export const garmentBlueprintIssueCodes = [
  /** No nodes at all. */
  "garment_blueprint.empty",
  /** `rootNodeId` names no node. */
  "garment_blueprint.root_missing",
  /** The node named by `rootNodeId` is not `kind: "root"`. */
  "garment_blueprint.root_kind",
  /** More than one node claims `kind: "root"`. */
  "garment_blueprint.multiple_roots",
  "garment_blueprint.duplicate_node_id",
  /** An edge names a node id that does not exist. */
  "garment_blueprint.edge_endpoint_unknown",
  /** A `part_of` edge leaves the root — the root is owned by nothing. */
  "garment_blueprint.root_has_parent",
  /** A non-root node has no `part_of` edge. */
  "garment_blueprint.part_of_missing",
  /** A node has more than one `part_of` edge (ownership must be unique). */
  "garment_blueprint.part_of_multiple_parents",
  "garment_blueprint.part_of_cycle",
  /** A node the root cannot reach through `part_of`. */
  "garment_blueprint.part_of_unreachable",
  "garment_blueprint.unknown_body_location",
  "garment_blueprint.unknown_material",
  /** A behavior binds to a node id that does not exist. */
  "garment_blueprint.behavior_node_unknown",
  /** A behavior binds to a node kind it is not legal on. */
  "garment_blueprint.behavior_kind_illegal",
  /** Two behaviors bind to the same node. */
  "garment_blueprint.behavior_duplicate",
  "garment_blueprint.fastener_count_missing",
  "garment_blueprint.fastener_count_out_of_range",
  /** A `fastenerCount` on a behavior whose channel is continuous. */
  "garment_blueprint.fastener_count_unsupported",
] as const;
export type GarmentBlueprintIssueCode = (typeof garmentBlueprintIssueCodes)[number];

export interface GarmentBlueprintIssue {
  code: GarmentBlueprintIssueCode;
  message: string;
  /** The part id the issue is about, when it has one. */
  partId?: string;
}

export interface GarmentBlueprintValidation {
  ok: boolean;
  issues: readonly GarmentBlueprintIssue[];
}

/**
 * Validate a parsed blueprint. Pure, total, allocation-light: every rule the
 * plan names (one root · acyclic `part_of` reaching every node · known edge
 * endpoints · unique node ids · registry-valid body/material ids · legal
 * behavior bindings · closure fastener-count bounds) reports its own code, and
 * all rules run so authoring surfaces see every problem at once.
 */
export function validateGarmentBlueprint(
  blueprint: GarmentBlueprint,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): GarmentBlueprintValidation {
  const issues: GarmentBlueprintIssue[] = [];
  const add = (code: GarmentBlueprintIssueCode, message: string, partId?: string): void => {
    issues.push(partId === undefined ? { code, message } : { code, message, partId });
  };

  // --- nodes ---
  const byId = new Map<string, (typeof blueprint.nodes)[number]>();
  for (const node of blueprint.nodes) {
    if (byId.has(node.id)) {
      add("garment_blueprint.duplicate_node_id", `duplicate part id "${node.id}"`, node.id);
      continue;
    }
    byId.set(node.id, node);
  }
  if (blueprint.nodes.length === 0) add("garment_blueprint.empty", "blueprint has no parts");

  const root = byId.get(blueprint.rootNodeId);
  if (!root) {
    add("garment_blueprint.root_missing", `rootNodeId "${blueprint.rootNodeId}" names no part`, blueprint.rootNodeId);
  } else if (root.kind !== "root") {
    add("garment_blueprint.root_kind", `root part "${root.id}" has kind "${root.kind}"`, root.id);
  }
  const rootKinded = blueprint.nodes.filter((node) => node.kind === "root");
  if (rootKinded.length > 1) {
    add("garment_blueprint.multiple_roots", `${rootKinded.length} parts claim kind "root"`);
  }

  for (const node of byId.values()) {
    if (!isGarmentMaterialProfileId(node.materialProfileId)) {
      add(
        "garment_blueprint.unknown_material",
        `part "${node.id}" has unknown material "${node.materialProfileId}"`,
        node.id,
      );
    }
    for (const location of node.baselineCoverage) {
      const known = registry.byId(location);
      // Non-coverage-relevant ids (the intimate/feature sub-trees) are never
      // STORED coverage — items/coverage.ts drops them on the same rule.
      if (!known || known.coverageRelevant === false) {
        add(
          "garment_blueprint.unknown_body_location",
          `part "${node.id}" covers "${location}", which is not a coverage-relevant body location`,
          node.id,
        );
      }
    }
  }

  // --- edges ---
  const parents = new Map<string, string[]>();
  for (const edge of blueprint.edges) {
    const endpoints = edge.kind === "fastens" ? [edge.from, ...edge.targets] : [edge.from, edge.to];
    let endpointsKnown = true;
    for (const endpoint of endpoints) {
      if (byId.has(endpoint)) continue;
      endpointsKnown = false;
      add(
        "garment_blueprint.edge_endpoint_unknown",
        `${edge.kind} edge references unknown part "${endpoint}"`,
        endpoint,
      );
    }
    if (!endpointsKnown || edge.kind !== "part_of") continue;
    if (edge.from === blueprint.rootNodeId) {
      add("garment_blueprint.root_has_parent", `the root part "${edge.from}" cannot be part_of anything`, edge.from);
      continue;
    }
    const list = parents.get(edge.from) ?? [];
    list.push(edge.to);
    parents.set(edge.from, list);
  }

  for (const node of byId.values()) {
    if (node.id === blueprint.rootNodeId) continue;
    const list = parents.get(node.id) ?? [];
    if (list.length === 0) {
      add("garment_blueprint.part_of_missing", `part "${node.id}" has no part_of edge`, node.id);
    } else if (list.length > 1) {
      add(
        "garment_blueprint.part_of_multiple_parents",
        `part "${node.id}" is part_of ${list.length} parts`,
        node.id,
      );
    }
  }

  // Cycle detection walks each node's parent chain; a chain that revisits a node
  // (or never lands on the root) before running out is a cycle.
  const cyclic = new Set<string>();
  for (const node of byId.values()) {
    const seen = new Set<string>([node.id]);
    let current: string | undefined = parents.get(node.id)?.[0];
    while (current !== undefined) {
      if (seen.has(current)) {
        cyclic.add(node.id);
        break;
      }
      seen.add(current);
      current = parents.get(current)?.[0];
    }
  }
  for (const partId of cyclic) {
    add("garment_blueprint.part_of_cycle", `part "${partId}" sits on a part_of cycle`, partId);
  }

  // Reachability from the root through part_of (child → parent, so walk the
  // inverted index).
  if (root) {
    const children = new Map<string, string[]>();
    for (const [child, list] of parents) {
      for (const parent of list) {
        const siblings = children.get(parent) ?? [];
        siblings.push(child);
        children.set(parent, siblings);
      }
    }
    const reached = new Set<string>([root.id]);
    const queue = [root.id];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      for (const child of children.get(current) ?? []) {
        if (reached.has(child)) continue;
        reached.add(child);
        queue.push(child);
      }
    }
    for (const node of byId.values()) {
      if (reached.has(node.id) || cyclic.has(node.id)) continue;
      add("garment_blueprint.part_of_unreachable", `part "${node.id}" is unreachable from the root`, node.id);
    }
  }

  // --- behaviors ---
  const boundParts = new Set<string>();
  for (const binding of blueprint.behaviors) {
    const node = byId.get(binding.partId);
    if (!node) {
      add(
        "garment_blueprint.behavior_node_unknown",
        `behavior "${binding.behavior}" binds to unknown part "${binding.partId}"`,
        binding.partId,
      );
      continue;
    }
    if (boundParts.has(binding.partId)) {
      add(
        "garment_blueprint.behavior_duplicate",
        `part "${binding.partId}" already carries a behavior`,
        binding.partId,
      );
    }
    boundParts.add(binding.partId);

    const legalKinds = GARMENT_BEHAVIOR_NODE_KINDS[binding.behavior];
    if (!legalKinds.includes(node.kind)) {
      add(
        "garment_blueprint.behavior_kind_illegal",
        `behavior "${binding.behavior}" is not legal on a "${node.kind}" part`,
        node.id,
      );
    }

    const series = GARMENT_FASTENER_SERIES_BEHAVIORS.includes(binding.behavior);
    if (series && binding.fastenerCount === undefined) {
      add(
        "garment_blueprint.fastener_count_missing",
        `behavior "${binding.behavior}" on "${binding.partId}" needs a fastenerCount`,
        binding.partId,
      );
    } else if (!series && binding.fastenerCount !== undefined) {
      add(
        "garment_blueprint.fastener_count_unsupported",
        `behavior "${binding.behavior}" has a continuous channel — fastenerCount is meaningless`,
        binding.partId,
      );
    } else if (
      binding.fastenerCount !== undefined &&
      (binding.fastenerCount < GARMENT_FASTENER_COUNT_MIN || binding.fastenerCount > GARMENT_FASTENER_COUNT_MAX)
    ) {
      add(
        "garment_blueprint.fastener_count_out_of_range",
        `fastenerCount ${binding.fastenerCount} is outside ${GARMENT_FASTENER_COUNT_MIN}–${GARMENT_FASTENER_COUNT_MAX}`,
        binding.partId,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Validation issues as persistable diagnostics (the codes ARE the stable codes). */
export function garmentBlueprintDiagnostics(
  validation: GarmentBlueprintValidation,
  path?: string,
): Diagnostic[] {
  return validation.issues.map((issue) =>
    diag("warn", issue.code, issue.message, {
      path,
      ...(issue.partId === undefined ? {} : { context: { partId: issue.partId } }),
    }),
  );
}

/**
 * The trust-boundary read: parse a raw blueprint (JSONB column, LLM proposal,
 * request body) and validate it. A parse failure OR any structural issue
 * degrades to `degradedGarmentBlueprint()` — a valid, coverage-free, behavior-
 * free root — and pushes diagnostics. Never throws.
 */
export function parseGarmentBlueprint(
  raw: unknown,
  sink?: DiagnosticSink,
  path = "garment.blueprint",
): GarmentBlueprint {
  const fallback = degradedGarmentBlueprint();
  const parsed = parseOr(garmentBlueprintSchema, raw, fallback, sink, path);
  const validation = validateGarmentBlueprint(parsed);
  if (validation.ok) return parsed;
  if (sink) for (const diagnostic of garmentBlueprintDiagnostics(validation, path)) sink.push(diagnostic);
  return fallback;
}
