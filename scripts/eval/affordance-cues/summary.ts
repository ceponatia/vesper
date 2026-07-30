import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { AUDIT_DIMENSIONS, type AuditDimension, type DimensionVerdict } from "./judge";
import type { ArmId } from "./harness";

/**
 * The COMMITTABLE audit record for a narrator trial round
 * (`docs/developer-notes/narrator-physical-guidance.plan.md` §Slice 0).
 *
 * `run.ts` writes the full `trial.json` — every prompt, every reply, every judge
 * answer — into `data/`, which is gitignored, so the only surviving record of
 * the three-round affordance-cue campaign is a hand transcription into the trial
 * doc. That is not an audit trail: nobody can re-check a number without rerunning
 * a paid round that is not even reproducible (production temperature, no seed).
 *
 * This module defines the small, safe half of that record — the half a future
 * round can commit next to the fixtures:
 *
 * - what was run (matrix, fixture commit, prompt/config hashes, model ids), so a
 *   later round can tell whether it changed the instrument or the feature;
 * - what was measured (raw per-dimension verdict counts, exchanges with any
 *   violation, spend);
 * - which violations survived quote verification, as the short excerpts the
 *   trial docs already quote in public.
 *
 * What it deliberately does NOT carry: narration. No prompts, no replies, no
 * judge rationales, no player lines — only the verified violation quotes, which
 * are bounded excerpts of the same kind already published in the trial docs.
 * `trial.json` remains the place transcripts live, and remains gitignored.
 *
 * Physical-claim counts are OPTIONAL by design. Nothing computes them today; the
 * next campaign's claim-normalized measures (plan §Evaluation → "Claim-normalized")
 * are the instrument that will, and modelling the headroom now means that round
 * does not have to bump the schema version to report them.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Pinned to the harness's arm union — an arm added there fails to compile here. */
const SUMMARY_ARMS = ["cues", "control"] as const satisfies readonly ArmId[];

const armIdSchema = z.enum(SUMMARY_ARMS);
const dimensionSchema = z.enum(AUDIT_DIMENSIONS);

/**
 * One dimension's raw tally for one arm. `violated` is the judge's RAW verdict
 * count, before quote verification; it always equals
 * `verifiedViolations + discardedViolations`, and only the verified half feeds a
 * contradiction rate (rematch §Judge redesign — a violation whose quote is not in
 * the transcript is discarded, not counted).
 */
const dimensionCountsSchema = z.object({
  violated: z.number().int().min(0),
  verifiedViolations: z.number().int().min(0),
  discardedViolations: z.number().int().min(0),
  clean: z.number().int().min(0),
  notApplicable: z.number().int().min(0),
});

/**
 * Claim-normalized measures. Absent from every round run so far — no instrument
 * counts physical claims yet — and optional precisely so the round that builds
 * one can fill them in without a schema version bump.
 */
const physicalClaimsSchema = z.object({
  total: z.number().int().min(0),
  perExchange: z.number().min(0),
  contradictionsPerClaim: z.number().min(0),
});
export type TrialPhysicalClaims = z.infer<typeof physicalClaimsSchema>;

const armSummarySchema = z.object({
  scenariosAudited: z.number().int().min(0),
  exchangesAudited: z.number().int().min(0),
  /** The plan's primary measure: exchanges carrying at least one verified violation. */
  exchangesWithAnyViolation: z.number().int().min(0),
  exchangesWithAnyViolationRate: z.number().min(0).max(1),
  verifiedViolations: z.number().int().min(0),
  discardedViolations: z.number().int().min(0),
  dimensions: z.record(dimensionSchema, dimensionCountsSchema),
  physicalClaims: physicalClaimsSchema.optional(),
});

/** A violation that PASSED quote verification, with the refs needed to find it in `trial.json`. */
const violationQuoteSchema = z.object({
  arm: armIdSchema,
  scenarioId: z.string().min(1),
  exchange: z.number().int().min(1),
  dimension: dimensionSchema,
  quote: z.string().min(1).max(400),
  match: z.enum(["exchange", "transcript"]),
});

export const trialSummarySchema = z.object({
  version: z.literal(1),
  experiment: z.string().min(1),
  matrix: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  verdict: z.enum(["pass", "fail", "invalid_induction"]).nullable(),
  /**
   * The repo state the fixtures came from. `sha` is `"unknown"` when git could
   * not answer (and `dirty` means nothing in that case); a `dirty` tree means the
   * committed fixtures are NOT what ran.
   */
  fixtureCommit: z.object({
    sha: z.string().min(1),
    dirty: z.boolean(),
  }),
  models: z.object({
    narrator: z.string().min(1),
    narratorTemperature: z.number(),
    /** Null when the round ran `--no-judge`. Audit and preference share one model. */
    judge: z.string().min(1).nullable(),
    judgeTemperature: z.number(),
  }),
  /**
   * Digests, not contents: two rounds with the same `prompts.control` hash sent
   * the control arm the same bytes, and a changed `config` hash means the matrix,
   * models or frozen thresholds moved between rounds.
   */
  hashes: z.object({
    config: z.string().min(1),
    prompts: z.record(armIdSchema, z.string().min(1)),
  }),
  arms: z.record(armIdSchema, armSummarySchema),
  violationQuotes: z.array(violationQuoteSchema),
  spend: z.object({
    generationCalls: z.number().int().min(0),
    auditCalls: z.number().int().min(0),
    preferenceCalls: z.number().int().min(0),
    approxTokens: z.object({
      generationPrompt: z.number().int().min(0),
      generationCompletion: z.number().int().min(0),
      judgePrompt: z.number().int().min(0),
    }),
    /** OpenRouter's cumulative key usage either side of the round; null when unreadable. */
    keyUsageBefore: z.number().min(0).nullable(),
    keyUsageAfter: z.number().min(0).nullable(),
    /** The round's cost — the usage delta, or null when either end is missing. */
    usd: z.number().nullable(),
  }),
});
export type TrialSummary = z.infer<typeof trialSummarySchema>;

// ---------------------------------------------------------------------------
// Builder inputs (structural — `run.ts` passes its own records straight in)
// ---------------------------------------------------------------------------

export interface SummaryExchangeAudit {
  index: number;
  verdicts: Record<AuditDimension, DimensionVerdict>;
  violations: readonly { dimension: AuditDimension; quote: string; match: "exchange" | "transcript" }[];
  discarded: readonly { dimension: AuditDimension }[];
}

export interface SummaryArmAudit {
  degraded: boolean;
  exchanges: readonly SummaryExchangeAudit[];
}

export interface SummaryScenario {
  scenarioId: string;
  audits: Record<ArmId, SummaryArmAudit | null>;
}

export interface BuildTrialSummaryInput {
  experiment: string;
  matrix: string;
  startedAt: string;
  finishedAt: string;
  verdict: TrialSummary["verdict"];
  fixtureCommit: TrialSummary["fixtureCommit"];
  models: TrialSummary["models"];
  hashes: TrialSummary["hashes"];
  spend: TrialSummary["spend"];
  scenarios: readonly SummaryScenario[];
  /** Optional per-arm claim counts; omit until a round has an instrument for them. */
  physicalClaims?: Partial<Record<ArmId, TrialPhysicalClaims>>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function emptyCounts(): z.infer<typeof dimensionCountsSchema> {
  return { violated: 0, verifiedViolations: 0, discardedViolations: 0, clean: 0, notApplicable: 0 };
}

function round(value: number, places = 3): number {
  return Number(value.toFixed(places));
}

interface ArmTally {
  arm: z.infer<typeof armSummarySchema>;
  quotes: z.infer<typeof violationQuoteSchema>[];
}

/**
 * A degraded audit contributes NOTHING — not a zero. `run.ts` already refuses a
 * verdict when any arm degrades; counting its missing rows as clean exchanges
 * here would quietly deflate the rate in the record that outlives the run.
 */
function tallyArm(
  arm: ArmId,
  scenarios: readonly SummaryScenario[],
  claims: TrialPhysicalClaims | undefined,
): ArmTally {
  const dimensions = {} as Record<AuditDimension, z.infer<typeof dimensionCountsSchema>>;
  for (const dimension of AUDIT_DIMENSIONS) dimensions[dimension] = emptyCounts();
  const quotes: z.infer<typeof violationQuoteSchema>[] = [];
  let scenariosAudited = 0;
  let exchangesAudited = 0;
  let exchangesWithAnyViolation = 0;
  let verifiedViolations = 0;
  let discardedViolations = 0;

  for (const scenario of scenarios) {
    const audit = scenario.audits[arm];
    if (!audit || audit.degraded) continue;
    scenariosAudited += 1;
    for (const exchange of audit.exchanges) {
      exchangesAudited += 1;
      for (const dimension of AUDIT_DIMENSIONS) {
        const counts = dimensions[dimension];
        switch (exchange.verdicts[dimension]) {
          case "violated":
            counts.violated += 1;
            break;
          case "clean":
            counts.clean += 1;
            break;
          case "not_applicable":
            counts.notApplicable += 1;
            break;
        }
      }
      for (const violation of exchange.violations) {
        dimensions[violation.dimension].verifiedViolations += 1;
        verifiedViolations += 1;
        const quote = violation.quote.trim().slice(0, 400);
        // A kept violation always carries a verified quote; the guard exists so a
        // surprise empty string degrades the record by one row instead of making
        // the whole paid round's summary fail its own schema.
        if (quote.length > 0) {
          quotes.push({
            arm,
            scenarioId: scenario.scenarioId,
            exchange: exchange.index,
            dimension: violation.dimension,
            quote,
            match: violation.match,
          });
        }
      }
      for (const entry of exchange.discarded) {
        dimensions[entry.dimension].discardedViolations += 1;
        discardedViolations += 1;
      }
      if (exchange.violations.length > 0) exchangesWithAnyViolation += 1;
    }
  }

  return {
    arm: {
      scenariosAudited,
      exchangesAudited,
      exchangesWithAnyViolation,
      exchangesWithAnyViolationRate: exchangesAudited === 0 ? 0 : round(exchangesWithAnyViolation / exchangesAudited),
      verifiedViolations,
      discardedViolations,
      dimensions,
      ...(claims ? { physicalClaims: claims } : {}),
    },
    quotes,
  };
}

/**
 * Pure: everything model-derived arrives already computed by `run.ts` (audit
 * records, thresholds, token counts), so this can be exercised — and its counting
 * proved — without spending anything.
 */
export function buildTrialSummary(input: BuildTrialSummaryInput): TrialSummary {
  const cues = tallyArm("cues", input.scenarios, input.physicalClaims?.cues);
  const control = tallyArm("control", input.scenarios, input.physicalClaims?.control);
  return {
    version: 1,
    experiment: input.experiment,
    matrix: input.matrix,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    verdict: input.verdict,
    fixtureCommit: input.fixtureCommit,
    models: input.models,
    hashes: input.hashes,
    arms: { cues: cues.arm, control: control.arm },
    violationQuotes: [...cues.quotes, ...control.quotes],
    spend: input.spend,
  };
}

// ---------------------------------------------------------------------------
// Provenance helpers
// ---------------------------------------------------------------------------

/**
 * Short, stable digest over an ordered list of strings. Used for the prompt and
 * config hashes: enough to tell two rounds apart, small enough to read in a diff,
 * and it never puts the prompts themselves in a committed file.
 */
export function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update(" ");
  }
  return hash.digest("hex").slice(0, 16);
}

const execFileAsync = promisify(execFile);

/**
 * The repo state that produced the fixtures. Best-effort by design: a trial that
 * can generate 60 replies must not fail because `git` is missing, so an
 * unanswerable git returns `"unknown"` rather than throwing.
 */
export async function resolveFixtureCommit(): Promise<TrialSummary["fixtureCommit"]> {
  try {
    const head = await execFileAsync("git", ["rev-parse", "HEAD"]);
    const status = await execFileAsync("git", ["status", "--porcelain"]);
    const sha = head.stdout.trim();
    return { sha: sha.length > 0 ? sha : "unknown", dirty: status.stdout.trim().length > 0 };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}
