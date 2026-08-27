import { describe, expect, it } from "vitest";
import { AUDIT_DIMENSIONS, type AuditDimension, type DimensionVerdict } from "./judge";
import {
  buildTrialSummary,
  digest,
  trialSummarySchema,
  type BuildTrialSummaryInput,
  type SummaryExchangeAudit,
  type SummaryScenario,
} from "./summary";

/**
 * The committed-record guard.
 *
 * `summary.json` is the only audit trail a paid round leaves behind in git, and
 * generation is not reproducible — so a summary that fails its own schema, or
 * silently miscounts, cannot be re-derived later. These assertions are the
 * cheapest place to catch that: pure, no model calls, no fixtures.
 */

const cleanVerdicts = (): Record<AuditDimension, DimensionVerdict> => {
  const verdicts = {} as Record<AuditDimension, DimensionVerdict>;
  for (const dimension of AUDIT_DIMENSIONS) verdicts[dimension] = "clean";
  return verdicts;
};

function exchange(index: number, overrides: Partial<SummaryExchangeAudit> = {}): SummaryExchangeAudit {
  return {
    index,
    verdicts: cleanVerdicts(),
    violations: [],
    discarded: [],
    ...overrides,
  };
}

/**
 * Two scenarios: one where the cue arm was convicted (one verified violation,
 * one discarded) and the control arm was clean, and one whose cue-arm audit
 * degraded — the case that must contribute nothing rather than a zero.
 */
function scenarios(): SummaryScenario[] {
  return [
    {
      scenarioId: "provenance-bath",
      audits: {
        cues: {
          degraded: false,
          exchanges: [
            exchange(1, {
              verdicts: { ...cleanVerdicts(), provenance: "violated", coverage: "not_applicable" },
              violations: [{ dimension: "provenance", quote: "still wet from the rain", match: "exchange" }],
            }),
            exchange(2, {
              verdicts: { ...cleanVerdicts(), wetness_degree: "violated" },
              discarded: [{ dimension: "wetness_degree" }],
            }),
          ],
        },
        control: { degraded: false, exchanges: [exchange(1), exchange(2)] },
      },
    },
    {
      scenarioId: "binding-braid",
      audits: {
        cues: { degraded: true, exchanges: [] },
        control: { degraded: false, exchanges: [exchange(1)] },
      },
    },
  ];
}

function input(overrides: Partial<BuildTrialSummaryInput> = {}): BuildTrialSummaryInput {
  return {
    experiment: "affordance cues — slice 5 rematch",
    matrix: "rematch",
    startedAt: "2026-07-29T18:00:00.000Z",
    finishedAt: "2026-07-29T18:24:00.000Z",
    verdict: "fail",
    fixtureCommit: { sha: "abc1234def5678", dirty: false },
    models: {
      narrator: "anthropic/claude-sonnet-4",
      narratorTemperature: 0.85,
      judge: "google/gemini-3.5-flash",
      judgeTemperature: 0,
    },
    hashes: { config: "0011223344556677", prompts: { cues: "aaaa1111", control: "bbbb2222" } },
    spend: {
      generationCalls: 60,
      auditCalls: 20,
      preferenceCalls: 10,
      approxTokens: { generationPrompt: 40_000, generationCompletion: 9_000, judgePrompt: 30_000 },
      keyUsageBefore: 31.53,
      keyUsageAfter: 33.43,
      usd: 1.9,
    },
    scenarios: scenarios(),
    ...overrides,
  };
}

describe("trialSummarySchema", () => {
  it("accepts a built summary", () => {
    const parsed = trialSummarySchema.safeParse(buildTrialSummary(input()));
    expect(parsed.success).toBe(true);
  });

  it("rejects a summary with no version", () => {
    const unversioned: Record<string, unknown> = { ...buildTrialSummary(input()) };
    delete unversioned.version;
    expect(trialSummarySchema.safeParse(unversioned).success).toBe(false);
  });

  it("rejects a summary from a future version", () => {
    expect(trialSummarySchema.safeParse({ ...buildTrialSummary(input()), version: 2 }).success).toBe(false);
  });

  it("rejects wrong types in the measured counts", () => {
    const summary = buildTrialSummary(input());
    const broken = {
      ...summary,
      arms: { ...summary.arms, cues: { ...summary.arms.cues, exchangesWithAnyViolation: "two" } },
    };
    expect(trialSummarySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a violation quote with no arm/scenario/exchange refs", () => {
    const summary = buildTrialSummary(input());
    const broken = { ...summary, violationQuotes: [{ dimension: "provenance", quote: "still wet from the rain" }] };
    expect(trialSummarySchema.safeParse(broken).success).toBe(false);
  });

  it("keeps physical-claim counts optional in both directions", () => {
    const without = buildTrialSummary(input());
    expect(without.arms.cues.physicalClaims).toBeUndefined();
    expect(trialSummarySchema.safeParse(without).success).toBe(true);

    const withClaims = buildTrialSummary(
      input({
        physicalClaims: {
          cues: { total: 34, perExchange: 1.42, contradictionsPerClaim: 0.21 },
          control: { total: 21, perExchange: 0.88, contradictionsPerClaim: 0.24 },
        },
      }),
    );
    expect(withClaims.arms.cues.physicalClaims?.total).toBe(34);
    expect(trialSummarySchema.safeParse(withClaims).success).toBe(true);
  });
});

describe("buildTrialSummary", () => {
  it("counts raw dimension verdicts, verified violations and discards separately", () => {
    const summary = buildTrialSummary(input());
    const cues = summary.arms.cues;
    expect(cues.dimensions.provenance).toMatchObject({
      violated: 1,
      verifiedViolations: 1,
      discardedViolations: 0,
      clean: 1,
    });
    // The raw verdict stands at 1 while the countable violation is 0 — the quote
    // failed verification, which is the whole point of the discard column.
    expect(cues.dimensions.wetness_degree).toMatchObject({
      violated: 1,
      verifiedViolations: 0,
      discardedViolations: 1,
    });
    expect(cues.verifiedViolations).toBe(1);
    expect(cues.discardedViolations).toBe(1);
  });

  it("reports exchanges with any violation, not just violation totals", () => {
    const summary = buildTrialSummary(input());
    expect(summary.arms.cues.exchangesAudited).toBe(2);
    expect(summary.arms.cues.exchangesWithAnyViolation).toBe(1);
    expect(summary.arms.cues.exchangesWithAnyViolationRate).toBe(0.5);
    expect(summary.arms.control.exchangesWithAnyViolation).toBe(0);
  });

  it("contributes nothing for a degraded audit rather than a clean zero", () => {
    const summary = buildTrialSummary(input());
    // The cue arm degraded on `binding-braid`: 1 of 2 scenarios audited, and its
    // exchanges never enter the denominator.
    expect(summary.arms.cues.scenariosAudited).toBe(1);
    expect(summary.arms.control.scenariosAudited).toBe(2);
    expect(summary.arms.control.exchangesAudited).toBe(3);
  });

  it("carries only quote-verified violations, with arm/scenario/exchange refs", () => {
    const summary = buildTrialSummary(input());
    expect(summary.violationQuotes).toEqual([
      {
        arm: "cues",
        scenarioId: "provenance-bath",
        exchange: 1,
        dimension: "provenance",
        quote: "still wet from the rain",
        match: "exchange",
      },
    ]);
  });

  it("carries no narration beyond the verified quotes", () => {
    const serialized = JSON.stringify(buildTrialSummary(input()));
    const quoted = serialized.includes("still wet from the rain");
    expect(quoted).toBe(true);
    // Nothing in the record is long enough to be a transcript: the only free text
    // is bounded by the quote schema's 400-char ceiling.
    for (const quote of buildTrialSummary(input()).violationQuotes) {
      expect(quote.quote.length).toBeLessThanOrEqual(400);
    }
  });
});

describe("digest", () => {
  it("is stable for the same ordered parts and changes with them", () => {
    expect(digest(["a", "b"])).toBe(digest(["a", "b"]));
    expect(digest(["a", "b"])).not.toBe(digest(["b", "a"]));
    expect(digest(["a"])).not.toBe(digest(["a", ""]));
    expect(digest([])).toHaveLength(16);
  });
});
