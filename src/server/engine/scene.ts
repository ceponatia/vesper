import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes } from "@/contracts/attributes/value";
import type { AttributeDefinition } from "@/contracts/attributes/types";
import { isConditionExpired } from "@/contracts/conditions/condition";
import type { ItemDefinition, ItemInstanceState } from "@/contracts/items/item";
import { resolveWardrobeVisibility, type WornItemInput } from "@/contracts/items/visibility";
import {
  crossedThresholdHints,
  meterDefinitions,
  type MeterDefinition,
} from "@/contracts/meters/registry";
import type { LinkAccess } from "@/contracts/world/access";
import type { NextTurnBrief } from "@/contracts/state/brief";
import type { ParticipantState } from "@/contracts/state/participant-state";
import type { SessionRuntime } from "@/contracts/state/session-runtime";
import type { CharacterProfile, WorldLore, WorldStyle } from "@/contracts/world/profile";
import type { SceneIntent } from "./intent";

/**
 * Pure scene/prompt-block builders (docs/turn-engine.md §Pre-turn 3d).
 * Callers parse DB rows into a SceneBundleInput (parseOr at the boundary);
 * everything here is deterministic string assembly over typed values.
 */

export type LocationScale = "intimate" | "room" | "hall" | "open" | "expanse";

export interface ScenePlaceInput {
  id: string;
  name: string;
  description: string;
  ambient: { scent?: string; sound?: string; light?: string };
  /** Physical size class (proximity-spec decision 18); absent ⇒ room. */
  scale?: LocationScale;
}

export interface SceneLinkInput {
  fromId: string;
  toId: string;
  label?: string | null;
  /** Game minutes to traverse; defaults to 1 (adjacent rooms). */
  travelMinutes?: number;
  /** Parsed link access (contracts/world/access); absent ⇒ public (today's behavior). */
  access?: LinkAccess;
  /** Bound door item instance id; closed+locked seals the link. */
  doorItemId?: string | null;
}

export interface SceneItemInput {
  id: string;
  name: string;
  /** Parsed item definition snapshot. */
  definition: ItemDefinition;
  holderParticipantId: string | null;
  worn: boolean;
  locationId: string | null;
  containerInstanceId: string | null;
  positionNote?: string | null;
  state: ItemInstanceState;
}

export interface SceneParticipantInput {
  id: string;
  displayName: string;
  isUser: boolean;
  role: "player" | "companion" | "npc";
  locationId: string | null;
  /** Parsed CharacterProfile snapshot. */
  snapshot: CharacterProfile;
  /** Parsed ParticipantState. */
  state: ParticipantState;
}

export interface SceneBundleInput {
  participants: SceneParticipantInput[];
  locations: ScenePlaceInput[];
  links: SceneLinkInput[];
  items: SceneItemInput[];
  style: WorldStyle;
  lore: WorldLore;
  runtime: SessionRuntime;
  brief: NextTurnBrief;
  clockMinutes: number;
}

function npcs(bundle: SceneBundleInput): SceneParticipantInput[] {
  return bundle.participants.filter((p) => !p.isUser);
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const end = trimmed.search(/[.!?](?:\s|$)/);
  return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
}

/** First sentences of a bio, capped (canonical-facts excerpting). */
export function excerptBio(bio: string, maxChars = 240, maxSentences = 3): string {
  const trimmed = bio.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const sentences = trimmed.match(/[^.!?]+[.!?]?/g) ?? [trimmed];
  let out = "";
  for (const sentence of sentences.slice(0, maxSentences)) {
    if (out && out.length + sentence.length > maxChars) break;
    out += sentence;
  }
  out = out.trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}

/** Apply WorldStyle.meterOverrides: null disables a meter, partials merge. */
export function effectiveMeterDefinitions(style: WorldStyle): MeterDefinition[] {
  const out: MeterDefinition[] = [];
  for (const def of meterDefinitions) {
    const override = style.meterOverrides[def.id];
    if (override === null) continue;
    out.push(override ? { ...def, ...override } : def);
  }
  return out;
}

function exitsFrom(bundle: SceneBundleInput, locationId: string): string[] {
  const nameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
  const exits: string[] = [];
  const seen = new Set<string>();
  for (const link of bundle.links) {
    let targetId: string | null = null;
    if (link.fromId === locationId) targetId = link.toId;
    else if (link.toId === locationId) targetId = link.fromId;
    if (!targetId || seen.has(targetId)) continue;
    const name = nameById.get(targetId);
    if (!name) continue;
    seen.add(targetId);
    exits.push(link.label ? `${name} (${link.label})` : name);
  }
  return exits;
}

function looseItemsAt(bundle: SceneBundleInput, locationId: string): SceneItemInput[] {
  return bundle.items.filter((i) => i.locationId === locationId && !i.containerInstanceId);
}

/**
 * One framing line per location scale (phase-2-plan T10, the prose half of
 * decision 18) — strictly physical size, never staging language: the
 * proximity phase's entry default for intimate/room is `apart`, so this line
 * must not assert how close anyone currently stands. `room` is the default
 * and renders nothing (an ordinary room needs no size remark); the proximity
 * phase extends this same line with tier mechanics.
 */
export function scaleFramingLine(scale: LocationScale | undefined): string {
  switch (scale) {
    case "intimate":
      return "Size: an intimate space; a few steps span it.";
    case "hall":
      return "Size: a large hall; crossing it takes many strides.";
    case "open":
      return "Size: an open area; the far side is a shout away.";
    case "expanse":
      return "Size: a vast expanse; reaching the far side takes real time.";
    case "room":
    case undefined:
      return "";
  }
}

/**
 * Scene reference block: full description + all items on a first visit (or a
 * forced re-establish, e.g. enter intent), one-line summary + current items on
 * revisits (docs/turn-engine.md §Scene snapshot).
 */
export function buildSceneSnapshot(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
  opts?: { forceFull?: boolean },
): string {
  const loc = bundle.locations.find((l) => l.id === activeLocationId);
  if (!loc) return "";

  const firstVisit = opts?.forceFull === true || !bundle.runtime.visitedLocationIds.includes(loc.id);
  const exits = exitsFrom(bundle, loc.id);
  const loose = looseItemsAt(bundle, loc.id);
  const containers = loose.filter((i) => i.definition.kind === "container");
  const plainItems = loose.filter((i) => i.definition.kind !== "container");

  const itemLine = plainItems.length
    ? `Items here: ${plainItems.map((i) => (i.positionNote ? `${i.name} (${i.positionNote})` : i.name)).join(", ")}`
    : "";
  const containerLines = containers.map((c) => {
    const open = c.state.open === true;
    if (!open) return `Container: ${c.name} (closed — contents not visible)`;
    const contents = bundle.items.filter((i) => i.containerInstanceId === c.id).map((i) => i.name);
    return `Container: ${c.name} (open${contents.length ? ` — containing: ${contents.join(", ")}` : " — empty"})`;
  });
  const exitLine = `Exits (adjacent only): ${exits.length ? exits.join(", ") : "none"}`;

  if (firstVisit) {
    const ambientParts = [
      loc.ambient.scent ? `scent — ${loc.ambient.scent}` : "",
      loc.ambient.sound ? `sound — ${loc.ambient.sound}` : "",
      loc.ambient.light ? `light — ${loc.ambient.light}` : "",
    ].filter(Boolean);
    return [
      `## Scene: ${loc.name} (first visit — establish the space; sole authority for fixed features)`,
      loc.description ? `Description: ${loc.description}` : "",
      scaleFramingLine(loc.scale),
      ambientParts.length ? `Ambient: ${ambientParts.join("; ")}` : "",
      itemLine,
      ...containerLines,
      exitLine,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `## Scene: ${loc.name} (familiar — do not re-describe the room; mention only what changed)`,
    firstSentence(loc.description),
    scaleFramingLine(loc.scale),
    itemLine,
    ...containerLines,
    exitLine,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * "Who is where" presence roster — the prompt-side slice of
 * presence-and-perception-spec.phase3.md pulled forward (interim co-location
 * semantics, same as witnessed_by; no channels/salience machinery). Groups
 * every session NPC against the active location: Present (co-located),
 * Nearby (adjacent via the undirected link graph), Elsewhere (everyone else,
 * with their location names). Empty groups render nothing; no NPCs at all
 * renders nothing. The static rulebook's "Presence fidelity" rules reference
 * this block by heading name.
 */
export function buildPresenceRoster(bundle: SceneBundleInput, activeLocationId: string | null): string {
  const groups = groupPresence(bundle, activeLocationId);
  if (!groups) return "";

  return [
    '## Who is where (authoritative presence roster this turn — see the "Presence fidelity" rules)',
    groups.present.length ? `Present: ${groups.present.join(", ")}` : "",
    groups.nearby.length
      ? `Nearby (one room away — may join this turn ONLY if narrated physically arriving before any dialogue): ${groups.nearby.join(", ")}`
      : "",
    groups.elsewhere.length ? `Elsewhere: ${groups.elsewhere.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Shared presence grouping for the roster and the turn digest. Null when there are no NPCs or the location is unknown. */
function groupPresence(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
): { present: string[]; nearby: string[]; elsewhere: string[] } | null {
  const cast = npcs(bundle);
  if (!cast.length) return null;
  const loc = bundle.locations.find((l) => l.id === activeLocationId);
  if (!loc) return null;

  const nameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
  // Links are undirected — match both orientations (merge.ts isAdjacent).
  const adjacentIds = new Set<string>();
  for (const link of bundle.links) {
    if (link.fromId === loc.id) adjacentIds.add(link.toId);
    else if (link.toId === loc.id) adjacentIds.add(link.fromId);
  }

  const present: string[] = [];
  const nearby: string[] = [];
  const elsewhere: string[] = [];
  for (const npc of cast) {
    if (npc.locationId === loc.id) {
      present.push(npc.displayName);
    } else if (npc.locationId && adjacentIds.has(npc.locationId)) {
      nearby.push(`${npc.displayName} (${nameById.get(npc.locationId) ?? "nearby"})`);
    } else {
      const where = npc.locationId ? (nameById.get(npc.locationId) ?? "location unknown") : "location unknown";
      elsewhere.push(`${npc.displayName} (${where})`);
    }
  }
  return { present, nearby, elsewhere };
}

/**
 * Compact imperative digest rendered at the very top of the turn context —
 * a pure restatement of the deterministic constraint blocks (roster, access),
 * because models follow a terse action list more reliably than they
 * cross-reference six authority blocks. Every line must be derivable from a
 * block below it; this builder never introduces new facts. Renders nothing
 * when there is nothing to constrain.
 */
export function buildTurnDigest(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
  blocked?: { targetName: string; reason: string } | null,
): string {
  const groups = groupPresence(bundle, activeLocationId);
  const lines: string[] = [];
  if (groups) {
    if (groups.present.length) lines.push(`- Voice freely: ${groups.present.join(", ")}.`);
    if (groups.nearby.length)
      lines.push(`- May bring in, but only via a narrated physical arrival before their first line: ${groups.nearby.join(", ")}.`);
    if (groups.elsewhere.length)
      lines.push(`- Never enact — discuss or quote from memory only: ${groups.elsewhere.join(", ")}.`);
  }
  if (blocked) {
    lines.push(
      `- The way to ${blocked.targetName} is not passable this turn (${blocked.reason}) — play the blocked threshold; never narrate the far side.`,
    );
  }
  if (!lines.length) return "";
  return ["## This turn (binding digest — each line restates an authoritative block below)", ...lines].join("\n");
}

/**
 * The sole authority on worn clothing: per NPC, visible items (outermost per
 * body location) plus items hinted through sheer layers. Hidden items are
 * omitted entirely — the narrator must not know about them.
 */
export function buildWardrobeBlock(bundle: SceneBundleInput, opts?: { includeSensory?: boolean }): string {
  const present = npcs(bundle);
  if (!present.length) return "";

  const lines = present.map((p) => {
    const worn = bundle.items.filter((i) => i.holderParticipantId === p.id && i.worn);
    if (!worn.length) return `- ${p.displayName}: nothing visibly worn`;

    const inputs: WornItemInput[] = worn.map((i) => ({
      instanceId: i.id,
      name: i.name,
      coverage: i.definition.coverage,
      layer: i.definition.layer ?? 1,
      opacity: i.definition.opacity,
    }));
    const views = resolveWardrobeVisibility(inputs);
    const byId = new Map(worn.map((i) => [i.id, i]));

    const describe = (instanceId: string, name: string): string => {
      if (!opts?.includeSensory) return name;
      const sensory = byId.get(instanceId)?.definition.sensory;
      const details = [sensory?.appearance, sensory?.scent].filter(Boolean).join("; ");
      return details ? `${name} (${details})` : name;
    };

    const visible = views.filter((v) => v.visibility === "visible").map((v) => describe(v.instanceId, v.name));
    const hinted = views.filter((v) => v.visibility === "hinted").map((v) => v.name);
    const parts = [
      visible.length ? visible.join(", ") : "nothing visible",
      hinted.length ? `hinted beneath sheer layers (vague hint only, never detail): ${hinted.join(", ")}` : "",
    ].filter(Boolean);
    return `- ${p.displayName}: ${parts.join("; ")}`;
  });

  return [
    "## Visible wardrobe (sole authority for what each character visibly wears this turn)",
    ...lines,
  ].join("\n");
}

/**
 * Identity-level truths the narrator must never contradict: display name,
 * apparent age (resolved attribute), and a 2–3 sentence bio excerpt.
 */
export function buildCanonicalFactsBlock(bundle: SceneBundleInput): string {
  const lines: string[] = [];
  for (const p of npcs(bundle)) {
    const effective = resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays);
    const age = effective.find((v) => v.id === "identity.apparent_age");
    const agePhrase = typeof age?.value === "string" ? ` — appears ${humanize(age.value)}` : "";
    const bio = excerptBio(p.snapshot.bio);
    const bioPhrase = bio ? ` Bio: ${bio}` : "";
    if (!agePhrase && !bioPhrase) continue;
    lines.push(`- ${p.displayName}${agePhrase}.${bioPhrase}`);
  }
  if (!lines.length) return "";
  return [
    "## Canonical character facts (authoritative truth — who characters ARE; never contradict these; do not recite them verbatim)",
    ...lines,
  ].join("\n");
}

function attributePhrase(def: AttributeDefinition, value: unknown): string | null {
  if (typeof value === "boolean") return value ? def.label.toLowerCase() : null;
  if (typeof value === "number") return `${def.label.toLowerCase()}: ${value}${def.unit ? ` ${def.unit}` : ""}`;
  if (Array.isArray(value)) return `${def.label.toLowerCase()}: ${value.map((v) => humanize(String(v))).join(", ")}`;
  if (typeof value === "string") return `${def.label.toLowerCase()}: ${humanize(value)}`;
  return null;
}

/**
 * Per-NPC appearance reference: a full attribute impression (plus registry
 * promptHints as phrasing guidance) on first encounter or when intent marks
 * the NPC as a look target; a one-liner otherwise.
 */
export function buildGlanceImpressions(bundle: SceneBundleInput, intent: SceneIntent): string {
  const present = npcs(bundle);
  if (!present.length) return "";

  const lines: string[] = [];
  const hints = new Set<string>();

  for (const p of present) {
    const firstEncounter = !bundle.runtime.encounteredParticipantIds.includes(p.id);
    const isLookTarget = intent.lookTarget?.toLowerCase() === p.displayName.toLowerCase();
    if (!firstEncounter && !isLookTarget) {
      lines.push(`- ${p.displayName} — present (appearance already established; mention only changes)`);
      continue;
    }

    const effective = resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays);
    const phrases: string[] = [];
    for (const value of effective) {
      const def = attributeRegistry.byId(value.id);
      if (!def) continue;
      const phrase = attributePhrase(def, value.value);
      if (!phrase) continue;
      phrases.push(phrase);
      for (const hint of def.promptHints ?? []) hints.add(hint);
    }
    const label = firstEncounter ? "first encounter — full impression" : "being looked at — full impression";
    lines.push(`- ${p.displayName} (${label}): ${phrases.length ? phrases.join("; ") : "no recorded appearance details"}`);
  }

  const block = [
    "## Character impressions (reference — weave into natural prose, never quote labels verbatim)",
    ...lines,
  ];
  if (hints.size) block.push(`Phrasing guidance: ${[...hints].join(" ")}`);
  return block.join("\n");
}

/**
 * What NPCs can plausibly do this turn: labeled exits, usable items in the
 * room, and what each NPC carries — gated by an explicit motivation rule.
 */
export function buildAffordancesBlock(bundle: SceneBundleInput, activeLocationId: string | null): string {
  const loc = bundle.locations.find((l) => l.id === activeLocationId);
  if (!loc) return "";

  const exits = exitsFrom(bundle, loc.id);
  const usable = looseItemsAt(bundle, loc.id).map((i) => i.name);
  const carriedLines = npcs(bundle)
    .map((p) => {
      const carried = bundle.items
        .filter((i) => i.holderParticipantId === p.id && !i.worn)
        .map((i) => i.name);
      return carried.length ? `Carried by ${p.displayName}: ${carried.join(", ")}` : "";
    })
    .filter(Boolean);

  const lines = [
    "## NPC affordances (reference — what NPCs can plausibly do this turn)",
    "Act only in service of a character's goals, schedule, or an open thread; small motivated actions (picking up, using, or carrying items; moving one adjacent room) are encouraged — demonstrative or unmotivated use is not.",
    `Exits from ${loc.name}: ${exits.length ? exits.join(", ") : "none"}`,
  ];
  if (usable.length) lines.push(`Usable items here: ${usable.join(", ")}`);
  lines.push(...carriedLines);
  return lines.join("\n");
}

/**
 * Current physical state per NPC: activity/posture, crossed meter-threshold
 * hints (world meter overrides applied), active condition hints, and any
 * short-lived mechanical notes.
 */
export function buildMeterConditionBlock(bundle: SceneBundleInput): string {
  const present = npcs(bundle);
  if (!present.length) return "";

  const defs = effectiveMeterDefinitions(bundle.style);
  const lines = present.map((p) => {
    const parts: string[] = [];
    parts.push(`activity: ${p.state.activity || "idle"}${p.state.posture ? ` (${p.state.posture})` : ""}`);

    const hints = crossedThresholdHints(p.state.meters, defs);
    if (hints.length) parts.push(hints.join(" "));

    const active = p.state.conditions.filter((c) => !isConditionExpired(c, bundle.clockMinutes));
    for (const condition of active) {
      const severity = condition.severity ? ` (${condition.severity})` : "";
      parts.push(`condition: ${condition.label}${severity}${condition.promptHint ? ` — ${condition.promptHint}` : ""}`);
    }

    if (p.state.notes.length) parts.push(p.state.notes.join(" "));
    return `- ${p.displayName} — ${parts.join(". ")}`;
  });

  return ["## Current state (authoritative over recent story beats)", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Follow guidance (docs/turn-engine.md §Follow scores)
// ---------------------------------------------------------------------------

export const FOLLOW_THRESHOLD = 0.55;

/** Follow-score term per relationship stage (replaces the fact-count proxy when an edge exists). */
const AFFINITY_STAGE_FOLLOW_TERMS: Record<string, number> = {
  hostile: -0.4,
  wary: -0.15,
  stranger: 0,
  acquaintance: 0.1,
  friendly: 0.18,
  close: 0.25,
  devoted: 0.3,
};

/** Stages below acquaintance never reach likely-follows on scene warmth alone. */
const GATED_STAGES = new Set(["hostile", "wary", "stranger"]);

export interface FollowNpcInput {
  displayName: string;
  /** Shares the room the player is leaving. */
  coLocated: boolean;
  activity: string;
}

export interface FollowGuidanceInput {
  playerInput: string;
  fromLocationName: string;
  toLocationName: string;
  npcs: FollowNpcInput[];
  /** Active `relationship`-kind facts in this session. */
  relationshipFacts: Array<{ subjectName: string; text: string }>;
  /** displayName → turns since the NPC last interacted with the player. */
  turnsSinceInteraction: Record<string, number>;
  /** displayName → stage id of the NPC's feeling toward the player. When present, replaces the fact-count warmth term and gates strangers (cast-tiers-and-affinity-spec). */
  affinityStages?: Record<string, string>;
}

export interface FollowCandidate {
  displayName: string;
  score: number;
  likelyFollows: boolean;
  reasons: string[];
}

const STICKY_ACTIVITY_RE = /\b(sleep|work|cook|bath|shower|repair|clean|writ|read|study|eat)/;
const IDLE_ACTIVITIES = new Set(["", "idle", "standing", "waiting"]);
const WANTS_ALONE_RE = /\b(alone|without you|leave me|stay here|stay put|don't follow|do not follow)\b/;

/** Whole-word, case-insensitive mention of a display name or its first name. */
function mentionsName(text: string, displayName: string): boolean {
  const candidates = [displayName];
  const first = displayName.trim().split(/\s+/)[0];
  // Short first names ("Al", "Bo") skip the first-name match — too many false hits.
  if (first && first.length >= 3 && first !== displayName) candidates.push(first);
  return candidates.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
  });
}

/**
 * Deterministic follow likelihood for each co-located NPC when the player
 * moves: relationship warmth + interaction recency + activity stickiness +
 * whether the input addressed them. Guidance for the narrator, not a hard rule.
 */
export function computeFollowScores(input: FollowGuidanceInput): FollowCandidate[] {
  const candidates: FollowCandidate[] = [];
  const wantsAlone = WANTS_ALONE_RE.test(input.playerInput.toLowerCase());

  for (const npc of input.npcs) {
    if (!npc.coLocated) continue;
    const reasons: string[] = ["co-located with the player"];
    let score = 0.25;

    if (mentionsName(input.playerInput, npc.displayName)) {
      score += 0.25;
      reasons.push("addressed in the player's input");
    }

    const stage = input.affinityStages?.[npc.displayName];
    if (stage !== undefined) {
      const term = AFFINITY_STAGE_FOLLOW_TERMS[stage] ?? 0;
      score += term;
      if (term !== 0) reasons.push(`relationship stage: ${stage}`);
    } else {
      // No affinity edge known — fall back to the fact-count warmth proxy.
      const warmth = input.relationshipFacts.filter(
        (f) => mentionsName(f.subjectName, npc.displayName) || mentionsName(f.text, npc.displayName),
      ).length;
      if (warmth >= 3) {
        score += 0.25;
        reasons.push(`relationship warmth (${warmth} facts)`);
      } else if (warmth >= 1) {
        score += 0.15;
        reasons.push(`relationship warmth (${warmth} fact${warmth === 1 ? "" : "s"})`);
      }
    }

    const turnsAgo = input.turnsSinceInteraction[npc.displayName];
    if (turnsAgo === 0 || turnsAgo === 1) {
      score += 0.25;
      reasons.push("interacted last turn");
    } else if (turnsAgo === 2) {
      score += 0.15;
      reasons.push("interacted 2 turns ago");
    } else if (turnsAgo === 3) {
      score += 0.08;
      reasons.push("interacted 3 turns ago");
    }

    const activity = npc.activity.toLowerCase().trim();
    if (STICKY_ACTIVITY_RE.test(activity)) {
      score -= 0.25;
      reasons.push(`busy: ${npc.activity}`);
    } else if (!IDLE_ACTIVITIES.has(activity)) {
      score -= 0.1;
      reasons.push(`engaged: ${npc.activity}`);
    }

    if (wantsAlone) {
      score -= 0.5;
      reasons.push("player implied wanting to be alone");
    }

    // Affinity gate (decision: strangers don't follow on chattiness alone):
    // below acquaintance, cap under the threshold regardless of this scene.
    if (stage !== undefined && GATED_STAGES.has(stage) && score >= FOLLOW_THRESHOLD) {
      score = FOLLOW_THRESHOLD - 0.05;
      reasons.push(`affinity gate: a ${stage} does not follow without a concrete reason`);
    }

    score = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
    candidates.push({
      displayName: npc.displayName,
      score,
      likelyFollows: score >= FOLLOW_THRESHOLD,
      reasons,
    });
  }

  return candidates;
}

export interface RelationshipBlockInput {
  playerId: string;
  playerName: string;
  presentNpcs: Array<{ id: string; displayName: string }>;
  relationships: Array<{
    fromParticipantId: string;
    toParticipantId: string;
    kind: "feeling" | "perceived";
    stage: string;
  }>;
}

/**
 * Relationship stages for present NPCs (cast-tiers-and-affinity-spec):
 * stages, never numbers, go in prompts. Each NPC line carries their feeling
 * toward the player and their *perceived* affinity from the player
 * (decision 41 — "Mara thinks Brian likes her"). Sparse: no edge ⇒ stranger,
 * and all-stranger NPCs render nothing.
 */
export function buildRelationshipBlock(input: RelationshipBlockInput): string {
  const lines: string[] = [];
  for (const npc of input.presentNpcs) {
    const feeling = input.relationships.find(
      (r) => r.kind === "feeling" && r.fromParticipantId === npc.id && r.toParticipantId === input.playerId,
    );
    const perceived = input.relationships.find(
      (r) => r.kind === "perceived" && r.fromParticipantId === npc.id && r.toParticipantId === input.playerId,
    );
    if (!feeling && !perceived) continue;
    const parts: string[] = [];
    if (feeling) parts.push(`${feeling.stage} toward ${input.playerName}`);
    if (perceived) parts.push(`believes ${input.playerName} is ${perceived.stage}-warm toward her/him`);
    lines.push(`- ${npc.displayName}: ${parts.join("; ")}`);
  }
  if (lines.length === 0) return "";
  return [
    "## Relationships (present characters)",
    ...lines,
    "Play these stages in tone and initiative; relationships move through events, not narration fiat.",
  ].join("\n");
}

export interface AbsenceNoticeInput {
  playerInput: string;
  playerName: string;
  /** Session NPCs NOT at the player's location, with where they actually are. */
  absentNpcs: Array<{ displayName: string; locationName: string | null }>;
}

/**
 * The player's input names characters who are not in the room — the narrator
 * must not stage them, and a direct address earns a light, in-voice aside
 * ("Talking to yourself again?") instead of a phantom conversation. Quoted
 * speech is deliberately NOT stripped here: addressing someone happens inside
 * quotes.
 */
export function buildAbsenceNotice(input: AbsenceNoticeInput): string {
  const mentioned = input.absentNpcs.filter((npc) => mentionsName(input.playerInput, npc.displayName));
  if (mentioned.length === 0) return "";
  const example = mentioned[0]?.displayName ?? "They";
  return [
    "## Absent characters (the player's input names characters who are NOT here)",
    ...mentioned.map(
      (npc) => `- ${npc.displayName} is not present${npc.locationName ? ` (currently at ${npc.locationName})` : ""}.`,
    ),
    "Rules:",
    '- Do not voice them or stage them in place. They may enter the scene only per the "Presence fidelity" rules: listed Nearby in the "Who is where" block and narrated physically arriving before any dialogue — otherwise they stay off stage this turn.',
    `- If the player is speaking to or interacting with them, open with a brief, lightly teasing narrator aside acknowledging the absence (e.g. "${example} isn't here." or "Talking to yourself again, ${input.playerName}?"), then continue with who actually is present.`,
    "- If they are only mentioned in passing (talked about, remembered), no aside is needed — just keep them off stage.",
  ].join("\n");
}

export function buildFollowGuidance(input: FollowGuidanceInput): string {
  const candidates = computeFollowScores(input);
  const header = `## Movement guidance (player moving: ${input.fromLocationName} → ${input.toLocationName})`;
  const body = candidates.length
    ? candidates.map(
        (c) =>
          `- ${c.displayName} — follow likelihood ${c.score.toFixed(2)} (${c.likelyFollows ? "likely follows" : "likely stays"}): ${c.reasons.join("; ")}`,
      )
    : ["No co-located NPCs to follow."];

  return [
    header,
    ...body,
    "Movement narration rules:",
    "- NPCs marked likely follows should accompany the player to continue the interaction unless staying behind is dramatically stronger (argument, refusal, task-bound).",
    "- NPCs marked likely stays may remain behind; mention the separation naturally if relevant.",
    "- Never teleport NPCs who were not co-located with the player.",
  ].join("\n");
}
