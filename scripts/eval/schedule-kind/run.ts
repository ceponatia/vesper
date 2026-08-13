import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characters, db } from "@/server/db";
import {
  HARD_EFFECT_SCHEDULE_KINDS,
  hasHardEffectCandidate,
  inferScheduleKind,
  type ScheduleKind,
  type ScheduleKindClassification,
} from "./classifier";
import { SCHEDULE_KIND_FIXTURES } from "./fixtures";

const DEFAULT_OUT = process.env.EVAL_OUT || "data/eval/schedule-kind";

interface Args {
  fixturesOnly: boolean;
  limit?: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      flags.set(key, value);
      index += 1;
    } else {
      bools.add(key);
    }
  }
  const limitRaw = Number(flags.get("limit"));
  return {
    fixturesOnly: bools.has("fixtures-only"),
    ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.floor(limitRaw) } : {}),
    out: flags.get("out") ?? DEFAULT_OUT,
  };
}

const label = (status: string, kind: ScheduleKind | null): string =>
  status === "matched" ? `matched:${kind ?? "none"}` : status;

function increment(matrix: Record<string, Record<string, number>>, expected: string, actual: string): void {
  const row = (matrix[expected] ??= {});
  row[actual] = (row[actual] ?? 0) + 1;
}

function summarize(classifications: readonly ScheduleKindClassification[]): {
  total: number;
  matched: number;
  ambiguous: number;
  unknown: number;
  coverage: number;
  byKind: Partial<Record<ScheduleKind, number>>;
} {
  const matched = classifications.filter((item) => item.status === "matched");
  const byKind: Partial<Record<ScheduleKind, number>> = {};
  for (const item of matched) {
    if (item.kind) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  }
  return {
    total: classifications.length,
    matched: matched.length,
    ambiguous: classifications.filter((item) => item.status === "ambiguous").length,
    unknown: classifications.filter((item) => item.status === "unknown").length,
    coverage: classifications.length ? matched.length / classifications.length : 0,
    byKind,
  };
}

async function profileAudit(limit?: number): Promise<{
  rows: Array<{
    characterId: string;
    characterName: string;
    scheduleIndex: number;
    activity: string;
    locationName: string;
    classification: ScheduleKindClassification;
  }>;
  summary: ReturnType<typeof summarize>;
  hardEffectReviewQueue: Array<{
    characterId: string;
    characterName: string;
    scheduleIndex: number;
    activity: string;
    locationName: string;
    classification: ScheduleKindClassification;
  }>;
}> {
  const characterRows = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters);
  const selected = limit ? characterRows.slice(0, limit) : characterRows;
  const rows = selected.flatMap((character) => {
    const profile = parseOr(
      characterProfileSchema,
      character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    return profile.schedule.map((entry, scheduleIndex) => ({
      characterId: character.id,
      characterName: character.name,
      scheduleIndex,
      activity: entry.activity,
      locationName: entry.locationName,
      classification: inferScheduleKind(entry.activity),
    }));
  });
  return {
    rows,
    summary: summarize(rows.map((row) => row.classification)),
    hardEffectReviewQueue: rows.filter((row) => hasHardEffectCandidate(row.classification)),
  };
}

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2));
  const confusion: Record<string, Record<string, number>> = {};
  const fixtures = SCHEDULE_KIND_FIXTURES.map((fixture) => {
    const classification = inferScheduleKind(fixture.activity);
    const expected = label(fixture.expectedStatus, fixture.expectedKind);
    const actual = label(classification.status, classification.kind);
    increment(confusion, expected, actual);
    return {
      ...fixture,
      classification,
      correct: expected === actual,
      falsePositiveHardEffect:
        classification.status === "matched" &&
        classification.kind != null &&
        HARD_EFFECT_SCHEDULE_KINDS.has(classification.kind) &&
        (fixture.expectedStatus !== "matched" || fixture.expectedKind !== classification.kind),
    };
  });

  const falsePositiveHardEffects = fixtures.filter((fixture) => fixture.falsePositiveHardEffect);
  const fixtureAccuracy = fixtures.filter((fixture) => fixture.correct).length / fixtures.length;
  const profiles = args.fixturesOnly ? null : await profileAudit(args.limit);
  const passed = fixtureAccuracy === 1 && falsePositiveHardEffects.length === 0;
  const result = {
    schemaVersion: 1,
    experiment: "gate0-schedule-kind-shadow",
    generatedAt: new Date().toISOString(),
    classifierMode: "read-only-shadow",
    fixtureSummary: {
      total: fixtures.length,
      correct: fixtures.filter((fixture) => fixture.correct).length,
      accuracy: fixtureAccuracy,
      falsePositiveHardEffects: falsePositiveHardEffects.length,
      passed,
    },
    confusion,
    fixtures,
    profiles,
    decision: {
      productionEffectsAllowed: false,
      promotion: "blocked_pending_manual_profile_review",
      rationale:
        "A perfect curated corpus only establishes a cheap shadow baseline. Every hard-effect candidate from authored prose still requires manual review and a typed schedule contract before effects.",
    },
  };

  await fs.mkdir(args.out, { recursive: true });
  const outPath = path.join(args.out, "audit.json");
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(
    [
      `fixtures ${result.fixtureSummary.correct}/${result.fixtureSummary.total}`,
      `hard false positives ${result.fixtureSummary.falsePositiveHardEffects}`,
      profiles
        ? `profile rows ${profiles.summary.total} (matched ${profiles.summary.matched}, ambiguous ${profiles.summary.ambiguous}, unknown ${profiles.summary.unknown})`
        : "profiles skipped",
    ].join(" · "),
  );
  console.log(`wrote shadow audit → ${outPath}`);
  return passed;
}

main()
  .then(async (passed) => {
    await globalThis.__vesperPool?.end();
    process.exit(passed ? 0 : 2);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await globalThis.__vesperPool?.end();
    process.exit(1);
  });
