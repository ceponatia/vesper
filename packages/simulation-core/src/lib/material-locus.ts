import type { ItemLocus, SimulationMaterialItem } from "../contracts/materials";

/**
 * Root-locus resolution and the authority-view contract (§26.1–26.2),
 * factored out of `materials.ts` so `material-condition.ts` (§26.7) can reuse
 * them without materials.ts importing material-condition.ts back — a
 * materials.ts → material-condition.ts → materials.ts cycle is exactly what
 * `pnpm lint:cycles` (madge) exists to catch. Both `materials.ts`'s transfer/
 * destroy/consume resolvers and `material-condition.ts`'s
 * `resolveApplyItemConditionSource` depend on this file; neither depends on
 * the other.
 */

/** Bounded holding-chain walk (§26.1): at most this many container hops resolve. */
export const MATERIAL_CHAIN_DEPTH_CAP = 8;

/**
 * A holding chain's root: an actor (held/worn, directly or through their
 * containers), a zone, `gone`, or `cycle` — the last standing in for both a
 * true cycle and a walk that overran the depth cap or dangled off a missing
 * container. A dangling reference fails closed as unresolvable, never as a root.
 */
export type RootLocus =
  | { kind: "actor"; actorId: string }
  | { kind: "zone"; zoneId: string }
  | { kind: "gone" }
  | { kind: "cycle" };

export function resolveRootLocus(
  locus: ItemLocus,
  itemById: (itemId: string) => SimulationMaterialItem | undefined,
  depthCap: number = MATERIAL_CHAIN_DEPTH_CAP,
): RootLocus {
  let current: ItemLocus = locus;
  const seen = new Set<string>();
  for (let hops = 0; hops <= depthCap; hops += 1) {
    switch (current.kind) {
      case "held":
        return { kind: "actor", actorId: current.actorId };
      case "worn":
        return { kind: "actor", actorId: current.actorId };
      case "zone":
        return { kind: "zone", zoneId: current.zoneId };
      case "gone":
        return { kind: "gone" };
      case "container": {
        if (hops >= depthCap) return { kind: "cycle" };
        if (seen.has(current.containerItemId)) return { kind: "cycle" };
        seen.add(current.containerItemId);
        const container = itemById(current.containerItemId);
        if (!container) return { kind: "cycle" };
        current = container.locus;
        break;
      }
    }
  }
  return { kind: "cycle" };
}

/**
 * The minimum authoritative facts a material command needs. Persistent adapters
 * load this under the branch lock instead of hydrating every item in the world;
 * a resolver reads only through these accessors so both paths run one resolver.
 */
export interface MaterialResolutionView {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  version: number;
  headSequence: number;
  storySecond: number;
  /** Identity of an actor, or undefined if the branch has no such actor. */
  actorById(actorId: string): { id: string; name: string } | undefined;
  /** The actor's current zone (§13.2 physical locus), or null if not embodied. */
  actorZoneId(actorId: string): string | null;
  /** The location containing the actor's current zone; for the event envelope. */
  actorLocationId(actorId: string): string | null;
  /** The item with its current locus, container config, and owner, or undefined. */
  itemById(itemId: string): SimulationMaterialItem | undefined;
  /** Count of items whose IMMEDIATE locus is this container (§26.2 capacity). */
  containerOccupantCount(containerItemId: string): number;
  /**
   * The live claim-holding-phase activity currently reserving this item
   * (§26.5), or null. A reserved item is untouchable by every command-driven
   * material path (transfer, destroy, consume) — only the reserving
   * activity's own completion/interruption machinery may move it.
   */
  reservingActivityId(itemId: string): string | null;
}

/** The root's zone, for co-location checks. */
export function rootZoneId(root: RootLocus, view: MaterialResolutionView): string | null {
  if (root.kind === "actor") return view.actorZoneId(root.actorId);
  if (root.kind === "zone") return root.zoneId;
  return null;
}

/** Fail-closed §26.2 access check on the immediate container at a transfer end. */
export function containerAccessAllowed(
  view: MaterialResolutionView,
  containerItemId: string,
  actingActorId: string,
): boolean {
  const container = view.itemById(containerItemId);
  if (!container?.container) return false;
  const access = container.container.access;
  switch (access.kind) {
    case "open":
      // Root co-location was already established, which is all `open` requires.
      return true;
    case "holder_only": {
      const root = resolveRootLocus(container.locus, view.itemById);
      return root.kind === "actor" && root.actorId === actingActorId;
    }
    case "allow_list":
      return access.actorIds.includes(actingActorId as never);
  }
}
