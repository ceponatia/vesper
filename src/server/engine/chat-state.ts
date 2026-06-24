import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeConditionSchema,
  applyMeterDrift,
  chatPulseSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatPulseTraceSchema,
  clampAffinity,
  degradedChatPulse,
  diag,
  emptyChatPulseTrace,
  evaluateSocialReaction,
  initialMeters,
  isConditionExpired,
  meterDefinitions,
  moodMeterToFactor,
  moodNudge,
  NEUTRAL_MOOD_METER,
  personalizeMeters,
  resolveSocialReaction,
  socialTraitScale,
  stageForValue,
  stageMidpoint,
  type ActiveCondition,
  type CharacterProfile,
  type ChatPulse,
  type ChatPulseTrace,
  type DiagnosticSink,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { agentModelId, generateChecked, isDemoMode, type GenerateCheckedResult } from "../ai";
import { characterChatMessages, characterChatState, db } from "../db";
import {
  AFFINITY_DELTA_CLAMP,
  CHAT_PULSE_MAX_OUTPUT_TOKENS,
  CHAT_PULSE_TIMEOUT_MS,
  CHAT_RESET_MINUTES,
  CHAT_TICK_MINUTES,
} from "./constants";
import { buildChatPulsePrompt, CHAT_PULSE_SYSTEM } from "./prompts/chat-state";

/**
 * The character-chat light-state engine (docs/developer-notes/character-chat-state.spec.md).
 * Grows the sessionless 1-on-1 chat into a state-aware quick chat by reusing the
 * pure contracts — meters, affinity stages, conditions, and the §6 social-reaction
 * curve — with one new table and at most one cheap structured pulse per exchange.
 * Two regimes drive state for free: a per-exchange tick decays meters within a
 * visit, and real elapsed time recovers them toward rested between visits. The
 * pulse classifies the player's act and refreshes the mindNote; the deterministic
 * curve turns that into affinity + mood deltas. Degrades to drift-only on any pulse
 * failure (resilience.md §3) — never blocks or fails a reply.
 */

/** The in-memory state for one chat, drifted/seeded/pulsed and persisted as a row. */
export interface ChatState {
  meters: Record<string, number>;
  affinity: number;
  conditions: ActiveCondition[];
  mindNote: string;
  premise: string;
  lastPulseTrace: ChatPulseTrace;
  clockMinutes: number;
  lastInteractionAt: Date | null;
}

/** The strip / state-tools / premise-bar projection returned by GET …/chat/state. */
export interface ChatStateSnapshot {
  meters: Record<string, number>;
  affinity: number;
  stage: { id: string; label: string };
  conditions: ActiveCondition[];
  mindNote: string;
  premise: string;
  lastPulseTrace: ChatPulseTrace;
}

const metersSchema = z.record(z.string(), z.number());
const conditionsSchema = z.array(activeConditionSchema);

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const clamp01 = (n: number): number => clamp(n, 0, 1);

/**
 * Seed a fresh state from the character's authored defaults (spec §1.1–1.2):
 * meters rested (`initialMeters`), affinity from `playerRelationship.stage` via
 * `stageMidpoint` (`stranger` ⇒ 0 ⇒ today's behavior), and a `premise` pre-filled
 * from `playerRelationship.note` (or the caller's explicit premise, e.g. a
 * PATCH-before-first-message). `mindNote` starts empty — it is purely dynamic. Pure.
 */
export function seedChatState(profile: CharacterProfile, premise?: string): ChatState {
  const note = profile.playerRelationship?.note ?? "";
  return {
    meters: initialMeters(),
    affinity: clampAffinity(stageMidpoint(profile.playerRelationship?.stage ?? "stranger")),
    conditions: [],
    mindNote: "",
    premise: (premise ?? note).trim().slice(0, CHAT_PREMISE_MAX_CHARS),
    lastPulseTrace: emptyChatPulseTrace(),
    clockMinutes: 0,
    lastInteractionAt: null,
  };
}

/** Load the stored state for a chat, parsing every jsonb at the trust boundary, or null when no row exists. */
export async function loadChatState(
  ownerId: string,
  characterId: string,
  sink?: DiagnosticSink,
): Promise<ChatState | null> {
  const [row] = await db()
    .select({
      meters: characterChatState.meters,
      affinity: characterChatState.affinity,
      conditions: characterChatState.conditions,
      mindNote: characterChatState.mindNote,
      lastPulseTrace: characterChatState.lastPulseTrace,
      premise: characterChatState.premise,
      clockMinutes: characterChatState.clockMinutes,
      lastInteractionAt: characterChatState.lastInteractionAt,
    })
    .from(characterChatState)
    .where(and(eq(characterChatState.ownerId, ownerId), eq(characterChatState.characterId, characterId)))
    .limit(1);
  if (!row) return null;
  return {
    meters: parseOr(metersSchema, row.meters, initialMeters(), sink, "character_chat_state.meters"),
    affinity: clampAffinity(row.affinity),
    conditions: parseOr(conditionsSchema, row.conditions, [], sink, "character_chat_state.conditions"),
    mindNote: row.mindNote,
    premise: row.premise,
    lastPulseTrace: parseOr(
      chatPulseTraceSchema,
      row.lastPulseTrace,
      emptyChatPulseTrace(),
      sink,
      "character_chat_state.last_pulse_trace",
    ),
    clockMinutes: row.clockMinutes,
    lastInteractionAt: row.lastInteractionAt,
  };
}

/**
 * Recompute state from the stored row + elapsed wall-clock (spec §3). PURE and
 * idempotent on read, so it runs on every read boundary (POST prompt-build and the
 * GET strip) and is persisted only once per exchange.
 *
 * - **Between visits** (always): each meter lerps toward its *rested* value
 *   (`initialMeters`) by `f = min(1, realElapsed / CHAT_RESET_MINUTES)` — offscreen
 *   she slept, bathed, calmed down, so state recovers toward rested rather than
 *   decaying toward grime. Affinity never moves here (no between-visit decay, §10).
 * - **Within a visit** (`advance` ⇒ an actual exchange): the chat clock ticks
 *   `CHAT_TICK_MINUTES` and meters decay that far toward their *personalized*
 *   baselines, and conditions past the clock expire.
 */
export function driftChatState(
  state: ChatState,
  now: Date,
  profile: CharacterProfile,
  options: { advance?: boolean } = {},
): ChatState {
  const rested = initialMeters();
  let meters = { ...state.meters };

  if (state.lastInteractionAt) {
    const elapsedMinutes = Math.max(0, (now.getTime() - state.lastInteractionAt.getTime()) / 60_000);
    const f = Math.min(1, elapsedMinutes / CHAT_RESET_MINUTES);
    if (f > 0) {
      for (const id of Object.keys(meters)) {
        const target = rested[id];
        const current = meters[id];
        if (target === undefined || current === undefined) continue;
        meters[id] = clamp01(current + (target - current) * f);
      }
    }
  }

  let clockMinutes = state.clockMinutes;
  let conditions = state.conditions;
  if (options.advance) {
    meters = applyMeterDrift(meters, CHAT_TICK_MINUTES, personalizeMeters(meterDefinitions, profile.traits));
    clockMinutes += CHAT_TICK_MINUTES;
    conditions = conditions.filter((c) => !isConditionExpired(c, clockMinutes));
  }

  return { ...state, meters, conditions, clockMinutes };
}

/**
 * Apply a parsed pulse to a drifted state via the deterministic §6 curve (PURE —
 * the testable core). A single-act mirror of merge.ts `planReactionAffinity`:
 * resolve the classified concept against the character's preferences, evaluate it
 * through the affinity/mood/trait-aware curve, sign + clamp the affinity move to
 * ±AFFINITY_DELTA_CLAMP, and nudge mood. An unrecognised / null act ⇒ no
 * affinity/mood move (just the mindNote refresh). Returns the updated state and the
 * last-turn trace.
 */
export function applyChatPulse(
  state: ChatState,
  pulse: ChatPulse,
  profile: CharacterProfile,
  characterName: string,
): { state: ChatState; trace: ChatPulseTrace } {
  const next: ChatState = { ...state, meters: { ...state.meters } };
  const concept = pulse.playerAct?.concept ?? null;
  let valence: "like" | "dislike" | null = null;
  let affinityDelta = 0;
  let moodDelta = 0;
  const changed: string[] = [];

  if (concept) {
    const reaction = resolveSocialReaction(
      { concept, target: characterName },
      { tags: profile.tags, preferences: profile.preferences, cards: [] },
    );
    if (reaction) {
      valence = reaction.valence;
      const evaluated = evaluateSocialReaction(
        reaction,
        state.affinity,
        moodMeterToFactor(state.meters.mood ?? NEUTRAL_MOOD_METER),
        socialTraitScale(reaction, profile.traits),
      );
      const signed = evaluated.valence === "dislike" ? -evaluated.magnitude : evaluated.magnitude;
      affinityDelta = clamp(Math.round(signed), -AFFINITY_DELTA_CLAMP, AFFINITY_DELTA_CLAMP);
      moodDelta = moodNudge(evaluated);
    }
  }

  if (affinityDelta !== 0) {
    next.affinity = clampAffinity(state.affinity + affinityDelta);
    changed.push("affinity");
  }
  if (Math.abs(moodDelta) >= 0.005 && next.meters.mood !== undefined) {
    next.meters.mood = clamp01(next.meters.mood + moodDelta);
    changed.push("mood");
  }
  const note = pulse.mindNote.trim();
  if (note) {
    next.mindNote = note.slice(0, CHAT_MIND_NOTE_MAX_CHARS);
    changed.push("mindNote");
  }

  const trace: ChatPulseTrace = { concept, valence, affinityDelta, moodDelta, changed, degraded: false };
  next.lastPulseTrace = trace;
  return { state: next, trace };
}

export interface ChatPulseInput {
  state: ChatState;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  sink?: DiagnosticSink;
}

/**
 * Run the reaction pulse: one cheap structured agent call (the `runIntake` recipe —
 * reasoning off, latency-sorted routing, no repair, hard timeout) followed by the
 * deterministic curve. On timeout / parse failure / demo mode it degrades to
 * drift-only state with a `chat_state.pulse.degraded` diagnostic (the worst case is
 * exactly drift-only state — still "alive"). Uses the cheap AGENT model, never the
 * narrator model.
 */
export async function runChatPulse(input: ChatPulseInput): Promise<{ state: ChatState; degraded: boolean }> {
  const { state, profile, characterName, sink } = input;
  if (isDemoMode()) return { state: degradeState(state, sink, "demo mode"), degraded: true };

  const controller = new AbortController();
  const work = generateChecked<ChatPulse>({
    schema: chatPulseSchema,
    system: CHAT_PULSE_SYSTEM,
    prompt: buildChatPulsePrompt({
      characterName,
      playerName: input.playerName,
      mindNote: state.mindNote,
      exchange: input.exchange,
    }),
    modelId: agentModelId(),
    temperature: 0,
    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,
    code: "chat_state.pulse",
    sink,
    fallback: degradedChatPulse,
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
  });

  const { value, degraded } = await withPulseTimeout(work, controller, sink);
  if (!value || degraded) return { state: degradeState(state, sink, "pulse degraded"), degraded: true };
  return { state: applyChatPulse(state, value, profile, characterName).state, degraded: false };
}

/** Drift-only fallback: keep the drifted state, stamp a degraded trace + the mandated diagnostic. */
function degradeState(state: ChatState, sink: DiagnosticSink | undefined, reason: string): ChatState {
  sink?.push(diag("warn", "chat_state.pulse.degraded", `pulse degraded (${reason}); persisting drift-only state`));
  return {
    ...state,
    lastPulseTrace: {
      concept: null,
      valence: null,
      affinityDelta: 0,
      moodDelta: 0,
      changed: [],
      degraded: true,
      diagnostic: "chat_state.pulse.degraded",
    },
  };
}

/**
 * Race the pulse against its timeout. generateChecked never throws (it owns the
 * resilience ladder); on timeout we abort the call (its orphaned tail then adds no
 * diagnostics) and degrade to drift-only.
 */
async function withPulseTimeout(
  work: Promise<GenerateCheckedResult<ChatPulse>>,
  controller: AbortController,
  sink?: DiagnosticSink,
): Promise<{ value: ChatPulse | null; degraded: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: ChatPulse | null; degraded: boolean }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      sink?.push(diag("warn", "chat_state.pulse.timeout", `pulse exceeded ${CHAT_PULSE_TIMEOUT_MS}ms; drift-only state`));
      resolve({ value: null, degraded: true });
    }, CHAT_PULSE_TIMEOUT_MS);
  });
  const settled = work
    .then((r) => ({ value: r.value, degraded: r.degraded }))
    .catch(() => ({ value: null as ChatPulse | null, degraded: true }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close the turn: run the pulse on the drifted state + the just-finished exchange,
 * stamp `lastInteractionAt`, and persist (guarded). Called from the chat route's
 * stream finalizer after `persistAssistantReply`, so it only delays
 * `controller.close()` — invisible to perceived latency.
 */
export async function finalizeChatState(input: {
  ownerId: string;
  characterId: string;
  promptMessageId: string;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  driftedState: ChatState;
  now: Date;
  exchange: { player: string; assistant: string };
  sink?: DiagnosticSink;
}): Promise<void> {
  const { state } = await runChatPulse({
    state: input.driftedState,
    profile: input.profile,
    characterName: input.characterName,
    playerName: input.playerName,
    exchange: input.exchange,
    sink: input.sink,
  });
  await saveChatState({
    ownerId: input.ownerId,
    characterId: input.characterId,
    promptMessageId: input.promptMessageId,
    state: { ...state, lastInteractionAt: input.now },
  });
}

/**
 * Upsert the state row, guarded on the prompting user-message still existing — the
 * same `INSERT … WHERE EXISTS` shape as `persistAssistantReply`, so a clear (Reset
 * All) landing mid-stream can't resurrect a deleted state row. jsonb values are
 * cast from text params; `last_interaction_at` binds a Date.
 */
export async function saveChatState(args: {
  ownerId: string;
  characterId: string;
  promptMessageId: string;
  state: ChatState;
}): Promise<void> {
  const { ownerId, characterId, promptMessageId, state } = args;
  const meters = JSON.stringify(state.meters);
  const conditions = JSON.stringify(state.conditions);
  const trace = JSON.stringify(state.lastPulseTrace);
  await db().execute(sql`
    insert into ${characterChatState}
      (owner_id, character_id, meters, affinity, conditions, mind_note, last_pulse_trace, premise, clock_minutes, last_interaction_at, updated_at)
    select ${ownerId}, ${characterId}, ${meters}::jsonb, ${state.affinity}, ${conditions}::jsonb, ${state.mindNote},
           ${trace}::jsonb, ${state.premise}, ${state.clockMinutes}, ${state.lastInteractionAt}, now()
    where exists (select 1 from ${characterChatMessages} where id = ${promptMessageId})
    on conflict (owner_id, character_id) do update set
      meters = excluded.meters,
      affinity = excluded.affinity,
      conditions = excluded.conditions,
      mind_note = excluded.mind_note,
      last_pulse_trace = excluded.last_pulse_trace,
      premise = excluded.premise,
      clock_minutes = excluded.clock_minutes,
      last_interaction_at = excluded.last_interaction_at,
      updated_at = now()
  `);
}

/**
 * Set the per-chat premise (spec §1.2 Save). Upserts the row: on insert it seeds
 * the rest from the authored defaults (`seedChatState` with this premise); on
 * conflict it touches ONLY the premise (the pulse owns the dynamic fields). Lets
 * the player set the scene before the first message. Not guarded on a message —
 * there is no exchange in flight.
 */
export async function setChatPremise(args: {
  ownerId: string;
  characterId: string;
  premise: string;
  profile: CharacterProfile;
}): Promise<void> {
  const seed = seedChatState(args.profile, args.premise);
  await db()
    .insert(characterChatState)
    .values({
      ownerId: args.ownerId,
      characterId: args.characterId,
      meters: seed.meters,
      affinity: seed.affinity,
      conditions: seed.conditions,
      mindNote: seed.mindNote,
      lastPulseTrace: seed.lastPulseTrace,
      premise: seed.premise,
      clockMinutes: seed.clockMinutes,
      lastInteractionAt: seed.lastInteractionAt,
    })
    .onConflictDoUpdate({
      target: [characterChatState.ownerId, characterChatState.characterId],
      set: { premise: seed.premise, updatedAt: new Date() },
    });
}

/** Delete the state row (Reset All / Reset State). Lazily re-seeds from authored defaults on next use. */
export async function deleteChatState(ownerId: string, characterId: string): Promise<void> {
  await db()
    .delete(characterChatState)
    .where(and(eq(characterChatState.ownerId, ownerId), eq(characterChatState.characterId, characterId)));
}

/** Project a state into the GET …/chat/state response shape (adds the derived stage). */
export function chatStateSnapshot(state: ChatState): ChatStateSnapshot {
  const stage = stageForValue(state.affinity);
  return {
    meters: state.meters,
    affinity: state.affinity,
    stage: { id: stage.id, label: stage.label },
    conditions: state.conditions,
    mindNote: state.mindNote,
    premise: state.premise,
    lastPulseTrace: state.lastPulseTrace,
  };
}
