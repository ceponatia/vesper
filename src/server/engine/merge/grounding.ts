import { checkLinkAccess } from "@/contracts/world/access";
import type { TurnAuthor } from "@/contracts/turns/stream";
import type { SimulantResult } from "@/contracts/turns/agent-results";
import { minuteOfDay, resolveGameTime } from "@/lib/clock";
import { activeLocationId, type BundlePlace, type SessionBundle } from "../bundle";
import { DEFAULT_LINK_TRAVEL_MINUTES } from "../constants";
import { detectIntent, isOocInput } from "../intent";
import type { SceneLinkInput } from "../scene";
import type { WorkingItem, WorkingParticipant } from "./working-state";

/**
 * Pure name→row resolution toolkit (merge-decomposition.spec.md §3.2): the
 * stateless grounding the reducer leans on — participants/locations/items by
 * name, link adjacency + travel cost, and the staged-location anchor. No working
 * state, no IO; safe to share between the reducer and pre-turn assembly.
 */

export type ItemAction = SimulantResult["itemEvents"][number]["action"];

/** The link connecting two locations, either direction (links are bidirectional). */
export function findLink(fromId: string, toId: string, links: readonly SceneLinkInput[]): SceneLinkInput | null {
  return (
    links.find((l) => (l.fromId === fromId && l.toId === toId) || (l.fromId === toId && l.toId === fromId)) ?? null
  );
}

/** Traversal cost of the link between two locations (either direction). */
export function linkTravelMinutes(fromId: string | null, toId: string, links: readonly SceneLinkInput[]): number {
  if (fromId === null) return 0; // placing an unplaced participant costs nothing
  return findLink(fromId, toId, links)?.travelMinutes ?? DEFAULT_LINK_TRAVEL_MINUTES;
}

/** Case-insensitive display-name map; canonical casing comes from the row. Aliases included. */
export function groundParticipants(participants: readonly WorkingParticipant[]): Map<string, WorkingParticipant> {
  const map = new Map<string, WorkingParticipant>();
  for (const p of participants) {
    map.set(p.displayName.trim().toLowerCase(), p);
    for (const alias of p.snapshot.aliases) {
      const key = alias.trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, p);
    }
  }
  return map;
}

/** Display name → participant: exact (ci) → alias → unique first-word match. */
export function findParticipant(
  name: string,
  participants: readonly WorkingParticipant[],
): WorkingParticipant | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const exact = groundParticipants(participants).get(wanted);
  if (exact) return exact;
  const firstWordMatches = participants.filter((p) => {
    const first = p.displayName.trim().toLowerCase().split(/\s+/)[0];
    return first === wanted;
  });
  if (firstWordMatches.length === 1) return firstWordMatches[0] ?? null;
  return null;
}

/** Links are traversable in both directions (matches the scene builders). */
export function isAdjacent(fromId: string | null, toId: string, links: readonly SceneLinkInput[]): boolean {
  if (fromId === null) return true; // an unplaced participant can be placed anywhere
  return links.some(
    (l) => (l.fromId === fromId && l.toId === toId) || (l.fromId === toId && l.toId === fromId),
  );
}

/** Session location by name: exact (ci) → unique containment either way. */
export function resolveSessionLocation(name: string, locations: readonly BundlePlace[]): BundlePlace | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const exact = locations.find((l) => l.name.trim().toLowerCase() === wanted);
  if (exact) return exact;
  const loose = locations.filter((l) => {
    const candidate = l.name.trim().toLowerCase();
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  return loose.length === 1 ? (loose[0] ?? null) : null;
}

/**
 * The location this turn's narration anchors on: the active location — or,
 * when a player enter-intent targets an adjacent passable room, that staged
 * target (the same access rule movement validation enforces below). Pre-turn
 * prompt assembly and the post-turn continuity audit MUST share this anchor:
 * an auditor anchored on the old room flags characters the narrator was
 * rightly told are Present (followups.phase2.md #13).
 */
export function stagedLocationAnchor(
  bundle: SessionBundle,
  input: string,
  author: TurnAuthor,
): { staged: BundlePlace | null; blocked: { target: BundlePlace; reason: string } | null } {
  const none = { staged: null, blocked: null };
  if (author !== "player" || isOocInput(input)) return none;
  const activeLoc = activeLocationId(bundle);
  const presentIds = new Set(
    bundle.participants.filter((p) => p.locationId !== null && p.locationId === activeLoc).map((p) => p.id),
  );
  const npcNames = bundle.participants
    .filter((p) => !p.isUser && p.locationId !== null && p.locationId === activeLoc)
    .map((p) => p.displayName);
  const itemNames = bundle.items
    .filter(
      (i) =>
        (i.locationId !== null && i.locationId === activeLoc) ||
        (i.holderParticipantId !== null && presentIds.has(i.holderParticipantId)),
    )
    .map((i) => i.name);
  const intent = detectIntent(input, npcNames, itemNames);
  if (!intent.enterLocation) return none;
  const target = resolveSessionLocation(intent.enterLocation, bundle.locations);
  if (!target || target.id === activeLoc || !isAdjacent(activeLoc, target.id, bundle.links)) return none;
  const link = activeLoc ? findLink(activeLoc, target.id, bundle.links) : null;
  const door = link?.doorItemId ? (bundle.items.find((i) => i.id === link.doorItemId)?.state ?? null) : null;
  const verdict = checkLinkAccess({
    access: link?.access ?? { kind: "public" },
    minuteOfDay: minuteOfDay(resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart)),
    door,
  });
  if (verdict.passable) return { staged: target, blocked: null };
  return { staged: null, blocked: { target, reason: verdict.reason } };
}

/** Action-aware preference among same-named instances (e.g. `remove` prefers worn). */
export function scoreItemCandidate(
  item: WorkingItem,
  action: ItemAction,
  actor: { id: string; locationId: string | null } | null,
): number {
  const heldByActor = actor !== null && item.holderParticipantId === actor.id;
  const wornByActor = heldByActor && item.worn;
  const inActorRoom = actor !== null && actor.locationId !== null && item.locationId === actor.locationId;
  switch (action) {
    case "remove":
      return wornByActor ? 3 : item.worn ? 2 : heldByActor ? 1 : 0;
    case "wear":
      return heldByActor && !item.worn ? 3 : inActorRoom ? 2 : heldByActor ? 1 : 0;
    case "pick_up":
    case "take_from":
      return inActorRoom ? 3 : item.containerInstanceId !== null ? 2 : heldByActor ? 0 : 1;
    case "drop":
    case "place":
    case "store_in":
      return heldByActor ? 3 : inActorRoom ? 2 : 0;
    case "open":
    case "close":
      return inActorRoom ? 3 : heldByActor ? 2 : 1;
    case "alter":
      return heldByActor ? 3 : inActorRoom ? 2 : 1;
  }
}

export function resolveItemByName(
  name: string,
  action: ItemAction,
  items: readonly WorkingItem[],
  actor: { id: string; locationId: string | null } | null,
): WorkingItem | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const candidates = items.filter((i) => i.name.trim().toLowerCase() === wanted);
  return pickBest(candidates, action, actor);
}

/** Highest-scoring candidate for the action (ties keep the first seen). */
export function pickBest(
  candidates: readonly WorkingItem[],
  action: ItemAction,
  actor: { id: string; locationId: string | null } | null,
): WorkingItem | null {
  let best: WorkingItem | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = scoreItemCandidate(c, action, actor);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
