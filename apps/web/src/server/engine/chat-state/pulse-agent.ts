import { z } from "zod";
import {
  type SocialReactionCard,
  type CharacterProfile,
  type DiagnosticSeverity,
  type DiagnosticSink,
  type ChatPulse,
  chatIntimateSceneSchema,
  chatPulseSchema,
  degradedChatPulse,
  diag,
} from "@/contracts";
import type { ChatState } from "./types";
import type { AgentLegTrace } from "../chat-memory";
import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";
import {
  isDemoMode,
  agentModelId,
  loadChatAgentReasoningProfile,
  type AgentTelemetry,
  generateChecked,
  withGenerateTimeout,
} from "../../ai";
import { buildChatPulsePrompt, CHAT_PULSE_SYSTEM } from "../prompts/chat-state";
import { agentReasoningPlan } from "@/lib/agent-reasoning";
import { CHAT_PULSE_MAX_OUTPUT_TOKENS, CHAT_PULSE_TIMEOUT_MS } from "../constants";
import { applyOpenerPulse, applyChatPulse } from "./pulse-rules";

export interface ChatPulseInput {
  /** The SETTING-wide house rules (followups ruling 9) — one set for every member. */
  activeSocialCards: readonly SocialReactionCard[];
  state: ChatState;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  /**
   * "opener" folds only the classifier's READS — sentPhoto + mindNote — into
   * state (`applyOpenerPulse`); a reopen opener has no player act, so the curve
   * must not move regard/meters/feeling off the character's own words. Absent ⇒
   * the full fold.
   */
  scope?: "full" | "opener";
  /**
   * Commitments that just came due this exchange: so the
   * feeling proposal is informed — a just-missed plan is a hurt that lingers, a just-kept
   * one is warm. Model-mediated only; the curve/regard never move off this (no deterministic
   * penalty). Absent when nothing came due (the common case).
   */
  commitmentsDue?: { missed: readonly string[]; kept: readonly string[] };
  /** Failure telemetry only (agent-failure.ts) — never reaches the prompt. */
  trace?: AgentLegTrace;
  sink?: DiagnosticSink;
  /**
   * This character is an authored minor (age-derived life stage) — fences
   * arousal/intimate-scene effects entirely (P1, #301 review): no arousal bump
   * from any concept, and `intimateScene` (active/completed/heated/afterglow/
   * hygiene) is never consumed. Every caller that has computed the prompt-side
   * minor flag (`lifeStageForAge(profile.age)?.minor`) must pass it here too —
   * this is the SAME determination, not a second one. Absent ⇒ false.
   */
  minor?: boolean;
  /**
   * The scenario's shared story clock, for stamping a `heated`/`afterglow`
   * condition's start (review finding — `state.metersAtMinutes` is not a
   * substitute: it can be null or lag). Required so no caller silently falls
   * back to a wrong clock.
   */
  clockMinutes: number;
}

/**
 * `chatPulseSchema`, but `intimateScene` is re-checked against its raw value
 * first (#301 acceptance item 3). The field's own `.catch(null)` is correct
 * resilience for the PERSISTED contract (docs/resilience.md §3) but makes an
 * ABSENT value and a PRESENT-but-invalid one indistinguishable by the time the
 * whole object parses — both silently become `null`. This LOCAL schema (used
 * only here, for this one diagnostic; the persisted `ChatPulse` type is
 * unchanged) overrides just that field to accept the raw value, then
 * re-validates it against the same leaf schema in a `.transform()` so the
 * caller can tell the two cases apart, while every other pulse field keeps
 * its normal resilient parse and the resolved `intimateScene` still defaults
 * to `null` in both cases — applying no new scene effect either way.
 */
export type ChatPulseWithIntimateSceneDiagnosis = ChatPulse & { intimateSceneUnreadable: boolean };

export const chatPulseWithIntimateSceneDiagnosisSchema = chatPulseSchema
  .extend({ intimateScene: z.unknown().optional() })
  .transform((raw): ChatPulseWithIntimateSceneDiagnosis => {
    const rawScene = raw.intimateScene;
    const parsed = chatIntimateSceneSchema.safeParse(rawScene);
    return {
      ...raw,
      intimateScene: parsed.success ? parsed.data : null,
      // True ONLY when the model SENT a value for this field and it failed the
      // leaf schema — a genuinely absent field, or an explicit `null` (a legal
      // "no scene" value), both stay silent.
      intimateSceneUnreadable: rawScene !== undefined && rawScene !== null && !parsed.success,
    };
  });

/**
 * Diagnostic code for a PRESENT-but-invalid `intimateScene` (#301 acceptance item 3) —
 * distinct from `chat_state.pulse.degraded` (the whole pulse failed) and from silence
 * (the field was genuinely absent, or explicitly `null`).
 */
export const INTIMATE_SCENE_UNREADABLE_DIAGNOSTIC = "chat_state.pulse.intimate_scene_unreadable";

/**
 * Push the diagnostic when (and only when) the raw model output sent an
 * `intimateScene` value that failed its schema; a no-op for an absent/`null`/valid
 * value. Every other pulse effect and the resolved `null` scene proceed exactly
 * as they already would — this reports the anomaly, it never changes behavior.
 */
export function reportIntimateSceneIfUnreadable(value: ChatPulseWithIntimateSceneDiagnosis, sink?: DiagnosticSink): void {
  if (!value.intimateSceneUnreadable) return;
  sink?.push(
    diag(
      "warn",
      INTIMATE_SCENE_UNREADABLE_DIAGNOSTIC,
      "pulse's intimateScene value failed its schema; reading this exchange as no intimate-scene beat",
    ),
  );
}

/** Summary + detail of "what the pulse read" for the inspector's activity log / lightbox. PURE. */
function describeChatPulse(p: ChatPulse): AgentRunDescription {
  const details: AgentRunDetailSection[] = [];
  if (p.playerAct?.concept) details.push({ label: "Player act", items: [p.playerAct.concept] });
  if (p.feeling) details.push({ label: "Feeling", items: [`${p.feeling.label}${p.feeling.cause.trim() ? ` — ${p.feeling.cause.trim()}` : ""}`] });
  if (p.mindNote.trim()) details.push({ label: "Mind note", items: [p.mindNote.trim()] });
  if (p.sentPhoto) details.push({ label: "Photo", items: ["sent a selfie"] });
  const summary =
    [
      p.playerAct?.concept ? `act: ${p.playerAct.concept}` : "",
      p.feeling ? `feeling: ${p.feeling.label}` : "",
      p.mindNote.trim() ? "mind-note" : "",
      p.sentPhoto ? "sent photo" : "",
    ]
      .filter(Boolean)
      .join(" · ") || "no change";
  return { summary, details };
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
  // Demo mode is an intentional stub, never a genuine problem — `info`, like
  // every other demo-mode degrade (`generateChecked`'s own `degrade()`,
  // `chat_archivist.degraded`), so a healthy demo-mode exchange still reads
  // "ok" (#637 CI fix: this used to share the real-failure path's "warn" and
  // permanently degraded every exchange trace taken under `AI_FAKE=1`).
  if (isDemoMode()) return { state: degradeState(state, sink, "demo mode", "info"), degraded: true };

  const controller = new AbortController();
  const prompt = buildChatPulsePrompt({
    characterName,
    playerName: input.playerName,
    mindNote: state.mindNote,
    // The standing feeling, so the model can judge resolution ("neutral" clears)
    // instead of proposing blind.
    feeling: state.feeling.current,
    commitmentsDue: input.commitmentsDue,
    exchange: input.exchange,
  });
  const modelId = agentModelId();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.trace?.chatId);
  const reasoning = agentReasoningPlan({
    profileId: reasoningProfile,
    leg: "pulse",
    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_PULSE_TIMEOUT_MS,
  });
  const telemetry: Partial<AgentTelemetry> = {
    legId: "chat_state.pulse",
    chatId: input.trace?.chatId,
    messageId: input.trace?.messageId,
    traceId: input.trace?.traceId,
    modelId,
    promptChars: CHAT_PULSE_SYSTEM.length + prompt.length,
    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work = generateChecked<ChatPulseWithIntimateSceneDiagnosis>({
    schema: chatPulseWithIntimateSceneDiagnosisSchema,
    system: CHAT_PULSE_SYSTEM,
    prompt,
    modelId,
    temperature: 0,
    maxOutputTokens: reasoning.maxOutputTokens,
    code: "chat_state.pulse",
    sink,
    fallback: () => ({ ...degradedChatPulse(), intimateSceneUnreadable: false }),
    signal: controller.signal,
    disableReasoning: !reasoning.enabled,
    providerOptions: reasoning.providerOptions,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
    telemetry,
  });

  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    reasoning.timeoutMs,
    "chat_state.pulse.timeout",
    sink,
    telemetry,
    describeChatPulse,
  );
  if (!value || degraded) return { state: degradeState(state, sink, "pulse degraded", "warn"), degraded: true };
  reportIntimateSceneIfUnreadable(value, sink);
  if (input.scope === "opener") return { state: applyOpenerPulse(state, value).state, degraded: false };
  return {
    state: applyChatPulse(state, value, profile, characterName, input.activeSocialCards, {
      minor: input.minor,
      clockMinutes: input.clockMinutes,
    }).state,
    degraded: false,
  };
}

/**
 * Drift-only fallback: keep the drifted state, stamp a degraded trace + the
 * mandated diagnostic. `severity` is the caller's call: demo mode is an
 * expected stub (`info`), a genuine timeout/parse failure is not (`warn`).
 */
function degradeState(
  state: ChatState,
  sink: DiagnosticSink | undefined,
  reason: string,
  severity: DiagnosticSeverity,
): ChatState {
  sink?.push(diag(severity, "chat_state.pulse.degraded", `pulse degraded (${reason}); persisting drift-only state`));
  return {
    ...state,
    lastPulseTrace: {
      concept: null,
      valence: null,
      regardDelta: 0,
      moodDelta: 0,
      arousalDelta: 0,
      hygieneDelta: 0,
      intimateScene: null,
      changed: [],
      feeling: state.feeling.current?.label ?? null,
      regardScale: 1,
      sentPhoto: false,
      degraded: true,
      diagnostic: "chat_state.pulse.degraded",
    },
  };
}