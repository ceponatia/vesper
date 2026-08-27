import { eq, sql } from "drizzle-orm";
import {
  deriveTriggerId,
  simulationTriggerSchema,
  type SimulationTrigger,
  type TriggerScheduledEvent,
} from "@vesper/simulation-core/contracts/scheduler";
import { simTriggers, type Db } from "@/server/db";

/** The query surface shared by `db()` transactions; the projector runs inside one. */
export type SimTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Projector for a committed trigger_scheduled event. The live command path and
 * fork replay both create trigger rows only through this function, so a
 * pending alarm can never exist that event history does not explain (R1).
 *
 * The target is the branch applying the event, which during fork replay is the
 * child rather than the branch the event was recorded on — the trigger ID and
 * command template routing re-derive from the target structurally.
 */
export async function applyTriggerScheduledEvent(
  tx: SimTx,
  event: TriggerScheduledEvent,
  target: { branchId: string; worldId: string },
): Promise<SimulationTrigger> {
  const [orderRow] = await tx
    .select({ next: sql<number>`coalesce(max(${simTriggers.stableOrder}), 0) + 1` })
    .from(simTriggers)
    .where(eq(simTriggers.branchId, target.branchId));

  const trigger = simulationTriggerSchema.parse({
    id: deriveTriggerId(target.branchId, event.payload.uniquenessKey),
    worldId: target.worldId,
    branchId: target.branchId,
    kind: event.payload.kind,
    schemaVersion: event.payload.triggerSchemaVersion,
    dueStorySecond: event.payload.dueStorySecond,
    priority: event.payload.priority,
    stableOrder: Number(orderRow?.next ?? 1),
    uniquenessKey: event.payload.uniquenessKey,
    payload: { command: { ...event.payload.command, branchId: target.branchId } },
  });
  // A fresh arm is born eligible: `available_at` exists ONLY for retry
  // backoff, which pushes it forward. The column's wall-clock default made a
  // trigger armed MID-DRAIN (a fired alarm arming its successor — sleep
  // arming its own expiry) invisible to the rest of that drain call, whose
  // eligibility clock is captured once at entry — so one long skip silently
  // deferred chained alarms to the NEXT drain, which then stamped their
  // events at a too-late story second. That breaks partition
  // invariance; the Gate 6 exit corpus (EXIT 3) falsified it against the
  // default before this line pinned the epoch.
  await tx.insert(simTriggers).values({ ...trigger, availableAt: new Date(0) });
  return trigger;
}
