import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assessSdTrainingDataset,
  fingerprintSdTrainingDataset,
  listSdTrainingRecipes,
  type SdTrainingDataset,
  type SdTrainingImage,
  type SdTrainingRecipe,
  SD_TRAINING_DATASET_TARGET_MAX,
  SD_TRAINING_DATASET_TARGET_MIN,
  sdTrainingDatasetSchema,
  sdTrainingRecipeById,
  sdTrainingViews,
} from "@vesper/image-sd";
import { z } from "zod";

/**
 * Train one SDXL character LoRA from a curated identity-pack dataset (Stage 4)
 * — PAID, owner-run, not a test gate.
 *
 *   pnpm tsx scripts/train-sd-character-lora.ts \
 *     --dataset-dir ./sabrina --identity-pack-id <pack> --trigger-token sabrina \
 *     --recipe sdxl/character-lora-r8 --destination ceponatia/sabrina-sdxl-r8 \
 *     --create-destination --s3-bucket <bucket> --dry-run
 *
 * Stage 4 asks for a REPEATABLE pipeline, and repeatable is the whole design
 * constraint: two runs of this script differing only in `--recipe` must differ
 * only in LoRA rank, because that is the comparison Stage 4 exists to make (rank
 * 8 against rank 16). So every value that shapes the weights comes from the
 * package's frozen training recipe rather than from a flag, and everything the
 * run cannot control — the trainer version, the dataset, the token — is recorded
 * beside the weights instead.
 *
 * WHAT THIS SCRIPT IS NOT ALLOWED TO DECIDE. Which twelve to twenty photographs
 * belong in a character's training set is a curation judgement:
 * spread the framings, spread the lighting, spread the clothing, and above all
 * avoid teaching the model that this character IS a shirt or IS a room. A script
 * cannot see any of that. It reports what the set looks like against the curation
 * window and coverage list and then trains what it was given, loudly.
 *
 * THE FOUR PROPERTIES CARRIED OVER FROM `train-image-lora.ts`, for the same
 * reasons recorded there: the source directory is never written to, the token is
 * never printed, spending is opt-in behind `--yes` or a TTY prompt, and
 * `--dry-run` reaches the whole decision for free.
 *
 * ## Two known limits of the pinned trainer, both deliberate
 *
 * **It writes its own captions.** `stability-ai/sdxl` captions the dataset itself
 * from `caption_prefix`; it does not read caption sidecars. A caption authored in
 * `--dataset-manifest` therefore changes the dataset FINGERPRINT — which is
 * correct, it is a different curation — while changing nothing about the training
 * run. The script says so rather than letting an operator believe otherwise.
 *
 * **It trains textual-inversion embeddings, and Vesper throws them away.** The
 * trainer's pivotal-tuning pipeline learns both a LoRA and an embedding for the
 * trigger token, and ships them together in one archive. The deployed Vesper
 * renderer loads LoRA weights and nothing else — it has no embedding loader —
 * and textual inversion is a non-goal of the first training pass. So
 * only `lora.safetensors` is published. That is why `--trigger-token` should be
 * an ORDINARY WORD (a first name), not the trainer's default `TOK`: the LoRA is
 * trained on captions containing the token, and at render time the token resolves
 * through the base text encoder. A real word already means something close to
 * the right thing there; `TOK` means nothing at all.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.replicate.com/v1";
/** Only Replicate's own API host is ever handed the token. A delivery CDN is not it. */
const API_HOST = "api.replicate.com";

/** The official SDXL fine-tuner, owner and name apart because the URL needs both. */
const TRAINER_OWNER = "stability-ai";
const TRAINER_NAME = "sdxl";

/**
 * The trainer version this runbook was written against — `stability-ai/sdxl`,
 * probed live on 2026-08-23.
 *
 * PINNED rather than "latest" for the reason every model version in this
 * repository is pinned, and with more force here than usual: Stage 4 IS a
 * comparison, and a trainer that moved between the rank 8 run and the rank 16 run
 * would make the two arms differ in something nobody chose.
 * `--trainer-version` overrides it for a deliberate re-probe.
 */
const TRAINER_VERSION = "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc";

/**
 * The hardware a new destination model is created on — inert, exactly as in
 * `train-image-lora.ts`: the destination is a shelf the training pushes a version
 * onto, and Vesper never runs a prediction against it.
 */
const DESTINATION_HARDWARE = "cpu";

/** Vendor-stated A100 price and wall clock, used only for the warning below. */
const USD_PER_SECOND = 0.001400;
const MINUTES_PER_1000_STEPS = { low: 20, high: 40 };

/** The image extensions a dataset may contain, lower-cased for comparison. */
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/** How often the poller asks, and what it stops on. */
const POLL_INTERVAL_MS = 30_000;
const TERMINAL_STATUSES = ["succeeded", "failed", "canceled"];

/** The file inside the trainer's archive that Vesper publishes. */
const PUBLISHED_WEIGHTS_NAME = "lora.safetensors";

const DEFAULTS = {
  recipeId: "sdxl/character-lora-r8",
  out: "./sd-lora-training-output",
  s3Prefix: "vesper/character-loras",
  s3Region: "us-east-1",
};

/** A mistake in how the script was CALLED — printed without a stack trace. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const OPTIONS = {
  "dataset-dir": { type: "string" },
  "dataset-manifest": { type: "string" },
  "identity-pack-id": { type: "string" },
  "trigger-token": { type: "string" },
  recipe: { type: "string" },
  destination: { type: "string" },
  "create-destination": { type: "boolean" },
  "trainer-version": { type: "string" },
  "mask-target-prompts": { type: "string" },
  "use-face-detection": { type: "boolean" },
  seed: { type: "string" },
  "s3-bucket": { type: "string" },
  "s3-prefix": { type: "string" },
  "s3-region": { type: "string" },
  "public-base-url": { type: "string" },
  out: { type: "string" },
  resume: { type: "string" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  help: { type: "boolean" },
} as const;

interface S3Target {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
  /** Overrides the derived `https://<bucket>.s3.<region>.amazonaws.com` origin (a CDN, say). */
  readonly publicBaseUrl?: string;
}

interface Args {
  readonly datasetDir?: string;
  readonly datasetManifest?: string;
  readonly identityPackId?: string;
  readonly triggerToken?: string;
  readonly recipe: SdTrainingRecipe;
  readonly destination?: string;
  readonly createDestination: boolean;
  readonly trainerVersion: string;
  readonly maskTargetPrompts?: string;
  readonly useFaceDetection: boolean;
  readonly seed?: number;
  readonly s3?: S3Target;
  readonly out: string;
  readonly resume?: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly help: boolean;
}

/** Seeds are the one number allowed to be zero — it is a legal seed, not an empty value. */
function parseSeed(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--seed must be a whole number >= 0: ${raw}`);
  return parsed;
}

function readArgs(argv: readonly string[]): Args {
  let values;
  try {
    values = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)} (run with --help)`);
  }
  const text = (key: keyof typeof OPTIONS): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const flag = (key: keyof typeof OPTIONS): boolean => values[key] === true;

  const recipeId = text("recipe") ?? DEFAULTS.recipeId;
  const recipe = sdTrainingRecipeById(recipeId);
  if (!recipe) {
    throw new UsageError(
      `unknown --recipe "${recipeId}" — the package registry has: ${listSdTrainingRecipes().map((r) => r.id).join(", ")}`,
    );
  }

  const bucket = text("s3-bucket");
  const seed = text("seed");
  const datasetDir = text("dataset-dir");
  const datasetManifest = text("dataset-manifest");
  const identityPackId = text("identity-pack-id");
  const triggerToken = text("trigger-token");
  const destination = text("destination");
  const maskTargetPrompts = text("mask-target-prompts");
  const resume = text("resume");
  const publicBaseUrl = text("public-base-url");

  return {
    ...(datasetDir === undefined ? {} : { datasetDir }),
    ...(datasetManifest === undefined ? {} : { datasetManifest }),
    ...(identityPackId === undefined ? {} : { identityPackId }),
    ...(triggerToken === undefined ? {} : { triggerToken }),
    recipe,
    ...(destination === undefined ? {} : { destination }),
    createDestination: flag("create-destination"),
    trainerVersion: text("trainer-version") ?? TRAINER_VERSION,
    ...(maskTargetPrompts === undefined ? {} : { maskTargetPrompts }),
    useFaceDetection: flag("use-face-detection"),
    ...(seed === undefined ? {} : { seed: parseSeed(seed) }),
    ...(bucket === undefined
      ? {}
      : {
          s3: {
            bucket,
            prefix: (text("s3-prefix") ?? DEFAULTS.s3Prefix).replace(/^\/+|\/+$/g, ""),
            region: text("s3-region") ?? DEFAULTS.s3Region,
            ...(publicBaseUrl === undefined ? {} : { publicBaseUrl: publicBaseUrl.replace(/\/+$/, "") }),
          },
        }),
    out: text("out") ?? DEFAULTS.out,
    ...(resume === undefined ? {} : { resume }),
    dryRun: flag("dry-run"),
    yes: flag("yes"),
    help: flag("help"),
  };
}

const HELP = `
Train one SDXL character LoRA from a curated identity-pack dataset (SD plan Stage 4).

  pnpm tsx scripts/train-sd-character-lora.ts --dataset-dir <path> \\
    --identity-pack-id <id> --trigger-token <word> --recipe <id> \\
    --destination <owner/name> [--create-destination] --s3-bucket <bucket> --yes

Required (unless --resume):
  --dataset-dir <path>       Flat directory of ${IMAGE_EXTENSIONS.join("/")} images. Never written to.
  --identity-pack-id <id>    The identity pack revision this set was curated from. Recorded,
                             never read — the register step binds the LoRA to it.
  --trigger-token <word>     An ordinary in-vocabulary word (a first name works). Becomes the
                             trainer's token_string and its caption prefix, and is the word a
                             render prompt uses. Avoid the trainer's default "TOK".
  --destination <owner/n>    The Replicate model the trained version is pushed to.

Optional:
  --recipe <id>              Default ${DEFAULTS.recipeId}
                             Have: ${listSdTrainingRecipes().map((r) => `${r.id} (rank ${String(r.rank)})`).join(", ")}
  --dataset-manifest <path>  JSON: {"<file name>": {"view": "...", "caption": "...", "tags": [...]}}.
                             Views: ${sdTrainingViews.join(", ")}. Untagged images count toward no view.
  --create-destination       Create the destination model first (private, ${DESTINATION_HARDWARE}).
  --trainer-version <id>     Default ${TRAINER_VERSION}
                             (${TRAINER_OWNER}/${TRAINER_NAME}, probed 2026-08-23)
  --mask-target-prompts <t>  Passed through to the trainer's CLIPSeg cropping.
  --use-face-detection       Crop on detected faces instead of salience. Off by default: it
                             would crop the required full-body and upper-body images down
                             to faces, and the LoRA would never learn a build.
  --seed <int>               Omitted by default (the trainer picks one).
  --s3-bucket <name>         Publish the extracted ${PUBLISHED_WEIGHTS_NAME} here. Without it the run
                             stops after extraction and prints the local path.
  --s3-prefix <path>         Default ${DEFAULTS.s3Prefix}
  --s3-region <region>       Default ${DEFAULTS.s3Region}
  --public-base-url <url>    Overrides the derived https://<bucket>.s3.<region>.amazonaws.com origin.
  --out <dir>                Where the archive is downloaded and extracted. Default ${DEFAULTS.out}
  --resume <training-id>     Skip straight to polling an already-started training.
  --dry-run                  Assess the dataset, build the request, print everything. No network calls.
  --yes                      Accept the cost warning without a prompt (required when not on a TTY).
  --help                     This text.

Authentication:
  REPLICATE_API_TOKEN from the environment, or from this repository's .env. Never printed,
  and sent only to ${API_HOST}. S3 upload uses the AWS CLI and whatever credentials it
  already has; this script never reads or writes AWS configuration.

Output:
  <out>/<training-id>/ holds the archive, its contents, and training-result.json — the
  provenance the register step reads. The published weights must be anonymously
  readable, because the renderer fetches them with no credential; the run checks that
  and says so.

Cost:
  Training runs on GPU at $${String(USD_PER_SECOND)}/second; the vendor states
  ${String(MINUTES_PER_1000_STEPS.low)}-${String(MINUTES_PER_1000_STEPS.high)} minutes at 1000 steps. Nothing is uploaded until the warning is accepted.
`.trim();

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** This repository's root, derived from the script's own location rather than from cwd. */
function repoRoot(): string {
  return resolve(fileURLToPath(import.meta.url), "..", "..");
}

/**
 * The API token, from the environment or the repository's `.env` — one key read
 * by name and returned, never logged and never put into the environment.
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
// The dataset
// ---------------------------------------------------------------------------

/** Per-image curation metadata, keyed by file name. Every field optional. */
const datasetManifestSchema = z.record(
  z.string(),
  z.object({
    view: z.string().optional(),
    caption: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
);

interface StagedDataset {
  readonly dataset: SdTrainingDataset;
  readonly fingerprint: string;
  /** The directory the zip was built from — a copy; the source is untouched. */
  readonly stagedDir: string;
  readonly zipPath: string;
}

function isUsableImage(file: string): boolean {
  return IMAGE_EXTENSIONS.includes(extname(file).toLowerCase());
}

/**
 * Build the package's training manifest from a directory, and stage a flat copy
 * to zip.
 *
 * Two field choices decide what the fingerprint means, and both are load-bearing:
 *
 * - **`id` is the file name.** It is the only stable handle a hand-curated
 *   directory has, and it is what the curator sees. Renaming a file therefore
 *   re-fingerprints the set — correct, if slightly severe: a renamed file is a
 *   set somebody edited, and the fingerprint's job is to notice edits.
 * - **`uri` is the content hash**, not a path. A path would make the fingerprint
 *   depend on which machine ran the training, and a dataset re-exported into a
 *   different folder would look like a different curation. The hash makes the
 *   opposite mistake impossible too: swapping one photograph for another under
 *   the same file name changes the fingerprint, which a path could not see.
 */
function stageDataset(datasetDir: string, manifestPath: string | undefined): StagedDataset {
  const sourceDir = resolve(datasetDir);
  if (!existsSync(sourceDir)) throw new UsageError(`--dataset-dir does not exist: ${sourceDir}`);

  const metadata = readDatasetManifest(manifestPath);
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  const images: string[] = [];
  const skipped: string[] = [];
  const nested: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      nested.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isUsableImage(entry.name)) images.push(entry.name);
    else skipped.push(entry.name);
  }
  for (const file of skipped) console.log(`  skipped (not an image): ${file}`);
  for (const dir of nested) console.log(`  ignored (the trainer never descends into subdirectories): ${dir}/`);
  if (images.length === 0) {
    throw new UsageError(
      `no usable images in ${sourceDir} — the trainer reads ${IMAGE_EXTENSIONS.join(", ")} from the top level only`,
    );
  }

  // A manifest key naming a file that is not there is a refused run, not a
  // shrug: it is almost always a typo or a file the curator meant to include,
  // and training without it produces a LoRA missing the framing they thought
  // they had covered.
  const present = new Set(images);
  const orphans = Object.keys(metadata).filter((key) => !present.has(key));
  if (orphans.length > 0) {
    throw new UsageError(`--dataset-manifest names files that are not in the dataset: ${orphans.join(", ")}`);
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "vesper-sd-lora-"));
  const stagedDir = join(stagingRoot, "dataset");
  mkdirSync(stagedDir);

  const manifestImages: SdTrainingImage[] = [];
  for (const file of images) {
    const bytes = readFileSync(join(sourceDir, file));
    copyFileSync(join(sourceDir, file), join(stagedDir, file));
    const meta = metadata[file];
    manifestImages.push({
      id: file,
      uri: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      ...(meta?.view === undefined ? {} : { view: meta.view }),
      ...(meta?.caption === undefined ? {} : { caption: meta.caption }),
      ...(meta?.tags === undefined ? {} : { tags: meta.tags }),
    } as SdTrainingImage);
  }

  // Parsed rather than trusted: `view` arrives from a hand-written JSON file, and
  // a misspelled framing that silently became "no view" would report a coverage
  // gap the curator already filled.
  const parsed = sdTrainingDatasetSchema.safeParse({ images: manifestImages });
  if (!parsed.success) {
    throw new UsageError(`the dataset does not satisfy @vesper/image-sd's manifest contract: ${parsed.error.message}`);
  }

  const zipPath = join(stagingRoot, "dataset.zip");
  zipFlat(zipPath, stagedDir);
  return { dataset: parsed.data, fingerprint: fingerprintSdTrainingDataset(parsed.data), stagedDir, zipPath };
}

function readDatasetManifest(manifestPath: string | undefined): z.infer<typeof datasetManifestSchema> {
  if (manifestPath === undefined) return {};
  const path = resolve(manifestPath);
  if (!existsSync(path)) throw new UsageError(`--dataset-manifest does not exist: ${path}`);
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UsageError(`--dataset-manifest is not valid JSON: ${path}`);
  }
  const parsed = datasetManifestSchema.safeParse(payload);
  if (!parsed.success) throw new UsageError(`--dataset-manifest has the wrong shape: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * The curation report, printed rather than enforced.
 *
 * Every line here is advice a curator may knowingly ignore, which is why nothing
 * throws: the window is "approximately 12–20", and a set of eleven excellent
 * photographs trains fine. What must not happen is training a set whose shape is
 * a surprise, so the report is loud and comes before the spend prompt.
 */
function reportCuration(dataset: SdTrainingDataset): void {
  const assessment = assessSdTrainingDataset(dataset);
  console.log(`  ${String(assessment.imageCount)} image(s)`);
  if (assessment.belowTargetMin) {
    console.log(
      `  ! below the plan's curation window of ${String(SD_TRAINING_DATASET_TARGET_MIN)}-${String(SD_TRAINING_DATASET_TARGET_MAX)} images — a small set overfits toward whatever it has`,
    );
  }
  if (assessment.aboveTargetMax) {
    console.log(
      `  ! above the plan's curation window of ${String(SD_TRAINING_DATASET_TARGET_MIN)}-${String(SD_TRAINING_DATASET_TARGET_MAX)} images — curation asks for selection, not for every available image`,
    );
  }
  if (assessment.missingViews.length > 0) {
    console.log(`  ! no image is tagged with: ${assessment.missingViews.join(", ")}`);
    console.log(
      "    Untagged images count toward no view, so this may mean the manifest is thin rather than the set.",
    );
  }
  const captioned = dataset.images.filter((image) => image.caption !== undefined).length;
  if (captioned > 0) {
    console.log(
      `  note: ${String(captioned)} authored caption(s) change the dataset fingerprint but NOT this training run — ` +
        `${TRAINER_OWNER}/${TRAINER_NAME} writes its own captions from the caption prefix.`,
    );
  }
}

/** Whether a thrown error is "the binary is not installed". */
function isMissingBinary(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Zip the staged directory FLAT (`-j`): a zip carrying the staging path trains on nothing. */
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

/** Unpack the trainer's archive. `-xf` detects tar/tar.gz on its own. */
function untarInto(archivePath: string, outDir: string): void {
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", outDir], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (isMissingBinary(err)) throw new UsageError("`tar` is not installed");
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
  /** Absent while the training runs and shaped differently by every failure mode. */
  output: z.object({ weights: z.string().min(1) }).nullable().catch(null).default(null),
});
type Training = z.infer<typeof trainingSchema>;

const modelSchema = z.object({ owner: z.string().min(1), name: z.string().min(1) });

async function callReplicate<T>(
  call: { method: "GET" | "POST"; path: string; token: string; body?: unknown },
  schema: z.ZodType<T>,
): Promise<T> {
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
    throw new UsageError(`${call.method} ${call.path} -> ${String(response.status)}: ${text.slice(0, 600)}`);
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

/** Create the destination model, tolerating one that already exists (the second run must not fail). */
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
      description: "Vesper SDXL character LoRA (scripts/train-sd-character-lora.ts)",
    }),
  });
  const text = await response.text();
  if (response.status === 409 || (!response.ok && text.toLowerCase().includes("already exists"))) {
    console.log(`  destination ${destination} already exists — using it`);
    return;
  }
  if (!response.ok) throw new UsageError(`POST /models -> ${String(response.status)}: ${text.slice(0, 600)}`);
  const model = parseJson(modelSchema, text, "POST /models");
  console.log(`  created ${model.owner}/${model.name} (private, ${DESTINATION_HARDWARE})`);
}

/** Upload the dataset zip; the returned URL is what the trainer reads it from. */
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
  if (!response.ok) throw new UsageError(`POST /files -> ${String(response.status)}: ${text.slice(0, 600)}`);
  return parseJson(fileUploadSchema, text, "POST /files").urls.get;
}

/**
 * The training request — built once, so `--dry-run` prints exactly what a real
 * run sends.
 *
 * Everything that shapes the weights comes from the frozen recipe. The two
 * cropping controls are the exception, and they are flags rather than recipe
 * fields because they describe the DATASET's needs rather than Stable
 * Diffusion's: a set of head-and-shoulders portraits and a set with full-body
 * shots want different cropping, and the plan pins neither.
 */
function trainingRequest(
  destination: string,
  datasetUrl: string,
  recipe: SdTrainingRecipe,
  triggerToken: string,
  args: Args,
): Record<string, unknown> {
  return {
    destination,
    input: {
      input_images: datasetUrl,
      is_lora: true,
      lora_rank: recipe.rank,
      ...(recipe.steps === undefined ? {} : { max_train_steps: recipe.steps }),
      ...(recipe.learningRate === undefined ? {} : { lora_lr: recipe.learningRate }),
      ...(recipe.resolution === undefined ? {} : { resolution: recipe.resolution }),
      ...(recipe.batchSize === undefined ? {} : { train_batch_size: recipe.batchSize }),
      token_string: triggerToken,
      caption_prefix: `a photo of ${triggerToken}, `,
      ...(args.maskTargetPrompts === undefined ? {} : { mask_target_prompts: args.maskTargetPrompts }),
      ...(args.useFaceDetection ? { use_face_detection_instead: true } : {}),
      ...(args.seed === undefined ? {} : { seed: args.seed }),
    },
  };
}

async function startTraining(body: Record<string, unknown>, version: string, token: string): Promise<Training> {
  return await callReplicate(
    { method: "POST", path: `/models/${TRAINER_OWNER}/${TRAINER_NAME}/versions/${version}/trainings`, token, body },
    trainingSchema,
  );
}

async function getTraining(trainingId: string, token: string): Promise<Training> {
  return await callReplicate({ method: "GET", path: `/trainings/${trainingId}`, token }, trainingSchema);
}

/** Wait for one training to settle, printing elapsed time as well as status. */
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
 * Download the trained archive and unpack it.
 *
 * The Authorization header is sent ONLY to Replicate's own API host — a weights
 * URL is normally served from a delivery CDN, and handing that host a provider
 * token would give a credential to somewhere it was never meant to go.
 */
async function downloadWeights(weightsUrl: string, outDir: string, token: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const host = new URL(weightsUrl).host;
  const response = await fetch(weightsUrl, host === API_HOST ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!response.ok) throw new UsageError(`downloading the weights from ${host} -> ${String(response.status)}`);
  const archivePath = join(outDir, "trained_model.tar");
  writeFileSync(archivePath, new Uint8Array(await response.arrayBuffer()));
  untarInto(archivePath, outDir);
  return archivePath;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Copy the LoRA into the bucket and hand back the address a render will use.
 *
 * The AWS CLI rather than an SDK, deliberately: this script holds no AWS
 * credential of its own and adds no AWS dependency to the repository. Whatever
 * profile the operator's shell already uses is the profile that uploads, and a
 * missing or expired session fails as the CLI's own message rather than as a
 * stack trace from a library the repo would then have to carry.
 */
function publishToS3(weightsPath: string, key: string, target: S3Target): string {
  const destination = `s3://${target.bucket}/${key}`;
  try {
    execFileSync(
      "aws",
      ["s3", "cp", weightsPath, destination, "--region", target.region, "--content-type", "application/octet-stream"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  } catch (err) {
    if (isMissingBinary(err)) throw new UsageError("the AWS CLI is not installed — install it, or upload by hand");
    throw new UsageError(`uploading to ${destination} failed; the weights are still at ${weightsPath}`);
  }
  const base = target.publicBaseUrl ?? `https://${target.bucket}.s3.${target.region}.amazonaws.com`;
  return `${base}/${key}`;
}

/**
 * Confirm the published URL is readable WITHOUT a credential.
 *
 * This is not a nicety. The renderer fetches `lora_weights` with a plain
 * unauthenticated request from inside a Replicate container, so a private object
 * produces a LoRA that looks perfectly registered and fails every render that
 * names it — after billing the prediction. Checking here turns that into one line
 * of output at the moment the operator can still fix it.
 */
async function verifyPubliclyReadable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The errand
// ---------------------------------------------------------------------------

/** What the run is about to spend, as a band rather than a figure nobody can honour. */
function costWarning(steps: number): string {
  const scale = steps / 1000;
  const band = [MINUTES_PER_1000_STEPS.low, MINUTES_PER_1000_STEPS.high].map((minutes) =>
    (minutes * scale * 60 * USD_PER_SECOND).toFixed(2),
  );
  return (
    `This spends real money: ${TRAINER_OWNER}/${TRAINER_NAME} trains on GPU at $${String(USD_PER_SECOND)}/second, ` +
    `and the vendor states ${String(MINUTES_PER_1000_STEPS.low)}-${String(MINUTES_PER_1000_STEPS.high)} minutes at 1000 steps. ` +
    `At ${String(steps)} steps expect roughly $${String(band[0])}-$${String(band[1])}.`
  );
}

/** The spend gate: `--yes`, or a human on a terminal. */
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

/**
 * What `scripts/register-sd-character-lora.ts` reads.
 *
 * A file rather than a direct database write, because the two halves of this
 * errand have different failure modes and different privileges: training is paid,
 * slow, and runs from wherever the dataset is; registration is free, instant, and
 * needs a database URL. Splitting them means a registration that fails on a typo
 * never costs a training run, and a training run whose registration is deferred
 * loses nothing.
 */
interface TrainingResultFile {
  readonly identityPackId: string;
  readonly trainingRecipeId: string;
  readonly trainingRecipeRevision: number;
  readonly baseCheckpoint: string;
  readonly rank: number;
  readonly datasetFingerprint: string;
  readonly datasetImageCount: number;
  readonly triggerToken: string;
  readonly trainingRunRef: string;
  readonly trainerVersion: string;
  readonly weightsUrl: string | null;
  readonly weightsPath: string;
  readonly publiclyReadable: boolean;
  readonly trainerInput: Record<string, unknown>;
  readonly datasetImages: readonly SdTrainingImage[];
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.resume !== undefined) {
    const token = replicateToken();
    console.log(`Resuming training ${args.resume}`);
    await settle(await pollUntilSettled(args.resume, token), args, token, null);
    return;
  }

  const { datasetDir, identityPackId, triggerToken, destination } = args;
  if (datasetDir === undefined) throw new UsageError("--dataset-dir is required (or --resume a training id)");
  if (identityPackId === undefined) throw new UsageError("--identity-pack-id is required (or --resume a training id)");
  if (triggerToken === undefined) throw new UsageError("--trigger-token is required (or --resume a training id)");
  if (destination === undefined) throw new UsageError("--destination is required (or --resume a training id)");
  splitDestination(destination);
  if (triggerToken.trim() !== triggerToken || /\s/.test(triggerToken)) {
    throw new UsageError(`--trigger-token must be one word with no spaces: "${triggerToken}"`);
  }

  const recipe = args.recipe;
  console.log(`Recipe:  ${recipe.id} revision ${String(recipe.revision)} — rank ${String(recipe.rank)}`);
  console.log(`Base:    ${recipe.baseCheckpoint}`);
  console.log(`Token:   ${triggerToken}`);
  console.log(`Staging ${resolve(datasetDir)} …`);
  const staged = stageDataset(datasetDir, args.datasetManifest);
  reportCuration(staged.dataset);
  console.log(`  fingerprint: ${staged.fingerprint}`);
  console.log(`  staged copy: ${staged.stagedDir}`);
  console.log(`  archive:     ${staged.zipPath}`);

  const request = trainingRequest(destination, "<the uploaded dataset URL>", recipe, triggerToken, args);
  if (args.dryRun) {
    console.log("");
    console.log("--dry-run: no network calls were made. The training request would have been:");
    console.log(JSON.stringify(request, null, 2));
    console.log(`Trainer: ${TRAINER_OWNER}/${TRAINER_NAME} @ ${args.trainerVersion}`);
    if (args.s3 === undefined) {
      console.log("No --s3-bucket: a real run would stop after extraction and print the local weights path.");
    } else {
      console.log(`Publish: s3://${args.s3.bucket}/${args.s3.prefix}/${identityPackId}/…`);
    }
    return;
  }

  // Resolved BEFORE the prompt: being asked to approve a spend and only then
  // told the token is missing wastes the one decision this script asks for.
  const token = replicateToken();
  await confirmSpend(recipe.steps ?? 1000, args.yes);

  if (args.createDestination) {
    console.log(`Creating destination ${destination} …`);
    await createDestination(destination, token);
  }

  console.log("Uploading the dataset …");
  const datasetUrl = await uploadDataset(staged.zipPath, token);
  console.log("Starting the training …");
  const started = await startTraining(
    trainingRequest(destination, datasetUrl, recipe, triggerToken, args),
    args.trainerVersion,
    token,
  );
  console.log(`  training ${started.id} (${started.status})`);
  console.log(`  if this stops, resume with: pnpm tsx scripts/train-sd-character-lora.ts --resume ${started.id}`);

  // Ctrl-C from here on is a decision to stop WAITING, not to stop training.
  process.on("SIGINT", () => {
    console.log("");
    console.log(`Interrupted. The training is still running on Replicate as ${started.id}.`);
    console.log(`Resume with: pnpm tsx scripts/train-sd-character-lora.ts --resume ${started.id} --out ${args.out}`);
    process.exit(130);
  });

  await settle(await pollUntilSettled(started.id, token), args, token, staged);
}

/** The terminal half of both entry paths: extract, publish, record — or fail loudly. */
async function settle(
  training: Training,
  args: Args,
  token: string,
  staged: StagedDataset | null,
): Promise<void> {
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

  // One directory PER TRAINING so a rerun can neither overwrite an earlier run's
  // expensive artifact nor publish a stale file out of it.
  const outDir = join(resolve(args.out), training.id);
  console.log("");
  console.log("Downloading the trained archive …");
  const archivePath = await downloadWeights(weightsUrl, outDir, token);
  console.log(`  ${archivePath}`);

  const extracted = filesUnder(outDir);
  const published = extracted.find((file) => basename(file) === PUBLISHED_WEIGHTS_NAME);
  for (const file of extracted) console.log(`  ${file}`);
  if (published === undefined) {
    console.error("");
    console.error(
      `no ${PUBLISHED_WEIGHTS_NAME} in the archive — inspect it by hand; this trainer's layout has changed`,
    );
    process.exitCode = 1;
    return;
  }
  const embeddings = extracted.filter((file) => file.endsWith(".pti"));
  if (embeddings.length > 0) {
    console.log("");
    console.log(
      `Note: the archive also holds trained textual-inversion embeddings (${embeddings.map((f) => basename(f)).join(", ")}). ` +
        "Vesper does not publish or load them — textual inversion is a non-goal of the first training " +
        "pass, and the deployed renderer has no embedding loader. The trigger token resolves through the base text encoder.",
    );
  }

  // A --resume run has no staged dataset in hand: the fingerprint belongs to the
  // run that paid for the training, and inventing one here would file a
  // provenance record for a dataset this process never read.
  if (staged === null) {
    console.log("");
    console.log(`Weights extracted to ${published}.`);
    console.log(
      "This was a --resume run, so no dataset was staged and no training-result.json was written. " +
        "Publish and register from the original run's output directory, or re-run with the dataset present.",
    );
    return;
  }

  let publishedUrl: string | null = null;
  let publiclyReadable = false;
  if (args.s3 === undefined) {
    console.log("");
    console.log(`No --s3-bucket was given, so nothing was published. The file to host is:\n  ${published}`);
  } else {
    const key = `${args.s3.prefix}/${args.identityPackId ?? "unbound"}/${args.recipe.id.replace(/\//g, "-")}-${training.id}.safetensors`;
    console.log("");
    console.log(`Publishing to s3://${args.s3.bucket}/${key} …`);
    publishedUrl = publishToS3(published, key, args.s3);
    publiclyReadable = await verifyPubliclyReadable(publishedUrl);
    console.log(`  ${publishedUrl}`);
    console.log(
      publiclyReadable
        ? "  anonymous read: OK — the renderer can fetch this"
        : "  anonymous read: FAILED — the renderer fetches with no credential, so every render naming this LoRA " +
            "would fail after being billed. Make the object publicly readable before registering it.",
    );
  }

  const result: TrainingResultFile = {
    identityPackId: args.identityPackId ?? "",
    trainingRecipeId: args.recipe.id,
    trainingRecipeRevision: args.recipe.revision,
    baseCheckpoint: args.recipe.baseCheckpoint,
    rank: args.recipe.rank,
    datasetFingerprint: staged.fingerprint,
    datasetImageCount: staged.dataset.images.length,
    triggerToken: args.triggerToken ?? "",
    trainingRunRef: training.id,
    trainerVersion: args.trainerVersion,
    weightsUrl: publishedUrl,
    weightsPath: published,
    publiclyReadable,
    trainerInput: trainingRequest("<destination>", "<dataset>", args.recipe, args.triggerToken ?? "", args).input as Record<
      string,
      unknown
    >,
    datasetImages: staged.dataset.images,
  };
  const resultPath = join(outDir, "training-result.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`Provenance written to ${resultPath}.`);
  console.log("Register it with:");
  console.log(`  pnpm tsx scripts/register-sd-character-lora.ts --result ${resultPath} --label "<library label>"`);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
