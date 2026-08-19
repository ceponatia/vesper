import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { emptyImageModelAdvancedCapabilities, type ImageModel } from "@vesper/image-core";
import { hasReplicate, replicateClient } from "@/server/ai";
import { negativeBlockDelta, parseNegativeBlockCsv, summarizeNegativeBlockRows } from "./negative-block-report";

/**
 * Per-block negative-prompt induction trials for Qwen Image 2512
 * (model-aware-image-prompts.plan.md §"Stage 6 — negative transport promotion").
 *
 * The first production-pack A/B proved the transport plumbing and nothing else:
 * its no-negative arms mostly lacked the failures the blocks exist to suppress,
 * so the negative arm had nothing to show. These trials are built the opposite
 * way — each one INDUCES or selects the failure its block is meant to prevent,
 * because a block can only be judged against renders where its failure actually
 * occurs.
 *
 * ## Rules the design holds
 *
 * - One block per comparison. The whole pack would let one harmful block hide a
 *   useful one; the combined pack gets its own later safety pass (Trial J, on
 *   the `entity-negative-ab.ts` production harness, after the matrix review).
 * - Paired seed sets: OFF and every ON arm render the SAME seeds, and nothing
 *   else varies — endpoint, positive prompt, aspect, provider controls all held.
 * - Neutral positives: the positive prompt never names the thing the negative
 *   is meant to suppress. Saying "invisible ghost mannequin" and then asking
 *   the negative to remove mannequins is a contradictory test, and the first
 *   run showed the naming alone puts one in the picture.
 * - Binary facts first: every primary metric is a yes/no an image either shows
 *   or does not. Subjective quality is collateral, never the headline.
 * - The verdict vocabulary is helpful / neutral / harmful / inconclusive per
 *   block × failure — never one global answer. An OFF arm whose failure rate is
 *   near zero makes the cell INCONCLUSIVE, not neutral.
 *
 * Trial A is a lab-only contradictory canary ("red apple, apple" against a
 * requested red apple). It deliberately bypasses the production collision
 * linter and is NOT a production wording candidate — it exists to prove the
 * field steers at all before subtler results are interpreted. If A shows no
 * repeatable steering, stop and report that first.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/eval/prompt-programs/qwen-2512-negative-blocks.ts                    # free: prints arms, writes CSV templates
 * AB_TRIAL=B1 pnpm tsx .../qwen-2512-negative-blocks.ts --render                       # PAID: one trial
 * AB_TRIAL=all ... --render                                                            # PAID: all of A–I
 * pnpm tsx .../qwen-2512-negative-blocks.ts --report                                   # rates + deltas from graded CSVs
 * ```
 *
 * Renders are idempotent (an existing file is not re-rendered), a scores CSV is
 * never overwritten once it exists, and every render's `executedVersionId` is
 * recorded in the trial's manifest so a mid-run provider re-point is visible
 * instead of silently grading two models as one.
 */

const SLUG = "qwen/qwen-image-2512";
const OUT_ROOT = process.env["AB_OUT"] ?? "screenshots/qwen-negative-blocks";
const SEED_BASE = Number(process.env["AB_SEED_BASE"] ?? 101);

// ---------------------------------------------------------------------------
// Trial definitions
// ---------------------------------------------------------------------------

interface TrialArm {
  readonly id: string;
  /** The exact negative_prompt this arm sends; null sends no field at all. */
  readonly negative: string | null;
}

interface TrialFixture {
  readonly id: string;
  readonly positive: string;
  readonly aspect: string;
  /** Fixture-specific ON negatives, when the block wording must specialize. */
  readonly negatives?: Readonly<Record<string, string>>;
}

interface NegativeBlockTrial {
  readonly id: string;
  readonly title: string;
  /** The production block (or distinction) under test. */
  readonly block: string;
  /** The failure this trial induces, in one line. */
  readonly failure: string;
  readonly seeds: number;
  readonly fixtures: readonly TrialFixture[];
  readonly arms: readonly TrialArm[];
  /** Primary binary metrics, graded per render. */
  readonly metrics: readonly string[];
  /** Collateral checks — the damage a block must not cause. */
  readonly collateral: readonly string[];
}

const ANTI_SUPPORT = "mannequin, dress form, torso, bust, human body, visible support structure, hanger";

const TRIALS: readonly NegativeBlockTrial[] = [
  {
    id: "A",
    title: "Transport canary (lab-only, deliberately contradictory)",
    block: "none — instrumentation",
    failure: "does changing negative_prompt measurably steer content at all",
    seeds: 10,
    fixtures: [
      {
        id: "apple_mug",
        positive: "A studio photograph of a bright red apple beside a blue ceramic mug on a plain white surface.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: "red apple, apple" },
    ],
    metrics: ["red_apple_present", "any_apple_present"],
    collateral: ["blue_mug_preserved"],
  },
  {
    id: "B1",
    title: "Garment support suppression — sheer scarf",
    block: "support suppression (candidate)",
    failure: "a mannequin/dress form/support appears in a garment-only product shot",
    seeds: 8,
    fixtures: [
      {
        id: "scarf",
        positive:
          "A pale rose sheer silk gauze scarf, isolated studio product photograph against a light neutral background. The scarf is softly draped as if suspended naturally, with its translucency and loosely woven texture clearly visible. Garment only.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: ANTI_SUPPORT },
    ],
    metrics: ["support_visible", "hanger_visible", "garment_alone"],
    collateral: ["translucency_preserved", "too_opaque", "drape_1_5"],
  },
  {
    id: "B2",
    title: "Garment support suppression — work coat",
    block: "support suppression (candidate)",
    failure: "a mannequin/dress form/support appears; or its removal collapses the garment's shape",
    seeds: 8,
    fixtures: [
      {
        id: "coat",
        positive:
          "A heavy olive waxed-canvas work coat with visibly scorched cuffs, isolated studio product photograph against a plain light background. Front view, sleeves hanging naturally, garment only.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: ANTI_SUPPORT },
    ],
    metrics: ["support_visible", "hanger_visible"],
    collateral: ["coat_shape_plausible", "scorched_cuffs_retained"],
  },
  {
    id: "C",
    title: "Invented storefront lettering",
    block: "generated_text_artifacts",
    failure: "the model invents a prominent shop name or readable text nobody authored",
    seeds: 8,
    fixtures: [
      {
        id: "storefront",
        positive:
          "A Victorian apothecary storefront at dusk, dark painted timber frontage, large display windows full of bottles and jars, warm amber lamplight glowing from the interior, richly detailed period architecture.",
        aspect: "4:3",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: "unintended text, random lettering, garbled letters, invented shop names, captions, signatures" },
    ],
    metrics: ["invented_name_prominent", "other_readable_text", "garbled_lettering"],
    collateral: ["storefront_coherent"],
  },
  {
    id: "D",
    title: "Authored sign plus junk-text suppression — broad vs narrow",
    block: "generated_text_artifacts wording (broad vs narrow)",
    failure: "junk text appears around a required sign; or the negative damages the required sign",
    seeds: 8,
    fixtures: [
      {
        id: "aldwin",
        positive:
          'A Victorian apothecary storefront with one sign above the window reading exactly "ALDWIN & SON" in gold lettering. Dark painted timber, warm amber interior light, shelves of bottles visible through the windows.',
        aspect: "4:3",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "broad", negative: "text, letters, captions, logos" },
      { id: "narrow", negative: "extra text, random lettering, garbled letters, duplicate signage, unintended captions" },
    ],
    metrics: ["sign_present", "exact_spelling", "junk_text_present"],
    collateral: ["sign_damaged_or_omitted"],
  },
  {
    id: "E",
    title: "Functional markings — compass dial",
    block: "generated_text_artifacts wording (broad vs narrow)",
    failure: "a text exclusion strips lettering that is intrinsic visual structure (dials, gauges)",
    seeds: 8,
    fixtures: [
      {
        id: "compass",
        positive:
          "A vintage brass pocket compass with a hinged lid and worn leather lanyard, isolated studio product photograph. The compass is open with the complete dial clearly visible, including readable cardinal direction letters and fine degree markings.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "broad", negative: "text, letters, garbled text" },
      { id: "narrow", negative: "unintended caption, watermark, signature, random printed text, garbled unrelated lettering" },
    ],
    metrics: ["cardinal_letters_present", "cardinal_letters_readable", "degree_markings_present"],
    collateral: ["junk_text_elsewhere", "compass_functional"],
  },
  {
    id: "F",
    title: "Duplicate-object suppression",
    block: "extra_objects / background_clutter",
    failure: "a single requested object is rendered twice, or unrelated objects join it",
    seeds: 8,
    fixtures: [
      {
        id: "glove",
        positive:
          "A single worn brown leather glove, isolated studio product photograph on a plain neutral background. Exactly one glove.",
        aspect: "1:1",
        negatives: { on: "duplicate object, second glove, extra items, unrelated objects, background clutter" },
      },
      {
        id: "boot",
        positive:
          "A single weathered brown leather work boot, isolated studio product photograph on a plain neutral background. Exactly one boot.",
        aspect: "1:1",
        negatives: { on: "duplicate object, second boot, extra items, unrelated objects, background clutter" },
      },
    ],
    arms: [
      { id: "off", negative: null },
      // Per-fixture wording above: "second glove" does not belong in a boot shot.
      { id: "on", negative: "" },
    ],
    metrics: ["exactly_one_target", "duplicate_target", "unrelated_object_added"],
    collateral: ["clean_background"],
  },
  {
    id: "G",
    title: "Cropping suppression — objects that strain a square frame",
    block: "composition_artifacts",
    failure: "a long object is cropped by the frame; or the negative bends it to fit",
    seeds: 8,
    fixtures: [
      {
        id: "cane",
        positive:
          "A full-length antique walking cane, isolated studio product photograph. The entire cane from handle to tip is visible inside the frame with comfortable margin around it.",
        aspect: "1:1",
      },
      {
        id: "umbrella",
        positive:
          "A full-length closed black umbrella, isolated studio product photograph. The entire umbrella from handle to tip is visible inside the frame with comfortable margin around it.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: "cropped object, cut-off ends, object extending outside frame, incomplete object" },
    ],
    metrics: ["both_ends_visible", "touches_edge", "comfortably_framed"],
    collateral: ["distorted_to_fit"],
  },
  {
    id: "H",
    title: "Accidental labels — apothecary interior",
    block: "generated_text_artifacts",
    failure: "shelves of bottles grow readable or garbled labels nobody authored",
    seeds: 8,
    fixtures: [
      {
        id: "interior",
        positive:
          "Interior of an old Victorian apothecary, rows of glass bottles and jars filling dark wooden shelves, warm lamplight, richly detailed but orderly interior.",
        aspect: "4:3",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: "readable labels, random lettering, garbled text, captions" },
    ],
    metrics: ["fake_readable_labels", "garbled_pseudo_text"],
    collateral: ["bottle_detail_preserved"],
  },
  {
    id: "I",
    title: "Watermark and signature — a context where one is plausible",
    block: "watermark_and_signature",
    failure: "a poster-style render grows a signature, watermark, or stock-image mark",
    seeds: 8,
    fixtures: [
      {
        id: "poster",
        positive:
          "A richly illustrated vintage travel poster depicting a seaside town at sunset, period print texture and graphic composition.",
        aspect: "3:4",
      },
    ],
    arms: [
      { id: "off", negative: null },
      { id: "on", negative: "watermark, artist signature, artist name, caption, stock-image mark" },
    ],
    metrics: ["signature_present", "watermark_present", "unintended_caption"],
    collateral: ["composition_preserved"],
  },
];

/** The ON negative for one fixture — per-fixture wording wins over the arm's. */
function armNegative(fixture: TrialFixture, arm: TrialArm): string | null {
  if (arm.negative === null) return null;
  const negative = fixture.negatives?.[arm.id] ?? arm.negative;
  // An arm may declare "" to mean "every fixture specializes me" (Trial F:
  // "second glove" does not belong in a boot shot). A fixture that then fails
  // to specialize is a definition bug, not a quiet no-negative render.
  if (negative.length === 0) throw new Error(`${fixture.id} does not specialize the ${arm.id} negative`);
  return negative;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The seeded 2512 row's shape, verbatim from migration 0098 — the same literal
 * the production-pack harness states, so both harnesses render what production
 * would send. The negative rides `controlInput` directly (this is a lab), so
 * one literal serves every arm.
 */
function trialModel(): ImageModel {
  return {
    id: "trial-qwen-2512",
    slug: SLUG,
    label: "Qwen Image 2512",
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "single",
    maxReferences: 1,
    referenceTransport: "file",
    aspectMode: "aspect_ratio",
    supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    outputFormat: "webp",
    extraInput: { output_quality: 95, go_fast: true, disable_safety_checker: true },
    probedVersionId: null,
    editKind: "img2img",
    identityPreservation: "weak",
    operatorWarning: null,
    advancedCapabilities: emptyImageModelAdvancedCapabilities(),
    forPortrait: true,
    forVariant: false,
    forScene: false,
    builtin: true,
    sort: 0,
  } satisfies ImageModel;
}

interface RenderRecord {
  readonly file: string;
  readonly seed: number;
  readonly arm: string;
  readonly fixture: string;
  readonly executedVersionId: string | null;
  readonly predictionId: string | null;
}

async function renderOne(
  positive: string,
  negative: string | null,
  aspect: string,
  seed: number,
): Promise<{ image: Buffer; executedVersionId: string | null; predictionId: string | null } | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await replicateClient().runRegistryImageModel(trialModel(), {
      prompt: positive,
      aspect,
      controlInput: { seed, ...(negative === null ? {} : { negative_prompt: negative }) },
    });
    if (result.ok && result.image) {
      return {
        image: result.image,
        executedVersionId: result.executedVersionId ?? null,
        predictionId: result.predictionId ?? null,
      };
    }
    console.log(`    retryable failure (${result.error ?? "no image"})`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// Contact sheets — one grid per fixture × arm, so grading reads one image
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 380;
const LABEL_HEIGHT = 26;
const SHEET_COLUMNS = 4;

async function contactSheet(files: readonly { file: string; label: string }[], out: string): Promise<void> {
  const panels: Buffer[] = [];
  let panelHeight = 0;
  for (const entry of files) {
    const resized = await sharp(await fs.readFile(entry.file)).resize(PANEL_WIDTH).png().toBuffer();
    const meta = await sharp(resized).metadata();
    panelHeight = Math.max(panelHeight, meta.height ?? PANEL_WIDTH);
    const labeled = await sharp({
      create: { width: PANEL_WIDTH, height: (meta.height ?? PANEL_WIDTH) + LABEL_HEIGHT, channels: 3, background: "#101010" },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${PANEL_WIDTH}" height="${LABEL_HEIGHT}"><text x="8" y="19" font-family="sans-serif" font-size="16" fill="#ffffff">${entry.label}</text></svg>`,
          ),
          top: 0,
          left: 0,
        },
        { input: resized, top: LABEL_HEIGHT, left: 0 },
      ])
      .png()
      .toBuffer();
    panels.push(labeled);
  }
  const rows = Math.ceil(panels.length / SHEET_COLUMNS);
  const cellHeight = panelHeight + LABEL_HEIGHT;
  await sharp({
    create: { width: PANEL_WIDTH * SHEET_COLUMNS, height: cellHeight * rows, channels: 3, background: "#101010" },
  })
    .composite(panels.map((panel, index) => ({ input: panel, top: Math.floor(index / SHEET_COLUMNS) * cellHeight, left: (index % SHEET_COLUMNS) * PANEL_WIDTH })))
    .webp({ quality: 82 })
    .toFile(out);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function seedsOf(trial: NegativeBlockTrial): number[] {
  const count = Number(process.env["AB_SEEDS"] ?? trial.seeds);
  return Array.from({ length: count }, (_, index) => SEED_BASE + index);
}

async function writeScoresTemplate(trial: NegativeBlockTrial, records: readonly RenderRecord[]): Promise<string> {
  const file = path.join(OUT_ROOT, `scores-${trial.id}.csv`);
  if (await fileExists(file)) {
    console.log(`  scores template exists, not overwritten: ${file}`);
    return file;
  }
  const columns = ["trial", "fixture", "arm", "seed", "file", ...trial.metrics, ...trial.collateral, "notes"];
  const rows = records.map((record) =>
    [trial.id, record.fixture, record.arm, String(record.seed), record.file, ...trial.metrics.map(() => ""), ...trial.collateral.map(() => ""), ""].join(","),
  );
  await fs.writeFile(file, `${columns.join(",")}\n${rows.join("\n")}\n`);
  return file;
}

async function runTrial(trial: NegativeBlockTrial, shouldRender: boolean): Promise<void> {
  const seeds = seedsOf(trial);
  console.log(`\n=== Trial ${trial.id} — ${trial.title}`);
  console.log(`    block: ${trial.block}`);
  console.log(`    failure: ${trial.failure}`);
  console.log(`    seeds: ${seeds.join(", ")}`);

  const records: RenderRecord[] = [];
  for (const fixture of trial.fixtures) {
    console.log(`  fixture ${fixture.id} (${fixture.aspect})`);
    console.log(`    POSITIVE ${fixture.positive}`);
    for (const arm of trial.arms) {
      const negative = armNegative(fixture, arm);
      console.log(`    ${arm.id.toUpperCase().padEnd(7)} ${negative ?? "(no negative field)"}`);
    }

    for (const seed of seeds) {
      for (const arm of trial.arms) {
        const negative = armNegative(fixture, arm);
        const file = path.join(OUT_ROOT, trial.id, `${fixture.id}-${arm.id}-s${seed}.webp`);
        records.push({ file, seed, arm: arm.id, fixture: fixture.id, executedVersionId: null, predictionId: null });
        if (!shouldRender) continue;
        if (await fileExists(file)) continue;
        await fs.mkdir(path.dirname(file), { recursive: true });
        const rendered = await renderOne(fixture.positive, negative, fixture.aspect, seed);
        if (rendered === null) {
          console.log(`    FAILED   ${file}`);
          records.pop();
          continue;
        }
        await fs.writeFile(file, rendered.image);
        const record = records[records.length - 1];
        if (record !== undefined) {
          records[records.length - 1] = { ...record, executedVersionId: rendered.executedVersionId, predictionId: rendered.predictionId };
        }
        console.log(`    rendered ${file}${rendered.executedVersionId === null ? "" : ` (${rendered.executedVersionId.slice(0, 12)})`}`);
      }
    }

    if (shouldRender) {
      for (const arm of trial.arms) {
        const armFiles: { file: string; label: string }[] = [];
        for (const seed of seeds) {
          const file = path.join(OUT_ROOT, trial.id, `${fixture.id}-${arm.id}-s${seed}.webp`);
          if (await fileExists(file)) armFiles.push({ file, label: `${fixture.id} ${arm.id} s${seed}` });
        }
        if (armFiles.length === 0) continue;
        const sheet = path.join(OUT_ROOT, trial.id, `sheet-${fixture.id}-${arm.id}.webp`);
        await contactSheet(armFiles, sheet);
        console.log(`    sheet    ${sheet}`);
      }
    }
  }

  await fs.mkdir(OUT_ROOT, { recursive: true });
  const scores = await writeScoresTemplate(trial, records);
  if (shouldRender) {
    const manifest = path.join(OUT_ROOT, trial.id, "manifest.json");
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(
      manifest,
      JSON.stringify(
        { trial: trial.id, slug: SLUG, block: trial.block, seeds, fixtures: trial.fixtures.map((f) => f.id), records },
        null,
        2,
      ),
    );
    console.log(`  manifest ${manifest}`);
  }
  console.log(`  scores   ${scores}`);
}

async function report(): Promise<void> {
  for (const trial of TRIALS) {
    const file = path.join(OUT_ROOT, `scores-${trial.id}.csv`);
    if (!(await fileExists(file))) continue;
    const rows = parseNegativeBlockCsv(await fs.readFile(file, "utf8"));
    const graded = rows.filter((row) => Object.values(row.values).some((value) => value.length > 0));
    if (graded.length === 0) continue;
    const summaries = summarizeNegativeBlockRows(rows);
    console.log(`\n=== Trial ${trial.id} — ${trial.title}`);
    for (const fixture of trial.fixtures) {
      for (const metric of [...trial.metrics, ...trial.collateral]) {
        const line: string[] = [];
        for (const arm of trial.arms) {
          const cell = summaries.find((s) => s.fixture === fixture.id && s.arm === arm.id);
          const m = cell?.metrics.find((entry) => entry.metric === metric);
          if (m === undefined || m.n === 0) continue;
          line.push(`${arm.id} ${m.rate === null ? `mean ${m.mean?.toFixed(1) ?? "—"}` : `${m.yes}/${m.n} (${Math.round(m.rate * 100)}%)`}`);
        }
        if (line.length === 0) continue;
        const deltas = trial.arms
          .filter((arm) => arm.id !== "off")
          .map((arm) => {
            const delta = negativeBlockDelta(summaries, { trial: trial.id, fixture: fixture.id, metric, offArm: "off", onArm: arm.id });
            return delta === null ? null : `Δ${arm.id} ${(delta.delta * 100).toFixed(0)}pp`;
          })
          .filter((entry): entry is string => entry !== null);
        console.log(`  ${fixture.id}.${metric.padEnd(28)} ${line.join("  ")}${deltas.length > 0 ? `  ${deltas.join("  ")}` : ""}`);
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--report")) {
    await report();
    return;
  }
  const shouldRender = process.argv.includes("--render");
  const wanted = process.env["AB_TRIAL"];
  if (shouldRender && !hasReplicate()) throw new Error("REPLICATE_API_TOKEN is not set — --render has nothing to send to");
  if (shouldRender && wanted === undefined) {
    throw new Error("--render needs AB_TRIAL=<id> or AB_TRIAL=all — a full run is ~200 paid renders and should be chosen, not defaulted into");
  }
  const selected = TRIALS.filter((trial) => wanted === undefined || wanted === "all" || trial.id === wanted);
  if (selected.length === 0) throw new Error(`no trial named ${wanted ?? ""}`);
  for (const trial of selected) await runTrial(trial, shouldRender);
  if (!shouldRender) console.log("\nNothing was sent. Re-run with AB_TRIAL=<id> --render to spend.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
