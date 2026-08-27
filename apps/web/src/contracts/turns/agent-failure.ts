import { z } from "zod";

/**
 * Agent-failure telemetry — the debug surface behind every helper leg.
 *
 * Every helper leg behind a reply (the pulse, the three extraction legs, the per-member
 * personal pass, the summary fold, the scene sketch, the photo read, the session lane's
 * agents) is **best-effort by design**: it degrades to a diagnostic and the reply still
 * ships. That resilience is correct — and it is also a blindfold. A leg that times out on
 * every single exchange looks exactly like a leg that never had anything to say: the state
 * row simply keeps its old values, and the only trace is one `log.info` line in `fly logs`
 * that nobody reads. (The 13-field archivist was timing out repeatedly in production for
 * days before a stray `fly logs` grep surfaced it.)
 *
 * So a failed leg now leaves a **durable, queryable record** with a **suspected cause**,
 * tallied in the admin chat inspector. Nothing here changes behavior: recording is
 * fire-and-forget and a failed record is swallowed. It exists to answer three questions —
 * *is a leg failing?*, *how often?*, and *why, probably?*
 *
 * Pure: the vocabulary, the record shape, and the classifier. No IO.
 */

/** What went wrong, mechanically. */
export const agentFailureKinds = [
  /** The caller's watchdog fired before the model answered (`withGenerateTimeout`). */
  "timeout",
  /** The provider call itself failed — 4xx/5xx, network, moderation. */
  "api_error",
  /** The model answered, but the answer wasn't the JSON we asked for (after the repair round-trip). */
  "parse_failed",
] as const;
export const agentFailureKindSchema = z.enum(agentFailureKinds).catch("timeout");
export type AgentFailureKind = (typeof agentFailureKinds)[number];

/**
 * The **suspected cause** — a best guess, deliberately labeled as such. Provider-class
 * causes are the honest ones (the provider told us); the rest are inferences from the
 * signals we hold (prompt size, token cap, whether the JSON was cut off mid-object).
 */
export const agentFailureCauses = [
  /** Timeout on a very large prompt — the leg's sheet or context is likely too big for its budget. */
  "prompt_too_large",
  /** Timeout with an ordinary prompt — a slow or cold provider endpoint, or a slow model. */
  "model_slow",
  /** The JSON stopped mid-object: the leg's output-token cap is probably too low. */
  "output_cap_too_low",
  /** The model answered with something that wasn't the requested object at all. */
  "malformed_output",
  /** 429 — provider or account throttling. */
  "rate_limited",
  /** 402 — the account is out of credits. */
  "no_credits",
  /** 401/403 — the API key was rejected. */
  "auth_failed",
  /** The provider refused the content. */
  "moderation_blocked",
  /** The prompt no longer fits the model's context window. */
  "context_too_long",
  /** An upstream provider failure with no more specific class. */
  "provider_error",
  /** The request never reached the provider. */
  "network",
  "unknown",
] as const;
export const agentFailureCauseSchema = z.enum(agentFailureCauses).catch("unknown");
export type AgentFailureCause = (typeof agentFailureCauses)[number];

/** One recorded failure — the `events` row payload (`type = "agent_failure"`). */
export const agentFailureSchema = z.object({
  /** The leg's diagnostic prefix — its identity for tallying (e.g. `chat_memory_scribe`). */
  legId: z.string().catch("unknown"),
  kind: agentFailureKindSchema,
  cause: agentFailureCauseSchema,
  /** Which conversation (chat lane) — the inspector's filter. Null for session-lane agents. */
  chatId: z.string().nullish().catch(null).transform((v) => v ?? null),
  /** The exchange this failure belongs to, when known — so a row points at a beat. */
  messageId: z.string().nullish().catch(null).transform((v) => v ?? null),
  modelId: z.string().catch(""),
  /** The upstream OpenRouter routed to, when a call completed. */
  provider: z.string().nullish().catch(null).transform((v) => v ?? null),
  /** Characters of system + user prompt — the "was it too big?" signal. */
  promptChars: z.number().int().nonnegative().catch(0),
  /** The leg's output-token cap — the "was it cut off?" signal. */
  maxOutputTokens: z.number().int().nonnegative().catch(0),
  /** The watchdog budget that fired (timeouts only). */
  timeoutMs: z.number().int().nonnegative().catch(0),
  /** How long the (last completed) call actually took, when one completed. */
  latencyMs: z.number().int().nonnegative().catch(0),
  /** The effective admin reasoning experiment at call time (old rows heal to off). */
  reasoningProfile: z.string().catch("off").default("off"),
  reasoningEnabled: z.boolean().catch(false).default(false),
  /** HTTP status, when the provider gave one. */
  httpStatus: z.number().int().catch(0),
  /** What the provider or parser actually said — truncated. */
  detail: z.string().catch(""),
  at: z.string().catch(""),
});
export type AgentFailure = z.infer<typeof agentFailureSchema>;

/** Human labels for the legs we know about; an unlisted leg shows its raw id. */
const LEG_LABELS: Record<string, string> = {
  chat_memory_scribe: "Memory scribe",
  chat_continuity: "Continuity tracker",
  chat_character_notes: "Character tracker",
  chat_personal_notes: "Personal note-taker (group)",
  "chat_state.pulse": "Reaction pulse",
  chat_summary: "Recap editor",
  chat_scene_sketch: "Location artist",
  chat_meanwhile: "Meanwhile pass",
  chat_vision: "Photo reader",
  intake: "Intake (session)",
  "agent.simulant": "Simulant (session)",
  "agent.archivist": "Archivist (session)",
  "agent.continuity": "Continuity (session)",
  "agent.director": "Director (session)",
};

export function agentLegLabel(legId: string): string {
  return LEG_LABELS[legId] ?? legId;
}

/** One line of plain language per cause — what it means and what to do about it. */
const CAUSE_EXPLANATIONS: Record<AgentFailureCause, string> = {
  prompt_too_large:
    "The prompt was unusually large, so the model likely needed longer than this leg's time budget just to read it. Tighten what the leg is sent, or raise its timeout.",
  model_slow:
    "The model didn't answer inside this leg's time budget on an ordinary-sized prompt — usually a slow or cold provider endpoint. If it recurs, raise the timeout or pick a faster agent model.",
  output_cap_too_low:
    "The reply was cut off mid-object, which almost always means the leg's output-token cap is too low for what it was asked to produce.",
  malformed_output: "The model answered with something that wasn't the object we asked for, even after the repair round-trip.",
  rate_limited: "The provider is throttling us (429). Usually transient; persistent means the account is over its limit.",
  no_credits: "The provider account is out of credits (402).",
  auth_failed: "The provider rejected the API key (401/403).",
  moderation_blocked: "The provider refused this content.",
  context_too_long: "The prompt no longer fits the model's context window.",
  provider_error: "An upstream provider failure with no more specific class.",
  network: "The request never reached the provider.",
  unknown: "No clear signal — see the detail below.",
};

export function agentFailureExplanation(cause: AgentFailureCause): string {
  return CAUSE_EXPLANATIONS[cause];
}

/**
 * A prompt at or above this many characters is "large" for a small agent leg — the chat
 * extraction sheets run ~3–8k, so 24k means the exchange, memory, or a runaway list is
 * dominating. Only used to *explain* a timeout, never to gate one.
 */
export const AGENT_LARGE_PROMPT_CHARS = 24_000;

/** Signs that a JSON body stopped mid-object rather than being wrong from the start. */
const TRUNCATION_HINTS = [
  "unexpected end of json",
  "unterminated string",
  "unexpected end of input",
  "unexpected token", // a cut-off object usually trips this at the truncation point
];

export interface AgentFailureSignals {
  kind: AgentFailureKind;
  /** The provider's own classification, when the failure was an API error. */
  providerCode?: string;
  promptChars?: number;
  detail?: string;
}

/**
 * The suspected cause, from the signals we actually hold. PURE.
 *
 * - An **API error** is not a guess: the provider told us (`classifyProviderError`), so its
 *   class passes straight through.
 * - A **parse failure** is diagnosed by whether the JSON *stopped* (truncation ⇒ the output
 *   cap is too low — a real, fixable bug that otherwise reads as "the model is bad at JSON")
 *   or was wrong from the start.
 * - A **timeout** is the weakest signal: we only know the prompt size, so a large prompt
 *   points at the sheet and anything else points at the model/endpoint.
 */
export function classifyAgentFailure(signals: AgentFailureSignals): AgentFailureCause {
  const detail = (signals.detail ?? "").toLowerCase();

  if (signals.kind === "api_error") {
    const parsed = agentFailureCauseSchema.safeParse(signals.providerCode);
    // The provider vocabulary overlaps ours by construction; anything else (including the
    // narrator-only "empty_reply"/"timeout" codes) lands as a plain provider error.
    if (parsed.success && parsed.data !== "unknown") return parsed.data;
    return "provider_error";
  }

  if (signals.kind === "parse_failed") {
    return TRUNCATION_HINTS.some((hint) => detail.includes(hint)) ? "output_cap_too_low" : "malformed_output";
  }

  // timeout
  return (signals.promptChars ?? 0) >= AGENT_LARGE_PROMPT_CHARS ? "prompt_too_large" : "model_slow";
}

/** One row of a tally (`byLeg` / `byCause`), newest-first counts. */
export const agentFailureTallyRowSchema = z.object({
  key: z.string().catch(""),
  count: z.number().int().nonnegative().catch(0),
});
export type AgentFailureTallyRow = z.infer<typeof agentFailureTallyRowSchema>;

/** Tally a list of failures by leg and by suspected cause. PURE. */
export function tallyAgentFailures(failures: readonly AgentFailure[]): {
  total: number;
  byLeg: AgentFailureTallyRow[];
  byCause: AgentFailureTallyRow[];
} {
  const count = (pick: (f: AgentFailure) => string): AgentFailureTallyRow[] => {
    const map = new Map<string, number>();
    for (const failure of failures) map.set(pick(failure), (map.get(pick(failure)) ?? 0) + 1);
    return [...map.entries()]
      .map(([key, n]) => ({ key, count: n }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  return { total: failures.length, byLeg: count((f) => f.legId), byCause: count((f) => f.cause) };
}

/**
 * One recorded SUCCESSFUL run — the `events` row payload (`type = "agent_run"`). A completed
 * agent leg (the pulse or an extraction leg) with its measured latency, the provider that
 * served it, and a one-line summary of what it produced. This is the activity + latency half
 * of the health picture: a failure record answers "is a leg dying?"; a run record answers
 * "when it lives, how slow is it, and what did it actually do?" — which is what tells a
 * timeout apart from a slow-but-alive endpoint.
 */
/**
 * One labelled section of a run's DETAIL — the actual content the leg produced, for the
 * inspector's click-to-open "db viewer" (e.g. `{ label: "Facts (2)", items: ["Mara · knowledge:
 * …", …] }`). A run's summary is the one-line count; the details are the rows behind it.
 */
export const agentRunDetailSectionSchema = z.object({
  label: z.string().catch(""),
  items: z.array(z.string()).catch([]),
});
export type AgentRunDetailSection = z.infer<typeof agentRunDetailSectionSchema>;

/** What a per-leg describer produces: the one-line summary AND the detail sections behind it. */
export interface AgentRunDescription {
  summary: string;
  details: AgentRunDetailSection[];
}

export const agentRunSchema = z.object({
  legId: z.string().catch("unknown"),
  chatId: z.string().nullish().catch(null).transform((v) => v ?? null),
  messageId: z.string().nullish().catch(null).transform((v) => v ?? null),
  modelId: z.string().catch(""),
  provider: z.string().nullish().catch(null).transform((v) => v ?? null),
  promptChars: z.number().int().nonnegative().catch(0),
  maxOutputTokens: z.number().int().nonnegative().catch(0),
  /** How long the model call actually took — the diagnostic that separates slow from dead. */
  latencyMs: z.number().int().nonnegative().catch(0),
  /** The effective admin reasoning experiment at call time (old rows heal to off). */
  reasoningProfile: z.string().catch("off").default("off"),
  reasoningEnabled: z.boolean().catch(false).default(false),
  /** One line of what the leg produced ("3 facts · 1 episode · 2 queries"); "" = nothing changed. */
  summary: z.string().catch(""),
  /** The actual content behind the summary — the click-to-open detail (empty on old rows). */
  details: z.array(agentRunDetailSectionSchema).catch([]).default([]),
  at: z.string().catch(""),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

/** Per-leg latency stat over a set of runs (the "how slow, really?" view). */
export const agentRunStatSchema = z.object({
  key: z.string().catch(""),
  count: z.number().int().nonnegative().catch(0),
  medianMs: z.number().int().nonnegative().catch(0),
  maxMs: z.number().int().nonnegative().catch(0),
});
export type AgentRunStat = z.infer<typeof agentRunStatSchema>;

/** Median of a numeric list (integer, midpoint-rounded). PURE. */
function medianMs(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** Tally runs by leg with count + median/max latency (the "how slow, really?" view). PURE. */
export function tallyAgentRuns(runs: readonly AgentRun[]): { total: number; byLeg: AgentRunStat[] } {
  const byLeg = new Map<string, number[]>();
  for (const run of runs) {
    const latencies = byLeg.get(run.legId) ?? [];
    latencies.push(run.latencyMs);
    byLeg.set(run.legId, latencies);
  }
  const stats: AgentRunStat[] = [...byLeg.entries()]
    .map(([key, latencies]) => ({
      key,
      count: latencies.length,
      medianMs: medianMs(latencies),
      maxMs: latencies.length ? Math.max(...latencies) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { total: runs.length, byLeg: stats };
}
