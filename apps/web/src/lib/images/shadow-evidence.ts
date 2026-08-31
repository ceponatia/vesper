/**
 * THE SHADOW-EVIDENCE AGGREGATOR — the pure arithmetic behind the cutover
 * decision for a character image lane (issue #256).
 *
 * A lane in shadow records one compact verdict per render
 * (`server/images/shadow-comparison.ts`, `image.meta.shadowComparison`). The
 * question a promotion asks is not "did that render agree" but "what does the
 * whole window say", and that is a counting problem with several ways to lie.
 * This module is the counting, stated once, so the report driver
 * (`scripts/eval/prompt-programs/shadow-report.ts`) is a query and a printer.
 *
 * ## The denominators are the point
 *
 * A shadow window has FOUR outcomes and only two of them are evidence:
 *
 * - `parity` — this render's compiled program said the same things.
 * - `divergence` — it did not.
 * - `unmeasured` — a half of the evidence is missing (no binding, no fact
 *   list, a capture that refused to plan, a deliberate refusal). It is **not a
 *   pass.** An unmeasured render has said nothing about the lane, and folding
 *   it into "not diverged" is how a window with no evidence reads as a green
 *   light.
 * - `error` — the comparator itself broke. Also not evidence, in either
 *   direction.
 *
 * So {@link ShadowEvidenceSummary} reports the parity count, the MEASURED count
 * (`parity + divergence`) and the total separately, and every consumer is
 * expected to state all three: "N parity of M measured, K unmeasured, E error".
 * There is deliberately no single "pass rate" field, because any one number
 * here would have to pick a denominator and hide the choice.
 *
 * ## Two traps this module handles, both verified in the source
 *
 * 1. **`error` records carry FALSE, not null.** `shadowErrorComparison` writes
 *    `coverage.matches: false` and `mandatory.survived: false` — the containment
 *    factory fills the record's shape rather than claiming a measurement. Every
 *    comparator crash would therefore be counted as a real coverage failure and
 *    a real mandatory loss. Coverage and mandatory attribution here EXCLUDES
 *    `error` records for exactly that reason.
 * 2. **`codes` is non-empty on `unmeasured` records too.** The unmeasured-half
 *    codes (`image_shadow.coverage_unmeasured`,
 *    `image_shadow.transport_uncaptured`) are appended AFTER the verdict is
 *    computed, so "this record has codes" does not mean "this record diverged".
 *    The code histogram counts every record's codes — that is what makes the
 *    unmeasured reasons visible — and the verdict counts are the only thing
 *    that says whether anything drifted.
 *
 * ## What this module is not allowed to import
 *
 * `apps/web/src/lib` is a purity boundary: no `@/server`, no IO, no clock
 * (eslint.config.mjs §1). The stored verdict's own type lives under
 * `@/server/images`, so {@link ShadowEvidenceComparison} is a structural VIEW of
 * it rather than a re-export. TypeScript is structural, so the driver's
 * `parseImageShadowComparison(...) -> ShadowEvidenceRecord` assignment is where
 * the two shapes meet: a schema field that is removed, renamed or retyped fails
 * typecheck THERE, which is the drift guard. A field ADDED to the schema is not
 * caught — it simply is not summarized yet.
 */

/** The four stored verdicts. Never collapse them: see the module note. */
export type ShadowEvidenceVerdict = "parity" | "divergence" | "unmeasured" | "error";

/**
 * The stored verdict as this module reads it — the structural view of
 * `imageShadowComparisonSchema` described in the module note. `version` and the
 * schema's other identity fields are deliberately absent: a summary that
 * demanded them would refuse rows it can count perfectly well.
 */
export interface ShadowEvidenceComparison {
  readonly lane: string;
  readonly verdict: ShadowEvidenceVerdict;
  readonly codes: readonly string[];
  readonly coverage: {
    /** Null when coverage was not measured. False on an `error` record — see the trap. */
    readonly matches: boolean | null;
    readonly missing: readonly string[];
    readonly unexpected: readonly string[];
    readonly duplicated: readonly string[];
    readonly staleAllowlist: readonly string[];
  };
  readonly transport: {
    /** Null when a side carried no capture — unmeasured, never passing. */
    readonly parity: boolean | null;
    readonly firstMismatch: string | null;
  };
  readonly mandatory: {
    /** Null when unmeasured. False on an `error` record — see the trap. */
    readonly survived: boolean | null;
    readonly missing: readonly string[];
  };
  readonly payload: {
    readonly legacyChars: number;
    readonly compiledChars: number;
  };
}

/**
 * One row of evidence: the parsed verdict plus the binding identity the row
 * recorded beside it.
 *
 * The identity fields are optional at both ends on purpose. A render that
 * failed a precondition never reaches `produce`, so it carries a
 * `shadowComparison` and NO `meta.render` — and a summary that filled those in
 * with a default would invent a binding the row never ran on.
 */
export interface ShadowEvidenceRecord {
  readonly comparison: ShadowEvidenceComparison;
  /** `meta.variantKind` — the variant lane's change kind, absent on other lanes. */
  readonly variantKind?: string | null;
  readonly modelSlug?: string | null;
  readonly profileId?: string | null;
  readonly executedVersionId?: string | null;
  readonly promptStrategy?: string | null;
}

/** What an absent identity value is called, so it is never printed as zero or as a guess. */
export const SHADOW_EVIDENCE_ABSENT = "(not recorded)";

/**
 * What the stored record cannot tell a reader, stated once and carried on every
 * summary so a report cannot print its numbers without it.
 */
export const SHADOW_EVIDENCE_TRUNCATION_NOTE =
  "Every list on a stored verdict is capped at its first 16 entries (SHADOW_LIST_LIMIT, shadow-comparison.ts): " +
  "a record showing 16 missing facts may have lost more, and the full lists exist only on the diagnostic sink. " +
  "Two shadow codes never reach a row at all — image_shadow.allowlist_inert and image_shadow.capture_refused are " +
  "sink-only — so this report cannot see how often a seeded delta was filtered away or which side's capture refused.";

/** One value and how many records carried it. */
export interface ShadowEvidenceTally {
  readonly value: string;
  readonly count: number;
}

/** The four buckets, never folded into each other. */
export interface ShadowVerdictCounts {
  readonly parity: number;
  readonly divergence: number;
  readonly unmeasured: number;
  readonly error: number;
}

/** Min/median/max/mean over a set of lengths. Absent (`null`) when nothing was measured. */
export interface ShadowLengthStats {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * The payload comparison — legacy chars against compiled chars.
 *
 * A record whose `compiledChars` is 0 is the UNMEASURED signature: the
 * refusal and comparator-failure factories both record a zero-length compiled
 * side because there was no compiled prompt to measure. Counting those into a
 * mean would report a payload shrink that is really an absence, so they are
 * excluded and counted on their own.
 */
export interface ShadowPayloadStats {
  /** Records that carried a compiled prompt and were measured. */
  readonly measured: number;
  /** Records excluded for `compiledChars === 0` — no compiled prompt existed. */
  readonly excludedNoCompiled: number;
  readonly legacy: ShadowLengthStats | null;
  readonly compiled: ShadowLengthStats | null;
}

/** Coverage mismatches, attributed over the records that actually measured coverage. */
export interface ShadowCoverageStats {
  /** Records whose coverage half was measured at all (`matches !== null`), `error` excluded. */
  readonly attributed: number;
  readonly withMissing: number;
  readonly withUnexpected: number;
  readonly withDuplicated: number;
  readonly withStaleAllowlist: number;
  /** Fact-name frequency, descending by count then name. Names are subject-agnostic. */
  readonly missingFacts: readonly ShadowEvidenceTally[];
  readonly unexpectedFacts: readonly ShadowEvidenceTally[];
  readonly duplicatedFacts: readonly ShadowEvidenceTally[];
  readonly staleAllowlistEntries: readonly ShadowEvidenceTally[];
}

export interface ShadowTransportStats {
  readonly parity: number;
  readonly mismatches: number;
  /** `transport.parity === null` — a side carried no capture. Unmeasured, not passing. */
  readonly uncaptured: number;
  readonly firstMismatches: readonly ShadowEvidenceTally[];
}

/** The mandatory-survival half, over the records that measured it (`error` excluded). */
export interface ShadowMandatoryStats {
  readonly attributed: number;
  readonly failures: number;
  readonly missingFacts: readonly ShadowEvidenceTally[];
}

/** Which binding the evidence applies to, and whether it moved mid-window. */
export interface ShadowBindingIdentity {
  readonly modelSlug: readonly ShadowEvidenceTally[];
  readonly profileId: readonly ShadowEvidenceTally[];
  readonly promptStrategy: readonly ShadowEvidenceTally[];
  /**
   * The provider version each render actually executed. More than one entry
   * means the endpoint moved underneath the window, and the halves are not one
   * experiment.
   */
  readonly executedVersionId: readonly ShadowEvidenceTally[];
}

export interface ShadowVariantKindBreakdown {
  readonly variantKind: string;
  readonly total: number;
  readonly verdicts: ShadowVerdictCounts;
}

export interface ShadowEvidenceSummary {
  readonly total: number;
  readonly verdicts: ShadowVerdictCounts;
  /**
   * `parity + divergence` — the records that produced evidence either way, and
   * the ONLY honest denominator for a parity rate. Stated beside `total` and
   * the verdict counts so a reader can always say "N of M measured, K
   * unmeasured, E error".
   */
  readonly measured: number;
  /** Every code on every record, descending by count then code. Codes ≠ divergence. */
  readonly codes: readonly ShadowEvidenceTally[];
  readonly coverage: ShadowCoverageStats;
  readonly transport: ShadowTransportStats;
  readonly mandatory: ShadowMandatoryStats;
  readonly payload: ShadowPayloadStats;
  readonly binding: ShadowBindingIdentity;
  /** Per-`meta.variantKind` verdict split, descending by total then kind. */
  readonly byVariantKind: readonly ShadowVariantKindBreakdown[];
  readonly lanes: readonly ShadowEvidenceTally[];
  readonly truncatedListNote: string;
}

// ---------------------------------------------------------------------------
// Counting helpers
// ---------------------------------------------------------------------------

function bump(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

/**
 * A frequency table, descending by count and then ascending by value.
 *
 * The second key is not cosmetic: a tie broken by insertion order would make
 * the same window print differently depending on the row order the query
 * happened to return, and two runs of one report that disagree are two reports.
 */
function tallies(counts: ReadonlyMap<string, number>): ShadowEvidenceTally[] {
  return [...counts.entries()]
    .map(([value, count]): ShadowEvidenceTally => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Absent identity is NAMED, never dropped and never defaulted to some other row's value. */
function identityValue(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? SHADOW_EVIDENCE_ABSENT : value;
}

function lengthStats(values: readonly number[]): ShadowLengthStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1] ?? 0;
  const upper = sorted[middle] ?? 0;
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    median: sorted.length % 2 === 0 ? (lower + upper) / 2 : upper,
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

function emptyVerdictCounts(): { parity: number; divergence: number; unmeasured: number; error: number } {
  return { parity: 0, divergence: 0, unmeasured: 0, error: 0 };
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/**
 * Summarize a window of shadow verdicts.
 *
 * Total over its input: it reads only the fields it declares, and a record with
 * a shape the schema no longer produces would have failed typecheck at the
 * driver's parse seam rather than reaching here.
 *
 * Three rules the arithmetic keeps, all of them promotion-relevant:
 *
 * 1. `unmeasured` is NEVER counted as passing. It has its own bucket, and the
 *    measured denominator excludes it.
 * 2. `error` records are excluded from coverage and mandatory ATTRIBUTION —
 *    their `matches: false` / `survived: false` are the containment factory
 *    filling a shape, not measurements — while still being counted as records
 *    and having their codes tallied.
 * 3. Payload statistics exclude records with no compiled prompt.
 */
export function summarizeShadowEvidence(records: readonly ShadowEvidenceRecord[]): ShadowEvidenceSummary {
  const verdicts = emptyVerdictCounts();
  const codes = new Map<string, number>();
  const lanes = new Map<string, number>();

  let coverageAttributed = 0;
  let withMissing = 0;
  let withUnexpected = 0;
  let withDuplicated = 0;
  let withStaleAllowlist = 0;
  const missingFacts = new Map<string, number>();
  const unexpectedFacts = new Map<string, number>();
  const duplicatedFacts = new Map<string, number>();
  const staleAllowlistEntries = new Map<string, number>();

  let transportParity = 0;
  let transportMismatches = 0;
  let transportUncaptured = 0;
  const firstMismatches = new Map<string, number>();

  let mandatoryAttributed = 0;
  let mandatoryFailures = 0;
  const mandatoryMissing = new Map<string, number>();

  const legacyChars: number[] = [];
  const compiledChars: number[] = [];
  let excludedNoCompiled = 0;

  const modelSlug = new Map<string, number>();
  const profileId = new Map<string, number>();
  const promptStrategy = new Map<string, number>();
  const executedVersionId = new Map<string, number>();
  const byVariantKind = new Map<string, { parity: number; divergence: number; unmeasured: number; error: number }>();

  for (const record of records) {
    const { comparison } = record;
    verdicts[comparison.verdict] += 1;
    bump(lanes, comparison.lane);
    for (const code of comparison.codes) bump(codes, code);

    bump(modelSlug, identityValue(record.modelSlug));
    bump(profileId, identityValue(record.profileId));
    bump(promptStrategy, identityValue(record.promptStrategy));
    bump(executedVersionId, identityValue(record.executedVersionId));

    const kind = identityValue(record.variantKind);
    const kindCounts = byVariantKind.get(kind) ?? emptyVerdictCounts();
    kindCounts[comparison.verdict] += 1;
    byVariantKind.set(kind, kindCounts);

    // Trap 1: the comparator-failure record writes `coverage.matches: false` and
    // `mandatory.survived: false` to fill the record's shape. Attributing those
    // would report every comparator crash as a lost fact and a lost anchor.
    const attributable = comparison.verdict !== "error";

    if (attributable && comparison.coverage.matches !== null) {
      coverageAttributed += 1;
      if (comparison.coverage.missing.length > 0) withMissing += 1;
      if (comparison.coverage.unexpected.length > 0) withUnexpected += 1;
      if (comparison.coverage.duplicated.length > 0) withDuplicated += 1;
      if (comparison.coverage.staleAllowlist.length > 0) withStaleAllowlist += 1;
      for (const fact of comparison.coverage.missing) bump(missingFacts, fact);
      for (const fact of comparison.coverage.unexpected) bump(unexpectedFacts, fact);
      for (const fact of comparison.coverage.duplicated) bump(duplicatedFacts, fact);
      for (const entry of comparison.coverage.staleAllowlist) bump(staleAllowlistEntries, entry);
    }

    // Transport keeps `error` records in the uncaptured bucket rather than
    // dropping them: a failed comparator genuinely captured nothing, and its
    // `parity: null` is the same honest absence every other unmeasured side has.
    if (comparison.transport.parity === null) transportUncaptured += 1;
    else if (comparison.transport.parity) transportParity += 1;
    else {
      transportMismatches += 1;
      if (comparison.transport.firstMismatch !== null) bump(firstMismatches, comparison.transport.firstMismatch);
    }

    if (attributable && comparison.mandatory.survived !== null) {
      mandatoryAttributed += 1;
      if (!comparison.mandatory.survived) mandatoryFailures += 1;
      for (const fact of comparison.mandatory.missing) bump(mandatoryMissing, fact);
    }

    if (comparison.payload.compiledChars === 0) excludedNoCompiled += 1;
    else {
      legacyChars.push(comparison.payload.legacyChars);
      compiledChars.push(comparison.payload.compiledChars);
    }
  }

  return {
    total: records.length,
    verdicts,
    measured: verdicts.parity + verdicts.divergence,
    codes: tallies(codes),
    coverage: {
      attributed: coverageAttributed,
      withMissing,
      withUnexpected,
      withDuplicated,
      withStaleAllowlist,
      missingFacts: tallies(missingFacts),
      unexpectedFacts: tallies(unexpectedFacts),
      duplicatedFacts: tallies(duplicatedFacts),
      staleAllowlistEntries: tallies(staleAllowlistEntries),
    },
    transport: {
      parity: transportParity,
      mismatches: transportMismatches,
      uncaptured: transportUncaptured,
      firstMismatches: tallies(firstMismatches),
    },
    mandatory: {
      attributed: mandatoryAttributed,
      failures: mandatoryFailures,
      missingFacts: tallies(mandatoryMissing),
    },
    payload: {
      measured: compiledChars.length,
      excludedNoCompiled,
      legacy: lengthStats(legacyChars),
      compiled: lengthStats(compiledChars),
    },
    binding: {
      modelSlug: tallies(modelSlug),
      profileId: tallies(profileId),
      promptStrategy: tallies(promptStrategy),
      executedVersionId: tallies(executedVersionId),
    },
    byVariantKind: [...byVariantKind.entries()]
      .map(([variantKind, counts]): ShadowVariantKindBreakdown => ({
        variantKind,
        total: counts.parity + counts.divergence + counts.unmeasured + counts.error,
        verdicts: counts,
      }))
      .sort(
        (a, b) =>
          b.total - a.total ||
          (a.variantKind < b.variantKind ? -1 : a.variantKind > b.variantKind ? 1 : 0),
      ),
    lanes: tallies(lanes),
    truncatedListNote: SHADOW_EVIDENCE_TRUNCATION_NOTE,
  };
}

/**
 * The one line every consumer must be able to print: parity against the
 * measured denominator, with the two non-evidence buckets stated beside it.
 *
 * Lives here rather than in the driver so the phrasing cannot drift into "N of
 * M passed" somewhere downstream — the sentence is part of the contract.
 */
export function shadowEvidenceHeadline(summary: ShadowEvidenceSummary): string {
  const { verdicts, measured, total } = summary;
  const rate = measured === 0 ? "no measured evidence" : `${Math.round((verdicts.parity / measured) * 100)}% of measured`;
  return (
    `${String(verdicts.parity)} parity of ${String(measured)} measured (${rate}); ` +
    `${String(verdicts.divergence)} divergence, ${String(verdicts.unmeasured)} unmeasured, ` +
    `${String(verdicts.error)} error, ${String(total)} records. ` +
    "Unmeasured and error are not passes."
  );
}
