import { and, asc, eq, inArray } from "drizzle-orm";
import { simulationActionDefinitionSchema } from "@vesper/simulation-core/contracts/activities";
import { METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import type { PhysicalLocus } from "@vesper/simulation-core/contracts/space";
import { buildMeterView, integrateMeterValue } from "@vesper/simulation-core/bodies";
import { isStandingCoPresentEngagement } from "@vesper/simulation-core/engagements";
import { humanizeId } from "@vesper/simulation-core/humanize";
import { parseOr } from "@/lib/parse";
import { deriveRelationshipRead } from "@vesper/simulation-core/social";
import {
  actorWhereabouts,
  buildWorldActions,
  buildWorldDestinations,
  buildWorldPlaceOrTransit,
  type SimChatWorld,
  type SimWorldCastMember,
  type WhereaboutsLocus,
  type WorldActionCandidate,
} from "@vesper/simulation-core/world-read";
import {
  buildGarmentDigest,
  exposedRegions,
  FULLY_COVERED,
  garmentEffectiveCoverage,
  garmentReadout,
  renderGarmentDigest,
  type GarmentReadout,
  type RegionExposure,
  type WornItemInput,
} from "@/contracts";
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
  readActorGarmentInstances,
  readDurableEngagements,
  readDurableSpaceBranch,
  type SimGarmentRead,
} from "./simulation";

/**
 * Successor chats replace character-chat-owned surfaces with simulation
 * world truth, surface by surface. These are the read seams the chat UI's
 * envelopes call for routed
 * chats instead of character-chat state rows: presence/space
 * (roster presence from the mirror's physical loci), and bodies & meters
 * (the strip's meter chips from the simulation substrate). Character-chat-routed
 * conversations never reach these reads — their own state remains authoritative.
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
  // B8: the starter world's third zone. Without an entry here the market would
  // render as a humanized raw id — charter law says a display label is data.
  market: "at the market",
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
 * character-chat presence flag. Null for character-chat and shadow lanes.
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
 * The player-facing world envelope for a routed
 * chat — where the player is (or is walking to), who else is around and their
 * whereabouts, the open destinations they can walk to, what they're holding,
 * and whether a scene is standing. The `ChatWorldCard` draws THIS. Null for
 * character-chat/shadow lanes (no card) and, per docs/resilience.md, on any
 * internal degradation (a malformed projection degrades to null — the card
 * hides — never throws).
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
 * The primary actor's body meters from the simulation substrate, on
 * the chat's 0..1 scale — the strip's mood/meter chips derive from THESE for
 * a routed chat. Integrated on read: each
 * meter drifts from its last material write to the branch clock through the
 * shared `buildMeterView` seam (modifiers + self-care folded in, exactly
 * as the command path integrates), so a chip that has drifted for hours reads
 * NOW, not as of its last event. Null for character-chat/shadow lanes or when
 * the mirror actor has no meters; degrades to null (a hidden chip, never a 500)
 * on any internal throw.
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
    // Clock and body rows come from one snapshot, so a command committing
    // mid-read cannot integrate stale meters to a newer clock.
    const snapshot = await db().transaction(
      async (tx) => {
        const [branch] = await tx
          .select({ storySecond: simBranches.storySecond })
          .from(simBranches)
          .where(eq(simBranches.id, branchId));
        if (!branch) return null;
        return { storySecond: branch.storySecond, body: await loadActorBody(tx, branchId, primaryActorId) };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!snapshot) return null;
    const { storySecond, body } = snapshot;
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
 * Map the relationship read's fixed-point axes onto the
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
  /** −100..100, derived from the relationship ledger (trust/attraction/resentment). */
  regard: number;
  /** 0..100 — authored-prior floor + accumulated dyad evidence. */
  familiarity: number;
}

/**
 * The primary's disposition toward the player from the RELATIONSHIP
 * LEDGER — directional evidence of what the player did (promises kept,
 * boundaries respected, scenes shared…) folded through the ledger read, with
 * authored-prior weights honored. Null for character-chat/shadow lanes or an
 * empty ledger with no authored prior (the character-chat seed then keeps the
 * chip).
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
    // Clock, both ledger directions, and the authored priors come from one
    // snapshot, so a command committing mid-read cannot leave the read
    // straddling two ledger states.
    const snapshot = await db().transaction(
      async (tx) => {
        const [branch] = await tx
          .select({ storySecond: simBranches.storySecond })
          .from(simBranches)
          .where(eq(simBranches.id, branchId));
        if (!branch) return null;
        const towardPrimary = await loadDyadLedgerEntries(tx, branchId, playerActorId, primaryActorId);
        const towardPlayer = await loadDyadLedgerEntries(tx, branchId, primaryActorId, playerActorId);
        if (towardPrimary.length === 0 && towardPlayer.length === 0) return null;
        const authoredPriorWeights = await loadAuthoredPriorWeights(tx, branchId, towardPrimary);
        return { storySecond: branch.storySecond, towardPrimary, towardPlayer, authoredPriorWeights };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!snapshot) return null;
    const { storySecond, towardPrimary, towardPlayer, authoredPriorWeights } = snapshot;
    const read = deriveRelationshipRead({
      entries: towardPrimary,
      subjectActorId: primaryActorId,
      aboutActorId: playerActorId,
      atStorySecond: storySecond,
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
 * Slice 5: the primary's outfit from world truth — the names of the items WORN
 * by the mapped actor in the mirror, slot-ordered. A known-empty worn set is
 * returned as the explicit phrase "no clothing" so downstream truthy-string
 * transport cannot collapse "wearing nothing" into "wardrobe unavailable".
 * Null is reserved for character-chat/shadow lanes or a degraded read.
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
    const names = rows.map((row) => row.name.trim()).filter(Boolean);
    return names.length > 0 ? names.join(", ") : "no clothing";
  } catch (error) {
    log.warn("engine.sim", "outfit read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * #297: the primary's clothing state as the shared garment digest — the SAME
 * read `readSimChatOutfit` degrades against, upgraded structural whenever the
 * worn set resolves reliable construction. One read produces the narrator
 * digest, the state-tools-shaped readouts, and the coverage-derived exposure,
 * so narration and an exposure/image consumer can never disagree about what
 * is worn (docs/engine/materials.md §Garments).
 */

/** Diagnostic when no worn item resolves a reliable blueprint — the read falls back to the name list. */
export const SIM_GARMENT_MAPPING_UNRESOLVED = "sim_garment.mapping_unresolved";

/** The digest, readouts and exposure all derive from one resolved, fully-reliable-or-better worn set. */
export interface SimChatGarmentsStructured {
  status: "structured";
  /** `renderGarmentDigest`'s block — bands only, carries its own authority sentence. */
  digest: string;
  /** Per-garment readouts, worn-slot order — the state-tools/inspector shape. */
  readouts: GarmentReadout[];
  /**
   * Bare/sheer/covered per region, derived from the SAME readouts. `FULLY_COVERED`
   * whenever any worn item's blueprint is unreliable — a partially-degraded
   * wardrobe must never expose a region a broken row merely failed to cover.
   */
  exposure: RegionExposure;
  /** False when at least one worn item could not resolve a trustworthy blueprint (a mixed wardrobe). */
  reliable: boolean;
}

/** A known-empty worn set — distinct from `null` (unavailable/not applicable), per docs/resilience.md §1. */
export interface SimChatGarmentsEmpty {
  status: "empty";
}

/** No worn item resolved a reliable blueprint at all — the existing name list, never a bare claim. */
export interface SimChatGarmentsFallback {
  status: "fallback";
  reason: string;
  names: string;
}

export type SimChatGarments = SimChatGarmentsStructured | SimChatGarmentsEmpty | SimChatGarmentsFallback;

/**
 * One resolved garment as an `exposedRegions` input row.
 *
 * The successor blueprint carries no absolute layer or per-garment opacity —
 * those are chat-lane library-ITEM-definition fields (`item.layer`,
 * `item.opacity`), and a sim item has no such definition to read them from.
 * `exposedRegions` never consults `layer` (only `resolveWardrobeVisibility`'s
 * cross-garment occlusion does, which this read does not attempt), so the
 * placeholder there is inert. Defaulting every garment's `opacity` to
 * `"opaque"` is the conservative reading `docs/resilience.md`'s
 * covered-not-bare rule asks for: it can only UNDER-state exposure (a sheer
 * piece reads "covered" instead of "sheer"), never manufacture a bare region
 * the sim has no data for.
 */
function garmentExposureInput(garment: SimGarmentRead): WornItemInput {
  return {
    instanceId: garment.instance.id,
    garmentId: garment.instance.id,
    name: garment.instance.name,
    coverage: garmentEffectiveCoverage(garment.instance, garment.blueprint).covers,
    layer: 1,
    opacity: "opaque",
  };
}

/**
 * The primary's structured clothing state for a routed chat (#297): #295's
 * adapter resolved to the shared digest, readouts and exposure. Same authority
 * guard and try/log.warn/null degradation as `readSimChatOutfit` — `null` only
 * for a non-sim lane or a thrown read.
 *
 * - Zero worn items ⇒ `"empty"` (known-empty, never confused with `null`).
 * - Every worn item unreliable ⇒ `"fallback"`, carrying the name list a reader
 *   already trusts and the `sim_garment.mapping_unresolved` diagnostic.
 * - Otherwise ⇒ `"structured"`, even when SOME items are unreliable (mixed):
 *   the digest and readouts still cover every worn item, but `reliable` is
 *   false and `exposure` degrades to `FULLY_COVERED` rather than trusting the
 *   readable remainder alone.
 */
export async function readSimChatGarments(chatId: string): Promise<SimChatGarments | null> {
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
    const [primaryRow] = await db()
      .select({ name: simCharacters.name })
      .from(simCharacters)
      .where(and(eq(simCharacters.branchId, branchId), eq(simCharacters.characterId, primaryActorId)))
      .limit(1);
    const primaryName = primaryRow?.name.trim() || "they";

    // One repeatable-read snapshot for the branch clock and the garment rows —
    // the same discipline `readSimChatMeters` uses — so the `atMinutes` stamp
    // `garmentReadout` integrates to can never straddle a command that commits
    // mid-read.
    const snapshot = await db().transaction(
      async (tx) => {
        const [branch] = await tx
          .select({ storySecond: simBranches.storySecond })
          .from(simBranches)
          .where(eq(simBranches.id, branchId));
        if (!branch) return null;
        return {
          storySecond: branch.storySecond,
          adapter: await readActorGarmentInstances(tx, branchId, primaryActorId),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (!snapshot) return null;
    const { storySecond, adapter } = snapshot;

    if (adapter.garments.length === 0) return { status: "empty" };

    if (adapter.garments.every((garment) => !garment.reliable)) {
      const names = adapter.instances.map((instance) => instance.name.trim()).filter(Boolean).join(", ");
      log.warn("engine.sim", "garment read fell back to the name list", {
        chatId,
        code: SIM_GARMENT_MAPPING_UNRESOLVED,
        adapterCodes: [...new Set(adapter.diagnostics.map((diagnostic) => diagnostic.code))],
      });
      return { status: "fallback", reason: SIM_GARMENT_MAPPING_UNRESOLVED, names };
    }

    const atMinutes = Math.floor(storySecond / 60);
    const readouts = adapter.garments.map((garment) =>
      garmentReadout(garment.instance, garment.blueprint, { atMinutes }),
    );
    const digest = renderGarmentDigest(buildGarmentDigest({ actors: [{ label: primaryName, readouts }] }));
    const reliable = adapter.reliable;
    if (!reliable) {
      // Some worn item resolved no trustworthy blueprint: the digest still
      // renders, but exposure degrades to fully covered, and that degradation
      // is recorded like the fallback arm's rather than passing silently.
      log.warn("engine.sim", "garment read partially unreliable — exposure degraded to fully covered", {
        chatId,
        adapterCodes: [...new Set(adapter.diagnostics.map((diagnostic) => diagnostic.code))],
      });
    }
    const exposure = reliable ? exposedRegions(adapter.garments.map(garmentExposureInput)) : FULLY_COVERED;
    return { status: "structured", digest, readouts, exposure, reliable };
  } catch (error) {
    log.warn("engine.sim", "garments read degraded to null", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
