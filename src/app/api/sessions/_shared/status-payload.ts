import { z } from "zod";
import {
  isConditionExpired,
  resolveWardrobeVisibility,
  type ActiveCondition,
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
  locationId: string | null;
  locationName: string | null;
  activity: string;
  posture: string | null;
  meters: Record<string, number>;
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
  exposure: ExposureMask;
  sceneGen: SceneGenState & {
    latestImageId: string | null;
    /** Ready scene images, oldest first — survives page refreshes and restarts. */
    gallery: SceneGalleryEntry[];
  };
  threads: StoryThread[];
}

function itemRef(item: BundleItem): StatusItemRef {
  return { id: item.id, name: item.name, kind: item.definition.kind };
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
    clockDelta: ClockDelta | null;
  },
): SessionStatusPayload {
  const locationName = new Map(bundle.locations.map((l) => [l.id, l.name]));

  const participants: StatusParticipant[] = bundle.participants.map((p) => {
    const held = bundle.items.filter((i) => i.holderParticipantId === p.id && !i.worn);
    const worn = bundle.items.filter((i) => i.holderParticipantId === p.id && i.worn);
    const wornFull = shapeWornFull(worn);
    return {
      id: p.id,
      displayName: p.displayName,
      role: p.role,
      tier: p.tier,
      isUser: p.isUser,
      avatarImageId: p.avatarImageId,
      locationId: p.locationId,
      locationName: p.locationId ? (locationName.get(p.locationId) ?? null) : null,
      activity: p.state.activity,
      posture: p.state.posture ?? null,
      meters: p.state.meters,
      conditions: p.state.conditions
        .filter((c) => !isConditionExpired(c, bundle.clockMinutes))
        .map((c) => shapeCondition(c, bundle.clockMinutes)),
      wardrobe: shapeWardrobe(wornFull),
      wornFull,
      held: held.map(itemRef),
    };
  });

  const activeId = activeLocationId(bundle);
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
    },
    clock: {
      minutes: bundle.clockMinutes,
      display: formatGameClock(time),
      calendarStart: bundle.style.calendarStart,
      delta: extras.clockDelta,
    },
    participants,
    location,
    exposure: bundle.brief.exposure,
    sceneGen: { ...bundle.scene, latestImageId: extras.latestSceneImageId, gallery: extras.sceneGallery },
    threads: bundle.runtime.storyThreads.filter((t) => t.status === "open"),
  };
}
