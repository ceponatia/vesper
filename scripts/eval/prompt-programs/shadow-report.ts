import "dotenv/config";
import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { db, images } from "@/server/db";
import { IMAGE_SHADOW_COMPARISON_META_KEY, parseImageShadowComparison } from "@/server/images";
import {
  shadowEvidenceHeadline,
  summarizeShadowEvidence,
  type ShadowEvidenceRecord,
  type ShadowEvidenceSummary,
  type ShadowEvidenceTally,
} from "@/lib/images/shadow-evidence";

/**
 * THE SHADOW-WINDOW REPORT — what a window of recorded shadow verdicts says
 * about cutting a character image lane over (issue #256).
 *
 * A lane in shadow compiles the candidate prompt program beside its production
 * prompt and records the comparison on the row
 * (`server/images/shadow-comparison.ts`, `image.meta.shadowComparison`). This
 * script is the reading of that: a narrowed query, a defensive parse, and the
 * pure aggregator in `@/lib/images/shadow-evidence`. All of the arithmetic —
 * and every rule about which records may be attributed to what — lives there
 * and is covered by `pnpm test`; nothing here does anything but fetch and
 * print.
 *
 * **It spends nothing.** No provider is contacted and no row is written.
 *
 * ## What it may print, and what it therefore cannot leak
 *
 * Counts, diagnostic CODES, canonical shadow FACT NAMES, prompt LENGTHS, and
 * the binding identity (`meta.render`). Never prompt text, never a character
 * name, never an attribute value. The fact names are safe by construction, not
 * by convention: `shadowFactName` strips the subject prefix, so a stored name is
 * `horns` or `exposure.torso`, never a character id.
 *
 * ## Reading the numbers
 *
 * The four verdicts are separate and stay separate. `unmeasured` is NOT a pass —
 * it is a render that produced no evidence either way (no binding, no fact list,
 * a capture that refused to plan) — and `error` is the comparator itself
 * breaking. The only honest denominator for a parity rate is the MEASURED count
 * (`parity + divergence`), which is why the headline states all four buckets.
 *
 * Two limits the window cannot see past, both restated on every run:
 *
 * - every list on a stored verdict is capped at 16 entries, so a fact frequency
 *   table is a floor;
 * - `image_shadow.allowlist_inert` and `image_shadow.capture_refused` are
 *   sink-only codes that never reach a row.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/eval/prompt-programs/shadow-report.ts
 * pnpm tsx scripts/eval/prompt-programs/shadow-report.ts --kind portrait_variant --variant-kind pose
 * pnpm tsx scripts/eval/prompt-programs/shadow-report.ts --since 2026-08-29T00:00:00Z --json
 * ```
 *
 * Locally it reads `DATABASE_URL` through dotenv. Against production, run it on
 * the machine that holds the database:
 *
 * ```
 * fly ssh console -a vesper -C "pnpm tsx scripts/eval/prompt-programs/shadow-report.ts"
 * ```
 */

const USAGE = [
  "Usage: pnpm tsx scripts/eval/prompt-programs/shadow-report.ts [options]",
  "  --kind <image kind>     one of: avatar, portrait_variant, scene, chat_look (default portrait_variant)",
  "  --lane <lane>           the shadow lane recorded on the verdict (avatar, variant, scene, chat_look)",
  "  --variant-kind <kind>   meta.variantKind — pose, outfit, expression, setting, nsfw_test",
  "  --model <slug>          meta.render.modelSlug",
  "  --since <ISO>           rows created at or after this instant",
  "  --until <ISO>           rows created at or before this instant",
  "  --limit <n>             row cap (default 500). A hit cap is reported, never silent.",
  "  --json                  print the summary object instead of the text report",
  "  --help                  print this and exit",
].join("\n");

/**
 * The image kinds the character-bearing lanes write. Closed, because `--kind`
 * reaches a typed enum column and an unknown value would be a silently empty
 * window rather than a mistake anybody notices.
 */
const SHADOW_IMAGE_KINDS = ["avatar", "portrait_variant", "scene", "chat_look"] as const;
type ShadowImageKind = (typeof SHADOW_IMAGE_KINDS)[number];

const DEFAULT_KIND: ShadowImageKind = "portrait_variant";
const DEFAULT_LIMIT = 500;

/**
 * The `meta` keys this report narrows on, spelled INTO the statement rather
 * than bound.
 *
 * `jsonb ->> $1` is ambiguous to Postgres — the operator is overloaded on
 * `text` and `integer`, so an untyped bind parameter fails to resolve; the same
 * note and the same `sql.raw` shape live on `server/db/job-liveness.ts`. Every
 * key below is a code-owned literal from this closed set, so nothing
 * user-supplied ever reaches the statement text. The VALUES stay bound.
 */
const META_KEYS = {
  shadow: IMAGE_SHADOW_COMPARISON_META_KEY,
  variantKind: "variantKind",
  render: "render",
  lane: "lane",
  modelSlug: "modelSlug",
} as const;

function jsonKey(key: (typeof META_KEYS)[keyof typeof META_KEYS]): SQL {
  return sql.raw(`'${key}'`);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * A `--flag value` pair, or null when the flag is ABSENT.
 *
 * A flag that is present but carries no usable value — nothing after it,
 * another flag after it, or an empty string from an unset shell variable —
 * exits rather than reading as absent. The two are opposite intentions, and
 * here the difference is the SCOPE of a claim: `--variant-kind "$UNSET"` would
 * quietly report the whole lane's window under a heading that says one kind.
 */
function flagValue(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  if (at < 0) return null;
  const next = process.argv[at + 1];
  if (next === undefined || next.startsWith("--") || next.trim().length === 0) {
    console.error(`${flag} was given without a value. Pass one, or omit the flag entirely.`);
    process.exit(1);
  }
  return next;
}

function instantValue(flag: string): Date | null {
  const raw = flagValue(flag);
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`${flag} is not a parsable instant: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

interface ReportArgs {
  readonly kind: ShadowImageKind;
  readonly lane: string | null;
  readonly variantKind: string | null;
  readonly modelSlug: string | null;
  readonly since: Date | null;
  readonly until: Date | null;
  readonly limit: number;
  readonly json: boolean;
}

function readArgs(): ReportArgs {
  const rawKind = flagValue("--kind");
  const kind = SHADOW_IMAGE_KINDS.find((known) => known === rawKind);
  if (rawKind !== null && kind === undefined) {
    console.error(`--kind must be one of ${SHADOW_IMAGE_KINDS.join(", ")}: ${rawKind}`);
    process.exit(1);
  }
  const rawLimit = flagValue("--limit");
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`--limit must be a positive whole number of rows: ${String(rawLimit)}`);
    process.exit(1);
  }
  return {
    kind: kind ?? DEFAULT_KIND,
    lane: flagValue("--lane"),
    variantKind: flagValue("--variant-kind"),
    modelSlug: flagValue("--model"),
    since: instantValue("--since"),
    until: instantValue("--until"),
    limit,
    json: process.argv.includes("--json"),
  };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface LoadedWindow {
  readonly records: readonly ShadowEvidenceRecord[];
  /**
   * Rows that matched the window and carry a `shadowComparison` the schema
   * could not read — an older shape, or a hand-edited blob. Counted and
   * reported separately, never coerced into a verdict and never counted as
   * zero of anything.
   */
  readonly unreadable: number;
  readonly rowsRead: number;
  readonly capHit: boolean;
}

/**
 * One pass over the window.
 *
 * Narrowed by `kind` and `created_at` FIRST: there is no index on `meta`, so
 * every jsonb predicate below is evaluated over whatever the indexed columns
 * already reduced the scan to.
 */
async function loadWindow(args: ReportArgs): Promise<LoadedWindow> {
  const conditions = [
    eq(images.kind, args.kind),
    ...(args.since === null ? [] : [gte(images.createdAt, args.since)]),
    ...(args.until === null ? [] : [lte(images.createdAt, args.until)]),
    // A row with no verdict is not evidence of anything; excluding it in SQL
    // keeps the reported row count equal to the window this report describes.
    sql`${images.meta} -> ${jsonKey(META_KEYS.shadow)} IS NOT NULL`,
    ...(args.lane === null
      ? []
      : [sql`${images.meta} -> ${jsonKey(META_KEYS.shadow)} ->> ${jsonKey(META_KEYS.lane)} = ${args.lane}`]),
    ...(args.variantKind === null
      ? []
      : [sql`${images.meta} ->> ${jsonKey(META_KEYS.variantKind)} = ${args.variantKind}`]),
    ...(args.modelSlug === null
      ? []
      : [sql`${images.meta} -> ${jsonKey(META_KEYS.render)} ->> ${jsonKey(META_KEYS.modelSlug)} = ${args.modelSlug}`]),
  ];

  const rows = await db()
    .select({ meta: images.meta })
    .from(images)
    .where(and(...conditions))
    .orderBy(asc(images.createdAt))
    .limit(args.limit);

  let unreadable = 0;
  const records: ShadowEvidenceRecord[] = [];
  for (const row of rows) {
    const meta: Record<string, unknown> = isRecord(row.meta) ? row.meta : {};
    // The assignment below is also the DRIFT GUARD between the stored schema
    // and the pure module's structural view of it: `apps/web/src/lib` may not
    // import `@/server`, so a schema field that is removed, renamed or retyped
    // fails typecheck here rather than being mis-summarized in silence.
    const comparison = parseImageShadowComparison(meta[IMAGE_SHADOW_COMPARISON_META_KEY]);
    if (comparison === null) {
      unreadable += 1;
      continue;
    }
    // `meta.render` is the authoritative binding identity and is written at
    // PRODUCE time. A render that failed a precondition never reaches produce,
    // so it carries a verdict with no `meta.render` at all — the summary names
    // that absence rather than inheriting another row's binding.
    const rawRender = meta[META_KEYS.render];
    const render = isRecord(rawRender) ? rawRender : null;
    records.push({
      comparison,
      variantKind: stringOrNull(meta[META_KEYS.variantKind]),
      modelSlug: stringOrNull(render?.modelSlug),
      profileId: stringOrNull(render?.profileId),
      promptStrategy: stringOrNull(render?.promptStrategy),
      executedVersionId: stringOrNull(render?.executedVersionId),
    });
  }
  return { records, unreadable, rowsRead: rows.length, capHit: rows.length === args.limit };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tallyLine(entries: readonly ShadowEvidenceTally[]): string {
  return entries.length === 0
    ? "(none)"
    : entries.map((entry) => `${entry.value} ${String(entry.count)}`).join(", ");
}

function lengths(stats: ShadowEvidenceSummary["payload"]["legacy"]): string {
  return stats === null
    ? "(nothing measured)"
    : `min ${String(stats.min)}, median ${String(stats.median)}, max ${String(stats.max)}, mean ${stats.mean.toFixed(1)}`;
}

function printReport(args: ReportArgs, loaded: LoadedWindow, summary: ShadowEvidenceSummary): void {
  const filters = [
    `kind ${args.kind}`,
    args.lane === null ? null : `lane ${args.lane}`,
    args.variantKind === null ? null : `variantKind ${args.variantKind}`,
    args.modelSlug === null ? null : `model ${args.modelSlug}`,
    args.since === null ? null : `since ${args.since.toISOString()}`,
    args.until === null ? null : `until ${args.until.toISOString()}`,
  ].filter((entry): entry is string => entry !== null);

  console.log(`\n##### Shadow window — ${filters.join(", ")}`);
  console.log(`  rows with a verdict: ${String(loaded.rowsRead)}${loaded.capHit ? ` (AT THE --limit ${String(args.limit)} CAP — the window is truncated, raise it or narrow the dates)` : ""}`);
  console.log(`  unreadable verdicts: ${String(loaded.unreadable)} (a stored blob the schema could not parse; excluded from every figure below)`);
  console.log(`\n  ${shadowEvidenceHeadline(summary)}`);

  console.log("\n=== Binding identity — which configuration this evidence describes");
  console.log(`  model          ${tallyLine(summary.binding.modelSlug)}`);
  console.log(`  profile        ${tallyLine(summary.binding.profileId)}`);
  console.log(`  promptStrategy ${tallyLine(summary.binding.promptStrategy)}`);
  console.log(`  executedVersion ${tallyLine(summary.binding.executedVersionId)}`);
  if (summary.binding.executedVersionId.length > 1) {
    console.log("  NOTE: more than one executed version — the provider moved mid-window, so these renders are not one experiment.");
  }
  console.log(`  lanes          ${tallyLine(summary.lanes)}`);

  console.log("\n=== Codes (every record's codes; an unmeasured record carries codes too, so this is not a divergence count)");
  for (const entry of summary.codes) console.log(`  ${entry.value.padEnd(38)} ${String(entry.count)}`);
  if (summary.codes.length === 0) console.log("  (none)");

  console.log(`\n=== Coverage — attributed over ${String(summary.coverage.attributed)} records that measured it (error records excluded)`);
  console.log(`  records with lost facts:       ${String(summary.coverage.withMissing)}`);
  console.log(`  records with leaked facts:     ${String(summary.coverage.withUnexpected)}`);
  console.log(`  records with duplicated facts: ${String(summary.coverage.withDuplicated)}`);
  console.log(`  records with a stale allowlist:${String(summary.coverage.withStaleAllowlist)}`);
  console.log(`  lost:       ${tallyLine(summary.coverage.missingFacts)}`);
  console.log(`  leaked:     ${tallyLine(summary.coverage.unexpectedFacts)}`);
  console.log(`  duplicated: ${tallyLine(summary.coverage.duplicatedFacts)}`);
  console.log(`  stale:      ${tallyLine(summary.coverage.staleAllowlistEntries)}`);

  console.log("\n=== Transport");
  console.log(`  parity ${String(summary.transport.parity)}, mismatch ${String(summary.transport.mismatches)}, uncaptured ${String(summary.transport.uncaptured)} (uncaptured is unmeasured, not passing)`);
  console.log(`  first mismatching field: ${tallyLine(summary.transport.firstMismatches)}`);

  console.log(`\n=== Mandatory anchors — attributed over ${String(summary.mandatory.attributed)} records (error records excluded)`);
  console.log(`  records that lost an anchor: ${String(summary.mandatory.failures)}`);
  console.log(`  anchors lost: ${tallyLine(summary.mandatory.missingFacts)}`);

  console.log(`\n=== Payload — ${String(summary.payload.measured)} records measured, ${String(summary.payload.excludedNoCompiled)} excluded for having no compiled prompt`);
  console.log(`  legacy chars:   ${lengths(summary.payload.legacy)}`);
  console.log(`  compiled chars: ${lengths(summary.payload.compiled)}`);

  if (summary.byVariantKind.length > 0) {
    console.log("\n=== By variant kind");
    for (const entry of summary.byVariantKind) {
      const { parity, divergence, unmeasured, error } = entry.verdicts;
      console.log(
        `  ${entry.variantKind.padEnd(16)} ${String(entry.total).padStart(4)} rows — ` +
          `parity ${String(parity)}, divergence ${String(divergence)}, unmeasured ${String(unmeasured)}, error ${String(error)}`,
      );
    }
  }

  console.log(`\n${summary.truncatedListNote}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const args = readArgs();
  const loaded = await loadWindow(args);
  const summary = summarizeShadowEvidence(loaded.records);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          filters: {
            kind: args.kind,
            lane: args.lane,
            variantKind: args.variantKind,
            modelSlug: args.modelSlug,
            since: args.since?.toISOString() ?? null,
            until: args.until?.toISOString() ?? null,
            limit: args.limit,
          },
          rowsRead: loaded.rowsRead,
          limitCapHit: loaded.capHit,
          unreadableVerdicts: loaded.unreadable,
          headline: shadowEvidenceHeadline(summary),
          ...summary,
        },
        null,
        2,
      ),
    );
    return;
  }
  printReport(args, loaded, summary);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
