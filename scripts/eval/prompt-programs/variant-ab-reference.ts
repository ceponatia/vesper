import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { hasReplicate, replicateClient } from "@/server/ai";
import { buildAvatarSegments } from "@/server/images";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { trialCharacterProfile, trialWardrobe, FIXTURE_NAME, FIXTURE_READ_TOKEN, FIXTURE_SUBJECT_ID, REFERENCE_DEFAULT } from "./variant-ab-fixture";

/**
 * The variant A/B's canonical portrait — the identity reference both arms send.
 *
 * `variant-prompt-ab.ts` compares a legacy variant prompt against a compiled
 * prompt program over ONE character, and Qwen Image Edit 2511 is edit-only: it
 * refuses a bare prompt and needs the picture it is editing. That picture is
 * this script's whole output.
 *
 * ## Why it is generated rather than borrowed
 *
 * A trial's reference has to be the character the prompts describe. The fixture
 * is a succubus with spiraled horns, membranous wings and a spaded tail, and
 * both arms instruct the model to keep them — so a reference without them turns
 * the compiled arm's "keep the horns unchanged from the source" into an
 * instruction with no referent, on exactly the axis
 * (`VARIANT_SHADOW_DELTA = added: horns/wings/tail`) the cutover claims as its
 * gain. Three of the trial's six grading dimensions would then be measuring the
 * mismatch instead of the migration: the preserved facts have nothing to
 * preserve, the stated late-twenties age contradicts the face, and a
 * full-figure instruction fights a head-and-shoulders crop.
 *
 * ## Why it is built through the avatar lane
 *
 * The portrait is composed by `buildAvatarSegments` over the SAME fixture
 * profile and wardrobe the trial uses — the production portrait path, camera,
 * policy and all — rather than from a paragraph written here. That is what
 * makes this a canonical portrait of the trial's character rather than a
 * picture that happens to resemble her: the same sheet produces both the
 * reference and the prompts measured against it, so a mismatch between them is
 * impossible by construction. The avatar lane is intimate-free by rule
 * (`intimateAllowed: false`), and the fixture is dressed, so the portrait is a
 * clothed full-figure shot.
 *
 * It runs on `qwen/qwen-image-2512`, the generation endpoint the portrait lane
 * uses, pinned to its probed version. The trial's own renders run on 2511; the
 * reference is an input to them, not one of their arms, so nothing about this
 * render is a variable in the comparison.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/eval/prompt-programs/variant-ab-reference.ts             # FREE: prints the portrait prompt
 * pnpm tsx scripts/eval/prompt-programs/variant-ab-reference.ts --render    # PAID: one render
 * ```
 *
 * One render. It refuses to overwrite an existing reference without `--force`,
 * because replacing the file silently would re-anchor a half-graded trial to a
 * different face and quietly invalidate every score already written against it.
 */

/** The probed pin from `docs/image-models/models/qwen-image-2512.md`. */
const PORTRAIT_VERSION = "47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6";

const PORTRAIT_SLUG = "qwen/qwen-image-2512";

/**
 * The portrait endpoint's row, stated here rather than read from `image_models`.
 *
 * Same discipline as the trial's own `trialModel`: a lab script that read the
 * production row would render whatever an admin last saved, and a run whose
 * configuration cannot be read off the script is a run nobody can reproduce.
 */
function portraitModel(): ImageModel {
  return imageModelSchema.parse({
    id: "trial-qwen-2512-portrait",
    slug: `${PORTRAIT_SLUG}:${PORTRAIT_VERSION}`,
    label: "Qwen Image 2512 (A/B reference)",
    canGenerate: true,
    canEdit: false,
    supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    outputFormat: "webp",
    // The reviewed production setting for this family: the fast sampler trades
    // exactly the surface detail an identity reference exists to carry.
    extraInput: { output_quality: 95, go_fast: false, disable_safety_checker: true },
    probedVersionId: PORTRAIT_VERSION,
    forPortrait: true,
  });
}

/** The portrait prompt, composed by the production avatar lane over the trial fixture. */
function referencePrompt(sink: DiagnosticCollector): string {
  const assembly = buildAvatarSegments({
    characterId: FIXTURE_SUBJECT_ID,
    name: FIXTURE_NAME,
    profile: trialCharacterProfile(),
    // The lane's realistic arm: a canonical portrait is a photograph of the
    // person, and the trial's compiled prompt asks 2511 to render a photograph.
    style: "realistic",
    wardrobe: trialWardrobe(),
    readToken: FIXTURE_READ_TOKEN,
    sink,
  });
  return assembly.prompt;
}

async function main(): Promise<void> {
  const render = process.argv.includes("--render");
  const force = process.argv.includes("--force");
  const sink = new DiagnosticCollector();
  const prompt = referencePrompt(sink);

  console.log(`\n##### Variant A/B reference portrait — ${FIXTURE_NAME}, on ${PORTRAIT_SLUG}`);
  console.log(`  VERSION  ${PORTRAIT_VERSION}`);
  console.log(`  OUT      ${REFERENCE_DEFAULT}`);
  console.log(`\n  PROMPT (${String(prompt.length)} chars, from buildAvatarSegments over the trial fixture)\n  ${prompt}\n`);
  for (const entry of sink.items) console.log(`  [${entry.severity}] ${entry.code}`);

  if (!render) {
    console.log("\nNothing was sent. Re-run with --render to generate the reference (1 render).");
    return;
  }
  if (!hasReplicate()) throw new Error("REPLICATE_API_TOKEN is not set — --render has nothing to send to");

  if (existsSync(REFERENCE_DEFAULT) && !force) {
    throw new Error(
      `${REFERENCE_DEFAULT} already exists. Replacing the reference re-anchors every arm of the trial, ` +
        "so scores already graded against the old face would no longer describe the renders they scored. " +
        "Pass --force only when no graded sheet depends on it.",
    );
  }

  const result = await replicateClient().runRegistryImageModel(portraitModel(), {
    prompt,
    aspect: "3:4",
    controlInput: { seed: 20_260_831 },
  });
  const image = result?.image;
  if (!image) throw new Error("the portrait endpoint returned no image");

  await mkdir(path.dirname(REFERENCE_DEFAULT), { recursive: true });
  await writeFile(REFERENCE_DEFAULT, image);
  console.log(`\n  WROTE ${REFERENCE_DEFAULT} (${String(image.length)} bytes)`);
  console.log(`  executedVersionId ${String(result.executedVersionId ?? "unknown")}`);
  console.log("\nLook at it before spending the trial's renders: it must show the horns, wings and tail,");
  console.log("read as the stated age, and be framed full-figure. A reference that does not is not this character.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
