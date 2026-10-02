import { newId } from "@/lib/ids";
import type { EngineAuthority } from "@vesper/simulation-core/contracts/authority";
import type { Diagnostic } from "@/contracts/diagnostics";
import {
  CHAT_EXCHANGE_TRACE_EVENT,
  exchangeCoverageEntrySchema,
  exchangeDiagnosticEntrySchema,
  exchangeFinishRecordSchema,
  exchangeStageEventSchema,
  exchangeTraceHeaderPatchSchema,
  mergeExchangeTraceHeaderPatch,
  type ExchangeCoverageEntry,
  type ExchangeCoverageStatus,
  type ExchangeDiagnosticEntry,
  type ExchangeFinishKind,
  type ExchangeFinishRecord,
  type ExchangeLane,
  type ExchangeOperation,
  type ExchangePhase,
  type ExchangeStageEvent,
  type ExchangeStageModel,
  type ExchangeStageRefs,
  type ExchangeStageStatus,
  type ExchangeTraceHeaderPatch,
} from "@/contracts/turns/chat-exchange-trace";
import type { ChatReplyFailureCode } from "@/contracts/turns/chat-reply-failure";
import { logEvent } from "../events";

/**
 * The exchange-trace RECORDER (#637) — the server side that buffers one
 * chat exchange's trace in memory and flushes it as batched `events` rows
 * (`type = "chat_trace"`). Contract + pure assembler live in
 * `contracts/turns/chat-exchange-trace.ts`; this module owns the only IO
 * (`logEvent`) and the only mutable state.
 *
 * Mirrors the two closest precedents closely:
 * - `server/ai/agent-failures.ts`: pure `build*` + fire-and-forget `record*`,
 *   payload vs `content`.
 * - `server/events.ts` / `buildEventRow`: the production/dev content split,
 *   never written to directly — every flush goes through `logEvent`.
 *
 * **Every method catches its own errors. Nothing this module does may throw
 * into or delay the caller.** `time()` is the one exception to "swallow and
 * move on": it is explicitly transparent, so it rethrows the ORIGINAL error
 * from the wrapped function after recording the stage as failed — the
 * recorder's own bookkeeping around that rethrow is still guarded so a bug in
 * the recorder can never mask the real error.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** What a caller knows about a stage's outcome — passed to `end()` / `record()` / `time()`'s `classify`. */
export interface ExchangeStageResult {
  status?: ExchangeStageStatus;
  /** A stable code, conventionally required whenever `status !== "success"`. */
  reason?: string;
  attempt?: number;
  model?: ExchangeStageModel;
  inputChars?: number;
  outputChars?: number;
  count?: number;
  refs?: ExchangeStageRefs;
  /** Free text (content-only — never on a production row). */
  detail?: string;
}

export interface ExchangeStageHandle {
  /** End the stage this handle was returned for. Safe to call at most once; a second call is a no-op. */
  end(result?: ExchangeStageResult): void;
}

/** A pre-timed or instantaneous stage, for `record()`. */
export interface ExchangeStageInput extends ExchangeStageResult {
  stage: string;
  phase: ExchangePhase;
  /** Defaults to now. */
  startedAt?: Date;
  /** Defaults to `null` (unknown / instantaneous). */
  durationMs?: number | null;
}

export interface ExchangeCoverageInput {
  family: string;
  status: ExchangeCoverageStatus;
  /** Required (by convention) for `missing | suppressed | degraded`. */
  reason?: string;
  count?: number;
  chars?: number;
  hash?: string;
  sourceIds?: readonly string[];
  /** Free text (content-only). */
  summary?: string;
}

export interface ExchangeFinishInput {
  kind: ExchangeFinishKind;
  failureCode?: ChatReplyFailureCode;
}

export interface ExchangeTrace {
  readonly traceId: string;
  /** Patch the header — merges onto whatever is pending for the next flush. */
  annotate(patch: ExchangeTraceHeaderPatch): void;
  /** Begin a stage; returns a handle whose `end()` closes it out. */
  begin(stage: string, phase: ExchangePhase, opts?: { startedAt?: Date }): ExchangeStageHandle;
  /** Record a pre-timed or instantaneous stage (typically `skipped` / `blocked`) in one call. */
  record(event: ExchangeStageInput): void;
  /**
   * Time an async unit of work as one stage. Transparent: returns `fn()`'s
   * value, and on a thrown error records the stage as `failed` (reason
   * `"exception"`, the error's message as `detail`) and RETHROWS THE
   * ORIGINAL ERROR unchanged.
   */
  time<T>(
    stage: string,
    phase: ExchangePhase,
    fn: () => Promise<T>,
    classify?: (value: T) => Partial<ExchangeStageResult>,
  ): Promise<T>;
  coverage(entry: ExchangeCoverageInput): void;
  /** Attach diagnostics, optionally stamped with the `seq` of the stage that emitted them. */
  diagnostics(items: readonly Diagnostic[], seq?: number): void;
  finish(f: ExchangeFinishInput): void;
  /** Fire-and-forget, idempotent: writes only items not yet written. */
  flush(): void;
}

export interface StartExchangeTraceInit {
  chatId: string;
  operation: ExchangeOperation;
  authority: EngineAuthority;
  lane: ExchangeLane;
  promptMessageId?: string | null;
  /** Injectable for tests; defaults to now. */
  at?: Date;
}

/** Mint a new trace and start buffering. Call sites never construct the recorder class directly. */
export function startExchangeTrace(init: StartExchangeTraceInit): ExchangeTrace {
  return new ExchangeTraceRecorder(init);
}

const NOOP_HANDLE: ExchangeStageHandle = { end: () => {} };

/** Every method a no-op; `traceId` is `""`. For callers without a trace — `time()` still runs `fn()` untouched. */
const NOOP_EXCHANGE_TRACE: ExchangeTrace = {
  traceId: "",
  annotate: () => {},
  begin: () => NOOP_HANDLE,
  record: () => {},
  time: (_stage, _phase, fn) => fn(),
  coverage: () => {},
  diagnostics: () => {},
  finish: () => {},
  flush: () => {},
};

export function noopExchangeTrace(): ExchangeTrace {
  return NOOP_EXCHANGE_TRACE;
}

// ---------------------------------------------------------------------------
// Pure row-building rule (unit-tested without a database)
// ---------------------------------------------------------------------------

/** One in-memory flush's worth of validated, ready-to-split data. */
export interface ExchangeTraceFlushDraft {
  v: 1;
  traceId: string;
  part: number;
  header?: ExchangeTraceHeaderPatch;
  stages: readonly ExchangeStageEvent[];
  coverage: readonly ExchangeCoverageEntry[];
  diagnostics: readonly ExchangeDiagnosticEntry[];
  finish?: ExchangeFinishRecord;
}

export interface ExchangeTraceEventRow {
  payload: Record<string, unknown>;
  content: Record<string, unknown>;
}

/**
 * PURE: split the free text (stage `detail` / coverage `summary` / diagnostic
 * `message`) out of the structured arrays, so the production payload never
 * carries roleplay-adjacent text (docs/resilience.md). The dev-only content
 * keys (`stageDetails` / `coverageSummaries` / `diagnosticMessages`) are NEW
 * top-level names that cannot collide with the payload's own `stages` /
 * `coverage` / `diagnostics` arrays — `buildEventRow` spreads payload last
 * (server/events.ts), so a colliding content key would always lose; distinct
 * names are what let the dev-only text actually survive the merge.
 */
export function buildExchangeTraceEventRow(draft: ExchangeTraceFlushDraft): ExchangeTraceEventRow {
  const stageDetails: { seq: number; detail: string }[] = [];
  const stages = draft.stages.map((entry) => {
    const { detail, ...rest } = entry;
    if (detail) stageDetails.push({ seq: entry.seq, detail });
    return rest;
  });

  const coverageSummaries: { index: number; summary: string }[] = [];
  const coverage = draft.coverage.map((entry, index) => {
    const { summary, ...rest } = entry;
    if (summary) coverageSummaries.push({ index, summary });
    return rest;
  });

  const diagnosticMessages: { index: number; message: string }[] = [];
  const diagnostics = draft.diagnostics.map((entry, index) => {
    const { message, ...rest } = entry;
    if (message) diagnosticMessages.push({ index, message });
    return rest;
  });

  const payload: Record<string, unknown> = {
    v: draft.v,
    traceId: draft.traceId,
    part: draft.part,
    stages,
    coverage,
    diagnostics,
  };
  if (draft.header !== undefined) payload.header = draft.header;
  if (draft.finish !== undefined) payload.finish = draft.finish;

  const content: Record<string, unknown> = {};
  if (stageDetails.length > 0) content.stageDetails = stageDetails;
  if (coverageSummaries.length > 0) content.coverageSummaries = coverageSummaries;
  if (diagnosticMessages.length > 0) content.diagnosticMessages = diagnosticMessages;

  return { payload, content };
}

// ---------------------------------------------------------------------------
// The stateful recorder
// ---------------------------------------------------------------------------

/** A stage begun but not yet ended — mutable until `.end()` closes it out. */
interface OpenStageDraft {
  seq: number;
  stage: string;
  phase: ExchangePhase;
  startedAt: Date;
  ended: boolean;
  /** Has this still-open stage already been flushed once with no status (its "last known state")? */
  flushedOnce: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class ExchangeTraceRecorder implements ExchangeTrace {
  readonly traceId: string;
  private readonly chatId: string;
  private readonly startedAt: Date;
  private part = 0;
  private seq = 0;
  private pendingHeaderPatch: ExchangeTraceHeaderPatch | undefined;
  private readonly openStages = new Map<number, OpenStageDraft>();
  /** Completed stages (from `end()` or `record()`), ready for the next flush, keyed by seq. */
  private readonly readyStages = new Map<number, ExchangeStageEvent>();
  private pendingCoverage: ExchangeCoverageEntry[] = [];
  private pendingDiagnostics: ExchangeDiagnosticEntry[] = [];
  private pendingFinish: ExchangeFinishRecord | undefined;

  constructor(init: StartExchangeTraceInit) {
    this.traceId = newId();
    this.chatId = init.chatId;
    this.startedAt = init.at ?? new Date();
    // Seeded here so the FIRST flush always carries the full header — the
    // design's "written in part 0" rule falls out of this for free, since
    // nothing can flush before the constructor runs.
    this.pendingHeaderPatch = exchangeTraceHeaderPatchSchema.parse({
      traceId: this.traceId,
      chatId: init.chatId,
      operation: init.operation,
      authority: init.authority,
      lane: init.lane,
      startedAt: this.startedAt.toISOString(),
      promptMessageId: init.promptMessageId ?? null,
      replyMessageId: null,
      guardMessageId: null,
    });
  }

  annotate(patch: ExchangeTraceHeaderPatch): void {
    try {
      const parsed = exchangeTraceHeaderPatchSchema.parse(patch);
      this.pendingHeaderPatch =
        this.pendingHeaderPatch === undefined ? parsed : mergeExchangeTraceHeaderPatch(this.pendingHeaderPatch, parsed);
    } catch {
      // never throw
    }
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  begin(stage: string, phase: ExchangePhase, opts?: { startedAt?: Date }): ExchangeStageHandle {
    try {
      const seq = this.nextSeq();
      const draft: OpenStageDraft = {
        seq,
        stage,
        phase,
        startedAt: opts?.startedAt ?? new Date(),
        ended: false,
        flushedOnce: false,
      };
      this.openStages.set(seq, draft);
      return { end: (result) => this.endStage(seq, result) };
    } catch {
      return NOOP_HANDLE;
    }
  }

  private endStage(seq: number, result?: ExchangeStageResult): void {
    try {
      const draft = this.openStages.get(seq);
      if (!draft || draft.ended) return;
      draft.ended = true;
      const endedAt = new Date();
      const event = exchangeStageEventSchema.parse({
        seq: draft.seq,
        stage: draft.stage,
        phase: draft.phase,
        startedAt: draft.startedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - draft.startedAt.getTime()),
        status: result?.status ?? "success",
        ...(result?.reason === undefined ? {} : { reason: result.reason }),
        ...(result?.attempt === undefined ? {} : { attempt: result.attempt }),
        ...(result?.model === undefined ? {} : { model: result.model }),
        ...(result?.inputChars === undefined ? {} : { inputChars: result.inputChars }),
        ...(result?.outputChars === undefined ? {} : { outputChars: result.outputChars }),
        ...(result?.count === undefined ? {} : { count: result.count }),
        ...(result?.refs === undefined ? {} : { refs: result.refs }),
        ...(result?.detail === undefined ? {} : { detail: result.detail }),
      });
      this.readyStages.set(seq, event);
      this.openStages.delete(seq);
    } catch {
      // never throw
    }
  }

  record(event: ExchangeStageInput): void {
    try {
      const seq = this.nextSeq();
      const parsed = exchangeStageEventSchema.parse({
        seq,
        stage: event.stage,
        phase: event.phase,
        startedAt: (event.startedAt ?? new Date()).toISOString(),
        durationMs: event.durationMs ?? null,
        status: event.status ?? "skipped",
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.inputChars === undefined ? {} : { inputChars: event.inputChars }),
        ...(event.outputChars === undefined ? {} : { outputChars: event.outputChars }),
        ...(event.count === undefined ? {} : { count: event.count }),
        ...(event.refs === undefined ? {} : { refs: event.refs }),
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
      this.readyStages.set(seq, parsed);
    } catch {
      // never throw
    }
  }

  async time<T>(
    stage: string,
    phase: ExchangePhase,
    fn: () => Promise<T>,
    classify?: (value: T) => Partial<ExchangeStageResult>,
  ): Promise<T> {
    const handle = this.begin(stage, phase);
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      try {
        handle.end({ status: "failed", reason: "exception", detail: errorMessage(err) });
      } catch {
        // the recorder must never mask the original error with one of its own
      }
      throw err;
    }
    try {
      const partial = classify ? classify(value) : {};
      handle.end({ status: "success", ...partial });
    } catch {
      // swallow — recording must never affect an already-resolved value
    }
    return value;
  }

  coverage(entry: ExchangeCoverageInput): void {
    try {
      this.pendingCoverage.push(exchangeCoverageEntrySchema.parse(entry));
    } catch {
      // never throw
    }
  }

  diagnostics(items: readonly Diagnostic[], seq?: number): void {
    try {
      for (const item of items) {
        this.pendingDiagnostics.push(
          exchangeDiagnosticEntrySchema.parse({
            severity: item.severity,
            code: item.code,
            ...(item.path === undefined ? {} : { path: item.path }),
            ...(seq === undefined ? {} : { seq }),
            ...(item.message ? { message: item.message } : {}),
          }),
        );
      }
    } catch {
      // never throw
    }
  }

  finish(f: ExchangeFinishInput): void {
    try {
      const endedAt = new Date();
      this.pendingFinish = exchangeFinishRecordSchema.parse({
        kind: f.kind,
        ...(f.failureCode === undefined ? {} : { failureCode: f.failureCode }),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, endedAt.getTime() - this.startedAt.getTime()),
      });
    } catch {
      // never throw
    }
  }

  flush(): void {
    try {
      const stages = [...this.readyStages.values()];
      this.readyStages.clear();

      // Still-open handles get ONE provisional, honest snapshot per flush
      // cycle — never re-written while still unchanged (idempotent: "writes
      // only unflushed items"). `status` is deliberately omitted: the
      // schema's own `.catch("failed")` is the honest "never heard back"
      // reading, never a false "success".
      for (const draft of this.openStages.values()) {
        if (draft.flushedOnce) continue;
        draft.flushedOnce = true;
        stages.push(
          exchangeStageEventSchema.parse({
            seq: draft.seq,
            stage: draft.stage,
            phase: draft.phase,
            startedAt: draft.startedAt.toISOString(),
            durationMs: null,
          }),
        );
      }

      const coverage = this.pendingCoverage;
      this.pendingCoverage = [];
      const diagnostics = this.pendingDiagnostics;
      this.pendingDiagnostics = [];
      const header = this.pendingHeaderPatch;
      this.pendingHeaderPatch = undefined;
      const finish = this.pendingFinish;
      this.pendingFinish = undefined;

      const nothingToWrite =
        stages.length === 0 && coverage.length === 0 && diagnostics.length === 0 && header === undefined && finish === undefined;
      if (nothingToWrite) return;

      const part = this.part;
      this.part += 1;
      const draft: ExchangeTraceFlushDraft = {
        v: 1,
        traceId: this.traceId,
        part,
        ...(header === undefined ? {} : { header }),
        stages,
        coverage,
        diagnostics,
        ...(finish === undefined ? {} : { finish }),
      };
      const { payload, content } = buildExchangeTraceEventRow(draft);
      void logEvent(CHAT_EXCHANGE_TRACE_EVENT, payload, { chatId: this.chatId, content }).catch(() => {});
    } catch {
      // flush must never throw into the caller
    }
  }
}
