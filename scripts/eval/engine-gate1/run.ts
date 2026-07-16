import { performance } from "node:perf_hooks";
import type {
  ItemTransferProjection,
  TransferItemCommand,
} from "@/contracts/simulation/item-transfer";
import { createItemTransferBranchRuntime } from "@/lib/simulation";

const WARMUP_RUNS = 500;
const SAMPLE_RUNS = 4_000;
const P95_BUDGET_MS = 5;

const seed: ItemTransferProjection = {
  worldId: "world_benchmark",
  branchId: "branch_benchmark",
  rulesetVersion: "gate1-v1",
  version: 0,
  headSequence: 0,
  storySecond: 57_600,
  actors: [
    { id: "actor_mara", name: "Mara", observedContainerIds: ["bag", "table"] },
    { id: "actor_theo", name: "Theo", observedContainerIds: ["bag", "table"] },
  ],
  containers: [
    { id: "bag", kind: "container", name: "bag", capacity: 4, accessibleToActorIds: ["actor_mara"] },
    { id: "table", kind: "location", name: "table", capacity: 4, accessibleToActorIds: ["actor_mara"] },
  ],
  items: [{ id: "item_ring", name: "ring", holdingContainerId: "bag" }],
  observations: [],
};

function command(index: number): TransferItemCommand {
  return {
    id: `command_${index}`,
    branchId: seed.branchId,
    expectedVersion: 0,
    idempotencyKey: `idempotency_${index}`,
    principal: { kind: "npc_policy", principalId: "policy_mara", controlledActorIds: ["actor_mara"] },
    submittedAtWallClock: "2026-07-16T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 1,
    correlationId: `correlation_${index}`,
    payload: {
      actorId: "actor_mara",
      itemId: "item_ring",
      fromContainerId: "bag",
      toContainerId: "table",
    },
  };
}

function runOnce(index: number): number {
  const start = performance.now();
  const runtime = createItemTransferBranchRuntime(seed);
  const result = runtime.submit(command(index));
  if (result.status !== "accepted") throw new Error(`Benchmark command was ${result.status}`);
  runtime.compileNarrativeCut("actor_theo");
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
