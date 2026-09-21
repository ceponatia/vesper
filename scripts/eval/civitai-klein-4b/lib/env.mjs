import path from "node:path";
import { fileURLToPath } from "node:url";

/** scripts/eval/civitai-klein-4b */
export const HARNESS_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.resolve(HARNESS_ROOT, "..", "..", "..");
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "eval-images", "civitai-klein-4b");
export const MANIFEST_DIR = path.join(HARNESS_ROOT, "manifests");

/**
 * The token comes from the process environment only. `scripts/web.mjs` solely
 * owns loading the repository `.env`, so this harness adds no second loader;
 * an operator who keeps the token in `.env` passes it with Node's own
 * `--env-file` flag. It is read once, handed to the client, and appears in no
 * saved file.
 */
export function civitaiToken() {
  const token = (process.env.CIVITAI_API_TOKEN ?? "").trim();
  if (token === "") {
    throw new Error(
      "CIVITAI_API_TOKEN is not set. Export it, or run the harness with Node's own env-file loader: " +
        "node --env-file=.env scripts/eval/civitai-klein-4b/run.mjs ...",
    );
  }
  return token;
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
