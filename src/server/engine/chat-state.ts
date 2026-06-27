import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeConditionSchema,
  applyMeterDrift,
  chatPulseSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_OUTFIT_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatPulseTraceSchema,
  clampAffinity,
  degradedChatPulse,
  deriveEmotionLabel,
  diag,
  emptyChatPulseTrace,
  evaluateSocialReaction,
  initialMeters,
  interactionConceptById,
  isConditionExpired,
  meterDefinitions,
  moodMeterToFactor,
  moodNudge,
  NEUTRAL_MOOD_METER,
  personalizeMeters,
  resolveSocialReaction,
  socialReactionCardSchema,
  socialTraitScale,
  stageForValue,
  stageMidpoint,
  type ActiveCondition,
  type ChatActionId,
  type CharacterProfile,
  type ChatPulse,
  type ChatPulseTrace,
  type DiagnosticSink,
  type EmotionLabel,
  type SocialReactionCard,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { agentModelId, generateChecked, isDemoMode, type GenerateCheckedResult } from "../ai";
import { characterChatMessages, characterChatState, db } from "../db";
import {
  AFFINITY_DELTA_CLAMP,
  CHAT_ACTION_CONDITION_MINUTES,
  CHAT_AROUSAL_INTIMATE,
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
  /** Free-text starting outfit driving chat scene images (character-chat-scenario.plan.md). */
  outfit: string;
  /** Whether chat scene images reveal intimate anatomy (no structured wardrobe to derive it). */
  outfitExposed: boolean;
  /** The social cards live in THIS chat — seeded from `profile.socialCards`, then authoritative. */
  activeSocialCards: SocialReactionCard[];
  lastPulseTrace: ChatPulseTrace;
  clockMinutes: number;
  lastInteractionAt: Date | null;
}

/** The strip / state-tools / premise-bar projection returned by GET …/chat/state. */
export interface ChatStateSnapshot {
  meters: Record<string, number>;
  affinity: number;
  stage: { id: string; label: string };
  /** Derived discrete emotion for the chat mood chip (mood.spec §4). */
  emotion: { label: EmotionLabel; intensity: number };
  conditions: ActiveCondition[];
  mindNote: string;
  premise: string;
  /** Free-text starting outfit for the scenario modal (character-chat-scenario.plan.md). */
  outfit: string;
  /** Intimate-reveal gate for chat scene images. */
  outfitExposed: boolean;
  /** The cards live in THIS chat (editable in the scenario modal). */
  activeSocialCards: SocialReactionCard[];
  lastPulseTrace: ChatPulseTrace;
  /** Read-only chat-clock + wall-clock anchor, surfaced for the state-tools modal (slice 4). */
  clockMinutes: number;
  lastInteractionAt: string | null;
  /**
   * False when this snapshot is a seed-on-read (no DB row yet) rather than a stored,
   * possibly-diverged chat. The UI uses it to preview the authored Starting Relationship
   * on a fresh chat without clobbering an ongoing chat's accumulated disposition.
   */
  persisted: boolean;
}

const metersSchema = z.record(z.string(), z.number());
const conditionsSchema = z.array(activeConditionSchema);
const activeSocialCardsSchema = z.array(socialReactionCardSchema);

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
    outfit: "",
    outfitExposed: false,
    // Seeded from the character's own cards, then author-editable + authoritative in the chat.
    activeSocialCards: [...(profile.socialCards ?? [])],
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
      outfit: characterChatState.outfit,
      outfitExposed: characterChatState.outfitExposed,
      activeSocialCards: characterChatState.activeSocialCards,
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
    outfit: row.outfit,
    outfitExposed: row.outfitExposed,
    activeSocialCards: parseOr(activeSocialCardsSchema, row.activeSocialCards, [], sink, "character_chat_state.active_social_cards"),
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
      // World-less chat: the cards active in THIS chat (scenario modal) apply —
      // seeded from the character's own `profile.socialCards`, then author-editable.
      { tags: profile.tags, preferences: profile.preferences, cards: state.activeSocialCards },
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

  // Arousal-from-intimate-acts (slice 4): an intimate concept raises arousal — full
  // for a flagged-intimate act (a proposition), half for courtship/physical
  // affection — unless the character disliked it.
  const arousalDelta = concept && valence !== "dislike" ? arousalBumpForConcept(concept) : 0;

  if (affinityDelta !== 0) {
    next.affinity = clampAffinity(state.affinity + affinityDelta);
    changed.push("affinity");
  }
  if (Math.abs(moodDelta) >= 0.005 && next.meters.mood !== undefined) {
    next.meters.mood = clamp01(next.meters.mood + moodDelta);
    changed.push("mood");
  }
  if (arousalDelta >= 0.005 && next.meters.arousal !== undefined) {
    next.meters.arousal = clamp01(next.meters.arousal + arousalDelta);
    changed.push("arousal");
  }
  const note = pulse.mindNote.trim();
  if (note) {
    next.mindNote = note.slice(0, CHAT_MIND_NOTE_MAX_CHARS);
    changed.push("mindNote");
  }

  const trace: ChatPulseTrace = { concept, valence, affinityDelta, moodDelta, arousalDelta, changed, degraded: false };
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
      arousalDelta: 0,
      changed: [],
      degraded: true,
      diagnostic: "chat_state.pulse.degraded",
    },
  };
}

/** Arousal bump for an intimate concept: full for a flagged-intimate act, half for courtship / physical affection. */
function arousalBumpForConcept(concept: string): number {
  const def = interactionConceptById(concept);
  if (!def) return 0;
  if (def.intimate) return CHAT_AROUSAL_INTIMATE;
  if (def.family === "courtship" || concept === "physical_affection") return CHAT_AROUSAL_INTIMATE * 0.5;
  return 0;
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
 * Persist a full state row unguarded — for explicit author edits (the premise Save,
 * the state-tools modal, action chips) where no exchange is in flight, so the
 * stream-race guard (`saveChatState`) is unnecessary. Upserts every field.
 */
export async function persistChatState(ownerId: string, characterId: string, state: ChatState): Promise<void> {
  const row = {
    meters: state.meters,
    affinity: state.affinity,
    conditions: state.conditions,
    mindNote: state.mindNote,
    lastPulseTrace: state.lastPulseTrace,
    premise: state.premise,
    outfit: state.outfit,
    outfitExposed: state.outfitExposed,
    activeSocialCards: state.activeSocialCards,
    clockMinutes: state.clockMinutes,
    lastInteractionAt: state.lastInteractionAt,
  };
  await db()
    .insert(characterChatState)
    .values({ ownerId, characterId, ...row })
    .onConflictDoUpdate({
      target: [characterChatState.ownerId, characterChatState.characterId],
      set: { ...row, updatedAt: new Date() },
    });
}

/** A partial edit to a chat state from the premise Save or the state-tools modal (slice 4). */
export interface ChatStateEdit {
  premise?: string;
  affinity?: number;
  mindNote?: string;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  outfit?: string;
  outfitExposed?: boolean;
  activeSocialCards?: SocialReactionCard[];
}

/**
 * Apply an author edit to a chat's state (spec §1.2 Save + slice 4 state-tools
 * modal). Loads the row (or seeds from the authored defaults — the premise
 * pre-fills before the first message), applies only the provided fields with the
 * same clamps the engine enforces, and persists. Returns the new state. Not guarded
 * on a message — there is no exchange in flight.
 */
export async function editChatState(args: {
  ownerId: string;
  characterId: string;
  profile: CharacterProfile;
  patch: ChatStateEdit;
}): Promise<ChatState> {
  const { ownerId, characterId, profile, patch } = args;
  const base = (await loadChatState(ownerId, characterId)) ?? seedChatState(profile, patch.premise);
  const next: ChatState = { ...base, meters: { ...base.meters } };
  if (patch.premise !== undefined) next.premise = patch.premise.trim().slice(0, CHAT_PREMISE_MAX_CHARS);
  if (patch.affinity !== undefined) next.affinity = clampAffinity(patch.affinity);
  if (patch.mindNote !== undefined) next.mindNote = patch.mindNote.trim().slice(0, CHAT_MIND_NOTE_MAX_CHARS);
  if (patch.meters !== undefined) next.meters = clampMeters(patch.meters);
  if (patch.conditions !== undefined) next.conditions = patch.conditions;
  if (patch.outfit !== undefined) next.outfit = patch.outfit.slice(0, CHAT_OUTFIT_MAX_CHARS);
  if (patch.outfitExposed !== undefined) next.outfitExposed = patch.outfitExposed;
  if (patch.activeSocialCards !== undefined) next.activeSocialCards = patch.activeSocialCards;
  await persistChatState(ownerId, characterId, next);
  return next;
}

/** Apply a one-click test-bed action chip to the state (slice 4); returns the mutated state (PURE). */
export function applyChatAction(state: ChatState, action: ChatActionId): ChatState {
  const meters = { ...state.meters };
  let conditions = state.conditions;
  const bump = (id: string, delta: number) => {
    meters[id] = clamp01((meters[id] ?? 0) + delta);
  };
  switch (action) {
    case "drink":
      bump("intoxication", 0.3);
      break;
    case "freshen":
      meters.hygiene = 0.95;
      bump("energy", 0.05);
      break;
    case "rest":
      bump("energy", 0.2);
      bump("stress", -0.2);
      break;
    case "fluster":
      bump("arousal", 0.25);
      conditions = upsertCondition(conditions, {
        id: "flushed",
        label: "Flushed",
        startedAtMinutes: state.clockMinutes,
        durationMinutes: CHAT_ACTION_CONDITION_MINUTES,
        promptHint: "Color high, breath a little quick.",
        attributeEffects: [],
      });
      break;
  }
  return { ...state, meters, conditions };
}

/** Replace a condition with the same id, else append (so re-applying a chip refreshes it). */
function upsertCondition(conditions: readonly ActiveCondition[], next: ActiveCondition): ActiveCondition[] {
  const rest = conditions.filter((c) => c.id !== next.id);
  return [...rest, next];
}

/** Clamp every meter value to [0,1], keeping the registry keys. */
function clampMeters(meters: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(meters)) out[id] = clamp01(value);
  return out;
}

/** Delete the state row (Reset All / Reset State). Lazily re-seeds from authored defaults on next use. */
export async function deleteChatState(ownerId: string, characterId: string): Promise<void> {
  await db()
    .delete(characterChatState)
    .where(and(eq(characterChatState.ownerId, ownerId), eq(characterChatState.characterId, characterId)));
}

/**
 * Project a state into the GET …/chat/state response shape (adds the derived stage +
 * the labeled emotion for the mood chip). `opts.dominance` (the character's
 * `social.dominance` trait) tilts a low-valence read angry vs sad; chat is an
 * intimate-capable 1-on-1, so `intimateContext` defaults on (the `aroused` gate is then
 * just the arousal meter) — callers without a character pass nothing and get the
 * conservative defaults.
 */
export function chatStateSnapshot(
  state: ChatState,
  opts: { dominance?: number; intimateContext?: boolean; persisted?: boolean } = {},
): ChatStateSnapshot {
  const stage = stageForValue(state.affinity);
  const emotion = deriveEmotionLabel({
    mood: state.meters.mood ?? NEUTRAL_MOOD_METER,
    arousal: state.meters.arousal ?? 0,
    stress: state.meters.stress ?? 0,
    energy: state.meters.energy ?? 1,
    affinityStage: stage.id,
    conditions: state.conditions,
    intimateContext: opts.intimateContext ?? false,
    dominance: opts.dominance ?? 0,
  });
  return {
    meters: state.meters,
    affinity: state.affinity,
    stage: { id: stage.id, label: stage.label },
    emotion: { label: emotion.emotion, intensity: emotion.intensity },
    conditions: state.conditions,
    mindNote: state.mindNote,
    premise: state.premise,
    outfit: state.outfit,
    outfitExposed: state.outfitExposed,
    activeSocialCards: state.activeSocialCards,
    lastPulseTrace: state.lastPulseTrace,
    clockMinutes: state.clockMinutes,
    lastInteractionAt: state.lastInteractionAt ? state.lastInteractionAt.toISOString() : null,
    // Defaults true: PATCH/POST always persist a row, and a stored GET passes its own value.
    persisted: opts.persisted ?? true,
  };
}
