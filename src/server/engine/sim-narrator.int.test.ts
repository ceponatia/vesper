import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposedArmedEffectSchema } from "@/contracts/simulation/narrative";
import { deriveEngagementId } from "@/lib/simulation";
import { db, simEvents, simWorlds } from "@/server/db";
import { renderCommittedCut, type RenderSeam } from "./sim-narrator";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  ROLLOUT_WORLD_ID,
  prepareEngagementTurn,
  seedRolloutTestWorld,
} from "./simulation";
import { submitDurableOpenEngagement } from "./simulation/engagement-store";

/**
 * R2 (engine.rollout.plan.md) — the live-narrator leg with the model seam
 * STUBBED (zero live calls, the corpus discipline): a compliant render is
 * accepted and confirmed, a bad render retries hidden from the same cut
 * (ruling 8), a persistently bad render WITHHOLDS without touching state,
 * and an enacted armed effect lands a real speech_act_delivered through
 * confirm_narrator_result.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_narrative_cuts limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[sim-narrator.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

async function teardown(): Promise<void> {
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
}

beforeAll(async () => {
  if (!ready) return;
  await teardown();
});
afterAll(async () => {
  if (!ready) return;
  await teardown();
});

/** A seam returning canned raw replies in order, then repeating the last. */
function seamOf(replies: unknown[]): { seam: RenderSeam; calls: () => number } {
  let call = 0;
  return {
    seam: async () => {
      const raw = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return { raw, degraded: false, provider: "stub", latencyMs: 1 };
    },
    calls: () => call,
  };
}

describe.runIf(ready)("R2 sim narrator over the committed cut", () => {
  it("renders, retries hidden from the same cut, withholds cleanly, and confirms enacted effects", async () => {
    await seedRolloutTestWorld();
    const openCommandId = "r2-test-open-ana-mara";
    const engagementId = deriveEngagementId(ROLLOUT_BRANCH_ID, openCommandId);
    const opened = await submitDurableOpenEngagement(
      {
        id: openCommandId,
        branchId: ROLLOUT_BRANCH_ID,
        expectedVersion: 0,
        idempotencyKey: openCommandId,
        principal: {
          kind: "player" as const,
          principalId: "r2-player",
          controlledActorIds: [ROLLOUT_ACTORS.mara],
        },
        submittedAtWallClock: new Date().toISOString(),
        correlationId: "r2-test",
        type: "open_engagement",
        schemaVersion: 1,
        payload: {
          participantIds: [ROLLOUT_ACTORS.ana, ROLLOUT_ACTORS.mara].sort(),
          channel: "co_present",
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");

    const turn = await prepareEngagementTurn({
      branchId: ROLLOUT_BRANCH_ID,
      engagementId,
      viewpointActorId: ROLLOUT_ACTORS.mara,
      spanSeconds: 60,
      playerActorIds: [ROLLOUT_ACTORS.mara],
      proposedArmedEffects: [
        proposedArmedEffectSchema.parse({
          effectType: "invitation_spoken",
          actorId: ROLLOUT_ACTORS.mara,
          targetActorIds: [ROLLOUT_ACTORS.ana],
          detail: "Mara invites Ana to walk to the square together.",
        }),
      ],
      workerId: "r2-test-worker",
    });
    const armedId = turn.cut.armedEffects[0]?.id;
    if (!armedId) throw new Error("expected one armed effect on the cut");
    const compliant = {
      prose: "The kitchen hums with morning quiet as Mara leans against the counter, and the words come easily: would Ana walk with her to the square?",
      enactedBeatEventIds: turn.cut.mustEnact.map((beat) => beat.eventId),
      enactedArmedEffectIds: [armedId],
      proposedSoftCanon: [],
    };

    // Ruling 8: the first (garbage) attempt is hidden; the retry renders the
    // SAME cut and the enacted invitation lands as a real speech act.
    const retrySeam = seamOf([{ nonsense: true }, compliant]);
    const rendered = await renderCommittedCut(
      { branchId: ROLLOUT_BRANCH_ID, engagementId, cutId: turn.cut.id },
      { render: retrySeam.seam },
    );
    expect(retrySeam.calls()).toBe(2);
    expect(rendered).toMatchObject({
      status: "rendered",
      attempts: 2,
      cutId: turn.cut.id,
      confirmStatus: "accepted",
      modelId: "aion-labs/aion-3.0",
    });
    expect(rendered.audit?.verdict).toBe("accept");
    const speechActs = await db()
      .select({ payload: simEvents.payload })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ROLLOUT_BRANCH_ID), eq(simEvents.type, "speech_act_delivered")));
    expect(speechActs).toHaveLength(1);
    expect(speechActs[0]?.payload).toMatchObject({
      effectType: "invitation_spoken",
      actorId: ROLLOUT_ACTORS.mara,
    });

    // A persistently bad render WITHHOLDS: no new events, nothing corrupted,
    // and the same cut stays renderable afterwards.
    const eventsBefore = await db()
      .select({ id: simEvents.id })
      .from(simEvents)
      .where(eq(simEvents.branchId, ROLLOUT_BRANCH_ID));
    const failSeam = seamOf([{ junk: 1 }]);
    const withheld = await renderCommittedCut(
      { branchId: ROLLOUT_BRANCH_ID, engagementId, cutId: turn.cut.id },
      { render: failSeam.seam },
    );
    expect(withheld).toMatchObject({ status: "withheld", attempts: 2 });
    expect(withheld.diagnostics).toContain("sim.narrator.withheld_after_retry");
    const eventsAfter = await db()
      .select({ id: simEvents.id })
      .from(simEvents)
      .where(eq(simEvents.branchId, ROLLOUT_BRANCH_ID));
    expect(eventsAfter).toHaveLength(eventsBefore.length);

    // A rerender of the same accepted result replays confirm idempotently —
    // one speech act, ever (rerender-creates-nothing).
    const rerenderSeam = seamOf([compliant]);
    const rerendered = await renderCommittedCut(
      { branchId: ROLLOUT_BRANCH_ID, engagementId, cutId: turn.cut.id },
      { render: rerenderSeam.seam },
    );
    expect(rerendered.status).toBe("rendered");
    const speechActsAfter = await db()
      .select({ id: simEvents.id })
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ROLLOUT_BRANCH_ID), eq(simEvents.type, "speech_act_delivered")));
    expect(speechActsAfter).toHaveLength(1);

    // Small omissions bridge deterministically instead of failing the turn.
    if (turn.cut.mustEnact.length > 0) {
      const partial = { ...compliant, enactedBeatEventIds: [], enactedArmedEffectIds: [] };
      const bridged = await renderCommittedCut(
        { branchId: ROLLOUT_BRANCH_ID, engagementId, cutId: turn.cut.id },
        { render: seamOf([partial]).seam },
      );
      // ≤2 missing beats bridges; more re-renders then withholds — both legal
      // §23.2 outcomes depending on how many beats this turn carried.
      expect(["rendered", "withheld"]).toContain(bridged.status);
    }
  });
});
