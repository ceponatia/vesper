import { and, asc, eq, inArray } from "drizzle-orm";
import { METER_FIXED_POINT_ONE } from "@/contracts/simulation/bodies";
import type { PhysicalLocus } from "@/contracts/simulation/space";
import { isStandingCoPresentEngagement } from "@/lib/simulation/engagements";
import { humanizeId } from "@/lib/simulation/humanize";
import { deriveRelationshipRead } from "@/lib/simulation/social";
import {
  actorWhereabouts,
  buildWorldDestinations,
  buildWorldPlaceOrTransit,
  type SimChatWorld,
  type SimWorldCastMember,
  type WhereaboutsLocus,
} from "@/lib/simulation/world-read";
import { db, simBranches, simCharacters, simItemHoldings, simItems, simPhysicalLoci, simZones } from "@/server/db";
import { readChatEngineAuthority } from "./chat-authority";
import { log } from "../log";
import {
  loadAuthoredPriorWeights,
  loadDyadLedgerEntries,
  readDurableBodies,
  readDurableEngagements,
  readDurableSpaceBranch,
} from "./simulation";

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
 * The narrator's bare zone display NOUN for a kind — the roster-whereabouts phrase
 * (ZONE_KIND_LABELS) with its leading preposition stripped ("at the town square" →
 * "town square"), so the ONE kind→place map serves both the presence chip and the
 * render prompt's zone display names (`sim-render` wraps this as "at the {noun}").
 * "" for an unknown kind — the render then humanizes the raw zone id itself.
 */
export function zoneDisplayNoun(kind: string): string {
  const phrase = ZONE_KIND_LABELS[kind];
  if (!phrase) return "";
  return phrase.replace(/^(?:at the |at |in the |in |on the |on )/, "");
}

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
  // Resolve the primary's zone phrase only when it can matter (not co-present) —
  // the shared decision below turns it into present / on-the-move / elsewhere.
  const coPresent = player.kind === "at" && primary.kind === "at" && primary.zoneId === player.zoneId;
  let primaryZonePhrase = "elsewhere";
  if (!coPresent && primary.kind === "at" && primary.zoneId !== null) {
    const [zone] = await db()
      .select({ kind: simZones.kind })
      .from(simZones)
      .where(and(eq(simZones.branchId, authority.simBranchId), eq(simZones.zoneId, primary.zoneId)));
    primaryZonePhrase = (zone && ZONE_KIND_LABELS[zone.kind]) ?? "elsewhere";
  }
  return actorWhereabouts({
    actorLocus: { kind: primary.kind, zoneId: primary.zoneId },
    playerLocus: { kind: player.kind, zoneId: player.zoneId },
    zonePhraseOf: () => primaryZonePhrase,
  });
}

/**
 * Slice 1 (world-ui.plan.md): the player-facing world envelope for a routed
 * chat — where the player is (or is walking to), who else is around and their
 * whereabouts, the open destinations they can walk to, what they're holding,
 * and whether a scene is standing. The `ChatWorldCard` draws THIS. Null for
 * legacy/shadow lanes (no card) and, per docs/resilience.md, on any internal
 * degradation (a malformed projection degrades to null — the card hides —
 * never throws).
 */
export async function readSimChatWorld(chatId: string): Promise<SimChatWorld | null> {
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
  const playerActorId = authority.simPlayerActorId;
  const primaryActorId = authority.simPrimaryActorId;
  try {
    const [space, engagements, nameRows, heldRows] = await Promise.all([
      readDurableSpaceBranch(branchId),
      readDurableEngagements(branchId),
      db()
        .select({ characterId: simCharacters.characterId, name: simCharacters.name })
        .from(simCharacters)
        .where(eq(simCharacters.branchId, branchId))
        .orderBy(asc(simCharacters.characterId)),
      db()
        .select({ itemId: simItemHoldings.itemId, name: simItems.name })
        .from(simItemHoldings)
        .innerJoin(
          simItems,
          and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
        )
        .where(
          and(
            eq(simItemHoldings.branchId, branchId),
            eq(simItemHoldings.locusKind, "held"),
            eq(simItemHoldings.actorId, playerActorId),
          ),
        )
        .orderBy(asc(simItemHoldings.slotKey)),
    ]);

    // Zone labels come from the projection's own zone KINDS (the schema has no
    // zone-name column — the same humane source the render prompt uses), so no
    // raw zone id reaches the card.
    const kindByZone = new Map<string, string>(space.zones.map((zone) => [zone.id, zone.kind]));
    const privacyByZone = new Map<string, string>(space.zones.map((zone) => [zone.id, zone.privacyPolicy]));
    const locusByActor = new Map<string, PhysicalLocus>(space.loci.map((locus) => [locus.actorId, locus]));
    const zoneLabelOf = (zoneId: string): string => {
      const noun = zoneDisplayNoun(kindByZone.get(zoneId) ?? "");
      return noun.length > 0 ? noun : humanizeId(zoneId);
    };
    const zonePrivacyOf = (zoneId: string): string => privacyByZone.get(zoneId) ?? "public";
    const zonePhraseOf = (zoneId: string): string => ZONE_KIND_LABELS[kindByZone.get(zoneId) ?? ""] ?? "elsewhere";

    const playerLocus = locusByActor.get(playerActorId);
    const { place, transit } = buildWorldPlaceOrTransit({
      playerLocus,
      journeys: space.journeys,
      zoneLabelOf,
      zonePrivacyOf,
      atStorySecond: space.storySecond,
    });
    const destinations = buildWorldDestinations({ playerLocus, links: space.links, zoneLabelOf });

    const playerWhereabouts: WhereaboutsLocus | undefined = playerLocus
      ? { kind: playerLocus.kind, zoneId: playerLocus.kind === "at" ? playerLocus.zoneId : null }
      : undefined;
    const cast: SimWorldCastMember[] = nameRows
      .filter((row) => row.characterId !== playerActorId)
      .map((row) => {
        const locus = locusByActor.get(row.characterId);
        const actorLocus: WhereaboutsLocus | undefined = locus
          ? { kind: locus.kind, zoneId: locus.kind === "at" ? locus.zoneId : null }
          : undefined;
        const { present, whereabouts } = actorWhereabouts({ actorLocus, playerLocus: playerWhereabouts, zonePhraseOf });
        return { name: row.name, whereabouts, present };
      });

    const sceneOpen = engagements.engagements.some((engagement) =>
      isStandingCoPresentEngagement(engagement, playerActorId, primaryActorId),
    );

    return {
      place,
      transit,
      cast,
      destinations,
      held: heldRows.map((row) => ({ itemId: row.itemId, name: row.name })),
      sceneOpen,
    };
  } catch (error) {
    log.warn("engine.sim", "world read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
