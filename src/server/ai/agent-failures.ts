import {
  agentFailureSchema,
  classifyAgentFailure,
  type AgentFailure,
  type AgentFailureKind,
} from "@/contracts/turns/agent-failure";
import { logEvent } from "../events";

/**
 * Recording side of the agent-failure telemetry (contract + classifier in
 * `contracts/turns/agent-failure.ts`). Writes one `events` row per failed leg
 * (`type = "agent_failure"`), so the admin inspector can show WHICH leg failed, HOW OFTEN,
 * and the SUSPECTED CAUSE — instead of the failure vanishing into a `fly logs` line.
 *
 * Deliberately reusing the existing `events` table (nullable session, typed payload,
 * already fire-and-forget): a debug surface must not cost a migration, and this data is
 * append-only observability, exactly what that table is for.
 *
 * **Never throws, never awaited by a turn.** `logEvent` already swallows its own errors;
 * this adds no path by which recording a failure could cause one.
 */

/** What a caller knows about the leg it is running. Every field is optional but the id. */
export interface AgentTelemetry {
  /** The leg's identity for tallying — defaults to the `generateChecked` diagnostic `code`. */
  legId: string;
  /** Chat lane: the conversation the failure belongs to (the inspector's filter). */
  chatId?: string | null;
  /** Session lane: the session, so the row joins the `events` stream normally. */
  sessionId?: string | null;
  /** The exchange this leg was running for, when known. */
  messageId?: string | null;
  modelId?: string;
  /** Characters of system + prompt — the "was it too big?" signal for a timeout. */
  promptChars?: number;
  maxOutputTokens?: number;
  /** The watchdog budget (timeouts only). */
  timeoutMs?: number;
}

export interface RecordAgentFailureInput extends AgentTelemetry {
  kind: AgentFailureKind;
  /** `classifyProviderError`'s code, when the failure came from the provider. */
  providerCode?: string;
  /** The upstream OpenRouter routed to, when a call completed. */
  provider?: string | null;
  latencyMs?: number;
  httpStatus?: number;
  /** What the provider or the parser actually said (truncated here, not by the caller). */
  detail?: string;
  /** Injectable for tests; defaults to now. */
  at?: Date;
}

const DETAIL_CAP = 300;

/** Build the record (pure — the classifier decides the suspected cause). */
export function buildAgentFailure(input: RecordAgentFailureInput): AgentFailure {
  const detail = (input.detail ?? "").slice(0, DETAIL_CAP);
  return agentFailureSchema.parse({
    legId: input.legId,
    kind: input.kind,
    cause: classifyAgentFailure({
      kind: input.kind,
      providerCode: input.providerCode,
      promptChars: input.promptChars,
      // The parse-failure classifier reads the RAW detail (the truncation hints live in the
      // parser's own words), so it must see it before the cap could clip a hint away.
      detail: input.detail,
    }),
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    modelId: input.modelId ?? "",
    provider: input.provider ?? null,
    promptChars: input.promptChars ?? 0,
    maxOutputTokens: input.maxOutputTokens ?? 0,
    timeoutMs: input.timeoutMs ?? 0,
    latencyMs: input.latencyMs ?? 0,
    httpStatus: input.httpStatus ?? 0,
    detail,
    at: (input.at ?? new Date()).toISOString(),
  });
}

/** Record a failed agent leg. Fire-and-forget — callers do not await it. */
export function recordAgentFailure(input: RecordAgentFailureInput): void {
  const failure = buildAgentFailure(input);
  void logEvent(input.sessionId ?? null, "agent_failure", { ...failure });
}
