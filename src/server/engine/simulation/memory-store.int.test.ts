import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import type { MemoryRecallResponse } from "@/contracts/simulation/memory";
import { proposedArmedEffectSchema } from "@/contracts/simulation/narrative";
import { newId } from "@/lib/ids";
import { deriveEngagementId } from "@/lib/simulation";
import { db, simSoftCanon, simWorlds } from "@/server/db";
import { prepareEngagementTurn, submitDurableConfirmNarratorResult } from "./arbiter-store";
import { forkBranch } from "./branch-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { seedDurableItemTransferBranch } from "./item-transfer-store";
import { submitDurableMakeDisclosure } from "./knowledge-store";
import {
  drainMemoryIndexOutbox,
  memoryIndexLag,
  rebuildMemoryIndex,
  seedAuthoredLoreDocuments,
  type MemoryEmbedder,
} from "./memory-index-store";
import { queryMemoryDocuments } from "./memory-query-store";
import { seedDurableSpaceTopology } from "./space-store";
import { submitDurableDemoteSoftCanon } from "./soft-canon-store";

/**
 * E4.4 integration: outbox-driven indexing, the §24.1 eligibility-before-
 * similarity pipeline, relational supersedence, fork-ancestry recall with
 * divergence, lag diagnostics, and the stubbed embedding seam — zero model
 * calls anywhere.
 */

const SEED_SECOND = 100_000;
const TURN_SPAN = 400;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_memory_documents limit 1`),
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
      `[memory-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

/** Cafe (hall + shop) and a park: iris overhears from the shop, noor is away. */
interface MemoryCase {
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

function branchProjection(ids: MemoryCase): ItemTransferProjection {
  return itemTransferProjectionSchema.parse({
    worldId: ids.worldId,
    branchId: ids.branchId,
    rulesetVersion: "e4-4-test-v1",
    version: 0,
    headSequence: 0,
    storySecond: SEED_SECOND,
    actors: [
      { id: ids.player, name: "Pia", observedContainerIds: [] },
      { id: ids.mara, name: "Mara", observedContainerIds: [] },
      { id: ids.iris, name: "Iris", observedContainerIds: [] },
      { id: ids.noor, name: "Noor", observedContainerIds: [] },
    ],
    containers: [],
    items: [],
    observations: [],
  });
}

async function seedMemoryCase(): Promise<MemoryCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: MemoryCase = {
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
  await seedDurableItemTransferBranch(branchProjection(ids), {
    worldTypeId: "e4-4-tests",
    worldSeed: `seed-${worldId}`,
  });
  await seedDurableSpaceTopology({
    branchId,
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
    loci: [
      { kind: "at", actorId: ids.player, locationId: ids.locCafe, zoneId: ids.zoneCafe, since: SEED_SECOND },
      { kind: "at", actorId: ids.mara, locationId: ids.locCafe, zoneId: ids.zoneCafe, since: SEED_SECOND },
      { kind: "at", actorId: ids.iris, locationId: ids.locCafe, zoneId: ids.zoneShop, since: SEED_SECOND },
      { kind: "at", actorId: ids.noor, locationId: ids.locPark, zoneId: ids.zonePark, since: SEED_SECOND },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

function command(
  ids: MemoryCase,
  name: string,
  type: string,
  principal: { kind: string; principalId: string; controlledActorIds: string[] },
  payload: Record<string, unknown>,
) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type,
    schemaVersion: type === "confirm_narrator_result" ? 2 : 1,
    payload,
  };
}

const admit = { admitAtLockedVersion: true };

async function openChat(ids: MemoryCase): Promise<string> {
  const opened = await submitDurableOpenEngagement(
    command(
      ids,
      "chat",
      "open_engagement",
      { kind: "player", principalId: "player-1", controlledActorIds: [ids.player] },
      { participantIds: [ids.player, ids.mara].sort(), channel: "co_present" },
    ),
    admit,
  );
  expect(opened.status).toBe("accepted");
  return deriveEngagementId(ids.branchId, `cmd-chat-${ids.branchId}`);
}

/** One rendered turn where Mara confides she is quitting, plus a nickname. */
async function confideQuitting(
  ids: MemoryCase,
  engagementId: string,
  options: { softCanon?: boolean } = {},
): Promise<{ throughStorySecond: number }> {
  const turn = await prepareEngagementTurn({
    branchId: ids.branchId,
    engagementId,
    viewpointActorId: ids.player,
    spanSeconds: TURN_SPAN,
    workerId: "w-e4-4",
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
  const disclosureEffect = turn.cut.armedEffects.find((effect) => effect.effectType === "disclosure_made");
  if (!disclosureEffect) throw new Error("Disclosure effect missing from cut");
  const confirmed = await submitDurableConfirmNarratorResult(
    command(
      ids,
      "confirm-quitting",
      "confirm_narrator_result",
      { kind: "system", principalId: "system-1", controlledActorIds: [] },
      {
        engagementId,
        cutId: turn.cut.id,
        enactedArmedEffectIds: [disclosureEffect.id],
        softCanonProposals:
          options.softCanon === true
            ? [
                {
                  key: "nickname_for_player",
                  value: "stray",
                  scope: "relationship",
                  subjectIds: [ids.mara, ids.player].sort(),
                  confidenceFixedPoint: 9_000,
                  sourceCutId: turn.cut.id,
                },
              ]
            : [],
      },
    ),
    admit,
  );
  expect(confirmed.status).toBe("accepted");
  return { throughStorySecond: turn.cut.throughStorySecond };
}

function query(
  ids: MemoryCase,
  viewpointActorId: string,
  atStorySecond: number,
  extra: Record<string, unknown> = {},
  branchId = ids.branchId,
): Promise<MemoryRecallResponse> {
  return queryMemoryDocuments({
    branchId,
    viewpointActorId,
    atStorySecond,
    limit: 32,
    maxCandidates: 256,
    ...extra,
  });
}

function texts(response: MemoryRecallResponse): string {
  return response.results.map((result) => result.text).join(" | ");
}

describe.runIf(ready)("E4.4 memory indexing and eligibility-before-similarity", () => {
  it("indexes from the outbox with visible lag, then gates recall by eligibility — similarity never widens it (§24.1, §24.3)", async () => {
    const ids = await seedMemoryCase();
    const engagementId = await openChat(ids);
    const { throughStorySecond } = await confideQuitting(ids, engagementId);
    const at = throughStorySecond;

    // §24.3: before the consumer runs, the lag is visible, not inferred.
    const before = await memoryIndexLag(ids.branchId);
    expect(before.pendingObligations).toBeGreaterThan(0);
    const early = await query(ids, ids.player, at);
    expect(early.diagnostics.pendingObligations).toBeGreaterThan(0);

    const drained = await drainMemoryIndexOutbox({ workerId: "w-drain" });
    expect(drained.failed).toBe(0);
    expect(drained.completed).toBeGreaterThan(0);
    const after = await memoryIndexLag(ids.branchId);
    expect(after.pendingObligations).toBe(0);
    expect(after.indexedThroughSequence).toBe(after.headSequence);

    await seedAuthoredLoreDocuments({
      branchId: ids.branchId,
      seeds: [
        {
          loreId: "lore-cafe-history",
          text: "The cafe has stood on this corner for forty years.",
          visibility: "public",
          eligibleActorIds: [],
          aboutEntityIds: [ids.locCafe],
          validFromSecond: 0,
        },
        {
          loreId: "lore-player-past",
          text: "Pia once worked the harbor markets.",
          visibility: "actors",
          eligibleActorIds: [ids.player],
          aboutEntityIds: [ids.player],
          validFromSecond: 0,
        },
      ],
    });

    // The listener recalls the confidence as belief, speech, and observation
    // — every result labeled and linked to its source (§24.1 step 7).
    const player = await query(ids, ids.player, at);
    const playerKinds = new Set(player.results.map((result) => result.sourceKind));
    expect(playerKinds.has("belief")).toBe(true);
    expect(playerKinds.has("speech_act")).toBe(true);
    expect(playerKinds.has("observation")).toBe(true);
    expect(playerKinds.has("authored_lore")).toBe(true);
    expect(texts(player)).toContain("quitting_job");
    const beliefResult = player.results.find((result) => result.sourceKind === "belief");
    expect(beliefResult).toMatchObject({ epistemicLabel: "believed", confidenceFixedPoint: 9_000 });
    expect(beliefResult?.sourceEventId).toBeDefined();

    // The muffled bystander holds evidence of talking, never the content.
    const iris = await query(ids, ids.iris, at);
    expect(texts(iris)).not.toContain("quitting");
    expect(iris.results.some((result) => result.epistemicLabel === "glimpsed")).toBe(true);
    expect(texts(iris)).toContain("forty years");
    expect(texts(iris)).not.toContain("harbor markets");

    // Someone in another location recalls nothing private — and asking the
    // right question does not change that (§24.1: similarity never widens).
    const noor = await query(ids, ids.noor, at, { queryText: "mara quitting her job" });
    expect(texts(noor)).not.toContain("quitting");
    expect(noor.results.every((result) => result.sourceKind === "authored_lore")).toBe(true);

    // Rebuild parity: the derived index reproduces the same recall.
    const playerBefore = await query(ids, ids.player, at);
    await rebuildMemoryIndex(ids.branchId);
    const playerAfter = await query(ids, ids.player, at);
    expect(playerAfter.results).toEqual(playerBefore.results);
  });

  it("narrows recall relationally on retraction and demotion — never by similarity (§24.2 active-only)", async () => {
    const ids = await seedMemoryCase();
    const engagementId = await openChat(ids);
    const { throughStorySecond } = await confideQuitting(ids, engagementId, { softCanon: true });
    await drainMemoryIndexOutbox({ workerId: "w-drain" });

    const at = throughStorySecond;
    const before = await query(ids, ids.player, at);
    expect(texts(before)).toContain("quitting_job");
    expect(texts(before)).toContain("nickname_for_player");
    // The relationship-scoped detail belongs to its subjects only.
    const irisBefore = await query(ids, ids.iris, at);
    expect(texts(irisBefore)).not.toContain("nickname_for_player");

    // Mara takes it back where the player can hear it.
    const beliefDoc = before.results.find((result) => result.sourceKind === "belief");
    const assertionId = before.results.find((result) => result.sourceKind === "assertion")?.sourceId;
    expect(beliefDoc).toBeDefined();
    const retractTarget =
      assertionId ??
      (() => {
        throw new Error("Assertion doc missing before retraction");
      })();
    const retracted = await submitDurableMakeDisclosure(
      command(
        ids,
        "retract",
        "make_disclosure",
        { kind: "player", principalId: "npc-mara", controlledActorIds: [ids.mara] },
        {
          speakerActorId: ids.mara,
          targetActorIds: [ids.player],
          content: { kind: "retraction", assertionId: retractTarget },
        },
      ),
      admit,
    );
    expect(retracted.status).toBe("accepted");
    await drainMemoryIndexOutbox({ workerId: "w-drain" });

    const afterRetraction = await query(ids, ids.player, at + 1);
    expect(texts(afterRetraction)).not.toContain("quitting_job");
    expect(afterRetraction.results.some((result) => result.sourceKind === "belief")).toBe(false);
    expect(afterRetraction.results.some((result) => result.sourceKind === "assertion")).toBe(false);

    // Storyteller demotion retracts the established detail from recall too.
    const [entryRow] = await db()
      .select({ entryId: simSoftCanon.entryId })
      .from(simSoftCanon)
      .where(eq(simSoftCanon.branchId, ids.branchId))
      .limit(1);
    if (!entryRow) throw new Error("Soft canon entry missing");
    const demoted = await submitDurableDemoteSoftCanon(
      command(
        ids,
        "demote",
        "demote_soft_canon",
        { kind: "storyteller", principalId: "storyteller-1", controlledActorIds: [] },
        { entryId: entryRow.entryId, reason: "the nickname reads as demeaning" },
      ),
      admit,
    );
    expect(demoted.status).toBe("accepted");
    await drainMemoryIndexOutbox({ workerId: "w-drain" });
    const afterDemotion = await query(ids, ids.player, at + 2);
    expect(texts(afterDemotion)).not.toContain("nickname_for_player");
  });

  it("recalls inherited documents through fork ancestry, and divergence stays branch-local (R4)", async () => {
    const ids = await seedMemoryCase();
    const engagementId = await openChat(ids);
    const { throughStorySecond } = await confideQuitting(ids, engagementId);
    await drainMemoryIndexOutbox({ workerId: "w-drain" });
    const at = throughStorySecond;

    const parentRecall = await query(ids, ids.player, at);
    expect(texts(parentRecall)).toContain("quitting_job");
    const parentHead = (await memoryIndexLag(ids.branchId)).headSequence;

    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentHead,
      principal: { kind: "player", principalId: "player-1" },
      reason: "what if she takes it back",
    });

    // The child recalls its inheritance without any indexing of its own.
    const childRecall = await query(ids, ids.player, at, {}, childBranchId);
    expect(texts(childRecall)).toContain("quitting_job");

    // Divergence: Mara retracts only on the child timeline.
    const assertionId = childRecall.results.find((result) => result.sourceKind === "assertion")?.sourceId;
    if (!assertionId) throw new Error("Assertion doc missing on child");
    const retracted = await submitDurableMakeDisclosure(
      {
        ...command(
          ids,
          "retract-child",
          "make_disclosure",
          { kind: "player", principalId: "npc-mara", controlledActorIds: [ids.mara] },
          {
            speakerActorId: ids.mara,
            targetActorIds: [ids.player],
            content: { kind: "retraction", assertionId },
          },
        ),
        branchId: childBranchId,
      },
      admit,
    );
    expect(retracted.status).toBe("accepted");
    await drainMemoryIndexOutbox({ workerId: "w-drain" });

    const childAfter = await query(ids, ids.player, at + 1, {}, childBranchId);
    expect(texts(childAfter)).not.toContain("quitting_job");
    const parentAfter = await query(ids, ids.player, at + 1);
    expect(texts(parentAfter)).toContain("quitting_job");
  });

  it("embeds through the injected seam, ranks within the eligible set, and degrades to lexical recall on failure (§24.3)", async () => {
    const ids = await seedMemoryCase();
    const engagementId = await openChat(ids);
    const { throughStorySecond } = await confideQuitting(ids, engagementId);

    const unit = (hot: number): number[] => {
      const vector = new Array<number>(1_536).fill(0);
      vector[hot] = 1;
      return vector;
    };
    const stubEmbedder: MemoryEmbedder = (documentTexts) =>
      Promise.resolve({
        model: "stub-v1",
        vectors: documentTexts.map((text) => unit(text.includes("quitting") ? 0 : 1)),
      });
    const drained = await drainMemoryIndexOutbox({ workerId: "w-drain", embed: stubEmbedder });
    expect(drained.failed).toBe(0);

    const at = throughStorySecond;
    const vectorRecall = await query(ids, ids.player, at, {
      queryEmbedding: unit(0),
      queryEmbeddingModel: "stub-v1",
    });
    expect(vectorRecall.results[0]?.text).toContain("quitting");
    expect(vectorRecall.results[0]?.scoreFixedPoint).toBe(10_000);
    expect(vectorRecall.diagnostics.unembeddedEligible).toBe(0);

    // A broken embedder still indexes: the obligation completes, the document
    // lands text-only, lexical recall finds it, and the vector path reports
    // the gap instead of silently shrinking (§24.3 degradation).
    const gossip = await submitDurableMakeDisclosure(
      command(
        ids,
        "gossip-rent",
        "make_disclosure",
        { kind: "player", principalId: "npc-mara", controlledActorIds: [ids.mara] },
        {
          speakerActorId: ids.mara,
          targetActorIds: [ids.player],
          content: {
            kind: "claim",
            propositionKey: "rent_overdue",
            subjectIds: [ids.mara],
            claimedValue: { monthsBehind: 2 },
          },
        },
      ),
      admit,
    );
    expect(gossip.status).toBe("accepted");
    const failingEmbedder: MemoryEmbedder = () => Promise.reject(new Error("embedding service down"));
    const degraded = await drainMemoryIndexOutbox({ workerId: "w-drain", embed: failingEmbedder });
    expect(degraded.failed).toBe(0);
    expect(degraded.completed).toBeGreaterThan(0);

    const lexical = await query(ids, ids.player, at + 1, { queryText: "rent overdue months" });
    expect(lexical.results[0]?.text).toContain("rent_overdue");
    const vectorAfter = await query(ids, ids.player, at + 1, {
      queryEmbedding: unit(0),
      queryEmbeddingModel: "stub-v1",
    });
    expect(vectorAfter.diagnostics.unembeddedEligible).toBeGreaterThan(0);
  });
});
