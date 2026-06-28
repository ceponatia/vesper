import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes } from "@/contracts/attributes/value";
import type { AttributeDefinition } from "@/contracts/attributes/types";
import { isConditionExpired } from "@/contracts/conditions/condition";
import type { ItemDefinition, ItemInstanceState } from "@/contracts/items/item";
import { resolveWardrobeVisibility, type WornItemInput } from "@/contracts/items/visibility";
import {
  crossedThresholdHints,
  deriveMoodDescriptor,
  meterDefinitions,
  type MeterDefinition,
} from "@/contracts/meters/registry";
import {
  concealedSalience,
  darknessVerdict,
  defaultSalience,
  deriveAttention,
  describeAttention,
  hasStealthMarker,
  isPresent,
  perceives,
  senseModsFromConditions,
  type DerivedAttention,
  type PresenceChannel,
  type Salience,
} from "@/contracts/perception";
import { daylightBand, type GameTime } from "@/lib/clock";
import type { LinkAccess } from "@/contracts/world/access";
import { defaultExposureMask, type ExposureMask, type NextTurnBrief } from "@/contracts/state/brief";
import { INTIMATE_ATTRIBUTE_CATEGORIES } from "@/contracts/body/locations";
import { realizeBody, speciesLorePhrase } from "@/contracts/species";
import type { ParticipantState } from "@/contracts/state/participant-state";
import type { SessionRuntime } from "@/contracts/state/session-runtime";
import { formatAge } from "@/contracts/world/profile";
import type { CharacterProfile, WorldLore, WorldStyle } from "@/contracts/world/profile";
import type { SocialReactionCard } from "@/contracts/personality/cards";
import { interactionConceptById } from "@/contracts/personality/interactions";
import type { Preference } from "@/contracts/personality/preference";
import { checkPuppetContradiction } from "@/contracts/personality/puppet";
import { socialTraitScale } from "@/contracts/personality/modulation";
import {
  evaluateSocialReaction,
  type EvaluatedReaction,
  moodMeterToFactor,
  resolveSocialReaction,
  type SocialReaction,
} from "@/contracts/personality/reactions";
import { bandForValue, INTIMATE_TRAIT_CATEGORY, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits, type TraitValue } from "@/contracts/personality/traits/value";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { IntentBrief, NarrationFocus } from "@/contracts/turns/intent-brief";
import { MAX_NPC_PAIR_AWARENESS_LINES } from "./constants";
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
export function buildPresenceRoster(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
  channels?: Map<string, PresenceChannel>,
): string {
  const groups = groupPresence(bundle, activeLocationId);

  // Comms-present characters (an active link or a comms intent staged this turn)
  // are present-for-the-narrator regardless of where their body is — they may
  // be voiced over the phone — so they get their own "On call/text" line even
  // when they are not co-located. They are surfaced HERE and pulled out of the
  // Nearby/Elsewhere groups (listing the same NPC twice contradicts itself —
  // "present by voice" supersedes their physical whereabouts for the narrator).
  const commsLines: string[] = [];
  const commsNames = new Set<string>();
  if (channels) {
    const locById = new Map(bundle.locations.map((l) => [l.id, l.name]));
    const presentSet = new Set(groups?.present ?? []);
    for (const npc of npcs(bundle)) {
      if (channels.get(npc.id) !== "comms" || presentSet.has(npc.displayName)) continue;
      commsNames.add(npc.displayName);
      const link = bundle.runtime.commsLinks.find((c) => c.withParticipantId === npc.id);
      const kind = link?.kind ?? "call";
      // Carry where they physically are so the narrator can't have them claim a
      // contradicted location over the line (Presence fidelity rules 5-6).
      const where = npc.locationId ? locById.get(npc.locationId) : null;
      commsLines.push(`${npc.displayName} (${kind === "text" ? "by text" : "on a call"}${where ? `, at ${where}` : ""})`);
    }
  }

  // A grouped entry is "Name (Location)" — strip the suffix to test membership.
  const isComms = (entry: string) => commsNames.has(entry.replace(/\s*\([^)]*\)\s*$/, ""));
  const nearby = (groups?.nearby ?? []).filter((e) => !isComms(e));
  const elsewhere = (groups?.elsewhere ?? []).filter((e) => !isComms(e));

  if (!groups && commsLines.length === 0) return "";

  return [
    '## Who is where (authoritative presence roster this turn — see the "Presence fidelity" rules)',
    groups?.present.length ? `Present: ${groups.present.join(", ")}` : "",
    commsLines.length
      ? `On call/text (present by voice only — may speak, but is NOT physically here; no actions, no appearance, no being touched; their words must fit where they actually are): ${commsLines.join(", ")}`
      : "",
    nearby.length
      ? `Nearby (one room away — may join this turn ONLY if narrated physically arriving before any dialogue): ${nearby.join(", ")}`
      : "",
    elsewhere.length ? `Elsewhere: ${elsewhere.join(", ")}` : "",
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

// ---------------------------------------------------------------------------
// Presence channels (presence-and-perception-spec.phase3.md §presence channels)
// ---------------------------------------------------------------------------

/** participantId → which channel a comms intent / staged link opens this turn. */
export interface CommsStaging {
  participantId: string;
  kind: "call" | "text";
}

/**
 * Classify every session NPC by presence channel for the active location
 * (T2 channel computation). v1 has no per-pair tracking, so co-location ⇒
 * `sight` (simple rule, decision 11 interim): even at open/expanse scale a
 * co-located NPC is sight-present — possibly distant (see `distantExists`), but
 * still on the visual channel. `comms` is an active `runtime.commsLinks` entry
 * OR a comms intent staged THIS turn; `absent` is everyone else (Nearby and
 * Elsewhere stay absent for channel purposes — they enter only via the Presence
 * fidelity rules). Returns a map keyed by participant id; the player is never
 * included.
 */
export function classifyPresenceChannels(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
  staged?: readonly CommsStaging[],
): Map<string, PresenceChannel> {
  const channels = new Map<string, PresenceChannel>();
  const loc = bundle.locations.find((l) => l.id === activeLocationId);
  const linkedIds = new Set(bundle.runtime.commsLinks.map((c) => c.withParticipantId));
  const stagedIds = new Set((staged ?? []).map((s) => s.participantId));

  for (const npc of npcs(bundle)) {
    if (loc && npc.locationId === loc.id) {
      channels.set(npc.id, "sight");
    } else if (linkedIds.has(npc.id) || stagedIds.has(npc.id)) {
      channels.set(npc.id, "comms");
    } else {
      channels.set(npc.id, "absent");
    }
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Awareness blocks (presence-and-perception-spec.phase3.md §Attention × salience)
// ---------------------------------------------------------------------------

/**
 * The player's action salience THIS turn — the prediction half of the witness
 * rule. Default is obvious/quiet (`defaultSalience`); a stealth marker only
 * conceals when there is a present NPC who is NOT the intent target to hide
 * from (a concealment target). This MUST mirror the merge's witness-set logic
 * so the awareness blocks predict exactly what the merge will apply (one rule,
 * prompt and memory never disagree). `presentNpcNames` is the sight-present
 * cast; `intent` supplies the addressed target (look/touch/smell) excluded as
 * the audience the action is FOR.
 */
export function deriveActionSalience(
  input: string,
  intent: SceneIntent,
  presentNpcNames: readonly string[],
): Salience {
  if (!hasStealthMarker(input)) return defaultSalience();
  const target = (intent.touchTarget ?? intent.tasteTarget ?? intent.lookTarget ?? intent.smellTarget ?? "").toLowerCase();
  const hasConcealmentTarget = presentNpcNames.some((name) => name.toLowerCase() !== target);
  return hasConcealmentTarget ? concealedSalience() : defaultSalience();
}

/**
 * Tight, deterministic phrasing for what an attention state will/won't catch —
 * the perception verdict only (the attention descriptor is rendered as the line
 * prefix via describeAttention, so this never restates it).
 */
function awarenessVerdictLine(attention: DerivedAttention): string {
  switch (attention.state) {
    case "asleep_or_impaired":
      return "will NOT notice anything but a loud disturbance.";
    case "engaged_with":
      return "will NOT notice subtle or quiet actions elsewhere; WILL react to anything loud or plainly visible.";
    case "absorbed":
      return attention.facesAway
        ? "will NOT see anything, even plain movement; WILL react only to loud sound."
        : "will NOT notice subtle or quiet actions; WILL react to anything loud or plainly visible.";
    case "idle_alert":
      return "WILL notice plainly visible actions and any sound, loud or quiet.";
  }
}

interface AwarenessNpc {
  id: string;
  displayName: string;
  attention: DerivedAttention;
  mods: { sight: "normal" | "reduced" | "blocked"; hearing: "normal" | "reduced" | "blocked" };
}

/**
 * Per-NPC + pairwise awareness lines (T2 centerpiece). For each SIGHT-present
 * NPC: derive attention from activity/posture, fold in darkness + per-NPC
 * condition sense mods, and state what they will/won't notice of the player's
 * action THIS turn (via `perceives`, so the prediction matches the merge).
 * Then up to MAX_NPC_PAIR_AWARENESS_LINES pairwise NPC↔NPC blindspot lines for
 * non-obvious cases (an absorbed/back-turned or asleep NPC who would miss a
 * subtle action by another) — obvious cases (two alert NPCs) generate nothing.
 * Renders nothing when there is no SIGHT-present NPC.
 */
export function buildAwarenessBlocks(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
  intent: SceneIntent,
  gameTime: GameTime,
  playerInput = "",
): string {
  const loc = bundle.locations.find((l) => l.id === activeLocationId);
  const channels = classifyPresenceChannels(bundle, activeLocationId);
  const sightNpcs = npcs(bundle).filter((p) => channels.get(p.id) === "sight");
  if (!loc || sightNpcs.length === 0) return "";

  const dark = darknessVerdict(daylightBand(gameTime), loc.ambient.light).dark;
  const observers: AwarenessNpc[] = sightNpcs.map((p) => {
    const active = p.state.conditions.filter((c) => !isConditionExpired(c, bundle.clockMinutes));
    const senseMods = senseModsFromConditions(active);
    return {
      id: p.id,
      displayName: p.displayName,
      attention: deriveAttention({ activity: p.state.activity, posture: p.state.posture }),
      mods: { sight: senseMods.sight ?? "normal", hearing: senseMods.hearing ?? "normal" },
    };
  });

  // The player's action salience this turn, used per-NPC to decide perception.
  const salience = deriveActionSalience(playerInput, intent, sightNpcs.map((p) => p.displayName));

  const npcLines = observers.map((o) => {
    const willPerceive = perceives(
      { attention: o.attention.state, facesAway: o.attention.facesAway },
      salience,
      { dark, sight: o.mods.sight, hearing: o.mods.hearing },
    );
    const descriptor = describeAttention(o.attention);
    const sightNote = o.mods.sight === "blocked" ? " (sight blocked)" : o.mods.sight === "reduced" ? " (sight reduced)" : "";
    const verdict = o.mods.sight === "blocked" || o.mods.hearing === "blocked"
      ? `${o.displayName} — ${descriptor}${sightNote}: ${awarenessVerdictLine(o.attention)}`
      : `${o.displayName} — ${descriptor}: ${awarenessVerdictLine(o.attention)}`;
    const stealthNote =
      salience.visual === "subtle" && !willPerceive
        ? " The player's concealed action this turn goes UNNOTICED by them."
        : "";
    return `- ${verdict}${stealthNote}`;
  });

  // Pairwise blindspots: an actor NPC doing a subtle/quiet thing that an
  // observer NPC would miss. Only non-obvious cases earn a line — an observer
  // who is asleep, absorbed, or facing away (and not proximity-overridden).
  const pairLines: string[] = [];
  const subtleAct: Salience = concealedSalience();
  outer: for (const actor of observers) {
    for (const observer of observers) {
      if (actor.id === observer.id) continue;
      if (pairLines.length >= MAX_NPC_PAIR_AWARENESS_LINES) break outer;
      const blind = !perceives(
        { attention: observer.attention.state, facesAway: observer.attention.facesAway },
        subtleAct,
        { dark, sight: observer.mods.sight, hearing: observer.mods.hearing },
      );
      // Skip obvious cases: only flag an observer whose attention genuinely
      // blinds them (asleep / absorbed / facing away / sense-impaired), not a
      // merely idle_alert one (who would catch a loud or visible act anyway).
      const nonObvious =
        observer.attention.state === "asleep_or_impaired" ||
        observer.attention.state === "absorbed" ||
        observer.attention.facesAway ||
        observer.mods.sight !== "normal" ||
        observer.mods.hearing !== "normal";
      if (blind && nonObvious) {
        pairLines.push(
          `- ${observer.displayName} (${describeAttention(observer.attention)}) would NOT notice a subtle, quiet move by ${actor.displayName}.`,
        );
      }
    }
  }

  return [
    "## Awareness (who can perceive what this turn — characters react ONLY to what they perceive)",
    ...npcLines,
    ...(pairLines.length ? ["Between characters:", ...pairLines] : []),
  ].join("\n");
}

/**
 * Darkness sensory line for the turn context (T2 darkness). When the active
 * location is dark right now — night daylight band AND no lit-leaning
 * `ambient.light` (`darknessVerdict`) — the narrator is told sight is
 * unreliable and to lean on other senses. Renders "" when the scene is lit.
 * Uses the turn-start clock (gameTime). Also reports the verdict's `miss` flag
 * so the caller can log `pipeline.perception.darkness_miss`.
 */
export function buildDarknessLine(
  bundle: SceneBundleInput,
  activeLocationId: string | null,
  gameTime: GameTime,
): { line: string; miss: boolean } {
  const loc = bundle.locations.find((l) => l.id === activeLocationId);
  if (!loc) return { line: "", miss: false };
  const verdict = darknessVerdict(daylightBand(gameTime), loc.ambient.light);
  if (!verdict.dark) return { line: "", miss: false };
  return {
    line: "It is dark here — only obvious, close movement is visible; rely on sound and touch.",
    miss: verdict.miss,
  };
}

/**
 * "Messages & calls" turn-context block (T2 comms): active `runtime.commsLinks`
 * (ids resolved → names), any comms link staged THIS turn (a fresh call/text
 * the player just placed), and any NPC-initiated `runtime.pendingComms` gists
 * ("Your phone buzzes: a text from Mara — …"). Renders nothing when there is
 * no active, staged, or pending comms. Staged entries already present in
 * `commsLinks` are not duplicated.
 */
export function buildCommsLine(bundle: SceneBundleInput, staged?: readonly CommsStaging[]): string {
  const nameById = new Map(npcs(bundle).map((p) => [p.id, p.displayName]));
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const link of bundle.runtime.commsLinks) {
    const name = nameById.get(link.withParticipantId);
    if (!name) continue;
    seen.add(link.withParticipantId);
    lines.push(`On a ${link.kind} with ${name} — voice only; they are not physically here.`);
  }
  for (const s of staged ?? []) {
    if (seen.has(s.participantId)) continue;
    const name = nameById.get(s.participantId);
    if (!name) continue;
    seen.add(s.participantId);
    lines.push(
      s.kind === "text"
        ? `The player is texting ${name} — voice them by text only; they are not physically here.`
        : `The player is calling ${name} — voice them over the phone only; they are not physically here.`,
    );
  }
  for (const pending of bundle.runtime.pendingComms) {
    const name = nameById.get(pending.fromParticipantId);
    if (!name) continue;
    const verb = pending.kind === "call" ? "a call from" : "a text from";
    const gist = pending.gist.trim();
    lines.push(`Your phone buzzes: ${verb} ${name}${gist ? ` — ${gist}` : ""}.`);
  }

  if (!lines.length) return "";
  return ["## Messages & calls", ...lines].join("\n");
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
    if (groups.present.length) {
      // Restate the tag FORMAT here, not just who may speak: the static rulebook's
      // tagging rule is prefix-cached and far from generation, so a run of untagged
      // narrator-only turns in the short history window (solo stretches, texting)
      // can drown it out and the model keeps a returning NPC's dialogue inline as
      // prose. This volatile reminder rides after that history and re-anchors it.
      const example = groups.present[0] ?? "Name";
      lines.push(`- Voice freely — start each spoken line at line start as [Name] "…", e.g. [${example}] "…": ${groups.present.join(", ")}.`);
    }
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
 * Identity-level truths the narrator must never contradict: display name, real
 * `age` (the profile's free-text basic-info field — NOT the visual
 * `identity.apparent_age` attribute, which is portrait-studio-only), and a 2–3
 * sentence bio excerpt.
 */
export function buildCanonicalFactsBlock(bundle: SceneBundleInput): string {
  const lines: string[] = [];
  for (const p of npcs(bundle)) {
    const age = formatAge(p.snapshot.age);
    const agePhrase = age ? ` — ${age}` : "";
    // Species is an identity truth ("who they ARE"); surface it (label + any
    // authored cultural lore) for non-human casts so the narrator knows the
    // character is an elf / succubus. Generic visual looks go to the image
    // models, not here — the narrator gets physical detail from per-character
    // attributes (buildGlanceImpressions). "" for human (the unmarked default).
    const species = speciesLorePhrase(p.snapshot.speciesId, p.snapshot.heritageId);
    const speciesPhrase = species ? ` Species: ${species}.` : "";
    const bio = excerptBio(p.snapshot.bio);
    const bioPhrase = bio ? ` Bio: ${bio}` : "";
    if (!agePhrase && !speciesPhrase && !bioPhrase) continue;
    lines.push(`- ${p.displayName}${agePhrase}.${speciesPhrase}${bioPhrase}`);
  }
  if (!lines.length) return "";
  return [
    "## Canonical character facts (authoritative truth — who characters ARE; never contradict these; do not recite them verbatim)",
    ...lines,
  ].join("\n");
}

/**
 * Render a character's trait bands as behavioural guidance (resolved overlays →
 * band label + hint). `intimateOnly` partitions the registry: the cached
 * disposition block takes the non-intimate traits; the volatile, exposure-gated
 * line takes the intimate ones. Unknown/over-range ids are skipped (the registry
 * clamps), so a stale value never breaks the block.
 */
function dispositionParts(traits: readonly TraitValue[], intimateOnly: boolean, withHint = true): string[] {
  const parts: string[] = [];
  for (const value of resolveTraits(traits, [])) {
    const def = traitRegistry.byId(value.id);
    if (!def) continue;
    if ((def.category === INTIMATE_TRAIT_CATEGORY) !== intimateOnly) continue;
    const band = bandForValue(def, value.value);
    if (!band) continue;
    parts.push(`${def.label}: ${band.label}${withHint && band.promptHint ? ` (${band.promptHint})` : ""}`);
  }
  return parts;
}

/**
 * Terse non-intimate trait bands ("Warmth: cold") for an agent state slice — the
 * simulant reads these so its raw deltas land in-character (spec §7 Agents). No
 * hints (token-tight) and no intimate traits (those stay exposure-gated).
 */
export function dispositionBandSummary(traits: readonly TraitValue[]): string[] {
  return dispositionParts(traits, false, false);
}

/**
 * Cached disposition block (docs/developer-notes/personality-and-state.spec.md §7;
 * closes character-schema audit C1 — "personality never reaches a prompt"). Renders
 * each cast member's **non-intimate** trait bands as stable behavioural guidance in
 * the static-rulebook region (prefix-cache-stable: core traits don't change mid-
 * session). Intimate traits surface separately, exposure-gated
 * (`buildIntimateDispositionLine`). Empty when no one has authored traits ⇒ the
 * prefix is byte-for-byte today's.
 */
export function buildDispositionBlock(bundle: SceneBundleInput): string {
  const lines: string[] = [];
  for (const p of npcs(bundle)) {
    const parts = dispositionParts(p.snapshot.traits, false);
    if (parts.length) lines.push(`- ${p.displayName} — ${parts.join("; ")}`);
  }
  if (!lines.length) return "";
  return [
    "## Disposition (stable temperament — play it consistently in tone and initiative; never recite verbatim)",
    ...lines,
  ].join("\n");
}

/**
 * Volatile, exposure-gated intimate disposition (spec §7.3): surfaces a present
 * character's intimate trait bands (libido/inhibition/possessiveness) only when the
 * turn's exposure reaches the **intimate** appearance tier — the same gate intimate
 * attributes ride (`intimateAttrAllowed`). Never cached. Empty below the gate or
 * when no present character has intimate traits.
 */
export function buildIntimateDispositionLine(
  present: ReadonlyArray<{ displayName: string; traits: readonly TraitValue[] }>,
  exposure: ExposureMask,
): string {
  if (exposure.appearance !== "intimate") return "";
  const lines: string[] = [];
  for (const npc of present) {
    const parts = dispositionParts(npc.traits, true);
    if (parts.length) lines.push(`- ${npc.displayName} — ${parts.join("; ")}`);
  }
  if (!lines.length) return "";
  return ["## Intimate disposition (this scene only — exposure-earned)", ...lines].join("\n");
}

/**
 * Whether an intimate-anatomy attribute may surface this turn, gated by the
 * exposure mask (body-model spec Decision 3/§B). Non-intimate attributes are
 * always allowed (unchanged behavior). Intimate descriptive detail needs the
 * intimate visual tier; per-region scent/taste needs the matching sense earned.
 */
function intimateAttrAllowed(def: AttributeDefinition, exposure: ExposureMask): boolean {
  if (!(INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category)) return true;
  if (def.kind === "sensory") {
    if (def.id.endsWith(".scent")) return exposure.scent === "close" || exposure.scent === "intimate";
    if (def.id.endsWith(".taste")) return exposure.taste === "close" || exposure.taste === "intimate";
  }
  return exposure.appearance === "intimate";
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
 * the NPC as a look target; a one-liner otherwise. Channel-aware (T2 first-
 * impression fidelity): a SIGHT-present first encounter gets the full physical
 * impression; a COMMS-present first encounter gets a VOICE-ONLY impression
 * (voice-category attributes only — pitch, timbre, accent, cadence; never
 * physical appearance), labeled "(first contact by voice — voice impression)".
 * When `channels` is omitted every NPC is treated as sight (legacy behavior).
 */
export function buildGlanceImpressions(
  bundle: SceneBundleInput,
  intent: SceneIntent,
  channels?: Map<string, PresenceChannel>,
  exposure: ExposureMask = defaultExposureMask(),
): string {
  const cast = npcs(bundle);
  if (!cast.length) return "";

  const lines: string[] = [];
  const hints = new Set<string>();

  for (const p of cast) {
    const channel = channels?.get(p.id) ?? "sight";
    if (!isPresent(channel)) continue; // absent NPCs get no impression line

    const firstEncounter = !bundle.runtime.encounteredParticipantIds.includes(p.id);
    const isLookTarget = intent.lookTarget?.toLowerCase() === p.displayName.toLowerCase();

    // Comms-present: never a physical impression. First voice contact earns a
    // voice-only impression; afterward, a one-liner noting they're on the line.
    if (channel === "comms") {
      if (!firstEncounter) {
        lines.push(`- ${p.displayName} — on the line (voice already familiar; no physical presence)`);
        continue;
      }
      const effective = resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays);
      const phrases: string[] = [];
      for (const value of effective) {
        const def = attributeRegistry.byId(value.id);
        if (!def || def.category !== "voice") continue;
        const phrase = attributePhrase(def, value.value);
        if (!phrase) continue;
        phrases.push(phrase);
        for (const hint of def.promptHints ?? []) hints.add(hint);
      }
      lines.push(
        `- ${p.displayName} (first contact by voice — voice impression): ${phrases.length ? phrases.join("; ") : "no recorded voice details"}`,
      );
      continue;
    }

    // Sight-present: full physical impression on first encounter / look target.
    if (!firstEncounter && !isLookTarget) {
      lines.push(`- ${p.displayName} — present (appearance already established; mention only changes)`);
      continue;
    }

    const effective = resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays);
    const realizedBody = realizeBody({
      speciesId: p.snapshot.speciesId,
      heritageId: p.snapshot.heritageId,
      bodyPlanId: p.snapshot.bodyPlanId,
      intimateRegions: p.snapshot.intimateRegions,
      bodyFeatures: p.snapshot.bodyFeatures,
    });
    const phrases: string[] = [];
    for (const value of effective) {
      if (value.id === "identity.apparent_age") continue; // visual age is portrait-studio-only; the narrator gets real `age` in canonical facts
      const def = attributeRegistry.byId(value.id);
      if (!def) continue;
      if (!realizedBody.isAttributeApplicable(def)) continue;
      if (!intimateAttrAllowed(def, exposure)) continue; // intimate detail only when the exposure mask earns it
      const phrase = attributePhrase(def, value.value);
      if (!phrase) continue;
      phrases.push(phrase);
      for (const hint of def.promptHints ?? []) hints.add(hint);
    }
    const label = firstEncounter ? "first encounter — full impression" : "being looked at — full impression";
    lines.push(`- ${p.displayName} (${label}): ${phrases.length ? phrases.join("; ") : "no recorded appearance details"}`);
  }

  if (!lines.length) return "";
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
    const mood = deriveMoodDescriptor(p.state.meters);
    if (mood) parts.push(`mood: ${mood}`);
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
  cool: -0.05,
  stranger: 0,
  acquaintance: 0.1,
  friendly: 0.18,
  warm: 0.22,
  close: 0.25,
  cherished: 0.28,
  devoted: 0.3,
  smitten: 0.32,
};

/** Stages below acquaintance never reach likely-follows on scene warmth alone. */
const GATED_STAGES = new Set(["hostile", "wary", "cool", "stranger"]);

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

export interface ReactionLineInput {
  playerId: string;
  playerName: string;
  /** intake's classified social acts (intent-brief.socialActs); v1 plays the primary (first). */
  socialActs: ReadonlyArray<{ concept: string; target: string }>;
  presentNpcs: ReadonlyArray<{
    id: string;
    displayName: string;
    tags: readonly string[];
    preferences: readonly Preference[];
    traits: readonly TraitValue[];
    /** The NPC's own default cards — tried before the world's (the personal line wins). */
    socialCards: readonly SocialReactionCard[];
    /** Turn-start mood meter (0–1); drives the curve's μ so the hint matches the applied delta. */
    mood: number;
  }>;
  /** Numeric affinity edges (BundleRelationship); the curve reads the NPC's feeling toward the player. */
  relationships: ReadonlyArray<{ fromParticipantId: string; toParticipantId: string; kind: "feeling" | "perceived"; value: number }>;
  /** The world's social fabric cards (bundle.style.socialCards), tried after the NPC's own. */
  worldCards: readonly SocialReactionCard[];
}

/**
 * The matched, evaluated PRIMARY social act — the shared verdict behind both the
 * `## Reaction` line (`buildReactionLine`) and the response-shape reaction-scale
 * line (`buildResponseShape`). Evaluating it once and feeding both is what
 * guarantees the two restate a single identical verdict and can never disagree
 * (narrator-prompt-focus.plan.md §Phase 2).
 */
export interface PrimaryReaction {
  npc: ReactionLineInput["presentNpcs"][number];
  reaction: SocialReaction;
  evaluated: EvaluatedReaction;
}

/**
 * Resolve + evaluate the player's primary social act against its target NPC's
 * bespoke disposition, affinity, and mood — the same resolve/curve pair the merge
 * applies, so the hint and the applied affinity delta can't disagree. Null when
 * there is no act, no present target by that name, or no disposition match — i.e.
 * exactly the cases where `buildReactionLine` renders nothing.
 */
export function evaluatePrimaryReaction(input: ReactionLineInput): PrimaryReaction | null {
  const primary = input.socialActs[0];
  if (!primary) return null;
  const npc = input.presentNpcs.find((n) => n.displayName.toLowerCase() === primary.target.toLowerCase());
  if (!npc) return null;
  const reaction = resolveSocialReaction(
    { concept: primary.concept, target: primary.target },
    { tags: npc.tags, preferences: npc.preferences, cards: [...npc.socialCards, ...input.worldCards] },
  );
  if (!reaction) return null;
  const feeling = input.relationships.find(
    (r) => r.kind === "feeling" && r.fromParticipantId === npc.id && r.toParticipantId === input.playerId,
  );
  const evaluated = evaluateSocialReaction(reaction, feeling?.value ?? 0, moodMeterToFactor(npc.mood), socialTraitScale(reaction, npc.traits));
  return { npc, reaction, evaluated };
}

/**
 * Authored-disposition reaction line (docs/developer-notes/personality-and-state.spec.md
 * §6). Renders the verdict for the narrator — so the model is *told* how the
 * character takes it (over the affinity-aware curve) instead of improvising it.
 * Takes the shared `evaluatePrimaryReaction` result (defaulted so single-arg
 * callers/tests compute it inline); the pipeline passes the value it also feeds
 * `buildResponseShape`. Empty when no act, no present target, or no match.
 */
export function buildReactionLine(
  input: ReactionLineInput,
  primary: PrimaryReaction | null = evaluatePrimaryReaction(input),
): string {
  if (!primary) return "";
  const { npc, reaction, evaluated } = primary;
  const concept = interactionConceptById(reaction.conceptId);
  const verb = concept?.verb ?? "made a social overture to";
  const label = (concept?.label ?? reaction.conceptId).toLowerCase();
  const valenceWord = reaction.valence === "dislike" ? "dislikes" : "likes";
  const hint = evaluated.hint ? ` ${evaluated.hint}.` : "";
  return [
    "## Reaction (authored disposition — play this; do not re-decide whether they mind)",
    `- ${input.playerName} ${verb} ${npc.displayName} — ${npc.displayName} ${valenceWord} this (${label}) and ${evaluated.band}.${hint}`,
  ].join("\n");
}

// A reaction at or above this evaluated magnitude already has a full "## Reaction"
// line (band "is pleased" / "is delighted" / "is clearly displeased" / "is stung",
// per reactions.ts `bandFor`'s magnitude<4/≥4 split above its <2 "mildly" band) — so
// the response-shape scale line DEFERS to it to avoid double-stating; below it the
// scale line reinforces a light, proportionate reaction.
const STRONG_REACTION_MAGNITUDE = 2;

// actionTypes whose turn has an in-place "respond first, stay on the beat" shape.
// `move` is owned by the movement rules + turn digest, `meta` by the OOC heading,
// and `other` is the degraded/unclassified default — none get a (possibly wrong)
// current-beat line; reaction-scale and speaker-focus still apply to them. Used only
// on the Phase-2 derivation path (no planner `focus`).
const RESPOND_IN_PLACE_ACTIONS: ReadonlySet<IntentBrief["actionType"]> = new Set([
  "converse",
  "comms",
  "observe",
  "social_attempt",
  "intimate",
  "touch",
  "manipulate_item",
  "rest",
]);

// Phase-3 narration-focus (intent-brief.focus) → prose steers. null ⇒ no line for
// that case (ooc_answer has no in-scene beat; concise_exchange is the default form).
const PRIMARY_RESPONSE_BEAT: Record<NarrationFocus["primaryResponse"], string | null> = {
  converse: "respond to the player's input",
  answer_question: "answer the player's question directly",
  resolve_action: "resolve the action the player took and show its outcome",
  react_emotionally: "react to the emotional beat the player landed",
  transition_scene: "carry the scene transition the player set in motion",
  ooc_answer: null,
};

const ALLOWED_NEW_TOPIC: Record<NarrationFocus["allowedNewTopic"], string> = {
  none: "don't introduce an unrelated new topic this turn",
  one_open_thread: "you may pick up one open thread only if it follows naturally",
  urgent_scene_event: "a new topic is warranted — an urgent scene event is in play",
};

const FOCUS_REACTION_SCALE: Record<NarrationFocus["reactionScale"], string> = {
  none: "ordinary — no special emotional reaction is owed; do not escalate affection, gratitude, or fluster.",
  small: "small — a light, in-character reaction; do not escalate to affection or doting.",
  moderate: "moderate — a genuine but measured reaction is warranted.",
  strong: "strong — a real emotional reaction is warranted this turn.",
};

const SUGGESTED_SHAPE_LINE: Record<NarrationFocus["suggestedShape"], string | null> = {
  concise_exchange: null,
  scene_establishing: "an establishing beat — fuller scene-setting is warranted.",
  multi_party: "a multi-character beat — several present characters are involved.",
  action_resolution: "action resolution — show the action's outcome concretely.",
};

export interface ResponseShapeInput {
  /** intake's coarse action classification (intent-brief.actionType). */
  actionType: IntentBrief["actionType"];
  /** NPC display names the player addressed this turn (intent-brief.addressedNpcs). */
  addressedNpcs: readonly string[];
  /** Present NPC display names (the "Who is where" Present set) — for addressed ∩ present. */
  presentNpcNames: readonly string[];
  /** Shared primary-reaction verdict (evaluatePrimaryReaction) — null ⇒ no act/target/match. */
  primaryReaction: PrimaryReaction | null;
  /** Open story threads surfaced this turn — gates whether a new topic is licensed (Phase-2 path). */
  openThreadCount: number;
  /** Direction lines this turn — also license a new topic (Phase-2 path). */
  directiveCount: number;
  /**
   * Phase-3 narration-focus planner (intent-brief.focus). When present, it supplies
   * the richer current-beat / new-topic / shape / reaction-scale signals; when absent
   * (regex fallback / any degrade), the builder falls back to the Phase-2 derivation.
   */
  focus?: NarrationFocus;
}

/**
 * The "## Response shape" steer block (narrator-prompt-focus.plan.md §Phase 2/3) — a
 * volatile, restatement-only sibling of `buildTurnDigest`: stay on the player's beat,
 * shape the turn, react in proportion, and don't voice a chorus. It invents nothing
 * (every line restates data already in the turn) and renders "" when nothing is
 * constrained, like `buildTurnDigest`.
 *
 * Two signal tiers: the §Phase-3 `focus` planner (the intake agent's read) supplies
 * the finer beat/topic/shape/reaction steers when present; absent it, the builder
 * derives the same lines deterministically from `actionType` / open-thread + Direction
 * counts (§Phase 2). The **authored reaction band always wins** over the planner's
 * `reactionScale` — it's authoritative and the "## Reaction" line plays it.
 */
export function buildResponseShape(input: ResponseShapeInput): string {
  const { focus } = input;
  const lines: string[] = [];

  // Current beat — respond first; a new topic is licensed only as stated. The planner
  // gives a finer verb + topic license; absent it, derive from actionType + whether a
  // Direction / open thread is present (Phase-2 path).
  if (focus) {
    const beat = PRIMARY_RESPONSE_BEAT[focus.primaryResponse];
    if (beat) lines.push(`- Current beat: ${beat} and keep the turn's focus there; ${ALLOWED_NEW_TOPIC[focus.allowedNewTopic]}.`);
  } else if (RESPOND_IN_PLACE_ACTIONS.has(input.actionType)) {
    const beat = input.actionType === "observe" ? "answer what the player is examining" : "respond to the player's input";
    const newTopic =
      input.directiveCount > 0 || input.openThreadCount > 0
        ? "open a new topic only if a Direction or open thread calls for it"
        : "don't introduce an unrelated new topic this turn";
    lines.push(`- Current beat: ${beat} and keep the turn's focus there; ${newTopic}.`);
  }

  // Shape — Phase-3 only; the per-turn analogue of the global shape profile. Emitted
  // only for the expansion shapes (concise_exchange is the default, so it says nothing).
  if (focus) {
    const shape = SUGGESTED_SHAPE_LINE[focus.suggestedShape];
    if (shape) lines.push(`- Shape: ${shape}`);
  }

  // Reaction scale — the authored band ALWAYS wins (authoritative; the "## Reaction"
  // line plays it): a strong band says nothing here (defer to it), a weak band → "small".
  // With no band, use the planner's read; with neither, "ordinary" (the no-signal default).
  if (input.primaryReaction) {
    if (input.primaryReaction.evaluated.magnitude < STRONG_REACTION_MAGNITUDE) {
      lines.push('- Reaction scale: small — keep the reaction light and proportionate; play the "## Reaction" line, do not amplify it.');
    }
  } else {
    lines.push(`- Reaction scale: ${FOCUS_REACTION_SCALE[focus?.reactionScale ?? "none"]}`);
  }

  // Speaker focus — only addressed-and-present characters owe an answer; others stay
  // silent unless directly affected (the multi-party restraint made concrete). Names
  // are framework-derived from typed participants, never echoed player prose.
  const present = new Set(input.presentNpcNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const addressedPresent: string[] = [];
  for (const name of input.addressedNpcs) {
    const key = name.toLowerCase();
    if (present.has(key) && !seen.has(key)) {
      seen.add(key);
      addressedPresent.push(name);
    }
  }
  if (addressedPresent.length) {
    const verb = addressedPresent.length === 1 ? "needs" : "need";
    lines.push(
      `- Speaker focus: only ${addressedPresent.join(" and ")} ${verb} to answer; another present character speaks only if directly affected or acting on their own goal.`,
    );
  }

  if (!lines.length) return "";
  return ["## Response shape (this turn — derived, not new facts)", ...lines].join("\n");
}

export interface PuppetDeflectionInput {
  /** intake's classified player-authored NPC behaviours (intent-brief.narratedNpcBehaviors). */
  narratedNpcBehaviors: ReadonlyArray<{ npc: string; concept?: string; summary?: string }>;
  presentNpcs: ReadonlyArray<{
    displayName: string;
    tags: readonly string[];
    preferences: readonly Preference[];
    traits?: readonly TraitValue[];
  }>;
  /** A behaviour naming a non-present character is logged here (the absence notice voices it). */
  sink?: DiagnosticSink;
}

/**
 * Disposition guardrail — refusing out-of-character puppeting
 * (docs/developer-notes/personality-and-state.spec.md §6, Note 2). When the
 * player's prose authors a present character's dialogue/affection/action that
 * **contradicts** that character's disposition, emit a volatile directive telling
 * the narrator not to honour it and to answer with a brief in-voice meta aside.
 * Consistent (in-disposition) puppeting passes silently — a v1 leniency. Empty when
 * nothing is puppeted or every puppeted act is consistent.
 *
 * v1 ships this deflection directive ONLY: the merge does not separately strip
 * puppet-implied state, because the narrator's refusal means the puppeted act never
 * reaches the post-turn agents (the simulant scores the narration, which won't
 * contain it). The broader puppet-handling system — merge-level stripping, routing
 * NPC authorship out of the player prompt — is deferred
 * (docs/developer-notes/npc-puppeting.deferred.md).
 */
export function buildPuppetDeflection(input: PuppetDeflectionInput): string {
  const lines: string[] = [];
  for (const behavior of input.narratedNpcBehaviors) {
    const npc = input.presentNpcs.find((n) => n.displayName.toLowerCase() === behavior.npc.toLowerCase());
    if (!npc) {
      input.sink?.push(
        diag("warn", "scene.puppet.unresolved_target", `narrated NPC behaviour names non-present character "${behavior.npc}"`, {
          context: { npc: behavior.npc, concept: behavior.concept },
        }),
      );
      continue;
    }
    const verdict = checkPuppetContradiction(
      { npc: behavior.npc, concept: behavior.concept },
      { tags: npc.tags, preferences: npc.preferences, traits: npc.traits },
    );
    if (!verdict.contradiction) continue;
    const act = behavior.summary?.trim() || interactionConceptById(behavior.concept ?? "")?.label.toLowerCase() || "that";
    lines.push(
      `- ${npc.displayName} would not "${act}" — it cuts against who ${npc.displayName} is. Do NOT narrate it; answer instead with a brief, knowing aside in the narrator's voice (e.g. "${npc.displayName} raises an eyebrow — those are ${npc.displayName}'s words to choose, not yours.") and let ${npc.displayName} react as themselves.`,
    );
  }
  if (lines.length === 0) return "";
  return [
    "## Disposition guardrail (the player's prose puts words or actions on a character — do NOT honour these)",
    ...lines,
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
