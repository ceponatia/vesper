import {
  type SocialReactionCard,
  type CharacterProfile,
  type DiagnosticSink,
  type ChatPulse,
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
  if (isDemoMode()) return { state: degradeState(state, sink, "demo mode"), degraded: true };

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
    modelId,
    promptChars: CHAT_PULSE_SYSTEM.length + prompt.length,
    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work = generateChecked<ChatPulse>({
    schema: chatPulseSchema,
    system: CHAT_PULSE_SYSTEM,
    prompt,
    modelId,
    temperature: 0,
    maxOutputTokens: reasoning.maxOutputTokens,
    code: "chat_state.pulse",
    sink,
    fallback: degradedChatPulse,
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
  if (!value || degraded) return { state: degradeState(state, sink, "pulse degraded"), degraded: true };
  if (input.scope === "opener") return { state: applyOpenerPulse(state, value).state, degraded: false };
  return { state: applyChatPulse(state, value, profile, characterName, input.activeSocialCards).state, degraded: false };
}

/** Drift-only fallback: keep the drifted state, stamp a degraded trace + the mandated diagnostic. */
function degradeState(state: ChatState, sink: DiagnosticSink | undefined, reason: string): ChatState {
  sink?.push(diag("warn", "chat_state.pulse.degraded", `pulse degraded (${reason}); persisting drift-only state`));
  return {
    ...state,
    lastPulseTrace: {
      concept: null,
      valence: null,
      regardDelta: 0,
      moodDelta: 0,
      arousalDelta: 0,
      changed: [],
      feeling: state.feeling.current?.label ?? null,
      regardScale: 1,
      sentPhoto: false,
      degraded: true,
      diagnostic: "chat_state.pulse.degraded",
    },
  };
}