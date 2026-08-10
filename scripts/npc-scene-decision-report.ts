import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { characterChatMessages, chatNpcSceneDecisions, db } from "@/server/db";
import {
  chatNpcReplyHash,
  npcSceneDecisionModes,
  npcSceneDecisionStatuses,
  parseNpcSceneDecisionPayload,
  type NpcSceneDecisionActionKind,
  type NpcSceneDecisionDropReason,
  type NpcSceneDecisionMode,
  type NpcSceneDecisionPayload,
  type NpcSceneDecisionResolution,
  type NpcSceneDecisionSlotOutcome,
  type NpcSceneDecisionStatus,
} from "@/server/engine";

/**
 * THE SHADOW-GATE REPORT over `chat_npc_scene_decisions`
 * (romantic-contact-affordances.spec.actor-control.md §"Execution, flags, and
 * cost gate"): the figures the owner rules on before NPC movement authority is
 * enabled — trigger fire rate and misses, candidate acceptance and drop
 * reasons, p50/p95/p99 added settle latency, timeout rate, and cost per 100
 * replies. One envelope row IS one included reply, trigger-miss tombstones
 * included, so the denominators need no reconstruction.
 *
 * Every figure is SPLIT BY MODE. A `shadow` envelope and an `authority`
 * envelope record the same admission work (the spec's continuity guarantee),
 * but only the shadow rows answer "what would authority have done"; mixing them
 * into one rate would measure two different questions at once.
 *
 * Two things this report deliberately does NOT do:
 *
 * 1. **It claims no accuracy.** False positives and false negatives are a human
 *    judgment about prose, so `--review-out` exports the labelling corpus
 *    (one JSONL line per envelope, decision beside the reply it was made about)
 *    and the accuracy pass happens outside this script.
 * 2. **It never prints unknown as zero.** Cost telemetry is optional and older
 *    builds wrote none, so every cost figure carries its covered-row count and
 *    a total with uncosted calls behind it is labelled a floor.
 *
 *   pnpm report:npc-scene-decisions [--since <ISO>] [--until <ISO>] [--chat <id>]
 *                                   [--mode shadow|authority] [--json]
 *                                   [--review-out <path>]
 *                                   [--price-in <usd/M>] [--price-out <usd/M>]
 *
 * Locally it reads `DATABASE_URL` through dotenv. Against production, run it on
 * the machine that holds the database:
 *
 *   fly ssh console -a vesper -C "pnpm report:npc-scene-decisions --mode shadow"
 *
 * The aggregation (`aggregateNpcSceneDecisionReport`) and the renderer are pure
 * over already-parsed rows — no database, no clock — which is what lets
 * `npc-scene-decision-report.test.ts` pin the arithmetic without a Postgres.
 */

const USAGE = [
  "Usage: pnpm report:npc-scene-decisions [options]",
  "  --since <ISO>        only envelopes created at or after this instant",
  "  --until <ISO>        only envelopes created at or before this instant",
  "  --chat <chatId>      restrict to one chat",
  "  --mode shadow|authority   restrict to one mode (default: both, always split)",
  "  --json               print the computed report object instead of the text report",
  "  --review-out <path>  write the JSONL human-review corpus to this path",
  "  --price-in <usd/M>   fallback input price per million tokens",
  "  --price-out <usd/M>  fallback output price per million tokens",
  "  --help               print this and exit",
].join("\n");

/** How many distinct `detail` values to show under each kind × resolution group. */
const TOP_DETAIL_VALUES = 5;

// ---------------------------------------------------------------------------
// The pure report's input
// ---------------------------------------------------------------------------

/**
 * The optional usage half of the envelope's telemetry — the spend and the added
 * settle latency the cost gate is stated in.
 *
 * Read off the STORED blob rather than the parsed payload on purpose, for two
 * reasons that both cost real money if ignored: a payload that fails its schema
 * degrades to the EMPTY payload, which would erase the spend of a call that
 * really happened; and the schema strips keys it does not know, so a build
 * writing a usage field this deployment has not caught up with would be read as
 * having spent nothing. Absent is absent here — never 0.
 */
export interface NpcSceneDecisionUsageTelemetry {
  /** Milliseconds this leg ADDED to settlement (the spec's added settle latency). */
  readonly settleWaitMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/** One envelope as the pure aggregation sees it: plain data, no db handles, no `Date`s. */
export interface NpcSceneDecisionReportRow {
  readonly chatId: string;
  readonly assistantMessageId: string;
  /** ISO-8601 UTC (`Date#toISOString`) — fixed width, so min/max is a string compare. */
  readonly createdAt: string;
  readonly mode: NpcSceneDecisionMode;
  readonly status: NpcSceneDecisionStatus;
  readonly storyMinute: number;
  readonly replyHash: string;
  /** Already through `parseNpcSceneDecisionPayload` — this type never carries a raw blob. */
  readonly payload: NpcSceneDecisionPayload;
  readonly usage: NpcSceneDecisionUsageTelemetry;
}

/** Fallback pricing for fired calls that recorded tokens but no cost. */
export interface NpcSceneDecisionPricing {
  readonly inputPerMillionUsd?: number;
  readonly outputPerMillionUsd?: number;
}

// ---------------------------------------------------------------------------
// The pure report's output
// ---------------------------------------------------------------------------

export interface NpcSceneDecisionWindow {
  readonly from: string;
  readonly to: string;
}

export interface NpcSceneDecisionPercentiles {
  /** Sample size — the coverage number every percentile must be read beside. */
  readonly samples: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface NpcSceneDecisionDetailCount {
  readonly detail: string;
  readonly count: number;
}

export interface NpcSceneDecisionActionGroup {
  readonly kind: NpcSceneDecisionActionKind;
  readonly resolution: NpcSceneDecisionResolution;
  readonly count: number;
  readonly topDetails: readonly NpcSceneDecisionDetailCount[];
}

export interface NpcSceneDecisionDropGroup {
  readonly reason: NpcSceneDecisionDropReason;
  readonly count: number;
  /** Scaled over EVERY envelope in the group (misses included) — the spec's per-hundred-replies unit. */
  readonly per100Replies: number | null;
}

export interface NpcSceneDecisionAcceptance {
  /** Admitted tier-2 actions: `movement` and `contact` only. */
  readonly admitted: number;
  readonly dropped: number;
  readonly candidates: number;
  readonly rate: number | null;
}

export interface NpcSceneDecisionCostSummary {
  readonly firedRows: number;
  /** Fired calls whose telemetry recorded a cost outright. */
  readonly recordedRows: number;
  readonly recordedUsd: number;
  /** Fired calls costed from token counts at the supplied fallback prices. */
  readonly pricedRows: number;
  readonly pricedUsd: number;
  readonly costedRows: number;
  readonly costedUsd: number;
  /** Fired calls whose cost is UNKNOWN — never folded into a total as zero. */
  readonly uncostedRows: number;
  /** True when every fired call is costed; false makes every total below a floor. */
  readonly complete: boolean;
  readonly meanUsdPerCostedCall: number | null;
  /** `costedUsd` scaled to 100 envelopes — a floor while `complete` is false. */
  readonly per100RepliesUsd: number | null;
  /** The same figure with uncosted calls priced at the costed mean; null when nothing is missing or nothing is costed. */
  readonly per100RepliesEstimatedUsd: number | null;
}

export interface NpcSceneDecisionTokenSummary {
  readonly firedRows: number;
  /** Fired calls carrying at least one token count. */
  readonly rowsWithTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface NpcSceneDecisionModelCount {
  readonly model: string;
  readonly count: number;
}

export interface NpcSceneDecisionModeReport {
  readonly mode: NpcSceneDecisionMode;
  readonly envelopes: number;
  readonly window: NpcSceneDecisionWindow | null;
  readonly status: Record<NpcSceneDecisionStatus, number>;
  /** Fired = the classifier was launched: `evaluated` + `degraded`. */
  readonly fired: number;
  readonly triggerFireRate: number | null;
  readonly triggerMisses: number;
  readonly triggerMissRate: number | null;
  readonly degradedRateAmongFired: number | null;
  readonly timedOut: number;
  readonly timeoutRateAmongFired: number | null;
  /** Fired rows whose telemetry never landed (empty payload / degraded parse) — excluded from latency. */
  readonly telemetryUnavailable: number;
  readonly classifierLatencyMs: NpcSceneDecisionPercentiles;
  readonly addedSettleLatencyMs: NpcSceneDecisionPercentiles;
  readonly slots: Record<"movement" | "contact", Record<NpcSceneDecisionSlotOutcome, number>>;
  readonly actions: readonly NpcSceneDecisionActionGroup[];
  readonly drops: readonly NpcSceneDecisionDropGroup[];
  readonly acceptance: NpcSceneDecisionAcceptance;
  readonly cost: NpcSceneDecisionCostSummary;
  readonly tokens: NpcSceneDecisionTokenSummary;
  readonly models: readonly NpcSceneDecisionModelCount[];
}

export interface NpcSceneDecisionReport {
  readonly envelopes: number;
  readonly window: NpcSceneDecisionWindow | null;
  /** Echoed so a `--json` dump states the cost assumption it was computed under. */
  readonly pricing: {
    readonly inputPerMillionUsd: number | null;
    readonly outputPerMillionUsd: number | null;
  };
  readonly groups: readonly NpcSceneDecisionModeReport[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A rate whose denominator is zero has no value — `null`, so the renderer prints "n/a" rather than 0%. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Nearest-rank percentiles on the sorted sample: the value at 0-based index
 * `ceil(p * n) - 1`, clamped into range. No interpolation — over the double- to
 * triple-digit samples a shadow window produces, an interpolated p99 reports a
 * latency no call actually took. An empty sample has no percentile at all.
 */
function percentiles(sample: readonly number[]): NpcSceneDecisionPercentiles {
  const sorted = [...sample].sort((left, right) => left - right);
  const at = (ratio: number): number | null => {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
    return sorted[index] ?? null;
  };
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/**
 * Did this reply actually spend a classifier call? A `trigger_miss` never
 * reached the model, so it is a free reply in the denominator and no part of
 * any latency, timeout, token, or cost numerator.
 */
function isFired(status: NpcSceneDecisionStatus): boolean {
  switch (status) {
    case "evaluated":
    case "degraded":
      return true;
    case "trigger_miss":
      return false;
  }
}

/**
 * Is this action a tier-2 CANDIDATE (the thing acceptance measures)? The frozen
 * ending floor and the presence fold are neither proposed nor droppable — their
 * authority predates this leg — so they never enter the acceptance ratio.
 */
function isTierTwo(kind: NpcSceneDecisionActionKind): boolean {
  switch (kind) {
    case "movement":
    case "contact":
      return true;
    case "floor_ending":
    case "presence_ending":
      return false;
  }
}

/** Descending by count, then by key, so equal counts print in a stable order. */
function topCounts(counts: ReadonlyMap<string, number>, limit: number): [string, number][] {
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, limit);
}

function windowOf(rows: readonly NpcSceneDecisionReportRow[]): NpcSceneDecisionWindow | null {
  let from: string | null = null;
  let to: string | null = null;
  for (const row of rows) {
    if (from === null || row.createdAt < from) from = row.createdAt;
    if (to === null || row.createdAt > to) to = row.createdAt;
  }
  return from === null || to === null ? null : { from, to };
}

/**
 * Fallback pricing for one fired call. BOTH token counts and BOTH prices are
 * required: pricing half a call would quietly understate the total, and the one
 * rule this report keeps about cost is that unknown is never zero.
 */
function priceFromTokens(
  usage: NpcSceneDecisionUsageTelemetry,
  pricing: NpcSceneDecisionPricing,
): number | null {
  const { inputTokens, outputTokens } = usage;
  const { inputPerMillionUsd, outputPerMillionUsd } = pricing;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  if (inputPerMillionUsd === undefined || outputPerMillionUsd === undefined) return null;
  return (inputTokens / 1_000_000) * inputPerMillionUsd + (outputTokens / 1_000_000) * outputPerMillionUsd;
}

// ---------------------------------------------------------------------------
// The aggregation
// ---------------------------------------------------------------------------

function tallyStatuses(rows: readonly NpcSceneDecisionReportRow[]): Record<NpcSceneDecisionStatus, number> {
  // Written out rather than folded from the enum so a new status is a type
  // error here instead of a silently missing line in the report.
  const counts: Record<NpcSceneDecisionStatus, number> = { trigger_miss: 0, degraded: 0, evaluated: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * Slot outcomes over FIRED rows only: "absent" on a trigger miss means no model
 * was asked, not that the model omitted a slot, and mixing the two would make
 * the malformed rate look better the more often the trigger stayed quiet.
 */
function tallySlots(
  fired: readonly NpcSceneDecisionReportRow[],
): Record<"movement" | "contact", Record<NpcSceneDecisionSlotOutcome, number>> {
  const slots: Record<"movement" | "contact", Record<NpcSceneDecisionSlotOutcome, number>> = {
    movement: { absent: 0, malformed: 0, parsed: 0 },
    contact: { absent: 0, malformed: 0, parsed: 0 },
  };
  for (const row of fired) {
    slots.movement[row.payload.slots.movement] += 1;
    slots.contact[row.payload.slots.contact] += 1;
  }
  return slots;
}

/** Candidate outcomes: the GROUP BY kind × resolution the envelope's bounded enums exist for. */
function tallyActions(rows: readonly NpcSceneDecisionReportRow[]): readonly NpcSceneDecisionActionGroup[] {
  interface Accumulator {
    kind: NpcSceneDecisionActionKind;
    resolution: NpcSceneDecisionResolution;
    count: number;
    details: Map<string, number>;
  }
  const groups = new Map<string, Accumulator>();
  for (const row of rows) {
    for (const action of row.payload.actions) {
      const key = `${action.kind}|${action.resolution}`;
      const group: Accumulator = groups.get(key) ?? {
        kind: action.kind,
        resolution: action.resolution,
        count: 0,
        details: new Map<string, number>(),
      };
      group.count += 1;
      // The whole detail string is the key: a detail may carry a bounded
      // suffix ("shadow_admitted_not_executed composite_departure"), and the
      // suffix is exactly the distinction a reviewer is looking for.
      group.details.set(action.detail, (group.details.get(action.detail) ?? 0) + 1);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      kind: group.kind,
      resolution: group.resolution,
      count: group.count,
      topDetails: topCounts(group.details, TOP_DETAIL_VALUES).map(([detail, total]) => ({ detail, count: total })),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        `${left.kind} ${left.resolution}`.localeCompare(`${right.kind} ${right.resolution}`),
    );
}

/** Drop reasons, absolute and per hundred replies — a GROUP BY over the bounded enum, never a regex. */
function tallyDrops(
  rows: readonly NpcSceneDecisionReportRow[],
  envelopes: number,
): readonly NpcSceneDecisionDropGroup[] {
  const counts = new Map<NpcSceneDecisionDropReason, number>();
  for (const row of rows) {
    for (const drop of row.payload.drops) counts.set(drop.reason, (counts.get(drop.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, total]) => {
      const share = rate(total, envelopes);
      return { reason, count: total, per100Replies: share === null ? null : share * 100 };
    });
}

function tallyModels(fired: readonly NpcSceneDecisionReportRow[]): readonly NpcSceneDecisionModelCount[] {
  const counts = new Map<string, number>();
  for (const row of fired) {
    const model = row.payload.telemetry.model;
    if (model === "") continue;
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return topCounts(counts, counts.size).map(([model, total]) => ({ model, count: total }));
}

function summarizeCost(
  fired: readonly NpcSceneDecisionReportRow[],
  envelopes: number,
  pricing: NpcSceneDecisionPricing,
): NpcSceneDecisionCostSummary {
  let recordedRows = 0;
  let recordedUsd = 0;
  let pricedRows = 0;
  let pricedUsd = 0;
  for (const row of fired) {
    const recorded = row.usage.costUsd;
    if (recorded !== undefined) {
      recordedRows += 1;
      recordedUsd += recorded;
      continue;
    }
    const priced = priceFromTokens(row.usage, pricing);
    if (priced !== null) {
      pricedRows += 1;
      pricedUsd += priced;
    }
  }
  const costedRows = recordedRows + pricedRows;
  const costedUsd = recordedUsd + pricedUsd;
  const uncostedRows = fired.length - costedRows;
  const meanUsdPerCostedCall = costedRows === 0 ? null : costedUsd / costedRows;
  // Per 100 REPLIES, not per 100 calls: a trigger miss is a real reply that
  // cost nothing, so it belongs in the denominator at its true price of zero.
  const observedShare = costedRows === 0 ? null : rate(costedUsd, envelopes);
  const estimated =
    meanUsdPerCostedCall === null || uncostedRows === 0
      ? null
      : rate(costedUsd + meanUsdPerCostedCall * uncostedRows, envelopes);
  return {
    firedRows: fired.length,
    recordedRows,
    recordedUsd,
    pricedRows,
    pricedUsd,
    costedRows,
    costedUsd,
    uncostedRows,
    complete: uncostedRows === 0,
    meanUsdPerCostedCall,
    per100RepliesUsd: observedShare === null ? null : observedShare * 100,
    per100RepliesEstimatedUsd: estimated === null ? null : estimated * 100,
  };
}

function summarizeTokens(fired: readonly NpcSceneDecisionReportRow[]): NpcSceneDecisionTokenSummary {
  let rowsWithTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of fired) {
    const input = row.usage.inputTokens;
    const output = row.usage.outputTokens;
    if (input === undefined && output === undefined) continue;
    rowsWithTokens += 1;
    inputTokens += input ?? 0;
    outputTokens += output ?? 0;
  }
  return { firedRows: fired.length, rowsWithTokens, inputTokens, outputTokens };
}

function buildModeReport(
  mode: NpcSceneDecisionMode,
  rows: readonly NpcSceneDecisionReportRow[],
  pricing: NpcSceneDecisionPricing,
): NpcSceneDecisionModeReport {
  const status = tallyStatuses(rows);
  const fired = rows.filter((row) => isFired(row.status));
  // A payload that failed its schema degrades to the empty payload, whose model
  // is "" — so an unreadable row and a row from a build that recorded no
  // telemetry look the same here, and both are reported as unavailable rather
  // than contributing a fictitious 0 ms sample.
  const withTelemetry = fired.filter((row) => row.payload.telemetry.model !== "");
  const settleWaits = fired.flatMap((row) => (row.usage.settleWaitMs === undefined ? [] : [row.usage.settleWaitMs]));
  const admitted = rows.reduce(
    (total, row) => total + row.payload.actions.filter((action) => isTierTwo(action.kind)).length,
    0,
  );
  const dropped = rows.reduce((total, row) => total + row.payload.drops.length, 0);
  // A timeout can only be reported by telemetry that survived, so this rate is
  // a floor whenever `telemetryUnavailable` is nonzero.
  const timedOut = fired.filter((row) => row.payload.telemetry.timedOut).length;

  return {
    mode,
    envelopes: rows.length,
    window: windowOf(rows),
    status,
    fired: fired.length,
    triggerFireRate: rate(fired.length, rows.length),
    triggerMisses: status.trigger_miss,
    triggerMissRate: rate(status.trigger_miss, rows.length),
    degradedRateAmongFired: rate(status.degraded, fired.length),
    timedOut,
    timeoutRateAmongFired: rate(timedOut, fired.length),
    telemetryUnavailable: fired.length - withTelemetry.length,
    classifierLatencyMs: percentiles(withTelemetry.map((row) => row.payload.telemetry.latencyMs)),
    addedSettleLatencyMs: percentiles(settleWaits),
    slots: tallySlots(fired),
    actions: tallyActions(rows),
    drops: tallyDrops(rows, rows.length),
    acceptance: {
      admitted,
      dropped,
      candidates: admitted + dropped,
      rate: rate(admitted, admitted + dropped),
    },
    cost: summarizeCost(fired, rows.length, pricing),
    tokens: summarizeTokens(fired),
    models: tallyModels(fired),
  };
}

/**
 * The whole report, pure over already-parsed rows. Groups follow the mode
 * vocabulary's own order (shadow first — it is the one under review), and a
 * mode with no rows in the window contributes no group at all.
 */
export function aggregateNpcSceneDecisionReport(
  rows: readonly NpcSceneDecisionReportRow[],
  pricing: NpcSceneDecisionPricing = {},
): NpcSceneDecisionReport {
  return {
    envelopes: rows.length,
    window: windowOf(rows),
    pricing: {
      inputPerMillionUsd: pricing.inputPerMillionUsd ?? null,
      outputPerMillionUsd: pricing.outputPerMillionUsd ?? null,
    },
    groups: npcSceneDecisionModes.flatMap((mode) => {
      const inMode = rows.filter((row) => row.mode === mode);
      return inMode.length === 0 ? [] : [buildModeReport(mode, inMode, pricing)];
    }),
  };
}

// ---------------------------------------------------------------------------
// The human-review corpus
// ---------------------------------------------------------------------------

export interface NpcSceneDecisionReviewLine {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly createdAt: string;
  readonly mode: NpcSceneDecisionMode;
  readonly status: NpcSceneDecisionStatus;
  readonly storyMinute: number;
  readonly replyHash: string;
  readonly reply: string | null;
  readonly slots: NpcSceneDecisionPayload["slots"];
  readonly actions: readonly {
    readonly kind: NpcSceneDecisionActionKind;
    readonly span: { readonly start: number; readonly end: number };
    readonly summary: string;
    readonly resolution: NpcSceneDecisionResolution;
    readonly detail: string;
  }[];
  readonly drops: NpcSceneDecisionPayload["drops"];
  readonly telemetry: NpcSceneDecisionPayload["telemetry"] & NpcSceneDecisionUsageTelemetry;
}

/**
 * One labelling line: the decision beside the exact reply it was made about.
 *
 * `reply` is `character_chat_messages.content`, which mirrors the ACTIVE take —
 * so a reply retaken after this decision would show the reviewer prose the
 * decision never read. `replyHash` is the sha256 of the decided bytes, which is
 * how a reviewer (and the export summary) tells those apart: hash the reply, and
 * a mismatch means the text moved. `null` is a reply row that vanished under
 * the join.
 *
 * The action's provenance blob, quote hash, and ledger references are left out
 * deliberately: this file is read by a person judging whether the decision
 * matches the prose, and replay material is noise in that job (the envelope row
 * itself keeps all of it). Each DROP row is the exception that proves the rule —
 * it carries the bounded verbatim evidence excerpt the candidate was grounded
 * on, because judging a drop is judging whether the gate read the right
 * sentence, which nothing but the quote itself can answer.
 */
export function reviewCorpusLine(row: NpcSceneDecisionReportRow, reply: string | null): NpcSceneDecisionReviewLine {
  return {
    chatId: row.chatId,
    assistantMessageId: row.assistantMessageId,
    createdAt: row.createdAt,
    mode: row.mode,
    status: row.status,
    storyMinute: row.storyMinute,
    replyHash: row.replyHash,
    reply,
    slots: row.payload.slots,
    actions: row.payload.actions.map((action) => ({
      kind: action.kind,
      span: action.span,
      summary: action.summary,
      resolution: action.resolution,
      detail: action.detail,
    })),
    drops: row.payload.drops,
    telemetry: { ...row.payload.telemetry, ...row.usage },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 30;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

function millis(value: number | null): string {
  return value === null ? "n/a" : count(Math.round(value));
}

function percentileText(summary: NpcSceneDecisionPercentiles): string {
  return `n=${count(summary.samples)}  p50 ${millis(summary.p50)}  p95 ${millis(summary.p95)}  p99 ${millis(summary.p99)}`;
}

function windowText(bounds: NpcSceneDecisionWindow | null): string {
  return bounds === null ? "n/a" : `${bounds.from} → ${bounds.to}`;
}

function slotText(counts: Record<NpcSceneDecisionSlotOutcome, number>): string {
  return `parsed ${count(counts.parsed)} · absent ${count(counts.absent)} · malformed ${count(counts.malformed)}`;
}

function renderCost(cost: NpcSceneDecisionCostSummary): string[] {
  const coverage = `over ${count(cost.costedRows)} of ${count(cost.firedRows)} fired call(s)`;
  const out = [
    line("cost recorded", `${count(cost.recordedRows)} row(s)  ${usd(cost.recordedUsd)}`),
    line("cost priced from tokens", `${count(cost.pricedRows)} row(s)  ${usd(cost.pricedUsd)}`),
    line("cost uncosted (unknown)", `${count(cost.uncostedRows)} row(s)`),
  ];
  if (cost.costedRows === 0) {
    out.push(line("cost total", `n/a — no fired call carries cost telemetry (${coverage})`));
    out.push(line("cost per 100 replies", "n/a — supply --price-in/--price-out, or wait for cost telemetry"));
    return out;
  }
  const qualifier = cost.complete ? "complete" : "FLOOR — uncosted calls are unknown, not zero";
  out.push(line("cost total", `${usd(cost.costedUsd)} ${coverage} — ${qualifier}`));
  out.push(line("cost per costed call", usd(cost.meanUsdPerCostedCall)));
  const per100 = `${usd(cost.per100RepliesUsd)}${cost.complete ? "" : " (floor)"}`;
  const estimate =
    cost.per100RepliesEstimatedUsd === null
      ? ""
      : `  ·  estimate ${usd(cost.per100RepliesEstimatedUsd)} (uncosted priced at the costed mean)`;
  out.push(line("cost per 100 replies", `${per100}${estimate}`));
  return out;
}

function renderGroup(group: NpcSceneDecisionModeReport): string[] {
  const out: string[] = ["", `── mode: ${group.mode} ${"─".repeat(Math.max(0, 46 - group.mode.length))}`];
  out.push(line("envelopes (= replies)", count(group.envelopes)));
  out.push(line("window (createdAt)", windowText(group.window)));
  out.push(line("status evaluated", count(group.status.evaluated)));
  out.push(line("status degraded", count(group.status.degraded)));
  out.push(line("status trigger_miss", count(group.status.trigger_miss)));
  out.push(line("trigger fire rate", `${pct(group.triggerFireRate)}  (${count(group.fired)} fired)`));
  out.push(line("trigger misses", `${count(group.triggerMisses)}  ${pct(group.triggerMissRate)}`));
  out.push(line("degraded among fired", `${count(group.status.degraded)}  ${pct(group.degradedRateAmongFired)}`));
  out.push(line("timed out among fired", `${count(group.timedOut)}  ${pct(group.timeoutRateAmongFired)}`));
  out.push(line("telemetry unavailable", `${count(group.telemetryUnavailable)}  (excluded from latency)`));
  out.push(line("classifier latency ms", percentileText(group.classifierLatencyMs)));
  out.push(
    line(
      "added settle latency ms",
      `${percentileText(group.addedSettleLatencyMs)}  (${count(group.addedSettleLatencyMs.samples)} of ${count(group.fired)} fired)`,
    ),
  );
  out.push(line("slots movement (fired)", slotText(group.slots.movement)));
  out.push(line("slots contact (fired)", slotText(group.slots.contact)));

  out.push("actions (kind × resolution)");
  if (group.actions.length === 0) out.push("  (none)");
  for (const action of group.actions) {
    const details = action.topDetails
      .map((entry) => `${entry.detail === "" ? "(no detail)" : entry.detail} ${count(entry.count)}`)
      .join(" · ");
    out.push(line(`  ${action.kind} → ${action.resolution}`, `${count(action.count)}${details === "" ? "" : `   ${details}`}`));
  }

  out.push(`drops (per 100 of ${count(group.envelopes)} replies)`);
  if (group.drops.length === 0) out.push("  (none)");
  for (const drop of group.drops) {
    const per100 = drop.per100Replies === null ? "n/a" : drop.per100Replies.toFixed(1);
    out.push(line(`  ${drop.reason}`, `${count(drop.count)}   ${per100} per 100`));
  }

  out.push(
    line(
      "tier-2 acceptance",
      `${count(group.acceptance.admitted)} admitted / ${count(group.acceptance.candidates)} candidate(s)   ${pct(group.acceptance.rate)}`,
    ),
  );
  out.push(...renderCost(group.cost));
  out.push(
    line(
      "tokens",
      `in ${count(group.tokens.inputTokens)} / out ${count(group.tokens.outputTokens)}  over ${count(group.tokens.rowsWithTokens)} of ${count(group.tokens.firedRows)} fired`,
    ),
  );
  out.push(line("models", group.models.length === 0 ? "n/a" : group.models.map((entry) => `${entry.model} ${count(entry.count)}`).join(" · ")));
  return out;
}

/** The compact text report. Pure — the same numbers `--json` dumps, laid out for a person. */
export function renderNpcSceneDecisionReport(report: NpcSceneDecisionReport): string {
  const out: string[] = [
    line("envelopes (= replies)", count(report.envelopes)),
    line("window (createdAt)", windowText(report.window)),
    line(
      "fallback pricing",
      report.pricing.inputPerMillionUsd === null && report.pricing.outputPerMillionUsd === null
        ? "none supplied"
        : `in ${usd(report.pricing.inputPerMillionUsd)}/M · out ${usd(report.pricing.outputPerMillionUsd)}/M`,
    ),
  ];
  if (report.groups.length === 0) out.push("", "No envelopes matched the filters.");
  for (const group of report.groups) out.push(...renderGroup(group));
  // Accuracy is a human judgment about prose; this script never claims one.
  out.push("", "False positives/negatives are NOT computed here — export --review-out and label the corpus.");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Argv, database, IO
// ---------------------------------------------------------------------------

/** A bad flag is the operator's typo, not a crash: the boundary prints the reason plus USAGE. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface ReportArgs {
  readonly since?: Date;
  readonly until?: Date;
  readonly chatId?: string;
  readonly mode?: NpcSceneDecisionMode;
  readonly json: boolean;
  readonly reviewOut?: string;
  readonly pricing: NpcSceneDecisionPricing;
  readonly help: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored number worth reporting: finite and non-negative. Anything else is absent. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The usage half of telemetry, read straight off the STORED blob — see
 * `NpcSceneDecisionUsageTelemetry` for why this does not go through the parsed
 * payload. Every field is optional at both ends: a row written before these
 * fields existed simply carries none, and coverage counts say how many did.
 */
function readUsageTelemetry(rawPayload: unknown): NpcSceneDecisionUsageTelemetry {
  const telemetry = isRecord(rawPayload) ? rawPayload.telemetry : undefined;
  if (!isRecord(telemetry)) return {};
  return {
    settleWaitMs: finiteNonNegative(telemetry.settleWaitMs),
    inputTokens: finiteNonNegative(telemetry.inputTokens),
    outputTokens: finiteNonNegative(telemetry.outputTokens),
    costUsd: finiteNonNegative(telemetry.costUsd),
  };
}

function parseInstant(raw: string | undefined, flag: string): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new UsageError(`${flag} is not a parsable instant: ${raw}`);
  return parsed;
}

function parsePrice(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`${flag} must be a non-negative number: ${raw}`);
  return parsed;
}

function parseArgs(argv: readonly string[]): ReportArgs {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      flags.set(key, value);
      index += 1;
    } else {
      bools.add(key);
    }
  }
  const rawMode = flags.get("mode");
  const mode = rawMode === undefined ? undefined : npcSceneDecisionModes.find((known) => known === rawMode);
  if (rawMode !== undefined && mode === undefined) {
    throw new UsageError(`--mode must be one of ${npcSceneDecisionModes.join(", ")}: ${rawMode}`);
  }
  return {
    since: parseInstant(flags.get("since"), "--since"),
    until: parseInstant(flags.get("until"), "--until"),
    chatId: flags.get("chat"),
    mode,
    json: bools.has("json"),
    reviewOut: flags.get("review-out"),
    pricing: {
      inputPerMillionUsd: parsePrice(flags.get("price-in"), "--price-in"),
      outputPerMillionUsd: parsePrice(flags.get("price-out"), "--price-out"),
    },
    help: bools.has("help"),
  };
}

/** One envelope as it comes back from the join: the report row plus the reply the corpus needs. */
interface LoadedRow {
  readonly row: NpcSceneDecisionReportRow;
  readonly reply: string | null;
}

interface LoadedWindow {
  readonly rows: readonly LoadedRow[];
  /** Rows whose `mode`/`status` sits outside the vocabulary — dropped from every figure, as the envelope reader drops them. */
  readonly unreadable: number;
}

/**
 * One pass over the window. The reply joins in unconditionally (a LEFT JOIN on
 * the assistant message's primary key) rather than only under `--review-out`:
 * one query shape is one thing to reason about, and the stale-reply count it
 * feeds is worth printing on every run.
 */
async function loadRows(args: ReportArgs): Promise<LoadedWindow> {
  const conditions = [
    ...(args.since === undefined ? [] : [gte(chatNpcSceneDecisions.createdAt, args.since)]),
    ...(args.until === undefined ? [] : [lte(chatNpcSceneDecisions.createdAt, args.until)]),
    ...(args.chatId === undefined ? [] : [eq(chatNpcSceneDecisions.chatId, args.chatId)]),
    ...(args.mode === undefined ? [] : [eq(chatNpcSceneDecisions.mode, args.mode)]),
  ];
  const rows = await db()
    .select({
      chatId: chatNpcSceneDecisions.chatId,
      assistantMessageId: chatNpcSceneDecisions.assistantMessageId,
      mode: chatNpcSceneDecisions.mode,
      status: chatNpcSceneDecisions.status,
      storyMinute: chatNpcSceneDecisions.storyMinute,
      replyHash: chatNpcSceneDecisions.replyHash,
      payload: chatNpcSceneDecisions.payload,
      createdAt: chatNpcSceneDecisions.createdAt,
      reply: characterChatMessages.content,
    })
    .from(chatNpcSceneDecisions)
    .leftJoin(characterChatMessages, eq(characterChatMessages.id, chatNpcSceneDecisions.assistantMessageId))
    .where(and(...conditions))
    .orderBy(asc(chatNpcSceneDecisions.createdAt));

  let unreadable = 0;
  const loaded = rows.flatMap((row): LoadedRow[] => {
    // `mode` and `status` are the text columns a hand-edit could put outside the
    // vocabulary, and a row whose status cannot be read is a row every rate here
    // would silently miscount — so it is dropped and reported, never guessed at.
    const mode = npcSceneDecisionModes.find((known) => known === row.mode);
    const status = npcSceneDecisionStatuses.find((known) => known === row.status);
    if (mode === undefined || status === undefined) {
      unreadable += 1;
      return [];
    }
    return [
      {
        row: {
          chatId: row.chatId,
          assistantMessageId: row.assistantMessageId,
          createdAt: row.createdAt.toISOString(),
          mode,
          status,
          storyMinute: row.storyMinute,
          replyHash: row.replyHash,
          // The payload's trust boundary — a malformed blob degrades to the
          // empty payload here exactly as it does for every other reader.
          payload: parseNpcSceneDecisionPayload(row.payload),
          usage: readUsageTelemetry(row.payload),
        },
        reply: row.reply,
      },
    ];
  });
  return { rows: loaded, unreadable };
}

async function writeReviewCorpus(outPath: string, loaded: readonly LoadedRow[]): Promise<void> {
  const lines = loaded.map((entry) => JSON.stringify(reviewCorpusLine(entry.row, entry.reply)));
  const resolved = path.resolve(outPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const observed = await loadRows(args);
  const loaded = observed.rows;
  const report = aggregateNpcSceneDecisionReport(
    loaded.map((entry) => entry.row),
    args.pricing,
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          filters: {
            since: args.since?.toISOString() ?? null,
            until: args.until?.toISOString() ?? null,
            chatId: args.chatId ?? null,
            mode: args.mode ?? null,
          },
          unreadableRows: observed.unreadable,
          ...report,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderNpcSceneDecisionReport(report));
    if (observed.unreadable > 0) {
      console.log(`\n${observed.unreadable} row(s) carried an unreadable mode/status and are in no figure above.`);
    }
  }

  if (args.reviewOut !== undefined) {
    await writeReviewCorpus(args.reviewOut, loaded);
    // A reply whose stored bytes no longer hash to the decided bytes was retaken
    // after the decision: the reviewer would be labelling prose the classifier
    // never saw, so the count is printed rather than left to be discovered.
    const stale = loaded.filter(
      (entry) => entry.reply !== null && chatNpcReplyHash(entry.reply) !== entry.row.replyHash,
    ).length;
    const missing = loaded.filter((entry) => entry.reply === null).length;
    console.log(`\nWrote ${loaded.length} review line(s) to ${args.reviewOut}`);
    if (stale > 0) console.log(`  ${stale} line(s) carry a reply that no longer hashes to the decided bytes (retaken).`);
    if (missing > 0) console.log(`  ${missing} line(s) have no reply row (deleted under the join).`);
  }
  process.exit(0);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    if (error instanceof UsageError) console.error(`${error.message}\n\n${USAGE}`);
    else console.error(error);
    process.exit(1);
  });
}
