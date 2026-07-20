import { performance } from "node:perf_hooks";
import {
  transferItemCommandSchema,
  type TransferItemCommand,
} from "@/contracts/simulation/materials";
import {
  applyMaterialEvent,
  materialsSeedProjection,
  resolveTransferItemFromView,
  type MaterialResolutionView,
} from "@/lib/simulation";

const WARMUP_RUNS = 500;
const SAMPLE_RUNS = 4_000;
const P95_BUDGET_MS = 5;

/**
 * The Gate 1 exit benchmark, ported to the E5.3 material lane: the whole
 * deterministic command path (authority view -> §26.4 resolution -> event ->
 * projection fold) must hold its p95 budget with zero model calls.
 */
const seed = materialsSeedProjection({
  worldId: "world_benchmark",
  worldTypeId: "world_type_benchmark",
  worldSeed: "benchmark-seed",
  branchId: "branch_benchmark",
  rulesetVersion: "gate1-v1",
  originStorySecond: 57_600,
  actors: [
    { id: "actor_mara", name: "Mara" },
    { id: "actor_theo", name: "Theo" },
  ],
  items: [
    {
      id: "bag",
      name: "bag",
      container: { capacityCount: 4, access: { kind: "open" } },
      locus: { kind: "held", actorId: "actor_mara" },
    },
    { id: "item_ring", name: "ring", locus: { kind: "container", containerItemId: "bag" } },
  ],
});

const BENCH_ZONE = "zone_benchmark";
const BENCH_LOCATION = "location_benchmark";

/** In-memory stand-in for the store's lock-consistent view: everyone in one zone. */
function viewOf(projection: typeof seed): MaterialResolutionView {
  const actors = new Map<string, (typeof projection.actors)[number]>(
    projection.actors.map((actor) => [actor.id, actor]),
  );
  const items = new Map<string, (typeof projection.items)[number]>(
    projection.items.map((item) => [item.id, item]),
  );
  return {
    worldId: projection.worldId,
    branchId: projection.branchId,
    rulesetVersion: projection.rulesetVersion,
    version: projection.version,
    headSequence: projection.headSequence,
    storySecond: projection.storySecond,
    actorById: (actorId) => actors.get(actorId),
    actorZoneId: (actorId) => (actors.has(actorId) ? BENCH_ZONE : null),
    actorLocationId: (actorId) => (actors.has(actorId) ? BENCH_LOCATION : null),
    itemById: (itemId) => items.get(itemId),
    containerOccupantCount: (containerItemId) =>
      projection.items.filter(
        (item) => item.locus.kind === "container" && item.locus.containerItemId === containerItemId,
      ).length,
    reservingActivityId: () => null,
  };
}

function command(index: number): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: `command_${index}`,
    branchId: seed.branchId,
    expectedVersion: 0,
    idempotencyKey: `idempotency_${index}`,
    principal: { kind: "npc_policy", principalId: "policy_mara", controlledActorIds: ["actor_mara"] },
    submittedAtWallClock: "2026-07-16T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: `correlation_${index}`,
    payload: {
      actorId: "actor_mara",
      itemId: "item_ring",
      fromLocus: { kind: "container", containerItemId: "bag" },
      toLocus: { kind: "zone", zoneId: BENCH_ZONE },
    },
  });
}

function runOnce(index: number): number {
  const start = performance.now();
  const resolution = resolveTransferItemFromView(viewOf(seed), command(index));
  if (!resolution.ok) throw new Error(`Benchmark command was rejected: ${resolution.code}`);
  for (const event of resolution.events) applyMaterialEvent(seed, event);
  return performance.now() - start;
}

for (let index = 0; index < WARMUP_RUNS; index += 1) runOnce(index);
const samples = Array.from({ length: SAMPLE_RUNS }, (_, index) => runOnce(index + WARMUP_RUNS)).sort(
  (left, right) => left - right,
);
const percentile = (ratio: number): number => samples[Math.ceil(samples.length * ratio) - 1] ?? Number.NaN;
const result = {
  budgetMs: P95_BUDGET_MS,
  sampleRuns: SAMPLE_RUNS,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  maxMs: samples.at(-1) ?? Number.NaN,
  modelCalls: 0,
};

console.log(JSON.stringify(result, null, 2));
if (result.p95Ms > P95_BUDGET_MS) {
  throw new Error(`Gate 1 p95 ${result.p95Ms.toFixed(3)} ms exceeds ${P95_BUDGET_MS.toFixed(1)} ms budget`);
}
