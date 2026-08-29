/**
 * The pure half of the per-block negative trial harness: CSV parsing, rate
 * arithmetic, and the manifest-provenance merge a resumed render run depends
 * on.
 *
 * Split from the runner and covered by `pnpm test` for the composer-model
 * precedent's reason — a grader nobody tests is an instrument nobody can trust.
 * The grading itself is human; what this owns is the counting the verdicts are
 * read off of, where a mixed-up arm or a blank cell silently counted as "no"
 * would misreport the matrix the owner rules on — and the record-keeping that
 * decides whether a resumed trial still knows which provider version rendered
 * its skipped images.
 */

export interface NegativeBlockRow {
  readonly trial: string;
  readonly fixture: string;
  readonly arm: string;
  readonly seed: number;
  /** Metric name → graded cell: "yes", "no", a number as text, or "" ungraded. */
  readonly values: Readonly<Record<string, string>>;
}

/** One metric's tally within one trial × fixture × arm cell. */
export interface NegativeBlockMetricSummary {
  readonly metric: string;
  /** Graded answers only — blank cells are ungraded, never "no". */
  readonly n: number;
  readonly yes: number;
  /** yes / n, or null when nothing is graded or the metric is numeric. */
  readonly rate: number | null;
  /** Mean of numeric answers (1–5 scales), or null for a yes/no metric. */
  readonly mean: number | null;
}

export interface NegativeBlockCellSummary {
  readonly trial: string;
  readonly fixture: string;
  readonly arm: string;
  readonly metrics: readonly NegativeBlockMetricSummary[];
}

/**
 * Minimal quote-aware CSV: doubled quotes inside quoted cells, one record per
 * line. Enough for a file this harness itself wrote; not a general parser.
 */
export function parseNegativeBlockCsv(text: string): NegativeBlockRow[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0] ?? "");
  const fixed = ["trial", "fixture", "arm", "seed", "file"];
  const metricNames = header.filter((name) => !fixed.includes(name) && name !== "notes");
  const rows: NegativeBlockRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const byName = new Map(header.map((name, index) => [name, cells[index] ?? ""]));
    rows.push({
      trial: byName.get("trial") ?? "",
      fixture: byName.get("fixture") ?? "",
      arm: byName.get("arm") ?? "",
      seed: Number(byName.get("seed") ?? "0"),
      values: Object.fromEntries(metricNames.map((name) => [name, (byName.get(name) ?? "").trim().toLowerCase()])),
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Tally every graded cell.
 *
 * A blank cell is EXCLUDED from `n` rather than counted as "no": an ungraded
 * render must lower confidence, not manufacture a failure-free arm.
 */
export function summarizeNegativeBlockRows(rows: readonly NegativeBlockRow[]): NegativeBlockCellSummary[] {
  const cells = new Map<string, { trial: string; fixture: string; arm: string; rows: NegativeBlockRow[] }>();
  for (const row of rows) {
    const key = `${row.trial}\u0000${row.fixture}\u0000${row.arm}`;
    const cell = cells.get(key) ?? { trial: row.trial, fixture: row.fixture, arm: row.arm, rows: [] };
    cell.rows.push(row);
    cells.set(key, cell);
  }
  return [...cells.values()].map((cell) => {
    const metricNames = [...new Set(cell.rows.flatMap((row) => Object.keys(row.values)))];
    return {
      trial: cell.trial,
      fixture: cell.fixture,
      arm: cell.arm,
      metrics: metricNames.map((metric) => {
        const answers = cell.rows.map((row) => row.values[metric] ?? "").filter((value) => value.length > 0);
        const yesNo = answers.filter((value) => value === "yes" || value === "no");
        const numeric = answers.map(Number).filter((value) => Number.isFinite(value));
        const yes = yesNo.filter((value) => value === "yes").length;
        return {
          metric,
          n: answers.length,
          yes,
          rate: yesNo.length > 0 ? yes / yesNo.length : null,
          mean: yesNo.length === 0 && numeric.length > 0 ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null,
        };
      }),
    };
  });
}

/** OFF-arm rate minus ON-arm rate for one metric, or null when either side is ungraded. */
export function negativeBlockDelta(
  summaries: readonly NegativeBlockCellSummary[],
  query: { trial: string; fixture: string; metric: string; offArm: string; onArm: string },
): { off: number; on: number; delta: number } | null {
  const rate = (arm: string): number | null => {
    const cell = summaries.find((s) => s.trial === query.trial && s.fixture === query.fixture && s.arm === arm);
    return cell?.metrics.find((m) => m.metric === query.metric)?.rate ?? null;
  };
  const off = rate(query.offArm);
  const on = rate(query.onArm);
  if (off === null || on === null) return null;
  return { off, on, delta: on - off };
}

// ---------------------------------------------------------------------------
// Manifest provenance — carrying skipped renders' records across resumed runs
// ---------------------------------------------------------------------------

/** One render in a trial's `manifest.json`. */
export interface RenderRecord {
  readonly file: string;
  readonly seed: number;
  readonly arm: string;
  readonly fixture: string;
  readonly executedVersionId: string | null;
  readonly predictionId: string | null;
  /**
   * Set only when the image predates the oldest surviving manifest: the file
   * exists on disk, but no prior record carries its provenance (e.g. the first
   * run was interrupted before its manifest write). Distinct from a null
   * `executedVersionId`, which means the provider reported none for a render
   * this instrument actually executed and recorded.
   */
  readonly provenanceUnknown?: true;
}

/** The per-render facts a resumed run must not lose. */
export interface RenderProvenance {
  readonly executedVersionId: string | null;
  readonly predictionId: string | null;
}

/**
 * Read per-render provenance out of a prior run's manifest text, keyed by
 * rendered file path. Tolerant on purpose — a missing, hand-edited, or
 * truncated manifest yields an empty (or partial) map rather than aborting the
 * run; the affected renders are then marked `provenanceUnknown` instead of
 * silently inheriting nulls that read as "not executed".
 */
export function parseManifestProvenance(text: string | null): ReadonlyMap<string, RenderProvenance> {
  const byFile = new Map<string, RenderProvenance>();
  if (text === null) return byFile;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return byFile;
  }
  if (typeof parsed !== "object" || parsed === null) return byFile;
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return byFile;
  for (const entry of records) {
    if (typeof entry !== "object" || entry === null) continue;
    const { file, executedVersionId, predictionId } = entry as Readonly<Record<string, unknown>>;
    if (typeof file !== "string") continue;
    byFile.set(file, {
      executedVersionId: typeof executedVersionId === "string" ? executedVersionId : null,
      predictionId: typeof predictionId === "string" ? predictionId : null,
    });
  }
  return byFile;
}

/**
 * The record for a render SKIPPED because its image already exists: carry the
 * prior manifest's provenance for that file, or mark the record
 * provenance-unknown when no prior record exists. Never a fresh null pair —
 * that is indistinguishable from "executed, provider reported no version".
 */
export function resumedRenderRecord(
  base: Omit<RenderRecord, "executedVersionId" | "predictionId" | "provenanceUnknown">,
  prior: ReadonlyMap<string, RenderProvenance>,
): RenderRecord {
  const carried = prior.get(base.file);
  if (carried === undefined) return { ...base, executedVersionId: null, predictionId: null, provenanceUnknown: true };
  return { ...base, executedVersionId: carried.executedVersionId, predictionId: carried.predictionId };
}
