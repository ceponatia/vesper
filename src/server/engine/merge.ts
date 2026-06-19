import { and, eq, sql } from "drizzle-orm";
import { matchActions, type ActionDefinition } from "@/contracts/actions/registry";
import { attributeRegistry } from "@/contracts/attributes";
import { attributeValueSchema } from "@/contracts/attributes/value";
import { isConditionExpired, type ActiveCondition } from "@/contracts/conditions/condition";
import { diag, type Diagnostic, type DiagnosticSink } from "@/contracts/diagnostics";
import type { ItemDefinition, ItemInstanceState } from "@/contracts/items/item";
import { applyMeterDrift, crossedThresholdHints, NEUTRAL_MOOD_METER, type MeterDefinition } from "@/contracts/meters/registry";
import {
  concealedSalience,
  darknessVerdict,
  defaultSalience,
  deriveAttention,
  hasStealthMarker,
  perceives,
  senseModsFromConditions,
  type Salience,
} from "@/contracts/perception";
import { emptyBrief, nextTurnBriefSchema, type NextTurnBrief } from "@/contracts/state/brief";
import type { ParticipantState } from "@/contracts/state/participant-state";
import {
  pendingCommsSchema,
  stagedIntentSchema,
  storyThreadSchema,
  type CommsLink,
  type PendingComms,
  type SessionRuntime,
  type StagedIntent,
  type StoryThread,
  type StoryThreadDevelopment,
} from "@/contracts/state/session-runtime";
import type {
  AgentResults,
  ArchivistResult,
  ContinuityResult,
  DirectorResult,
  SimulantResult,
  TurnProviders,
} from "@/contracts/turns/agent-results";
import type { TurnAuthor } from "@/contracts/turns/stream";
import type { CharacterProfile } from "@/contracts/world/profile";
import { evaluateSocialReaction, moodMeterToFactor, moodNudge, resolveSocialReaction } from "@/contracts/personality/reactions";
import { affinityDecayRetention, personalizeMeters, scaleAffinityGain, socialTraitScale } from "@/contracts/personality/modulation";
import type { TraitValue } from "@/contracts/personality/traits/value";
import type { IntentBrief } from "@/contracts/turns/intent-brief";
import { checkLinkAccess, type DoorState } from "@/contracts/world/access";
import { daylightBand, minuteOfDay, resolveGameTime, type DaylightBand } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { parseOrNull } from "@/lib/parse";
import { clampAffinity, stageForValue } from "@/contracts/relationships/stages";
import { db, events, itemInstances, participantRelationships, sessionParticipants, sessions, turns } from "../db";
import { embedTexts } from "../ai";
import {
  addFacts,
  appendEpisode,
  computeUnlocks,
  cosineSimilarity,
  deleteEpisodeForTurn,
  fuzzyResolve,
  type FactDraftInput,
} from "../memory";
import { activeLocationId, type BundlePlace, type BundleRelationship, type SessionBundle } from "./bundle";
import { declaredRestMinutes, detectDeclaredRest, detectIntent, isOocInput } from "./intent";
import {
  AFFINITY_DECAY_WEEK_MINUTES,
  AFFINITY_DELTA_CLAMP,
  DEFAULT_LINK_TRAVEL_MINUTES,
  FALLBACK_MINUTES_ADVANCED,
  MAX_MINUTES_ADVANCED,
  MIN_MINUTES_ADVANCED,
  PENDING_COMMS_CAP,
  REST_CLAMP_MINUTES,
  SCHEDULE_JITTER_MINUTES,
  STAGED_INTENT_DEFAULT_BUDGET,
  THREAD_COOLING_TURNS,
  THREAD_DEDUPE_MIN_SCORE,
  THREAD_DEVELOPMENTS_CAP,
} from "./constants";
import { applyStagedIntents } from "./movement";
import { effectiveMeterDefinitions, type SceneLinkInput } from "./scene";

/**
 * The merge reducer (docs/turn-engine.md §Merge reducer): deterministic
 * planning over the typed bundle + whatever agent subset succeeded, then one
 * transaction for all world-state writes. Invalid references degrade to
 * dropped events with diagnostics; a turn with every agent failed still
 * advances the clock, applies drift, and writes a synthetic episode.
 */

// ---------------------------------------------------------------------------
// Working state
// ---------------------------------------------------------------------------

export interface WorkingParticipant {
  id: string;
  displayName: string;
  isUser: boolean;
  role: "player" | "companion" | "npc";
  characterId: string | null;
  snapshot: CharacterProfile;
  locationId: string | null;
  state: ParticipantState;
}

export interface WorkingItem {
  id: string;
  name: string;
  itemId: string | null;
  definition: ItemDefinition;
  holderParticipantId: string | null;
  worn: boolean;
  locationId: string | null;
  containerInstanceId: string | null;
  positionNote: string | null;
  state: ItemInstanceState;
}

export interface MergeTurn {
  id: string;
  number: number;
  author: TurnAuthor;
  input: string;
  narration: string;
  /** Companion-authored turns: the speaking NPC (counts as a targeted interaction). */
  speakerParticipantId?: string | null;
  /**
   * The persisted intake brief. Its `socialActs` drive the deterministic
   * reaction affinity (personality-and-state.spec.md §6). Absent ⇒ no reaction.
   */
  intentBrief?: IntentBrief;
}

export type MergeMode = "post_turn" | "reconcile";

export interface GroundingDeps {
  /** Library fuzzy match for an item name (maps to instances via itemId). */
  resolveLibraryItem?: (name: string) => Promise<{ id: string } | null>;
  /** Library fuzzy match for a location name (maps via session_locations.location_id). */
  resolveLibraryLocation?: (name: string) => Promise<{ id: string } | null>;
  /**
   * Batch-embed thread texts for semantic dedup of proposals (docs/story-threads.md).
   * Injected so the planner stays testable; absent ⇒ exact-title dedup only.
   */
  embedThreadTexts?: (texts: string[]) => Promise<number[][]>;
}

export interface PlanInput {
  bundle: SessionBundle;
  turn: MergeTurn;
  results: AgentResults;
  sink: DiagnosticSink;
  mode?: MergeMode;
  deps?: GroundingDeps;
  /** When set, lore-unlock near-misses are logged as events (impure). */
  logMissesForSessionId?: string;
}

export interface MergePlan {
  /** Minutes applied by this merge (0 in reconcile mode). */
  minutes: number;
  /** Dominant time component ("travel", "shower", "scene", "reconcile") — for the clock-delta UI. */
  minutesCause: string;
  /** Final session clock. */
  clockMinutes: number;
  participants: WorkingParticipant[];
  items: WorkingItem[];
  /** Ids of items whose row changed (placement or state). */
  touchedItemIds: string[];
  factDrafts: FactDraftInput[];
  episodeSummary: string;
  syntheticEpisode: boolean;
  touchedThreadIds: string[];
  runtime: SessionRuntime;
  brief: NextTurnBrief;
  droppedEvents: string[];
  affinityUpdates: AffinityUpdate[];
  /** Time-driven affinity decay applied by this merge (post_turn only; always empty in reconcile). */
  affinityDecay: AffinityDecayEdge[];
  /**
   * Participant ids who perceived this turn (presence-spec §witness sets): the
   * placed player plus every co-located NPC whose attention let them perceive a
   * salient action this turn. One set per turn, stamped on every fact draft.
   */
  witnessedBy: string[];
  /**
   * Comms links opened/closed this turn, for the events log (post_turn only;
   * always empty in reconcile). The persisted link state already lives in
   * `runtime.commsLinks`; this is just the per-turn audit trail.
   */
  commsChanges: CommsChange[];
}

const SYNTHETIC_EPISODE_CHARS = 300;
const ITEM_NOTE_CAP = 5;
const CORRECTION_CAP = 2;
const THRESHOLD_HINT_CAP = 2;
const DIRECTIVE_CAP = 8;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Clamp simulant minutes to [MIN, MAX]; null/garbage → FALLBACK (clock always advances). */
export function clampMinutes(raw: number | null | undefined, sink?: DiagnosticSink): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return FALLBACK_MINUTES_ADVANCED;
  const rounded = Math.round(raw);
  if (rounded < MIN_MINUTES_ADVANCED || rounded > MAX_MINUTES_ADVANCED) {
    const clamped = Math.min(MAX_MINUTES_ADVANCED, Math.max(MIN_MINUTES_ADVANCED, rounded));
    sink?.push(diag("info", "merge.clock.clamped", `minutesAdvanced ${rounded} clamped to ${clamped}`));
    return clamped;
  }
  return rounded;
}

export function advanceClock(
  input: { clockMinutes: number; minutesAdvanced: number | null | undefined },
  sink?: DiagnosticSink,
): { clockMinutes: number; minutes: number } {
  const minutes = clampMinutes(input.minutesAdvanced, sink);
  return { clockMinutes: input.clockMinutes + minutes, minutes };
}

/** Declared rest gets its own clamp — never less than a minute, never more than REST_CLAMP_MINUTES. */
export function clampRestMinutes(raw: number, sink?: DiagnosticSink): number {
  if (!Number.isFinite(raw)) return FALLBACK_MINUTES_ADVANCED;
  const rounded = Math.round(raw);
  if (rounded < MIN_MINUTES_ADVANCED || rounded > REST_CLAMP_MINUTES) {
    const clamped = Math.min(REST_CLAMP_MINUTES, Math.max(MIN_MINUTES_ADVANCED, rounded));
    sink?.push(diag("info", "merge.clock.rest_clamped", `declared rest ${rounded} clamped to ${clamped}`));
    return clamped;
  }
  return rounded;
}

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

/**
 * Turn time (docs/developer-notes/time-and-travel-spec.phase3.md): authored
 * components win over the LLM estimate, composed by max — never sum — so
 * overlapping activities are not double-counted. Decision 40: the estimate
 * still participates, so narration that clearly spans longer than a
 * registered action is not undercounted. Declared rest (decision 38) joins
 * the same composition with its own clamp (REST_CLAMP_MINUTES, not 480) —
 * ordinary turns without a rest component are untouched.
 */
export function resolveTurnMinutes(
  input: {
    estimate: number | null | undefined;
    travelMinutes: number;
    actions: readonly ActionDefinition[];
    /** Declared rest ("slept until morning"): minutes pre-wrap, clamped here. */
    rest?: { minutes: number; cause: string } | null;
  },
  sink?: DiagnosticSink,
): { minutes: number; cause: string } {
  const estimate = clampMinutes(input.estimate, sink);
  const longestAction = input.actions.reduce<ActionDefinition | null>(
    (best, a) => (best === null || a.minutes > best.minutes ? a : best),
    null,
  );
  const components: Array<{ minutes: number; cause: string }> = [
    { minutes: estimate, cause: "scene" },
    { minutes: input.travelMinutes, cause: "travel" },
    ...(longestAction ? [{ minutes: longestAction.minutes, cause: longestAction.label.toLowerCase() }] : []),
    ...(input.rest ? [{ minutes: clampRestMinutes(input.rest.minutes, sink), cause: input.rest.cause }] : []),
  ];
  // Last-wins on ties so an authored component beats an equal estimate.
  const winner = components.reduce((best, c) => (c.minutes >= best.minutes ? c : best));
  return { minutes: winner.minutes, cause: winner.cause };
}

/** Deterministic meter effects from registered actions (shower restores hygiene). Agent deltas still apply afterwards and win. */
export function applyActionMeterEffects(
  meters: Record<string, number>,
  actions: readonly ActionDefinition[],
  defs: readonly MeterDefinition[],
  sink?: DiagnosticSink,
  participantName?: string,
): Record<string, number> {
  const known = new Set(defs.map((d) => d.id));
  const next = { ...meters };
  for (const action of actions) {
    for (const effect of action.meterEffects) {
      if (!known.has(effect.meterId)) {
        sink?.push(
          diag("info", "merge.action.unknown_meter", `action "${action.id}" meter effect "${effect.meterId}" skipped (meter disabled or unknown)`, {
            context: { participantName, meterId: effect.meterId },
          }),
        );
        continue;
      }
      if (effect.set !== undefined) {
        next[effect.meterId] = Math.min(1, Math.max(0, effect.set));
      } else if (effect.delta !== undefined) {
        const current = next[effect.meterId] ?? defs.find((d) => d.id === effect.meterId)?.initial ?? 0;
        next[effect.meterId] = Math.min(1, Math.max(0, current + effect.delta));
      }
    }
  }
  return next;
}

/** Does the text mention the participant's first name or an alias (whole-word, ci)? */
export function mentionsParticipant(text: string, participant: WorkingParticipant): boolean {
  const lower = text.toLowerCase();
  const names = [participant.displayName.split(/\s+/)[0] ?? participant.displayName, ...participant.snapshot.aliases];
  return names.some((name) => {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return re.test(lower);
  });
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

type ItemAction = SimulantResult["itemEvents"][number]["action"];

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

function pickBest(
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

export interface ItemPlacement {
  holderParticipantId: string | null;
  worn: boolean;
  locationId: string | null;
  containerInstanceId: string | null;
}

function held(participantId: string, worn: boolean): ItemPlacement {
  return { holderParticipantId: participantId, worn, locationId: null, containerInstanceId: null };
}
function atLocation(locationId: string): ItemPlacement {
  return { holderParticipantId: null, worn: false, locationId, containerInstanceId: null };
}
function inContainer(containerInstanceId: string): ItemPlacement {
  return { holderParticipantId: null, worn: false, locationId: null, containerInstanceId };
}

/** Exactly-one-placement invariant, asserted before the DB CHECK constraint can. */
export function assertPlacementExclusive(placement: ItemPlacement): boolean {
  const set =
    (placement.holderParticipantId !== null ? 1 : 0) +
    (placement.locationId !== null ? 1 : 0) +
    (placement.containerInstanceId !== null ? 1 : 0);
  return set === 1 && (!placement.worn || placement.holderParticipantId !== null);
}

export interface ItemEventContext {
  item: WorkingItem;
  actor: WorkingParticipant | null;
  /** Grounded event.locationName, when given. */
  location: BundlePlace | null;
  /** Grounded event.containerName, when given. */
  container: WorkingItem | null;
  items: readonly WorkingItem[];
}

export type ItemEventPlanResult =
  | { ok: true; placement?: ItemPlacement; open?: boolean; note?: string }
  | { ok: false; code: string; message: string };

function isWearable(definition: ItemDefinition): boolean {
  return definition.kind === "clothing" || definition.fields["wearableContainer"] === true;
}

function containerChainContains(start: WorkingItem, targetId: string, items: readonly WorkingItem[]): boolean {
  let current: WorkingItem | undefined = start;
  const seen = new Set<string>();
  while (current) {
    if (current.id === targetId) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    const parentId: string | null = current.containerInstanceId;
    current = parentId ? items.find((i) => i.id === parentId) : undefined;
  }
  return false;
}

/** Validate + place an item into a container (shared by `store_in` and a
 * container-destination `remove`, e.g. a garment tossed into the hamper). */
function planStoreInContainer(
  container: WorkingItem | null,
  item: WorkingItem,
  items: readonly WorkingItem[],
  note: string | undefined,
): ItemEventPlanResult {
  if (!container) {
    return { ok: false, code: "merge.item.no_container", message: `container for "${item.name}" not found` };
  }
  if (container.definition.kind !== "container") {
    return { ok: false, code: "merge.item.not_container", message: `"${container.name}" is not a container` };
  }
  if (container.id === item.id || containerChainContains(container, item.id, items)) {
    return { ok: false, code: "merge.item.container_cycle", message: `cannot store "${item.name}" inside itself` };
  }
  return { ok: true, placement: inContainer(container.id), note };
}

/**
 * One item event → a placement/state transition honoring the placement CHECK
 * constraint (setting one placement clears the others). Pure.
 */
export function planItemEvent(
  event: SimulantResult["itemEvents"][number],
  ctx: ItemEventContext,
): ItemEventPlanResult {
  const { item, actor } = ctx;
  const note = event.stateNote?.trim() || undefined;

  switch (event.action) {
    case "wear": {
      if (!actor) return { ok: false, code: "merge.item.no_actor", message: `no actor to wear "${item.name}"` };
      if (!isWearable(item.definition)) {
        return { ok: false, code: "merge.item.invalid_wear", message: `"${item.name}" is not wearable` };
      }
      return { ok: true, placement: held(actor.id, true), note };
    }
    case "remove": {
      if (!item.worn) return { ok: false, code: "merge.item.not_worn", message: `"${item.name}" is not being worn` };
      // A removed garment goes where the prose puts it. Destination wins over the
      // hand: stowed in a container (hamper/drawer), or dropped/left at a location
      // (the floor of the current room). The agent signals these via the event's
      // existing containerName / locationName; a bare `remove` (no destination)
      // defaults to held — she takes it off and keeps it. A `locationName` the
      // resolver couldn't ground still falls back to the actor's room, so "the
      // floor" lands the item in the open here rather than in her hand.
      if (event.containerName) {
        return planStoreInContainer(ctx.container, item, ctx.items, note);
      }
      if (event.locationName) {
        const locationId = ctx.location?.id ?? actor?.locationId ?? item.locationId;
        if (locationId) return { ok: true, placement: atLocation(locationId), note };
      }
      const taker = actor ?? (item.holderParticipantId ? { id: item.holderParticipantId } : null);
      if (!taker) return { ok: false, code: "merge.item.no_actor", message: `no one to remove "${item.name}"` };
      return { ok: true, placement: held(taker.id, false), note };
    }
    case "pick_up":
    case "take_from": {
      if (!actor) return { ok: false, code: "merge.item.no_actor", message: `no actor to take "${item.name}"` };
      if (item.holderParticipantId === actor.id && !item.worn) return { ok: true, note }; // already held
      return { ok: true, placement: held(actor.id, false), note };
    }
    case "drop": {
      const locationId = ctx.location?.id ?? actor?.locationId ?? item.locationId;
      if (!locationId) return { ok: false, code: "merge.item.no_location", message: `nowhere to drop "${item.name}"` };
      return { ok: true, placement: atLocation(locationId), note };
    }
    case "place": {
      const locationId = ctx.location?.id ?? actor?.locationId ?? item.locationId;
      if (!locationId) return { ok: false, code: "merge.item.no_location", message: `nowhere to place "${item.name}"` };
      return { ok: true, placement: atLocation(locationId), note };
    }
    case "store_in":
      return planStoreInContainer(ctx.container, item, ctx.items, note);
    case "open":
    case "close": {
      if (item.definition.kind !== "container") {
        return { ok: false, code: "merge.item.not_container", message: `"${item.name}" is not a container` };
      }
      return { ok: true, open: event.action === "open", note };
    }
    case "alter": {
      return { ok: true, note: note ?? "altered" };
    }
  }
}

export interface MeterAdjustment {
  meterId: string;
  delta: number;
}

/** Agent deltas applied AFTER drift (corrections win over drift), clamped twice. */
export function applyMeterAdjustments(
  meters: Record<string, number>,
  adjustments: readonly MeterAdjustment[],
  defs: readonly MeterDefinition[],
  sink?: DiagnosticSink,
  participantName?: string,
): Record<string, number> {
  const known = new Set(defs.map((d) => d.id));
  const next = { ...meters };
  for (const adj of adjustments) {
    if (!known.has(adj.meterId)) {
      sink?.push(
        diag("warn", "merge.meter.unknown", `unknown meter "${adj.meterId}" dropped`, {
          context: { participantName, meterId: adj.meterId },
        }),
      );
      continue;
    }
    const delta = Number.isFinite(adj.delta) ? Math.max(-1, Math.min(1, adj.delta)) : 0;
    const current = next[adj.meterId] ?? defs.find((d) => d.id === adj.meterId)?.initial ?? 0;
    next[adj.meterId] = Math.min(1, Math.max(0, current + delta));
  }
  return next;
}

type ConditionEvent = SimulantResult["conditionEvents"][number];

export function applyConditionEvents(
  conditions: readonly ActiveCondition[],
  events: readonly ConditionEvent[],
  startedAtMinutes: number,
  sink?: DiagnosticSink,
): ActiveCondition[] {
  let next = [...conditions];
  for (const event of events) {
    const labelKey = event.label.trim().toLowerCase();
    if (!labelKey) continue;
    if (event.op === "end") {
      const before = next.length;
      next = next.filter((c) => c.label.trim().toLowerCase() !== labelKey);
      if (next.length === before) {
        sink?.push(
          diag("info", "merge.condition.unmatched", `condition "${event.label}" ended but was not active`, {
            context: { participantName: event.participantName },
          }),
        );
      }
      continue;
    }
    const existing = next.find((c) => c.label.trim().toLowerCase() === labelKey);
    if (existing) {
      // Refresh rather than duplicate.
      next = next.map((c) =>
        c === existing
          ? {
              ...c,
              severity: event.severity ?? c.severity,
              durationMinutes: event.durationMinutes ?? c.durationMinutes,
              promptHint: event.promptHint ?? c.promptHint,
              startedAtMinutes,
            }
          : c,
      );
      continue;
    }
    next.push({
      id: newId(),
      label: event.label,
      severity: event.severity,
      startedAtMinutes,
      durationMinutes: event.durationMinutes,
      source: { kind: "narrative" },
      attributeEffects: [],
      promptHint: event.promptHint,
    });
  }
  return next;
}

export function expireConditions(conditions: readonly ActiveCondition[], clockMinutes: number): ActiveCondition[] {
  return conditions.filter((c) => !isConditionExpired(c, clockMinutes));
}

export type ScheduleEntry = CharacterProfile["schedule"][number];

/**
 * Schedule entry covering a minute-of-day; windows may wrap past midnight.
 * Entries with a `days` mask only match on those weekdays (absent ⇒ daily).
 */
export function scheduleEntryAt(
  schedule: readonly ScheduleEntry[],
  minute: number,
  weekdayIndex?: number,
): ScheduleEntry | null {
  for (const entry of schedule) {
    if (entry.days && weekdayIndex !== undefined && !entry.days.includes(weekdayIndex)) continue;
    if (entry.startMinute <= entry.endMinute) {
      if (minute >= entry.startMinute && minute < entry.endMinute) return entry;
    } else if (minute >= entry.startMinute || minute < entry.endMinute) {
      return entry;
    }
  }
  return null;
}

export interface AffinityUpdate {
  /** Edge owner — always an NPC (decision 41). */
  fromParticipantId: string;
  toParticipantId: string;
  kind: "feeling" | "perceived";
  delta: number;
  reason?: string;
}

/**
 * Resolve simulant affinityAdjustments to relationship-edge updates
 * (cast-tiers-and-affinity-spec). fromName is whose feeling moved; when that
 * is the player, the evidence becomes the NPC's *perceived* affinity from the
 * player (decision 41 — the player's actual feelings are the player's own).
 * The summed raw delta is **scaled by the edge owner's traits** (personality §4
 * gain/loss asymmetry: warmth/agreeableness amplify gains, guardedness damps them,
 * composure damps losses) before the ±AFFINITY_DELTA_CLAMP clamp. Empty traits ⇒
 * the delta unchanged ⇒ exactly today's behavior. (Recognized social acts are
 * scaled inside the curve instead and never reach this path — they own their edge.)
 */
export function planAffinityUpdates(
  adjustments: SimulantResult["affinityAdjustments"],
  parts: readonly WorkingParticipant[],
  sink?: DiagnosticSink,
): AffinityUpdate[] {
  const byEdge = new Map<string, AffinityUpdate>();
  for (const adj of adjustments) {
    const from = findParticipant(adj.fromName, parts);
    const toward = findParticipant(adj.towardName, parts);
    if (!from || !toward || from.id === toward.id) {
      sink?.push(
        diag("warn", "merge.affinity.unresolved_pair", `affinity adjustment "${adj.fromName}" → "${adj.towardName}" dropped`, {
          context: { fromName: adj.fromName, towardName: adj.towardName },
        }),
      );
      continue;
    }
    if (from.isUser && toward.isUser) continue;
    const update: Omit<AffinityUpdate, "delta"> = from.isUser
      ? { fromParticipantId: toward.id, toParticipantId: from.id, kind: "perceived", reason: adj.reason }
      : { fromParticipantId: from.id, toParticipantId: toward.id, kind: "feeling", reason: adj.reason };
    const key = `${update.fromParticipantId}::${update.toParticipantId}::${update.kind}`;
    const existing = byEdge.get(key);
    const rawDelta = Number.isFinite(adj.delta) ? adj.delta : 0;
    const summed = (existing?.delta ?? 0) + rawDelta;
    byEdge.set(key, { ...update, delta: summed, reason: adj.reason ?? existing?.reason });
  }
  const updates: AffinityUpdate[] = [];
  for (const update of byEdge.values()) {
    const owner = parts.find((p) => p.id === update.fromParticipantId);
    const scaled = scaleAffinityGain(update.delta, owner?.snapshot.traits ?? []);
    const clamped = Math.max(-AFFINITY_DELTA_CLAMP, Math.min(AFFINITY_DELTA_CLAMP, Math.round(scaled)));
    if (clamped === 0) continue;
    updates.push({ ...update, delta: clamped });
  }
  return updates;
}

export interface ReactionAffinityResult {
  updates: AffinityUpdate[];
  /** Edge keys (from::to::kind) a reaction resolved for — suppress simulant updates here. */
  ownedEdgeKeys: Set<string>;
  /** Mood-meter nudge the reaction applies to the target NPC (spec §4); absent ⇒ none. */
  moodAdjustment?: { participantId: string; delta: number };
}

/**
 * Deterministic affinity from the player's classified social acts
 * (personality-and-state.spec.md §6). v1 plays the **primary** act: resolve it
 * against the target NPC's disposition, run the affinity-aware curve over the
 * NPC's turn-start *feeling* edge **and turn-start mood** (μ from the mood meter),
 * and emit a feeling delta plus a mood nudge. The reaction **owns** that edge — its
 * key is returned so the simulant's update on the same edge is dropped (the authored
 * verdict wins for recognized acts), even when the delta rounds to 0 ("lets it
 * slide"). No match ⇒ the simulant handles the edge as usual. `moodByParticipant`
 * supplies turn-start mood (so the narrated hint and the applied number agree); absent
 * ⇒ read the current meter (neutral in tests).
 */
export function planReactionAffinity(
  socialActs: IntentBrief["socialActs"],
  parts: readonly WorkingParticipant[],
  relationships: readonly BundleRelationship[],
  sink?: DiagnosticSink,
  moodByParticipant?: ReadonlyMap<string, number>,
): ReactionAffinityResult {
  const empty: ReactionAffinityResult = { updates: [], ownedEdgeKeys: new Set() };
  const primary = socialActs[0]; // v1: primary act only (multi-act deferred)
  if (!primary) return empty;
  const player = parts.find((p) => p.isUser);
  if (!player) return empty;
  const target = findParticipant(primary.target, parts);
  if (!target || target.isUser) {
    sink?.push(
      diag("warn", "merge.reaction.unresolved_target", `social act target "${primary.target}" (${primary.concept}) unresolved`, {
        context: { target: primary.target, concept: primary.concept },
      }),
    );
    return empty;
  }

  const reaction = resolveSocialReaction(
    { concept: primary.concept, target: primary.target },
    { tags: target.snapshot.tags, preferences: target.snapshot.preferences, cards: [] },
  );
  if (!reaction) return empty;

  const feeling = relationships.find(
    (r) => r.kind === "feeling" && r.fromParticipantId === target.id && r.toParticipantId === player.id,
  );
  const mood = moodByParticipant?.get(target.id) ?? target.state.meters.mood ?? NEUTRAL_MOOD_METER;
  const evaluated = evaluateSocialReaction(
    reaction,
    feeling?.value ?? 0,
    moodMeterToFactor(mood),
    socialTraitScale(reaction, target.snapshot.traits),
  );
  const ownedEdgeKeys = new Set([`${target.id}::${player.id}::feeling`]);

  // The reaction also nudges the target's mood (a like lifts, a dislike lowers).
  const md = moodNudge(evaluated);
  const moodAdjustment = Math.abs(md) >= 0.005 ? { participantId: target.id, delta: md } : undefined;

  const signed = evaluated.valence === "dislike" ? -evaluated.magnitude : evaluated.magnitude;
  const delta = Math.max(-AFFINITY_DELTA_CLAMP, Math.min(AFFINITY_DELTA_CLAMP, Math.round(signed)));
  const updates =
    delta === 0
      ? []
      : [{ fromParticipantId: target.id, toParticipantId: player.id, kind: "feeling" as const, delta, reason: `reaction:${reaction.conceptId}` }];
  return { updates, ownedEdgeKeys, moodAdjustment };
}

/** Reaction updates win their edge; simulant updates on an owned edge are dropped. */
export function combineAffinityUpdates(reaction: ReactionAffinityResult, simulant: AffinityUpdate[]): AffinityUpdate[] {
  const kept = simulant.filter(
    (u) => !reaction.ownedEdgeKeys.has(`${u.fromParticipantId}::${u.toParticipantId}::${u.kind}`),
  );
  return [...reaction.updates, ...kept];
}

/**
 * One edge's decay: `points` toward 0, stopped at a **floor** that sits between the
 * stage's zero-side boundary and the current value. `retention` (0..1, personality §4)
 * lifts that floor toward the current value, so a warm, even-keeled (constant) character
 * resists decay — its regard ebbs only a fraction of the way to the boundary each pass.
 * `retention = 0` ⇒ the floor *is* the stage boundary ⇒ exactly today's behavior. The
 * floor is always ≥ the boundary, so decay never crosses a stage boundary regardless of
 * traits (stages stay sticky; only events demote).
 */
export function decayAffinityValue(value: number, points: number, retention = 0): { value: number; clamped: boolean } {
  if (points <= 0 || value === 0) return { value, clamped: false };
  const stage = stageForValue(value);
  if (value > 0) {
    // E.g. friendly (33..49): decay stops at 33; stranger (−14..14) decays through to 0.
    const boundary = Math.max(0, stage.min);
    const floor = Math.round(boundary + retention * (value - boundary));
    const target = value - points;
    return target < floor ? { value: floor, clamped: floor > 0 } : { value: target, clamped: false };
  }
  const boundary = Math.min(0, stage.max);
  const floor = Math.round(boundary + retention * (value - boundary));
  const target = value + points;
  return target > floor ? { value: floor, clamped: floor < 0 } : { value: target, clamped: false };
}

export interface AffinityDecayEdge {
  fromParticipantId: string;
  toParticipantId: string;
  kind: "feeling" | "perceived";
  /** Value before decay. */
  previousValue: number;
  /** Value after decay — same stage by construction (decay never crosses a boundary). */
  value: number;
  /** Decay wanted to keep going but stopped at the stage's zero-side boundary. */
  clamped: boolean;
}

export interface AffinityDecayResult {
  edges: AffinityDecayEdge[];
  /** New runtime marker: seeded on first use, else advanced by the consumed whole weeks. */
  lastAffinityDecayAt: number;
}

/**
 * Affinity decay (defaults doc §Affinity stages): 1 point per whole elapsed
 * in-game week toward 0 on every relationship edge — but decay alone never
 * crosses a stage boundary; it stops at a trait-derived floor at or above the
 * stage's zero-side edge (stages are sticky; only events demote). The floor is
 * lifted toward the current value by the owner's **decay retention** (personality
 * §4: warmth + composure ⇒ a constant character holds its regard, ebbing more
 * slowly than a fickle one); absent traits ⇒ retention 0 ⇒ the floor is the stage
 * boundary, exactly today's behavior. Edges parked at their floor still plan a
 * `clamped` edge each decay pass — that drives the `affinity_decay_clamped` events
 * row, the tuning evidence for the "relationships fossilizing" revisit trigger.
 * The marker advances by whole weeks only, so the remainder keeps accumulating.
 */
export function planAffinityDecay(
  input: {
    relationships: readonly BundleRelationship[];
    /** Post-turn session clock. */
    clockMinutes: number;
    lastAffinityDecayAt: number | undefined;
    /** Owner participant id → resolved traits, for per-character decay retention. Absent ⇒ baseline decay. */
    traitsByParticipant?: ReadonlyMap<string, readonly TraitValue[]>;
  },
  sink?: DiagnosticSink,
): AffinityDecayResult {
  const last = input.lastAffinityDecayAt;
  if (last === undefined) return { edges: [], lastAffinityDecayAt: input.clockMinutes }; // seed on first use
  if (last > input.clockMinutes) {
    sink?.push(
      diag("warn", "merge.affinity.decay_marker_reset", `lastAffinityDecayAt ${last} is ahead of the clock ${input.clockMinutes} — reseeded`),
    );
    return { edges: [], lastAffinityDecayAt: input.clockMinutes };
  }
  const weeks = Math.floor((input.clockMinutes - last) / AFFINITY_DECAY_WEEK_MINUTES);
  if (weeks < 1) return { edges: [], lastAffinityDecayAt: last };
  const edges: AffinityDecayEdge[] = [];
  for (const rel of input.relationships) {
    const retention = affinityDecayRetention(input.traitsByParticipant?.get(rel.fromParticipantId) ?? []);
    const decayed = decayAffinityValue(rel.value, weeks, retention);
    if (decayed.value === rel.value && !decayed.clamped) continue;
    edges.push({
      fromParticipantId: rel.fromParticipantId,
      toParticipantId: rel.toParticipantId,
      kind: rel.kind,
      previousValue: rel.value,
      value: decayed.value,
      clamped: decayed.clamped,
    });
  }
  return { edges, lastAffinityDecayAt: last + weeks * AFFINITY_DECAY_WEEK_MINUTES };
}

export interface CommsChange {
  op: "open" | "close";
  kind: "call" | "text";
  withParticipantId: string;
}

export interface CommsPlanResult {
  /** The merged link list to persist to runtime.commsLinks. */
  links: CommsLink[];
  /** Per-turn opens/closes, for the events log. */
  changes: CommsChange[];
}

/**
 * Comms link persistence (presence-and-perception-spec §comms). `open` resolves
 * `withName` to a participant and adds/replaces that NPC's link (one link per
 * participant — re-opening replaces in place); `close` removes any link to that
 * participant. Unresolved names drop with a diagnostic. Pure given the resolver.
 */
export function planCommsEvents(
  events: SimulantResult["commsEvents"],
  prior: readonly CommsLink[],
  clockMinutes: number,
  parts: readonly WorkingParticipant[],
  sink?: DiagnosticSink,
): CommsPlanResult {
  const links = prior.map((l) => ({ ...l }));
  const changes: CommsChange[] = [];
  for (const event of events) {
    const target = findParticipant(event.withName, parts);
    if (!target) {
      sink?.push(
        diag("warn", "merge.comms.unresolved", `comms ${event.op} target "${event.withName}" not found`, {
          context: { withName: event.withName, op: event.op, kind: event.kind },
        }),
      );
      continue;
    }
    const idx = links.findIndex((l) => l.withParticipantId === target.id);
    if (event.op === "open") {
      const link: CommsLink = { kind: event.kind, withParticipantId: target.id, since: clockMinutes };
      if (idx >= 0) links[idx] = link;
      else links.push(link);
      changes.push({ op: "open", kind: event.kind, withParticipantId: target.id });
    } else {
      if (idx >= 0) {
        const [removed] = links.splice(idx, 1);
        changes.push({ op: "close", kind: removed?.kind ?? event.kind, withParticipantId: target.id });
      }
      // Closing a link that was never open is a no-op (no diagnostic — benign).
    }
  }
  return { links, changes };
}

/**
 * The set of saliences the player's actions carried this turn (presence-spec
 * §witness sets). The baseline is `obvious/quiet` — a plainly visible turn —
 * unless the player declared stealth AND there is someone present to hide from
 * (a co-located non-user participant not named/targeted in the input), in which
 * case the baseline is concealed. Each player-actor item/activity event that
 * tagged its own salience joins the set; untagged events fall back to the
 * baseline. Returns at least the baseline.
 */
export function turnSalienceSet(input: {
  inputText: string;
  /** Saliences explicitly tagged on the player's own item/activity events. */
  explicit: readonly Salience[];
  /** A co-located non-user participant is present who is NOT named/targeted in the input. */
  hasConcealmentTarget: boolean;
}): Salience[] {
  const baseline =
    hasStealthMarker(input.inputText) && input.hasConcealmentTarget ? concealedSalience() : defaultSalience();
  const set: Salience[] = [baseline];
  const seen = new Set<string>([`${baseline.visual}::${baseline.audible}`]);
  for (const s of input.explicit) {
    const key = `${s.visual}::${s.audible}`;
    if (seen.has(key)) continue;
    seen.add(key);
    set.push(s);
  }
  return set;
}

/**
 * Seeded daily schedule jitter (decision 33): same character + same day ⇒
 * same offset in [-max, +max], so routines read as life, not clockwork —
 * reproducibly. FNV-1a, dependency-free.
 */
export function scheduleJitter(participantId: string, dayIndex: number, max = SCHEDULE_JITTER_MINUTES): number {
  const text = `${participantId}::${dayIndex}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % (2 * max + 1)) - max;
}

export interface ScheduleMoveStagingInput {
  displayName: string;
  fromLocationId: string | null;
  toLocationId: string;
  /** The player's (camera's) location this turn. */
  activeLocationId: string | null;
  locationNameById: ReadonlyMap<string, string>;
}

/**
 * Arrival/departure staging (phase-2-plan T9): when an off-screen schedule
 * tick moves an NPC into or out of the player's location, the next brief
 * carries a line so the narrator stages motivated movement instead of
 * teleportation. Moves elsewhere stage nothing. V1 assumes co-located ⇒
 * perceived — the same interim rule as witnessed_by; the presence phase's
 * witness machinery gates these lines when it ships.
 */
export function scheduleMoveStaging(input: ScheduleMoveStagingInput): { arrival?: string; departure?: string } {
  if (input.activeLocationId === null || input.fromLocationId === input.toLocationId) return {};
  if (input.toLocationId === input.activeLocationId) {
    const from = input.fromLocationId ? input.locationNameById.get(input.fromLocationId) : undefined;
    return { arrival: from ? `${input.displayName} arrived from ${from}.` : `${input.displayName} arrived.` };
  }
  if (input.fromLocationId === input.activeLocationId) {
    const toward = input.locationNameById.get(input.toLocationId);
    return { departure: toward ? `${input.displayName} left toward ${toward}.` : `${input.displayName} left.` };
  }
  return {};
}

type ThreadSignals = NonNullable<DirectorResult["threadSignals"]>;

export interface ThreadSignalResult {
  threads: StoryThread[];
  touchedIds: string[];
}

/**
 * Thread lifecycle (docs/story-threads.md): touch keeps a thread warm (no log
 * entry), develop appends an accumulated development on a major beat, propose
 * opens a new thread (deduped by exact title here as the innermost guard;
 * semantic dedup runs upstream in dedupeThreadProposals), resolve closes an
 * investigation. Unknown references degrade to diagnostics. Signals are
 * partial-tolerant so callers (and tests) may omit empty channels.
 */
export function applyThreadSignals(
  threads: readonly StoryThread[],
  signals: Partial<ThreadSignals>,
  turnNumber: number,
  sink?: DiagnosticSink,
): ThreadSignalResult {
  const next = threads.map((t) => ({ ...t }));
  const touchedIds = new Set<string>();

  const refresh = (thread: StoryThread, summary?: string) => {
    thread.status = "open";
    thread.lastTouchedTurn = turnNumber;
    thread.touchCount += 1;
    if (summary?.trim()) thread.summary = summary.trim();
    touchedIds.add(thread.id);
  };

  // develop = refresh + append an accumulated development (capped, oldest dropped).
  const develop = (thread: StoryThread, entry: string, entryKind: StoryThreadDevelopment["kind"] | undefined, summary?: string) => {
    refresh(thread, summary);
    const text = entry.trim();
    if (!text) return;
    thread.developments = [...thread.developments, { turn: turnNumber, text, kind: entryKind ?? "update" }].slice(
      -THREAD_DEVELOPMENTS_CAP,
    );
  };

  const byTitle = (title: string) => next.find((t) => t.title.trim().toLowerCase() === title.trim().toLowerCase());
  const find = (id?: string, title?: string) =>
    (id ? next.find((t) => t.id === id) : undefined) ?? (title ? byTitle(title) : undefined);

  for (const touch of signals.touch ?? []) {
    const thread = find(touch.id, touch.title);
    if (!thread) {
      sink?.push(diag("info", "merge.thread.unmatched", `touched thread "${touch.title}" not found`, { context: { id: touch.id } }));
      continue;
    }
    refresh(thread, touch.summary);
  }

  for (const entry of signals.develop ?? []) {
    const thread = find(entry.id, entry.title);
    if (!thread) {
      sink?.push(
        diag("info", "merge.thread.unmatched", `developed thread "${entry.title ?? entry.id ?? ""}" not found`, {
          context: { id: entry.id },
        }),
      );
      continue;
    }
    develop(thread, entry.entry, entry.entryKind, entry.summary);
  }

  for (const proposal of signals.propose ?? []) {
    if (!proposal.title.trim()) continue;
    const existing = byTitle(proposal.title);
    if (existing) {
      // Exact-title re-proposal of a live thread is a development, not a duplicate.
      develop(existing, proposal.summary, "update", proposal.summary);
      continue;
    }
    const summary = proposal.summary.trim();
    const thread = storyThreadSchema.parse({
      id: newId(),
      title: proposal.title.trim(),
      summary,
      kind: proposal.kind,
      status: "open",
      source: "emergent",
      question: proposal.question ?? "",
      closeConditions: proposal.closeConditions ?? [],
      // Seed the timeline with the opening beat so the modal isn't empty.
      developments: summary ? [{ turn: turnNumber, text: summary, kind: "update" }] : [],
      openedAtTurn: turnNumber,
      lastTouchedTurn: turnNumber,
      touchCount: 1,
    });
    next.push(thread);
    touchedIds.add(thread.id);
  }

  for (const id of signals.resolve ?? []) {
    const thread = next.find((t) => t.id === id);
    if (!thread) {
      sink?.push(diag("info", "merge.thread.unmatched", `resolved thread "${id}" not found`));
      continue;
    }
    thread.status = "resolved";
    thread.lastTouchedTurn = turnNumber;
    touchedIds.add(thread.id);
  }

  return { threads: next, touchedIds: [...touchedIds] };
}

/** Text a thread/proposal embeds as for dedup: title, question, and synopsis together. */
function threadDedupText(t: { title: string; question?: string; summary?: string }): string {
  return [t.title, t.question, t.summary].map((s) => s?.trim()).filter(Boolean).join(" — ");
}

/**
 * Semantic dedup backstop (docs/story-threads.md): a proposed thread whose
 * title+question+summary is near-identical to an existing open/cooling thread is
 * rewritten into a `develop` on that thread instead of opening a duplicate —
 * the same belt-and-suspenders idiom as the item-dedupe ladder. Conservative
 * threshold (THREAD_DEDUPE_MIN_SCORE) so only obvious dupes merge; the director
 * prompt is the primary consolidation. Resolved/archived threads are never
 * candidates (a closed thread must not resurrect). Embedding failure degrades
 * to the exact-title guard in applyThreadSignals.
 */
export async function dedupeThreadProposals(
  threads: readonly StoryThread[],
  signals: ThreadSignals,
  embed: (texts: string[]) => Promise<number[][]>,
  turnNumber: number,
  sink?: DiagnosticSink,
): Promise<ThreadSignals> {
  void turnNumber; // reserved for future recency-aware tie-breaks; keeps the call signature stable
  if (signals.propose.length === 0) return signals;
  const candidates = threads.filter((t) => t.status === "open" || t.status === "cooling");
  if (candidates.length === 0) return signals;

  let vectors: number[][];
  try {
    vectors = await embed([...candidates.map(threadDedupText), ...signals.propose.map(threadDedupText)]);
  } catch (err) {
    sink?.push(
      diag("warn", "merge.thread.dedup_embed_failed", `thread dedup embedding failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    return signals;
  }
  const candVecs = vectors.slice(0, candidates.length);
  const propVecs = vectors.slice(candidates.length);

  const extraDevelop: ThreadSignals["develop"] = [];
  const keptProposals: ThreadSignals["propose"] = [];
  signals.propose.forEach((proposal, i) => {
    const pv = propVecs[i];
    let bestScore = -1;
    let bestIdx = -1;
    if (pv) {
      candVecs.forEach((cv, j) => {
        const score = cosineSimilarity(pv, cv);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      });
    }
    const match = bestIdx >= 0 ? candidates[bestIdx] : undefined;
    if (match && bestScore >= THREAD_DEDUPE_MIN_SCORE) {
      sink?.push(
        diag(
          "info",
          "merge.thread.dedup_merged",
          `proposed thread "${proposal.title}" folded into "${match.title}" (${bestScore.toFixed(2)})`,
        ),
      );
      extraDevelop.push({ id: match.id, entry: proposal.summary.trim() || proposal.title.trim(), summary: proposal.summary });
    } else {
      keptProposals.push(proposal);
    }
  });

  if (extraDevelop.length === 0) return signals;
  return { ...signals, propose: keptProposals, develop: [...signals.develop, ...extraDevelop] };
}

/** Open threads untouched for THREAD_COOLING_TURNS move to cooling. */
export function coolThreads(threads: readonly StoryThread[], turnNumber: number): StoryThread[] {
  return threads.map((t) =>
    t.status === "open" && turnNumber - t.lastTouchedTurn >= THREAD_COOLING_TURNS ? { ...t, status: "cooling" as const } : t,
  );
}

export interface BriefBuildInput {
  prior: NextTurnBrief;
  director: DirectorResult | null;
  continuity: ContinuityResult | null;
  episodeSummary: string;
  droppedEvents: readonly string[];
  /** Newly crossed meter-threshold hints, "Name: hint". */
  thresholdHints: readonly string[];
  /** Schedule-tick staging lines (scheduleMoveStaging) — per-turn, never carried forward. */
  arrivals?: readonly string[];
  departures?: readonly string[];
  /** On-arrival directives from staged beats that fired this turn — play the beat next turn. */
  stagedDirectives?: readonly string[];
}

/**
 * Next-turn brief (docs/turn-engine.md step 7). Director failure → the
 * previous brief carries forward with sceneSummary refreshed from the episode
 * and memoryQueries kept. Continuity output folds in as at most
 * CORRECTION_CAP `Correction:`-prefixed directives (self-expiring — the brief
 * is rebuilt every turn).
 */
export function buildNextBrief(input: BriefBuildInput): NextTurnBrief {
  // Arrivals/departures are this turn's staging only — stale lines would
  // re-stage a long-finished entrance, so they never carry forward from prior.
  const arrivals = [...(input.arrivals ?? [])];
  const departures = [...(input.departures ?? [])];
  const base: NextTurnBrief = input.director
    ? {
        sceneSummary: input.director.sceneSummary.trim() || input.episodeSummary || input.prior.sceneSummary,
        storySoFar: input.director.storySoFar.trim() || input.prior.storySoFar,
        characterNotes: [...input.director.characterNotes],
        directives: [...input.director.directives],
        memoryQueries: input.director.memoryQueries.length > 0 ? [...input.director.memoryQueries] : [...input.prior.memoryQueries],
        exposure: input.director.exposure,
        droppedEvents: [],
        arrivals,
        departures,
      }
    : {
        ...input.prior,
        sceneSummary: input.episodeSummary || input.prior.sceneSummary,
        characterNotes: [...input.prior.characterNotes],
        directives: [...input.prior.directives],
        memoryQueries: [...input.prior.memoryQueries],
        droppedEvents: [],
        arrivals,
        departures,
      };

  const corrections: string[] = [];
  if (input.continuity) {
    const violations = [...input.continuity.violations].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1,
    );
    for (const v of violations) {
      corrections.push(`Correction: the narration claimed "${v.claim}" but canon holds "${v.canonical}" (${v.subject}).`);
    }
    for (const b of input.continuity.normBreaches) {
      const witnesses = b.witnessNames.length > 0 ? ` (seen by ${b.witnessNames.join(", ")})` : "";
      const reaction = b.suggestedReaction.trim() || "let witnesses react in character";
      corrections.push(`Correction: ${b.byName} breached the norm "${b.normRule}"${witnesses} — next turn: ${reaction}`);
    }
  }

  const directives = dedupe([
    ...base.directives,
    ...(input.stagedDirectives ?? []),
    ...corrections.slice(0, CORRECTION_CAP),
    ...input.thresholdHints.slice(0, THRESHOLD_HINT_CAP),
  ]).slice(0, DIRECTIVE_CAP);

  const candidate: NextTurnBrief = {
    ...base,
    directives,
    droppedEvents: [...input.droppedEvents],
  };
  const parsed = nextTurnBriefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : emptyBrief();
}

/**
 * Reconcile-mode brief (docs/turn-engine.md §Edit / rerun): the prior brief
 * carries forward untouched — no director/continuity ran — except that this
 * reconcile's dropped events and newly crossed meter thresholds fold in.
 * Without this, an edit that references unknown entities fails silently and a
 * meter adjustment that crosses a threshold never surfaces to the next turn.
 * Returns the prior brief by identity when there is nothing to fold.
 */
export function reconcileBrief(
  prior: NextTurnBrief,
  droppedEvents: readonly string[],
  thresholdHints: readonly string[],
): NextTurnBrief {
  if (droppedEvents.length === 0 && thresholdHints.length === 0) return prior;
  const candidate: NextTurnBrief = {
    ...prior,
    directives: dedupe([...prior.directives, ...thresholdHints.slice(0, THRESHOLD_HINT_CAP)]).slice(0, DIRECTIVE_CAP),
    droppedEvents: dedupe([...prior.droppedEvents, ...droppedEvents]),
  };
  const parsed = nextTurnBriefSchema.safeParse(candidate);
  return parsed.success ? parsed.data : prior;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function syntheticEpisodeSummary(narration: string): string {
  const trimmed = narration.trim().replace(/\s+/g, " ");
  if (!trimmed) return "(turn completed without narration)";
  return trimmed.length <= SYNTHETIC_EPISODE_CHARS ? trimmed : `${trimmed.slice(0, SYNTHETIC_EPISODE_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const SIMULANT_FALLBACK: SimulantResult = {
  minutesAdvanced: FALLBACK_MINUTES_ADVANCED,
  movements: [],
  itemEvents: [],
  meterAdjustments: [],
  conditionEvents: [],
  attributeChanges: [],
  activityUpdates: [],
  affinityAdjustments: [],
  commsEvents: [],
};

const CONTINUITY_FALLBACK: ContinuityResult = { violations: [], normBreaches: [], driftNotes: [] };

export async function planTurnEffects(input: PlanInput): Promise<MergePlan> {
  const { bundle, turn, results, sink } = input;
  const mode: MergeMode = input.mode ?? "post_turn";
  const droppedEvents: string[] = [];

  const simulant = results.simulant ?? SIMULANT_FALLBACK;
  if (!results.simulant) {
    sink.push(diag("warn", "merge.simulant.degraded", "simulant failed — no state changes; clock advances by fallback"));
  }
  const continuity = results.continuity ?? CONTINUITY_FALLBACK;

  const parts: WorkingParticipant[] = bundle.participants.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    isUser: p.isUser,
    role: p.role,
    characterId: p.characterId,
    snapshot: p.snapshot,
    locationId: p.locationId,
    state: structuredClone(p.state),
  }));
  const items: WorkingItem[] = bundle.items.map((i) => ({
    id: i.id,
    name: i.name,
    itemId: i.itemId,
    definition: i.definition,
    holderParticipantId: i.holderParticipantId,
    worn: i.worn,
    locationId: i.locationId,
    containerInstanceId: i.containerInstanceId,
    positionNote: i.positionNote ?? null,
    state: structuredClone(i.state),
  }));
  const touchedItemIds = new Set<string>();
  const touchedParticipantIds = new Set<string>();
  const player = parts.find((p) => p.isUser) ?? null;

  const resolveLocation = async (name: string): Promise<BundlePlace | null> => {
    const direct = resolveSessionLocation(name, bundle.locations);
    if (direct) return direct;
    if (!input.deps?.resolveLibraryLocation) return null;
    try {
      const match = await input.deps.resolveLibraryLocation(name);
      if (!match) return null;
      return bundle.locations.find((l) => l.locationId === match.id) ?? null;
    } catch {
      return null;
    }
  };

  const resolveItem = async (
    name: string,
    action: ItemAction,
    actor: { id: string; locationId: string | null } | null,
  ): Promise<WorkingItem | null> => {
    const direct = resolveItemByName(name, action, items, actor);
    if (direct) return direct;
    if (!input.deps?.resolveLibraryItem) return null;
    try {
      const match = await input.deps.resolveLibraryItem(name);
      if (!match) return null;
      return pickBest(items.filter((i) => i.itemId === match.id), action, actor);
    } catch {
      return null;
    }
  };

  // -- Step 2: movements (validated against the session location graph) ------
  // Movement and declared rest both resolve against the turn-START time: the
  // player walks through (or is blocked by) the door at the moment they act.
  const turnStartMinute = minuteOfDay(resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart));
  let playerTravelMinutes = 0;
  for (const movement of simulant.movements) {
    const participant = findParticipant(movement.participantName, parts);
    if (!participant) {
      sink.push(
        diag("warn", "merge.participant.unresolved", `movement participant "${movement.participantName}" not found`),
      );
      droppedEvents.push(`${movement.participantName} did not actually move to ${movement.toLocationName} (unknown character).`);
      continue;
    }
    if (participant.isUser && turn.author !== "player") {
      sink.push(
        diag("warn", "merge.movement.player_not_author", "player movement dropped: the player only moves on player-authored turns"),
      );
      droppedEvents.push(`The player did not actually move to ${movement.toLocationName}.`);
      continue;
    }
    const target = await resolveLocation(movement.toLocationName);
    if (!target) {
      sink.push(diag("warn", "merge.location.unresolved", `movement target "${movement.toLocationName}" not found`));
      droppedEvents.push(`${participant.displayName} did not actually move to ${movement.toLocationName} (unknown location).`);
      continue;
    }
    if (target.id === participant.locationId) continue;
    if (!isAdjacent(participant.locationId, target.id, bundle.links)) {
      sink.push(
        diag("warn", "merge.movement.invalid", `movement to non-adjacent location "${target.name}" dropped`, {
          context: { participantName: participant.displayName },
        }),
      );
      droppedEvents.push(`${participant.displayName} did not actually move to ${target.name} (not adjacent).`);
      continue;
    }
    // Link access (phase-2-plan T8, player-side only — NPC traversal reuses
    // checkLinkAccess when the drives phase ships). A link with no access
    // field parsed to public at the bundle boundary: today's behavior.
    if (participant.isUser && participant.locationId !== null) {
      const link = findLink(participant.locationId, target.id, bundle.links);
      const door = link?.doorItemId ? (items.find((i) => i.id === link.doorItemId)?.state ?? null) : null;
      const verdict = checkLinkAccess({
        access: link?.access ?? { kind: "public" },
        minuteOfDay: turnStartMinute,
        moverParticipantId: participant.id,
        door,
      });
      if (!verdict.passable) {
        sink.push(
          diag("warn", "merge.movement.access_denied", `player movement to "${target.name}" blocked: ${verdict.reason}`, {
            context: { participantName: participant.displayName, toLocationName: target.name, kind: verdict.kind },
          }),
        );
        droppedEvents.push(
          `The player did not actually reach ${target.name} — ${verdict.reason}. Narrate the blocked way, not the arrival.`,
        );
        continue;
      }
    }
    if (participant.isUser) {
      playerTravelMinutes = Math.max(
        playerTravelMinutes,
        linkTravelMinutes(participant.locationId, target.id, bundle.links),
      );
    }
    participant.locationId = target.id;
    touchedParticipantIds.add(participant.id);
  }

  // -- Step 3: item events ----------------------------------------------------
  for (const event of simulant.itemEvents) {
    const actor = event.byName ? findParticipant(event.byName, parts) : player;
    if (event.byName && !actor) {
      sink.push(diag("warn", "merge.participant.unresolved", `item event actor "${event.byName}" not found`));
      droppedEvents.push(`The ${event.action} of ${event.itemName} did not take effect (unknown character ${event.byName}).`);
      continue;
    }
    const actorRef = actor ? { id: actor.id, locationId: actor.locationId } : null;
    const item = await resolveItem(event.itemName, event.action, actorRef);
    if (!item) {
      sink.push(diag("warn", "merge.item.unresolved", `item "${event.itemName}" not found in this session`));
      droppedEvents.push(`The ${event.action} of ${event.itemName} did not take effect (no such item).`);
      continue;
    }
    const location = event.locationName ? await resolveLocation(event.locationName) : null;
    const container = event.containerName
      ? await resolveItem(event.containerName, "open", actorRef)
      : null;
    const planned = planItemEvent(event, { item, actor, location, container, items });
    if (!planned.ok) {
      sink.push(diag("warn", planned.code, planned.message, { context: { action: event.action, itemName: event.itemName } }));
      droppedEvents.push(`The ${event.action} of ${item.name} did not take effect (${planned.message}).`);
      continue;
    }
    if (planned.placement) {
      if (!assertPlacementExclusive(planned.placement)) {
        sink.push(diag("error", "merge.item.placement_invalid", `planned placement for "${item.name}" violates exclusivity`));
        continue;
      }
      item.holderParticipantId = planned.placement.holderParticipantId;
      item.worn = planned.placement.worn;
      item.locationId = planned.placement.locationId;
      item.containerInstanceId = planned.placement.containerInstanceId;
      item.positionNote = event.action === "place" ? (event.stateNote?.trim() || null) : null;
      touchedItemIds.add(item.id);
    }
    if (planned.open !== undefined) {
      item.state.open = planned.open;
      touchedItemIds.add(item.id);
    }
    if (planned.note && (event.action === "alter" || !planned.placement)) {
      item.state.notes = [...item.state.notes, planned.note].slice(-ITEM_NOTE_CAP);
      touchedItemIds.add(item.id);
    }
  }

  // -- Step 4: clock, meters (drift THEN deltas), conditions, schedules -------
  const reconcile = mode === "reconcile";
  // Registered actions: matched in the player's own input only (companion/
  // director turns keep the pure estimate) — docs/developer-notes/time-and-travel-spec.phase3.md.
  const matchedActions = !reconcile && turn.author === "player" ? matchActions(turn.input) : [];
  // Declared rest (decision 38): "I sleep until morning" fast-forwards to a
  // schedule-aware endpoint, clamped to REST_CLAMP_MINUTES inside the clock
  // resolution. World-tick batching across the span is reserved for the
  // offscreen-simulation phase — today the single post-turn schedule tick at
  // the post-rest clock is all that runs (intermediate slots are skipped).
  const declaredRest = !reconcile && turn.author === "player" ? detectDeclaredRest(turn.input) : null;
  const resolved = reconcile
    ? { minutes: 0, cause: "reconcile" }
    : resolveTurnMinutes(
        {
          estimate: results.simulant ? simulant.minutesAdvanced : null,
          travelMinutes: playerTravelMinutes,
          actions: matchedActions,
          rest: declaredRest ? declaredRestMinutes(declaredRest, turnStartMinute) : null,
        },
        sink,
      );
  const minutes = resolved.minutes;
  const minutesCause = resolved.cause;
  const clockMinutes = bundle.clockMinutes + minutes;

  const defs = effectiveMeterDefinitions(bundle.style);
  // Turn-start mood, captured before drift mutates it — the social reaction reads this
  // for its μ so the narrated hint and the applied delta agree (the §6 key invariant).
  const moodAtTurnStart = new Map(parts.map((p) => [p.id, p.state.meters.mood ?? NEUTRAL_MOOD_METER]));
  const hintsBefore = new Map(parts.map((p) => [p.id, crossedThresholdHints(p.state.meters, defs)]));

  const adjustmentsByParticipant = new Map<string, MeterAdjustment[]>();
  for (const adj of simulant.meterAdjustments) {
    const participant = findParticipant(adj.participantName, parts);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `meter adjustment for "${adj.participantName}" dropped`));
      continue;
    }
    const list = adjustmentsByParticipant.get(participant.id) ?? [];
    list.push({ meterId: adj.meterId, delta: adj.delta });
    adjustmentsByParticipant.set(participant.id, list);
  }

  for (const participant of parts) {
    // Per-character drift: traits shift the resting baseline/recovery (spec §4); thresholds
    // and agent adjustments still use the global defs.
    const drifted = reconcile
      ? participant.state.meters
      : applyMeterDrift(participant.state.meters, minutes, personalizeMeters(defs, participant.snapshot.traits));
    // Registered-action effects (shower ⇒ hygiene) apply after drift and
    // before agent deltas, so narration-grounded corrections still win.
    const withActionEffects =
      participant.isUser && matchedActions.length > 0
        ? applyActionMeterEffects(drifted, matchedActions, defs, sink, participant.displayName)
        : drifted;
    participant.state.meters = applyMeterAdjustments(
      withActionEffects,
      adjustmentsByParticipant.get(participant.id) ?? [],
      defs,
      sink,
      participant.displayName,
    );
    touchedParticipantIds.add(participant.id);
  }

  // Social-reaction affinity + mood (personality §6/§4): resolve the player's primary
  // social act against the target's disposition over turn-start feeling + mood, then nudge
  // the target's mood (post-drift — the event moved it this turn). Affinity is applied via
  // the return's affinityUpdates; the mood nudge is a direct meter write here.
  const reactionResult = reconcile
    ? null
    : planReactionAffinity(turn.intentBrief?.socialActs ?? [], parts, bundle.relationships, sink, moodAtTurnStart);
  if (reactionResult?.moodAdjustment) {
    const t = parts.find((p) => p.id === reactionResult.moodAdjustment?.participantId);
    if (t) {
      const next = Math.min(1, Math.max(0, (t.state.meters.mood ?? NEUTRAL_MOOD_METER) + reactionResult.moodAdjustment.delta));
      t.state.meters = { ...t.state.meters, mood: next };
      touchedParticipantIds.add(t.id);
    }
  }

  // Conditions: agent ops first, then duration expiry against the new clock.
  const conditionsByParticipant = new Map<string, ConditionEvent[]>();
  for (const event of simulant.conditionEvents) {
    const participant = findParticipant(event.participantName, parts);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `condition event for "${event.participantName}" dropped`));
      continue;
    }
    const list = conditionsByParticipant.get(participant.id) ?? [];
    list.push(event);
    conditionsByParticipant.set(participant.id, list);
  }
  for (const participant of parts) {
    const withOps = applyConditionEvents(
      participant.state.conditions,
      conditionsByParticipant.get(participant.id) ?? [],
      clockMinutes,
      sink,
    );
    participant.state.conditions = expireConditions(withOps, clockMinutes);
  }

  // Attribute changes (rare, lasting): overlays with narrative provenance.
  for (const change of simulant.attributeChanges) {
    const participant = findParticipant(change.participantName, parts);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `attribute change for "${change.participantName}" dropped`));
      continue;
    }
    if (!attributeRegistry.byId(change.attributeId)) {
      sink.push(diag("warn", "merge.attribute.unknown", `unknown attribute "${change.attributeId}" dropped`));
      continue;
    }
    const overlay = parseOrNull(
      attributeValueSchema,
      { id: change.attributeId, value: change.value, source: "narrative", note: change.note },
      sink,
      "merge.attributeChange",
    );
    if (!overlay) {
      sink.push(diag("warn", "merge.attribute.invalid", `attribute change for "${change.attributeId}" failed validation`));
      continue;
    }
    participant.state.attributeOverlays = [
      ...participant.state.attributeOverlays.filter((o) => !(o.id === overlay.id && o.source === "narrative")),
      overlay,
    ];
    touchedParticipantIds.add(participant.id);
  }

  // Activity updates.
  for (const update of simulant.activityUpdates) {
    const participant = findParticipant(update.participantName, parts);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `activity update for "${update.participantName}" dropped`));
      continue;
    }
    participant.state.activity = update.activity;
    if (update.posture !== undefined) participant.state.posture = update.posture;
    touchedParticipantIds.add(participant.id);
  }

  // Off-screen schedule ticks: never teleport on-screen NPCs, and never
  // override an explicit simulant movement/activity from this turn. Ticks
  // into/out of the player's location stage arrival/departure lines for the
  // next brief (phase-2-plan T9) — co-located ⇒ perceived, interim rule.
  const arrivals: string[] = [];
  const departures: string[] = [];
  // Director-staged off-screen movement (phase-4 npc-movement minimal slice):
  // carried across turns, fired beats appended to pendingComms / the next brief.
  let stagedIntents = bundle.runtime.stagedIntents;
  const firedComms: PendingComms[] = [];
  const stagedDirectives: string[] = [];
  if (!reconcile) {
    const activeLoc = player?.locationId ?? activeLocationId({ participants: parts, locations: bundle.locations });
    const locationNameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
    const gameTime = resolveGameTime(clockMinutes, bundle.style.calendarStart);
    const minute = minuteOfDay(gameTime);

    // Staged-intent tick — runs BEFORE the schedule tick so a committed NPC is
    // not yanked back to its routine. The director only decides (proposes the
    // goal); this advances the NPC one hop and fires the on-arrival beat. New
    // intents the director just authored are appended AFTER the advance, so
    // their first hop is next turn (they have to set out).
    const stagedThisTick = new Set<string>();
    const cancelIds = new Set(results.director?.stageMovement?.cancel ?? []);
    const surviving = stagedIntents.filter((s) => !cancelIds.has(s.id));
    const itemById = new Map(items.map((i) => [i.id, i] as const));
    const doorStateForLink = (link: SceneLinkInput): DoorState | null =>
      link.doorItemId ? (itemById.get(link.doorItemId)?.state ?? null) : null;
    const tick = applyStagedIntents({
      intents: surviving,
      locationByParticipant: new Map(parts.map((p) => [p.id, p.locationId] as const)),
      knownParticipantIds: new Set(parts.map((p) => p.id)),
      links: bundle.links,
      doorStateForLink,
      minuteOfDay: minute,
      turnNumber: turn.number,
      sink,
    });
    for (const move of tick.moves) {
      const p = parts.find((x) => x.id === move.participantId);
      if (!p) continue;
      const staged = scheduleMoveStaging({
        displayName: p.displayName,
        fromLocationId: move.fromLocationId,
        toLocationId: move.toLocationId,
        activeLocationId: activeLoc,
        locationNameById,
      });
      if (staged.arrival) arrivals.push(staged.arrival);
      if (staged.departure) departures.push(staged.departure);
      p.locationId = move.toLocationId;
      // In-transit hop: a "heading toward X" activity keeps the Cast tab honest
      // (no stale clinic activity at a node that isn't the clinic). On the hop
      // that arrives, leave activity to the fired beat / narrator.
      if (!move.reachedDestination) {
        const dest = locationNameById.get(move.destinationLocationId);
        p.state.activity = dest ? `heading toward ${dest}` : "on the move";
      }
      stagedThisTick.add(p.id);
      touchedParticipantIds.add(p.id);
    }
    for (const f of tick.fired) {
      stagedThisTick.add(f.participantId);
      if (f.comms) {
        const pc = parseOrNull(
          pendingCommsSchema,
          { fromParticipantId: f.participantId, kind: f.comms.kind, gist: f.comms.gist, urgency: f.comms.urgency },
          sink,
          "merge.movement.pending_comms",
        );
        if (pc) firedComms.push(pc);
      }
      if (f.directive?.trim()) stagedDirectives.push(f.directive.trim());
    }

    // Open new staged intents from the director's story decision (names → ids).
    const newIntents: StagedIntent[] = [];
    for (const stage of results.director?.stageMovement?.stage ?? []) {
      const npc = findParticipant(stage.npcName, parts);
      const dest = resolveSessionLocation(stage.destinationName, bundle.locations);
      if (!npc || npc.isUser || !dest) {
        sink.push(
          diag("warn", "merge.movement.intent_unresolved", `staged movement "${stage.npcName}" → "${stage.destinationName}" dropped`, {
            context: { npcResolved: !!npc, destResolved: !!dest },
          }),
        );
        continue;
      }
      const dup = [...tick.intents, ...newIntents].some(
        (s) => s.participantId === npc.id && s.destinationLocationId === dest.id,
      );
      if (dup) continue;
      const threadId = stage.threadTitle
        ? bundle.runtime.storyThreads.find((t) => t.title.trim().toLowerCase() === stage.threadTitle?.trim().toLowerCase())?.id
        : undefined;
      const parsed = parseOrNull(
        stagedIntentSchema,
        {
          id: newId(),
          participantId: npc.id,
          destinationLocationId: dest.id,
          reason: stage.reason,
          threadId,
          onArrival: { comms: stage.onArrivalComms, directive: stage.onArrivalDirective },
          status: "active",
          openedAtTurn: turn.number,
          expiresInTurns: STAGED_INTENT_DEFAULT_BUDGET,
        },
        sink,
        "merge.movement.intent",
      );
      if (parsed) newIntents.push(parsed);
    }
    stagedIntents = [...tick.intents, ...newIntents];

    for (const participant of parts) {
      if (participant.isUser) continue;
      if (stagedThisTick.has(participant.id)) continue;
      if (participant.locationId !== null && participant.locationId === activeLoc) continue;
      if (touchedParticipantIds.has(participant.id) && simulantTouchedPlacement(participant, simulant, parts)) continue;
      // Per-character daily jitter: shifting the compared minute by -j makes
      // this character's windows start j minutes late (or early) today.
      const jitter = scheduleJitter(participant.id, gameTime.dayIndex);
      const jitteredMinute = (((minute - jitter) % 1440) + 1440) % 1440;
      const entry = scheduleEntryAt(participant.snapshot.schedule, jitteredMinute, gameTime.weekdayIndex);
      if (!entry) continue;
      const target = resolveSessionLocation(entry.locationName, bundle.locations);
      if (!target) {
        sink.push(
          diag("info", "merge.schedule.unknown_location", `schedule location "${entry.locationName}" not found`, {
            context: { participantName: participant.displayName },
          }),
        );
        continue;
      }
      if (participant.locationId !== target.id) {
        const staged = scheduleMoveStaging({
          displayName: participant.displayName,
          fromLocationId: participant.locationId,
          toLocationId: target.id,
          activeLocationId: activeLoc,
          locationNameById,
        });
        if (staged.arrival) arrivals.push(staged.arrival);
        if (staged.departure) departures.push(staged.departure);
        participant.locationId = target.id;
      }
      participant.state.activity = entry.activity;
      touchedParticipantIds.add(participant.id);
    }
  }

  // -- Step 5/6 planning: facts, episode, threads ------------------------------
  const archivist: ArchivistResult | null = results.archivist;
  const locByName = (name: string) => resolveSessionLocation(name, bundle.locations);
  const factDrafts: FactDraftInput[] = (archivist?.facts ?? []).map((draft) => {
    let subjectId: string | null = null;
    if (draft.subjectKind === "character" || draft.subjectKind === "player") {
      subjectId = findParticipant(draft.subjectName, parts)?.id ?? null;
    } else if (draft.subjectKind === "location") {
      subjectId = locByName(draft.subjectName)?.id ?? null;
    } else if (draft.subjectKind === "item") {
      subjectId = resolveItemByName(draft.subjectName, "alter", items, null)?.id ?? null;
    }
    return { ...draft, subjectId };
  });

  const syntheticEpisode = !archivist || !archivist.episodeSummary.trim();
  const episodeSummary = syntheticEpisode ? syntheticEpisodeSummary(turn.narration) : archivist.episodeSummary.trim();
  if (syntheticEpisode) {
    sink.push(diag("warn", "merge.episode.synthetic", "archivist failed — synthetic episode written from the narration"));
  }

  let threads = bundle.runtime.storyThreads;
  let touchedThreadIds: string[] = [];
  if (!reconcile) {
    const raw = results.director?.threadSignals ?? { touch: [], develop: [], propose: [], resolve: [] };
    // Conservative semantic dedup folds near-duplicate proposals into develops
    // before the pure reducer runs (degrades to exact-title dedup if no embedder).
    const signals = input.deps?.embedThreadTexts
      ? await dedupeThreadProposals(threads, raw, input.deps.embedThreadTexts, turn.number, sink)
      : raw;
    const applied = applyThreadSignals(threads, signals, turn.number, sink);
    threads = coolThreads(applied.threads, turn.number);
    touchedThreadIds = applied.touchedIds;
  }

  // Lore unlocks from this turn's fact tags (exact lowercase tag match).
  const factTags = factDrafts.flatMap((d) => d.tags);
  const newlyUnlocked = computeUnlocks(factTags, bundle.loreChunks, {
    alreadyUnlockedIds: bundle.runtime.unlockedLoreIds,
    sessionId: input.logMissesForSessionId,
  });

  const witnessLoc = player?.locationId ?? activeLocationId({ participants: parts, locations: bundle.locations });
  const coLocatedNpcs = parts.filter((p) => !p.isUser && p.locationId !== null && p.locationId === witnessLoc);

  // Targeted interactions (decision: co-presence alone never counts):
  // intent-detected targets, the speaking NPC on companion turns, and
  // co-located NPCs addressed by name in the player's input. Computed here so
  // both the witness perception read (engagedWithActor) and the
  // lastInteractedTurn follow-score recency can reuse it.
  const interacted = new Set<string>();
  if (!reconcile) {
    if (turn.author === "player") {
      const intent = detectIntent(turn.input, coLocatedNpcs.map((p) => p.displayName), []);
      for (const name of [intent.lookTarget, intent.touchTarget, intent.smellTarget, intent.tasteTarget]) {
        if (!name) continue;
        const target = findParticipant(name, parts);
        if (target && !target.isUser) interacted.add(target.id);
      }
      for (const npc of coLocatedNpcs) {
        if (mentionsParticipant(turn.input, npc)) interacted.add(npc.id);
      }
    }
    if (turn.author === "companion" && turn.speakerParticipantId) interacted.add(turn.speakerParticipantId);
  }

  // Witness set (presence-and-perception-spec §witness sets): the placed player
  // plus every co-located NPC who perceived a salient action this turn. Falls
  // back to interim co-location semantics when there is no placed player to
  // anchor the turn's salience on. One set per turn, stamped on every draft.
  const witnessedBy = computeWitnessSet({
    player,
    coLocatedNpcs,
    witnessLoc,
    parts,
    simulant,
    turn,
    interacted,
    witnessLight: witnessLoc ? bundle.locations.find((l) => l.id === witnessLoc)?.ambient?.light : undefined,
    // Turn-START clock for darkness, matching the pre-turn awareness blocks.
    band: daylightBand(resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart)),
    sink,
  });
  for (const draft of factDrafts) draft.witnessedBy = witnessedBy;

  // Runtime: visited locations + encountered participants follow the camera.
  const finalActiveLoc = player?.locationId ?? activeLocationId({ participants: parts, locations: bundle.locations });
  const visited = new Set(bundle.runtime.visitedLocationIds);
  if (finalActiveLoc) visited.add(finalActiveLoc);
  const encountered = new Set(bundle.runtime.encounteredParticipantIds);
  for (const p of parts) {
    if (!p.isUser && p.locationId !== null && p.locationId === finalActiveLoc) encountered.add(p.id);
  }

  const lastInteractedTurn = { ...bundle.runtime.lastInteractedTurn };
  for (const id of interacted) lastInteractedTurn[id] = turn.number;

  // Comms links (presence-spec §comms): persist opens/closes to runtime, log
  // per-turn changes. Post_turn only — reconcile leaves the link state alone
  // (consistent with affinity/schedule gating).
  const comms = reconcile
    ? { links: bundle.runtime.commsLinks, changes: [] as CommsChange[] }
    : planCommsEvents(simulant.commsEvents, bundle.runtime.commsLinks, clockMinutes, parts, sink);

  // Affinity decay (defaults doc §Affinity stages): time-driven, so it only
  // runs when the clock advances — reconcile leaves edges and marker alone.
  const affinityDecay = reconcile
    ? null
    : planAffinityDecay(
        {
          relationships: bundle.relationships,
          clockMinutes,
          lastAffinityDecayAt: bundle.runtime.lastAffinityDecayAt,
          traitsByParticipant: new Map(parts.map((p) => [p.id, p.snapshot.traits])),
        },
        sink,
      );

  const runtime: SessionRuntime = {
    ...bundle.runtime,
    storyThreads: threads,
    visitedLocationIds: [...visited],
    encounteredParticipantIds: [...encountered],
    unlockedLoreIds: [...new Set([...bundle.runtime.unlockedLoreIds, ...newlyUnlocked])],
    lastInteractedTurn,
    commsLinks: comms.links,
    // Surface-once: pending messages were rendered in this turn's pre-turn
    // context already, so they clear here; only beats fired THIS merge ride to
    // the next turn (reconcile leaves the queue untouched). Capped as a guard.
    pendingComms: reconcile ? bundle.runtime.pendingComms : firedComms.slice(-PENDING_COMMS_CAP),
    stagedIntents,
    ...(affinityDecay ? { lastAffinityDecayAt: affinityDecay.lastAffinityDecayAt } : {}),
  };

  // -- Step 7: next-turn brief --------------------------------------------------
  const thresholdHints: string[] = [];
  for (const participant of parts) {
    if (participant.isUser) continue;
    const before = hintsBefore.get(participant.id) ?? [];
    const after = crossedThresholdHints(participant.state.meters, defs);
    for (const hint of after) {
      if (!before.includes(hint)) thresholdHints.push(`${participant.displayName}: ${hint}`);
    }
  }

  const brief = reconcile
    ? reconcileBrief(bundle.brief, droppedEvents, thresholdHints)
    : buildNextBrief({
        prior: bundle.brief,
        director: results.director,
        continuity,
        episodeSummary,
        droppedEvents,
        thresholdHints,
        arrivals,
        departures,
        stagedDirectives,
      });

  return {
    minutes,
    minutesCause,
    clockMinutes,
    affinityUpdates: reactionResult
      ? combineAffinityUpdates(reactionResult, planAffinityUpdates(simulant.affinityAdjustments, parts, sink))
      : [],
    affinityDecay: affinityDecay?.edges ?? [],
    witnessedBy,
    commsChanges: comms.changes,
    participants: parts,
    items,
    touchedItemIds: [...touchedItemIds],
    factDrafts,
    episodeSummary,
    syntheticEpisode,
    touchedThreadIds,
    runtime,
    brief,
    droppedEvents,
  };
}

/** Did the simulant explicitly move or re-task this participant this turn? */
function simulantTouchedPlacement(
  participant: WorkingParticipant,
  simulant: SimulantResult,
  parts: readonly WorkingParticipant[],
): boolean {
  const moved = simulant.movements.some((m) => findParticipant(m.participantName, parts)?.id === participant.id);
  const reTasked = simulant.activityUpdates.some((u) => findParticipant(u.participantName, parts)?.id === participant.id);
  return moved || reTasked;
}

/**
 * Compute this turn's witness set (presence-and-perception-spec §witness sets).
 * Gathers the saliences the player's salient actions carried, then asks
 * `perceives` per co-located NPC whether any of them got through their
 * attention/conditions/darkness. Result = the placed player + every NPC who
 * perceived. Degrades to interim co-location semantics when no placed player
 * anchors the turn (a companion/director turn with no embodied player). Pushes
 * `merge.perception.darkness_miss` (info) for ambiguous ambient light; never throws.
 */
function computeWitnessSet(input: {
  player: WorkingParticipant | null;
  coLocatedNpcs: readonly WorkingParticipant[];
  witnessLoc: string | null;
  parts: readonly WorkingParticipant[];
  simulant: SimulantResult;
  turn: MergeTurn;
  interacted: ReadonlySet<string>;
  witnessLight: string | undefined;
  band: DaylightBand;
  sink: DiagnosticSink;
}): string[] {
  const { player, coLocatedNpcs, witnessLoc, parts, simulant, turn, interacted, witnessLight, band, sink } = input;

  // No placed player to anchor the turn's salience on: fall back to the interim
  // co-location stamp (everyone at the witness location perceives).
  if (!player || player.locationId === null) {
    return parts.filter((p) => p.locationId !== null && p.locationId === witnessLoc).map((p) => p.id);
  }

  // Saliences explicitly tagged on the player's own item/activity events.
  const explicit: Salience[] = [];
  for (const e of simulant.itemEvents) {
    if (!e.salience) continue;
    const actor = e.byName ? findParticipant(e.byName, parts) : player;
    if (actor?.id === player.id) explicit.push(e.salience);
  }
  for (const u of simulant.activityUpdates) {
    if (!u.salience) continue;
    if (findParticipant(u.participantName, parts)?.id === player.id) explicit.push(u.salience);
  }

  // Concealment target: a co-located NPC NOT named/targeted in the input — so a
  // stealth marker actually has someone to hide from (intimate "quietly" to the
  // only person present is tone, not a sneak).
  const hasConcealmentTarget = coLocatedNpcs.some(
    (npc) => !interacted.has(npc.id) && !mentionsParticipant(turn.input, npc),
  );
  const salienceSet = turnSalienceSet({ inputText: turn.input, explicit, hasConcealmentTarget });

  const darkness = darknessVerdict(band, witnessLight);
  if (darkness.miss) {
    sink.push(
      diag("info", "merge.perception.darkness_miss", `ambient light "${witnessLight ?? ""}" matched no keyword — defaulting dark`, {
        context: { locationId: witnessLoc, light: witnessLight ?? null },
      }),
    );
  }

  const witnessIds: string[] = [player.id];
  for (const npc of coLocatedNpcs) {
    const attention = deriveAttention({ activity: npc.state.activity, posture: npc.state.posture });
    const engagedWithActor =
      attention.state === "engaged_with" &&
      (interacted.has(npc.id) || mentionsActorFirstName(npc.state.activity, player));
    const observer = { attention: attention.state, facesAway: attention.facesAway, engagedWithActor };
    const mods = { dark: darkness.dark, ...senseModsFromConditions(npc.state.conditions) };
    if (salienceSet.some((s) => perceives(observer, s, mods))) witnessIds.push(npc.id);
  }
  return witnessIds;
}

/** Does the NPC's activity text mention the player's first name (whole-word, ci)? */
function mentionsActorFirstName(activity: string, player: WorkingParticipant): boolean {
  const first = (player.displayName.split(/\s+/)[0] ?? player.displayName).trim().toLowerCase();
  if (!first) return false;
  const re = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(activity.toLowerCase());
}

// ---------------------------------------------------------------------------
// Application (one transaction for all world-state writes)
// ---------------------------------------------------------------------------

export interface ApplyTurnInput {
  bundle: SessionBundle;
  turn: MergeTurn;
  results: AgentResults;
  /** Per-agent provider attribution from the fan-out; concatenated onto the
   * narrator leg the pipeline seeded (jsonb `||`). Empty/absent in demo mode. */
  providers?: TurnProviders;
  sink: DiagnosticSink;
  mode?: MergeMode;
  deps?: GroundingDeps;
}

export async function applyTurnResults(input: ApplyTurnInput): Promise<MergePlan> {
  const { bundle, turn, results } = input;
  const mode: MergeMode = input.mode ?? "post_turn";
  const ownerId = bundle.world.ownerId;

  // Tee diagnostics: the caller keeps its sink, and everything recorded during
  // this merge is also persisted onto the turn row.
  const recorded: Diagnostic[] = [];
  const sink: DiagnosticSink = {
    push(d) {
      recorded.push(d);
      input.sink.push(d);
    },
  };

  const deps: GroundingDeps = input.deps ?? {
    resolveLibraryItem: (name) => fuzzyResolve("item", ownerId, name, { sink }),
    resolveLibraryLocation: (name) => fuzzyResolve("location", ownerId, name, { sink }),
    embedThreadTexts: async (texts) => (await embedTexts(texts)).map((e) => e.vector),
  };

  const plan = await planTurnEffects({
    bundle,
    turn,
    results,
    sink,
    mode,
    deps,
    logMissesForSessionId: bundle.session.id,
  });

  // Facts and the episode are written through the memory module (each
  // internally transactional; embeddings degrade per docs/memory.md). The
  // world-state merge below is the single atomic transaction.
  await addFacts(bundle.session.id, plan.factDrafts, turn.id, sink);
  if (mode === "reconcile") {
    await deleteEpisodeForTurn(bundle.session.id, turn.number);
  }
  await appendEpisode(bundle.session.id, turn.number, plan.episodeSummary, plan.touchedThreadIds, sink, plan.witnessedBy);

  const touchedItems = new Set(plan.touchedItemIds);
  const diagnosticsJson = JSON.stringify(recorded);
  // Concatenated onto the providers map (the pipeline already wrote `narrator`),
  // so the agent legs merge in without clobbering it.
  const providersJson = JSON.stringify(input.providers ?? {});

  await db().transaction(async (tx) => {
    for (const participant of plan.participants) {
      await tx
        .update(sessionParticipants)
        .set({ locationId: participant.locationId, state: participant.state })
        .where(eq(sessionParticipants.id, participant.id));
    }

    // Affinity decay first (1 pt per whole in-game week toward 0, stopped at
    // the stage's zero-side boundary), so this turn's adjustments land on
    // decayed values. A boundary stop logs an `affinity_decay_clamped` events
    // row — the "relationships fossilizing" tuning evidence. Stage is
    // recomputed but never changes from decay (boundary stop is within-stage).
    for (const edge of plan.affinityDecay) {
      if (edge.value !== edge.previousValue) {
        await tx
          .update(participantRelationships)
          .set({ value: edge.value, stage: stageForValue(edge.value).id })
          .where(
            and(
              eq(participantRelationships.sessionId, bundle.session.id),
              eq(participantRelationships.fromParticipantId, edge.fromParticipantId),
              eq(participantRelationships.toParticipantId, edge.toParticipantId),
              eq(participantRelationships.kind, edge.kind),
            ),
          );
      }
      if (edge.clamped) {
        await tx.insert(events).values({
          sessionId: bundle.session.id,
          type: "affinity_decay_clamped",
          payload: {
            fromParticipantId: edge.fromParticipantId,
            toParticipantId: edge.toParticipantId,
            kind: edge.kind,
            value: edge.value,
            previousValue: edge.previousValue,
            stage: stageForValue(edge.value).id,
            turnId: turn.id,
          },
        });
      }
    }

    // Affinity edges: read-modify-write per update (tiny volume), logging
    // stage transitions as events — the tuning evidence the spec requires.
    for (const update of plan.affinityUpdates) {
      const [existing] = await tx
        .select()
        .from(participantRelationships)
        .where(
          and(
            eq(participantRelationships.sessionId, bundle.session.id),
            eq(participantRelationships.fromParticipantId, update.fromParticipantId),
            eq(participantRelationships.toParticipantId, update.toParticipantId),
            eq(participantRelationships.kind, update.kind),
          ),
        )
        .limit(1);
      const previousValue = existing?.value ?? 0;
      const previousStage = existing?.stage ?? stageForValue(previousValue).id;
      const value = clampAffinity(previousValue + update.delta);
      const stage = stageForValue(value).id;
      if (existing) {
        await tx.update(participantRelationships).set({ value, stage }).where(eq(participantRelationships.id, existing.id));
      } else {
        await tx.insert(participantRelationships).values({
          sessionId: bundle.session.id,
          fromParticipantId: update.fromParticipantId,
          toParticipantId: update.toParticipantId,
          kind: update.kind,
          value,
          stage,
        });
      }
      if (stage !== previousStage) {
        await tx.insert(events).values({
          sessionId: bundle.session.id,
          type: "affinity_stage",
          payload: {
            fromParticipantId: update.fromParticipantId,
            toParticipantId: update.toParticipantId,
            kind: update.kind,
            from: previousStage,
            to: stage,
            value,
            reason: update.reason ?? null,
            turnId: turn.id,
          },
        });
      }
    }

    // Comms link opens/closes (presence-spec §comms): the link state itself is
    // already in plan.runtime.commsLinks; these rows are the per-turn audit log.
    for (const change of plan.commsChanges) {
      await tx.insert(events).values({
        sessionId: bundle.session.id,
        type: change.op === "open" ? "comms_link_opened" : "comms_link_closed",
        payload: { withParticipantId: change.withParticipantId, kind: change.kind, turnId: turn.id },
      });
    }

    for (const item of plan.items) {
      if (!touchedItems.has(item.id)) continue;
      await tx
        .update(itemInstances)
        .set({
          holderParticipantId: item.holderParticipantId,
          worn: item.worn,
          locationId: item.locationId,
          containerInstanceId: item.containerInstanceId,
          positionNote: item.positionNote,
          state: item.state,
        })
        .where(eq(itemInstances.id, item.id));
    }

    if (mode === "reconcile") {
      // Clock stays put, but the brief carries any reconcile-dropped events
      // and threshold crossings forward (see reconcileBrief).
      await tx.update(sessions).set({ runtime: plan.runtime, brief: plan.brief }).where(eq(sessions.id, bundle.session.id));
      await tx
        .update(turns)
        .set({
          agentResults: sql`${turns.agentResults} || ${JSON.stringify({ simulant: results.simulant, archivist: results.archivist })}::jsonb`,
          diagnostics: sql`${turns.diagnostics} || ${diagnosticsJson}::jsonb`,
          providers: sql`${turns.providers} || ${providersJson}::jsonb`,
          heartbeatAt: new Date(),
        })
        .where(eq(turns.id, turn.id));
    } else {
      await tx
        .update(sessions)
        .set({ clockMinutes: plan.clockMinutes, runtime: plan.runtime, brief: plan.brief })
        .where(eq(sessions.id, bundle.session.id));
      await tx
        .update(turns)
        .set({
          status: "ready",
          minutes: plan.minutes,
          agentResults: {
            simulant: results.simulant,
            archivist: results.archivist,
            continuity: results.continuity,
            director: results.director,
            clock: { minutes: plan.minutes, cause: plan.minutesCause },
          },
          diagnostics: sql`${turns.diagnostics} || ${diagnosticsJson}::jsonb`,
          providers: sql`${turns.providers} || ${providersJson}::jsonb`,
          heartbeatAt: new Date(),
        })
        .where(and(eq(turns.id, turn.id), eq(turns.status, "processing")));
    }
  });

  return plan;
}
