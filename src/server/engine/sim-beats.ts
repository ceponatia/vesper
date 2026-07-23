import { eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import type { CompositionFallbackCode } from "@/contracts/turns/composition-fallback";
import { simCalendarStartSchema, type SimCalendarStart } from "@/lib/simulation/clock";
import { worldBeatText, type WorldBeatKind } from "@/lib/simulation/world-beat";
import { characterChatMessages, db, simBranches, simWorlds } from "../db";
import { log } from "../log";
import { recordCompositionFallback } from "./composition-diagnostics";

/**
 * World beats (world-ui.plan.md slice 2) — the durable transcript trace of a
 * world event the player caused or witnessed (travel, a time skip, a scene
 * ending), successor-lane only. A beat is an ordinary `character_chat_messages`
 * row (NO migration): `role = "assistant"` (a legal enum value, `speakerCharacterId`
 * null) with `meta.worldBeat = { kind }` marking it, and the phrased line stored
 * verbatim on `content`. The transcript read carries `meta` through untouched, so
 * the client re-parses the marker and renders a muted system line; the narrator
 * dialogue tail skips beat rows by that same marker.
 */

export interface SimChatClock {
  storySecond: number;
  /** The world's calendar anchor (R5 time domain) — null = no calendar, "Day N" display. */
  calendarStart: SimCalendarStart | null;
}

/** The world-beat marker on a message row's `meta` (fail-open to "not a beat"). */
const worldBeatMetaSchema = z.object({ worldBeat: z.object({ kind: z.string() }).nullish() }).catch({ worldBeat: null });

/** True when a message row's `meta` marks it as a world beat (a UI trace, not narration). */
export function isWorldBeatMeta(meta: unknown): boolean {
  return parseOr(worldBeatMetaSchema, meta, {}, undefined, "character_chat_messages.meta").worldBeat != null;
}

/** The branch clock + its world's calendar anchor (fail-open to no calendar). */
export async function readBranchClock(branchId: string): Promise<SimChatClock | null> {
  const [row] = await db()
    .select({ storySecond: simBranches.storySecond, calendarStart: simWorlds.calendarStart })
    .from(simBranches)
    .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!row) return null;
  return {
    storySecond: row.storySecond,
    calendarStart: parseOr(simCalendarStartSchema.nullable(), row.calendarStart ?? null, null, undefined, "sim_worlds.calendar_start"),
  };
}

/**
 * Write one world beat to a successor chat's transcript, stamped at the current
 * (post-command) branch clock. Best-effort by ruling (docs/resilience.md): a
 * failed beat write must NEVER fail the command that already committed — it logs
 * the `engine.sim.world_beat` diagnostic and returns. Callers resolve any display
 * label (they hold the space projection); this owns the clock read, phrasing, and
 * insert so every call site is one guarded line.
 */
export async function writeWorldBeat(input: {
  chatId: string;
  branchId: string;
  kind: WorldBeatKind;
  /** Destination display noun for a `traveled` beat; omitted for skips / scene-ends. */
  destinationLabel?: string;
  /** A `traveled` departure ended a standing scene as a choice (slice 4) — acknowledge the parting. */
  parted?: boolean;
  /** A `traveled` WALK-WITH-ME (slice 5) — the primary came along ("You walk to … together."). */
  together?: boolean;
  /** Recipient display name for a `gave_item` beat. */
  recipientName?: string;
  /** Handed item display name for a `gave_item` beat. */
  itemName?: string;
  /** Performed action display label for a `rested` beat. */
  activityLabel?: string;
  /**
   * Public-safe composition-fallback codes to stamp on this beat's meta (C15 surface a) — the
   * "open a suspicious beat and see what degraded" breadcrumb. Codes ONLY, never private
   * detail (ruling 2). Omitted / empty ⇒ no marker.
   */
  fallbacks?: readonly CompositionFallbackCode[];
}): Promise<void> {
  try {
    const clock = await readBranchClock(input.branchId);
    const content = worldBeatText({
      kind: input.kind,
      storySecond: clock?.storySecond ?? 0,
      anchor: clock?.calendarStart ?? null,
      ...(input.destinationLabel === undefined ? {} : { destinationLabel: input.destinationLabel }),
      ...(input.parted === undefined ? {} : { parted: input.parted }),
      ...(input.together === undefined ? {} : { together: input.together }),
      ...(input.recipientName === undefined ? {} : { recipientName: input.recipientName }),
      ...(input.itemName === undefined ? {} : { itemName: input.itemName }),
      ...(input.activityLabel === undefined ? {} : { activityLabel: input.activityLabel }),
    });
    await db().insert(characterChatMessages).values({
      id: newId(),
      chatId: input.chatId,
      speakerCharacterId: null,
      role: "assistant",
      content,
      meta: {
        simTurn: true,
        worldBeat: { kind: input.kind },
        ...(input.fallbacks && input.fallbacks.length ? { compositionFallbacks: [...input.fallbacks] } : {}),
      },
    });
  } catch (error) {
    log.warn("engine.sim.world_beat", "beat write degraded; command already succeeded", {
      chatId: input.chatId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    // C15: the one degradation that has no reply/beat to attach a code to — record it directly
    // as a durable events row so a beat vanishing is countable, not just a log line.
    recordCompositionFallback({
      site: "beat",
      code: "beat_write_degraded",
      chatId: input.chatId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
