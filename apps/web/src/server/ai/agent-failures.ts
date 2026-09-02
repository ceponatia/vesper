import {
  agentFailureSchema,
  agentRunSchema,
  classifyAgentFailure,
  type AgentFailure,
  type AgentFailureKind,
  type AgentRun,
  type AgentRunDetailSection,
} from "@/contracts/turns/agent-failure";
import { logEvent } from "../events";

/** The `events.type` for a SUCCESSFUL agent run (the activity + latency log). */
export const AGENT_RUN_EVENT = "agent_run";
/** The `events.type` for a FAILED agent leg. */
export const AGENT_FAILURE_EVENT = "agent_failure";

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
  /** The exchange this leg was running for, when known. */
  messageId?: string | null;
  modelId?: string;
  /** Characters of system + prompt — the "was it too big?" signal for a timeout. */
  promptChars?: number;
  maxOutputTokens?: number;
  /** The watchdog budget (timeouts only). */
  timeoutMs?: number;
  /** Admin-selected per-chat experiment profile at call time. */
  reasoningProfile?: string;
  /** Whether this leg actually received a reasoning configuration. */
  reasoningEnabled?: boolean;
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
    reasoningProfile: input.reasoningProfile ?? "off",
    reasoningEnabled: input.reasoningEnabled ?? false,
    at: (input.at ?? new Date()).toISOString(),
  });
}

/**
 * Record a failed agent leg. Fire-and-forget — callers do not await it.
 *
 * `detail` is what the provider or the parser actually said, which can quote the
 * model's output back at us, so it rides `content`: kept for the dev inspector,
 * never stored in production. The classified `cause` — the field the tally and
 * the explanation are built from — stays in the payload, so production keeps the
 * diagnosis without the quote.
 */
export function recordAgentFailure(input: RecordAgentFailureInput): void {
  const { detail, ...diagnostic } = buildAgentFailure(input);
  void logEvent(AGENT_FAILURE_EVENT, diagnostic, { chatId: input.chatId ?? null, content: { detail } });
}

const SUMMARY_CAP = 200;
// Safety caps on the recorded detail (the leg outputs are already bounded; this just bounds
// the event-payload size for a debug surface): sections, items/section, chars/item.
const DETAIL_SECTIONS_CAP = 12;
const DETAIL_ITEMS_CAP = 20;
const DETAIL_ITEM_CHARS = 300;

/** What a successful run knows on top of the shared telemetry. */
export interface RecordAgentRunInput extends AgentTelemetry {
  /** The upstream OpenRouter routed to (from the completed call's providerMetadata). */
  provider?: string | null;
  /** How long the model call actually took. */
  latencyMs?: number;
  /** One line of what the leg produced this run. */
  summary?: string;
  /** The actual content behind the summary — the click-to-open detail. */
  details?: AgentRunDetailSection[];
  /** Injectable for tests; defaults to now. */
  at?: Date;
}

/** Cap the recorded detail so a debug event never bloats (leg outputs are already small). */
function capDetails(details: readonly AgentRunDetailSection[]): AgentRunDetailSection[] {
  return details.slice(0, DETAIL_SECTIONS_CAP).map((section) => ({
    label: section.label.slice(0, SUMMARY_CAP),
    items: section.items.slice(0, DETAIL_ITEMS_CAP).map((item) => item.slice(0, DETAIL_ITEM_CHARS)),
  }));
}

/** Build a run record (pure). */
export function buildAgentRun(input: RecordAgentRunInput): AgentRun {
  return agentRunSchema.parse({
    legId: input.legId,
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    modelId: input.modelId ?? "",
    provider: input.provider ?? null,
    promptChars: input.promptChars ?? 0,
    maxOutputTokens: input.maxOutputTokens ?? 0,
    latencyMs: input.latencyMs ?? 0,
    summary: (input.summary ?? "").slice(0, SUMMARY_CAP),
    details: capDetails(input.details ?? []),
    reasoningProfile: input.reasoningProfile ?? "off",
    reasoningEnabled: input.reasoningEnabled ?? false,
    at: (input.at ?? new Date()).toISOString(),
  });
}

/**
 * Record a SUCCESSFUL agent run — the activity + latency log (chat-plans-promises follow-up:
 * DeepSeek was still timing out, so we need to SEE how long the ones that DO complete take).
 * Fire-and-forget, same as `recordAgentFailure`; a run with no `legId` is skipped by the caller.
 */
export function recordAgentRun(input: RecordAgentRunInput): void {
  const { summary, details, ...diagnostic } = buildAgentRun(input);
  // `summary` and `details` describe what the leg produced — facts, queries,
  // narration fragments — so they are content, not diagnostics. Production keeps
  // the leg id, the model, and the latency; the words stay in development.
  void logEvent(AGENT_RUN_EVENT, diagnostic, { chatId: input.chatId ?? null, content: { summary, details } });
}
