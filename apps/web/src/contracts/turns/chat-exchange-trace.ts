import { z } from "zod";
import { DEFAULT_ENGINE_AUTHORITY, engineAuthoritySchema, type EngineAuthority } from "@vesper/simulation-core/contracts/authority";
import { diagnosticSeveritySchema, type Diagnostic } from "../diagnostics";
import {
  agentFailureSchema,
  agentRunSchema,
  type AgentFailure,
  type AgentRun,
} from "./agent-failure";
import { chatReplyFailureCodes, type ChatReplyFailureCode } from "./chat-reply-failure";
import { compositionFallbackSchema, type CompositionFallback } from "./composition-fallback";

/**
 * The exchange-trace contract (#637) — ONE durable trace per chat exchange,
 * read by both the CLI (`--json`) and the admin chat inspector. This module is
 * the foundation every other #637 slice builds against: the trace shape, the
 * vocabularies, the persisted-part shape, and the pure assembler that turns
 * stored parts plus correlated agent/fallback rows into one ordered trace with
 * a derived outcome and highlights.
 *
 * Pure: schemas, vocabularies, the assembler. No IO — the recorder
 * (`server/engine/chat-exchange-trace.ts`) and the read model
 * (`server/memory/chat-exchange-trace-log.ts`) own that.
 *
 * Storage (docs/resilience.md §1, §2; docs/database/README.md §Operational
 * tables): one `events` row per flush, `type = "chat_trace"`. No migration —
 * append-only observability, exactly like `agent_failure` / `composition_fallback`.
 * **Production payload carries no text.** The only free-text fields this
 * contract models — a stage's `detail`, a coverage entry's `summary`, a
 * diagnostic's `message` — ride `logEvent`'s `content` option under NEW
 * top-level keys (`stageDetails` / `coverageSummaries` / `diagnosticMessages`)
 * that cannot collide with the payload's own `stages` / `coverage` /
 * `diagnostics` arrays (`buildEventRow` spreads payload last — server/events.ts).
 * Everything else — ids, enums, stable codes, counts, sizes, durations, hashes
 * — is safe in production and stays on the structured arrays.
 */

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** A stage's outcome. Closed: an unrecognized value degrades to "failed" — never a false "success". */
export const exchangeStageStatuses = ["success", "degraded", "failed", "skipped", "retried", "blocked"] as const;
export const exchangeStageStatusSchema = z.enum(exchangeStageStatuses).catch("failed");
export type ExchangeStageStatus = (typeof exchangeStageStatuses)[number];

/** Which part of the exchange a stage belongs to — the trace's coarse timeline. */
export const exchangePhases = ["admission", "prepare", "narrator", "settle", "post_turn"] as const;
export const exchangePhaseSchema = z.enum(exchangePhases).catch("admission");
export type ExchangePhase = (typeof exchangePhases)[number];

/**
 * A coverage check's result. Closed, and distinguishes MISSING (we don't know,
 * never fetched/skipped) from EMPTY (fetched, genuinely nothing there) — the
 * issue checklist's "distinguishes missing from valid empty". An unrecognized
 * value degrades to "missing": per docs/resilience.md §1, a fallback must never
 * read as a positive claim.
 */
export const exchangeCoverageStatuses = ["present", "empty", "missing", "suppressed", "degraded"] as const;
export const exchangeCoverageStatusSchema = z.enum(exchangeCoverageStatuses).catch("missing");
export type ExchangeCoverageStatus = (typeof exchangeCoverageStatuses)[number];

/** How the whole exchange ended. Closed; an unrecognized value degrades to "failed". */
export const exchangeFinishKinds = ["ok", "stopped", "failed"] as const;
export const exchangeFinishKindSchema = z.enum(exchangeFinishKinds).catch("failed");
export type ExchangeFinishKind = (typeof exchangeFinishKinds)[number];

/** What kind of player action opened this exchange. Closed. */
export const exchangeOperations = ["send", "open", "continue", "action_beat", "regenerate", "rerun"] as const;
export const exchangeOperationSchema = z.enum(exchangeOperations).catch("send");
export type ExchangeOperation = (typeof exchangeOperations)[number];

/** Which engine rendered the exchange. Closed — coarser than `EngineAuthority`'s four rollout stages. */
export const exchangeLanes = ["legacy_chat", "successor"] as const;
export const exchangeLaneSchema = z.enum(exchangeLanes).catch("legacy_chat");
export type ExchangeLane = (typeof exchangeLanes)[number];

/** The trace's outcome, derived (never stored directly) — see {@link deriveExchangeOutcome}. */
export const exchangeOutcomes = ["ok", "degraded", "stopped", "failed", "incomplete"] as const;
export const exchangeOutcomeSchema = z.enum(exchangeOutcomes);
export type ExchangeOutcome = (typeof exchangeOutcomes)[number];

// ---------------------------------------------------------------------------
// Open vocabularies — any non-empty string is legal; these are recommendations
// so later slices converge on the same spelling, not a gate.
// ---------------------------------------------------------------------------

/** Recommended stage ids. Later slices use these exact strings; add to the list if more are needed. */
export const RECOMMENDED_EXCHANGE_STAGE_IDS = [
  "admission.lock",
  "admission.user_line",
  "state.load",
  "state.rollback",
  "state.drift",
  "history.window",
  "jobs.summary_enqueue",
  "ensemble.load",
  "prepare.recall",
  "prepare.beats",
  "prepare.presentation",
  "prepare.contact",
  "prepare.guidance",
  "narrator.prompt",
  "narrator.stream",
  "reply.persist",
  "settle.npc_decision_begin",
  "settle.finalize",
  "settle.members",
  "settle.wardrobe",
  "settle.npc_decision_finish",
  "settle.contact_events",
  "settle.permission",
  "post_turn.shadow",
  "jobs.scene_enqueue",
  "sim.admission",
  "sim.context",
  "sim.time",
  "sim.travel",
  "sim.turn",
  "sim.cut",
  "sim.narrator",
  "sim.persist",
] as const;
export type RecommendedExchangeStageId = (typeof RECOMMENDED_EXCHANGE_STAGE_IDS)[number];
/** Open: any non-empty string is a legal stage id; garbage degrades to "unknown". */
export const exchangeStageIdSchema = z.string().min(1).catch("unknown");

/** Recommended coverage families. */
export const RECOMMENDED_COVERAGE_FAMILIES = [
  "history",
  "summary",
  "memory.facts",
  "memory.episodes",
  "memory.callback",
  "scene",
  "actor_state",
  "relationship",
  "schedule_time",
  "physical_guidance",
  "visual_state",
  "garments",
  "affordances",
  "contact",
  "directives",
] as const;
export type RecommendedCoverageFamily = (typeof RECOMMENDED_COVERAGE_FAMILIES)[number];
/** Open: any non-empty string is a legal coverage family; garbage degrades to "unknown". */
export const exchangeCoverageFamilySchema = z.string().min(1).catch("unknown");

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * The sim-lane header fields. Every field is optional on the SCHEMA (not just
 * the type) so it can serve as a patch fragment at any part: `branchId` may be
 * known before `cutId`, and a patch that sets one must not be rejected for
 * omitting the other.
 */
export const exchangeSimHeaderSchema = z.object({
  branchId: z.string().min(1).optional().catch(undefined),
  cutId: z.string().min(1).optional().catch(undefined),
  branchVersion: z.number().int().nonnegative().optional().catch(undefined),
  fromSequence: z.number().int().nonnegative().optional().catch(undefined),
  throughSequence: z.number().int().nonnegative().optional().catch(undefined),
});
export type ExchangeSimHeader = z.infer<typeof exchangeSimHeaderSchema>;

/** One prompt unit's identity in the narrator's assembled system message. */
export const exchangePromptUnitSchema = z.object({
  id: z.string().catch(""),
  chars: z.number().int().nonnegative().catch(0),
  hash: z.string().catch(""),
});
export type ExchangePromptUnit = z.infer<typeof exchangePromptUnitSchema>;

/** The narrator-lane header fields — same all-optional-field rule as {@link exchangeSimHeaderSchema}. */
export const exchangeNarratorHeaderSchema = z.object({
  modelId: z.string().min(1).optional().catch(undefined),
  provider: z.string().optional().catch(undefined),
  attempts: z.number().int().nonnegative().optional().catch(undefined),
  finishReason: z.string().optional().catch(undefined),
  inputTokens: z.number().int().nonnegative().optional().catch(undefined),
  outputTokens: z.number().int().nonnegative().optional().catch(undefined),
  instructionHash: z.string().optional().catch(undefined),
  assembledSystemHash: z.string().optional().catch(undefined),
  promptUnits: z.array(exchangePromptUnitSchema).optional().catch(undefined),
});
export type ExchangeNarratorHeader = z.infer<typeof exchangeNarratorHeaderSchema>;

/**
 * A header PATCH — what `annotate()` records and what part 0's full header
 * also structurally is (the first and most complete patch). Every field is
 * independently optional: a key absent means "don't touch"; a key present
 * (including an explicit `null` on a nullable field) means "set it". See
 * {@link mergeExchangeTraceHeaderPatch}.
 */
export const exchangeTraceHeaderPatchSchema = z.object({
  traceId: z.string().min(1).optional().catch(undefined),
  chatId: z.string().min(1).optional().catch(undefined),
  operation: exchangeOperationSchema.optional().catch(undefined),
  authority: engineAuthoritySchema.catch(DEFAULT_ENGINE_AUTHORITY).optional().catch(undefined),
  lane: exchangeLaneSchema.optional().catch(undefined),
  startedAt: z.string().optional().catch(undefined),
  promptMessageId: z.string().min(1).nullable().optional().catch(undefined),
  replyMessageId: z.string().min(1).nullable().optional().catch(undefined),
  guardMessageId: z.string().min(1).nullable().optional().catch(undefined),
  sim: exchangeSimHeaderSchema.optional().catch(undefined),
  narrator: exchangeNarratorHeaderSchema.optional().catch(undefined),
});
export type ExchangeTraceHeaderPatch = z.infer<typeof exchangeTraceHeaderPatchSchema>;

/** The fully assembled header — every required field defaulted when no part ever set it. */
export interface AssembledTraceHeader {
  traceId: string;
  chatId: string;
  operation: ExchangeOperation;
  authority: EngineAuthority;
  lane: ExchangeLane;
  startedAt: string;
  promptMessageId: string | null;
  replyMessageId: string | null;
  guardMessageId: string | null;
  sim?: ExchangeSimHeader;
  narrator?: ExchangeNarratorHeader;
}

/** The degraded-default header: every required field has a safe, honest value (never a positive claim). */
export function emptyAssembledTraceHeader(traceId: string, chatId: string): AssembledTraceHeader {
  return {
    traceId,
    chatId,
    operation: "send",
    authority: DEFAULT_ENGINE_AUTHORITY,
    lane: "legacy_chat",
    startedAt: "",
    promptMessageId: null,
    replyMessageId: null,
    guardMessageId: null,
  };
}

/**
 * Apply one header patch onto a base (a full header, or another patch being
 * combined before its own flush). Generic so the SAME merge rule serves both
 * uses: a key PRESENT on the patch wins (including an explicit `null`); a key
 * ABSENT leaves the base alone. `sim` / `narrator` merge field-by-field rather
 * than replacing wholesale, so a later part can patch `narrator.instructionHash`
 * without erasing an earlier part's `narrator.modelId`.
 */
export function mergeExchangeTraceHeaderPatch<T extends ExchangeTraceHeaderPatch>(
  base: T,
  patch: ExchangeTraceHeaderPatch,
): T {
  const next: T = { ...base };
  if (patch.traceId !== undefined) next.traceId = patch.traceId;
  if (patch.chatId !== undefined) next.chatId = patch.chatId;
  if (patch.operation !== undefined) next.operation = patch.operation;
  if (patch.authority !== undefined) next.authority = patch.authority;
  if (patch.lane !== undefined) next.lane = patch.lane;
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
  if (patch.promptMessageId !== undefined) next.promptMessageId = patch.promptMessageId;
  if (patch.replyMessageId !== undefined) next.replyMessageId = patch.replyMessageId;
  if (patch.guardMessageId !== undefined) next.guardMessageId = patch.guardMessageId;
  if (patch.sim !== undefined) next.sim = { ...base.sim, ...patch.sim };
  if (patch.narrator !== undefined) next.narrator = { ...base.narrator, ...patch.narrator };
  return next;
}

// ---------------------------------------------------------------------------
// Stage / coverage / diagnostic / finish
// ---------------------------------------------------------------------------

/** One stage's model attribution, when it called an LLM. */
export const exchangeStageModelSchema = z.object({
  modelId: z.string().catch(""),
  provider: z.string().optional().catch(undefined),
  reasoningProfile: z.string().optional().catch(undefined),
});
export type ExchangeStageModel = z.infer<typeof exchangeStageModelSchema>;

/** Cross-references a stage carries to other rows (job, persisted ids). */
export const exchangeStageRefsSchema = z.object({
  jobId: z.string().optional().catch(undefined),
  rowIds: z.array(z.string()).optional().catch(undefined),
});
export type ExchangeStageRefs = z.infer<typeof exchangeStageRefsSchema>;

/**
 * One stage event. `seq` is the per-trace monotonic counter assigned when the
 * stage BEGAN (ordering by start time, even across several flushes). `reason`
 * is a stable code, conventionally required whenever `status !== "success"` —
 * enforced at the recorder's call sites, not here: a persisted row stays
 * readable even when an older writer omitted it.
 *
 * `detail` is the free-text sibling (per-stage, content-only — see the module
 * doc). It never appears on a production row's `stages` entry; the recorder
 * strips it to the sibling `stageDetails` content key, and the read model
 * hydrates it back here for a non-production read.
 */
export const exchangeStageEventSchema = z.object({
  seq: z.number().int().nonnegative().catch(0),
  stage: exchangeStageIdSchema,
  phase: exchangePhaseSchema,
  startedAt: z.string().catch(""),
  durationMs: z.number().int().nonnegative().nullable().catch(null),
  status: exchangeStageStatusSchema,
  reason: z.string().optional().catch(undefined),
  attempt: z.number().int().nonnegative().optional().catch(undefined),
  model: exchangeStageModelSchema.optional().catch(undefined),
  inputChars: z.number().int().nonnegative().optional().catch(undefined),
  outputChars: z.number().int().nonnegative().optional().catch(undefined),
  count: z.number().int().nonnegative().optional().catch(undefined),
  refs: exchangeStageRefsSchema.optional().catch(undefined),
  /** Free text, content-only (see module doc). Never present on a production row. */
  detail: z.string().optional().catch(undefined),
});
export type ExchangeStageEvent = z.infer<typeof exchangeStageEventSchema>;

/**
 * One coverage entry — the "did this context actually have what it needed?"
 * record, with `status` distinguishing MISSING (never fetched / unknown) from
 * EMPTY (fetched, genuinely nothing there). `summary` is the free-text sibling,
 * same content-only rule as stage `detail`.
 */
export const exchangeCoverageEntrySchema = z.object({
  family: exchangeCoverageFamilySchema,
  status: exchangeCoverageStatusSchema,
  reason: z.string().optional().catch(undefined),
  count: z.number().int().nonnegative().optional().catch(undefined),
  chars: z.number().int().nonnegative().optional().catch(undefined),
  hash: z.string().optional().catch(undefined),
  sourceIds: z.array(z.string()).optional().catch(undefined),
  /** Free text, content-only. Never present on a production row. */
  summary: z.string().optional().catch(undefined),
});
export type ExchangeCoverageEntry = z.infer<typeof exchangeCoverageEntrySchema>;

/**
 * One diagnostic entry attached to the trace — the structured half of an
 * app-wide {@link Diagnostic} (`severity`, `code`, `path`), plus the `seq` of
 * the stage that emitted it, when known. `message` is the free-text sibling,
 * same content-only rule; `context` is deliberately NOT carried (it can hold
 * arbitrary data, including request bodies — the one field this contract
 * refuses to persist in any form, per "never record secrets, headers, request
 * bodies, or reasoning").
 */
export const exchangeDiagnosticEntrySchema = z.object({
  severity: diagnosticSeveritySchema.catch("info"),
  code: z.string().min(1).catch("unknown"),
  path: z.string().optional().catch(undefined),
  seq: z.number().int().nonnegative().optional().catch(undefined),
  /** Free text, content-only. Never present on a production row. */
  message: z.string().optional().catch(undefined),
});
export type ExchangeDiagnosticEntry = z.infer<typeof exchangeDiagnosticEntrySchema>;

/** How the whole exchange ended. */
export const exchangeFinishRecordSchema = z.object({
  kind: exchangeFinishKindSchema,
  failureCode: z.enum(chatReplyFailureCodes).optional().catch(undefined),
  endedAt: z.string().catch(""),
  durationMs: z.number().int().nonnegative().catch(0),
});
export type ExchangeFinishRecord = z.infer<typeof exchangeFinishRecordSchema>;

// ---------------------------------------------------------------------------
// Persisted-part shape (one `events` row payload)
// ---------------------------------------------------------------------------

/** The `events.type` every flush writes under. */
export const CHAT_EXCHANGE_TRACE_EVENT = "chat_trace";

/** One correlated `{ seq, detail }` pair — the dev-only sibling for stage detail. */
const stageDetailContentSchema = z.object({
  seq: z.number().int().nonnegative().catch(-1),
  detail: z.string().catch(""),
});
/** One correlated `{ index, summary }` pair — the dev-only sibling for coverage summary. */
const coverageSummaryContentSchema = z.object({
  index: z.number().int().nonnegative().catch(-1),
  summary: z.string().catch(""),
});
/** One correlated `{ index, message }` pair — the dev-only sibling for diagnostic message. */
const diagnosticMessageContentSchema = z.object({
  index: z.number().int().nonnegative().catch(-1),
  message: z.string().catch(""),
});

/**
 * The raw shape of one flushed `events` row payload, INCLUDING the dev-only
 * sibling content keys when present (outside production, `logEvent` merges
 * them onto the row — server/events.ts). `v`, `traceId` and `part` are the
 * only fields with no catch: without a valid identity or ordering, the row
 * cannot be placed in any trace and {@link parseExchangeTracePart} reports it
 * as unreadable rather than guessing.
 */
export const exchangeTracePartSchema = z.object({
  v: z.literal(1),
  traceId: z.string().min(1),
  part: z.number().int().nonnegative(),
  header: exchangeTraceHeaderPatchSchema.optional().catch(undefined),
  stages: z.array(exchangeStageEventSchema).catch([]),
  coverage: z.array(exchangeCoverageEntrySchema).catch([]),
  diagnostics: z.array(exchangeDiagnosticEntrySchema).catch([]),
  finish: exchangeFinishRecordSchema.optional().catch(undefined),
  // Dev-only siblings (see the module doc's content-split). Absent in production.
  stageDetails: z.array(stageDetailContentSchema).catch([]).optional().catch(undefined),
  coverageSummaries: z.array(coverageSummaryContentSchema).catch([]).optional().catch(undefined),
  diagnosticMessages: z.array(diagnosticMessageContentSchema).catch([]).optional().catch(undefined),
});
type RawExchangeTracePart = z.infer<typeof exchangeTracePartSchema>;

/** One persisted part, hydrated: dev-only text (when present) merged back onto its owning entry. */
export interface ExchangeTracePart {
  v: 1;
  traceId: string;
  part: number;
  header?: ExchangeTraceHeaderPatch;
  stages: ExchangeStageEvent[];
  coverage: ExchangeCoverageEntry[];
  diagnostics: ExchangeDiagnosticEntry[];
  finish?: ExchangeFinishRecord;
}

function hydrateExchangeTracePart(raw: RawExchangeTracePart): ExchangeTracePart {
  const detailBySeq = new Map((raw.stageDetails ?? []).map((d) => [d.seq, d.detail]));
  const summaryByIndex = new Map((raw.coverageSummaries ?? []).map((d) => [d.index, d.summary]));
  const messageByIndex = new Map((raw.diagnosticMessages ?? []).map((d) => [d.index, d.message]));
  return {
    v: raw.v,
    traceId: raw.traceId,
    part: raw.part,
    ...(raw.header === undefined ? {} : { header: raw.header }),
    stages: raw.stages.map((stage) => {
      const detail = detailBySeq.get(stage.seq);
      return detail === undefined ? stage : { ...stage, detail };
    }),
    coverage: raw.coverage.map((entry, index) => {
      const summary = summaryByIndex.get(index);
      return summary === undefined ? entry : { ...entry, summary };
    }),
    diagnostics: raw.diagnostics.map((entry, index) => {
      const message = messageByIndex.get(index);
      return message === undefined ? entry : { ...entry, message };
    }),
    ...(raw.finish === undefined ? {} : { finish: raw.finish }),
  };
}

/**
 * Validate + hydrate one raw `events.payload` value into an {@link ExchangeTracePart}.
 * Returns `null` when the row's identity/ordering fields (`v` / `traceId` /
 * `part`) are not even structurally sound — every other field degrades through
 * its own `.catch()` instead of failing the whole row.
 */
export function parseExchangeTracePart(raw: unknown): ExchangeTracePart | null {
  const result = exchangeTracePartSchema.safeParse(raw);
  if (!result.success) return null;
  return hydrateExchangeTracePart(result.data);
}

/**
 * A cheap, tolerant peek at a raw row's `traceId` — used to attribute a row to
 * a trace (or to decide it cannot be attributed at all) BEFORE the full parse
 * above decides whether the row is otherwise readable. Never throws.
 */
export function peekExchangeTracePartTraceId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).traceId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Outcome + highlights
// ---------------------------------------------------------------------------

export interface ExchangeHighlights {
  firstFailedStage: ExchangeStageEvent | null;
  degradedStages: ExchangeStageEvent[];
  retriedStages: ExchangeStageEvent[];
  missingCoverage: ExchangeCoverageEntry[];
  degradedCoverage: ExchangeCoverageEntry[];
  suppressedCoverage: ExchangeCoverageEntry[];
  /** Each composition fallback, with the stage that produced it when linkable (see the derivation below). */
  fallbackStages: { fallback: CompositionFallback; stage: ExchangeStageEvent | null }[];
}

/**
 * Derive the outcome (docs: the design's outcome table) from persisted
 * evidence alone — never a positive claim beyond what was actually recorded.
 */
export function deriveExchangeOutcome(input: {
  finish: ExchangeFinishRecord | null;
  stages: readonly ExchangeStageEvent[];
  coverage: readonly ExchangeCoverageEntry[];
  diagnostics: readonly ExchangeDiagnosticEntry[];
  agentFailures: readonly AgentFailure[];
  compositionFallbacks: readonly CompositionFallback[];
}): { outcome: ExchangeOutcome; failureCode?: ChatReplyFailureCode } {
  const { finish } = input;
  if (!finish) return { outcome: "incomplete" };
  if (finish.kind === "failed") {
    return finish.failureCode === undefined ? { outcome: "failed" } : { outcome: "failed", failureCode: finish.failureCode };
  }
  if (finish.kind === "stopped") return { outcome: "stopped" };

  const degraded =
    input.stages.some((s) => s.status === "degraded" || s.status === "failed" || s.status === "retried") ||
    input.coverage.some((c) => c.status === "degraded" || c.status === "missing") ||
    input.diagnostics.some((d) => d.severity === "error" || d.severity === "warn") ||
    input.agentFailures.length > 0 ||
    input.compositionFallbacks.length > 0;
  return { outcome: degraded ? "degraded" : "ok" };
}

/**
 * Best-effort link from a composition fallback to the stage that produced it:
 * a fallback carries a `messageId` (the beat/reply it attached to), and a
 * stage names the rows it touched in `refs.rowIds`. When the fallback's
 * `messageId` appears in some stage's `refs.rowIds`, that stage is the
 * producer; otherwise the link is honestly `null` rather than guessed — a
 * fallback still SHOWS, just without a stage attribution.
 */
function linkCompositionFallbackStage(
  fallback: CompositionFallback,
  stages: readonly ExchangeStageEvent[],
): ExchangeStageEvent | null {
  if (!fallback.messageId) return null;
  return stages.find((stage) => stage.refs?.rowIds?.includes(fallback.messageId as string) ?? false) ?? null;
}

/** Derive the trace's highlights — the inspector's "what needs a look" summary. */
export function deriveExchangeHighlights(input: {
  stages: readonly ExchangeStageEvent[];
  coverage: readonly ExchangeCoverageEntry[];
  compositionFallbacks: readonly CompositionFallback[];
}): ExchangeHighlights {
  const bySeqAsc = [...input.stages].sort((a, b) => a.seq - b.seq);
  return {
    firstFailedStage: bySeqAsc.find((s) => s.status === "failed") ?? null,
    degradedStages: input.stages.filter((s) => s.status === "degraded"),
    retriedStages: input.stages.filter((s) => s.status === "retried"),
    missingCoverage: input.coverage.filter((c) => c.status === "missing"),
    degradedCoverage: input.coverage.filter((c) => c.status === "degraded"),
    suppressedCoverage: input.coverage.filter((c) => c.status === "suppressed"),
    fallbackStages: input.compositionFallbacks.map((fallback) => ({
      fallback,
      stage: linkCompositionFallbackStage(fallback, input.stages),
    })),
  };
}

// ---------------------------------------------------------------------------
// Assembled trace
// ---------------------------------------------------------------------------

export interface AssembledTrace {
  traceId: string;
  chatId: string;
  header: AssembledTraceHeader;
  stages: ExchangeStageEvent[];
  coverage: ExchangeCoverageEntry[];
  diagnostics: ExchangeDiagnosticEntry[];
  finish: ExchangeFinishRecord | null;
  outcome: ExchangeOutcome;
  failureCode?: ChatReplyFailureCode;
  highlights: ExchangeHighlights;
  agentRuns: AgentRun[];
  agentFailures: AgentFailure[];
  compositionFallbacks: CompositionFallback[];
  /** How many of `parts` were dropped as unreadable (identity/ordering fields unsound). */
  unreadableParts: number;
}

export interface AssembleExchangeTraceInput {
  traceId: string;
  chatId: string;
  /** Raw `events.payload` values (any order) — this trace's own rows, as scanned. */
  parts: readonly unknown[];
  agentRuns?: readonly AgentRun[];
  agentFailures?: readonly AgentFailure[];
  compositionFallbacks?: readonly CompositionFallback[];
}

/**
 * Turn persisted parts plus correlated agent/fallback rows into one ordered
 * trace (#637 acceptance #2). PURE — every input is already in memory.
 *
 * - A raw part whose own `traceId` does not match `input.traceId` (including
 *   one too malformed to tell) is silently NOT this trace's — never counted.
 * - A raw part that DOES carry this trace's id but fails full validation is
 *   dropped and counted in {@link AssembledTrace.unreadableParts}.
 * - Header patches merge in `part` order ({@link mergeExchangeTraceHeaderPatch}).
 * - Stages are deduped by `seq`, keeping the HIGHEST-`part` occurrence — the
 *   mechanism that lets a still-open stage's provisional snapshot (flushed
 *   while open) be superseded by its real completion once a later flush
 *   carries it. Coverage and diagnostics are append-only across parts. The
 *   LAST part carrying a `finish` wins.
 */
export function assembleExchangeTrace(input: AssembleExchangeTraceInput): AssembledTrace {
  const validParts: ExchangeTracePart[] = [];
  let unreadableParts = 0;
  for (const raw of input.parts) {
    const traceId = peekExchangeTracePartTraceId(raw);
    if (traceId !== input.traceId) continue;
    const parsed = parseExchangeTracePart(raw);
    if (parsed === null) {
      unreadableParts += 1;
      continue;
    }
    validParts.push(parsed);
  }
  validParts.sort((a, b) => a.part - b.part);

  let header = emptyAssembledTraceHeader(input.traceId, input.chatId);
  const stagesBySeq = new Map<number, ExchangeStageEvent>();
  const coverage: ExchangeCoverageEntry[] = [];
  const diagnostics: ExchangeDiagnosticEntry[] = [];
  let finish: ExchangeFinishRecord | null = null;

  for (const part of validParts) {
    if (part.header !== undefined) header = mergeExchangeTraceHeaderPatch(header, part.header);
    for (const stage of part.stages) stagesBySeq.set(stage.seq, stage);
    coverage.push(...part.coverage);
    diagnostics.push(...part.diagnostics);
    if (part.finish !== undefined) finish = part.finish;
  }

  const stages = [...stagesBySeq.values()].sort((a, b) => a.seq - b.seq);
  const agentRuns = [...(input.agentRuns ?? [])];
  const agentFailures = [...(input.agentFailures ?? [])];
  const compositionFallbacks = [...(input.compositionFallbacks ?? [])];

  const { outcome, failureCode } = deriveExchangeOutcome({ finish, stages, coverage, diagnostics, agentFailures, compositionFallbacks });
  const highlights = deriveExchangeHighlights({ stages, coverage, compositionFallbacks });

  return {
    traceId: header.traceId,
    chatId: header.chatId,
    header,
    stages,
    coverage,
    diagnostics,
    finish,
    outcome,
    ...(failureCode === undefined ? {} : { failureCode }),
    highlights,
    agentRuns,
    agentFailures,
    compositionFallbacks,
    unreadableParts,
  };
}

// ---------------------------------------------------------------------------
// Versioned JSON output — the CLI `--json` and the inspector API both emit this
// ---------------------------------------------------------------------------

export const EXCHANGE_TRACE_SCHEMA_VERSION = 1;

export interface ExchangeTraceJsonOutput {
  schemaVersion: 1;
  chatId: string;
  traces: AssembledTrace[];
}

/** Build the versioned output both consumers emit. PURE. */
export function buildExchangeTraceJsonOutput(chatId: string, traces: readonly AssembledTrace[]): ExchangeTraceJsonOutput {
  return { schemaVersion: EXCHANGE_TRACE_SCHEMA_VERSION, chatId, traces: [...traces] };
}

/** Schemas that PIN the assembled/output shape (tests parse the builder's own output through
 * these), so the CLI and the inspector — both future consumers — cannot silently drift apart. */
export const assembledTraceHeaderSchema = z.object({
  traceId: z.string(),
  chatId: z.string(),
  operation: exchangeOperationSchema,
  authority: engineAuthoritySchema.catch(DEFAULT_ENGINE_AUTHORITY),
  lane: exchangeLaneSchema,
  startedAt: z.string(),
  promptMessageId: z.string().nullable(),
  replyMessageId: z.string().nullable(),
  guardMessageId: z.string().nullable(),
  sim: exchangeSimHeaderSchema.optional(),
  narrator: exchangeNarratorHeaderSchema.optional(),
});

export const exchangeHighlightsSchema = z.object({
  firstFailedStage: exchangeStageEventSchema.nullable(),
  degradedStages: z.array(exchangeStageEventSchema),
  retriedStages: z.array(exchangeStageEventSchema),
  missingCoverage: z.array(exchangeCoverageEntrySchema),
  degradedCoverage: z.array(exchangeCoverageEntrySchema),
  suppressedCoverage: z.array(exchangeCoverageEntrySchema),
  fallbackStages: z.array(z.object({ fallback: compositionFallbackSchema, stage: exchangeStageEventSchema.nullable() })),
});

export const assembledTraceSchema = z.object({
  traceId: z.string(),
  chatId: z.string(),
  header: assembledTraceHeaderSchema,
  stages: z.array(exchangeStageEventSchema),
  coverage: z.array(exchangeCoverageEntrySchema),
  diagnostics: z.array(exchangeDiagnosticEntrySchema),
  finish: exchangeFinishRecordSchema.nullable(),
  outcome: exchangeOutcomeSchema,
  failureCode: z.enum(chatReplyFailureCodes).optional(),
  highlights: exchangeHighlightsSchema,
  agentRuns: z.array(agentRunSchema),
  agentFailures: z.array(agentFailureSchema),
  compositionFallbacks: z.array(compositionFallbackSchema),
  unreadableParts: z.number().int().nonnegative(),
});

export const exchangeTraceJsonOutputSchema = z.object({
  schemaVersion: z.literal(EXCHANGE_TRACE_SCHEMA_VERSION),
  chatId: z.string(),
  traces: z.array(assembledTraceSchema),
});

// Re-exported so a caller of this module never needs a second import just to
// hand a `diagnostics()` call the app-wide Diagnostic type.
export type { Diagnostic };
