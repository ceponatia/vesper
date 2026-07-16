import type { Gate0CaseDefinition } from "./cases";

export interface Gate0LegEvidence {
  id: string;
  model: string;
  attemptedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenSource: "provider" | "estimated" | "none";
  ttftMs: number;
  totalMs: number;
  provider: string | null;
  degraded: boolean;
  error?: string;
}

export interface Gate0AutomatedQuality {
  contradiction: boolean | null;
  perspectiveLeak: boolean | null;
  hardEffectRepair: boolean | null;
  requiredCueMiss: boolean | null;
}

export interface Gate0ManualReview {
  contradiction: boolean | null;
  perspectiveLeak: boolean | null;
  hardEffectRepair: boolean | null;
  note: string;
}

export interface Gate0ResultRow {
  caseId: string;
  title: string;
  lane: "session" | "chat";
  seed: number;
  authoredSetup: {
    expectation: string;
    knownNames: string[];
    authoredReaction: string | null;
  };
  inputMessages: unknown[];
  deterministicStateBefore: Record<string, unknown>;
  deterministicStateAfter: Record<string, unknown>;
  prompt: {
    system: string;
    messages: unknown[];
    sha256: string;
  };
  transcript: string;
  legs: Gate0LegEvidence[];
  automatedQuality: Gate0AutomatedQuality;
  manualReview: Gate0ManualReview;
}

export interface MetricCount {
  hits: number;
  checked: number;
}

export interface Gate0Summary {
  rows: number;
  successfulRows: number;
  attemptedModelCalls: number;
  degradedLegs: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: { p50: number; p95: number };
  automatedQuality: {
    contradiction: MetricCount;
    perspectiveLeak: MetricCount;
    hardEffectRepair: MetricCount;
    requiredCueMiss: MetricCount;
  };
  manualReview: {
    pending: number;
    contradiction: MetricCount;
    perspectiveLeak: MetricCount;
    hardEffectRepair: MetricCount;
  };
}

function matches(pattern: RegExp | undefined, text: string): boolean | null {
  if (!pattern) return null;
  pattern.lastIndex = 0;
  return pattern.test(text);
}

export function evaluateGate0Quality(definition: Gate0CaseDefinition, transcript: string): Gate0AutomatedQuality {
  const requiredCue = matches(definition.checks.requiredCueRe, transcript);
  return {
    contradiction: matches(definition.checks.contradictionRe, transcript),
    perspectiveLeak: matches(definition.checks.perspectiveLeakRe, transcript),
    hardEffectRepair: matches(definition.checks.hardEffectRepairRe, transcript),
    requiredCueMiss: requiredCue === null ? null : !requiredCue,
  };
}

/** Nearest-rank percentile: stable and unsurprising for the small Gate 0 sample. */
export function percentile(values: readonly number[], percent: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((Math.min(100, Math.max(0, percent)) / 100) * ordered.length));
  return ordered[rank - 1] ?? 0;
}

function count(values: readonly (boolean | null)[]): MetricCount {
  const checked = values.filter((value) => value !== null);
  return { hits: checked.filter(Boolean).length, checked: checked.length };
}

export function summarizeGate0Rows(rows: readonly Gate0ResultRow[]): Gate0Summary {
  const legs = rows.flatMap((row) => row.legs);
  const successfulRows = rows.filter(
    (row) => row.transcript.trim().length > 0 && row.legs.every((leg) => !leg.degraded),
  );
  const latencies = successfulRows.flatMap((row) => row.legs.filter((leg) => leg.attemptedCalls > 0).map((leg) => leg.totalMs));
  const reviews = rows.flatMap((row) => [
    row.manualReview.contradiction,
    row.manualReview.perspectiveLeak,
    row.manualReview.hardEffectRepair,
  ]);

  return {
    rows: rows.length,
    successfulRows: successfulRows.length,
    attemptedModelCalls: legs.reduce((sum, leg) => sum + leg.attemptedCalls, 0),
    degradedLegs: legs.filter((leg) => leg.degraded).length,
    promptTokens: legs.reduce((sum, leg) => sum + leg.promptTokens, 0),
    completionTokens: legs.reduce((sum, leg) => sum + leg.completionTokens, 0),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    automatedQuality: {
      contradiction: count(successfulRows.map((row) => row.automatedQuality.contradiction)),
      perspectiveLeak: count(successfulRows.map((row) => row.automatedQuality.perspectiveLeak)),
      hardEffectRepair: count(successfulRows.map((row) => row.automatedQuality.hardEffectRepair)),
      requiredCueMiss: count(successfulRows.map((row) => row.automatedQuality.requiredCueMiss)),
    },
    manualReview: {
      pending: reviews.filter((value) => value === null).length,
      contradiction: count(rows.map((row) => row.manualReview.contradiction)),
      perspectiveLeak: count(rows.map((row) => row.manualReview.perspectiveLeak)),
      hardEffectRepair: count(rows.map((row) => row.manualReview.hardEffectRepair)),
    },
  };
}
