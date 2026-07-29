import { and, asc, eq, inArray } from "drizzle-orm";
import { simulationActionDefinitionSchema } from "@/contracts/simulation/activities";
import { METER_FIXED_POINT_ONE } from "@/contracts/simulation/bodies";
import type { PhysicalLocus } from "@/contracts/simulation/space";
import { buildMeterView, integrateMeterValue } from "@/lib/simulation/bodies";
import { isStandingCoPresentEngagement } from "@/lib/simulation/engagements";
import { humanizeId } from "@/lib/simulation/humanize";
import { parseOr } from "@/lib/parse";
import { deriveRelationshipRead } from "@/lib/simulation/social";
import {
  actorWhereabouts,
  buildWorldActions,
  buildWorldDestinations,
  buildWorldPlaceOrTransit,
  type SimChatWorld,
  type SimWorldCastMember,
  type WhereaboutsLocus,
  type WorldActionCandidate,
} from "@/lib/simulation/world-read";
import {
  db,
  simActionDefinitions,
  simBranches,
  simCharacters,
  simItemHoldings,
  simItems,
  simPhysicalLoci,
  simZones,
} from "@/server/db";
import { readChatEngineAuthority } from "./chat-authority";
import { log } from "../log";
import {
  loadActorBody,
  loadAuthoredPriorWeights,
  loadDyadLedgerEntries,
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
 * A zone's display label from its kind — the display NOUN, humanizing the raw
 * zone id only when the kind is unknown. The one `zoneLabelOf` both the world
 * read and the world-beat writer resolve through (charter law — never a raw id).
 */
export function zoneLabelFromKind(zoneId: string, kind: string): string {
  const noun = zoneDisplayNoun(kind);
  return noun.length > 0 ? noun : humanizeId(zoneId);
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
  const branchId = authority.simBranchId;
  const playerActorId = authority.simPlayerActorId;
  const primaryActorId = authority.simPrimaryActorId;
  try {
    const rows = await db()
      .select({ actorId: simPhysicalLoci.actorId, kind: simPhysicalLoci.kind, zoneId: simPhysicalLoci.zoneId })
      .from(simPhysicalLoci)
      .where(
        and(
          eq(simPhysicalLoci.branchId, branchId),
          inArray(simPhysicalLoci.actorId, [playerActorId, primaryActorId]),
        ),
      );
    const player = rows.find((row) => row.actorId === playerActorId);
    const primary = rows.find((row) => row.actorId === primaryActorId);
    if (!player || !primary) return null;
    // Resolve the primary's zone phrase only when it can matter (not co-present) —
    // the shared decision below turns it into present / on-the-move / elsewhere.
    const coPresent = player.kind === "at" && primary.kind === "at" && primary.zoneId === player.zoneId;
    let primaryZonePhrase = "elsewhere";
    if (!coPresent && primary.kind === "at" && primary.zoneId !== null) {
      const [zone] = await db()
        .select({ kind: simZones.kind })
        .from(simZones)
        .where(and(eq(simZones.branchId, branchId), eq(simZones.zoneId, primary.zoneId)));
      primaryZonePhrase = (zone && ZONE_KIND_LABELS[zone.kind]) ?? "elsewhere";
    }
    return actorWhereabouts({
      actorLocus: { kind: primary.kind, zoneId: primary.zoneId },
      playerLocus: { kind: player.kind, zoneId: player.zoneId },
      zonePhraseOf: () => primaryZonePhrase,
    });
  } catch (error) {
    log.warn("engine.sim", "presence read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
    const [space, engagements, nameRows, heldRows, actionRows] = await Promise.all([
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
      db()
        .select({ payload: simActionDefinitions.payload })
        .from(simActionDefinitions)
        .where(eq(simActionDefinitions.branchId, branchId))
        .orderBy(asc(simActionDefinitions.actionDefinitionId)),
    ]);

    // Zone labels come from the projection's own zone KINDS (the schema has no
    // zone-name column — the same humane source the render prompt uses), so no
    // raw zone id reaches the card.
    const kindByZone = new Map<string, string>(space.zones.map((zone) => [zone.id, zone.kind]));
    const privacyByZone = new Map<string, string>(space.zones.map((zone) => [zone.id, zone.privacyPolicy]));
    const locusByActor = new Map<string, PhysicalLocus>(space.loci.map((locus) => [locus.actorId, locus]));
    const zoneLabelOf = (zoneId: string): string => zoneLabelFromKind(zoneId, kindByZone.get(zoneId) ?? "");
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
        return {
          actorId: row.characterId,
          name: row.name,
          whereabouts,
          present,
          isPrimary: row.characterId === primaryActorId,
        };
      });

    // Player-startable actions (slice 3): availability is the `at_zone_kind`
    // law against the player's CURRENT zone kind. A malformed authored payload
    // is dropped (parseOr → null), never a thrown read.
    const playerZoneKind = playerLocus?.kind === "at" ? (kindByZone.get(playerLocus.zoneId) ?? null) : null;
    const candidates: WorldActionCandidate[] = actionRows.flatMap((row) => {
      const definition = parseOr(simulationActionDefinitionSchema.nullable(), row.payload, null, undefined, "sim_action_definitions.payload");
      if (!definition) return [];
      return [
        {
          id: definition.id,
          ...(definition.label === undefined ? {} : { label: definition.label }),
          controllerKinds: definition.controllerKinds,
          durationSeconds: definition.duration.seconds,
          requiredZoneKinds: definition.preconditions.flatMap((precondition) =>
            precondition.kind === "at_zone_kind" ? [precondition.zoneKind] : [],
          ),
          needsConsent: definition.preconditions.some((precondition) => precondition.kind === "consent_covered"),
        },
      ];
    });
    const actions = buildWorldActions({ candidates, playerZoneKind });

    const sceneOpen = engagements.engagements.some((engagement) =>
      isStandingCoPresentEngagement(engagement, playerActorId, primaryActorId),
    );

    return {
      place,
      transit,
      cast,
      destinations,
      held: heldRows.map((row) => ({ itemId: row.itemId, name: row.name })),
      actions,
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
 * a routed chat. Integrated on read (sim-read-seam-guards.plan.md slice 2): each
 * meter drifts from its last material write to the branch clock through the
 * shared `buildMeterView` seam (modifiers + §25.5 self-care folded in, exactly
 * as the command path integrates), so a chip that has drifted for hours reads
 * NOW, not as of its last event. Null for legacy/shadow lanes or when the
 * mirror actor has no meters; degrades to null (a hidden chip, never a 500) on
 * any internal throw.
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
  const branchId = authority.simBranchId;
  const primaryActorId = authority.simPrimaryActorId;
  try {
    // The branch clock is the integrate target — a narrower per-actor load
    // (WITH rhythms, unlike the branch projection) is all the strip needs.
    const [branch] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, branchId));
    if (!branch) return null;
    const storySecond = branch.storySecond;
    const body = await loadActorBody(db(), branchId, primaryActorId);
    if (body.meters.length === 0) return null;
    const integrated: Record<string, number> = {};
    for (const meter of body.meters) {
      // Integrate only to now — never the future — so the self-care horizon
      // need only reach the branch clock.
      const view = buildMeterView(body, meter.meterKey, storySecond);
      if (!view) continue;
      integrated[meter.meterKey] = integrateMeterValue(view, storySecond) / METER_FIXED_POINT_ONE;
    }
    if (Object.keys(integrated).length === 0) return null;
    return integrated;
  } catch (error) {
    log.warn("engine.sim", "meters read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
  const playerActorId = authority.simPlayerActorId;
  const primaryActorId = authority.simPrimaryActorId;
  try {
    const [branch] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, branchId));
    if (!branch) return null;
    const [towardPrimary, towardPlayer] = await Promise.all([
      loadDyadLedgerEntries(db(), branchId, playerActorId, primaryActorId),
      loadDyadLedgerEntries(db(), branchId, primaryActorId, playerActorId),
    ]);
    if (towardPrimary.length === 0 && towardPlayer.length === 0) return null;
    const authoredPriorWeights = await loadAuthoredPriorWeights(db(), branchId, towardPrimary);
    const read = deriveRelationshipRead({
      entries: towardPrimary,
      subjectActorId: primaryActorId,
      aboutActorId: playerActorId,
      atStorySecond: branch.storySecond,
      authoredPriorWeights,
    });
    const priorCount =
      towardPrimary.filter((entry) => entry.kind === "authored_prior").length +
      towardPlayer.filter((entry) => entry.kind === "authored_prior").length;
    const livedEntries = towardPrimary.length + towardPlayer.length - priorCount;
    const familiarity = Math.min(100, (priorCount > 0 ? 40 : 0) + livedEntries * 6);
    return { regard: regardFromRead(read), familiarity };
  } catch (error) {
    log.warn("engine.sim", "relationship read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
  const branchId = authority.simBranchId;
  const primaryActorId = authority.simPrimaryActorId;
  try {
    const rows = await db()
      .select({ name: simItems.name })
      .from(simItemHoldings)
      .innerJoin(
        simItems,
        and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
      )
      .where(
        and(
          eq(simItemHoldings.branchId, branchId),
          eq(simItemHoldings.locusKind, "worn"),
          eq(simItemHoldings.actorId, primaryActorId),
        ),
      )
      .orderBy(asc(simItemHoldings.slotKey));
    return rows.map((row) => row.name).join(", ");
  } catch (error) {
    log.warn("engine.sim", "outfit read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
