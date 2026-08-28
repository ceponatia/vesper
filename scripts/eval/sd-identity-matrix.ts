import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type SdEvaluationFixture,
  type SdRecipe,
  type SdxlCharacterRenderInput,
  sdEvaluationDimensions,
  sdEvaluationFixtures,
  sdRecipeById,
  sdxlCharacterRenderInputSchema,
} from "@vesper/image-sd";
import { z } from "zod";

/**
 * The Stage 3 identity matrix — PAID, owner-run, and not a test gate.
 *
 * Stage 3 asks one question before any ControlNet is allowed near the renderer:
 * how hard should identity conditioning be pushed? The recipe registry names
 * three PuLID test points — 0.65 / 0.80 / 0.95 — and neither identity layer should
 * automatically run at maximum strength, because the layers fail in opposite
 * directions: pushing identity up improves `face` while destroying
 * `clothing_flexibility` and `pose_flexibility`. So the run renders every
 * fixture at every strength plus a no-identity control, and a human grades the
 * seven dimensions afterwards.
 *
 *   pnpm tsx scripts/eval/sd-identity-matrix.ts \
 *     --version <replicate-version-id> --reference ./anchor.png --dry-run
 *
 * FOUR ARMS, and the control is the one with a rule attached. `sdxl/base-portrait`
 * carries no identity weight, and the renderer REFUSES a reference image sent to
 * a recipe that has none (packages/image-sd/deployment/README.md). That refusal
 * is deliberate — a control arm that silently conditioned at some default
 * strength would be a fourth identity cell, and the comparison would measure
 * nothing — so this script sends the base arm no reference at all and checks
 * that it did not before spending anything.
 *
 * THE LoRA ARMS ARRIVE WITH THEIR WEIGHTS. Stage 3's matrix also has LoRA-only
 * and LoRA+PuLID arms, and neither exists until somebody hands this script a
 * trained character LoRA — so they are built from `--lora <id>=<url>` rather than
 * being listed in {@link BASE_ARMS}. Each supplied LoRA adds two arms: the
 * LoRA alone (`sdxl/lora-portrait`, no runtime conditioning) and the LoRA
 * together with PuLID at the recipe's own weight (`sdxl/identity-portrait`).
 * Passing the rank 8 and rank 16 weights from Stage 4 therefore runs both halves
 * of the remaining Stage 3 matrix AND the rank comparison Stage 4 asks for, in
 * one graded run against the same fixtures and seeds.
 *
 * `sdxl/lora-portrait` is a recipe the DEPLOYED build must already carry. It was
 * added to the registry with Stage 4, and the predictor refuses a recipe id that
 * is not baked into its image, so the deployment has to have been pushed since
 * then before a `lora-*` arm can run.
 *
 * The version id is an ARGUMENT, never a constant. `ceponatia/sdxl-character-render`
 * is private and non-official, so it runs only through `POST /v1/predictions`
 * with an explicit `version`, and that hash is whatever the owner's last
 * `cog push` printed. A default here would go stale silently and grade an old
 * build.
 *
 * WHAT IT WRITES, into `--out` (default `eval-images/sd-identity-matrix-r1`):
 *
 * - `<arm>/<fixture>.png` — one image per cell. Gitignored: the owner ruling of
 *   2026-08-28 is that all evaluation output, graded or not, lives in the
 *   untracked root `eval-images/` and never enters git history. A cell whose
 *   bytes are not one of the covered formats is REFUSED rather than written.
 * - `manifest.csv` — one row per cell, appended as the run goes, so an
 *   interrupted run still records what it paid for.
 * - `scores.csv` — the grading sheet, header only. Columns come from
 *   `sdEvaluationDimensions`, so they cannot drift from what the package says is
 *   graded.
 * - `README.md` — the run notes skeleton. Two lines in it are the owner's to
 *   fill: where the reference came from, and the verdict.
 *
 * Everything free happens before anything paid: `--dry-run` builds every request,
 * runs every check and prints the whole matrix without one network call.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.replicate.com/v1";
/** Only Replicate's own API host is ever handed the token. A delivery CDN is not it. */
const API_HOST = "api.replicate.com";

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_STATUSES = ["succeeded", "failed", "canceled"];
const DEFAULT_TIMEOUT_SECONDS = 900;

const DEFAULT_OUT = "eval-images/sd-identity-matrix-r1";

/**
 * The image extensions `.gitignore` already keeps out of git repo-wide.
 *
 * Copied from the rules themselves rather than assumed: the owner ruling of
 * 2026-08-21 is that generated imagery must never enter git history, and this
 * script's whole output is generated imagery. A renderer that one day returned
 * something outside this list would otherwise leave tracked images sitting in a
 * folder whose README promises there are none.
 */
const GITIGNORED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff"];

/** A mistake in how the script was CALLED — printed without a stack trace. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Arm {
  readonly id: string;
  /** The frozen recipe this arm runs. Must resolve in the package registry. */
  readonly recipeId: string;
  /** The question this arm answers — printed above the matrix at run time. */
  readonly question: string;
  /**
   * Stage 4's slot. A LoRA arm sends `lora_weights` (and optionally overrides
   * the recipe's scale); every arm below leaves it undefined, because no SDXL
   * character LoRA exists yet and an arm that named one would be a lie in the
   * manifest.
   */
  readonly lora?: { readonly weights: string; readonly scale?: number };
}

/**
 * The control plus the three PuLID test points.
 *
 * The identity arms differ from each other in `identityWeight` and in nothing
 * else — the recipe registry copies every other value verbatim between them, per
 * the rule that only one variable should move at a time. Whether that is still true is
 * checked below rather than trusted.
 */
const BASE_ARMS: readonly Arm[] = [
  {
    id: "base",
    recipeId: "sdxl/base-portrait",
    question: "vanilla SDXL, no identity conditioning — what these prompts produce with no reference at all",
  },
  { id: "w065", recipeId: "sdxl/identity-portrait-w065", question: "PuLID at 0.65 — the weak arm" },
  { id: "w080", recipeId: "sdxl/identity-portrait", question: "PuLID at 0.80 — the recipe's current middle value" },
  { id: "w095", recipeId: "sdxl/identity-portrait-w095", question: "PuLID at 0.95 — the strong arm" },
];

/**
 * The two arms one trained character LoRA adds.
 *
 * Two rather than one because the identity architecture is two LAYERS with
 * different jobs — the LoRA teaches the model the person, the adapter anchors an
 * individual render to a reference — and Stage 3 grades them separately for
 * exactly that reason. Running only the combined arm would leave "is the LoRA
 * doing anything?" unanswerable.
 *
 * The scale is left to the recipe. Both recipes already carry the mid-band 0.8,
 * and an override here would make two LoRAs comparable only if the operator
 * remembered to pass the same number twice.
 */
function armsForLora(id: string, weights: string): Arm[] {
  return [
    {
      id: `lora-${id}`,
      recipeId: "sdxl/lora-portrait",
      question: `character LoRA "${id}" alone, no runtime identity conditioning`,
      lora: { weights },
    },
    {
      id: `identity-lora-${id}`,
      recipeId: "sdxl/identity-portrait",
      question: `character LoRA "${id}" plus PuLID at 0.80 — both identity layers`,
      lora: { weights },
    },
  ];
}

/** Every arm this run may select from: the fixed four, plus two per supplied LoRA. */
function allArms(loras: readonly LoraArgument[]): Arm[] {
  return [...BASE_ARMS, ...loras.flatMap((lora) => armsForLora(lora.id, lora.weights))];
}

/** An arm sends the identity reference when its recipe declares an identity weight. */
function sendsReference(recipe: SdRecipe): boolean {
  return recipe.identityWeight !== undefined;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const OPTIONS = {
  version: { type: "string" },
  reference: { type: "string" },
  out: { type: "string" },
  lora: { type: "string", multiple: true },
  arm: { type: "string", multiple: true },
  fixture: { type: "string", multiple: true },
  timeout: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean" },
} as const;

/** One `--lora <id>=<url>` pair: the label its arms are named after, and the weights. */
interface LoraArgument {
  readonly id: string;
  readonly weights: string;
}

interface Args {
  readonly version?: string;
  readonly reference?: string;
  readonly out: string;
  readonly loras: readonly LoraArgument[];
  readonly arms: readonly string[];
  readonly fixtures: readonly string[];
  readonly timeoutSeconds: number;
  readonly dryRun: boolean;
  readonly help: boolean;
}

/** `--arm base --arm w095` and `--arm base,w095` both work; neither is worth arguing about. */
function idList(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

/**
 * `--lora r8=https://…/r8.safetensors`, parsed into the id its arms are named
 * after and the URL they send.
 *
 * The id is required and is not derived from the URL, because it lands in arm
 * names, in image paths and in every manifest row — "r8" and "r16" are what a
 * grader reads, and a hash out of an S3 key is not. Repeats are refused for the
 * reason {@link assertNoRepeats} gives about arms: two arms with one name would
 * pay twice and overwrite one file.
 */
function readLoras(values: readonly string[] | undefined): LoraArgument[] {
  const loras = (values ?? []).map((value) => {
    const separator = value.indexOf("=");
    const id = separator < 0 ? "" : value.slice(0, separator).trim();
    const weights = separator < 0 ? "" : value.slice(separator + 1).trim();
    if (id === "" || weights === "") throw new UsageError(`--lora must be <id>=<url>: ${value}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new UsageError(`--lora id "${id}" must be lowercase letters, digits and hyphens — it names files and arms`);
    }
    // Checked here rather than by the renderer, which would refuse it after the
    // prediction was created and billed.
    if (!/^https?:\/\//.test(weights) || !weights.toLowerCase().endsWith(".safetensors")) {
      throw new UsageError(`--lora ${id} must point at an http(s) .safetensors URL: ${weights}`);
    }
    return { id, weights };
  });
  assertNoRepeats("lora", loras.map((lora) => lora.id));
  return loras;
}

function readArgs(argv: readonly string[]): Args {
  let values;
  try {
    values = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)} (run with --help)`);
  }

  const timeoutRaw = values.timeout;
  const timeoutSeconds = timeoutRaw === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new UsageError(`--timeout must be a positive whole number of seconds: ${String(timeoutRaw)}`);
  }

  return {
    ...(values.version === undefined ? {} : { version: values.version }),
    ...(values.reference === undefined ? {} : { reference: values.reference }),
    out: values.out ?? DEFAULT_OUT,
    loras: readLoras(values.lora),
    arms: idList(values.arm),
    fixtures: idList(values.fixture),
    timeoutSeconds,
    dryRun: values["dry-run"] === true,
    help: values.help === true,
  };
}

const HELP = `
Run the Stage 3 identity matrix against the Vesper SDXL renderer.

  pnpm tsx scripts/eval/sd-identity-matrix.ts --version <id> --reference <path|url> [--out <dir>]

Required:
  --version <id>       The Replicate VERSION id of ceponatia/sdxl-character-render.
                       The model is private and non-official, so predictions name the
                       version explicitly. Use the hash the last \`cog push\` printed.
  --reference <p|url>  The identity anchor. A local file is uploaded once and reused for
                       every cell, then deleted afterwards; an http(s) URL is used as it
                       stands. Required unless the run is the base arm alone — that arm
                       must not receive a reference and the renderer refuses one.

Optional:
  --out <dir>          Default ${DEFAULT_OUT}
  --lora <id>=<url>    A trained character LoRA. Repeatable. Each one adds two arms:
                       lora-<id> (the LoRA alone) and identity-lora-<id> (LoRA + PuLID).
                       Pass Stage 4's rank 8 and rank 16 weights to run the remaining
                       Stage 3 arms and the rank comparison in one graded matrix.
  --arm <id>           Restrict the arms. Repeatable, or comma-separated.
                       Always have: ${BASE_ARMS.map((arm) => arm.id).join(", ")}
                       Plus lora-<id> and identity-lora-<id> for every --lora.
  --fixture <id>       Restrict the fixtures. Repeatable, or comma-separated.
  --timeout <seconds>  Per-cell wait before the prediction is cancelled. Default ${String(DEFAULT_TIMEOUT_SECONDS)}.
  --dry-run            Build and check every request, print the whole matrix, spend nothing.
  --help               This text.

Authentication:
  REPLICATE_API_TOKEN, from the environment or the repository .env. Never printed, and
  sent only to ${API_HOST}.

Cost:
  One GPU prediction per cell (arms x fixtures). The count is printed before the first
  send; --dry-run reaches the same point for free.
`.trim();

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** One arm with its recipe already resolved, so nothing downstream re-looks-up or casts. */
interface ResolvedArm {
  readonly arm: Arm;
  readonly recipe: SdRecipe;
}

interface Cell {
  readonly arm: Arm;
  readonly recipe: SdRecipe;
  readonly fixture: SdEvaluationFixture;
  /** Exactly what will be POSTed as `input`, parsed through the package's own contract. */
  readonly input: SdxlCharacterRenderInput;
}

/** The sentinel a dry run prints where the uploaded reference URL would go. */
const REFERENCE_PLACEHOLDER = "<the uploaded reference URL>";

/**
 * One cell's request, built through `sdxlCharacterRenderInputSchema`.
 *
 * The schema is the renderer's published input contract, so a cell that could
 * not have been accepted — a recipe id nothing registers, a seed below zero, a
 * height that is not a multiple of 8 — fails here, for free, instead of as a
 * billed prediction that errors on the GPU. Width and height come from the
 * resolved recipe rather than from a constant, so the request cannot disagree
 * with the recipe it names.
 */
function buildCell(arm: Arm, recipe: SdRecipe, fixture: SdEvaluationFixture, referenceUrl: string | undefined): Cell {
  const lora = arm.lora;
  const input = sdxlCharacterRenderInputSchema.parse({
    prompt: fixture.prompt,
    ...(fixture.negativePrompt === undefined ? {} : { negative_prompt: fixture.negativePrompt }),
    ...(sendsReference(recipe) && referenceUrl !== undefined ? { reference_image: referenceUrl } : {}),
    ...(lora === undefined
      ? {}
      : { lora_weights: lora.weights, ...(lora.scale === undefined ? {} : { lora_scale: lora.scale }) }),
    seed: fixture.seed,
    width: recipe.width,
    height: recipe.height,
    recipe: arm.recipeId,
  });
  return { arm, recipe, fixture, input };
}

/**
 * A selector naming the same id twice is refused, not quietly collapsed.
 *
 * `--arm w080 --arm w080` would build the cell twice, and every consequence of
 * that is silent: the same prediction is created and paid for twice, the second
 * image overwrites the first at a path keyed by arm and fixture, and the
 * manifest ends up with two rows pointing at one file. Deduplicating would fix
 * the spend but not the ambiguity — a repeated id usually means the operator
 * meant a DIFFERENT one, and this is cheap enough to say out loud.
 */
function assertNoRepeats(flag: string, wanted: readonly string[]): void {
  const repeated = [...new Set(wanted.filter((id, index) => wanted.indexOf(id) !== index))];
  if (repeated.length > 0) {
    throw new UsageError(
      `--${flag} names ${repeated.map((id) => `"${id}"`).join(", ")} more than once — that would pay for the same prediction twice, ` +
        `overwrite the first image at the same path, and leave two manifest rows for one file`,
    );
  }
}

function selectArms(available: readonly Arm[], wanted: readonly string[]): Arm[] {
  if (wanted.length === 0) return [...available];
  assertNoRepeats("arm", wanted);
  return wanted.map((id) => {
    const arm = available.find((candidate) => candidate.id === id);
    if (!arm) throw new UsageError(`unknown --arm "${id}" — have: ${available.map((a) => a.id).join(", ")}`);
    return arm;
  });
}

function selectFixtures(wanted: readonly string[]): SdEvaluationFixture[] {
  if (wanted.length === 0) return [...sdEvaluationFixtures];
  assertNoRepeats("fixture", wanted);
  return wanted.map((id) => {
    const fixture = sdEvaluationFixtures.find((candidate) => candidate.id === id);
    if (!fixture) {
      throw new UsageError(`unknown --fixture "${id}" — have: ${sdEvaluationFixtures.map((f) => f.id).join(", ")}`);
    }
    return fixture;
  });
}

/** Every arm's recipe, resolved once — an unresolvable id is a refused run, not a failed cell. */
function resolveArms(arms: readonly Arm[]): ResolvedArm[] {
  return arms.map((arm) => {
    const recipe = sdRecipeById(arm.recipeId);
    if (!recipe) {
      throw new UsageError(
        `arm "${arm.id}" names recipe "${arm.recipeId}", which the package registry does not resolve — the renderer would refuse every one of its predictions after billing them`,
      );
    }
    return { arm, recipe };
  });
}

/**
 * Five ways this run would cost money and answer nothing.
 *
 * 1. **An arm with no identity weight sent a reference.** The renderer refuses it
 *    outright — and if it ever stopped refusing, the control (or the LoRA-only
 *    arm) would become another identity cell and the comparison would be
 *    measuring one thing against itself.
 * 2. **An identity arm sent no reference.** It would degrade cleanly to the base
 *    recipe and render a stranger at a weight that never applied.
 * 3. **An arm named after a LoRA sent no LoRA.** Same failure in the other layer:
 *    a `lora-*` cell with no weights renders the plain base recipe under a name
 *    that claims a character LoRA was applied.
 * 4. **Two arms in the same identity CONFIGURATION.** A configuration is the
 *    (identity weight, LoRA) pair, not the weight alone — `w080` and
 *    `identity-lora-r8` share a weight and are a real comparison, while two arms
 *    agreeing on both are a duplicated cell.
 * 5. **The identity arms differ in something besides weight and LoRA.** Only
 *    one variable may move; a recipe edit that also changed steps or CFG would
 *    make every difference in the grading unattributable.
 */
function assertMatrixIsHonest(cells: readonly Cell[]): void {
  const identityArms = new Map<string, { recipe: SdRecipe; weight: number }>();
  const configurations = new Map<string, string>();

  for (const cell of cells) {
    const hasReference = "reference_image" in cell.input;
    if (!sendsReference(cell.recipe) && hasReference) {
      throw new Error(
        `${cell.arm.id}/${cell.fixture.id}: recipe "${cell.recipe.id}" carries no identity weight, so the renderer REFUSES a reference image — this cell would fail on the GPU`,
      );
    }
    if (sendsReference(cell.recipe) && !hasReference) {
      throw new Error(
        `${cell.arm.id}/${cell.fixture.id}: an identity arm with no reference image degrades to the base recipe and renders a stranger — pass --reference`,
      );
    }
    if (cell.arm.lora !== undefined && !("lora_weights" in cell.input)) {
      throw new Error(
        `${cell.arm.id}/${cell.fixture.id}: the arm names a character LoRA but its request carries no lora_weights — the cell would render the base recipe under a LoRA arm's name`,
      );
    }
    const weight = cell.recipe.identityWeight;
    if (weight !== undefined) identityArms.set(cell.arm.id, { recipe: cell.recipe, weight });
    // The LoRA is identified by its WEIGHTS URL rather than by the arm id: two
    // arms given the same file under two names would be one configuration
    // rendered twice, which is exactly what this check exists to catch.
    const configuration = `${weight === undefined ? "none" : String(weight)}|${cell.arm.lora?.weights ?? "none"}`;
    const claimedBy = configurations.get(configuration);
    if (claimedBy !== undefined && claimedBy !== cell.arm.id) {
      throw new Error(
        `arms "${claimedBy}" and "${cell.arm.id}" run the same identity configuration (${configuration}) — that is a duplicated cell, not a comparison point`,
      );
    }
    configurations.set(configuration, cell.arm.id);
  }

  const recipes = [...identityArms.values()].map((entry) => entry.recipe);
  const first = recipes[0];
  if (first !== undefined) {
    for (const recipe of recipes.slice(1)) {
      const drifted = (
        [
          ["checkpoint", first.checkpoint, recipe.checkpoint],
          ["sampler", first.sampler, recipe.sampler],
          ["scheduler", first.scheduler, recipe.scheduler],
          ["steps", first.steps, recipe.steps],
          ["cfg", first.cfg, recipe.cfg],
          ["width", first.width, recipe.width],
          ["height", first.height, recipe.height],
          ["loraScale", first.loraScale, recipe.loraScale],
        ] as const
      ).filter(([, a, b]) => a !== b);
      if (drifted.length > 0) {
        throw new Error(
          `identity arms "${first.id}" and "${recipe.id}" differ in more than identity weight and LoRA (${drifted
            .map(([field]) => field)
            .join(", ")}) — only one variable may move at a time, so this run's differences would be unattributable`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Replicate
// ---------------------------------------------------------------------------

const fileSchema = z.object({ id: z.string().min(1), urls: z.object({ get: z.string().min(1) }) });

const predictionSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  error: z.unknown().optional(),
  /**
   * A Cog predictor returning one `Path` publishes a bare URL; the same
   * predictor returning a list publishes an array. Both are accepted, and
   * anything else degrades to null rather than failing the poll — the STATUS is
   * what the loop decides on, and a malformed output on a failed prediction is
   * expected.
   */
  output: z.union([z.string(), z.array(z.string())]).nullable().catch(null).default(null),
});
type Prediction = z.infer<typeof predictionSchema>;

function replicateToken(): string {
  const token = process.env.REPLICATE_API_TOKEN?.trim();
  if (token === undefined || token === "") {
    throw new UsageError("REPLICATE_API_TOKEN is not set (environment or the repository .env). It is never printed.");
  }
  return token;
}

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new UsageError(`${what} did not answer with JSON: ${text.slice(0, 300)}`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new UsageError(`${what} answered a shape this script does not understand: ${parsed.error.message}`);
  return parsed.data;
}

async function callReplicate<T>(
  method: "GET" | "POST",
  routePath: string,
  token: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE}${routePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new UsageError(`${method} ${routePath} → ${String(response.status)}: ${text.slice(0, 600)}`);
  return parseJson(schema, text, `${method} ${routePath}`);
}

const UPLOAD_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** The identity anchor, resolved to a URL the renderer can fetch — uploaded once, reused by every cell. */
interface Reference {
  readonly url: string;
  /** Set when this script uploaded the file, so it can delete it afterwards. */
  readonly fileId?: string;
  /** What the operator passed, for the run notes. */
  readonly provenance: string;
}

async function resolveReference(source: string, token: string): Promise<Reference> {
  if (/^https?:\/\//i.test(source)) return { url: source, provenance: source };

  const absolute = path.resolve(source);
  const bytes = await fs.readFile(absolute);
  const extension = path.extname(absolute).toLowerCase();
  const form = new FormData();
  form.append(
    "content",
    new Blob([new Uint8Array(bytes)], { type: UPLOAD_MEDIA_TYPES[extension] ?? "application/octet-stream" }),
    path.basename(absolute),
  );
  const response = await fetch(`${API_BASE}/files`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const text = await response.text();
  if (!response.ok) throw new UsageError(`POST /files → ${String(response.status)}: ${text.slice(0, 600)}`);
  const file = parseJson(fileSchema, text, "POST /files");
  return { url: file.urls.get, fileId: file.id, provenance: absolute };
}

/**
 * Best-effort cleanup of the uploaded anchor.
 *
 * Best-effort because the images are already downloaded by the time this runs:
 * a failed delete leaves one file on Replicate, which is worth a printed line
 * and not worth failing a completed run over.
 */
async function deleteUploadedReference(reference: Reference, token: string): Promise<void> {
  const fileId = reference.fileId;
  if (fileId === undefined) return;
  try {
    const response = await fetch(`${API_BASE}/files/${fileId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    console.log(response.ok ? `  uploaded reference deleted (${fileId})` : `  uploaded reference NOT deleted (${String(response.status)}) — remove ${fileId} by hand`);
  } catch (err) {
    console.log(`  uploaded reference NOT deleted (${err instanceof Error ? err.message : String(err)}) — remove ${fileId} by hand`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Stop a prediction that outran the per-cell timeout, so it is not billed for a wait nobody is doing. */
async function cancelPrediction(id: string, token: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/predictions/${id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch {
    // A cancel that could not be sent changes nothing about the recorded cell.
  }
}

async function pollUntilSettled(id: string, token: string, timeoutSeconds: number): Promise<Prediction> {
  const startedAt = Date.now();
  for (;;) {
    const prediction = await callReplicate("GET", `/predictions/${id}`, token, predictionSchema);
    if (TERMINAL_STATUSES.includes(prediction.status)) return prediction;
    if ((Date.now() - startedAt) / 1000 > timeoutSeconds) {
      await cancelPrediction(id, token);
      return { ...prediction, status: "timeout" };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The first output URL, whichever shape the predictor published. */
function outputUrl(prediction: Prediction): string | undefined {
  const output = prediction.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output[0];
  return undefined;
}

/** The real format of the returned bytes, so a PNG is never filed as `.webp`. */
function imageExtension(bytes: Buffer, url: string): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  const fromUrl = path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
  return fromUrl === "" ? undefined : fromUrl;
}

async function downloadImage(url: string, token: string): Promise<Buffer> {
  // The token goes to Replicate's API host and nowhere else; outputs are served
  // from a delivery host that has no business receiving a provider credential.
  const sameHost = new URL(url).host === API_HOST;
  const response = await fetch(url, sameHost ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!response.ok) throw new Error(`downloading the output from ${new URL(url).host} → ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MANIFEST_COLUMNS = ["arm", "fixture", "seed", "recipe", "prediction", "status", "duration_s", "output"];

function csvRow(cells: readonly string[]): string {
  return `${cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",")}\n`;
}

/**
 * The grading sheet's header, derived from `sdEvaluationDimensions`.
 *
 * Hand-typing the seven columns would let the sheet and the package's own idea
 * of what is graded drift apart, and the sheet is the artifact that outlives the
 * run.
 */
function scoresHeader(): string {
  return csvRow(["arm", "fixture", ...sdEvaluationDimensions, "notes"]);
}

function runNotes(
  version: string,
  cells: readonly Cell[],
  arms: readonly ResolvedArm[],
  fixtures: readonly SdEvaluationFixture[],
  reference: Reference | undefined,
): string {
  const today = new Date().toISOString().slice(0, 10);
  return `# Stage 3 identity matrix

Status: rendered ${today} — ungraded.

The controlled identity matrix, Stage 3: base SDXL
against the identity layers — PuLID at three strengths, and any character LoRA
this run was given, alone and combined — over ${String(fixtures.length)} fixed scenes at fixed seeds.
Rendered by \`scripts/eval/sd-identity-matrix.ts\`.

- **Renderer version:** \`${version}\` (\`ceponatia/sdxl-character-render\`)
- **Reference provenance:** ${reference === undefined ? "none — this run was the control arm only, which sends no reference" : `\`${reference.provenance}\` — TO BE FILLED: which character, which identity-pack image, and why that one`}
- **Cells:** ${String(cells.length)} (${arms.map(({ arm }) => arm.id).join(" / ")} x ${String(fixtures.length)} fixtures)

Everything in this folder is **local only**. The owner ruling of 2026-08-28 is
that all evaluation output lives in the untracked root \`eval-images/\` and none
of it enters git — not the images, not \`manifest.csv\`, not \`scores.csv\`. It
exists on the machine that ran the eval and nowhere else, so whatever a later
reader needs to keep has to be written up somewhere durable: the issue this run
was for.

## The arms

${arms.map(({ arm, recipe }) => `- \`${arm.id}\` — recipe \`${arm.recipeId}\` (identity weight ${recipe.identityWeight === undefined ? "none" : recipe.identityWeight.toFixed(2)}, LoRA ${arm.lora === undefined ? "none" : `\`${arm.lora.weights}\``}). ${arm.question}`).join("\n")}

Arms whose recipe carries **no identity weight** send no reference image: the
renderer refuses one there, and conditioning the control at some default strength
would turn it into another identity cell.

The LoRA URLs above are the run's real provenance for the trained weights — the
arm names say \`r8\` and \`r16\`, but only the address says which training produced
them. TO BE FILLED: the identity-pack binding each one was registered under.

## The fixtures

${fixtures.map((fixture) => `- \`${fixture.id}\` (seed ${String(fixture.seed)}) — ${fixture.notes ?? "no notes"}`).join("\n")}

## How to grade

Open every arm of one fixture side by side, then move to the next fixture.
Score each cell in \`scores.csv\`, one row per arm per fixture, on these seven
dimensions: ${sdEvaluationDimensions.join(", ")}.

Suggested scale: **0** = absent or wrong, **1** = partly there, **2** = right.
Whatever scale is used, write it here so the numbers stay readable later.

Two of these pull against each other by design, and that tension is the result
this run exists to measure: raising identity strength should improve \`face\` and
cost \`clothing_flexibility\` and \`pose_flexibility\`. A single quality score would
hide it and would name the strongest arm the winner every time.

\`state_obedience\` is the Vesper-specific column. Grade it only on
\`state-prosthetic-forearm\` (is the prosthetic present, on the stated arm,
replacing the forearm?) and \`state-face-dressing\` (is the dressing present, on
the stated cheek?), and leave it blank elsewhere — the other fixtures author no
state to obey.

## Verdict

TO BE FILLED — the provisional identity recipe this run selects, and why. Per
Stage 3, no ControlNet work starts until there is a clear winner here.
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  if (error === undefined || error === null) return "no reason was given";
  return JSON.stringify(error).slice(0, 300);
}

function printMatrix(cells: readonly Cell[], arms: readonly ResolvedArm[], fixtures: readonly SdEvaluationFixture[]): void {
  console.log("\n=== Arms ===");
  // The id column is sized to the widest id present rather than to a constant:
  // `--lora` builds arm names at run time, and a fixed width turns the matrix
  // listing — the thing an operator reads before approving the spend — into
  // ragged text at exactly the moment it has the most rows.
  const armWidth = Math.max(...arms.map(({ arm }) => arm.id.length));
  for (const { arm } of arms) console.log(`  ${arm.id.padEnd(armWidth)} ${arm.recipeId.padEnd(30)} ${arm.question}`);

  console.log("\n=== Fixtures ===");
  for (const fixture of fixtures) {
    console.log(`\n--- ${fixture.id} (seed ${String(fixture.seed)}) ---`);
    console.log(`  ${fixture.notes ?? "no notes"}`);
    console.log(`  prompt:   ${fixture.prompt}`);
    console.log(`  negative: ${fixture.negativePrompt ?? "(none)"}`);
  }

  console.log(`\n=== The matrix: ${String(cells.length)} cells ===`);
  for (const cell of cells) {
    const reference = "reference_image" in cell.input ? "reference: yes" : "reference: none";
    const weight = cell.recipe.identityWeight;
    console.log(
      `  ${cell.arm.id.padEnd(armWidth)} ${cell.fixture.id.padEnd(26)} ${cell.recipe.id.padEnd(30)} ` +
        `seed ${String(cell.fixture.seed).padEnd(8)} ${String(cell.recipe.width)}x${String(cell.recipe.height)}  ` +
        `identity ${(weight === undefined ? "—" : weight.toFixed(2)).padEnd(5)} ` +
        `lora ${(cell.arm.lora === undefined ? "—" : "yes").padEnd(4)} ${reference}`,
    );
  }

  const sample = cells[0];
  if (sample !== undefined) {
    console.log(`\nEvery request body is this shape; only prompt, negative_prompt, seed and recipe differ.\nSample (${sample.arm.id}/${sample.fixture.id}):`);
    console.log(JSON.stringify(sample.input, null, 2));
  }
}

/** What a paid run is aimed at: the pinned version, and how long one cell may take. */
interface RunTarget {
  readonly version: string;
  readonly timeoutSeconds: number;
}

interface CellResult {
  readonly row: string[];
  readonly ok: boolean;
}

async function renderCell(cell: Cell, run: RunTarget, token: string, outDir: string): Promise<CellResult> {
  const label = `${cell.arm.id}/${cell.fixture.id}`;
  const base = [cell.arm.id, cell.fixture.id, String(cell.fixture.seed), cell.recipe.id];
  const startedAt = Date.now();
  const elapsed = (): string => ((Date.now() - startedAt) / 1000).toFixed(1);

  let prediction: Prediction;
  try {
    prediction = await callReplicate("POST", "/predictions", token, predictionSchema, {
      version: run.version,
      input: cell.input,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  ${label} ERROR: ${reason}`);
    return { ok: false, row: [...base, "", `error: ${reason}`, elapsed(), ""] };
  }

  let settled: Prediction;
  try {
    settled = await pollUntilSettled(prediction.id, token, run.timeoutSeconds);
  } catch (err) {
    // A transient 5xx on a poll must not abort a matrix that has already been
    // paid for. The prediction id is recorded, so the cell can be collected from
    // Replicate by hand or the one cell re-run with --arm/--fixture.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  ${label} POLL FAILED (${prediction.id}): ${reason}`);
    return { ok: false, row: [...base, prediction.id, `error: ${reason}`, elapsed(), ""] };
  }

  if (settled.status !== "succeeded") {
    const reason = settled.status === "timeout" ? `timed out after ${String(run.timeoutSeconds)}s and was cancelled` : describeError(settled.error);
    console.error(`  ${label} ${settled.status.toUpperCase()} (${settled.id}): ${reason}`);
    return { ok: false, row: [...base, settled.id, settled.status, elapsed(), ""] };
  }

  const url = outputUrl(settled);
  if (url === undefined) {
    console.error(`  ${label} succeeded but published no output (${settled.id})`);
    return { ok: false, row: [...base, settled.id, "error: no output", elapsed(), ""] };
  }

  try {
    const bytes = await downloadImage(url, token);
    const extension = imageExtension(bytes, url);
    if (extension === undefined || !GITIGNORED_IMAGE_EXTENSIONS.includes(extension)) {
      // Fail-closed on purpose. The owner ruling of 2026-08-28 is that generated
      // imagery never enters git history, and writing an uncovered format is how
      // a tracked image would get there if this ever ran outside `eval-images/`.
      const reason = `the renderer returned .${extension ?? "unknown"}, which .gitignore's image rules do not cover — extend .gitignore before re-running; nothing was written`;
      console.error(`  ${label} REFUSED: ${reason}`);
      return { ok: false, row: [...base, settled.id, `error: uncovered output format .${extension ?? "unknown"}`, elapsed(), ""] };
    }
    const file = path.join(outDir, cell.arm.id, `${cell.fixture.id}.${extension}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    const duration = elapsed();
    console.log(`  ${label} → ${file} (${duration}s)`);
    return { ok: true, row: [...base, settled.id, settled.status, duration, file] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`  ${label} DOWNLOAD FAILED: ${reason}`);
    return { ok: false, row: [...base, settled.id, `error: ${reason}`, elapsed(), ""] };
  }
}

/**
 * Everything downstream of the reference upload.
 *
 * Split out of {@link main} for one reason: the caller wraps this whole call in
 * the `finally` that deletes an uploaded anchor, so every step below is covered
 * by that cleanup. It used to guard only the render loop, which left a window —
 * an unwritable `--out`, a bad `--version`, a failed honesty check — where the
 * upload had already succeeded and nothing ever took it back off Replicate.
 */
async function runMatrix(
  args: Args,
  arms: readonly ResolvedArm[],
  fixtures: readonly SdEvaluationFixture[],
  token: string,
  reference: Reference | undefined,
): Promise<void> {
  const identityArms = arms.filter(({ recipe }) => sendsReference(recipe));
  const referenceUrl = args.dryRun ? REFERENCE_PLACEHOLDER : reference?.url;

  const cells = arms.flatMap(({ arm, recipe }) => fixtures.map((fixture) => buildCell(arm, recipe, fixture, referenceUrl)));
  // Everything above is free. This is the last free thing, and it runs on the
  // WHOLE selected matrix before the first send.
  assertMatrixIsHonest(cells);
  printMatrix(cells, arms, fixtures);

  const outDir = path.resolve(args.out);
  if (args.dryRun) {
    // The grading sheet and the run notes are the artifacts that outlive the
    // images, and both are free to review. Printing them here means the wording
    // of the notes and the shape of the sheet can be argued about before a GPU
    // is involved, which is the same reason the prompts print above.
    console.log("\n=== manifest.csv (header; one row appended per cell) ===");
    console.log(csvRow(MANIFEST_COLUMNS).trimEnd());
    console.log("\n=== scores.csv (header only; grading fills the rest) ===");
    console.log(scoresHeader().trimEnd());
    console.log("\n=== README.md ===");
    console.log(
      runNotes(args.version ?? "<the --version id>", cells, arms, fixtures, {
        url: REFERENCE_PLACEHOLDER,
        provenance: args.reference ?? "<the --reference value>",
      }),
    );

    console.log(`--dry-run: no network calls were made, nothing was uploaded, nothing was written.`);
    console.log(`A real run would write ${String(cells.length)} image(s) plus manifest.csv, scores.csv and README.md into ${outDir}/`);
    if (identityArms.length > 0 && args.reference === undefined) {
      console.log(
        `It would also need --reference: ${String(identityArms.length)} of the selected arms condition identity, and each one's request carries the anchor URL printed above as ${REFERENCE_PLACEHOLDER}.`,
      );
    }
    return;
  }

  // Re-read rather than asserted: the guard above already refused a real run
  // without one, and narrowing here keeps the version a plain string everywhere
  // it is used instead of an optional threaded through every call.
  const version = args.version;
  if (version === undefined) throw new UsageError("--version is required");
  const run: RunTarget = { version, timeoutSeconds: args.timeoutSeconds };

  console.log(`\nPAID RUN: ${String(cells.length)} predictions on version ${version} → ${outDir}/`);
  await fs.mkdir(outDir, { recursive: true });
  const manifest = path.join(outDir, "manifest.csv");
  await fs.writeFile(manifest, csvRow(MANIFEST_COLUMNS));
  await fs.writeFile(path.join(outDir, "scores.csv"), scoresHeader());
  await fs.writeFile(path.join(outDir, "README.md"), runNotes(version, cells, arms, fixtures, reference));

  let failures = 0;
  for (const cell of cells) {
    const result = await renderCell(cell, run, token, outDir);
    // Appended per cell rather than written at the end: an interrupted run
    // still records every prediction it paid for.
    await fs.appendFile(manifest, csvRow(result.row));
    if (!result.ok) failures += 1;
  }

  console.log(`\n${String(cells.length - failures)}/${String(cells.length)} cells rendered. Manifest: ${manifest}`);
  console.log(`Grade into ${path.join(outDir, "scores.csv")} — see ${path.join(outDir, "README.md")}.`);
  if (failures > 0) {
    console.error(`${String(failures)} cell(s) failed; their rows carry the status and the prediction id.`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const arms = resolveArms(selectArms(allArms(args.loras), args.arms));
  const fixtures = selectFixtures(args.fixtures);
  const identityArms = arms.filter(({ recipe }) => sendsReference(recipe));

  if (!args.dryRun && args.version === undefined) {
    throw new UsageError("--version is required: the renderer is private and non-official, so a prediction must name its version id");
  }
  if (!args.dryRun && identityArms.length > 0 && args.reference === undefined) {
    throw new UsageError("--reference is required whenever an identity arm runs (use --arm base for a control-only run)");
  }

  // The reference is uploaded BEFORE the matrix is built, because its URL is
  // part of every identity cell's request — and a dry run says so with a
  // sentinel rather than uploading anything.
  const token = args.dryRun ? "" : replicateToken();
  let reference: Reference | undefined;
  if (!args.dryRun && args.reference !== undefined) {
    console.log(`Resolving the identity reference (${args.reference}) …`);
    reference = await resolveReference(args.reference, token);
    console.log(`  ${reference.fileId === undefined ? "used as given" : `uploaded once as ${reference.fileId}`}`);
  }

  // The `try` opens IMMEDIATELY after the upload returns, so there is no step
  // between "Replicate now holds a file" and "something guarantees it is
  // deleted". Nothing between the upload and here can throw.
  try {
    await runMatrix(args, arms, fixtures, token, reference);
  } finally {
    if (reference !== undefined) await deleteUploadedReference(reference, token);
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
