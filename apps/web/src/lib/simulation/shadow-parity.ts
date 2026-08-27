import { z } from "zod";
import { parseOr } from "@/lib/parse";
import { METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import { formatStoryClockShort, storyClockAt } from "./clock";

/**
 * The scale-aware parity analysis over recorded `sim_shadow_divergences` rows.
 * Pure: rows in, report out. The two
 * lanes measure differently, so every comparison normalizes first:
 *
 * - clock: absolutes are incommensurate (legacy minutes-since-anchor vs the
 *   branch's storySecond) — successive-row DELTAS are compared, within a
 *   tolerance that absorbs the lanes' differing per-exchange drift.
 * - meters: chat meters are 0..1 floats, sim meters fixed-point 0..10 000 —
 *   normalized to 0..1 and compared per shared key.
 * - presence: the recorder already judged the pair (detail non-empty = mismatch).
 * - prose: never auto-judged — the report counts pairs and surfaces failures;
 *   reading them stays human work.
 *
 * Rows whose verdict is no longer "open" are excluded from findings (a ruled
 * divergence is settled), and malformed payloads are skipped with a note,
 * never thrown (docs/resilience.md).
 */

export interface ShadowDivergenceRowInput {
  id: string;
  messageId: string;
  domain: string;
  legacy: unknown;
  successor: unknown;
  detail: string;
  verdict: string;
  createdAt: string | Date;
}

export interface ShadowParityOptions {
  /** Max |legacy − successor| on the normalized 0..1 meter scale. Default 0.15. */
  meterTolerance?: number;
  /** Max |legacy delta − successor delta| per clock step, in minutes. Default 2. */
  clockToleranceMinutes?: number;
}

export interface ClockStepFinding {
  fromMessageId: string;
  toMessageId: string;
  legacyDeltaMinutes: number;
  successorDeltaMinutes: number;
}

export interface MeterFinding {
  messageId: string;
  meterKey: string;
  legacyValue: number;
  successorValue: number;
}

export interface ShadowParityReport {
  totals: {
    rows: number;
    byDomain: Record<string, number>;
    byVerdict: Record<string, number>;
    skippedMalformed: number;
  };
  clock: {
    steps: number;
    driftingSteps: ClockStepFinding[];
    latestSuccessorClock: string | null;
  };
  meters: {
    comparedRows: number;
    sharedKeys: string[];
    beyondTolerance: MeterFinding[];
    /** Keys the chat tracks that the mirror actor lacks (latest row). */
    missingOnMirror: string[];
    /** Keys the mirror tracks that the chat lacks (latest row). */
    missingOnChat: string[];
  };
  presence: { rows: number; mismatches: { messageId: string; detail: string }[] };
  prose: { pairs: number; rendered: number; failures: { messageId: string; detail: string }[] };
  /** Human-readable open findings — the exit's "fixed or ruled intentional" list. */
  findings: string[];
}

const clockLegacySchema = z.object({ clockMinutes: z.number() }).loose();
const clockSuccessorSchema = z.object({ storySecond: z.number() }).loose();
const metersLegacySchema = z.object({ meters: z.record(z.string(), z.number()) }).loose();
const metersSuccessorSchema = z.object({ metersFixedPoint: z.record(z.string(), z.number()) }).loose();
const proseSuccessorSchema = z.object({ status: z.string() }).loose();

export function analyzeShadowParity(
  rows: readonly ShadowDivergenceRowInput[],
  options: ShadowParityOptions = {},
): ShadowParityReport {
  const meterTolerance = options.meterTolerance ?? 0.15;
  const clockToleranceMinutes = options.clockToleranceMinutes ?? 2;
  const ordered = rows
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));

  const byDomain: Record<string, number> = {};
  const byVerdict: Record<string, number> = {};
  let skippedMalformed = 0;
  for (const row of ordered) {
    byDomain[row.domain] = (byDomain[row.domain] ?? 0) + 1;
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
  }
  const open = (row: ShadowDivergenceRowInput) => row.verdict === "open";

  // --- Clock: successive-row deltas -----------------------------------------
  const clockRows = ordered.filter((row) => row.domain === "clock");
  const clockPoints: { messageId: string; legacyMinutes: number; storySecond: number; open: boolean }[] = [];
  for (const row of clockRows) {
    const legacy = parseOr(clockLegacySchema, row.legacy, null);
    const successor = parseOr(clockSuccessorSchema, row.successor, null);
    if (!legacy || !successor) {
      skippedMalformed += 1;
      continue;
    }
    clockPoints.push({
      messageId: row.messageId,
      legacyMinutes: legacy.clockMinutes,
      storySecond: successor.storySecond,
      open: open(row),
    });
  }
  const driftingSteps: ClockStepFinding[] = [];
  for (let i = 1; i < clockPoints.length; i += 1) {
    const prev = clockPoints[i - 1];
    const next = clockPoints[i];
    if (!prev || !next || !next.open) continue;
    const legacyDelta = next.legacyMinutes - prev.legacyMinutes;
    const successorDelta = (next.storySecond - prev.storySecond) / 60;
    if (Math.abs(legacyDelta - successorDelta) > clockToleranceMinutes) {
      driftingSteps.push({
        fromMessageId: prev.messageId,
        toMessageId: next.messageId,
        legacyDeltaMinutes: legacyDelta,
        successorDeltaMinutes: successorDelta,
      });
    }
  }
  const latestClock = clockPoints[clockPoints.length - 1];

  // --- Meters: normalized per shared key ------------------------------------
  const meterRows = ordered.filter((row) => row.domain === "meters");
  const beyondTolerance: MeterFinding[] = [];
  const sharedKeys = new Set<string>();
  let comparedRows = 0;
  let missingOnMirror: string[] = [];
  let missingOnChat: string[] = [];
  for (const row of meterRows) {
    const legacy = parseOr(metersLegacySchema, row.legacy, null);
    const successor = parseOr(metersSuccessorSchema, row.successor, null);
    if (!legacy || !successor) {
      skippedMalformed += 1;
      continue;
    }
    comparedRows += 1;
    const legacyKeys = Object.keys(legacy.meters);
    const successorKeys = Object.keys(successor.metersFixedPoint);
    missingOnMirror = legacyKeys.filter((key) => !successorKeys.includes(key)).sort();
    missingOnChat = successorKeys.filter((key) => !legacyKeys.includes(key)).sort();
    for (const key of legacyKeys) {
      const fixedPoint = successor.metersFixedPoint[key];
      if (fixedPoint === undefined) continue;
      sharedKeys.add(key);
      const legacyValue = legacy.meters[key] ?? 0;
      const successorValue = fixedPoint / METER_FIXED_POINT_ONE;
      if (open(row) && Math.abs(legacyValue - successorValue) > meterTolerance) {
        beyondTolerance.push({ messageId: row.messageId, meterKey: key, legacyValue, successorValue });
      }
    }
  }

  // --- Presence + prose: the recorder's own judgments ------------------------
  const presenceRows = ordered.filter((row) => row.domain === "presence");
  const presenceMismatches = presenceRows
    .filter((row) => open(row) && row.detail.length > 0)
    .map((row) => ({ messageId: row.messageId, detail: row.detail }));
  const proseRows = ordered.filter((row) => row.domain === "prose");
  let rendered = 0;
  const proseFailures: { messageId: string; detail: string }[] = [];
  for (const row of proseRows) {
    const successor = parseOr(proseSuccessorSchema, row.successor, null);
    if (!successor) {
      skippedMalformed += 1;
      continue;
    }
    if (successor.status === "rendered") rendered += 1;
    else if (open(row)) proseFailures.push({ messageId: row.messageId, detail: row.detail || successor.status });
  }

  const findings: string[] = [
    ...driftingSteps.map(
      (step) =>
        `clock drift ${step.fromMessageId} → ${step.toMessageId}: legacy moved ${step.legacyDeltaMinutes}min, successor ${step.successorDeltaMinutes}min`,
    ),
    ...beyondTolerance.map(
      (finding) =>
        `meter ${finding.meterKey} @ ${finding.messageId}: legacy ${finding.legacyValue.toFixed(2)} vs successor ${finding.successorValue.toFixed(2)}`,
    ),
    ...(missingOnMirror.length > 0 ? [`meters missing on the mirror actor: ${missingOnMirror.join(", ")}`] : []),
    ...presenceMismatches.map((mismatch) => `presence @ ${mismatch.messageId}: ${mismatch.detail}`),
    ...proseFailures.map((failure) => `prose @ ${failure.messageId}: ${failure.detail}`),
  ];

  return {
    totals: { rows: ordered.length, byDomain, byVerdict, skippedMalformed },
    clock: {
      steps: Math.max(0, clockPoints.length - 1),
      driftingSteps,
      latestSuccessorClock: latestClock ? formatStoryClockShort(storyClockAt(latestClock.storySecond)) : null,
    },
    meters: {
      comparedRows,
      sharedKeys: [...sharedKeys].sort(),
      beyondTolerance,
      missingOnMirror,
      missingOnChat,
    },
    presence: { rows: presenceRows.length, mismatches: presenceMismatches },
    prose: { pairs: proseRows.length, rendered, failures: proseFailures },
    findings,
  };
}
