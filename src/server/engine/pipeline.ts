import { and, desc, eq, sql } from "drizzle-orm";
import { streamText, type ModelMessage } from "ai";
import { z } from "zod";
import { matchActions } from "@/contracts/actions/registry";
import { diag, DiagnosticCollector, diagnosticSchema, type Diagnostic, type DiagnosticSink } from "@/contracts/diagnostics";
import type { ExposureMask } from "@/contracts/state/brief";
import { submitTurnBodySchema, type SubmitTurnBody, type TurnAuthor } from "@/contracts/turns/stream";
import { emptyIntentBrief, intentBriefSchema, type IntentBrief } from "@/contracts/turns/intent-brief";
import { daylightBand, formatElapsed, formatGameClock, resolveGameTime } from "@/lib/clock";
import { log } from "@/server/log";
import { parseOr, parseOrNull } from "@/lib/parse";
import { fillPlayerToken } from "@/lib/player-token";
import { isDemoMode, narrativeModelId, narrativeProviderOptions, openrouter, routedProvider, stripNarratorArtifactStream } from "../ai";
import type { TurnProvider } from "@/contracts/turns/agent-results";
import { db, facts, jobs, sessions, turnMessages, turns } from "../db";
import {
  characterAppearanceSummary,
  intimateSceneAppearance,
  composeSceneSpec,
  renderSceneImage,
  shouldGenerateScene,
  type SceneComposerContext,
  type ScenePresentCharacter,
} from "../images";
import { preTurnRetrieve, recentEpisodes, retractFactsFromTurn, deleteEpisodeForTurn, sessionScope } from "../memory";
import { runPostTurnAgents } from "./agents";
import { activeLocationId, bundlePlayerName, loadSessionBundle, type SessionBundle } from "./bundle";
import { EPISODE_WINDOW, FACTS_CAP, HEARTBEAT_INTERVAL_MS, MAX_CHAINED_ACTIONS, NARRATIVE_HISTORY_TURNS, OPEN_THREADS_IN_CONTEXT, TURN_READY_POLL_MS, TURN_READY_WAIT_MS } from "./constants";
import { demoNarrative } from "./demo";
import { detectCommsIntent, isOocInput, type SceneIntent } from "./intent";
import { runIntake, sceneIntentFromBrief } from "./intake";
import { enqueueJob, registerJobHandler, sessionBusy } from "./jobs";
import { applyTurnResults, stagedLocationAnchor } from "./merge";
import { narrationShapeId } from "./prompts/constants";
import { buildStaticRulebook, buildTurnContext, narrativeNotationNote } from "./prompts/narrative";
import { recoverAbandonedTurns } from "./recovery";
import {
  buildAbsenceNotice,
  buildAffordancesBlock,
  buildAwarenessBlocks,
  buildCanonicalFactsBlock,
  buildCommsLine,
  buildDispositionBlock,
  buildIntimateDispositionLine,
  buildDarknessLine,
  buildFollowGuidance,
  buildGlanceImpressions,
  buildMeterConditionBlock,
  buildPresenceRoster,
  buildPuppetDeflection,
  buildReactionLine,
  buildRelationshipBlock,
  buildResponseShape,
  buildSceneSnapshot,
  buildTurnDigest,
  buildWardrobeBlock,
  classifyPresenceChannels,
  evaluatePrimaryReaction,
  excerptBio,
  type CommsStaging,
  type ReactionLineInput,
} from "./scene";
import { createSegmenter, parseSegments } from "./segmenter";
import { exposedRegions, resolveWardrobeVisibility } from "@/contracts/items/visibility";
import { resolveAttributes } from "@/contracts/attributes/value";
import { NEUTRAL_MOOD_METER } from "@/contracts/meters/registry";
import { speciesLabelPhrase } from "@/contracts/species";

/**
 * The turn pipeline (docs/turn-engine.md §Lifecycle). Streaming is decoupled
 * from the consumer: the narrative task runs detached and pushes SSE events
 * into a channel — a client disconnect changes nothing server-side, narration
 * persists and the post_turn job runs regardless.
 */

export const NARRATIVE_TEMPERATURE = 0.85;
/** ~1500 tokens of always-tier lore in the static rulebook. */
const ALWAYS_LORE_CHAR_BUDGET = 6000;

export interface TurnStreamEvent {
  event: "start" | "chunk" | "status" | "done" | "error";
  data: Record<string, unknown>;
}

export interface SubmitTurnInput {
  sessionId: string;
  userId: string;
  body: SubmitTurnBody;
}

// ---------------------------------------------------------------------------
// Event channel: detached producer → at-most-one consumer
// ---------------------------------------------------------------------------

class EventChannel {
  private buffer: TurnStreamEvent[] = [];
  private resolvers: Array<(r: IteratorResult<TurnStreamEvent, undefined>) => void> = [];
  private closed = false;

  push(event: TurnStreamEvent): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: event, done: false });
    else this.buffer.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<TurnStreamEvent, undefined>> {
    const event = this.buffer.shift();
    if (event) return { value: event, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}

function errEvent(code: string, message: string): TurnStreamEvent {
  return { event: "error", data: { code, message } };
}

// ---------------------------------------------------------------------------
// submitTurn
// ---------------------------------------------------------------------------

export async function* submitTurn(input: SubmitTurnInput): AsyncGenerator<TurnStreamEvent, void, unknown> {
  const body = parseOrNull(submitTurnBodySchema, input.body);
  if (!body) {
    yield errEvent("invalid_input", "turn input failed validation");
    return;
  }

  try {
    await recoverAbandonedTurns(input.sessionId);
  } catch (err) {
    log.warn("pipeline", "recovery before submit failed", { error: errorText(err) });
  }

  const [session] = await db().select().from(sessions).where(eq(sessions.id, input.sessionId)).limit(1);
  if (!session || session.ownerId !== input.userId) {
    yield errEvent("not_found", "session not found");
    return;
  }

  // CAS ready → narrating. The lock lingers through the previous turn's post-turn
  // "processing" window (~8–10s after its `done` — UX-audit M3), so rather than
  // 409 a back-to-back / API-driven turn outright, wait that window out and retry
  // the CAS. An actively "narrating" turn is never waited on — that's the caller's
  // own race and fails fast. The route turns the final error event into a 409.
  const deadline = Date.now() + TURN_READY_WAIT_MS;
  for (;;) {
    const cas = await db()
      .update(sessions)
      .set({ status: "narrating" })
      .where(and(eq(sessions.id, input.sessionId), eq(sessions.status, "ready")))
      .returning({ id: sessions.id });
    if (cas.length > 0) break;
    const [current] = await db()
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1);
    if (current?.status !== "processing" || Date.now() >= deadline) {
      yield errEvent(
        "session_busy",
        current?.status === "processing"
          ? 'the session is still finishing the previous turn; wait for status to return to "ready", then retry'
          : "a turn is already in progress for this session",
      );
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, TURN_READY_POLL_MS));
  }

  const channel = new EventChannel();
  void runNarrationTask(input.sessionId, body, channel).catch((err) => {
    // runNarrationTask handles its own failures; this is a last resort.
    log.error("pipeline", "narration task crashed", { sessionId: input.sessionId, error: errorText(err) });
    channel.push(errEvent("turn_failed", "the turn failed unexpectedly"));
    channel.close();
  });

  for (;;) {
    const result = await channel.next();
    if (result.done) return;
    yield result.value;
  }
}

/**
 * The detached narrative task: everything from turn-row creation through the
 * post_turn enqueue. Independent of the SSE consumer by design.
 */
async function runNarrationTask(sessionId: string, body: SubmitTurnBody, channel: EventChannel): Promise<void> {
  const sink = new DiagnosticCollector();
  let turnId: string | null = null;
  try {
    const bundle = await loadSessionBundle(sessionId, sink);
    if (!bundle) throw new Error("session vanished while starting the turn");

    const speaker =
      body.author === "companion" && body.speakerParticipantId
        ? (bundle.participants.find((p) => p.id === body.speakerParticipantId && !p.isUser) ?? null)
        : null;
    if (body.author === "companion" && body.speakerParticipantId && !speaker) {
      sink.push(diag("warn", "turn.speaker_invalid", "speakerParticipantId did not match a non-player participant"));
    }

    const [agg] = await db()
      .select({ max: sql<number | null>`max(${turns.number})` })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    const turnNumber = (agg?.max ?? 0) + 1;

    const [turnRow] = await db()
      .insert(turns)
      .values({
        sessionId,
        number: turnNumber,
        author: body.author,
        speakerParticipantId: speaker?.id ?? null,
        input: body.input,
        status: "narrating",
        heartbeatAt: new Date(),
        model: isDemoMode() ? "demo" : narrativeModelId(bundle.world.narrativeModel),
      })
      .returning({ id: turns.id });
    if (!turnRow) throw new Error("turn insert returned no row");
    turnId = turnRow.id;

    channel.push({ event: "start", data: { turnId, turnNumber } });

    const pre = await assemblePreTurn(bundle, body, speaker?.displayName, sink, turnNumber);
    const live = isDemoMode()
      ? null
      : liveNarrativeStream(narrativeModelId(bundle.world.narrativeModel), pre.system, pre.messages);
    // Strip the Aion "uncensored response" wrapper tags that leak into narration
    // (server/ai/narrator-artifacts.ts) before the segmenter and `narration`
    // accumulator see them — keeps the artifact out of both the live feed and the
    // persisted `turns.narration` (which is fed back as history). Demo output has
    // no tags, but wrapping it too keeps one path.
    const stream = stripNarratorArtifactStream(live ? live.textStream : demoNarrative(body.input, pre.npcNames));

    const segmenter = createSegmenter(pre.allNpcNames);
    let narration = "";
    let lastBeat = Date.now();
    let streamError: string | null = null;
    let heartbeatFailed = false;
    try {
      for await (const chunk of stream) {
        narration += chunk;
        for (const event of segmenter.push(chunk)) channel.push({ event: "chunk", data: event });
        if (Date.now() - lastBeat >= HEARTBEAT_INTERVAL_MS) {
          lastBeat = Date.now();
          void beatTurn(turnId).then((ok) => {
            // One diagnostic per turn: a silently stale heartbeat can get a
            // live stream failed by recovery, so the failure must be visible.
            if (!ok && !heartbeatFailed) {
              heartbeatFailed = true;
              sink.push(
                diag("warn", "turn.heartbeat_failed", "heartbeat refresh failed while streaming; recovery may see this turn as stale"),
              );
            }
          });
        }
      }
      for (const event of segmenter.finish()) channel.push({ event: "chunk", data: event });
    } catch (err) {
      streamError = errorText(err);
      sink.push(diag("error", "turn.narrative_failed", `narrative stream failed: ${streamError.slice(0, 500)}`));
    }

    if (streamError && !narration.trim()) {
      await failTurn(turnId, sink);
      await unwedgeSession(sessionId, "narrating");
      channel.push(errEvent("narrative_failed", "the narrative model failed before producing any text"));
      return;
    }

    // Best-effort narrator provider attribution for the Inspector — resolved
    // only when the stream completed cleanly (a broken stream's metadata may
    // never settle). The post-turn agents add their own entries in the merge.
    const narratorProvider = live && !streamError ? await live.provider() : null;

    // Persist regardless of the consumer (the doc's "finally"): narration,
    // messages, processing status, then hand off to the post_turn job.
    await persistNarration(turnId, body, speaker?.displayName ?? null, narration, pre.allNpcNames, pre.intentBrief, sink, narratorProvider);
    if (pre.ooc) {
      // OOC exchange: a meta answer has no world impact — no agents, no clock
      // advance, no episode. The turn completes as soon as the answer persists.
      await db().update(turns).set({ status: "ready" }).where(eq(turns.id, turnId));
      await unwedgeSession(sessionId, "narrating");
      channel.push({ event: "done", data: { turnId } });
      return;
    }
    await db()
      .update(sessions)
      .set({ status: "processing" })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "narrating")));
    channel.push({ event: "status", data: { phase: "processing" } });
    await enqueueJob({ sessionId, type: "post_turn", payload: { turnId } });
    channel.push({ event: "done", data: { turnId } });
  } catch (err) {
    sink.push(diag("error", "turn.failed", errorText(err).slice(0, 500)));
    if (turnId) await failTurn(turnId, sink).catch(() => undefined);
    await unwedgeSession(sessionId, "narrating").catch(() => undefined);
    channel.push(errEvent("turn_failed", "the turn failed unexpectedly"));
  } finally {
    channel.close();
  }
}

interface LiveNarrativeStream {
  textStream: AsyncIterable<string>;
  /**
   * Provider attribution for the narrator, resolved once the stream is fully
   * consumed (`providerMetadata` settles at stream end). Best-effort — returns
   * null if the metadata never arrives. `ms` is the whole-stream latency, so
   * read it as throughput-ish, not time-to-first-token.
   */
  provider: () => Promise<TurnProvider | null>;
}

function liveNarrativeStream(modelId: string, system: string, messages: ModelMessage[]): LiveNarrativeStream {
  const startedAt = Date.now();
  const result = streamText({
    model: openrouter().chat(modelId),
    system,
    messages,
    temperature: NARRATIVE_TEMPERATURE,
    // Prefer the lowest-latency provider endpoint for the model (same weights) so
    // narration's first token arrives sooner — OpenRouter routing variance is the
    // dominant cost (pre-narrator-agents.followups.md §2d). For a long stream this
    // optimises time-to-first-token; switch to sort:"throughput" if sustained
    // tokens/sec matters more than first-token latency. narrativeProviderOptions
    // also drops per-model bad endpoints (DeepInfra on GLM 5.2) and applies the
    // eval-ruled per-model reasoning knob (Aion/GLM effort:low).
    providerOptions: narrativeProviderOptions(modelId, { sortLatency: true }),
  });
  return {
    textStream: result.textStream,
    provider: async () => {
      try {
        const meta = await result.providerMetadata;
        return { provider: routedProvider(meta), ms: Date.now() - startedAt };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Refresh a turn's liveness heartbeat. Best-effort — the stream never fails
 * over a missed beat — but never silent (docs/resilience.md §8): a stale
 * heartbeat is exactly what recovery uses to fail a turn, so a write failure
 * here must be visible post-mortem. Returns false on failure so the caller
 * can record a turn-scoped diagnostic.
 */
async function beatTurn(turnId: string): Promise<boolean> {
  try {
    await db().update(turns).set({ heartbeatAt: new Date() }).where(eq(turns.id, turnId));
    return true;
  } catch (err) {
    log.warn("pipeline", "turn heartbeat refresh failed", { turnId, error: errorText(err) });
    return false;
  }
}

async function failTurn(turnId: string, sink: DiagnosticCollector): Promise<void> {
  await db()
    .update(turns)
    .set({ status: "failed", diagnostics: sql`${turns.diagnostics} || ${JSON.stringify(sink.items)}::jsonb` })
    .where(eq(turns.id, turnId));
}

/** A failed turn returns its session to ready — failure never wedges play. */
async function unwedgeSession(sessionId: string, from: "narrating" | "processing"): Promise<void> {
  await db()
    .update(sessions)
    .set({ status: "ready" })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, from)));
}

/** Turn messages: seq 0 is the input (role by author), then narration segments. */
export function messagesFromNarration(
  body: { input: string; author: TurnAuthor },
  speakerName: string | null,
  narration: string,
  npcNames: string[],
): Array<{ seq: number; role: "player" | "narrator" | "character" | "system"; speaker: string | null; content: string }> {
  const inputRole = body.author === "player" ? "player" : body.author === "companion" ? "character" : "system";
  const rows: Array<{ seq: number; role: "player" | "narrator" | "character" | "system"; speaker: string | null; content: string }> = [
    { seq: 0, role: inputRole, speaker: body.author === "companion" ? speakerName : null, content: body.input },
  ];
  let seq = 1;
  for (const segment of parseSegments(narration, npcNames)) {
    if (!segment.content.trim()) continue;
    rows.push({
      seq: seq++,
      role: segment.speaker ? "character" : "narrator",
      speaker: segment.speaker,
      content: segment.content,
    });
  }
  return rows;
}

async function persistNarration(
  turnId: string,
  body: SubmitTurnBody,
  speakerName: string | null,
  narration: string,
  npcNames: string[],
  intentBrief: IntentBrief,
  sink: DiagnosticCollector,
  narratorProvider: TurnProvider | null,
): Promise<void> {
  const rows = messagesFromNarration(body, speakerName, narration, npcNames);
  await db()
    .insert(turnMessages)
    .values(rows.map((r) => ({ turnId, seq: r.seq, role: r.role, speaker: r.speaker, content: r.content })));
  await db()
    .update(turns)
    .set({
      narration,
      intentBrief,
      status: "processing",
      heartbeatAt: new Date(),
      diagnostics: sql`${turns.diagnostics} || ${JSON.stringify(sink.items)}::jsonb`,
      // Seed the providers map with the narrator leg; the post-turn merge concats
      // the agent legs onto it (jsonb `||`), so this write must not be clobbered.
      ...(narratorProvider ? { providers: { narrator: narratorProvider } } : {}),
    })
    .where(eq(turns.id, turnId));
}

// ---------------------------------------------------------------------------
// Pre-turn assembly (docs/turn-engine.md steps 3–4)
// ---------------------------------------------------------------------------

const EXPOSURE_APPEARANCE_ORDER = ["ambient", "close", "intimate"] as const;
const EXPOSURE_SCENT_ORDER = ["none", "ambient", "close", "intimate"] as const;
const EXPOSURE_TOUCH_ORDER = ["none", "close", "intimate"] as const;
const EXPOSURE_TASTE_ORDER = ["none", "close", "intimate"] as const;

function atLeast<T extends string>(order: readonly T[], current: T, floor: T): T {
  return order.indexOf(current) >= order.indexOf(floor) ? current : floor;
}

/**
 * Intent raises the relevant sense for one turn (docs/prompts.md §Exposure gating).
 * A taste intent (kiss / lick / mouth) raises both taste **and** touch — tasting
 * a target is also contact (Decision 5: a kiss earns touch + taste at `close`).
 */
export function raiseExposureForIntent(mask: ExposureMask, intent: SceneIntent): ExposureMask {
  const tasting = Boolean(intent.tasteTarget);
  return {
    appearance: intent.lookTarget ? atLeast(EXPOSURE_APPEARANCE_ORDER, mask.appearance, "close") : mask.appearance,
    scent: intent.smellTarget ? atLeast(EXPOSURE_SCENT_ORDER, mask.scent, "close") : mask.scent,
    touch: intent.touchTarget || tasting ? atLeast(EXPOSURE_TOUCH_ORDER, mask.touch, "close") : mask.touch,
    taste: tasting ? atLeast(EXPOSURE_TASTE_ORDER, mask.taste, "close") : mask.taste,
  };
}

/** Trim always-tier lore bodies to the rulebook budget, preserving sort order. */
export function trimLoreBudget(bodies: readonly string[], budget = ALWAYS_LORE_CHAR_BUDGET): string[] {
  const out: string[] = [];
  let used = 0;
  for (const body of bodies) {
    if (used + body.length > budget && out.length > 0) break;
    out.push(body.length > budget ? `${body.slice(0, budget - 1)}…` : body);
    used += body.length;
  }
  return out;
}

interface PreTurnAssembly {
  system: string;
  messages: ModelMessage[];
  /** Present NPCs — the prompt's dialogue-tag vocabulary. */
  npcNames: string[];
  /** Every session NPC — the parser's vocabulary. The model is told to tag
   * only present NPCs, but a tag for any known character must still parse
   * instead of leaking literal brackets into prose (liberal in what we accept). */
  allNpcNames: string[];
  /** Out-of-character question: the answer has no world impact (no post-turn). */
  ooc: boolean;
  /** Pre-narrator intake output — persisted on the turn, reused by the continuity audit. */
  intentBrief: IntentBrief;
}

async function assemblePreTurn(
  bundle: SessionBundle,
  body: SubmitTurnBody,
  speakerName: string | undefined,
  sink: DiagnosticSink,
  turnNumber?: number,
): Promise<PreTurnAssembly> {
  const activeLoc = activeLocationId(bundle);
  const activePlace = bundle.locations.find((l) => l.id === activeLoc) ?? null;
  const present = bundle.participants.filter((p) => p.locationId !== null && p.locationId === activeLoc);
  const presentNpcs = present.filter((p) => !p.isUser);
  const npcNames = presentNpcs.map((p) => p.displayName);
  const player = bundle.participants.find((p) => p.isUser);

  const presentIds = new Set(present.map((p) => p.id));
  const inScopeItemNames = bundle.items
    .filter(
      (i) =>
        (i.locationId !== null && i.locationId === activeLoc) ||
        (i.holderParticipantId !== null && presentIds.has(i.holderParticipantId)),
    )
    .map((i) => i.name);

  // OOC input is a question to the game, not an in-world action: no physical
  // intents (an OOC "can I go to the beach?" must not stage a movement). The
  // scene intent now comes from the intake agent (run in the fan-out below),
  // which returns an empty brief for OOC / non-player turns.
  const ooc = body.author === "player" && isOocInput(body.input);

  // Comms staging (presence-spec §comms): "I call/text X" against ANY session
  // NPC (the target is usually absent) stages that NPC as comms-present THIS
  // turn so the narrator may voice them over the line. The simulant persists
  // the link post-turn; here we only stage + display. A target who is already
  // sight-present (co-located) is not staged — they are right there to talk to.
  const sessionNpcs = bundle.participants.filter((p) => !p.isUser);
  const commsStaging: CommsStaging[] = [];
  if (!ooc && body.author === "player") {
    const commsIntent = detectCommsIntent(body.input, sessionNpcs.map((p) => p.displayName));
    if (commsIntent) {
      const target = sessionNpcs.find((p) => p.displayName.toLowerCase() === commsIntent.targetName.toLowerCase());
      const alreadyLinked = target ? bundle.runtime.commsLinks.some((c) => c.withParticipantId === target.id) : false;
      if (target && target.locationId !== activeLoc && !alreadyLinked) {
        commsStaging.push({ participantId: target.id, kind: commsIntent.kind });
      }
    }
  }

  // Chain cap (docs/developer-notes/time-and-travel-spec.phase3.md §Action durations):
  // when the input stacks several timed activities, the narrator ends the beat
  // after the cap instead of compressing a whole evening into one turn.
  const chainedActions = !ooc && body.author === "player" ? matchActions(body.input) : [];
  const pacingGuidance =
    chainedActions.length >= MAX_CHAINED_ACTIONS
      ? [
          "## Pacing",
          `The player's input chains several time-consuming activities (${chainedActions.map((a) => a.label.toLowerCase()).join(", ")}).`,
          `Narrate at most the first ${MAX_CHAINED_ACTIONS}, then end the beat there — time passes, the rest stays for the next turn. Do not summarize the remaining activities as already done.`,
        ].join("\n")
      : undefined;

  // The intake agent (pre-narrator) runs in the fan-out, concurrent with
  // retrieval, so its latency hides behind the network-bound retrieval window.
  // Empty brief for OOC / non-player turns; degrades to the regex on timeout.
  const intakeLeg: Promise<IntentBrief> =
    ooc || body.author !== "player"
      ? Promise.resolve(emptyIntentBrief())
      : runIntake({
          playerInput: body.input,
          presentNpcNames: npcNames,
          otherNpcNames: bundle.participants
            .filter((p) => !p.isUser && p.locationId !== activeLoc)
            .map((p) => p.displayName),
          itemNames: inScopeItemNames,
          currentLocationName: activePlace?.name ?? null,
          locationNames: bundle.locations.map((l) => l.name),
          agentModel: bundle.world.agentModel,
          sink,
        });

  // Pre-turn parallel fan-out: retrieval legs + recent context + intake.
  const [retrieval, history, episodeWindow, relationshipFacts, intentBrief] = await Promise.all([
    preTurnRetrieve({
      session: { id: bundle.session.id },
      world: { id: bundle.world.id },
      queries: bundle.brief.memoryQueries,
      input: body.input,
      sceneCtx: {
        locationTags: activePlace ? [activePlace.name] : [],
        presentCharacterIds: present.flatMap((p) => (p.characterId ? [p.characterId] : [])),
      },
      unlockedIds: bundle.runtime.unlockedLoreIds,
      sink,
    }),
    recentTurnHistory(bundle.session.id, NARRATIVE_HISTORY_TURNS),
    recentEpisodes(sessionScope(bundle.session.id), EPISODE_WINDOW, sink),
    activeRelationshipFacts(bundle.session.id),
    intakeLeg,
  ]);

  // The scene-intent view the prompt builders consume (exposure / glance /
  // awareness) — a lossless projection of the intake brief's target fields.
  const intent = sceneIntentFromBrief(intentBrief);

  // Movement intent: when the player heads into an adjacent room, the prompt
  // establishes the target and surfaces follow guidance (state moves post-turn).
  // NPC → player feeling stages (sparse; absent edge = stranger).
  const affinityStages: Record<string, string> = {};
  if (player) {
    for (const npc of presentNpcs) {
      const edge = bundle.relationships.find(
        (r) => r.kind === "feeling" && r.fromParticipantId === npc.id && r.toParticipantId === player.id,
      );
      if (edge) affinityStages[npc.displayName] = edge.stage;
    }
  }

  let promptLocationId = activeLoc;
  let forceFull = false;
  let followGuidance: string | undefined;
  // One shared staging rule with the post-turn continuity audit
  // (merge.stagedLocationAnchor — access check included): drift between the
  // two makes the auditor flag characters the narrator was rightly told are
  // Present (followups.phase2.md #13).
  const anchor = stagedLocationAnchor(bundle, body.input, body.author);
  if (anchor.blocked) {
    followGuidance = [
      `## Movement guidance (player attempting: ${activePlace?.name ?? "here"} → ${anchor.blocked.target.name})`,
      `The way is not passable right now — ${anchor.blocked.reason}.`,
      "Narrate the blocked attempt at the threshold; do not move anyone there and do not describe the far side.",
    ].join("\n");
  } else if (anchor.staged) {
    const target = anchor.staged;
    promptLocationId = target.id;
    forceFull = !bundle.runtime.visitedLocationIds.includes(target.id);
    const turnsSinceInteraction: Record<string, number> = {};
    if (turnNumber !== undefined) {
      for (const npc of presentNpcs) {
        const last = bundle.runtime.lastInteractedTurn[npc.id];
        if (last !== undefined) turnsSinceInteraction[npc.displayName] = Math.max(0, turnNumber - last);
      }
    }
    followGuidance = buildFollowGuidance({
      playerInput: body.input,
      fromLocationName: activePlace?.name ?? "here",
      toLocationName: target.name,
      npcs: presentNpcs.map((p) => ({ displayName: p.displayName, coLocated: true, activity: p.state.activity })),
      relationshipFacts,
      turnsSinceInteraction,
      affinityStages,
    });
  }

  // Addressing someone who isn't in the room: the narrator gets an explicit
  // absence block (don't stage them; tease a direct address) instead of
  // hallucinating the conversation.
  const locationNameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
  const absenceNotice =
    !ooc && body.author === "player"
      ? buildAbsenceNotice({
          playerInput: body.input,
          playerName: player?.displayName ?? "you",
          absentNpcs: bundle.participants
            .filter((p) => !p.isUser && p.locationId !== activeLoc)
            .map((p) => ({
              displayName: p.displayName,
              locationName: p.locationId ? (locationNameById.get(p.locationId) ?? null) : null,
            })),
        })
      : "";

  const exposure = raiseExposureForIntent(bundle.brief.exposure, intent);
  const includeSensory =
    exposure.appearance !== "ambient" ||
    exposure.scent === "close" ||
    exposure.scent === "intimate" ||
    exposure.taste === "close" ||
    exposure.taste === "intimate";

  const alwaysLore = trimLoreBudget(
    bundle.loreChunks
      .filter((c) => c.tier === "always" && isUnlocked(c, bundle.runtime.unlockedLoreIds))
      .sort((a, b) => a.sort - b.sort)
      .map((c) => c.body),
  );
  const sceneLore = [
    ...bundle.loreChunks
      .filter((c) => c.tier === "scene" && isUnlocked(c, bundle.runtime.unlockedLoreIds) && sceneChunkMatches(c, activePlace?.name, present))
      .sort((a, b) => a.sort - b.sort)
      .map((c) => c.body),
    // Retrieval-tier hits are authored text read straight from the DB (not the
    // bundle), so the {{player}} fill happens here, at their one prompt entry.
    ...retrieval.loreHits.map((h) => fillPlayerToken(`${h.title}: ${h.body}`, bundlePlayerName(bundle))),
  ];

  // One curated facts channel: retrieved facts + director notes + recalled
  // episodes, deduped, capped at FACTS_CAP (docs/memory.md §Semantic facts 4).
  const factsChannel = dedupeStrings([
    ...retrieval.factHits,
    ...bundle.brief.characterNotes,
    ...retrieval.episodeHits.map((e) => `Recalled: ${e}`),
  ]).slice(0, FACTS_CAP);

  // The tag vocabulary is EVERY session NPC, not just the present ones: a
  // Nearby character who arrives mid-turn must be taggable so their dialogue
  // segments into speaker bubbles instead of plain prose, and a session-stable
  // list keeps the rulebook bytes identical across moves (prefix caching).
  // WHO may actually speak is gated by the Presence fidelity rules + roster.
  const allNpcNames = bundle.participants.filter((p) => !p.isUser).map((p) => p.displayName);
  const system = buildStaticRulebook({
    worldName: bundle.world.name,
    synopsis: bundle.lore.synopsis,
    styleDirectives: bundle.style.directives,
    narratorGuidance: bundle.style.narratorGuidance,
    alwaysLore,
    factions: bundle.lore.factions.map((f) => ({ name: f.name, description: f.description })),
    canonicalFactsBlock: buildCanonicalFactsBlock(bundle),
    dispositionBlock: buildDispositionBlock(bundle),
    npcNames: allNpcNames,
    embodied: bundle.session.embodied,
    playerContext: bundle.session.embodied && player ? excerptBio(player.snapshot.bio) || undefined : undefined,
    narrationShape: narrationShapeId("session"),
  });

  const gameTime = resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart);
  const lastMinutes = history.at(-1)?.minutes ?? 0;

  // Presence channels anchored on the room being narrated (promptLocationId),
  // like the roster/snapshot: sight = co-located & perceivable; comms = an
  // active link or this-turn staging; else absent. Drives the channel-aware
  // roster + glance impressions, and which absent NPCs may be voiced by phone.
  const channels = classifyPresenceChannels(bundle, promptLocationId, commsStaging);
  const commsPresentNames = sessionNpcs.filter((p) => channels.get(p.id) === "comms").map((p) => p.displayName);
  // Comms-present NPCs join the present speaker list so their down-the-line
  // dialogue segments into speaker bubbles even though their body is elsewhere.
  const speakerNpcNames = dedupeStrings([...npcNames, ...commsPresentNames]);

  // Darkness: turn-start clock; an info diagnostic when the light text was
  // ambiguous so the keyword lists can be tuned (optional, per the task).
  const darkness = buildDarknessLine(bundle, promptLocationId, gameTime);
  if (darkness.miss) {
    sink.push(diag("info", "pipeline.perception.darkness_miss", "night ambient light matched no keyword; defaulting dark"));
  }

  // Present NPCs with their authored disposition — shared by the reaction line and
  // the puppet-deflection guardrail (both resolve a classified intent against it).
  const dispositionNpcs = presentNpcs.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    tags: p.snapshot.tags,
    preferences: p.snapshot.preferences,
    traits: p.snapshot.traits,
    socialCards: p.snapshot.socialCards,
    mood: p.state.meters.mood ?? NEUTRAL_MOOD_METER,
  }));

  // The primary social-act verdict, evaluated ONCE and shared by the Reaction line
  // and the response-shape reaction-scale line so the two can never disagree
  // (narrator-prompt-focus.plan.md §Phase 2).
  const reactionInput: ReactionLineInput | null = player
    ? {
        playerId: player.id,
        playerName: player.displayName,
        socialActs: intentBrief.socialActs,
        presentNpcs: dispositionNpcs,
        relationships: bundle.relationships,
        worldCards: bundle.style.socialCards,
      }
    : null;
  const primaryReaction = reactionInput ? evaluatePrimaryReaction(reactionInput) : null;

  // Open threads surfaced to the narrator this turn — hoisted so the count gates the
  // response shape's "new topic allowed?" steer and the same list renders below.
  const openThreads = bundle.runtime.storyThreads
    .filter((t) => t.status === "open")
    .sort((a, b) => b.lastTouchedTurn - a.lastTouchedTurn)
    .slice(0, OPEN_THREADS_IN_CONTEXT)
    .map((t) => ({ title: t.title, summary: t.summary }));

  const turnContext = buildTurnContext({
    clockLine: formatGameClock(gameTime),
    elapsedLine: lastMinutes > 0 ? `${formatElapsed(lastMinutes)} since the previous turn` : undefined,
    // Binding per-turn allowances digest, first thing the narrator reads —
    // same anchor as the roster, plus the blocked threshold when staging
    // refused a move (pure restatement of the blocks below it).
    turnDigest: buildTurnDigest(
      bundle,
      promptLocationId,
      anchor.blocked ? { targetName: anchor.blocked.target.name, reason: anchor.blocked.reason } : null,
    ),
    // Derived focus / reaction-scale / speaker-focus steers — a restatement-only
    // sibling of the digest, rendered right after it (narrator-prompt-focus §Phase 2).
    // Only for in-character player turns: OOC / director / companion turns carry an
    // empty brief (like intake), so the derived shape would be noise there — and it
    // must stay consistent with the Reaction line, which is also silent on them.
    responseShape:
      !ooc && body.author === "player"
        ? buildResponseShape({
            actionType: intentBrief.actionType,
            addressedNpcs: intentBrief.addressedNpcs,
            presentNpcNames: npcNames,
            primaryReaction,
            openThreadCount: openThreads.length,
            directiveCount: bundle.brief.directives.length,
            // Phase-3 planner: richer steers when intake emitted it; undefined on the
            // regex/degrade path ⇒ buildResponseShape uses its Phase-2 derivation.
            focus: intentBrief.focus,
          })
        : "",
    sceneSnapshot: buildSceneSnapshot(bundle, promptLocationId, { forceFull }),
    // Anchored on promptLocationId, like the snapshot/affordances: on a staged
    // move the roster must describe the room being narrated (its occupants are
    // Present; the room being left becomes Nearby — followers arrive, per the
    // Presence fidelity rules).
    presenceRoster: buildPresenceRoster(bundle, promptLocationId, channels),
    commsBlock: buildCommsLine(bundle, commsStaging),
    wardrobeBlock: buildWardrobeBlock(bundle, { includeSensory }),
    stateBlock: [
      buildMeterConditionBlock(bundle),
      player
        ? buildRelationshipBlock({
            playerId: player.id,
            playerName: player.displayName,
            presentNpcs: presentNpcs.map((p) => ({ id: p.id, displayName: p.displayName })),
            relationships: bundle.relationships,
          })
        : "",
      reactionInput ? buildReactionLine(reactionInput, primaryReaction) : "",
      player
        ? buildPuppetDeflection({
            narratedNpcBehaviors: intentBrief.narratedNpcBehaviors,
            presentNpcs: dispositionNpcs,
            sink,
          })
        : "",
      // Intimate trait bands, surfaced only when this turn's exposure earns it (volatile).
      buildIntimateDispositionLine(dispositionNpcs, exposure),
    ]
      .filter(Boolean)
      .join("\n\n"),
    glanceBlock: buildGlanceImpressions(bundle, intent, channels, exposure),
    awarenessBlock: buildAwarenessBlocks(bundle, promptLocationId, intent, gameTime, body.input),
    darknessLine: darkness.line,
    affordancesBlock: buildAffordancesBlock(bundle, promptLocationId),
    followGuidance,
    absenceNotice,
    pacingGuidance,
    facts: factsChannel,
    episodeSummaries: episodeWindow.map((e) => e.summary),
    sceneLore,
    // characterNotes already folded into the facts channel — one list, not three.
    brief: { ...bundle.brief, characterNotes: [] },
    openThreads,
    exposure,
    playerInput: body.input,
    author: body.author,
    speakerName,
    ooc,
    // Derived-fact notation note (player-input-perception.plan.md slice 7): the shared
    // span parser reads the current input's markup and renders a comms/OOC one-liner.
    // Player non-OOC turns only (a director/companion turn or an OOC question carries no
    // player persona texting anyone). knownNames is every session NPC — a text may go to
    // someone elsewhere. The raw input is never touched; this only feeds the prompt tail.
    notationNote:
      !ooc && body.author === "player"
        ? narrativeNotationNote(body.input, { playerName: player?.displayName, knownNames: allNpcNames })
        : "",
  });

  const messages: ModelMessage[] = [];
  for (const turn of history) {
    messages.push({ role: "user", content: turn.input });
    messages.push({ role: "assistant", content: turn.narration });
  }
  messages.push({ role: "user", content: turnContext });

  // The present-speaker vocabulary includes comms-present NPCs (they speak down
  // the line); the segmenter vocabulary (allNpcNames) is every session NPC.
  return { system, messages, npcNames: speakerNpcNames, allNpcNames, ooc, intentBrief };
}

function isUnlocked(chunk: { visibility: "public" | "secret"; manuallyUnlocked: boolean; id: string }, unlockedIds: readonly string[]): boolean {
  return chunk.visibility === "public" || chunk.manuallyUnlocked || unlockedIds.includes(chunk.id);
}

function sceneChunkMatches(
  chunk: { locationTags: string[]; characterIds: string[] },
  activeLocationName: string | undefined,
  present: ReadonlyArray<{ characterId: string | null }>,
): boolean {
  if (chunk.locationTags.length === 0 && chunk.characterIds.length === 0) return true;
  if (activeLocationName && chunk.locationTags.includes(activeLocationName.toLowerCase())) return true;
  return chunk.characterIds.some((id) => present.some((p) => p.characterId === id));
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

async function recentTurnHistory(
  sessionId: string,
  count: number,
): Promise<Array<{ input: string; narration: string; minutes: number }>> {
  const rows = await db()
    .select({ input: turns.input, narration: turns.narration, minutes: turns.minutes })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "ready")))
    .orderBy(desc(turns.number))
    .limit(count);
  return rows
    .reverse()
    .flatMap((row) => (row.narration ? [{ input: row.input, narration: row.narration, minutes: row.minutes }] : []));
}

async function activeRelationshipFacts(sessionId: string): Promise<Array<{ subjectName: string; text: string }>> {
  return db()
    .select({ subjectName: facts.subjectName, text: facts.text })
    .from(facts)
    .where(and(eq(facts.sessionId, sessionId), eq(facts.status, "active"), eq(facts.kind, "relationship")))
    .orderBy(desc(facts.createdAt))
    .limit(20);
}

// ---------------------------------------------------------------------------
// Job handlers (post_turn · reconcile · scene_image)
// ---------------------------------------------------------------------------

const turnJobPayloadSchema = z.object({ turnId: z.string().min(1) });
const sceneJobPayloadSchema = z.object({ turnId: z.string().optional(), turnNumber: z.number().int().optional() });

registerJobHandler("post_turn", async (job) => {
  const payload = parseOrNull(turnJobPayloadSchema, job.payload);
  if (!payload) throw new Error("post_turn job missing turnId");
  const [turn] = await db().select().from(turns).where(eq(turns.id, payload.turnId)).limit(1);
  if (!turn) return;
  if (turn.status !== "processing") return; // idempotent: already merged or failed

  const sink = new DiagnosticCollector();
  try {
    const bundle = await loadSessionBundle(turn.sessionId, sink);
    if (!bundle) throw new Error("session vanished before the merge");
    const narration = turn.narration ?? "";
    const { results, providers } = await runPostTurnAgents(
      bundle,
      {
        number: turn.number,
        author: turn.author,
        input: turn.input,
        // Trust boundary: the persisted brief is jsonb — parseOr to the empty
        // brief so a malformed/absent value degrades to the regex path in the agent.
        intentBrief: parseOr(intentBriefSchema, turn.intentBrief, emptyIntentBrief()),
      },
      narration,
      { sink },
    );
    await applyTurnResults({
      bundle,
      turn: {
        id: turn.id,
        number: turn.number,
        author: turn.author,
        input: turn.input,
        narration,
        speakerParticipantId: turn.speakerParticipantId,
        // The persisted brief's socialActs drive the deterministic reaction affinity (§6).
        intentBrief: parseOr(intentBriefSchema, turn.intentBrief, emptyIntentBrief()),
      },
      results,
      providers,
      sink,
    });

    const worthIt = results.director?.imageMoment?.worthIt ?? false;
    if (shouldGenerateScene(bundle.scene, turn.number, worthIt)) {
      await enqueueJob({
        sessionId: turn.sessionId,
        type: "scene_image",
        payload: { turnId: turn.id, turnNumber: turn.number },
      });
    }
  } catch (err) {
    // The turn fails, the session does not wedge (the job runner settles it).
    sink.push(diag("error", "post_turn.failed", errorText(err).slice(0, 500)));
    await db()
      .update(turns)
      .set({ status: "failed", diagnostics: sql`${turns.diagnostics} || ${JSON.stringify(sink.items)}::jsonb` })
      .where(and(eq(turns.id, turn.id), eq(turns.status, "processing")));
    throw err;
  }
});

registerJobHandler("reconcile", async (job) => {
  const payload = parseOrNull(turnJobPayloadSchema, job.payload);
  if (!payload) throw new Error("reconcile job missing turnId");
  const [turn] = await db().select().from(turns).where(eq(turns.id, payload.turnId)).limit(1);
  if (!turn || turn.status !== "ready") return;

  const sink = new DiagnosticCollector();
  const bundle = await loadSessionBundle(turn.sessionId, sink);
  if (!bundle) return;
  const narration = turn.narration ?? "";
  const { results, providers } = await runPostTurnAgents(
    bundle,
    { number: turn.number, author: turn.author, input: turn.input },
    narration,
    { sink, endState: true },
  );
  await applyTurnResults({
    bundle,
    turn: { id: turn.id, number: turn.number, author: turn.author, input: turn.input, narration, speakerParticipantId: turn.speakerParticipantId },
    results: { ...results, continuity: null, director: null },
    providers,
    sink,
    mode: "reconcile",
  });
});

/**
 * Composer input for a scene image (docs/images.md §Scene images). The
 * candidate subject pool is every NPC co-located with the player — camera
 * location from session state (activeLocationId), never prose — so an NPC in
 * another room can never reach the composer. The player is excluded entirely:
 * the image is their first-person POV, and their appearance/wardrobe never
 * enters any image prompt. Per NPC the wardrobe is occlusion-filtered
 * (resolveWardrobeVisibility — hidden layers omitted, sheer-covered items a
 * hint); lighting context is the session clock's daylight band.
 */
export function buildSceneComposerContext(
  bundle: Pick<SessionBundle, "participants" | "locations" | "items" | "brief" | "style" | "clockMinutes">,
  recentNarration: string[],
): SceneComposerContext {
  const povLocationId = activeLocationId(bundle);
  const location = bundle.locations.find((l) => l.id === povLocationId);
  const present: ScenePresentCharacter[] = bundle.participants
    .filter((p) => !p.isUser && p.locationId === povLocationId)
    .map((p) => {
      const worn = bundle.items.filter((i) => i.holderParticipantId === p.id && i.worn);
      const wornById = new Map(worn.map((i) => [i.id, i]));
      const wornInputs = worn.map((i) => ({
        instanceId: i.id,
        name: i.name,
        coverage: i.definition.coverage,
        layer: i.definition.layer ?? 1,
        opacity: i.definition.opacity,
      }));
      const views = resolveWardrobeVisibility(wornInputs);
      const exposure = exposedRegions(wornInputs);
      return {
        name: p.displayName,
        species: speciesLabelPhrase(p.snapshot.speciesId, p.snapshot.heritageId),
        activity: p.state.activity,
        posture: p.state.posture,
        wornVisible: views
          .filter((v) => v.visibility !== "hidden")
          .map((v) => {
            const def = wornById.get(v.instanceId)?.definition;
            return {
              name: v.name,
              visibility: v.visibility === "hinted" ? ("hinted" as const) : ("visible" as const),
              ...(def?.description ? { description: def.description } : {}),
              ...(def?.sensory.appearance ? { appearance: def.sensory.appearance } : {}),
            };
          }),
        exposure,
        // Session item state is authoritative for scene images. If a participant
        // has no worn clothing items, exposedRegions([]) is the explicit current
        // state and must override any clothed reference avatar.
        wardrobeTracked: true,
        appearance: characterAppearanceSummary(
          resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays),
          undefined,
          false,
          p.snapshot,
        ),
        intimateAppearance: intimateSceneAppearance(
          resolveAttributes(p.snapshot.attributes, p.state.attributeOverlays),
          exposure,
        ),
      };
    });
  return {
    present,
    locationName: location?.name,
    locationDescription: location?.description,
    ambient: [location?.ambient.scent, location?.ambient.sound, location?.ambient.light].filter(Boolean).join("; ") || undefined,
    timeOfDay: daylightBand(resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart)),
    sceneSummary: bundle.brief.sceneSummary,
    recentNarration,
  };
}

/** How many recent turns' narration feed the scene composer. */
const SCENE_RECENT_TURNS = 2;

registerJobHandler("scene_image", async (job) => {
  const payload = parseOr(sceneJobPayloadSchema, job.payload, {});
  if (!job.sessionId) return;
  const bundle = await loadSessionBundle(job.sessionId);
  if (!bundle) return;

  const setSceneState = async (patch: Record<string, unknown>) => {
    await db()
      .update(sessions)
      .set({ scene: { ...bundle.scene, ...patch } })
      .where(eq(sessions.id, bundle.session.id));
  };

  await setSceneState({ status: "generating" });
  try {
    const recentTurns = await db()
      .select({ narration: turns.narration, number: turns.number })
      .from(turns)
      .where(eq(turns.sessionId, bundle.session.id))
      .orderBy(desc(turns.number))
      .limit(SCENE_RECENT_TURNS);
    const newestTurnNumber = recentTurns[0]?.number;
    const recentNarration = recentTurns
      .map((t) => t.narration ?? "")
      .reverse() // oldest first
      .filter(Boolean);

    const plan = await composeSceneSpec(buildSceneComposerContext(bundle, recentNarration));
    // The scene's location reference uses the active location's library id (null
    // for an emergent session location, which has no library row to reference).
    const povLocation = bundle.locations.find((l) => l.id === activeLocationId(bundle));
    const location = povLocation?.locationId ? { id: povLocation.locationId, name: povLocation.name } : null;
    await renderSceneImage({
      session: { id: bundle.session.id, ownerId: bundle.session.ownerId },
      plan,
      userId: bundle.session.ownerId,
      location,
      mode: bundle.scene.referenceMode,
    });
    await setSceneState({ status: "idle", lastGeneratedTurn: payload.turnNumber ?? newestTurnNumber ?? 0 });
  } catch (err) {
    await setSceneState({ status: "failed" });
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Message actions: edit · delete · rerun · job status
// ---------------------------------------------------------------------------

export type ActionResult = { ok: true } | { ok: false; code: string; message: string };

async function loadOwnedMessage(sessionId: string, userId: string, messageId: string) {
  const [row] = await db()
    .select({
      messageId: turnMessages.id,
      seq: turnMessages.seq,
      role: turnMessages.role,
      turnId: turns.id,
      turnNumber: turns.number,
      turnAuthor: turns.author,
      turnInput: turns.input,
      speakerParticipantId: turns.speakerParticipantId,
      sessionOwnerId: sessions.ownerId,
      sessionStatus: sessions.status,
    })
    .from(turnMessages)
    .innerJoin(turns, eq(turnMessages.turnId, turns.id))
    .innerJoin(sessions, eq(turns.sessionId, sessions.id))
    .where(and(eq(turnMessages.id, messageId), eq(turns.sessionId, sessionId)))
    .limit(1);
  if (!row || row.sessionOwnerId !== userId) return null;
  return row;
}

/** Rebuild turns.narration from the narration-role messages (speaker tags restored). */
async function rebuildNarration(turnId: string): Promise<void> {
  const rows = await db()
    .select({ seq: turnMessages.seq, role: turnMessages.role, speaker: turnMessages.speaker, content: turnMessages.content })
    .from(turnMessages)
    .where(eq(turnMessages.turnId, turnId))
    .orderBy(turnMessages.seq);
  const narration = rows
    .filter((r) => r.seq > 0 && (r.role === "narrator" || r.role === "character"))
    .map((r) => (r.speaker ? `[${r.speaker}] ${r.content}` : r.content))
    .join("\n\n");
  await db().update(turns).set({ narration }).where(eq(turns.id, turnId));
}

/**
 * PATCH semantics (docs/turn-engine.md §Edit / rerun): update the message,
 * retract the turn's facts, queue a reconcile job. The session leaves `ready`
 * until the reconcile drains, so the next turn can never interleave with it.
 */
export async function editMessage(input: {
  sessionId: string;
  userId: string;
  messageId: string;
  content: string;
}): Promise<ActionResult> {
  const content = input.content.trim();
  if (!content) return { ok: false, code: "invalid_input", message: "content must not be empty" };
  const row = await loadOwnedMessage(input.sessionId, input.userId, input.messageId);
  if (!row) return { ok: false, code: "not_found", message: "message not found" };

  const cas = await db()
    .update(sessions)
    .set({ status: "processing" })
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.status, "ready")))
    .returning({ id: sessions.id });
  if (cas.length === 0) return { ok: false, code: "session_busy", message: "the session is busy" };

  await db().update(turnMessages).set({ content }).where(eq(turnMessages.id, row.messageId));
  if (row.seq === 0) {
    await db().update(turns).set({ input: content }).where(eq(turns.id, row.turnId));
  } else {
    await rebuildNarration(row.turnId);
  }
  await retractFactsFromTurn(row.turnId);
  await enqueueJob({ sessionId: input.sessionId, type: "reconcile", payload: { turnId: row.turnId } });
  return { ok: true };
}

/** Delete one message; an emptied turn is removed entirely (facts retracted, episode deleted). */
export async function deleteMessage(input: { sessionId: string; userId: string; messageId: string }): Promise<ActionResult> {
  const row = await loadOwnedMessage(input.sessionId, input.userId, input.messageId);
  if (!row) return { ok: false, code: "not_found", message: "message not found" };

  const cas = await db()
    .update(sessions)
    .set({ status: "processing" })
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.status, "ready")))
    .returning({ id: sessions.id });
  if (cas.length === 0) return { ok: false, code: "session_busy", message: "the session is busy" };

  try {
    await db().delete(turnMessages).where(eq(turnMessages.id, row.messageId));
    const [remaining] = await db()
      .select({ id: turnMessages.id })
      .from(turnMessages)
      .where(eq(turnMessages.turnId, row.turnId))
      .limit(1);
    if (!remaining) {
      await retractFactsFromTurn(row.turnId);
      await deleteEpisodeForTurn(sessionScope(input.sessionId), row.turnNumber);
      await db().delete(turns).where(eq(turns.id, row.turnId));
    } else if (row.seq > 0) {
      await rebuildNarration(row.turnId);
    }
    return { ok: true };
  } finally {
    await unwedgeSession(input.sessionId, "processing");
  }
}

/**
 * Rerun (docs/turn-engine.md §Edit / rerun): retract the turn's effects
 * (facts retracted, episode deleted — supersedence is NOT reversed), delete
 * the turn, then resubmit the same input through the normal pipeline.
 */
export async function* rerunTurn(input: {
  sessionId: string;
  userId: string;
  messageId: string;
}): AsyncGenerator<TurnStreamEvent, void, unknown> {
  const row = await loadOwnedMessage(input.sessionId, input.userId, input.messageId);
  if (!row) {
    yield errEvent("not_found", "message not found");
    return;
  }
  const [latest] = await db()
    .select({ id: turns.id })
    .from(turns)
    .where(eq(turns.sessionId, input.sessionId))
    .orderBy(desc(turns.number))
    .limit(1);
  if (!latest || latest.id !== row.turnId) {
    yield errEvent("not_latest", "only the latest turn can be rerun");
    return;
  }
  if (row.sessionStatus !== "ready") {
    yield errEvent("session_busy", "a turn is already in progress for this session");
    return;
  }

  await retractFactsFromTurn(row.turnId);
  await deleteEpisodeForTurn(sessionScope(input.sessionId), row.turnNumber);
  await db().delete(turns).where(eq(turns.id, row.turnId)); // cascades turn_messages

  yield* submitTurn({
    sessionId: input.sessionId,
    userId: input.userId,
    body: {
      input: row.turnInput,
      author: row.turnAuthor,
      speakerParticipantId: row.speakerParticipantId ?? undefined,
    },
  });
}

export interface SessionJobStatus {
  status: "ready" | "narrating" | "processing";
  jobType?: string;
  diagnostics?: Diagnostic[];
}

/** Polling payload for GET /sessions/:id/job (docs/streaming-api.md). */
export async function sessionJobStatus(sessionId: string): Promise<SessionJobStatus | null> {
  const [session] = await db().select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) return null;

  const result: SessionJobStatus = { status: session.status };
  if (await sessionBusy(sessionId)) {
    const [active] = await db()
      .select({ type: jobs.type })
      .from(jobs)
      .where(and(eq(jobs.sessionId, sessionId), sql`${jobs.status} in ('running','queued')`))
      .orderBy(sql`case ${jobs.status} when 'running' then 0 else 1 end`, jobs.createdAt)
      .limit(1);
    if (active) result.jobType = active.type;
  }
  const [latestTurn] = await db()
    .select({ diagnostics: turns.diagnostics })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(desc(turns.number))
    .limit(1);
  if (latestTurn) {
    const parsed = parseOr(z.array(diagnosticSchema), latestTurn.diagnostics, []);
    if (parsed.length > 0) result.diagnostics = parsed;
  }
  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
