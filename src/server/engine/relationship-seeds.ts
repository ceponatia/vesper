import {
  classifyBond,
  diag,
  stageForValue,
  stageMidpoint,
  type AuthoredRelationship,
  type DiagnosticSink,
} from "@/contracts";

/**
 * Authored-relationship seeding (phase-2-plan T1): turn `world_cast.relationships`
 * entries into directional `participant_relationships` rows at the stage
 * midpoint. Pure — spawn (and later the emergent-cast conceptNote path) maps
 * participants in and inserts the rows it gets back. Rules:
 *
 * - Sparse = stranger: an authored "stranger" stage writes no row, but still
 *   counts as explicit (it suppresses an implied reverse edge).
 * - Reverse edges: authored A→B implies B→A at the same midpoint unless that
 *   direction is itself authored — explicit always wins; unrequited
 *   relationships are authored by writing both sides.
 * - Player edges (decision 41 — players own no edges): the NPC's `feeling` row
 *   seeds at the midpoint, and its `perceived` row (its belief about the
 *   player's feeling toward them) seeds per the bond classifier over the cast
 *   member's concept/bio text — mutual-knowledge bonds and indeterminate text
 *   mirror the midpoint, explicit first-meeting phrasing seeds no row.
 * - Played cast member: when a member's participantId IS the player (the
 *   chosen player character sits in the cast), edges toward its display name
 *   count as toward-player, and its own authored edges seed the NPC side
 *   instead (the implied reverse: feeling at the midpoint plus the
 *   classifier-driven perceived row) — explicit NPC edges still win.
 * - Unresolved `toward` names degrade with a diagnostic and a skipped row,
 *   never a failed spawn.
 */

export interface RelationshipSeedMember {
  participantId: string;
  displayName: string;
  /** Authored entries (already boundary-parsed from world_cast.relationships). */
  relationships: readonly AuthoredRelationship[];
  /** Concept/bio text the bond classifier reads when an edge targets the player. */
  bondText: string;
}

export interface RelationshipSeedRow {
  fromParticipantId: string;
  toParticipantId: string;
  kind: "feeling" | "perceived";
  value: number;
  stage: string;
}

const PLAYER_TOKEN = "player";

export function seedRelationshipRows(
  members: readonly RelationshipSeedMember[],
  playerParticipantId: string | null,
  sink?: DiagnosticSink,
): RelationshipSeedRow[] {
  const memberByName = new Map<string, RelationshipSeedMember>();
  for (const member of members) {
    const key = member.displayName.trim().toLowerCase();
    if (!memberByName.has(key)) memberByName.set(key, member);
  }

  // Resolve every authored entry before emitting rows: explicit directions
  // must all be known before reverse edges are implied (explicit wins).
  interface ResolvedEdge {
    fromId: string;
    fromMember: RelationshipSeedMember;
    fromPlayer: boolean;
    toId: string;
    toMember: RelationshipSeedMember | null;
    toPlayer: boolean;
    stage: string;
  }
  const resolved: ResolvedEdge[] = [];
  const authoredDirections = new Set<string>();

  for (const member of members) {
    for (const entry of member.relationships) {
      const towardKey = entry.toward.trim().toLowerCase();
      const toMember = towardKey === PLAYER_TOKEN ? null : (memberByName.get(towardKey) ?? null);
      const toId = towardKey === PLAYER_TOKEN ? playerParticipantId : (toMember?.participantId ?? null);
      const toPlayer = toId !== null && toId === playerParticipantId;
      if (!toId) {
        sink?.push(
          diag(
            "warn",
            "spawn.relationship.unresolved_toward",
            `relationship target "${entry.toward}" from "${member.displayName}" does not resolve to a cast member or the player; skipped`,
            { context: { from: member.displayName, toward: entry.toward } },
          ),
        );
        continue;
      }
      if (toId === member.participantId) {
        sink?.push(
          diag("warn", "spawn.relationship.self_reference", `"${member.displayName}" authors a relationship toward themselves; skipped`, {
            context: { from: member.displayName },
          }),
        );
        continue;
      }
      const direction = `${member.participantId}->${toId}`;
      if (authoredDirections.has(direction)) {
        sink?.push(
          diag(
            "warn",
            "spawn.relationship.duplicate",
            `"${member.displayName}" authors more than one relationship toward "${entry.toward}"; kept the first`,
            { context: { from: member.displayName, toward: entry.toward } },
          ),
        );
        continue;
      }
      authoredDirections.add(direction);
      resolved.push({
        fromId: member.participantId,
        fromMember: member,
        fromPlayer: member.participantId === playerParticipantId,
        toId,
        toMember,
        toPlayer,
        stage: entry.stage,
      });
    }
  }

  const rows = new Map<string, RelationshipSeedRow>();
  const add = (fromId: string, toId: string, kind: "feeling" | "perceived", value: number): void => {
    const key = `${fromId}|${toId}|${kind}`;
    if (rows.has(key)) return;
    rows.set(key, { fromParticipantId: fromId, toParticipantId: toId, kind, value, stage: stageForValue(value).id });
  };

  for (const edge of resolved) {
    if (edge.stage === "stranger") continue; // sparse = stranger
    const value = stageMidpoint(edge.stage);
    if (edge.fromPlayer) {
      // Players own no edges (decision 41): an edge authored on the played
      // cast member seeds the NPC's side instead — unless that NPC authors
      // its own edge toward the player (explicit wins).
      if (!edge.toMember || authoredDirections.has(`${edge.toId}->${edge.fromId}`)) continue;
      add(edge.toId, edge.fromId, "feeling", value);
      if (classifyBond(edge.toMember.bondText) !== "first-meeting") {
        add(edge.toId, edge.fromId, "perceived", value);
      }
      continue;
    }
    add(edge.fromId, edge.toId, "feeling", value);
    if (edge.toPlayer) {
      if (classifyBond(edge.fromMember.bondText) !== "first-meeting") {
        add(edge.fromId, edge.toId, "perceived", value);
      }
    } else if (!authoredDirections.has(`${edge.toId}->${edge.fromId}`)) {
      add(edge.toId, edge.fromId, "feeling", value);
    }
  }

  return [...rows.values()];
}
