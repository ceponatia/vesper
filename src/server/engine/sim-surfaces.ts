import { and, eq, inArray } from "drizzle-orm";
import { METER_FIXED_POINT_ONE } from "@/contracts/simulation/bodies";
import { db, simPhysicalLoci, simZones } from "@/server/db";
import { readChatEngineAuthority } from "./chat-authority";
import { readDurableBodies } from "./simulation";

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
