import { and, asc, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { MemoryRecallResponse } from "@vesper/simulation-core/contracts/memory";
import { proposedArmedEffectSchema } from "@vesper/simulation-core/contracts/narrative";
import { newId } from "@/lib/ids";
import { deriveEngagementId } from "@vesper/simulation-core/engagements";
import { auditPresentation, parseNarratorResult } from "@vesper/simulation-core/presentation";
import { db, simAssertions, simBeliefs } from "@/server/db";
import {
  ADMIT_AT_LOCKED_VERSION,
  branchFootprint,
  expectAccepted,
  footprintDelta,
  playerPrincipal,
  readBranchEvents,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  systemPrincipal,
} from "@/server/test-support";
import { prepareEngagementTurn, submitDurableConfirmNarratorResult } from "./arbiter-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { submitDurableMakeDisclosure } from "./knowledge-store";
import { beliefFromRow } from "./knowledge-recorder";
import { drainMemoryIndexOutbox } from "./memory-index-store";
import { queryMemoryDocuments } from "./memory-query-store";
import { loadPersistedCut } from "./narrative-cut-store";

/**
 * The Gate 4 exit corpus (engine.plan §"Gate 4 exit", ruled 2026-07-18):
 * deterministic scenarios proving the four gate-closing criteria with ZERO
 * model calls —
 *   1. zero cross-viewpoint leaks (the live-scene suite extended with
 *      knowledge asymmetry: a viewpoint that did not observe or learn a fact
 *      never receives it in cut, serialized prompt input, or retrieval);
 *   2. contradictions and retractions never leave both claims presented as
 *      current truth;
 *   3. rerendering the same cut creates no events, memories, or rows at all;
 *   4. narrator failures retry from the same persisted cut.
 * Gossip-provenance chains prove "who told whom" stays reconstructible.
 * The fifth criterion (live paired voice/chemistry eval) is owner-gated
 * spend, deferred by the same ruling — it does not hold this verdict.
 */

const SEED_SECOND = 100_000;
const TURN_SPAN = 400;

const harness = await simulationSuiteHarness({
  suite: "gate4-corpus.int.test",
  table: "sim_memory_documents",
});

/** Cafe (hall: player+mara; shop: iris) and a park (noor) — two locations. */
interface CorpusCase {
  worldId: string;
  branchId: string;
  player: string;
  mara: string;
  iris: string;
  noor: string;
  locCafe: string;
  locPark: string;
  zoneCafe: string;
  zoneShop: string;
  zonePark: string;
}

async function seedCorpusCase(): Promise<CorpusCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: CorpusCase = {
    worldId,
    branchId,
    player: newId(),
    mara: newId(),
    iris: newId(),
    noor: newId(),
    locCafe: `${worldId}-loc-cafe`,
    locPark: `${worldId}-loc-park`,
    zoneCafe: `${branchId}-zone-cafe`,
    zoneShop: `${branchId}-zone-shop`,
    zonePark: `${branchId}-zone-park`,
  };
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "gate4-corpus",
    rulesetVersion: "gate4-corpus-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.player, name: "Pia" },
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
      { id: ids.noor, name: "Noor" },
    ],
    locations: [
      { id: ids.locCafe, worldId, kind: "town", defaultAccessPolicy: "public" },
      { id: ids.locPark, worldId, kind: "park", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: ids.zoneCafe, locationId: ids.locCafe, kind: "cafe", privacyPolicy: "public" },
      { id: ids.zoneShop, locationId: ids.locCafe, kind: "shop", privacyPolicy: "public" },
      { id: ids.zonePark, locationId: ids.locPark, kind: "park", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${branchId}-link-cafe-shop`,
        fromZoneId: ids.zoneCafe,
        toZoneId: ids.zoneShop,
        modes: ["walk"],
        minimumDurationSeconds: 60,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: `${branchId}-link-cafe-park`,
        fromZoneId: ids.zoneCafe,
        toZoneId: ids.zonePark,
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
    ],
    placements: [
      { actorId: ids.player, locationId: ids.locCafe, zoneId: ids.zoneCafe },
      { actorId: ids.mara, locationId: ids.locCafe, zoneId: ids.zoneCafe },
      { actorId: ids.iris, locationId: ids.locCafe, zoneId: ids.zoneShop },
      { actorId: ids.noor, locationId: ids.locPark, zoneId: ids.zonePark },
    ],
  });
  harness.trackWorld(worldId);
  return ids;
}

async function openEngagement(
  ids: CorpusCase,
  name: string,
  initiatorId: string,
  participantIds: string[],
  channel: "co_present" | "text",
): Promise<string> {
  const opened = await submitDurableOpenEngagement(
    simCommand({
      branchId: ids.branchId,
      name,
      type: "open_engagement",
      principal: playerPrincipal(initiatorId),
      payload: { participantIds: [...participantIds].sort(), channel },
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(opened, `engagement ${name}`);
  return deriveEngagementId(ids.branchId, `cmd-${name}-${ids.branchId}`);
}

function disclose(
  ids: CorpusCase,
  name: string,
  speakerActorId: string,
  targetActorIds: string[],
  content: Record<string, unknown>,
) {
  return submitDurableMakeDisclosure(
    simCommand({
      branchId: ids.branchId,
      name,
      type: "make_disclosure",
      principal: playerPrincipal(speakerActorId),
      payload: { speakerActorId, targetActorIds: [...targetActorIds].sort(), content },
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
}

function recall(
  ids: CorpusCase,
  viewpointActorId: string,
  atStorySecond: number,
  extra: Record<string, unknown> = {},
): Promise<MemoryRecallResponse> {
  return queryMemoryDocuments({
    branchId: ids.branchId,
    viewpointActorId,
    atStorySecond,
    limit: 32,
    maxCandidates: 256,
    ...extra,
  });
}

function recallText(response: MemoryRecallResponse): string {
  return response.results.map((result) => result.text).join(" | ");
}

/** Mara confides the secret to the player inside a rendered turn. */
async function confideSecret(
  ids: CorpusCase,
  engagementId: string,
  name: string,
): Promise<{ cutId: string; throughStorySecond: number }> {
  const turn = await prepareEngagementTurn({
    branchId: ids.branchId,
    engagementId,
    viewpointActorId: ids.player,
    spanSeconds: TURN_SPAN,
    workerId: "w-gate4",
    proposedArmedEffects: [
      proposedArmedEffectSchema.parse({
        effectType: "disclosure_made",
        actorId: ids.mara,
        targetActorIds: [ids.player],
        detail: "Mara admits she is quitting her job.",
        disclosureContent: {
          kind: "claim",
          propositionKey: "quitting_job",
          subjectIds: [ids.mara],
          claimedValue: { quitting: true },
        },
      }),
    ],
  });
  const effect = turn.cut.armedEffects.find((candidate) => candidate.effectType === "disclosure_made");
  if (!effect) throw new Error("Disclosure effect missing from cut");
  const confirmed = await submitDurableConfirmNarratorResult(
    simCommand({
      branchId: ids.branchId,
      name,
      type: "confirm_narrator_result",
      principal: systemPrincipal,
      payload: {
        engagementId,
        cutId: turn.cut.id,
        enactedArmedEffectIds: [effect.id],
        softCanonProposals: [],
      },
    }),
    ADMIT_AT_LOCKED_VERSION,
  );
  expectAccepted(confirmed, `confirmation ${name}`);
  return { cutId: turn.cut.id, throughStorySecond: turn.cut.throughStorySecond };
}

describe.runIf(harness.ready)("Gate 4 exit corpus (deterministic, zero model calls)", () => {
  it("EXIT 1 — sweeps every viewpoint's cut and retrieval for the secret: only those who learned it hold it", async () => {
    const ids = await seedCorpusCase();
    const chatId = await openEngagement(ids, "chat", ids.player, [ids.player, ids.mara], "co_present");
    // A second, remote scene so the non-participants have a cut surface too.
    const sideId = await openEngagement(ids, "side", ids.iris, [ids.iris, ids.noor], "text");

    const { throughStorySecond } = await confideSecret(ids, chatId, "confide");
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });
    const at = throughStorySecond + TURN_SPAN;

    // Cut surface sweep: the serialized cut IS the narrator's prompt input
    // (§22.1) — the secret may appear only in the knowers' cuts.
    const playerTurn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: chatId,
      viewpointActorId: ids.player,
      spanSeconds: TURN_SPAN,
      workerId: "w-gate4",
    });
    expect(JSON.stringify(playerTurn.cut)).toContain("quitting_job");

    const irisTurn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: sideId,
      viewpointActorId: ids.iris,
      spanSeconds: TURN_SPAN,
      workerId: "w-gate4",
    });
    expect(JSON.stringify(irisTurn.cut)).not.toContain("quitting");
    const noorTurn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: sideId,
      viewpointActorId: ids.noor,
      spanSeconds: TURN_SPAN,
      workerId: "w-gate4",
    });
    expect(JSON.stringify(noorTurn.cut)).not.toContain("quitting");

    // Retrieval sweep — and asking the right question must not widen it.
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });
    const sweepAt = at + 2 * TURN_SPAN;
    const playerRecall = await recall(ids, ids.player, sweepAt);
    expect(recallText(playerRecall)).toContain("quitting_job");
    const maraRecall = await recall(ids, ids.mara, sweepAt);
    // The speaker remembers saying it (speech act), holds no belief in it.
    expect(recallText(maraRecall)).toContain("quitting her job");
    expect(maraRecall.results.some((result) => result.sourceKind === "belief")).toBe(false);
    for (const outsider of [ids.iris, ids.noor]) {
      const swept = await recall(ids, outsider, sweepAt, { queryText: "mara quitting her job" });
      expect(recallText(swept)).not.toContain("quitting");
    }
  });

  it("EXIT 2 — contradiction and retraction never leave both claims presented as current truth", async () => {
    const ids = await seedCorpusCase();
    const chatId = await openEngagement(ids, "chat", ids.player, [ids.player, ids.mara], "co_present");

    // Two voices, two values: Mara says florist, Iris says bakery.
    const claimed = await disclose(ids, "claim-florist", ids.mara, [ids.player], {
      kind: "claim",
      propositionKey: "works_at",
      subjectIds: [ids.mara],
      claimedValue: { employer: "florist" },
    });
    expectAccepted(claimed, "florist claim");
    const countered = await disclose(ids, "claim-bakery", ids.iris, [ids.player], {
      kind: "claim",
      propositionKey: "works_at",
      subjectIds: [ids.mara],
      claimedValue: { employer: "bakery" },
    });
    expectAccepted(countered, "bakery claim");
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });

    // Both assertions are contradicted (§3.3): neither is presentable truth.
    const assertionRows = await db()
      .select()
      .from(simAssertions)
      .where(eq(simAssertions.branchId, ids.branchId))
      .orderBy(asc(simAssertions.assertionId));
    expect(assertionRows.map((row) => row.status)).toEqual(["contradicted", "contradicted"]);
    const at = SEED_SECOND + 10;
    const playerRecall = await recall(ids, ids.player, at);
    expect(playerRecall.results.some((result) => result.sourceKind === "assertion")).toBe(false);
    // The holder's stances are labeled, and the weaker one is marked doubted.
    const beliefTexts = playerRecall.results
      .filter((result) => result.sourceKind === "belief")
      .map((result) => result.text)
      .sort();
    expect(beliefTexts).toHaveLength(2);
    expect(beliefTexts.join(" ")).toContain("florist");
    expect(beliefTexts.find((text) => text.includes("bakery"))).toContain("Holds this with doubt.");

    // Retraction: Mara takes the florist claim back where the player hears.
    const retractTarget = assertionRows.find((row) => row.sourceActorId === ids.mara)?.assertionId;
    if (!retractTarget) throw new Error("Florist assertion missing");
    const retracted = await disclose(ids, "retract-florist", ids.mara, [ids.player], {
      kind: "retraction",
      assertionId: retractTarget,
    });
    expectAccepted(retracted, "florist retraction");
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });

    const afterRecall = await recall(ids, ids.player, at + 1);
    expect(recallText(afterRecall)).not.toContain("florist");
    expect(afterRecall.results.some((result) => result.sourceKind === "assertion")).toBe(false);

    // The next cut voices exactly the surviving doubted stance — never both
    // as truth (§22.1 speakerBeliefs are stances, labeled and confident).
    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: chatId,
      viewpointActorId: ids.player,
      spanSeconds: TURN_SPAN,
      workerId: "w-gate4",
    });
    expect(turn.cut.speakerBeliefs).toHaveLength(1);
    expect(turn.cut.speakerBeliefs[0]).toMatchObject({ status: "doubted" });
    expect(JSON.stringify(turn.cut.speakerBeliefs)).toContain("bakery");
    expect(JSON.stringify(turn.cut.speakerBeliefs)).not.toContain("florist");
  });

  it("EXIT 3 + 4 — rerender creates nothing anywhere, and a failed narrator retries from the same persisted cut", async () => {
    const ids = await seedCorpusCase();
    const chatId = await openEngagement(ids, "chat", ids.player, [ids.player, ids.mara], "co_present");
    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: chatId,
      viewpointActorId: ids.player,
      spanSeconds: TURN_SPAN,
      workerId: "w-gate4",
      proposedArmedEffects: [
        proposedArmedEffectSchema.parse({
          effectType: "apology_delivered",
          actorId: ids.mara,
          targetActorIds: [ids.player],
          detail: "Mara apologizes for the earlier silence.",
        }),
      ],
    });
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });

    // Ruling 8: the first render "fails" — nothing to roll back, because the
    // committed cut row is the whole render state. Retry re-reads it.
    // `branchFootprint` counts every branch-scoped sim_ table the drizzle
    // schema knows about, so a lane added later is covered without editing
    // this file.
    const footprint = await branchFootprint(ids.branchId);
    const retried = await loadPersistedCut(ids.branchId, turn.cut.id);
    expect(retried).toEqual(turn.cut);
    // Rerender: parse a narrator reply and audit it — pure presentation.
    const parsed = parseNarratorResult(
      {
        prose: "Mara looks up and finally says sorry.",
        enactedArmedEffectIds: [turn.cut.armedEffects[0]?.id ?? "armed-missing"],
        enactedBeatEventIds: turn.cut.mustEnact.map((beat) => beat.eventId),
        proposedSoftCanon: [],
      },
      retried,
    );
    const audit = auditPresentation(retried, parsed.result);
    expect(audit.verdict).toBe("accept");
    expect(await loadPersistedCut(ids.branchId, turn.cut.id)).toEqual(turn.cut);
    expect(footprintDelta(footprint, await branchFootprint(ids.branchId))).toEqual({});

    // Only explicit confirmation commits — once; replaying it adds nothing.
    const confirmCommand = simCommand({
      branchId: ids.branchId,
      name: "confirm-apology",
      type: "confirm_narrator_result",
      principal: systemPrincipal,
      payload: {
        engagementId: chatId,
        cutId: turn.cut.id,
        enactedArmedEffectIds: parsed.result.enactedArmedEffectIds,
        softCanonProposals: [],
      },
    });
    const confirmed = await submitDurableConfirmNarratorResult(confirmCommand, ADMIT_AT_LOCKED_VERSION);
    expectAccepted(confirmed, "apology confirmation");
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });
    const afterConfirm = await branchFootprint(ids.branchId);
    expect(await submitDurableConfirmNarratorResult(confirmCommand, ADMIT_AT_LOCKED_VERSION)).toEqual(confirmed);
    expect(await loadPersistedCut(ids.branchId, turn.cut.id)).toEqual(turn.cut);
    expect(footprintDelta(afterConfirm, await branchFootprint(ids.branchId))).toEqual({});
  });

  it("EXIT sweep — gossip provenance chains stay reconstructible, decay per hop, and retraction reaches only earshot", async () => {
    const ids = await seedCorpusCase();

    // Hop 1: Mara → player (co-present). Hop 2: player → Iris (same location).
    // Hop 3: Iris → Noor (another location — device, unoverhearable).
    const original = await disclose(ids, "hop-1", ids.mara, [ids.player], {
      kind: "claim",
      propositionKey: "quitting_job",
      subjectIds: [ids.mara],
      claimedValue: { quitting: true },
    });
    expectAccepted(original, "hop 1");
    const [assertionRow] = await db()
      .select({ assertionId: simAssertions.assertionId })
      .from(simAssertions)
      .where(eq(simAssertions.branchId, ids.branchId))
      .limit(1);
    if (!assertionRow) throw new Error("Assertion missing after hop 1");
    const relayContent = { kind: "relay", assertionId: assertionRow.assertionId };
    expectAccepted(await disclose(ids, "hop-2", ids.player, [ids.iris], relayContent), "hop 2");
    expectAccepted(await disclose(ids, "hop-3", ids.iris, [ids.noor], relayContent), "hop 3");
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });

    // Confidence decays hop by hop; the provenance path is the route.
    const beliefRows = (
      await db()
        .select()
        .from(simBeliefs)
        .where(and(eq(simBeliefs.branchId, ids.branchId), inArray(simBeliefs.status, ["active", "doubted"])))
        .orderBy(asc(simBeliefs.beliefId))
    ).map(beliefFromRow);
    const byHolder = new Map<string, (typeof beliefRows)[number]>(
      beliefRows.map((belief) => [belief.holderActorId, belief]),
    );
    expect(byHolder.get(ids.player)).toMatchObject({
      confidenceFixedPoint: 9_000,
      learnedFromActorIds: [ids.mara],
    });
    expect(byHolder.get(ids.iris)).toMatchObject({
      confidenceFixedPoint: 8_000,
      learnedFromActorIds: [ids.mara, ids.player],
    });
    expect(byHolder.get(ids.noor)).toMatchObject({
      confidenceFixedPoint: 7_000,
      learnedFromActorIds: [ids.mara, ids.player, ids.iris],
    });

    // Reconstructible: Noor's belief names the hop event that minted it, and
    // that committed event carries the captured chain (§6.4).
    const noorBelief = byHolder.get(ids.noor);
    if (!noorBelief) throw new Error("Noor's belief missing");
    const hopEvent = (await readBranchEvents(ids.branchId)).find((event) => event.id === noorBelief.sourceEventId);
    if (!hopEvent) throw new Error("Hop event missing");
    if (hopEvent.type !== "disclosure_made") throw new Error("Hop event is not a disclosure");
    expect(hopEvent.payload.speakerActorId).toBe(ids.iris);
    expect(hopEvent.payload.derived.learnedFromActorIds).toEqual([ids.mara, ids.player, ids.iris]);

    // Recall shows the route in plain words, at the right epistemic label.
    const noorRecall = await recall(ids, ids.noor, SEED_SECOND + 10);
    const noorBeliefResult = noorRecall.results.find((result) => result.sourceKind === "belief");
    expect(noorBeliefResult?.epistemicLabel).toBe("believed");
    expect(noorBeliefResult?.confidenceFixedPoint).toBe(7_000);
    expect(noorBeliefResult?.text).toContain(`heard through ${ids.mara} then ${ids.player} then ${ids.iris}`);

    // Retraction reaches only earshot: Mara retracts to the player alone —
    // Iris and Noor keep believing the old story. That is the point (§21).
    const retracted = await disclose(ids, "retract", ids.mara, [ids.player], {
      kind: "retraction",
      assertionId: assertionRow.assertionId,
    });
    expectAccepted(retracted, "earshot retraction");
    await drainMemoryIndexOutbox({ workerId: "w-gate4-drain" });
    const at = SEED_SECOND + 20;
    expect(recallText(await recall(ids, ids.player, at))).not.toContain("quitting_job");
    expect(recallText(await recall(ids, ids.iris, at))).toContain("quitting_job");
    expect(recallText(await recall(ids, ids.noor, at))).toContain("quitting_job");
  });
});
