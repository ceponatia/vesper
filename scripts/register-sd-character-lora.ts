import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type ImageProfileTask,
  imageLoraCreateRequestSchema,
  imageProfileTasks,
  isValidImageLoraLocator,
} from "@vesper/image-core";
import { sdTrainingRecipeRevision } from "@vesper/image-sd";
import { z } from "zod";
import { createIdentityLoraBinding, createImageLora, setIdentityLoraBindingState } from "@/server/images";

/**
 * Put a trained character LoRA into Vesper's library and bind it to the identity
 * pack it was trained from (Stage 4).
 *
 *   pnpm tsx scripts/register-sd-character-lora.ts \
 *     --result ./sd-lora-training-output/<training-id>/training-result.json \
 *     --label "Sabrina — SDXL rank 8"
 *
 * The free half of the Stage 4 errand. `scripts/train-sd-character-lora.ts` does
 * the paid, slow, dataset-bound part and writes `training-result.json`; this
 * reads that file and makes two rows. Splitting them is what keeps a typo in a
 * label from costing a training run, and lets a training whose registration is
 * deferred lose nothing.
 *
 * **Two rows, both existing kinds.** Vesper keeps
 * ONE LoRA library, so the weights become an ordinary `image_loras` row with the
 * same compatibility rules as every other. The binding is the small extra fact —
 * that this row is a likeness of a particular identity pack revision, trained
 * under a particular recipe from a particular dataset — and it is what lets
 * Vesper notice later that the pack has moved on.
 *
 * **Nothing here is promoted.** A new binding is `experimental`, which is what
 * Stage 4 says the whole slice is: rank 8 and rank 16 both land, both renderable,
 * neither preferred, until the comparison picks one. `--activate` is the
 * deliberate promotion, and it fails loudly if the pack already has an active
 * binding rather than silently demoting one.
 */

class UsageError extends Error {}

const OPTIONS = {
  result: { type: "string" },
  label: { type: "string" },
  "weights-url": { type: "string" },
  "model-slug": { type: "string", multiple: true },
  task: { type: "string", multiple: true },
  "default-scale": { type: "string" },
  "minimum-scale": { type: "string" },
  "maximum-scale": { type: "string" },
  activate: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean" },
} as const;

/**
 * The renderer this LoRA is trained for.
 *
 * `compatibleModelSlugs` is fail-closed by design (`image-loras.ts`): an empty
 * list means NOTHING may use these weights. So a default is supplied rather than
 * left blank, and it is the Vesper-owned SDXL renderer — the only model in
 * Vesper that loads a raw `.safetensors` LoRA against SDXL base weights. The
 * third-party `nsfw-api/sdxl-pulid` row is deliberately not here: it exposes no
 * LoRA input, so naming it would promise a render that cannot happen.
 */
const DEFAULT_MODEL_SLUG = "ceponatia/sdxl-character-render";

/**
 * The tasks an identity LoRA may serve, and the curated strength band.
 *
 * The tasks are the four SD profiles. The band brackets the "character LoRA
 * around 0.7–0.9" guidance rather than pinning it: the library row is what a lab
 * comparison varies within, and a band exactly as wide as the default would make
 * the next tuning pass an edit to the row instead of a parameter of the run.
 */
const DEFAULT_TASKS: readonly ImageProfileTask[] = ["portrait", "variant", "chat_look", "scene"];
const DEFAULT_SCALES = { defaultScale: 0.8, minimumScale: 0.6, maximumScale: 1.0 };

/** The provenance file `train-sd-character-lora.ts` writes. Parsed, never trusted. */
const trainingResultSchema = z.object({
  identityPackId: z.string().min(1),
  trainingRecipeId: z.string().min(1),
  trainingRecipeRevision: z.number().int().positive(),
  baseCheckpoint: z.string().min(1),
  rank: z.number().int().min(1).max(128),
  datasetFingerprint: z.string().min(1),
  datasetImageCount: z.number().int().positive(),
  triggerToken: z.string().min(1),
  trainingRunRef: z.string().min(1),
  weightsUrl: z.string().nullable().default(null),
  publiclyReadable: z.boolean().default(false),
});
type TrainingResult = z.infer<typeof trainingResultSchema>;

const HELP = `
Register a trained SDXL character LoRA and bind it to its identity pack (SD plan Stage 4).

  pnpm tsx scripts/register-sd-character-lora.ts --result <path> --label "<library label>"

Required:
  --result <path>        training-result.json, written by scripts/train-sd-character-lora.ts.
  --label <text>         The LoRA library label an operator will pick from.

Optional:
  --weights-url <url>    Overrides the published URL in the result file — use it when the
                         weights were uploaded by hand. Must be an HTTPS .safetensors URL.
  --model-slug <slug>    Repeatable. Default ${DEFAULT_MODEL_SLUG}
  --task <task>          Repeatable. Default ${DEFAULT_TASKS.join(", ")}
                         Have: ${imageProfileTasks.join(", ")}
  --default-scale <n>    Default ${String(DEFAULT_SCALES.defaultScale)}
  --minimum-scale <n>    Default ${String(DEFAULT_SCALES.minimumScale)}
  --maximum-scale <n>    Default ${String(DEFAULT_SCALES.maximumScale)}
  --activate             Promote the new binding to 'active'. Fails if the pack already has one.
  --dry-run              Print both rows and write nothing.
  --help                 This text.

Environment:
  DATABASE_URL, from the repository .env as usual.
`.trim();

function scale(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`${flag} must be a number >= 0: ${raw}`);
  return parsed;
}

/** `--task a --task b` and `--task a,b` both work; neither is worth arguing about. */
function idList(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function readResult(path: string): TrainingResult {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new UsageError(`--result does not exist: ${resolved}`);
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new UsageError(`--result is not valid JSON: ${resolved}`);
  }
  const parsed = trainingResultSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UsageError(
      `--result is missing provenance this registration needs (${parsed.error.message}). ` +
        "A file written by a --resume run has no dataset in it and cannot be registered.",
    );
  }
  return parsed.data;
}

async function main(): Promise<void> {
  let values;
  try {
    values = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)} (run with --help)`);
  }
  if (values.help === true) {
    console.log(HELP);
    return;
  }

  const resultPath = typeof values.result === "string" ? values.result : undefined;
  const label = typeof values.label === "string" ? values.label : undefined;
  if (resultPath === undefined) throw new UsageError("--result is required");
  if (label === undefined) throw new UsageError("--label is required");

  const result = readResult(resultPath);
  const locator = (typeof values["weights-url"] === "string" ? values["weights-url"] : result.weightsUrl) ?? "";
  if (locator === "") {
    throw new UsageError(
      "no weights URL — the training run published nothing, so pass --weights-url with the address you hosted " +
        "lora.safetensors at. The renderer fetches it with no credential, so it must be publicly readable.",
    );
  }
  if (!isValidImageLoraLocator("https_url", locator) || !locator.toLowerCase().endsWith(".safetensors")) {
    throw new UsageError(`--weights-url must be an HTTPS URL ending in .safetensors: ${locator}`);
  }
  // Reported, not refused. The check ran against the URL as it stood at training
  // time; the operator may have fixed the object's permissions since, and this
  // script cannot tell the difference between "still private" and "checked before
  // the fix". Saying it out loud is the honest middle.
  if (!result.publiclyReadable && values["weights-url"] === undefined) {
    console.log(
      "! the training run could not read these weights anonymously. If that is still true, every render naming " +
        "this LoRA will fail after being billed.",
    );
  }

  // The recipe is resolved for one reason: to prove the revision recorded beside
  // the weights still exists in the package. A binding pointing at a revision
  // nothing can resolve is provenance that cannot be read back.
  const recipe = sdTrainingRecipeRevision(result.trainingRecipeId, result.trainingRecipeRevision);
  if (!recipe) {
    throw new UsageError(
      `the package registry has no ${result.trainingRecipeId} revision ${String(result.trainingRecipeRevision)} — ` +
        "these weights were trained by a recipe revision this checkout does not carry",
    );
  }
  if (recipe.rank !== result.rank || recipe.baseCheckpoint !== result.baseCheckpoint) {
    throw new UsageError(
      `the recorded training does not match ${recipe.id} revision ${String(recipe.revision)} ` +
        `(rank ${String(result.rank)} vs ${String(recipe.rank)}, checkpoint ${result.baseCheckpoint} vs ${recipe.baseCheckpoint}) — ` +
        "a revision was edited in place instead of being added",
    );
  }

  const tasks = idList(values.task as string[] | undefined);
  const unknownTasks = tasks.filter((task) => !imageProfileTasks.includes(task as ImageProfileTask));
  if (unknownTasks.length > 0) {
    throw new UsageError(`unknown --task ${unknownTasks.join(", ")} — have: ${imageProfileTasks.join(", ")}`);
  }
  const slugs = idList(values["model-slug"] as string[] | undefined);

  const loraRequest = imageLoraCreateRequestSchema.parse({
    label,
    locatorType: "https_url",
    locator,
    compatibleModelSlugs: slugs.length > 0 ? slugs : [DEFAULT_MODEL_SLUG],
    compatibleVersionIds: [],
    defaultScale: scale(values["default-scale"] as string | undefined, "--default-scale", DEFAULT_SCALES.defaultScale),
    minimumScale: scale(values["minimum-scale"] as string | undefined, "--minimum-scale", DEFAULT_SCALES.minimumScale),
    maximumScale: scale(values["maximum-scale"] as string | undefined, "--maximum-scale", DEFAULT_SCALES.maximumScale),
    triggerWords: [result.triggerToken],
    allowedTasks: tasks.length > 0 ? tasks : [...DEFAULT_TASKS],
    enabled: true,
  });

  const bindingRequest = {
    identityPackId: result.identityPackId,
    baseCheckpoint: result.baseCheckpoint,
    datasetFingerprint: result.datasetFingerprint,
    datasetImageCount: result.datasetImageCount,
    trainingRecipeId: result.trainingRecipeId,
    trainingRecipeRevision: result.trainingRecipeRevision,
    rank: result.rank,
    triggerToken: result.triggerToken,
    trainingRunRef: result.trainingRunRef,
  };

  if (values["dry-run"] === true) {
    console.log("--dry-run: nothing was written.");
    console.log("image_loras row:");
    console.log(JSON.stringify(loraRequest, null, 2));
    console.log("image_identity_lora_bindings row:");
    console.log(JSON.stringify({ ...bindingRequest, loraId: "<the new LoRA id>", state: "experimental" }, null, 2));
    return;
  }

  const lora = await createImageLora(loraRequest);
  console.log(`Created LoRA ${lora.id} — ${lora.label}`);

  const binding = await createIdentityLoraBinding({ ...bindingRequest, loraId: lora.id, state: "experimental" });
  if (!binding.ok) {
    // The LoRA row is deliberately LEFT in place. It is valid on its own, an
    // operator can bind it by hand, and deleting it here would throw away the
    // one durable record of a paid training run because a second insert failed.
    console.error(`The LoRA was created, but the binding was refused (${binding.code}): ${binding.message}`);
    console.error(`Fix the cause and bind LoRA ${lora.id} to pack ${result.identityPackId} by hand.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Bound it to identity pack ${result.identityPackId} as ${binding.binding.id} (experimental)`);

  if (values.activate === true) {
    const promoted = await setIdentityLoraBindingState(binding.binding.id, "active");
    if (!promoted.ok) {
      console.error(`Promotion refused (${promoted.code}): ${promoted.message}`);
      console.error("Retire the pack's current active binding first, then promote this one.");
      process.exitCode = 1;
      return;
    }
    console.log("Promoted it to active.");
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
