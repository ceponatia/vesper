"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { CalendarStart } from "@/lib/clock";
import { calendarStartSchema } from "@/lib/clock";
import { apiGet, toApiError, withQuery, type ApiError } from "@/lib/client/api";
import { consumeTurnStream, type TurnChunkPayload } from "@/lib/client/turn-stream";
import type { TurnAuthor } from "@/contracts/turns/stream";
import { emotionLabelSchema } from "@/contracts/mood/emotion-label";

/**
 * Play-screen client data layer (docs/ui.md §Play screen,
 * docs/streaming-api.md): feed load + ?before pagination, live streaming
 * segments, submit/edit/delete/rerun, and the post-turn job poll. Every
 * response crosses a trust boundary and is parsed with forgiving schemas —
 * missing data renders as absent, never as a crash. The pure helpers
 * (parseFeedPage, mergeFeedTail, applyChunk, parseSessionStatus, …) are
 * exported for tests.
 */

export const FEED_PAGE_SIZE = 80;
export const JOB_POLL_MS = 1500;
/** Stop polling after ~5 minutes; the recover affordance can restart it. */
const MAX_JOB_POLLS = 200;

// ---------------------------------------------------------------------------
// Forgiving schema helpers (same idiom as lib/client/api.ts)
// ---------------------------------------------------------------------------

/** Array where invalid elements are dropped instead of failing the list. */
function arrayOf<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((xs) =>
      xs.flatMap((x) => {
        const parsed = item.safeParse(x);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

const optionalText = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function firstPresent(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export const feedRoleSchema = z.enum(["player", "narrator", "character", "system"]).catch("narrator");
export type FeedRole = z.infer<typeof feedRoleSchema>;

export const feedMessageSchema = z.preprocess(
  (raw) => {
    const obj = record(raw);
    if (!obj) return raw;
    return {
      ...obj,
      id: firstPresent(obj, ["id", "messageId"]),
      turnNumber: firstPresent(obj, ["turnNumber", "number"]),
      createdAt: firstPresent(obj, ["createdAt", "created_at"]),
    };
  },
  z.object({
    id: z.string().min(1),
    turnId: z.string().catch(""),
    turnNumber: z
      .number()
      .int()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
    seq: z.number().int().catch(0),
    role: feedRoleSchema,
    speaker: optionalText,
    content: z.string().catch(""),
    createdAt: optionalText,
  }),
);
export type FeedMessage = z.infer<typeof feedMessageSchema>;

export interface FeedPage {
  /** Chronological (oldest first). */
  messages: FeedMessage[];
  hasMore: boolean;
  /** Cursor for the next older page, or null when exhausted/unknown. */
  nextBefore: string | null;
}

/** Pure: shape any plausible /feed payload into a normalized page. */
export function parseFeedPage(raw: unknown, limit = FEED_PAGE_SIZE): FeedPage {
  const obj = record(raw);
  const listRaw = Array.isArray(raw)
    ? raw
    : (obj && ["messages", "feed", "items", "data"].map((k) => obj[k]).find(Array.isArray)) || [];
  let messages = arrayOf(feedMessageSchema).parse(listRaw);

  // Normalize to chronological order if the server returned newest-first.
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first && last && first !== last) {
    if (first.turnNumber !== null && last.turnNumber !== null) {
      if (first.turnNumber > last.turnNumber) messages = [...messages].reverse();
    } else if (first.createdAt && last.createdAt && first.createdAt > last.createdAt) {
      messages = [...messages].reverse();
    }
  }

  const explicitCursor = obj
    ? z
        .string()
        .min(1)
        .nullish()
        .catch(null)
        .parse(firstPresent(obj, ["nextBefore", "before", "cursor", "nextCursor"]))
    : null;
  const explicitHasMore = obj ? z.boolean().optional().catch(undefined).parse(obj.hasMore) : undefined;

  return {
    messages,
    hasMore: explicitHasMore ?? messages.length >= limit,
    nextBefore: explicitCursor ?? messages[0]?.id ?? null,
  };
}

/**
 * Pure: merge a freshly fetched tail page into the loaded feed. Existing rows
 * keep their position (and pick up edits by id); unseen rows append in tail
 * order — the loaded older range is never refetched or reordered.
 */
export function mergeFeedTail(existing: FeedMessage[], tail: FeedMessage[]): FeedMessage[] {
  if (existing.length === 0) return tail;
  const tailById = new Map(tail.map((m) => [m.id, m] as const));
  const existingIds = new Set(existing.map((m) => m.id));
  const updated = existing.map((m) => tailById.get(m.id) ?? m);
  const appended = tail.filter((m) => !existingIds.has(m.id));
  return appended.length === 0 && updated.every((m, i) => m === existing[i]) ? existing : [...updated, ...appended];
}

/** Pure: prepend an older page, dropping rows already loaded. */
export function prependOlder(existing: FeedMessage[], older: FeedMessage[]): FeedMessage[] {
  const existingIds = new Set(existing.map((m) => m.id));
  const fresh = older.filter((m) => !existingIds.has(m.id));
  return fresh.length === 0 ? existing : [...fresh, ...existing];
}

// ---------------------------------------------------------------------------
// Streaming segments
// ---------------------------------------------------------------------------

export interface StreamSegment {
  segmentIndex: number;
  speaker: string | null;
  content: string;
}

/** Pure: fold an SSE chunk delta into the segment list (keyed by index). */
export function applyChunk(segments: StreamSegment[], chunk: TurnChunkPayload): StreamSegment[] {
  const existing = segments.find((s) => s.segmentIndex === chunk.segmentIndex);
  if (existing) {
    return segments.map((s) =>
      s.segmentIndex === chunk.segmentIndex ? { ...s, content: s.content + chunk.content } : s,
    );
  }
  const next = [...segments, { segmentIndex: chunk.segmentIndex, speaker: chunk.speaker, content: chunk.content }];
  next.sort((a, b) => a.segmentIndex - b.segmentIndex);
  return next;
}

// ---------------------------------------------------------------------------
// Status payload (GET /sessions/:id/status)
// ---------------------------------------------------------------------------

export const wornVisibilitySchema = z.enum(["visible", "hinted", "hidden"]).catch("visible");

const wardrobeEntrySchema = z.preprocess(
  (raw) => {
    if (typeof raw === "string") return { name: raw };
    const obj = record(raw);
    if (!obj) return raw;
    const instanceId = firstPresent(obj, ["instanceId", "id"]);
    return instanceId === undefined ? obj : { ...obj, instanceId };
  },
  z.object({
    instanceId: z.string().optional().catch(undefined),
    name: z.string().min(1),
    visibility: wornVisibilitySchema,
  }),
);
export type WardrobeEntry = z.infer<typeof wardrobeEntrySchema>;

const conditionChipSchema = z.object({
  id: z.string().catch(""),
  label: z.string().min(1),
  severity: z
    .enum(["minor", "moderate", "severe"])
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  /** Game minutes left on a timed condition; old payloads/open-ended → null. */
  remainingMinutes: z
    .number()
    .int()
    .positive()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
});
export type ConditionChip = z.infer<typeof conditionChipSchema>;

/** A held item on the expanded cast card; old payloads simply lack the list. */
const heldItemSchema = z.preprocess(
  (raw) => (typeof raw === "string" ? { name: raw } : raw),
  z.object({
    id: z.string().catch(""),
    name: z.string().min(1),
    kind: z.enum(["clothing", "object", "container"]).catch("object"),
  }),
);
export type HeldItem = z.infer<typeof heldItemSchema>;

/** The cast-card mood chip (mood.spec §4); absent/legacy payloads → null (no chip). */
const emotionChipSchema = z
  .object({
    label: emotionLabelSchema,
    intensity: z.number().min(0).max(1).catch(0),
  })
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);
export type EmotionChip = z.infer<typeof emotionChipSchema>;

export const statusParticipantSchema = z.preprocess(
  (raw) => {
    const obj = record(raw);
    if (!obj) return raw;
    const state = record(obj.state) ?? {};
    return {
      ...obj,
      displayName: firstPresent(obj, ["displayName", "name"]),
      activity: firstPresent(obj, ["activity"]) ?? state.activity,
      posture: firstPresent(obj, ["posture"]) ?? state.posture,
      meters: firstPresent(obj, ["meters"]) ?? state.meters,
      conditions: firstPresent(obj, ["conditions"]) ?? state.conditions,
      wardrobe: firstPresent(obj, ["wardrobe", "outfit", "visibleOutfit", "worn"]),
    };
  },
  z.object({
    id: z.string().min(1),
    displayName: z.string().catch("Unknown"),
    role: z.enum(["player", "companion", "npc"]).catch("npc"),
    /** Tier chip on the cast cards; absent/legacy payloads degrade to minor. */
    tier: z.enum(["major", "minor", "extra"]).catch("minor"),
    isUser: z.boolean().catch(false),
    avatarImageId: optionalText,
    locationId: optionalText,
    locationName: optionalText,
    activity: z.string().catch("idle"),
    posture: optionalText,
    meters: z.record(z.string(), z.number()).catch({}),
    /** Derived discrete emotion for the mood chip; player/legacy payloads → null. */
    emotion: emotionChipSchema,
    conditions: arrayOf(conditionChipSchema),
    wardrobe: arrayOf(wardrobeEntrySchema),
    /**
     * The complete worn list (hidden layers included) for the expanded cast
     * card; `wardrobe` stays visibility-filtered. Old payloads lack the field
     * and degrade to [] — the expanded card then falls back to `wardrobe`.
     */
    wornFull: arrayOf(wardrobeEntrySchema),
    held: arrayOf(heldItemSchema),
  }),
);
export type StatusParticipant = z.infer<typeof statusParticipantSchema>;

export const statusItemSchema = z.preprocess(
  (raw) => {
    const obj = record(raw);
    if (!obj) return raw;
    return {
      ...obj,
      containerInstanceId: firstPresent(obj, ["containerInstanceId", "containerId"]),
      holderParticipantId: firstPresent(obj, ["holderParticipantId", "holderId"]),
    };
  },
  z.object({
    id: z.string().min(1),
    name: z.string().catch("item"),
    kind: z.enum(["clothing", "object", "container"]).catch("object"),
    quantity: z.number().int().catch(1),
    worn: z.boolean().catch(false),
    holderParticipantId: optionalText,
    locationId: optionalText,
    containerInstanceId: optionalText,
    positionNote: optionalText,
    open: z
      .boolean()
      .nullish()
      .catch(null)
      .transform((v) => v ?? null),
  }),
);
export type StatusItem = z.infer<typeof statusItemSchema>;

const statusThreadDevelopmentSchema = z.object({
  turn: z.number().catch(0),
  text: z.string().catch(""),
  kind: z.enum(["evidence", "statement", "event", "lead", "update"]).catch("update"),
});
export type StatusThreadDevelopment = z.infer<typeof statusThreadDevelopmentSchema>;

const statusThreadSchema = z.object({
  id: z.string().catch(""),
  title: z.string().min(1),
  summary: z.string().catch(""),
  kind: z.enum(["investigation", "ongoing"]).catch("investigation"),
  status: z.enum(["open", "cooling", "resolved", "archived"]).catch("open"),
  question: z.string().catch(""),
  closeConditions: z.array(z.string()).catch([]),
  developments: z.array(statusThreadDevelopmentSchema).catch([]),
  openedAtTurn: z.number().catch(0),
  lastTouchedTurn: z.number().catch(0),
});
export type StatusThread = z.infer<typeof statusThreadSchema>;

const sceneImageSchema = z.preprocess(
  (raw) => (typeof raw === "string" ? { id: raw } : raw),
  z.object({
    id: z.string().min(1),
    createdAt: optionalText,
    status: z.enum(["pending", "ready", "failed"]).catch("ready"),
    /** Generation prompt — fed to the dev-only lightbox troubleshooting panel. */
    prompt: z.string().catch(""),
  }),
);
export type SceneImage = z.infer<typeof sceneImageSchema>;

const sceneGenSchema = z.object({
  interval: z.number().int().min(0).catch(0),
  status: z.enum(["idle", "generating", "failed"]).catch("idle"),
  /** Single identity anchor vs Venice multi-reference edit (the session toggle). */
  referenceMode: z.enum(["single", "multi"]).catch("single"),
});
export type SceneGen = z.infer<typeof sceneGenSchema>;

export const sessionStateSchema = z.enum(["ready", "narrating", "processing"]).catch("ready");
export type SessionState = z.infer<typeof sessionStateSchema>;

/** The latest turn's time advance ("+20m — shower"); old turns have none. */
const clockDeltaSchema = z.object({
  minutes: z.number().int().min(1),
  cause: z.string().catch(""),
});
export type ClockDelta = z.infer<typeof clockDeltaSchema>;

export interface StatusLocation {
  id: string | null;
  name: string;
  description: string;
}

export interface SessionStatus {
  title: string | null;
  state: SessionState;
  worldId: string | null;
  /** Resolved narrator model id, or null when the route doesn't report one. */
  narrativeModel: string | null;
  /** Resolved in-session agent model id, or null when the route doesn't report one. */
  agentModel: string | null;
  clockMinutes: number;
  /** Last turn's advance, or null when unknown (old turns, no turns yet). */
  clockDelta: ClockDelta | null;
  calendarStart: CalendarStart | null;
  location: StatusLocation | null;
  participants: StatusParticipant[];
  items: StatusItem[];
  threads: StatusThread[];
  scene: {
    currentImageId: string | null;
    gallery: SceneImage[];
    gen: SceneGen;
  };
}

const locationSchema = z.object({
  id: optionalText,
  name: z.string().catch("Somewhere"),
  description: z.string().catch(""),
});

/**
 * Pure: shape the /status payload (whatever subset the route provides) into a
 * SessionStatus. Returns null only for a non-object payload; otherwise every
 * missing piece degrades to an absent-but-renderable default.
 */
export function parseSessionStatus(raw: unknown): SessionStatus | null {
  const obj = record(raw);
  if (!obj) return null;
  const session = record(obj.session) ?? {};

  const clockRaw = firstPresent(obj, ["clockMinutes"]) ?? firstPresent(session, ["clockMinutes"]) ?? obj.clock;
  const clockObj = record(obj.clock) ?? {};
  const clockMinutes = z
    .number()
    .min(0)
    .catch(0)
    .parse(typeof clockRaw === "number" ? clockRaw : clockObj.minutes);
  const delta = clockDeltaSchema.safeParse(firstPresent(clockObj, ["delta"]) ?? obj.clockDelta);

  const calendarRaw =
    firstPresent(obj, ["calendarStart"]) ?? clockObj.calendarStart ?? record(obj.style)?.calendarStart;
  const calendar = calendarStartSchema.safeParse(calendarRaw);

  const locationRaw = firstPresent(obj, ["location", "currentLocation"]);
  const location = record(locationRaw) ? locationSchema.parse(locationRaw) : null;

  const sceneObj = record(obj.scene) ?? {};
  const genRaw = firstPresent(sceneObj, ["gen", "sceneGen"]) ?? firstPresent(obj, ["sceneGen"]) ?? sceneObj;
  const genObj = record(genRaw) ?? {};
  const gallery = arrayOf(sceneImageSchema).parse(
    firstPresent(sceneObj, ["gallery", "images"]) ??
      firstPresent(obj, ["gallery", "sceneImages"]) ??
      genObj.gallery ??
      [],
  );
  const currentImageId =
    optionalText.parse(
      firstPresent(sceneObj, ["currentImageId", "imageId", "latestImageId"]) ??
        firstPresent(genObj, ["latestImageId", "currentImageId"]),
    ) ??
    gallery[gallery.length - 1]?.id ??
    null;

  const threadsRaw =
    firstPresent(obj, ["threads", "storyThreads"]) ?? record(obj.runtime)?.storyThreads ?? [];

  return {
    title: optionalText.parse(firstPresent(obj, ["title"]) ?? session.title),
    state: sessionStateSchema.parse(firstPresent(obj, ["status", "state"]) ?? session.status),
    worldId: optionalText.parse(firstPresent(obj, ["worldId"]) ?? session.worldId),
    narrativeModel: optionalText.parse(firstPresent(obj, ["narrativeModel"]) ?? session.narrativeModel),
    agentModel: optionalText.parse(firstPresent(obj, ["agentModel"]) ?? session.agentModel),
    clockMinutes,
    clockDelta: delta.success ? delta.data : null,
    calendarStart: calendar.success ? calendar.data : null,
    location,
    participants: arrayOf(statusParticipantSchema).parse(firstPresent(obj, ["participants", "cast"]) ?? []),
    items: arrayOf(statusItemSchema).parse(firstPresent(obj, ["items", "itemInstances"]) ?? []),
    threads: arrayOf(statusThreadSchema).parse(threadsRaw),
    scene: { currentImageId, gallery, gen: sceneGenSchema.catch({ interval: 0, status: "idle", referenceMode: "single" }).parse(genRaw) },
  };
}

const sessionStatusResponseSchema = z.unknown().transform((raw) => parseSessionStatus(raw));

// ---------------------------------------------------------------------------
// Job polling payload (GET /sessions/:id/job)
// ---------------------------------------------------------------------------

export const jobStatusSchema = z.object({
  status: sessionStateSchema,
  jobType: optionalText,
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export type AuthorMode = TurnAuthor;

export type ActionOutcome = { ok: true } | { ok: false; error: ApiError };

export interface PendingEcho {
  input: string;
  author: AuthorMode;
  speakerName: string | null;
}

export interface StreamingView {
  active: boolean;
  phase: "idle" | "narrating" | "processing";
  turnId: string | null;
  segments: StreamSegment[];
  echo: PendingEcho | null;
}

export interface UseSession {
  sessionId: string;
  feed: FeedMessage[];
  feedLoading: boolean;
  feedError: ApiError | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
  status: SessionStatus | null;
  statusLoading: boolean;
  statusError: ApiError | null;
  refresh: () => Promise<void>;
  /** Why the composer is disabled, or null when ready for input. */
  busy: "narrating" | "processing" | null;
  jobType: string | null;
  streaming: StreamingView;
  /** Stream dropped before done/error; the turn finishes server-side. */
  incomplete: boolean;
  recoverIncomplete: () => Promise<void>;
  submit: (input: string, author: AuthorMode, speakerParticipantId?: string) => Promise<ActionOutcome>;
  editMessage: (messageId: string, content: string) => Promise<ActionOutcome>;
  deleteMessage: (messageId: string) => Promise<ActionOutcome>;
  rerunMessage: (messageId: string) => Promise<ActionOutcome>;
}

function networkError(err: unknown): ApiError {
  return { status: 0, code: "network_error", message: err instanceof Error ? err.message : "Network error" };
}

export function useSession(sessionId: string): UseSession {
  const [feed, setFeed] = useState<FeedMessage[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState<ApiError | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<ApiError | null>(null);

  const [sessionState, setSessionState] = useState<SessionState>("ready");
  const [jobType, setJobType] = useState<string | null>(null);

  const [segments, setSegments] = useState<StreamSegment[]>([]);
  const [streamTurnId, setStreamTurnId] = useState<string | null>(null);
  const [streamPhase, setStreamPhase] = useState<"idle" | "narrating" | "processing">("idle");
  const [echo, setEcho] = useState<PendingEcho | null>(null);
  const [incomplete, setIncomplete] = useState(false);

  const mountedRef = useRef(true);
  // Completing a turn never resets the pagination cursor (docs/ui.md).
  const cursorRef = useRef<string | null>(null);
  const cursorInitializedRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const streamActiveRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollGenerationRef.current += 1; // cancel any in-flight poll loop
    };
  }, []);

  const feedLoadedRef = useRef(false);
  const feedTailGenRef = useRef(0);
  const fetchFeedTail = useCallback(async (): Promise<void> => {
    const gen = ++feedTailGenRef.current;
    const result = await apiGet(z.unknown(), `/api/sessions/${sessionId}/feed`);
    // Superseded by a newer tail fetch (or unmounted): only the latest fetch
    // updates state, so concurrent fetches can't initialize the pagination
    // cursor from a stale page or merge another session's tail.
    if (!mountedRef.current || gen !== feedTailGenRef.current) return;
    if (!result.ok) {
      setFeedError((prev) => (feedLoadedRef.current ? prev : result.error));
      setFeedLoading(false);
      return;
    }
    const page = parseFeedPage(result.data);
    feedLoadedRef.current = true;
    setFeed((prev) => mergeFeedTail(prev, page.messages));
    if (!cursorInitializedRef.current) {
      cursorInitializedRef.current = true;
      cursorRef.current = page.nextBefore;
      setHasOlder(page.hasMore);
    }
    setFeedError(null);
    setFeedLoading(false);
  }, [sessionId]);

  const statusLoadedRef = useRef(false);
  const fetchStatus = useCallback(async (): Promise<void> => {
    const result = await apiGet(sessionStatusResponseSchema, `/api/sessions/${sessionId}/status`);
    if (!mountedRef.current) return;
    if (result.ok && result.data) {
      statusLoadedRef.current = true;
      setStatus(result.data);
      setStatusError(null);
      // The stream is the live source of truth while it is open.
      if (!streamActiveRef.current) setSessionState(result.data.state);
    } else if (!result.ok) {
      // Keep showing loaded data through transient refresh failures.
      setStatusError((prev) => (statusLoadedRef.current ? prev : result.error));
    }
    setStatusLoading(false);
  }, [sessionId]);

  const clearStream = useCallback(() => {
    setSegments([]);
    setStreamTurnId(null);
    setStreamPhase("idle");
    setEcho(null);
  }, []);

  /** Poll /job every 1.5s until the session is ready (docs/streaming-api.md). */
  const pollUntilReady = useCallback(async (): Promise<void> => {
    const generation = ++pollGenerationRef.current;
    for (let i = 0; i < MAX_JOB_POLLS; i++) {
      if (!mountedRef.current || generation !== pollGenerationRef.current) return;
      const result = await apiGet(jobStatusSchema, `/api/sessions/${sessionId}/job`);
      if (!mountedRef.current || generation !== pollGenerationRef.current) return;
      if (result.ok) {
        setJobType(result.data.jobType);
        if (result.data.status === "ready") {
          setSessionState("ready");
          setJobType(null);
          return;
        }
        if (!streamActiveRef.current) setSessionState(result.data.status);
      }
      // Transient failures: keep polling.
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    }
  }, [sessionId]);

  /** After done/edit: wait for the job queue, then refresh sidebar + feed tail. */
  const settle = useCallback(async (): Promise<void> => {
    await pollUntilReady();
    await Promise.all([fetchStatus(), fetchFeedTail()]);
    if (mountedRef.current) clearStream();
  }, [pollUntilReady, fetchStatus, fetchFeedTail, clearStream]);

  // Reset for a new session id during render (the React "adjust state while
  // rendering" pattern) so the load effect below stays setState-free until
  // its fetches resolve.
  const [loadedSessionId, setLoadedSessionId] = useState(sessionId);
  if (loadedSessionId !== sessionId) {
    setLoadedSessionId(sessionId);
    setFeed([]);
    setFeedLoading(true);
    setFeedError(null);
    setStatus(null);
    setStatusLoading(true);
    setStatusError(null);
    setSegments([]);
    setStreamTurnId(null);
    setStreamPhase("idle");
    setEcho(null);
    setIncomplete(false);
    setSessionState("ready");
    setJobType(null);
  }

  // Initial load: feed + status + (if a turn is mid-flight after a reload)
  // resume the job poll.
  useEffect(() => {
    feedLoadedRef.current = false;
    statusLoadedRef.current = false;
    cursorInitializedRef.current = false;
    cursorRef.current = null;
    void fetchFeedTail();
    void (async () => {
      await fetchStatus();
      const result = await apiGet(jobStatusSchema, `/api/sessions/${sessionId}/job`);
      if (!mountedRef.current) return;
      if (result.ok && result.data.status !== "ready") {
        setSessionState(result.data.status);
        setJobType(result.data.jobType);
        await settle();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per session id
  }, [sessionId]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const before = cursorRef.current;
    if (!before || loadingOlder) return;
    setLoadingOlder(true);
    const result = await apiGet(z.unknown(), withQuery(`/api/sessions/${sessionId}/feed`, { before }));
    if (!mountedRef.current) return;
    if (result.ok) {
      const page = parseFeedPage(result.data);
      setFeed((prev) => prependOlder(prev, page.messages));
      // A page that doesn't advance the cursor means history is exhausted
      // (or the server ignored ?before) — stop offering "load earlier".
      const advanced = page.messages.length > 0 && page.nextBefore !== before;
      cursorRef.current = advanced ? page.nextBefore : null;
      setHasOlder(page.hasMore && advanced);
    }
    setLoadingOlder(false);
  }, [sessionId, loadingOlder]);

  /** Shared SSE runner for submit and rerun. */
  const runTurnStream = useCallback(
    async (path: string, body: unknown, pendingEcho: PendingEcho | null, dropTurnId?: string): Promise<ActionOutcome> => {
      if (streamActiveRef.current) {
        return { ok: false, error: { status: 409, code: "client_busy", message: "A turn is already streaming." } };
      }
      let response: Response;
      try {
        response = await fetch(path, {
          method: "POST",
          headers: { accept: "text/event-stream", "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } catch (err) {
        return { ok: false, error: networkError(err) };
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/event-stream")) {
        let raw: unknown = null;
        try {
          raw = await response.json();
        } catch {
          raw = null;
        }
        return { ok: false, error: toApiError(response.status || 500, raw) };
      }

      streamActiveRef.current = true;
      setIncomplete(false);
      setSegments([]);
      setStreamTurnId(null);
      setEcho(pendingEcho);
      setStreamPhase("narrating");
      setSessionState("narrating");

      let streamError: ApiError | null = null;
      const outcome = await consumeTurnStream(response, {
        onStart: (e) => {
          if (!mountedRef.current) return;
          setStreamTurnId(e.turnId || null);
          // A rerun replaces the turn's old messages; drop them once the
          // replacement stream is live.
          if (dropTurnId) setFeed((prev) => prev.filter((m) => m.turnId !== dropTurnId));
        },
        onChunk: (e) => {
          if (mountedRef.current) setSegments((prev) => applyChunk(prev, e));
        },
        onStatus: () => {
          if (!mountedRef.current) return;
          setStreamPhase("processing");
          setSessionState("processing");
        },
        onError: (e) => {
          streamError = { status: 0, code: e.code, message: e.message };
        },
      });
      streamActiveRef.current = false;
      if (!mountedRef.current) return { ok: true };

      if (outcome.completed) {
        await settle();
        return { ok: true };
      }
      if (streamError) {
        clearStream();
        await Promise.all([pollUntilReady(), fetchFeedTail()]);
        await fetchStatus();
        return { ok: false, error: streamError };
      }
      // Dropped stream: keep the partial text visible; the recover affordance
      // re-polls /job + /feed to pick up the server-finished turn.
      setIncomplete(true);
      setStreamPhase("processing");
      return { ok: true };
    },
    [settle, clearStream, pollUntilReady, fetchFeedTail, fetchStatus],
  );

  const submit = useCallback(
    async (input: string, author: AuthorMode, speakerParticipantId?: string): Promise<ActionOutcome> => {
      const speakerName =
        (speakerParticipantId &&
          status?.participants.find((p) => p.id === speakerParticipantId)?.displayName) ||
        null;
      return runTurnStream(
        `/api/sessions/${sessionId}/turns`,
        { input, author, ...(speakerParticipantId ? { speakerParticipantId } : {}) },
        { input, author, speakerName },
      );
    },
    [sessionId, runTurnStream, status],
  );

  const rerunMessage = useCallback(
    async (messageId: string): Promise<ActionOutcome> => {
      const message = feed.find((m) => m.id === messageId);
      const turnId = message?.turnId || undefined;
      const playerLine = turnId ? feed.find((m) => m.turnId === turnId && m.role === "player") : undefined;
      return runTurnStream(
        `/api/sessions/${sessionId}/messages/${messageId}/rerun`,
        {},
        playerLine ? { input: playerLine.content, author: "player", speakerName: null } : null,
        turnId,
      );
    },
    [sessionId, runTurnStream, feed],
  );

  const recoverIncomplete = useCallback(async (): Promise<void> => {
    // Drop the partial segments before the network-bound settle: otherwise the
    // catch-up click strands the partial text on screen with no affordance
    // until the job poll + feed refresh complete.
    setIncomplete(false);
    clearStream();
    await settle();
  }, [settle, clearStream]);

  const editMessage = useCallback(
    async (messageId: string, content: string): Promise<ActionOutcome> => {
      let response: Response;
      try {
        response = await fetch(`/api/sessions/${sessionId}/messages/${messageId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ content }),
        });
      } catch (err) {
        return { ok: false, error: networkError(err) };
      }
      if (!response.ok) {
        let raw: unknown = null;
        try {
          raw = await response.json();
        } catch {
          raw = null;
        }
        return { ok: false, error: toApiError(response.status, raw) };
      }
      if (!mountedRef.current) return { ok: true };
      setFeed((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
      // Editing narration queues a reconcile job (docs/turn-engine.md).
      setSessionState("processing");
      void settle();
      return { ok: true };
    },
    [sessionId, settle],
  );

  const deleteMessage = useCallback(
    async (messageId: string): Promise<ActionOutcome> => {
      let response: Response;
      try {
        response = await fetch(`/api/sessions/${sessionId}/messages/${messageId}`, {
          method: "DELETE",
          headers: { accept: "application/json" },
        });
      } catch (err) {
        return { ok: false, error: networkError(err) };
      }
      if (!response.ok) {
        let raw: unknown = null;
        try {
          raw = await response.json();
        } catch {
          raw = null;
        }
        return { ok: false, error: toApiError(response.status, raw) };
      }
      if (mountedRef.current) {
        setFeed((prev) => prev.filter((m) => m.id !== messageId));
        void fetchStatus();
      }
      return { ok: true };
    },
    [sessionId, fetchStatus],
  );

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([fetchStatus(), fetchFeedTail()]);
  }, [fetchStatus, fetchFeedTail]);

  const busy: "narrating" | "processing" | null =
    streamPhase !== "idle" ? streamPhase : sessionState !== "ready" ? sessionState : null;

  return {
    sessionId,
    feed,
    feedLoading,
    feedError,
    hasOlder,
    loadingOlder,
    loadOlder,
    status,
    statusLoading,
    statusError,
    refresh,
    busy,
    jobType,
    streaming: {
      active: streamPhase !== "idle",
      phase: streamPhase,
      turnId: streamTurnId,
      segments,
      echo,
    },
    incomplete,
    recoverIncomplete,
    submit,
    editMessage,
    deleteMessage,
    rerunMessage,
  };
}
