import { and, eq, or } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { transferItemCommandSchema, type TransferItemCommand } from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import { escalateToTimeJob, runDueTimeJobs, runSkipWithEscalation } from "@/server/engine";
import { db, simTimeJobs } from "@/server/db";
import { seedSimpleBranch, simCommand, simulationSuiteHarness, systemPrincipal } from "@/server/test-support";
import { scheduleDurableTrigger } from "./scheduler-store";
import {
  claimDueTimeJob,
  enqueueTimeJob,
  hasActiveTimeJob,
  readTimeJobForChat,
  runClaimedTimeJob,
} from "./time-job-store";

/**
 * Concurrency validation for the durable time-job store (drain-hardening A5 slice 4). These are
 * the tests that had to run against a real Postgres — the whole point of building this slice with
 * a DB up: the partial unique index (one active job per branch), the lease/fence (a stale worker
 * can't overwrite live work), reclaim-after-expiry, and the drain-to-completion outcome.
 *
 * Probe, per-test world sweep (`cleanup: "afterEach"` — these cases would
 * otherwise pile up rows) and the pool close come from `simulationSuiteHarness`.
 * `legacyPlayerMode: false`: every command here is scheduler/system-authored, so
 * this suite must keep running without the aggregate-run opt-in flag.
 */

const SEED_STORY_SECOND = 57_600;

const harness = await simulationSuiteHarness({
  suite: "time-job-store.int.test",
  table: "sim_time_jobs",
  legacyPlayerMode: false,
  cleanup: "afterEach",
});
const ready = harness.ready;

interface CaseIds {
  worldId: string;
  branchId: string;
  chatId: string;
  actorId: string;
  locationId: string;
  zoneId: string;
  sourceId: string;
  destinationId: string;
  itemIds: string[];
}

function makeIds(itemCount = 1): CaseIds {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    chatId: newId(),
    actorId: newId(),
    locationId: `${worldId}-loc-cafe`,
    zoneId: `${branchId}-zone-hall`,
    sourceId: newId(),
    destinationId: newId(),
    itemIds: Array.from({ length: itemCount }, () => newId()),
  };
}

/** Mara in a cafe hall, holding a bag and a table, with the loose items in the bag. */
async function seedCase(ids: CaseIds): Promise<void> {
  harness.trackWorld(ids.worldId);
  await seedSimpleBranch({
    prefix: "time-job-test",
    worldId: ids.worldId,
    branchId: ids.branchId,
    originStorySecond: SEED_STORY_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
    locationSlug: "cafe",
    zoneSlug: "hall",
    locationKind: "cafe",
    zoneKind: "hall",
    items: [
      {
        id: ids.sourceId,
        name: "Mara's bag",
        container: { capacityCount: 8, access: { kind: "holder_only" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: ids.destinationId,
        name: "the cafe table",
        container: { capacityCount: 8, access: { kind: "holder_only" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      ...ids.itemIds.map((id, index) => ({
        id,
        name: index === 0 ? "gold ring" : `test item ${index + 1}`,
        locus: { kind: "container" as const, containerItemId: ids.sourceId },
      })),
    ],
  });
}

/**
 * A trigger's payload command. Re-parsed through the REAL per-type schema so the
 * scheduler's payload contract (which takes a branded `TransferItemCommand`, not
 * a bare envelope) is honored. The dispatcher overwrites `id`/`idempotencyKey`
 * with its own derived pair, so `simCommand`'s deterministic ids are free here.
 */
function command(ids: CaseIds, name: string, itemId: string): TransferItemCommand {
  return transferItemCommandSchema.parse(
    simCommand({
      branchId: ids.branchId,
      name,
      type: "transfer_item",
      principal: { ...systemPrincipal, controlledActorIds: [ids.actorId] },
      payload: {
        actorId: ids.actorId,
        itemId,
        fromLocus: { kind: "container", containerItemId: ids.sourceId },
        toLocus: { kind: "container", containerItemId: ids.destinationId },
      },
    }),
  );
}

function scheduleAt(ids: CaseIds, dueStorySecond: number, uniquenessKey: string, itemId: string) {
  return scheduleDurableTrigger({
    worldId: ids.worldId,
    branchId: ids.branchId,
    kind: "scheduled_transfer_item",
    schemaVersion: 1,
    dueStorySecond,
    uniquenessKey,
    payload: { command: command(ids, uniquenessKey, itemId) },
  });
}

function enqueueFor(ids: CaseIds, targetStorySecond: number, reachedStorySecond = SEED_STORY_SECOND) {
  return enqueueTimeJob({ worldId: ids.worldId, branchId: ids.branchId, chatId: ids.chatId, targetStorySecond, reachedStorySecond });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function activeJobCount(branchId: string): Promise<number> {
  const rows = await db()
    .select({ id: simTimeJobs.id })
    .from(simTimeJobs)
    .where(and(eq(simTimeJobs.branchId, branchId), or(eq(simTimeJobs.state, "pending"), eq(simTimeJobs.state, "processing"))));
  return rows.length;
}

describe.skipIf(!ready)("durable time jobs", () => {
  it("enqueues one job per branch — a repeat enqueue returns the same job, bumping the target", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const first = await enqueueFor(ids, SEED_STORY_SECOND + 600);
    expect(first.created).toBe(true);

    // A repeat for the SAME branch keeps the existing job (never a second active row).
    const again = await enqueueFor(ids, SEED_STORY_SECOND + 1200);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(await activeJobCount(ids.branchId)).toBe(1);

    // The target advanced to the further second.
    const [row] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.id, first.id));
    expect(row?.targetStorySecond).toBe(SEED_STORY_SECOND + 1200);
  });

  it("keeps exactly one active job under a concurrent enqueue race (the partial unique index)", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const results = await Promise.all([
      enqueueFor(ids, SEED_STORY_SECOND + 600),
      enqueueFor(ids, SEED_STORY_SECOND + 600),
      enqueueFor(ids, SEED_STORY_SECOND + 600),
    ]);
    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    expect(await activeJobCount(ids.branchId)).toBe(1);
    // The losers merge into the winner's job rather than inventing one: every caller walks away
    // pointing at the same durable drain.
    expect([...new Set(results.map((r) => r.id))]).toEqual([created[0]!.id]);
  });

  it("merges its farther target into a peer's job when its own insert loses the race", async () => {
    const ids = makeIds();
    await seedCase(ids);

    // The test above only hits the losing branch when the scheduler happens to interleave the
    // three enqueues just so; this one FORCES it. An uncommitted peer insert is held open, so the
    // enqueue's opening select sees nothing (the row isn't visible yet) and its own insert
    // collides with the held row and blocks until the peer commits.
    //
    // That is the path that used to raise a unique violation, which aborts the enqueue's whole
    // transaction — its recovery re-read then died with 25P02 instead of adopting the peer's job.
    // Intermittent in CI, a real lost enqueue in production.
    //
    // The racer asks for a FARTHER target than the peer's, which is the case that actually costs a
    // player something: a long skip can lose this race to a short arrival-settlement escalation,
    // and a loser that merely adopted the winner's row would truncate the drain to the near target.
    const peerTarget = SEED_STORY_SECOND + 600;
    const racerTarget = SEED_STORY_SECOND + 1800;
    const peerId = newId();

    // A barrier, not a timed guess: the racer may only start once the peer's insert has actually
    // landed. A `sleep` here would let a slow runner reverse the two, and then it is the PEER's
    // plain insert that fails — a flake manufactured by the test rather than found by it.
    let peerHasInserted!: () => void;
    const peerInserted = new Promise<void>((resolve) => {
      peerHasInserted = resolve;
    });
    const peer = db().transaction(async (tx) => {
      await tx.insert(simTimeJobs).values({
        id: peerId,
        worldId: ids.worldId,
        branchId: ids.branchId,
        chatId: ids.chatId,
        targetStorySecond: peerTarget,
        reachedStorySecond: SEED_STORY_SECOND,
      });
      peerHasInserted();
      // Hold the row uncommitted long enough for the racer to reach its own insert and block on it.
      await sleep(250);
    });
    await peerInserted;

    // `Promise.all` rather than a bare await: it settles only once the peer's transaction is done
    // (so the row reads below see the committed state) and it attaches a handler to the peer even
    // when the enqueue throws, so a failure here can never surface as an unhandled rejection
    // blamed on whichever test runs next.
    const [raced] = await Promise.all([enqueueFor(ids, racerTarget), peer]);

    expect(raced.created).toBe(false);
    expect(raced.id).toBe(peerId);
    expect(await activeJobCount(ids.branchId)).toBe(1);
    // The merge holds on either interleaving: `greatest` when the race fired, the `for update`
    // bump when the peer committed first. Both must land on the farther target.
    const [row] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.id, peerId));
    expect(row?.targetStorySecond).toBe(racerTarget);
  });

  it("claims a due job with a lease and drains it to completion, stamping progress", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "t200", ids.itemIds[1]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    expect(job).not.toBeNull();
    expect(job?.state).toBe("processing");
    expect(job?.attempts).toBe(1);

    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(result.terminalFailures).toBe(0);

    const [row] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.id, job!.id));
    expect(row?.state).toBe("completed");
    expect(row?.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(row?.leaseOwner).toBeNull();
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);
  });

  // Ruling 24 — the drain target IS the arrival trigger's due second, so a delay that lands
  // mid-drain (a bump onto the still-processing row) must EXTEND the running drain; stranding the
  // further target on a completed row would leave the traveller short and nothing to re-claim it.
  it("a mid-drain target bump extends the running job — the drain lands on the new target", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    // Inside the EXTENDED window only — the original target would never reach it.
    await scheduleAt(ids, SEED_STORY_SECOND + 450, "t450", ids.itemIds[1]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    expect(job).not.toBeNull();
    expect(job?.state).toBe("processing");
    expect(job?.targetStorySecond).toBe(SEED_STORY_SECOND + 300);

    // The delay arrives while the job is processing: the enqueue bumps the claimed row's target.
    const bump = await enqueueFor(ids, SEED_STORY_SECOND + 600);
    expect(bump.created).toBe(false);
    expect(bump.id).toBe(job!.id);

    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 600);
    expect(result.targetStorySecond).toBe(SEED_STORY_SECOND + 600);
    expect(result.terminalFailures).toBe(0);

    const [row] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.id, job!.id));
    expect(row?.state).toBe("completed");
    expect(row?.reachedStorySecond).toBe(SEED_STORY_SECOND + 600);
    expect(row?.targetStorySecond).toBe(SEED_STORY_SECOND + 600);
    expect(row?.leaseOwner).toBeNull();
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);
  });

  it("a fenced write cannot land after another worker takes the job over (lease_lost)", async () => {
    const ids = makeIds(1);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    expect(job).not.toBeNull();
    // Simulate worker B stealing the job (e.g. after worker_a's lease expired and B reclaimed):
    // the row's lease_owner is now B, so worker_a's fenced writes must all fail.
    await db()
      .update(simTimeJobs)
      .set({ leaseOwner: "worker_b", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(simTimeJobs.id, job!.id));

    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("lease_lost");
    // Worker B still owns it; worker_a never completed it.
    const [row] = await db().select({ state: simTimeJobs.state, leaseOwner: simTimeJobs.leaseOwner }).from(simTimeJobs).where(eq(simTimeJobs.id, job!.id));
    expect(row?.state).toBe("processing");
    expect(row?.leaseOwner).toBe("worker_b");
  });

  it("reclaims a job whose lease has expired, incrementing attempts", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const enq = await enqueueFor(ids, SEED_STORY_SECOND + 300);
    // A crashed worker left the job processing with an expired lease.
    await db()
      .update(simTimeJobs)
      .set({ state: "processing", attempts: 1, leaseOwner: "dead_worker", leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(simTimeJobs.id, enq.id));

    const reclaimed = await claimDueTimeJob("worker_b");
    expect(reclaimed?.id).toBe(enq.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("does not claim a job whose lease is still valid", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const enq = await enqueueFor(ids, SEED_STORY_SECOND + 300);
    await db()
      .update(simTimeJobs)
      .set({ state: "processing", leaseOwner: "worker_a", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(simTimeJobs.id, enq.id));

    expect(await claimDueTimeJob("worker_b")).toBeNull();
  });

  it("completes past a poison trigger and surfaces it as a terminal failure", async () => {
    const ids = makeIds(1);
    await seedCase(ids);
    // A poison trigger (missing item → rejected → failed) at +100, a healthy one at +200.
    await scheduleDurableTrigger({
      worldId: ids.worldId,
      branchId: ids.branchId,
      kind: "scheduled_transfer_item",
      schemaVersion: 1,
      dueStorySecond: SEED_STORY_SECOND + 100,
      uniquenessKey: "poison",
      payload: { command: command(ids, "poison", newId()) },
    });
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "healthy", ids.itemIds[0]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(result.terminalFailures).toBe(1);
  });

  it("reports a chat's job status for the catch-up UI", async () => {
    const ids = makeIds();
    await seedCase(ids);
    await enqueueFor(ids, SEED_STORY_SECOND + 900, SEED_STORY_SECOND + 100);
    const status = await readTimeJobForChat(ids.chatId);
    expect(status).toMatchObject({ state: "pending", targetStorySecond: SEED_STORY_SECOND + 900, reachedStorySecond: SEED_STORY_SECOND + 100 });
  });

  it("runSkipWithEscalation finishes a short skip in-request (no job left behind)", async () => {
    const ids = makeIds(1);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);

    const result = await runSkipWithEscalation(
      { worldId: ids.worldId, branchId: ids.branchId, chatId: ids.chatId, targetStorySecond: SEED_STORY_SECOND + 300 },
      { kick: false },
    );
    expect(result.status).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);
  });

  it("escalateToTimeJob + the sweep drain a job to completion offline (server owns completion)", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "t200", ids.itemIds[1]!);

    await escalateToTimeJob(
      { worldId: ids.worldId, branchId: ids.branchId, chatId: ids.chatId, targetStorySecond: SEED_STORY_SECOND + 300, reachedStorySecond: SEED_STORY_SECOND },
      { kick: false },
    );
    expect(await hasActiveTimeJob(ids.branchId)).toBe(true);

    const processed = await runDueTimeJobs("sweep_worker");
    expect(processed).toBe(1);
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);

    const status = await readTimeJobForChat(ids.chatId);
    expect(status).toMatchObject({ state: "completed", reachedStorySecond: SEED_STORY_SECOND + 300 });
  });
});
