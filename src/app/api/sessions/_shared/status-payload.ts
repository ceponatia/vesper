import { z } from "zod";
import {
  type AvatarCue,
  deriveAvatarCue,
  deriveEmotionLabel,
  effectiveTraitValue,
  type EmotionResult,
  isConditionExpired,
  resolveWardrobeVisibility,
  type ActiveCondition,
  type EmotionLabel,
  type ExposureMask,
  type ItemKind,
  type SceneGenState,
  type StoryThread,
  type WornVisibility,
} from "@/contracts";
import { type CalendarStart, formatGameClock, resolveGameTime } from "@/lib/clock";
import { parseOrNull } from "@/lib/parse";
import { activeLocationId } from "@/server/engine";
import type { BundleItem, SessionBundle } from "@/server/engine";

/**
 * The GET /api/sessions/:id/status sidebar payload (docs/streaming-api.md):
 * participants + state, wardrobe visibility (from state, never prose) plus
 * the complete worn list for the expanded cast card, the current location
 * with its loose items and open containers, the game clock, exposure mask,
 * scene-gen state, and open story threads. Pure shaping over an
 * already-parsed SessionBundle — the trust boundary was bundle.ts.
 */

export interface StatusWardrobeItem {
  instanceId: string;
  name: string;
  visibility: "visible" | "hinted";
}

/** One worn layer in the complete inventory list — hidden layers included. */
export interface StatusWornItem {
  instanceId: string;
  name: string;
  visibility: WornVisibility;
}

export interface StatusItemRef {
  id: string;
  name: string;
  kind: ItemKind;
}

/**
 * A full session item instance with its placement, for the world-tab "Items here"
 * view (UX-audit P6). The bare StatusItemRef omits placement, so the top-level
 * `items` list below carries these — the client filters them by current location.
 */
export interface StatusItemInstance {
  id: string;
  name: string;
  kind: ItemKind;
  worn: boolean;
  holderParticipantId: string | null;
  locationId: string | null;
  containerInstanceId: string | null;
  positionNote: string | null;
  /** Container open/closed; null for non-containers. */
  open: boolean | null;
}

export interface StatusCondition {
  id: string;
  label: string;
  severity?: "minor" | "moderate" | "severe";
  promptHint?: string;
  /** Game minutes until the condition expires; absent for open-ended ones. */
  remainingMinutes?: number;
}

export interface StatusParticipant {
  id: string;
  displayName: string;
  role: "player" | "companion" | "npc";
  /** Simulation/narration depth — the cast-tab tier chip (docs/ui.md). */
  tier: "major" | "minor" | "extra";
  isUser: boolean;
  avatarImageId: string | null;
  /** Soft pointer to the source library character — the key for the avatar manifest fetch
   *  (`GET /api/characters/[id]/avatar/manifest`); null for the player / ad-hoc cast. */
  characterId: string | null;
  locationId: string | null;
  locationName: string | null;
  activity: string;
  posture: string | null;
  meters: Record<string, number>;
  /**
   * Derived discrete emotion (mood.spec.md §4) — the sustained baseline label + its
   * intensity for the cast-card mood chip. A *read* over meters + affinity stage +
   * conditions; null for the player. No transient reaction beat here (that's the
   * avatar's concern) — this is the held face.
   */
  emotion: { label: EmotionLabel; intensity: number } | null;
  /**
   * The renderer-neutral avatar cue (avatar-3d.spec §1) for the in-session standing avatar:
   * the sustained emotion wrapped with posture → pose and the scene atmosphere. `reaction` is
   * always `none` here (the one-shot beat travels the top-level `reactionBeat`). Null for the
   * player. A *read*, derived alongside `emotion`.
   */
  avatarCue: AvatarCue | null;
  conditions: StatusCondition[];
  /** Visibility-filtered outfit (visible/hinted only) — the collapsed-card list. */
  wardrobe: StatusWardrobeItem[];
  /**
   * The complete worn list, hidden layers included, for the expanded cast
   * card (followups.phase2.md #4). `wardrobe` keeps its filtered semantics
   * for existing consumers.
   */
  wornFull: StatusWornItem[];
  held: StatusItemRef[];
}

export interface StatusContainer {
  id: string;
  name: string;
  contents: StatusItemRef[];
}

export interface StatusLocation {
  id: string;
  name: string;
  description: string;
  ambient: { scent?: string; sound?: string; light?: string };
  items: StatusItemRef[];
  openContainers: StatusContainer[];
}

export interface SceneGalleryEntry {
  id: string;
  createdAt: Date;
  /** The generation prompt (for the dev-only lightbox troubleshooting panel). */
  prompt: string;
}

/** The latest turn's time advance, for the "+20m — shower" clock-delta UI. */
export interface ClockDelta {
  minutes: number;
  cause: string;
}

const clockDeltaBlobSchema = z.object({
  clock: z.object({
    minutes: z.number().int().min(1),
    cause: z.string().catch(""),
  }),
});

/**
 * Pure: the `clock` blob a merge wrote into `turns.agentResults`
 * (engine/merge.ts applyTurnResults). Old turns predate the blob and parse to
 * null — the UI renders nothing then.
 */
export function parseClockDelta(agentResults: unknown): ClockDelta | null {
  return parseOrNull(clockDeltaBlobSchema, agentResults)?.clock ?? null;
}

/**
 * The latest turn's one-shot avatar reaction beat (avatar-3d.spec §3), projected from the
 * `reaction` blob `apply.ts` writes onto `turns.agentResults`. Carries the `turn` number so
 * the client fires it **once** (mount-baseline replay guard) for the focal NPC only.
 */
export interface SessionReactionBeat {
  participantId: string;
  concept: string;
  valence: "like" | "dislike";
  magnitude: number;
  turn: number;
}

const reactionBeatBlobSchema = z.object({
  reaction: z.object({
    participantId: z.string().min(1),
    concept: z.string().catch(""),
    valence: z.enum(["like", "dislike"]).catch("like"),
    magnitude: z.number().catch(0),
  }),
});

/** Pure: the `reaction` blob from `turns.agentResults`, stamped with the turn number. Turns
 *  without a resolvable act (or that predate the blob) parse to null — no beat. */
export function parseReactionBeat(agentResults: unknown, turn: number): SessionReactionBeat | null {
  const parsed = parseOrNull(reactionBeatBlobSchema, agentResults)?.reaction;
  return parsed ? { ...parsed, turn } : null;
}

export interface SessionStatusPayload {
  session: {
    id: string;
    title: string;
    status: "ready" | "narrating" | "processing";
    embodied: boolean;
    worldId: string;
    worldName: string;
    /** Resolved narrator model id (world override or env default). */
    narrativeModel: string;
    /** Resolved in-session agent model id (world override or env default). */
    agentModel: string;
  };
  clock: {
    minutes: number;
    display: string;
    /** The world's authored calendar anchor — without it the client falls back to DEFAULT_CALENDAR_START and shows the wrong date. */
    calendarStart: CalendarStart;
    /** The latest completed turn's advance, or null (old/absent turns). */
    delta: ClockDelta | null;
  };
  participants: StatusParticipant[];
  location: StatusLocation | null;
  /** Every session item instance with placement — the world-tab "Items here" view filters these by location (UX-audit P6). */
  items: StatusItemInstance[];
  exposure: ExposureMask;
  sceneGen: SceneGenState & {
    latestImageId: string | null;
    /** Ready scene images, oldest first — survives page refreshes and restarts. */
    gallery: SceneGalleryEntry[];
  };
  threads: StoryThread[];
  /** The latest turn's one-shot avatar reaction beat (avatar-3d), or null when none. */
  reactionBeat: SessionReactionBeat | null;
  /** The latest ready turn number — the client's mount-baseline for the beat replay guard. */
  latestTurn: number | null;
}

function itemRef(item: BundleItem): StatusItemRef {
  return { id: item.id, name: item.name, kind: item.definition.kind };
}

/** Full instance (with placement) for the top-level `items` list — UX-audit P6. */
function itemInstance(item: BundleItem): StatusItemInstance {
  return {
    id: item.id,
    name: item.name,
    kind: item.definition.kind,
    worn: item.worn,
    holderParticipantId: item.holderParticipantId,
    locationId: item.locationId,
    containerInstanceId: item.containerInstanceId,
    positionNote: item.positionNote ?? null,
    open: item.definition.kind === "container" ? (item.state.open ?? null) : null,
  };
}

function shapeCondition(condition: ActiveCondition, clockMinutes: number): StatusCondition {
  return {
    id: condition.id,
    label: condition.label,
    ...(condition.severity !== undefined ? { severity: condition.severity } : {}),
    ...(condition.promptHint !== undefined ? { promptHint: condition.promptHint } : {}),
    // Active conditions never expire mid-payload, so remaining is always > 0.
    ...(condition.durationMinutes !== undefined
      ? { remainingMinutes: condition.startedAtMinutes + condition.durationMinutes - clockMinutes }
      : {}),
  };
}

/**
 * The sustained baseline emotion for an NPC (mood.spec.md §4): a pure read over meters +
 * the affinity stage toward the player + conditions + the scene's intimate frame. The full
 * `EmotionResult` feeds both the cast-card mood chip and the standing avatar's cue. No
 * reaction beat (the avatar layers that on); null for the player.
 */
function participantEmotionResult(
  p: SessionBundle["participants"][number],
  ctx: { playerId: string | undefined; relationships: SessionBundle["relationships"]; intimateContext: boolean },
): EmotionResult | null {
  if (p.isUser) return null;
  const meters = p.state.meters;
  const stage =
    (ctx.playerId
      ? ctx.relationships.find(
          (r) => r.kind === "feeling" && r.fromParticipantId === p.id && r.toParticipantId === ctx.playerId,
        )?.stage
      : undefined) ?? "stranger";
  return deriveEmotionLabel({
    mood: meters.mood ?? 0.5,
    arousal: meters.arousal ?? 0,
    stress: meters.stress ?? 0,
    energy: meters.energy ?? 1,
    affinityStage: stage,
    conditions: p.state.conditions,
    intimateContext: ctx.intimateContext,
    dominance: effectiveTraitValue(p.snapshot.traits, "social.dominance"),
  });
}

/** Worn instances → the complete per-layer list with resolved visibility. */
function shapeWornFull(worn: BundleItem[]): StatusWornItem[] {
  return resolveWardrobeVisibility(
    worn.map((item) => ({
      instanceId: item.id,
      name: item.name,
      coverage: item.definition.coverage,
      layer: item.definition.layer ?? 1,
      opacity: item.definition.opacity,
    })),
  ).map((view) => ({ instanceId: view.instanceId, name: view.name, visibility: view.visibility }));
}

/** Visible/hinted wardrobe entries (hidden layers excluded). */
function shapeWardrobe(wornFull: StatusWornItem[]): StatusWardrobeItem[] {
  return wornFull.flatMap((view) =>
    view.visibility === "hidden"
      ? []
      : [{ instanceId: view.instanceId, name: view.name, visibility: view.visibility }],
  );
}

export function buildStatusPayload(
  bundle: SessionBundle,
  extras: {
    latestSceneImageId: string | null;
    sceneGallery: SceneGalleryEntry[];
    narrativeModel: string;
    agentModel: string;
    clockDelta: ClockDelta | null;
    reactionBeat: SessionReactionBeat | null;
    latestTurn: number | null;
  },
): SessionStatusPayload {
  const locationName = new Map(bundle.locations.map((l) => [l.id, l.name]));
  const playerId = bundle.participants.find((p) => p.isUser)?.id;
  const exposure = bundle.brief.exposure;
  // Intimate *frame* (mood.spec §2): an intimate touch/appearance scope — the gate
  // for `aroused`. Deliberately distinct from wardrobe undress (a clothed character
  // can be aroused).
  const intimateContext = exposure.touch === "intimate" || exposure.appearance === "intimate";
  const activeId = activeLocationId(bundle);
  // Continuity key for the avatar cue: the active location, falling back to the session id.
  const sceneId = activeId ?? bundle.session.id;

  const participants: StatusParticipant[] = bundle.participants.map((p) => {
    const held = bundle.items.filter((i) => i.holderParticipantId === p.id && !i.worn);
    const worn = bundle.items.filter((i) => i.holderParticipantId === p.id && i.worn);
    const wornFull = shapeWornFull(worn);
    const emotionResult = participantEmotionResult(p, { playerId, relationships: bundle.relationships, intimateContext });
    return {
      id: p.id,
      displayName: p.displayName,
      role: p.role,
      tier: p.tier,
      isUser: p.isUser,
      avatarImageId: p.avatarImageId,
      characterId: p.characterId ?? null,
      locationId: p.locationId,
      locationName: p.locationId ? (locationName.get(p.locationId) ?? null) : null,
      activity: p.state.activity,
      posture: p.state.posture ?? null,
      meters: p.state.meters,
      emotion: emotionResult ? { label: emotionResult.emotion, intensity: emotionResult.intensity } : null,
      // The standing avatar's sustained cue: emotion + posture→pose + scene atmosphere. The
      // one-shot beat rides the top-level `reactionBeat`, not this (avatar-3d.spec §3).
      avatarCue: emotionResult
        ? deriveAvatarCue({ emotion: emotionResult, posture: p.state.posture ?? null, atmosphere: bundle.brief.atmosphere, sceneId })
        : null,
      conditions: p.state.conditions
        .filter((c) => !isConditionExpired(c, bundle.clockMinutes))
        .map((c) => shapeCondition(c, bundle.clockMinutes)),
      wardrobe: shapeWardrobe(wornFull),
      wornFull,
      held: held.map(itemRef),
    };
  });

  const place = bundle.locations.find((l) => l.id === activeId) ?? null;
  let location: StatusLocation | null = null;
  if (place) {
    const inLocation = bundle.items.filter((i) => i.locationId === place.id);
    const openContainers: StatusContainer[] = inLocation
      .filter((i) => i.definition.kind === "container" && i.state.open === true)
      .map((container) => ({
        id: container.id,
        name: container.name,
        contents: bundle.items.filter((i) => i.containerInstanceId === container.id).map(itemRef),
      }));
    location = {
      id: place.id,
      name: place.name,
      description: place.description,
      ambient: place.ambient,
      items: inLocation.map(itemRef),
      openContainers,
    };
  }

  const time = resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart);

  return {
    session: {
      id: bundle.session.id,
      title: bundle.session.title,
      status: bundle.session.status,
      embodied: bundle.session.embodied,
      worldId: bundle.world.id,
      worldName: bundle.world.name,
      narrativeModel: extras.narrativeModel,
      agentModel: extras.agentModel,
    },
    clock: {
      minutes: bundle.clockMinutes,
      display: formatGameClock(time),
      calendarStart: bundle.style.calendarStart,
      delta: extras.clockDelta,
    },
    participants,
    location,
    items: bundle.items.map(itemInstance),
    exposure: bundle.brief.exposure,
    sceneGen: { ...bundle.scene, latestImageId: extras.latestSceneImageId, gallery: extras.sceneGallery },
    // Active threads (open + cooling) with their full detail (kind, question,
    // closeConditions, developments) so the World-tab cards and detail modal
    // can render everything gleaned (docs/story-threads.md). Resolved/archived
    // threads are intentionally dropped — closing one removes it from the UI.
    threads: bundle.runtime.storyThreads.filter((t) => t.status === "open" || t.status === "cooling"),
    reactionBeat: extras.reactionBeat,
    latestTurn: extras.latestTurn,
  };
}
