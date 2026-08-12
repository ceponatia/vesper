import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

/**
 * The character-LoRA training runbook, as a script
 * (qwen-advanced-image-subsystem.plan.md §"Stage 5 — one character LoRA pilot").
 *
 *   pnpm tsx scripts/train-image-lora.ts --dataset-dir ./sabrina --name Sabrina \
 *     --destination brian/sabrina-lora --create-destination --yes
 *
 * On-demand OPERATOR TOOLING, deliberately outside the application: it is not
 * wired into CI, nothing in `src/` imports it, and it imports nothing from `src/`
 * either. That isolation is the point — training a LoRA is a paid, hour-long,
 * hand-supervised errand that happens a handful of times, and a dependency
 * between it and the app would make the app's build care about a workflow the app
 * never runs.
 *
 * What it automates is the part that is easy to get wrong by hand: staging a
 * dataset without mutating it, writing the caption sidecars the trainer expects,
 * zipping it FLAT, uploading it, starting a training against a PINNED trainer
 * version, and waiting. The parts that need a human — which images to include,
 * whether the result is any good — are left to the human.
 *
 * Three properties are load-bearing:
 *
 * 1. **The source directory is never written to.** Everything is staged into a
 *    temporary copy first. A caption generator that edited the originals would be
 *    unrepeatable the second time it ran, and a dataset is the one artifact of
 *    this errand that is expensive to reproduce.
 * 2. **The token is never printed.** It is read from the environment, or from the
 *    repository's own `.env`, and travels only in an `Authorization` header to
 *    `api.replicate.com` — so a weights URL served from a delivery host never
 *    receives it.
 * 3. **Spending is opt-in.** The cost warning is printed before anything is
 *    uploaded, and the run stops there unless `--yes` was passed or a human
 *    answers a prompt on a TTY. `--dry-run` reaches the same point and makes no
 *    network call at all, printing the exact request body it would have sent.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.replicate.com/v1";

/** The official trainer, owner and name apart because the URL needs both. */
const TRAINER_OWNER = "qwen";
const TRAINER_NAME = "qwen-image-lora-trainer";

/**
 * The trainer version this runbook was written against —
 * `qwen/qwen-image-lora-trainer`, probed live on 2026-08-11.
 *
 * PINNED rather than "latest" for the reason every image-model version in this
 * repository is pinned: a trainer that silently moved would produce weights whose
 * behaviour cannot be compared with the last set, and the whole of Stage 5 is a
 * comparison. `--trainer-version` overrides it for a deliberate re-probe.
 */
const TRAINER_VERSION = "f28eb39544f2c0dff4fbd9d50588fd75789f7ef26f6118456a96c2eedddddf90";

/**
 * The hardware a new destination model is created on. H200 is what the trainer
 * requires; a destination created on anything else is refused at training time,
 * which is a confusing place to learn it.
 */
const DESTINATION_HARDWARE = "gpu-h200";

/** Vendor-stated H200 price, used only for the warning below. */
const H200_USD_PER_SECOND = 0.001525;
/** Vendor-stated wall clock at 1000 steps, scaled by the requested step count. */
const MINUTES_PER_1000_STEPS = { low: 10, high: 30 };

/** The image extensions a dataset may contain, lower-cased for comparison. */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/** How often the poller asks, and what it stops on. */
const POLL_INTERVAL_MS = 30_000;
const TERMINAL_STATUSES = ["succeeded", "failed", "canceled"];

const DEFAULTS = {
  captionTemplate: "A photo of a woman named {name}",
  steps: 1500,
  loraRank: 32,
  learningRate: 0.0002,
  batchSize: 1,
  optimizer: "adamw",
  out: "./lora-training-output",
};

/** A mistake in how the script was CALLED — printed without a stack trace. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const OPTIONS = {
  "dataset-dir": { type: "string" },
  name: { type: "string" },
  "caption-template": { type: "string" },
  destination: { type: "string" },
  "create-destination": { type: "boolean" },
  steps: { type: "string" },
  "lora-rank": { type: "string" },
  "learning-rate": { type: "string" },
  "batch-size": { type: "string" },
  optimizer: { type: "string" },
  seed: { type: "string" },
  "trainer-version": { type: "string" },
  out: { type: "string" },
  resume: { type: "string" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean" },
} as const;

interface TrainingHyperparameters {
  readonly steps: number;
  readonly loraRank: number;
  readonly learningRate: number;
  readonly batchSize: number;
  readonly optimizer: string;
  readonly seed?: number;
}

interface Args {
  readonly datasetDir?: string;
  readonly name?: string;
  readonly captionTemplate: string;
  readonly destination?: string;
  readonly createDestination: boolean;
  readonly hyperparameters: TrainingHyperparameters;
  readonly trainerVersion: string;
  readonly out: string;
  readonly resume?: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly help: boolean;
}

function parsePositiveInteger(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive whole number: ${raw}`);
  return parsed;
}

function parsePositiveNumber(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive number: ${raw}`);
  return parsed;
}

/** Seeds are the one number allowed to be zero — it is a legal seed, not an empty value. */
function parseSeed(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--seed must be a whole number ≥ 0: ${raw}`);
  return parsed;
}

/**
 * Everything `parseArgs` understood, with its own inferred shape kept (each
 * option's type comes from {@link OPTIONS}, so an unknown flag is a thrown usage
 * error rather than a silently ignored one).
 */
function rawArgs(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)} (run with --help)`);
  }
}

function readArgs(argv: readonly string[]): Args {
  const values = rawArgs(argv);
  const text = (key: keyof typeof OPTIONS): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const flag = (key: keyof typeof OPTIONS): boolean => values[key] === true;

  const datasetDir = text("dataset-dir");
  const name = text("name");
  const destination = text("destination");
  const seed = text("seed");
  const resume = text("resume");
  return {
    ...(datasetDir === undefined ? {} : { datasetDir }),
    ...(name === undefined ? {} : { name }),
    captionTemplate: text("caption-template") ?? DEFAULTS.captionTemplate,
    ...(destination === undefined ? {} : { destination }),
    createDestination: flag("create-destination"),
    hyperparameters: {
      steps: parsePositiveInteger(text("steps"), "--steps", DEFAULTS.steps),
      loraRank: parsePositiveInteger(text("lora-rank"), "--lora-rank", DEFAULTS.loraRank),
      learningRate: parsePositiveNumber(text("learning-rate"), "--learning-rate", DEFAULTS.learningRate),
      batchSize: parsePositiveInteger(text("batch-size"), "--batch-size", DEFAULTS.batchSize),
      optimizer: text("optimizer") ?? DEFAULTS.optimizer,
      ...(seed === undefined ? {} : { seed: parseSeed(seed) }),
    },
    trainerVersion: text("trainer-version") ?? TRAINER_VERSION,
    out: text("out") ?? DEFAULTS.out,
    ...(resume === undefined ? {} : { resume }),
    dryRun: flag("dry-run"),
    yes: flag("yes"),
    help: flag("help"),
  };
}

const HELP = `
Train one character LoRA on Replicate, from a flat directory of images.

  pnpm tsx scripts/train-image-lora.ts --dataset-dir <path> --name <first-name> \\
    --destination <owner/name> [--create-destination] --yes

Required (unless --resume):
  --dataset-dir <path>     Flat directory of .jpg/.jpeg/.png/.webp images. Never written to.
  --name <first-name>      Substituted into the caption template's {name}.
  --destination <owner/n>  The Replicate model the weights are pushed to.

Optional:
  --create-destination     Create the destination model first (private, ${DESTINATION_HARDWARE}).
  --caption-template <t>   Default: "${DEFAULTS.captionTemplate}"
                           Written as <image>.txt for every image that has no caption yet.
  --steps <int>            Default ${String(DEFAULTS.steps)}
  --lora-rank <int>        Default ${String(DEFAULTS.loraRank)}
  --learning-rate <num>    Default ${String(DEFAULTS.learningRate)}
  --batch-size <int>       Default ${String(DEFAULTS.batchSize)}
  --optimizer <name>       Default ${DEFAULTS.optimizer}
  --seed <int>             Omitted by default (the trainer picks one).
  --trainer-version <id>   Default ${TRAINER_VERSION}
                           (${TRAINER_OWNER}/${TRAINER_NAME}, probed 2026-08-11)
  --out <dir>              Where the weights zip is downloaded and extracted. Default ${DEFAULTS.out}
  --resume <training-id>   Skip straight to polling an already-started training.
  --dry-run                Validate, stage, zip, print the exact training request. No network calls.
  --yes                    Accept the cost warning without a prompt (required when not on a TTY).
  --help                   This text.

Authentication:
  REPLICATE_API_TOKEN from the environment. If it is unset, the REPLICATE_API_TOKEN
  line of this repository's .env is read instead. The token is never printed.

Cost:
  Training runs on ${DESTINATION_HARDWARE} at $${String(H200_USD_PER_SECOND)}/second — the vendor states
  ${String(MINUTES_PER_1000_STEPS.low)}-${String(MINUTES_PER_1000_STEPS.high)} minutes at 1000 steps. Nothing is uploaded until the warning is accepted.
`.trim();

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** This repository's root, derived from the script's own location rather than
 * from `process.cwd()` — the errand is run from wherever the dataset is. */
function repoRoot(): string {
  return resolve(fileURLToPath(import.meta.url), "..", "..");
}

/**
 * The API token, from the environment or the repository's `.env`.
 *
 * The `.env` fallback is deliberate and narrow: it reads ONE key by name, out of
 * the file this repository already keeps its provider credentials in, and it
 * returns the value rather than populating the environment. Nothing here logs it.
 */
function replicateToken(): string {
  const fromEnv = process.env.REPLICATE_API_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();

  const envPath = join(repoRoot(), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?REPLICATE_API_TOKEN\s*=\s*(.*)$/.exec(line);
      const raw = match?.[1]?.trim();
      if (raw === undefined || raw === "") continue;
      const unquoted = /^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw;
      if (unquoted !== "") return unquoted;
    }
  }
  throw new UsageError(
    `no REPLICATE_API_TOKEN in the environment or in ${envPath}. Export it for this shell, or add the line to .env.`,
  );
}

// ---------------------------------------------------------------------------
// Dataset validation and staging
// ---------------------------------------------------------------------------

interface StagedDataset {
  /** The directory the zip was built from — a copy; the source is untouched. */
  readonly stagedDir: string;
  readonly zipPath: string;
  readonly imageCount: number;
  readonly captionsWritten: number;
  readonly captionsKept: number;
}

/** The caption sidecar's name for one image: the stem, plus `.txt`. */
function captionFileName(imageFile: string): string {
  return `${basename(imageFile, extname(imageFile))}.txt`;
}

function isUsableImage(file: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(file).toLowerCase());
}

/**
 * Copy the usable images (and any captions already beside them) into a fresh
 * staging directory, writing a generated caption for every image that lacks one.
 *
 * Everything the trainer will not read is reported OUT LOUD rather than silently
 * dropped: an unusable file, a nested directory (the trainer ignores those
 * without saying so, which is exactly how half a dataset goes missing), and a
 * caption that was kept rather than generated. A dataset whose contents are a
 * surprise is a training run whose result cannot be explained.
 */
function stageDataset(datasetDir: string, caption: string): StagedDataset {
  const sourceDir = resolve(datasetDir);
  if (!existsSync(sourceDir)) throw new UsageError(`--dataset-dir does not exist: ${sourceDir}`);

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  const images: string[] = [];
  const skipped: string[] = [];
  const nested: string[] = [];
  const captions = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) {
      nested.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isUsableImage(entry.name)) images.push(entry.name);
    else if (extname(entry.name).toLowerCase() === ".txt") captions.add(entry.name);
    else skipped.push(entry.name);
  }

  for (const file of skipped) console.log(`  skipped (not an image): ${file}`);
  for (const dir of nested) console.log(`  ignored (the trainer never descends into subdirectories): ${dir}/`);
  if (images.length === 0) {
    throw new UsageError(
      `no usable images in ${sourceDir} — the trainer reads ${IMAGE_EXTENSIONS.join(", ")} from the top level only`,
    );
  }

  // Two images sharing a stem would share one caption file, so one of the two
  // captions would silently win. Refused rather than resolved: which of them the
  // operator meant is not a question this script can answer.
  const claimedCaptions = new Map<string, string>();
  for (const file of images) {
    const captionFile = captionFileName(file);
    const previous = claimedCaptions.get(captionFile);
    if (previous !== undefined) {
      throw new UsageError(`${previous} and ${file} would share one caption file (${captionFile}); rename one of them`);
    }
    claimedCaptions.set(captionFile, file);
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "vesper-lora-"));
  const stagedDir = join(stagingRoot, "dataset");
  mkdirSync(stagedDir);

  let captionsWritten = 0;
  let captionsKept = 0;
  for (const file of images) {
    copyFileSync(join(sourceDir, file), join(stagedDir, file));
    const captionFile = captionFileName(file);
    if (captions.has(captionFile)) {
      copyFileSync(join(sourceDir, captionFile), join(stagedDir, captionFile));
      captionsKept += 1;
    } else {
      writeFileSync(join(stagedDir, captionFile), `${caption}\n`, "utf8");
      captionsWritten += 1;
    }
  }

  const zipPath = join(stagingRoot, "dataset.zip");
  zipFlat(zipPath, stagedDir);
  return { stagedDir, zipPath, imageCount: images.length, captionsWritten, captionsKept };
}

/** Whether a thrown error is "the binary is not installed". */
function isMissingBinary(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Zip the staged directory FLAT (`-j`): the trainer expects images at the archive
 * root, and a zip that carries the staging path would deliver a dataset one
 * directory deep, which trains on nothing.
 */
function zipFlat(zipPath: string, stagedDir: string): void {
  const files = readdirSync(stagedDir).map((file) => join(stagedDir, file));
  try {
    execFileSync("zip", ["-j", "-q", zipPath, ...files], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (isMissingBinary(err)) {
      throw new UsageError("`zip` is not installed — install it (Debian/Ubuntu: sudo apt install zip unzip)");
    }
    throw err;
  }
}

function unzipInto(zipPath: string, outDir: string): void {
  try {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", outDir], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (isMissingBinary(err)) {
      throw new UsageError("`unzip` is not installed — install it (Debian/Ubuntu: sudo apt install zip unzip)");
    }
    throw err;
  }
}

/** Every file under a directory, recursively — the extracted archive is small. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Replicate
// ---------------------------------------------------------------------------

const fileUploadSchema = z.object({ urls: z.object({ get: z.string().min(1) }) });

const trainingSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  error: z.unknown().optional(),
  /**
   * Absent while the training runs and shaped differently by every failure mode,
   * so it degrades to null rather than failing the poll — the STATUS is what the
   * loop decides on, and a malformed output on a `failed` training is expected.
   */
  output: z.object({ weights: z.string().min(1) }).nullable().catch(null).default(null),
});
type Training = z.infer<typeof trainingSchema>;

const modelSchema = z.object({ owner: z.string().min(1), name: z.string().min(1) });

interface ApiCall {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly token: string;
  readonly body?: unknown;
}

/**
 * One API call, parsed into the shape the caller declared.
 *
 * A non-2xx answer is a thrown `UsageError` carrying the status and the body:
 * every failure here is something the operator has to read and act on (a bad
 * token, a destination that is not theirs, a version that no longer exists), and
 * a stack trace over it would bury the one sentence that matters.
 */
async function callReplicate<T>(call: ApiCall, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${API_BASE}${call.path}`, {
    method: call.method,
    headers: {
      Authorization: `Bearer ${call.token}`,
      ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new UsageError(`${call.method} ${call.path} → ${String(response.status)}: ${text.slice(0, 600)}`);
  }
  return parseJson(schema, text, `${call.method} ${call.path}`);
}

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new UsageError(`${what} did not answer with JSON: ${text.slice(0, 300)}`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new UsageError(`${what} answered a shape this script does not understand: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** `owner/name`, split and checked — the destination is half of every API path below. */
function splitDestination(destination: string): { owner: string; name: string } {
  const parts = destination.split("/");
  const owner = parts[0];
  const name = parts[1];
  if (parts.length !== 2 || owner === undefined || owner === "" || name === undefined || name === "") {
    throw new UsageError(`--destination must be owner/name: ${destination}`);
  }
  return { owner, name };
}

/**
 * Create the destination model, tolerating one that already exists.
 *
 * "Already there" is a success, not a conflict: `--create-destination` is how a
 * first run bootstraps, and the second run of the same command must not fail on
 * the strength of the first one having worked.
 */
async function createDestination(destination: string, token: string): Promise<void> {
  const { owner, name } = splitDestination(destination);
  const response = await fetch(`${API_BASE}/models`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      owner,
      name,
      visibility: "private",
      hardware: DESTINATION_HARDWARE,
      description: "Character LoRA trained by scripts/train-image-lora.ts",
    }),
  });
  const text = await response.text();
  // 409 is the documented conflict; the "already exists" body is checked too
  // because the endpoint has answered 400 and 422 for the same condition.
  if (response.status === 409 || (!response.ok && text.toLowerCase().includes("already exists"))) {
    console.log(`  destination ${destination} already exists — using it`);
    return;
  }
  if (!response.ok) {
    throw new UsageError(`POST /models → ${String(response.status)}: ${text.slice(0, 600)}`);
  }
  const model = parseJson(modelSchema, text, "POST /models");
  console.log(`  created ${model.owner}/${model.name} (private, ${DESTINATION_HARDWARE})`);
}

/**
 * Upload the dataset zip and return the URL the trainer reads it from.
 *
 * `content` is the field name the files endpoint expects; anything else is
 * accepted as a 4xx that says very little. The returned `urls.get` is what rides
 * into the training request as `input.dataset`.
 */
async function uploadDataset(zipPath: string, token: string): Promise<string> {
  const bytes = readFileSync(zipPath);
  const form = new FormData();
  form.append("content", new Blob([new Uint8Array(bytes)], { type: "application/zip" }), "dataset.zip");
  const response = await fetch(`${API_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new UsageError(`POST /files → ${String(response.status)}: ${text.slice(0, 600)}`);
  return parseJson(fileUploadSchema, text, "POST /files").urls.get;
}

/** The training request body — built once, so `--dry-run` prints exactly what a real run sends. */
function trainingRequest(
  destination: string,
  datasetUrl: string,
  caption: string,
  hyperparameters: TrainingHyperparameters,
): Record<string, unknown> {
  return {
    destination,
    input: {
      dataset: datasetUrl,
      steps: hyperparameters.steps,
      lora_rank: hyperparameters.loraRank,
      learning_rate: hyperparameters.learningRate,
      batch_size: hyperparameters.batchSize,
      optimizer: hyperparameters.optimizer,
      ...(hyperparameters.seed === undefined ? {} : { seed: hyperparameters.seed }),
      default_caption: caption,
    },
  };
}

async function startTraining(body: Record<string, unknown>, version: string, token: string): Promise<Training> {
  return await callReplicate(
    {
      method: "POST",
      path: `/models/${TRAINER_OWNER}/${TRAINER_NAME}/versions/${version}/trainings`,
      token,
      body,
    },
    trainingSchema,
  );
}

async function getTraining(trainingId: string, token: string): Promise<Training> {
  return await callReplicate({ method: "GET", path: `/trainings/${trainingId}`, token }, trainingSchema);
}

/**
 * Wait for one training to reach a terminal status, printing each poll.
 *
 * Every line carries the elapsed time as well as the status, because "processing"
 * printed twelve times says nothing about whether anything is happening. Ctrl-C
 * is handled where the loop is started (see `main`): the training keeps running
 * on Replicate, so interrupting the poller costs nothing but the wait.
 */
async function pollUntilSettled(trainingId: string, token: string): Promise<Training> {
  const startedAt = Date.now();
  for (;;) {
    const training = await getTraining(trainingId, token);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  [${String(elapsed).padStart(5)}s] ${training.status}`);
    if (TERMINAL_STATUSES.includes(training.status)) return training;
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Download the weights archive and unpack it.
 *
 * The Authorization header is sent ONLY to Replicate's own API host. A weights
 * URL is normally served from a delivery CDN, and handing that host a provider
 * token would be giving a credential to somewhere it was never meant to go.
 */
async function downloadWeights(weightsUrl: string, outDir: string, token: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const host = new URL(weightsUrl).host;
  const sameHost = host === "api.replicate.com";
  const response = await fetch(weightsUrl, sameHost ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!response.ok) {
    throw new UsageError(`downloading the weights from ${host} → ${String(response.status)}`);
  }
  const zipPath = join(outDir, "weights.zip");
  writeFileSync(zipPath, new Uint8Array(await response.arrayBuffer()));
  unzipInto(zipPath, outDir);
  return zipPath;
}

// ---------------------------------------------------------------------------
// The errand
// ---------------------------------------------------------------------------

/** What the run is about to spend, as a band rather than a figure nobody can honour. */
function costWarning(steps: number): string {
  const scale = steps / 1000;
  const band = [MINUTES_PER_1000_STEPS.low, MINUTES_PER_1000_STEPS.high].map((minutes) =>
    (minutes * scale * 60 * H200_USD_PER_SECOND).toFixed(2),
  );
  return (
    `This spends real money: ${DESTINATION_HARDWARE} at $${String(H200_USD_PER_SECOND)}/second, ` +
    `and the vendor states ${String(MINUTES_PER_1000_STEPS.low)}-${String(MINUTES_PER_1000_STEPS.high)} minutes at 1000 steps. ` +
    `At ${String(steps)} steps expect roughly $${String(band[0])}-$${String(band[1])}.`
  );
}

/**
 * The spend gate: `--yes`, or a human on a terminal. A non-interactive run with
 * no `--yes` stops rather than assuming consent it cannot ask for.
 */
async function confirmSpend(steps: number, yes: boolean): Promise<void> {
  console.log("");
  console.log(costWarning(steps));
  if (yes) {
    console.log("  --yes was passed; continuing.");
    return;
  }
  if (process.stdin.isTTY !== true) {
    throw new UsageError("this run is not interactive — pass --yes to accept the cost above");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("  Continue? [y/N] ");
    if (answer.trim().toLowerCase() !== "y") throw new UsageError("cancelled at the cost prompt; nothing was uploaded");
  } finally {
    rl.close();
  }
}

/** The failure's own words, whatever shape the API gave them. */
function describeError(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  if (error === undefined || error === null) return "no reason was given";
  return JSON.stringify(error).slice(0, 600);
}

/** What the operator does with the result — printed on every successful run. */
function reportWeights(training: Training, outDir: string, zipPath: string): void {
  const weightsUrl = training.output?.weights ?? "";
  console.log("");
  console.log("Weights URL (durable — this is the address to keep, not the prediction page):");
  console.log(`  ${weightsUrl}`);
  console.log(`Downloaded to ${zipPath} and extracted into ${outDir}:`);

  const extracted = filesUnder(outDir).filter((file) => file.endsWith(".safetensors"));
  const primary = extracted.find((file) => basename(file) === "lora.safetensors") ?? extracted[0];
  for (const file of extracted) console.log(`  ${file}`);
  if (primary === undefined) {
    console.log("  no .safetensors was found in the archive — inspect it by hand before registering anything");
    return;
  }
  console.log("");
  console.log("The file to re-host and register in the LoRA library is:");
  console.log(`  ${primary}`);
  console.log(
    "The plus-lora endpoint most likely refuses a zip URL, so upload that .safetensors somewhere public " +
      "(or push it to a Hugging Face repo) and curate THAT address — a library row pointing at the zip is a row " +
      "every render will refuse.",
  );
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  // Polling an already-started training needs nothing but the id: the dataset was
  // uploaded and the money committed by the run that started it.
  if (args.resume !== undefined) {
    const token = replicateToken();
    console.log(`Resuming training ${args.resume}`);
    await settle(await pollUntilSettled(args.resume, token), args, token);
    return;
  }

  const datasetDir = args.datasetDir;
  const name = args.name;
  const destination = args.destination;
  if (datasetDir === undefined) throw new UsageError("--dataset-dir is required (or --resume a training id)");
  if (name === undefined) throw new UsageError("--name is required (or --resume a training id)");
  if (destination === undefined) throw new UsageError("--destination is required (or --resume a training id)");
  // Checked here, where the result is not needed, so a malformed destination is
  // refused before anything is staged rather than after the cost prompt.
  splitDestination(destination);

  const caption = args.captionTemplate.split("{name}").join(name);
  console.log(`Caption: ${caption}`);
  console.log(`Staging ${resolve(datasetDir)} …`);
  const staged = stageDataset(datasetDir, caption);
  console.log(
    `  ${String(staged.imageCount)} image(s); ${String(staged.captionsWritten)} caption(s) written, ` +
      `${String(staged.captionsKept)} kept as they were`,
  );
  console.log(`  staged copy: ${staged.stagedDir}`);
  console.log(`  archive:     ${staged.zipPath}`);

  if (args.dryRun) {
    console.log("");
    console.log("--dry-run: no network calls were made. The training request would have been:");
    console.log(
      JSON.stringify(
        trainingRequest(destination, "<the uploaded dataset URL>", caption, args.hyperparameters),
        null,
        2,
      ),
    );
    console.log(`Trainer: ${TRAINER_OWNER}/${TRAINER_NAME} @ ${args.trainerVersion}`);
    return;
  }

  // Resolved BEFORE the prompt: being asked to approve a spend and only then
  // told the token is missing wastes the one decision this script asks for.
  const token = replicateToken();
  await confirmSpend(args.hyperparameters.steps, args.yes);

  if (args.createDestination) {
    console.log(`Creating destination ${destination} …`);
    await createDestination(destination, token);
  }

  console.log("Uploading the dataset …");
  const datasetUrl = await uploadDataset(staged.zipPath, token);
  console.log("Starting the training …");
  const started = await startTraining(
    trainingRequest(destination, datasetUrl, caption, args.hyperparameters),
    args.trainerVersion,
    token,
  );
  console.log(`  training ${started.id} (${started.status})`);
  console.log(`  if this stops, resume with: pnpm tsx scripts/train-image-lora.ts --resume ${started.id}`);

  // Ctrl-C from here on is a decision to stop WAITING, not to stop training —
  // the run is Replicate's now, and it is already paid for.
  process.on("SIGINT", () => {
    console.log("");
    console.log(`Interrupted. The training is still running on Replicate as ${started.id}.`);
    console.log(`Resume with: pnpm tsx scripts/train-image-lora.ts --resume ${started.id} --out ${args.out}`);
    process.exit(130);
  });

  await settle(await pollUntilSettled(started.id, token), args, token);
}

/** The terminal half of both entry paths: report, download, or fail loudly. */
async function settle(training: Training, args: Args, token: string): Promise<void> {
  if (training.status !== "succeeded") {
    console.error("");
    console.error(`Training ${training.id} ${training.status}: ${describeError(training.error)}`);
    process.exitCode = 1;
    return;
  }
  const weightsUrl = training.output?.weights;
  if (weightsUrl === undefined || weightsUrl === null) {
    console.error("");
    console.error(`Training ${training.id} succeeded but reported no output weights — inspect it on Replicate.`);
    process.exitCode = 1;
    return;
  }
  // One directory PER TRAINING, keyed by the training id, so a rerun with the
  // default --out can neither overwrite an earlier run's expensive artifact nor
  // pick a stale .safetensors out of it when reporting which file to re-host.
  const outDir = join(resolve(args.out), training.id);
  console.log("");
  console.log("Downloading the weights …");
  const zipPath = await downloadWeights(weightsUrl, outDir, token);
  reportWeights(training, outDir, zipPath);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
