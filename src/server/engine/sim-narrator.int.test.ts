import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposedArmedEffectSchema } from "@/contracts/simulation/narrative";
import { deriveEngagementId } from "@/lib/simulation";
import { db, simEvents, simWorlds } from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  expectAccepted,
  playerPrincipal,
  simCommand,
  simulationSuiteHarness,
} from "@/server/test-support";
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
 *
 * `simulationSuiteHarness` supplies the probe, the legacy-player opt-in guard
 * (this suite submits a player command against the directly-seeded, unanchored
 * rollout branch — without the flag the authz seam refuses the open as
 * `unanchored_player` and the failure reads as a domain bug) and the pool
 * close. The rollout world's ids are FIXED, so the explicit both-ends teardown
 * below stays hand-written rather than tracked (tracking it would delete the
 * same world twice).
 */

const harness = await simulationSuiteHarness({
  suite: "sim-narrator.int.test",
  table: "sim_narrative_cuts",
});
const ready = harness.ready;

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
    const openCommand = simCommand({
      branchId: ROLLOUT_BRANCH_ID,
      name: "r2-test-open-ana-mara",
      type: "open_engagement",
      principal: playerPrincipal(ROLLOUT_ACTORS.mara),
      payload: {
        participantIds: [ROLLOUT_ACTORS.ana, ROLLOUT_ACTORS.mara].sort(),
        channel: "co_present",
      },
    });
    const engagementId = deriveEngagementId(ROLLOUT_BRANCH_ID, openCommand.id);
    const opened = await submitDurableOpenEngagement(openCommand, ADMIT_AT_LOCKED_VERSION);
    expectAccepted(opened, "opening the Ana/Mara engagement on the rollout branch");

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
