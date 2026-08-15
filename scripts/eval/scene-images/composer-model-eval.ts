import "dotenv/config";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { SCENE_COMPOSER_MODELS } from "@/lib/composer-models";
import { composerFallbackModelId } from "@/server/ai";
import { effectiveLadderCostPerThousand, fallbackInvocationRate } from "./composer-model-economics";

/**
 * One-command owner entrypoint for composer-model evaluation.
 *
 * The existing A/B remains the validated grading instrument. This wrapper runs it
 * unchanged, then derives the production ladder economics from its recorded rows:
 * actual degrade/fallback rate plus effective primary+fallback cost.
 */

const OUT = process.env.EVAL_OUT ?? "data/eval/composer-model-ab";
const FALLBACK_REVIEW_THRESHOLD = 0.1;

const ARM_MODELS: Readonly<Record<string, string>> = {
  aion3: "aion-labs/aion-3.0",
  aion3mini: "aion-labs/aion-3.0-mini",
  aion2: "aion-labs/aion-2.0",
  "dsflash-off": "~deepseek/deepseek-v4-flash-latest",
  "dsflash-low": "~deepseek/deepseek-v4-flash-latest",
  qwen37flash: "qwen/qwen3.7-flash",
  glm47flash: "z-ai/glm-4.7-flash",
  ling3flash: "inclusionai/ling-3.0-flash",
};

interface ResultRow {
  arm: string;
  answered: boolean;
  costUsd: number | null;
  diagnosticCodes: string[];
}

interface ArmEconomics {
  arm: string;
  modelId: string;
  runs: number;
  answeredRate: number;
  fallbackRate: number | null;
  primaryCostPerThousand: number | null;
  fallbackModelId: string;
  effectiveCostPerThousand: number | null;
}

function modelIdForArm(arm: string): string {
  const modelId = ARM_MODELS[arm];
  if (!modelId) {
    throw new Error(`unknown composer A/B arm "${arm}" — update ARM_MODELS before interpreting this run`);
  }
  return modelId;
}

function summarizeRows(rows: readonly ResultRow[]): ArmEconomics[] {
  const arms = [...new Set(rows.map((row) => row.arm))];
  const base = arms.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    const costs = armRows.map((row) => row.costUsd).filter((cost): cost is number => cost !== null);
    const degraded = armRows.filter((row) => row.diagnosticCodes.includes("images.scene_composer.degraded")).length;
    return {
      arm,
      modelId: modelIdForArm(arm),
      runs: armRows.length,
      answeredRate: armRows.length === 0 ? 0 : armRows.filter((row) => row.answered).length / armRows.length,
      fallbackRate: fallbackInvocationRate(degraded, armRows.length),
      primaryCostPerThousand:
        costs.length === 0 ? null : (costs.reduce((sum, cost) => sum + cost, 0) / costs.length) * 1000,
    };
  });

  return base.map((summary) => {
    const fallbackModelId = composerFallbackModelId(summary.modelId);
    const fallback = base.find((candidate) => candidate.modelId === fallbackModelId);
    return {
      ...summary,
      fallbackModelId,
      effectiveCostPerThousand: effectiveLadderCostPerThousand(
        summary.primaryCostPerThousand,
        summary.fallbackRate,
        fallback?.primaryCostPerThousand ?? null,
      ),
    };
  });
}

const pct = (value: number | null): string => (value === null ? "—" : `${Math.round(value * 100)}%`);
const money = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(3)}`);

function printEconomics(summaries: readonly ArmEconomics[]): void {
  console.log(`\n${"=".repeat(103)}`);
  console.log("PRODUCTION LADDER ECONOMICS — fallback uses the exact generateChecked degrade signal");
  console.log("=".repeat(103));
  console.log(
    [
      "arm".padEnd(16),
      "answered".padStart(9),
      "fallback".padStart(9),
      "primary $/1k".padStart(13),
      "effective $/1k".padStart(15),
      "fallback model",
    ].join(" "),
  );

  for (const summary of summaries) {
    console.log(
      [
        summary.arm.padEnd(16),
        pct(summary.answeredRate).padStart(9),
        pct(summary.fallbackRate).padStart(9),
        money(summary.primaryCostPerThousand).padStart(13),
        money(summary.effectiveCostPerThousand).padStart(15),
        summary.fallbackModelId,
      ].join(" "),
    );
  }

  console.log(
    "\n`answered` is a quality measure. `fallback` counts only rows where production would actually retry; a valid all-defaulted answer can fail `answered` without invoking the fallback.",
  );
  console.log("Effective $/1k = primary $/1k + fallback rate × measured fallback-model $/1k.");

  const review = summaries.filter(
    (summary) => summary.fallbackRate !== null && summary.fallbackRate >= FALLBACK_REVIEW_THRESHOLD,
  );
  if (review.length > 0) {
    console.log(
      `Fallback review threshold (${pct(FALLBACK_REVIEW_THRESHOLD)}) reached: ${review
        .map((summary) => `${summary.arm}=${pct(summary.fallbackRate)}`)
        .join(", ")}.`,
    );
  }
}

function assertArmMapIsCurated(): void {
  const curated = new Set(SCENE_COMPOSER_MODELS.map((option) => option.id));
  for (const modelId of new Set(Object.values(ARM_MODELS))) {
    if (!curated.has(modelId)) {
      console.warn(`note: ${modelId} is in the A/B arm map but not the admin candidate shortlist`);
    }
  }
}

async function main(): Promise<void> {
  assertArmMapIsCurated();

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const run = spawnSync(command, ["tsx", "scripts/eval/scene-images/composer-model-ab.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
    return;
  }

  const resultsPath = path.join(OUT, "results.json");
  let rows: ResultRow[];
  try {
    rows = JSON.parse(await fs.readFile(resultsPath, "utf8")) as ResultRow[];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.log("\nNo results.json was written (expected in demo/no-provider mode); ladder economics skipped.");
      return;
    }
    throw error;
  }

  const summaries = summarizeRows(rows);
  printEconomics(summaries);
  await fs.writeFile(path.join(OUT, "ladder-summary.json"), JSON.stringify(summaries, null, 2));
  console.log(`Wrote ladder economics → ${path.join(OUT, "ladder-summary.json")}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
