import "dotenv/config";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  buildExchangeTraceJsonOutput,
  type AssembledTrace,
  type ExchangeCoverageEntry,
  type ExchangeCoverageStatus,
  type ExchangeDiagnosticEntry,
  type ExchangeHighlights,
  type ExchangeStageEvent,
  type ExchangeStageStatus,
} from "@/contracts/turns/chat-exchange-trace";
import { characterChats, db } from "@/server/db";
import { loadChatExchangeTraces, type LoadChatExchangeTracesQuery } from "@/server/memory";

/**
 * THE #637 EXCHANGE-TRACE CLI — an operator or coding agent's window onto one
 * chat's per-turn execution traces, reading the exact same persisted data and
 * the exact same read model (`loadChatExchangeTraces`, `@/server/memory`) as
 * the admin chat inspector. This file never queries `events` itself and never
 * re-derives outcome/highlights — every figure printed here is read straight
 * off slice A's `AssembledTrace` (`@/contracts/turns/chat-exchange-trace`), so
 * the CLI cannot drift from the inspector's notion of what happened.
 *
 * Pattern follows `scripts/npc-scene-decision-report.ts`: `dotenv/config` for
 * local env loading, a `--help` usage block, and a pure rendering layer
 * (`renderTraceReport` and its helpers) that takes already-assembled traces —
 * no database, no clock — which is what lets `chat-trace.test.ts` pin the
 * argument parsing and the report layout without a Postgres.
 *
 *   pnpm trace:chat --chat <chatId> [--latest | --message <id> | --trace <id> | --limit <n>] [--json]
 *
 * Locally it reads `DATABASE_URL` through dotenv, exactly like every other
 * root script. Against production, run it on the machine that holds the
 * database — the same trusted-environment boundary `report:npc-scene-decisions`
 * uses; there is no additional web authentication here:
 *
 *   fly ssh console -a vesper -C "pnpm trace:chat --chat <id> --latest --json"
 *
 * If the SSH tunnel is unavailable, the fallback reaches the same machine
 * through the Machines API instead:
 *
 *   fly machine exec <machine-id> -a vesper 'pnpm trace:chat --chat <id> --latest --json'
 *
 * Production traces carry NO TEXT by design (the contract's module doc): a
 * stage's `detail`, a coverage entry's `summary`, and a diagnostic's `message`
 * are dropped before they ever reach a production `events` row, so a trace
 * read from the deployed app shows ids, enums, stable codes, counts, sizes,
 * durations, and hashes — never prompt or reply prose.
 */

const USAGE = [
  "Usage: pnpm trace:chat --chat <chatId> [options]",
  "  --chat <chatId>      the chat to read traces for (required)",
  "  --latest             the single most recently active trace (default)",
  "  --message <id>       the trace whose header names this message as prompt/reply/guard",
  "  --trace <id>         exactly this trace id",
  "  --limit <n>          the n most recently active traces (1-50)",
  "  --json               print the contract's versioned JSON output instead of the text report",
  "  --help               print this and exit",
  "",
  "Exactly one of --latest, --message, --trace, --limit may be given; --latest is the default",
  "when none is given.",
].join("\n");

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/** A bad flag is the operator's typo, not a crash: the boundary prints the reason plus USAGE. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type TraceSelector =
  | { readonly kind: "latest" }
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "trace"; readonly traceId: string }
  | { readonly kind: "limit"; readonly limit: number };

export type ParsedArgs =
  | { readonly help: true }
  | { readonly help: false; readonly chatId: string; readonly selector: TraceSelector; readonly json: boolean };

const BOOLEAN_FLAGS = new Set(["help", "latest", "json"]);
const VALUE_FLAGS = new Set(["chat", "message", "trace", "limit"]);

/** Parse `--limit`'s value: an integer in [1, 50], per the contract's own `loadChatExchangeTraces` cap. */
function parseLimit(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new UsageError(`--limit must be an integer between 1 and 50: ${raw}`);
  }
  return parsed;
}

/**
 * Pure argv parser — no IO, so the exit-code table's usage-error rows
 * (missing `--chat`, conflicting selectors, bad `--limit`, an unknown flag)
 * are unit-testable without touching a database. `--help` short-circuits
 * every other validation, exactly like `report:npc-scene-decisions`.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let chatId: string | undefined;
  let json = false;
  let help = false;
  let latest = false;
  let messageId: string | undefined;
  let traceId: string | undefined;
  let limitRaw: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      throw new UsageError(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);

    if (BOOLEAN_FLAGS.has(key)) {
      if (key === "help") help = true;
      else if (key === "latest") latest = true;
      else if (key === "json") json = true;
      continue;
    }

    if (VALUE_FLAGS.has(key)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`--${key} requires a value`);
      }
      index += 1;
      if (key === "chat") chatId = value;
      else if (key === "message") messageId = value;
      else if (key === "trace") traceId = value;
      else if (key === "limit") limitRaw = value;
      continue;
    }

    throw new UsageError(`unknown flag: ${token}`);
  }

  if (help) return { help: true };

  if (chatId === undefined || chatId === "") {
    throw new UsageError("--chat <chatId> is required");
  }

  const selectorCount = [latest, messageId !== undefined, traceId !== undefined, limitRaw !== undefined].filter(
    Boolean,
  ).length;
  if (selectorCount > 1) {
    throw new UsageError("specify exactly one of --latest, --message, --trace, --limit");
  }

  let selector: TraceSelector;
  if (messageId !== undefined) {
    selector = { kind: "message", messageId };
  } else if (traceId !== undefined) {
    selector = { kind: "trace", traceId };
  } else if (limitRaw !== undefined) {
    selector = { kind: "limit", limit: parseLimit(limitRaw) };
  } else {
    selector = { kind: "latest" };
  }

  return { help: false, chatId, selector, json };
}

/** The read model's query shape for each selector — the only place selector → query is decided. */
export function selectorQuery(chatId: string, selector: TraceSelector): LoadChatExchangeTracesQuery {
  switch (selector.kind) {
    case "latest":
      return { chatId };
    case "message":
      return { chatId, messageId: selector.messageId };
    case "trace":
      return { chatId, traceId: selector.traceId };
    case "limit":
      return { chatId, limit: selector.limit };
  }
}

/** The exit-1 message for "chat exists, no trace matches" — worded by what the operator asked for. */
export function noTraceFoundMessage(chatId: string, selector: TraceSelector): string {
  switch (selector.kind) {
    case "latest":
      return `no trace found: chat ${chatId} has no recorded exchange traces`;
    case "limit":
      return `no trace found: chat ${chatId} has no recorded exchange traces`;
    case "trace":
      return `no trace found: chat ${chatId} has no trace ${selector.traceId}`;
    case "message":
      return `no trace found: chat ${chatId} has no trace naming message ${selector.messageId}`;
  }
}

// ---------------------------------------------------------------------------
// Pure rendering — no IO, no clock. Everything printed is read off AssembledTrace.
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 18;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

/** Marks the statuses the acceptance calls out as visually distinct; "success" carries no marker. */
function statusMarker(status: ExchangeStageStatus): string {
  switch (status) {
    case "failed":
    case "degraded":
    case "retried":
    case "skipped":
    case "blocked":
      return `[${status.toUpperCase()}]`;
    case "success":
      return "";
  }
}

function durationText(durationMs: number | null): string {
  return durationMs === null ? "n/a" : `${durationMs}ms`;
}

function renderHeader(trace: AssembledTrace): string[] {
  const header = trace.header;
  const outcomeText = trace.failureCode === undefined ? trace.outcome : `${trace.outcome} (${trace.failureCode})`;
  return [
    line("trace id", trace.traceId),
    line("chat id", trace.chatId),
    line("prompt message", header.promptMessageId ?? "n/a"),
    line("reply message", header.replyMessageId ?? "n/a"),
    line("guard message", header.guardMessageId ?? "n/a"),
    line("operation", header.operation),
    line("authority / lane", `${header.authority} / ${header.lane}`),
    line("started at", header.startedAt === "" ? "n/a" : header.startedAt),
    // Never rendered as "success" when no finish was ever recorded — deriveExchangeOutcome
    // (slice A) already returns "incomplete" for that case; this line only ever echoes it.
    line("outcome", outcomeText),
    line("duration", trace.finish === null ? "n/a" : durationText(trace.finish.durationMs)),
  ];
}

/** `seq`, stage, phase, status, duration, reason, attempt, model, sizes — one line, marked. */
function renderStage(stage: ExchangeStageEvent): string {
  const marker = statusMarker(stage.status);
  const sizes: string[] = [];
  if (stage.inputChars !== undefined) sizes.push(`in=${stage.inputChars}c`);
  if (stage.outputChars !== undefined) sizes.push(`out=${stage.outputChars}c`);
  if (stage.count !== undefined) sizes.push(`count=${stage.count}`);
  const modelText =
    stage.model === undefined
      ? undefined
      : `${stage.model.modelId}${stage.model.provider === undefined ? "" : ` (${stage.model.provider})`}`;

  const fields = [
    `seq=${stage.seq}`,
    `stage=${stage.stage}`, // unknown/garbage ids render verbatim — no lookup table here
    `phase=${stage.phase}`,
    `status=${stage.status}`,
    `duration=${durationText(stage.durationMs)}`,
    ...(stage.reason === undefined ? [] : [`reason=${stage.reason}`]),
    ...(stage.attempt === undefined ? [] : [`attempt=${stage.attempt}`]),
    ...(modelText === undefined ? [] : [`model=${modelText}`]),
    ...(sizes.length === 0 ? [] : [`sizes=${sizes.join(",")}`]),
  ];
  return `${marker === "" ? "  " : `${marker} `}${fields.join("  ")}`;
}

/** Grouped by status, missing/degraded/suppressed first (the acceptance's exact order). */
const COVERAGE_STATUS_DISPLAY_ORDER: readonly ExchangeCoverageStatus[] = [
  "missing",
  "degraded",
  "suppressed",
  "present",
  "empty",
];

function renderCoverageEntry(entry: ExchangeCoverageEntry): string {
  const extras: string[] = [];
  if (entry.reason !== undefined) extras.push(`reason=${entry.reason}`);
  if (entry.count !== undefined) extras.push(`count=${entry.count}`);
  if (entry.chars !== undefined) extras.push(`chars=${entry.chars}`);
  if (entry.hash !== undefined) extras.push(`hash=${entry.hash}`);
  return `  ${entry.family}${extras.length === 0 ? "" : `  ${extras.join("  ")}`}`; // unknown families render verbatim
}

function renderCoverage(coverage: readonly ExchangeCoverageEntry[]): string[] {
  if (coverage.length === 0) return ["coverage: (none)"];
  const out: string[] = [];
  for (const status of COVERAGE_STATUS_DISPLAY_ORDER) {
    const entries = coverage.filter((entry) => entry.status === status);
    if (entries.length === 0) continue;
    out.push(`coverage: ${status} (${entries.length})`);
    for (const entry of entries) out.push(renderCoverageEntry(entry));
  }
  return out;
}

function renderCorrelated(trace: AssembledTrace): string[] {
  const out: string[] = [];
  out.push(`agent runs: ${trace.agentRuns.length}`);
  for (const run of trace.agentRuns) {
    out.push(`  ${run.legId}  model=${run.modelId || "n/a"}  latency=${run.latencyMs}ms`);
  }
  out.push(`agent failures: ${trace.agentFailures.length}`);
  for (const failure of trace.agentFailures) {
    out.push(`  ${failure.legId}  kind=${failure.kind}  cause=${failure.cause}`);
  }
  out.push(`composition fallbacks: ${trace.compositionFallbacks.length}`);
  for (const fallback of trace.compositionFallbacks) {
    out.push(`  site=${fallback.site}  code=${fallback.code}`);
  }
  return out;
}

function renderDiagnostics(diagnostics: readonly ExchangeDiagnosticEntry[]): string[] {
  if (diagnostics.length === 0) return ["diagnostics: (none)"];
  const out = [`diagnostics (${diagnostics.length})`];
  for (const diagnostic of diagnostics) {
    out.push(`  [${diagnostic.severity}] ${diagnostic.code}${diagnostic.path === undefined ? "" : `  path=${diagnostic.path}`}`);
  }
  return out;
}

function stageLabels(stages: readonly ExchangeStageEvent[]): string {
  return stages.length === 0 ? "none" : stages.map((stage) => `${stage.stage} (seq=${stage.seq})`).join(", ");
}

function coverageLabels(entries: readonly ExchangeCoverageEntry[]): string {
  return entries.length === 0 ? "none" : entries.map((entry) => entry.family).join(", ");
}

function renderHighlights(highlights: ExchangeHighlights): string[] {
  const out = ["highlights:"];
  out.push(
    `  first failed stage: ${
      highlights.firstFailedStage === null
        ? "none"
        : `${highlights.firstFailedStage.stage} (seq=${highlights.firstFailedStage.seq})`
    }`,
  );
  out.push(`  degraded stages: ${stageLabels(highlights.degradedStages)}`);
  out.push(`  retried stages: ${stageLabels(highlights.retriedStages)}`);
  out.push(`  missing coverage: ${coverageLabels(highlights.missingCoverage)}`);
  out.push(`  degraded coverage: ${coverageLabels(highlights.degradedCoverage)}`);
  out.push(`  suppressed coverage: ${coverageLabels(highlights.suppressedCoverage)}`);
  out.push(
    `  fallback stages: ${
      highlights.fallbackStages.length === 0
        ? "none"
        : highlights.fallbackStages
            .map((entry) => `${entry.fallback.code}${entry.stage === null ? "" : ` @ ${entry.stage.stage}`}`)
            .join(", ")
    }`,
  );
  return out;
}

/** One trace's full report, in the acceptance's exact order: header, stages, coverage, correlated, diagnostics, highlights. */
function renderTrace(trace: AssembledTrace): string {
  const out: string[] = [...renderHeader(trace), ""];
  out.push("stages:");
  if (trace.stages.length === 0) out.push("  (none)");
  for (const stage of trace.stages) out.push(renderStage(stage));
  out.push("");
  out.push(...renderCoverage(trace.coverage));
  out.push("");
  out.push(...renderCorrelated(trace));
  out.push("");
  out.push(...renderDiagnostics(trace.diagnostics));
  out.push("");
  out.push(...renderHighlights(trace.highlights));
  if (trace.unreadableParts > 0) {
    out.push("", `${trace.unreadableParts} persisted part(s) for this trace were unreadable and are excluded above.`);
  }
  return out.join("\n");
}

/** The whole human-readable report, pure over already-assembled traces — what `--json` also emits, laid out for a person. */
export function renderTraceReport(chatId: string, traces: readonly AssembledTrace[]): string {
  if (traces.length === 0) return `No traces for chat ${chatId}.`;
  return traces
    .map((trace, index) => `=== trace ${index + 1} of ${traces.length}: ${trace.traceId} ===\n${renderTrace(trace)}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** The one direct query this script is allowed: a bounded existence check by id. */
async function chatExists(chatId: string): Promise<boolean> {
  const rows = await db().select({ id: characterChats.id }).from(characterChats).where(eq(characterChats.id, chatId)).limit(1);
  return rows.length > 0;
}

function oneLineError(error: unknown): string {
  if (error instanceof Error) {
    const [first = error.message] = error.message.split("\n");
    return first;
  }
  return String(error);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const exists = await chatExists(args.chatId);
  if (!exists) {
    console.error(`chat not found: ${args.chatId}`);
    process.exit(1);
  }

  const traces = await loadChatExchangeTraces(selectorQuery(args.chatId, args.selector));

  if (traces.length === 0) {
    // Exit 1 either way, but --json still gets a valid, parseable document on stdout.
    if (args.json) {
      console.log(JSON.stringify(buildExchangeTraceJsonOutput(args.chatId, []), null, 2));
    }
    console.error(noTraceFoundMessage(args.chatId, args.selector));
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(buildExchangeTraceJsonOutput(args.chatId, traces), null, 2));
  } else {
    console.log(renderTraceReport(args.chatId, traces));
  }
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(oneLineError(error));
    process.exit(1);
  });
}
