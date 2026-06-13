import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { checkLinkAccess, type DoorState } from "@/contracts/world/access";
import type { StagedIntent } from "@/contracts/state/session-runtime";
import { DEFAULT_LINK_TRAVEL_MINUTES } from "./constants";
import type { SceneLinkInput } from "./scene";

/**
 * The movement system (phase-4 npc-movement, minimal slice —
 * docs/developer-notes/npc-movement-spec.phase3.md): the deterministic executor
 * that walks director-staged NPCs toward a destination one hop per turn and
 * fires their on-arrival beat. Pure and dependency-injected (no DB, no merge
 * imports) so it unit-tests like the merge's other pure helpers. The director
 * decides; this only executes.
 */

// ---------------------------------------------------------------------------
// Pathfinding — one hop toward a destination over the session link graph
// ---------------------------------------------------------------------------

export interface NextHopInput {
  fromId: string;
  toId: string;
  links: readonly SceneLinkInput[];
  /** Resolve a link's bound door instance state, for checkLinkAccess. */
  doorStateForLink: (link: SceneLinkInput) => DoorState | null;
  /** Current minute of day (0–1439) — timeWindow access checks. */
  minuteOfDay: number;
  moverParticipantId: string;
}

export type NextHopResult =
  | { kind: "arrived" }
  | { kind: "hop"; nextId: string; travelMinutes: number }
  | { kind: "no_path" };

/**
 * Shortest-path (by hop count) next step from `fromId` toward `toId`, expanding
 * only links the mover may currently traverse (the phase-2 passability rule
 * checkLinkAccess — locked/door-locked/time-window edges are not walked). A
 * fully walled-off destination returns `no_path`; never marches the NPC at a
 * wall. Nodes-only (no mid-edge positions), one hop per call.
 */
export function nextHopToward(input: NextHopInput): NextHopResult {
  if (input.fromId === input.toId) return { kind: "arrived" };

  // Adjacency restricted to passable edges (links are bidirectional).
  const passableNeighbors = (id: string): Array<{ to: string; link: SceneLinkInput }> => {
    const out: Array<{ to: string; link: SceneLinkInput }> = [];
    for (const link of input.links) {
      const to = link.fromId === id ? link.toId : link.toId === id ? link.fromId : null;
      if (to === null) continue;
      const verdict = checkLinkAccess({
        access: link.access ?? { kind: "public" },
        minuteOfDay: input.minuteOfDay,
        moverParticipantId: input.moverParticipantId,
        door: input.doorStateForLink(link),
      });
      if (!verdict.passable) continue;
      out.push({ to, link });
    }
    return out;
  };

  // BFS, tracking how each node was reached so we can recover the first hop.
  const cameFrom = new Map<string, { prev: string; link: SceneLinkInput }>();
  const visited = new Set<string>([input.fromId]);
  const queue: string[] = [input.fromId];
  while (queue.length) {
    const cur = queue.shift() as string;
    if (cur === input.toId) break;
    for (const { to, link } of passableNeighbors(cur)) {
      if (visited.has(to)) continue;
      visited.add(to);
      cameFrom.set(to, { prev: cur, link });
      queue.push(to);
    }
  }
  if (!visited.has(input.toId)) return { kind: "no_path" };

  // Walk the parent chain back to fromId; the node whose parent IS fromId is the
  // first hop.
  let node = input.toId;
  while (true) {
    const step = cameFrom.get(node);
    if (!step) return { kind: "no_path" }; // defensive — visited but no chain
    if (step.prev === input.fromId) {
      return { kind: "hop", nextId: node, travelMinutes: step.link.travelMinutes ?? DEFAULT_LINK_TRAVEL_MINUTES };
    }
    node = step.prev;
  }
}

// ---------------------------------------------------------------------------
// Staged-intent lifecycle — advance, arrive, fire, cancel
// ---------------------------------------------------------------------------

export interface StagedIntentTickInput {
  intents: readonly StagedIntent[];
  /** Current location of each participant by id (read-only view of the working set). */
  locationByParticipant: ReadonlyMap<string, string | null>;
  /** Participant ids that still exist this turn (orphan detection). */
  knownParticipantIds: ReadonlySet<string>;
  links: readonly SceneLinkInput[];
  doorStateForLink: (link: SceneLinkInput) => DoorState | null;
  minuteOfDay: number;
  turnNumber: number;
  sink?: DiagnosticSink;
}

/** A location change for the merge to apply (it owns participant mutation + arrival staging). */
export interface StagedMove {
  participantId: string;
  fromLocationId: string | null;
  toLocationId: string;
  /** The intent's final destination (for the "heading toward X" transit activity). */
  destinationLocationId: string;
  /** True when this hop reached the destination (no transit activity; the beat fires). */
  reachedDestination: boolean;
}

/** An on-arrival payload to surface. */
export interface StagedFire {
  participantId: string;
  comms?: { kind: "call" | "text"; gist: string; urgency: "low" | "normal" | "high" };
  directive?: string;
}

export interface StagedIntentTickResult {
  /** Next runtime.stagedIntents — resolved/cancelled pruned, active carried forward. */
  intents: StagedIntent[];
  moves: StagedMove[];
  fired: StagedFire[];
}

/**
 * Advance every active staged intent one hop toward its destination, firing the
 * on-arrival payload the tick it arrives. Commitment lives in the merge: a
 * participant in `moves`/`fired` is skipped by that turn's schedule tick so a
 * routine can't yank them off course. Cancelled intents (no path, budget spent,
 * orphaned) release the participant back to their schedule. Every drop is a
 * diagnostic, never an exception (docs/resilience.md).
 */
export function applyStagedIntents(input: StagedIntentTickInput): StagedIntentTickResult {
  const next: StagedIntent[] = [];
  const moves: StagedMove[] = [];
  const fired: StagedFire[] = [];

  const fire = (intent: StagedIntent) => {
    if (!intent.onArrival) return;
    if (intent.onArrival.comms || intent.onArrival.directive) {
      fired.push({
        participantId: intent.participantId,
        comms: intent.onArrival.comms,
        directive: intent.onArrival.directive,
      });
    }
  };

  for (const intent of input.intents) {
    // Carry non-active intents through unchanged (the merge prunes them on write,
    // but a reconcile or partial run should never lose them mid-flight).
    if (intent.status !== "active") {
      next.push(intent);
      continue;
    }

    if (!input.knownParticipantIds.has(intent.participantId)) {
      input.sink?.push(
        diag("info", "merge.movement.intent_orphaned", `staged intent ${intent.id} dropped — participant gone`),
      );
      continue; // drop entirely
    }

    const from = input.locationByParticipant.get(intent.participantId) ?? null;

    // Already at the destination (placed there, or arrived last tick): fire + resolve.
    if (from !== null && from === intent.destinationLocationId) {
      fire(intent);
      continue; // resolved → pruned
    }

    // Budget spent before arrival: give up (the human behavior — they didn't make it).
    if (input.turnNumber - intent.openedAtTurn >= intent.expiresInTurns) {
      input.sink?.push(
        diag("warn", "merge.movement.intent_expired", `staged intent ${intent.id} expired before reaching its destination`, {
          context: { participantId: intent.participantId },
        }),
      );
      continue; // cancelled → pruned
    }

    // An unplaced NPC has no node to path from — cancel rather than teleport.
    if (from === null) {
      input.sink?.push(
        diag("info", "merge.movement.intent_orphaned", `staged intent ${intent.id} dropped — participant unplaced`),
      );
      continue;
    }

    const hop = nextHopToward({
      fromId: from,
      toId: intent.destinationLocationId,
      links: input.links,
      doorStateForLink: input.doorStateForLink,
      minuteOfDay: input.minuteOfDay,
      moverParticipantId: intent.participantId,
    });

    if (hop.kind === "no_path") {
      input.sink?.push(
        diag("warn", "merge.movement.unreachable", `staged intent ${intent.id} destination unreachable — cancelled`, {
          context: { participantId: intent.participantId, destinationLocationId: intent.destinationLocationId },
        }),
      );
      continue; // cancelled → pruned
    }
    if (hop.kind === "arrived") {
      // from !== destination was already established; defensive.
      fire(intent);
      continue;
    }

    const reached = hop.nextId === intent.destinationLocationId;
    moves.push({
      participantId: intent.participantId,
      fromLocationId: from,
      toLocationId: hop.nextId,
      destinationLocationId: intent.destinationLocationId,
      reachedDestination: reached,
    });
    if (reached) {
      fire(intent);
      continue; // resolved this hop → pruned
    }
    next.push(intent); // still travelling
  }

  return { intents: next, moves, fired };
}
