import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CHARACTER_CHAT_MODEL_ID } from "@/lib/narrative-models";
import {
  deterministicArmOrder,
  normalizedQuoteAppears,
  runNarratorArm,
  type NarratorArmRun,
} from "../narrator-comparison/harness";
import { extractionAccuracy, runGarmentExtractionFixture } from "./extraction";
import { PLAYER_NAME } from "./fixtures";
import {
  extractionFixtures,
  garmentHarnessChecks,
  planGarmentCorpus,
  type GarmentArm,
  type PlannedGarmentScenario,
} from "./harness";
import {
  auditGarmentArm,
  type GarmentArmAudit,
  type GarmentExchangeAudit,
} from "./judge";

/**
 * Clothing-state graph slice-6 tuning runner.
 *
 * Treatment = the production authoritative wardrobe digest plus the bounded,
 * repeat-gated garment cue block. Control = the same legacy outfit/premise/scene
 * prompt with both graph blocks absent. The production narrator generates both
 * arms with independent histories. Each arm is audited alone for contradictions,
 * repetition, concrete detail and prose naturalness; the production continuity
 * extractor is measured against a separate fixed handle-based corpus.
 *
 * No flag is changed and no result is promoted automatically. This creates the
 * evidence the plan previously asked an owner to "run" without providing an
 * instrument capable of producing it.
 */

const DEFAULT_JUDGE_MODEL = "google/gemini-3.5-flash";
const DEFAULT_OUT = process.env.EVAL_OUT || "data/eval/garment-cues";

interface Args {
  dryRun: boolean;
  skipExtraction: boolean;
  scenario?: string;
  chatModel: string;
  judgeModel: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  const scenario = values.get("scenario");
  return {
    dryRun: flags.has("dry-run"),
    skipExtraction: flags.has("skip-extraction"),
    ...(scenario ? { scenario } : {}),
    chatModel: values.get("chat-model") ?? DEFAULT_CHARACTER_CHAT_MODEL_ID,
    judgeModel: values.get("judge-model") ?? DEFAULT_JUDGE_MODEL,
    out: values.get("out") ?? DEFAULT_OUT,
  };
}

interface VerifiedAudit {
  contradictoryExchanges: number;
  contradictionFindings: number;
  repetitions: number;
  staticRestatements: number;
  discardedQuotes: number;
  concreteDetail: number;
  naturalness: number;
}

function verifiedExchangeViolation(
  audit: GarmentExchangeAudit,
  reply: string,
  dimension: "stateConsistency" | "visibilityAndCoverage" | "adoptedFalsePremise",
): { counted: boolean; discarded: boolean } {
  if (audit[dimension] !== "violated") return { counted: false, discarded: false };
  const quote =
    dimension === "stateConsistency"
      ? audit.quoteStateConsistency
      : dimension === "visibilityAndCoverage"
        ? audit.quoteVisibilityAndCoverage
        : audit.quoteAdoptedFalsePremise;
  const counted = normalizedQuoteAppears(quote, reply);
  return { counted, discarded: !counted };
}

function verifyAudit(audit: GarmentArmAudit, replies: readonly string[]): VerifiedAudit {
  let contradictoryExchanges = 0;
  let contradictionFindings = 0;
  let discardedQuotes = 0;
  for (const exchange of audit.exchanges) {
    const reply = replies[exchange.exchange - 1] ?? "";
    const results = ([
      "stateConsistency",
      "visibilityAndCoverage",
      "adoptedFalsePremise",
    ] as const).map((dimension) => verifiedExchangeViolation(exchange, reply, dimension));
    const findings = results.filter((result) => result.counted).length;
    if (findings > 0) contradictoryExchanges += 1;
    contradictionFindings += findings;
    discardedQuotes += results.filter((result) => result.discarded).length;
  }
  const validQuotedFindings = (items: readonly { exchange: number; quote: string }[]) =>
    items.filter((item) => normalizedQuoteAppears(item.quote, replies[item.exchange - 1] ?? "")).length;
  const repetitions = validQuotedFindings(audit.repetitions);
  const staticRestatements = validQuotedFindings(audit.staticRestatements);
  discardedQuotes += audit.repetitions.length - repetitions;
  discardedQuotes += audit.staticRestatements.length - staticRestatements;
  return {
    contradictoryExchanges,
    contradictionFindings,
    repetitions,
    staticRestatements,
    discardedQuotes,
    concreteDetail: audit.concreteDetail,
    naturalness: audit.naturalness,
  };
}

interface ScenarioArmResult {
  generation: NarratorArmRun;
  audit: GarmentArmAudit;
  verified: VerifiedAudit;
}

interface ScenarioResult {
  scenarioId: string;
  title: string;
  arms: Record<GarmentArm, ScenarioArmResult>;
}

async function runScenario(
  plan: PlannedGarmentScenario,
  chatModel: string,
  judgeModel: string,
): Promise<ScenarioResult> {
  const generations = {} as Record<GarmentArm, NarratorArmRun>;
  for (const arm of deterministicArmOrder(plan.fixture.id, ["garment", "control"] as const)) {
    generations[arm] = await runNarratorArm({
      turns: plan.turns,
      arm,
      characterName: plan.characterName,
      playerName: PLAYER_NAME,
      model: chatModel,
    });
  }

  const arms = {} as Record<GarmentArm, ScenarioArmResult>;
  for (const arm of ["garment", "control"] as const) {
    const generation = generations[arm];
    const auditResult = await auditGarmentArm({
      scenarioTitle: plan.fixture.title,
      premise: plan.fixture.premise,
      characterName: plan.characterName,
      playerName: PLAYER_NAME,
      exchanges: plan.turns.map((turn, index) => ({
        index: index + 1,
        player: turn.player,
        groundTruth: turn.groundTruth,
        reply: generation.replies[index] ?? "",
      })),
      modelId: judgeModel,
    });
    if (auditResult.degraded || auditResult.audit === null) {
      throw new Error(`${plan.fixture.id}/${arm}: ${auditResult.failure ?? "judge degraded"}`);
    }
    arms[arm] = {
      generation,
      audit: auditResult.audit,
      verified: verifyAudit(auditResult.audit, generation.replies),
    };
  }
  return { scenarioId: plan.fixture.id, title: plan.fixture.title, arms };
}

function armSummary(results: readonly ScenarioResult[], arm: GarmentArm) {
  const exchanges = results.reduce((sum, result) => sum + result.arms[arm].generation.replies.length, 0);
  const totals = results.reduce(
    (acc, result) => {
      const value = result.arms[arm].verified;
      acc.contradictoryExchanges += value.contradictoryExchanges;
      acc.contradictionFindings += value.contradictionFindings;
      acc.repetitions += value.repetitions;
      acc.staticRestatements += value.staticRestatements;
      acc.discardedQuotes += value.discardedQuotes;
      acc.concreteDetail += value.concreteDetail;
      acc.naturalness += value.naturalness;
      return acc;
    },
    {
      contradictoryExchanges: 0,
      contradictionFindings: 0,
      repetitions: 0,
      staticRestatements: 0,
      discardedQuotes: 0,
      concreteDetail: 0,
      naturalness: 0,
    },
  );
  const scenarios = Math.max(1, results.length);
  return {
    exchanges,
    contradictionRate: exchanges === 0 ? 0 : totals.contradictoryExchanges / exchanges,
    repetitionRate: exchanges === 0 ? 0 : totals.repetitions / exchanges,
    staticRestatementRate: exchanges === 0 ? 0 : totals.staticRestatements / exchanges,
    contradictionFindings: totals.contradictionFindings,
    discardedQuotes: totals.discardedQuotes,
    concreteDetail: totals.concreteDetail / scenarios,
    naturalness: totals.naturalness / scenarios,
  };
}

function printChecks(checks: readonly { id: string; ok: boolean; detail: string }[]): void {
  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.id} — ${check.detail}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let plans = planGarmentCorpus();
  if (args.scenario) plans = plans.filter((plan) => plan.fixture.id === args.scenario);
  if (plans.length === 0) throw new Error(`no garment scenario matched ${args.scenario ?? "the corpus"}`);

  const checks = garmentHarnessChecks(plans);
  printChecks(checks);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) throw new Error(`${failed.length} model-free garment harness check(s) failed`);

  for (const plan of plans) {
    console.log(`\n${plan.fixture.id}: ${plan.fixture.title}`);
    for (const [index, turn] of plan.turns.entries()) {
      console.log(`  ${index + 1}. cues=[${turn.cues.join(" | ")}] digest=${turn.digest.replace(/\n/gu, " / ")}`);
    }
  }
  if (args.dryRun) {
    console.log("\nDry run complete; no narrator, judge or extractor calls were made.");
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for the live comparison");

  const scenarioResults: ScenarioResult[] = [];
  for (const plan of plans) {
    console.log(`\nRunning narrator arms and audits: ${plan.fixture.id}`);
    scenarioResults.push(await runScenario(plan, args.chatModel, args.judgeModel));
  }

  const extractionResults = args.skipExtraction
    ? []
    : await Promise.all(extractionFixtures().map((fixture) => runGarmentExtractionFixture(fixture)));
  if (extractionResults.some((result) => result.degraded)) {
    throw new Error("one or more garment extraction calls degraded; refusing to publish a partial accuracy number");
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    chatModel: args.chatModel,
    judgeModel: args.judgeModel,
    scenarioCount: scenarioResults.length,
    arms: {
      garment: armSummary(scenarioResults, "garment"),
      control: armSummary(scenarioResults, "control"),
    },
    extraction: args.skipExtraction
      ? { skipped: true }
      : {
          skipped: false,
          accuracy: extractionAccuracy(extractionResults),
          matched: extractionResults.reduce((sum, result) => sum + result.matchedCount, 0),
          expected: extractionResults.reduce((sum, result) => sum + result.expectedCount, 0),
        },
  };

  await fs.mkdir(args.out, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(args.out, "trial.json"), JSON.stringify({ summary, scenarios: scenarioResults, extractionResults }, null, 2)),
    fs.writeFile(path.join(args.out, "summary.json"), JSON.stringify(summary, null, 2)),
  ]);

  console.log("\nSummary");
  console.table(summary.arms);
  console.log("Extraction", summary.extraction);
  console.log(`Wrote ${path.join(args.out, "trial.json")} and summary.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
