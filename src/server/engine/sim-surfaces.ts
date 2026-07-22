import { and, asc, eq, inArray } from "drizzle-orm";
import { METER_FIXED_POINT_ONE } from "@/contracts/simulation/bodies";
import { deriveRelationshipRead } from "@/lib/simulation/social";
import { db, simBranches, simItemHoldings, simItems, simPhysicalLoci, simZones } from "@/server/db";
import { readChatEngineAuthority } from "./chat-authority";
import { loadAuthoredPriorWeights, loadDyadLedgerEntries, readDurableBodies } from "./simulation";

/**
 * R5 — successor chats shed their legacy hybrids, surface by surface
 * (engine.rollout.plan.md, re-framed 2026-07-22): these are the read seams
 * the chat UI's envelopes call for ROUTED chats instead of legacy chat-state
 * rows. Slice 3 is presence/space (roster presence from the mirror's
 * physical loci); slice 4 is bodies & meters (the strip's meter chips from
 * the ruling-15 substrate). Legacy chats never reach these — their rows stay
 * authoritative until R6.
 */

export interface SimChatPresence {
  /** True when the pair is physically co-located (both `at` the same zone). */
  present: boolean;
  /** "" when co-present; else a short phrase ("on the move", "at the town square"). */
  whereabouts: string;
}

/** Human phrases for zone kinds — grows with the world templates. */
const ZONE_KIND_LABELS: Record<string, string> = {
  home: "at home",
  plaza: "at the town square",
  town: "in town",
};

/**
 * Slice 3: the primary character's REAL presence for a routed chat — where
 * their body is in the mirror world relative to the player's, never the
 * legacy chat-state flag. Null for legacy and shadow lanes (their display
 * stays legacy).
 */
export async function readSimChatPresence(chatId: string): Promise<SimChatPresence | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPlayerActorId ||
    !authority.simPrimaryActorId
  ) {
    return null;
  }
  const rows = await db()
    .select({ actorId: simPhysicalLoci.actorId, kind: simPhysicalLoci.kind, zoneId: simPhysicalLoci.zoneId })
    .from(simPhysicalLoci)
    .where(
      and(
        eq(simPhysicalLoci.branchId, authority.simBranchId),
        inArray(simPhysicalLoci.actorId, [authority.simPlayerActorId, authority.simPrimaryActorId]),
      ),
    );
  const player = rows.find((row) => row.actorId === authority.simPlayerActorId);
  const primary = rows.find((row) => row.actorId === authority.simPrimaryActorId);
  if (!player || !primary) return null;
  if (primary.kind === "in_transit") return { present: false, whereabouts: "on the move" };
  if (player.kind === "at" && primary.zoneId === player.zoneId) return { present: true, whereabouts: "" };
  let label = "elsewhere";
  if (primary.zoneId !== null) {
    const [zone] = await db()
      .select({ kind: simZones.kind })
      .from(simZones)
      .where(and(eq(simZones.branchId, authority.simBranchId), eq(simZones.zoneId, primary.zoneId)));
    label = (zone && ZONE_KIND_LABELS[zone.kind]) ?? "elsewhere";
  }
  return { present: false, whereabouts: label };
}

/**
 * Slice 4: the primary actor's body meters from the ruling-15 substrate, on
 * the chat's 0..1 scale — the strip's mood/meter chips derive from THESE for
 * a routed chat. Stored values (integrate-on-read is the named refinement);
 * null for legacy/shadow lanes or when the mirror actor has no meters.
 */
export async function readSimChatMeters(chatId: string): Promise<Record<string, number> | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPrimaryActorId
  ) {
    return null;
  }
  const bodies = await readDurableBodies(authority.simBranchId);
  const meters = bodies.meters.filter((meter) => meter.actorId === authority.simPrimaryActorId);
  if (meters.length === 0) return null;
  return Object.fromEntries(meters.map((meter) => [meter.meterKey, meter.valueFixedPoint / METER_FIXED_POINT_ONE]));
}

/**
 * Slice 7 (relationships): map the §21 read's fixed-point axes onto the
 * chip's −100..100 regard scale. Monotone and deliberately simple — trust
 * leads, attraction warms, resentment cools; the divisor aligns the ±3 000
 * strong-band threshold with regard ≈ ±75. Tuning rides later; the point is
 * the chip MOVES with world truth instead of freezing at the seed.
 */
function regardFromRead(read: { trustFixedPoint: number; attractionFixedPoint: number; resentmentFixedPoint: number }): number {
  const blended = read.trustFixedPoint + read.attractionFixedPoint / 2 - read.resentmentFixedPoint / 2;
  return Math.max(-100, Math.min(100, Math.round(blended / 40)));
}

export interface SimChatRelationship {
  /** −100..100, derived from the §21 ledger (trust/attraction/resentment). */
  regard: number;
  /** 0..100 — authored-prior floor + accumulated dyad evidence. */
  familiarity: number;
}

/**
 * Slice 7: the primary's disposition toward the player from the RELATIONSHIP
 * LEDGER — directional evidence of what the player did (promises kept,
 * boundaries respected, scenes shared…) folded through §21's read, with
 * authored-prior weights honored. Null for legacy/shadow lanes or an empty
 * ledger with no authored prior (the legacy seed then keeps the chip).
 */
export async function readSimChatRelationship(chatId: string): Promise<SimChatRelationship | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPlayerActorId ||
    !authority.simPrimaryActorId
  ) {
    return null;
  }
  const branchId = authority.simBranchId;
  const [branch] = await db()
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId));
  if (!branch) return null;
  const [towardPrimary, towardPlayer] = await Promise.all([
    loadDyadLedgerEntries(db(), branchId, authority.simPlayerActorId, authority.simPrimaryActorId),
    loadDyadLedgerEntries(db(), branchId, authority.simPrimaryActorId, authority.simPlayerActorId),
  ]);
  if (towardPrimary.length === 0 && towardPlayer.length === 0) return null;
  const authoredPriorWeights = await loadAuthoredPriorWeights(db(), branchId, towardPrimary);
  const read = deriveRelationshipRead({
    entries: towardPrimary,
    subjectActorId: authority.simPrimaryActorId,
    aboutActorId: authority.simPlayerActorId,
    atStorySecond: branch.storySecond,
    authoredPriorWeights,
  });
  const priorCount =
    towardPrimary.filter((entry) => entry.kind === "authored_prior").length +
    towardPlayer.filter((entry) => entry.kind === "authored_prior").length;
  const livedEntries = towardPrimary.length + towardPlayer.length - priorCount;
  const familiarity = Math.min(100, (priorCount > 0 ? 40 : 0) + livedEntries * 6);
  return { regard: regardFromRead(read), familiarity };
}

/**
 * Slice 5: the primary's outfit from world truth — the names of the items
 * WORN by the mapped actor in the mirror, slot-ordered. "" when they wear
 * nothing (the honest empty chip); null for legacy/shadow lanes.
 */
export async function readSimChatOutfit(chatId: string): Promise<string | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPrimaryActorId
  ) {
    return null;
  }
  const rows = await db()
    .select({ name: simItems.name })
    .from(simItemHoldings)
    .innerJoin(
      simItems,
      and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
    )
    .where(
      and(
        eq(simItemHoldings.branchId, authority.simBranchId),
        eq(simItemHoldings.locusKind, "worn"),
        eq(simItemHoldings.actorId, authority.simPrimaryActorId),
      ),
    )
    .orderBy(asc(simItemHoldings.slotKey));
  return rows.map((row) => row.name).join(", ");
}
