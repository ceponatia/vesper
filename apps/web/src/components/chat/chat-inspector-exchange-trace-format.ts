import type { TagTone } from "@/components/ui/tag";
import type {
  ExchangeCoverageEntry,
  ExchangeCoverageStatus,
  ExchangeOperation,
  ExchangeOutcome,
  ExchangePhase,
  ExchangeStageEvent,
  ExchangeStageStatus,
} from "@/contracts/turns/chat-exchange-trace";

/**
 * Pure client-side copy, grouping, and highlight-derivation for the
 * exchange-trace inspector panel (chat-inspector-exchange-trace.tsx) — kept
 * out of the component so the non-trivial logic (coverage grouping, the
 * timeline's highlight set) is unit-tested without rendering React
 * (vesper-testing: pure deterministic logic stays in a pure suite). The
 * label/tone tables are Records keyed by the contract's own closed enums
 * (image-generator-copy.ts's precedent), so an enum value missing its copy is
 * a compile error rather than a blank cell.
 */

// ---------------------------------------------------------------------------
// Copy — every code → label/tone translation lives here, at the UI boundary
// ---------------------------------------------------------------------------

const OPERATION_LABELS: Record<ExchangeOperation, string> = {
  send: "send",
  open: "open",
  continue: "continue",
  action_beat: "action beat",
  regenerate: "regenerate",
  rerun: "rerun",
};
export function exchangeOperationLabel(operation: ExchangeOperation): string {
  return OPERATION_LABELS[operation];
}

export interface StatusBadge {
  label: string;
  tone: TagTone;
}

/**
 * The trace's overall outcome. `incomplete` — no finish record at all — is
 * deliberately NOT `ok`-toned: it is a crash-safety reading, never a positive
 * claim (contract: `deriveExchangeOutcome`'s "no finish → incomplete").
 */
const OUTCOME_BADGES: Record<ExchangeOutcome, StatusBadge> = {
  ok: { label: "ok", tone: "ok" },
  degraded: { label: "degraded", tone: "accent" },
  stopped: { label: "stopped", tone: "default" },
  failed: { label: "failed", tone: "danger" },
  incomplete: { label: "incomplete", tone: "default" },
};
export function exchangeOutcomeBadge(outcome: ExchangeOutcome): StatusBadge {
  return OUTCOME_BADGES[outcome];
}

/** One stage's status. The tone always rides alongside the label text — never color alone. */
const STAGE_STATUS_BADGES: Record<ExchangeStageStatus, StatusBadge> = {
  success: { label: "success", tone: "ok" },
  degraded: { label: "degraded", tone: "accent" },
  failed: { label: "failed", tone: "danger" },
  skipped: { label: "skipped", tone: "default" },
  retried: { label: "retried", tone: "accent" },
  blocked: { label: "blocked", tone: "danger" },
};
export function exchangeStageStatusBadge(status: ExchangeStageStatus): StatusBadge {
  return STAGE_STATUS_BADGES[status];
}

/** One coverage check's result — `missing` reads as a gap, never a lesser `present`. */
const COVERAGE_STATUS_BADGES: Record<ExchangeCoverageStatus, StatusBadge> = {
  present: { label: "present", tone: "ok" },
  empty: { label: "empty", tone: "default" },
  missing: { label: "missing", tone: "danger" },
  suppressed: { label: "suppressed", tone: "accent" },
  degraded: { label: "degraded", tone: "accent" },
};
export function exchangeCoverageStatusBadge(status: ExchangeCoverageStatus): StatusBadge {
  return COVERAGE_STATUS_BADGES[status];
}

const PHASE_LABELS: Record<ExchangePhase, string> = {
  admission: "admission",
  prepare: "prepare",
  narrator: "narrator",
  settle: "settle",
  post_turn: "post-turn",
};
export function exchangePhaseLabel(phase: ExchangePhase): string {
  return PHASE_LABELS[phase];
}

// ---------------------------------------------------------------------------
// Grouping — the coverage summary's required reading order
// ---------------------------------------------------------------------------

export interface CoverageGroup {
  status: ExchangeCoverageStatus;
  entries: ExchangeCoverageEntry[];
}

/**
 * Coverage statuses in the inspector's required reading order: the three
 * that need a second look (`missing` — never fetched; `degraded`;
 * `suppressed`) before the two that don't (`present`, `empty` — #637's
 * "distinguishes missing from valid empty").
 */
const COVERAGE_STATUS_ORDER: readonly ExchangeCoverageStatus[] = [
  "missing",
  "degraded",
  "suppressed",
  "present",
  "empty",
];

/** Group coverage entries by status, in the fixed order above; a status with no entries gets no group. */
export function groupCoverageByStatus(entries: readonly ExchangeCoverageEntry[]): CoverageGroup[] {
  return COVERAGE_STATUS_ORDER.flatMap((status) => {
    const matches = entries.filter((entry) => entry.status === status);
    return matches.length > 0 ? [{ status, entries: matches }] : [];
  });
}

// ---------------------------------------------------------------------------
// Highlights — which timeline rows the trace's own `highlights` call out
// ---------------------------------------------------------------------------

/**
 * The subset of `AssembledTrace["highlights"]` this derivation reads —
 * narrowed so a test fixture only needs these two fields, not the full
 * highlights shape (structurally compatible with the real thing).
 */
export interface HighlightStageSource {
  retriedStages: readonly ExchangeStageEvent[];
  fallbackStages: readonly { stage: ExchangeStageEvent | null }[];
}

/**
 * Which stage `seq`s the timeline marks: a retried stage, or the stage a
 * composition fallback was linked to (`deriveExchangeHighlights`'s
 * best-effort link) — "the stage that caused a fallback or retry."
 */
export function highlightedStageSeqs(highlights: HighlightStageSource): ReadonlySet<number> {
  const seqs = new Set<number>();
  for (const stage of highlights.retriedStages) seqs.add(stage.seq);
  for (const { stage } of highlights.fallbackStages) {
    if (stage) seqs.add(stage.seq);
  }
  return seqs;
}

// ---------------------------------------------------------------------------
// Ids — the short, copyable display form every linked id uses
// ---------------------------------------------------------------------------

/** `null`/empty → an em dash; a short id passes through; a long one truncates with an ellipsis. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}
