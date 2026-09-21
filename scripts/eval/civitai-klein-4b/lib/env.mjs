import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** scripts/eval/civitai-klein-4b */
export const HARNESS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.resolve(HARNESS_ROOT, "..", "..", "..");
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "eval-images", "civitai-klein-4b");
export const MANIFEST_DIR = path.join(HARNESS_ROOT, "manifests");

/**
 * Minimal `.env` reader. The harness deliberately does not import the
 * application's env loader (`scripts/web.mjs`) so that it stays a
 * dependency-free evaluation script that touches no application code.
 */
export function loadDotenv(file = path.join(REPO_ROOT, ".env")) {
  const out = {};
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The token is read once and handed to the client; nothing else ever sees it. */
export function civitaiToken() {
  const fromProcess = process.env.CIVITAI_API_TOKEN;
  const token = (fromProcess && fromProcess.trim() !== "" ? fromProcess : loadDotenv().CIVITAI_API_TOKEN) ?? "";
  if (token.trim() === "") {
    throw new Error("CIVITAI_API_TOKEN is not set in the repository .env (or the environment)");
  }
  return token.trim();
}

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Spend gates. Every default is zero-spend:
 *
 * - `CIVITAI_EVAL_DRY_RUN` defaults to `true`; only the literal `false` opens it.
 * - `CIVITAI_EVAL_MAX_PAID_RUNS` and `CIVITAI_EVAL_MAX_YELLOW_BUZZ` default to 0.
 * - The `--paid` flag must ALSO be present on the command line.
 *
 * A paid submit happens only when all four agree. The caps are compared
 * against the cumulative ledger in the output directory, not against the
 * current invocation alone, so they bound the whole suite's spend.
 */
export function resolveSpendGates(flags) {
  const env = process.env;
  const dryRunEnv = env.CIVITAI_EVAL_DRY_RUN;
  const envAllowsPaid = dryRunEnv !== undefined && dryRunEnv.trim().toLowerCase() === "false";
  const maxPaidRuns = numberOr(flags["max-paid-runs"], numberOr(env.CIVITAI_EVAL_MAX_PAID_RUNS, 0));
  const maxYellowBuzz = numberOr(flags["max-yellow-buzz"], numberOr(env.CIVITAI_EVAL_MAX_YELLOW_BUZZ, 0));
  const paidFlag = flags.paid === true;
  const paidAllowed = paidFlag && envAllowsPaid && maxPaidRuns > 0 && maxYellowBuzz > 0;
  const reasons = [];
  if (!paidFlag) reasons.push("--paid flag absent");
  if (!envAllowsPaid) reasons.push("CIVITAI_EVAL_DRY_RUN is not the literal false");
  if (!(maxPaidRuns > 0)) reasons.push("CIVITAI_EVAL_MAX_PAID_RUNS / --max-paid-runs is 0");
  if (!(maxYellowBuzz > 0)) reasons.push("CIVITAI_EVAL_MAX_YELLOW_BUZZ / --max-yellow-buzz is 0");
  return { paidAllowed, maxPaidRuns, maxYellowBuzz, reasons };
}
