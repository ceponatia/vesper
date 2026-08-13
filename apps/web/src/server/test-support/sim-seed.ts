import {
  materialBranchSeedSchema,
  type MaterialBranchSeedInput,
} from "@vesper/simulation-core/contracts/materials";
import { newId } from "@/lib/ids";
import { seedDurableMaterialBranch, seedDurableSpaceTopology, type SpaceTopologySeed } from "@/server/engine";

/**
 * Branch + topology seeding for the durable-simulation integration suites.
 *
 * Roughly 25 suites carried their own `branchSeed()` / `topologySeed()` /
 * `seedCase()` trio — the same two production seeders called with the same
 * scaffolding and a different world-type string. The copies encoded the same
 * conventions by hand every time (world seed `seed-<worldId>`, location ids
 * `<worldId>-loc-*`, zone ids `<branchId>-zone-*`, every actor placed with an
 * `at` locus stamped `since: originStorySecond`), so a convention change meant
 * 25 edits. Both seeders stay production code; this only removes the copies.
 *
 * NOTE the two id namespaces, which the copies got right and are easy to get
 * wrong: LOCATIONS are world-scoped (`<worldId>-loc-…`) because a fork inherits
 * them, ZONES are branch-scoped (`<branchId>-zone-…`).
 *
 * Both seeders come through the `@/server/engine` barrel (the deep alias
 * `@/server/engine/simulation` is banned by eslint's module-boundary rule). That
 * is only safe because production no longer imports test-support: the legacy
 * player-mode flags the authorization seam reads moved into the engine's own
 * `legacy-test-mode.ts`, so test-support → engine is a one-way edge.
 */

/** What every seed helper hands back — the two ids the suite tracks for teardown. */
export interface SeededSimBranch {
  worldId: string;
  branchId: string;
}

type SimLocationSeed = SpaceTopologySeed["locations"][number];
type SimZoneSeed = SpaceTopologySeed["zones"][number];

/** Where one actor starts. Turned into an `{ kind: "at", … }` locus at the origin second. */
export interface SimActorPlacement {
  actorId: string;
  locationId: string;
  zoneId: string;
}

export interface SeedSimBranchInput {
  worldTypeId: string;
  rulesetVersion: string;
  originStorySecond: number;
  actors: readonly { id: string; name: string }[];
  items?: MaterialBranchSeedInput["items"];
  locations: SpaceTopologySeed["locations"];
  zones: SpaceTopologySeed["zones"];
  /** Default `[]` — most suites test a single location and never travel. */
  links?: SpaceTopologySeed["links"];
  placements: readonly SimActorPlacement[];
  /** Minted when absent. Pass an existing id to seed a SECOND branch into one world. */
  worldId?: string;
  branchId?: string;
  /** Default `seed-<worldId>`; determinism suites that pin a literal seed override it. */
  worldSeed?: string;
  worldStatus?: MaterialBranchSeedInput["worldStatus"];
  permitsTrespass?: boolean;
}

/**
 * Seed one branch's material projection and its space topology, in that order —
 * a space seed must land before the branch's first event and every locus actor
 * must already exist in the branch's character registry, which is exactly what
 * the material seed writes.
 */
export async function seedSimBranch(input: SeedSimBranchInput): Promise<SeededSimBranch> {
  const worldId = input.worldId ?? newId();
  const branchId = input.branchId ?? newId();

  // Parse first: a malformed fixture then fails with the contract's own message
  // instead of a constraint violation three statements deeper.
  const seed = materialBranchSeedSchema.parse({
    worldId,
    worldTypeId: input.worldTypeId,
    worldSeed: input.worldSeed ?? `seed-${worldId}`,
    ...(input.worldStatus === undefined ? {} : { worldStatus: input.worldStatus }),
    ...(input.permitsTrespass === undefined ? {} : { permitsTrespass: input.permitsTrespass }),
    branchId,
    rulesetVersion: input.rulesetVersion,
    originStorySecond: input.originStorySecond,
    actors: [...input.actors],
    items: input.items === undefined ? [] : [...input.items],
  });
  await seedDurableMaterialBranch(seed);

  await seedDurableSpaceTopology({
    branchId,
    locations: [...input.locations],
    zones: [...input.zones],
    links: input.links === undefined ? [] : [...input.links],
    loci: input.placements.map((placement) => ({
      kind: "at" as const,
      actorId: placement.actorId,
      locationId: placement.locationId,
      zoneId: placement.zoneId,
      since: input.originStorySecond,
    })),
  });

  return { worldId, branchId };
}

/** The simple case's ids: one location holding one zone, with everybody in it. */
export interface SimpleBranchIds extends SeededSimBranch {
  locationId: string;
  zoneId: string;
}

export interface SeedSimpleBranchInput {
  /**
   * Suite slug, e.g. `"e6-2-test"` — expands to worldTypeId `<prefix>-world` and
   * rulesetVersion `<prefix>-v1`, the shape every copied fixture already used.
   */
  prefix: string;
  actors: readonly { id: string; name: string }[];
  originStorySecond: number;
  items?: MaterialBranchSeedInput["items"];
  worldId?: string;
  branchId?: string;
  /** Pin the deterministic world seed — defaults to `seed-<worldId>`. */
  worldSeed?: string;
  /** Suffixes for the two derived ids — override when a test asserts on them. */
  locationSlug?: string;
  zoneSlug?: string;
  locationKind?: SimLocationSeed["kind"];
  zoneKind?: SimZoneSeed["kind"];
  defaultAccessPolicy?: SimLocationSeed["defaultAccessPolicy"];
  privacyPolicy?: SimZoneSeed["privacyPolicy"];
}

/**
 * The shape the large majority of durable suites actually seed: ONE location,
 * ONE zone inside it, every actor standing there, no links. A one-liner:
 *
 * ```ts
 * const ids = await seedSimpleBranch({ prefix: "e6-2-test", actors, originStorySecond: SEED_SECOND });
 * ```
 *
 * Reach for `seedSimBranch` the moment a case needs a second location (the
 * "never witnessed" negative control needs a different LOCATION, not merely a
 * different zone — cross-zone sound inside one location still reaches an
 * occupant) or a travel link.
 */
export async function seedSimpleBranch(input: SeedSimpleBranchInput): Promise<SimpleBranchIds> {
  const worldId = input.worldId ?? newId();
  const branchId = input.branchId ?? newId();
  const locationId = `${worldId}-loc-${input.locationSlug ?? "home"}`;
  const zoneId = `${branchId}-zone-${input.zoneSlug ?? "home"}`;

  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: `${input.prefix}-world`,
    rulesetVersion: `${input.prefix}-v1`,
    originStorySecond: input.originStorySecond,
    actors: input.actors,
    ...(input.items === undefined ? {} : { items: input.items }),
    ...(input.worldSeed === undefined ? {} : { worldSeed: input.worldSeed }),
    locations: [
      {
        id: locationId,
        worldId,
        kind: input.locationKind ?? "home",
        defaultAccessPolicy: input.defaultAccessPolicy ?? "public",
      },
    ],
    zones: [
      {
        id: zoneId,
        locationId,
        kind: input.zoneKind ?? "room",
        privacyPolicy: input.privacyPolicy ?? "public",
      },
    ],
    links: [],
    placements: input.actors.map((actor) => ({ actorId: actor.id, locationId, zoneId })),
  });

  return { worldId, branchId, locationId, zoneId };
}
