import { z } from "zod";

/**
 * Link access (docs/developer-notes/multi-character-data-model.phase3.md):
 * who/when a location link admits. Stored as jsonb on world_links and
 * session_links; parsed at the bundle boundary via parseOr — a malformed or
 * absent value degrades to public (today's behavior, never a blocked door).
 */

export const linkAccessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public") }),
  /** Discourages future NPC pathing; no player effect in v1. */
  z.object({ kind: z.literal("private"), ownerParticipantIds: z.array(z.string()).default([]) }),
  /** keyItemId is reserved — v1 blocks even a key-holder (keys/lockpicking are later content). */
  z.object({ kind: z.literal("locked"), keyItemId: z.string().optional() }),
  /** Passable only inside [start, end) minutes-of-day; windows may wrap past midnight. */
  z.object({
    kind: z.literal("timeWindow"),
    start: z.number().int().min(0).max(1439),
    end: z.number().int().min(0).max(1439),
  }),
]);

export type LinkAccess = z.infer<typeof linkAccessSchema>;

export function defaultLinkAccess(): LinkAccess {
  return { kind: "public" };
}

/** Bound door item state, when the link has a doorItemId (item_instances.state slice). */
export interface DoorState {
  open?: boolean;
  locked?: boolean;
}

export interface LinkAccessCheckInput {
  access: LinkAccess;
  /** Current minute of day (0–1439) — timeWindow checks. */
  minuteOfDay: number;
  /** Mover's participant id. Unused in v1 (private has no player effect); the NPC-traversal phase reads it. */
  moverParticipantId?: string;
  /** State of the bound door item instance, when the link carries a doorItemId. */
  door?: DoorState | null;
}

export type LinkAccessResult =
  | { passable: true }
  | { passable: false; kind: "locked" | "door_locked" | "time_window"; reason: string };

/** Is `minute` inside [start, end), wrapping past midnight when start > end? */
export function withinMinuteWindow(minute: number, start: number, end: number): boolean {
  // A zero-length window is an authoring artifact, not a permanent wall —
  // degrade to "no restriction" (docs/resilience.md: degraded defaults).
  if (start === end) return true;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/**
 * The one traversal rule (phase-2-plan T8): link access + time + mover ⇒
 * passable or blocked-with-reason. Player movement validation uses it now;
 * phase-4 NPC traversal reuses it instead of growing a second rule. Pure —
 * callers resolve the door instance and the minute of day.
 */
export function checkLinkAccess(input: LinkAccessCheckInput): LinkAccessResult {
  // A bound door that is closed and locked seals the link regardless of the
  // access kind (item state drives traversability).
  if (input.door && input.door.locked === true && input.door.open !== true) {
    return { passable: false, kind: "door_locked", reason: "the door is closed and locked" };
  }
  switch (input.access.kind) {
    case "public":
      return { passable: true };
    case "private":
      // Discourages NPC pathing when drives ship; never blocks the player.
      return { passable: true };
    case "locked":
      return { passable: false, kind: "locked", reason: "the way is locked" };
    case "timeWindow":
      return withinMinuteWindow(input.minuteOfDay, input.access.start, input.access.end)
        ? { passable: true }
        : { passable: false, kind: "time_window", reason: "that way is closed at this hour" };
  }
}
