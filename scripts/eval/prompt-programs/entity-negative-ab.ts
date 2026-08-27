import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import {
  activeImagePromptBinding,
  buildImageWorldDigest,
  chooseAspect,
  compileImagePromptProgram,
  emptyImageModelAdvancedCapabilities,
  imageNegativePack,
  imagePositivePack,
  imagePromptBudgetFromBinding,
  parseAspectValue,
  type ImageModel,
  type ImageWorldDigest,
} from "@vesper/image-core";
import { hasReplicate, replicateClient } from "@/server/ai";
import {
  entityReadToken,
  itemImageOperation,
  itemSourceRevision,
  locationImageOperation,
  locationSourceRevision,
  projectItemDigest,
  projectLocationDigest,
  type ItemProjectionInput,
  type LocationProjectionInput,
} from "@/contracts/images/entity-digest";

/**
 * The pinned item/location trial for Qwen Image 2512's negative transport
 * promotion.
 *
 * Stage 5 is done: the item and location lanes compile guarded negative blocks,
 * lint them against world truth, and record a transport decision for each. Stage
 * 6 needs the one thing code cannot supply — evidence that SENDING those
 * exclusions makes a better picture on this endpoint than not sending them.
 *
 * ## The two arms
 *
 * Everything is held constant except `negativeFieldAvailable`, which is the exact
 * boundary a version probe crosses:
 *
 * - **off** — production today. The seeded `qwen/qwen-image-2512` row has empty
 *   `advancedCapabilities`, so the compiled exclusions are all recorded with a
 *   `dropped` transport and no `negative_prompt` key is invented.
 * - **on** — production after the row's version is probed and activated. The same
 *   compile, the same packs, the same world, and the exclusions travel.
 *
 * The positive prompt is byte-identical across the arms by construction; the
 * script asserts that before spending anything, because an A/B whose arms differ
 * in two places measures neither.
 *
 * ## Why this does not touch production
 *
 * The arm is chosen by a local model literal, not by the database. Probing the
 * production row would repin the version for FOUR seeded profiles — including
 * `portrait-standard` and the two curated portrait profiles, whose `steps` and
 * `go_fast` settings are inert only while the row is unprobed — so the evidence
 * has to come first and the activation second.
 *
 * ## Running it
 *
 * ```
 * pnpm tsx scripts/eval/prompt-programs/entity-negative-ab.ts            # free: prints both arms
 * pnpm tsx scripts/eval/prompt-programs/entity-negative-ab.ts --render   # PAID
 * AB_CASE=lettered_sign AB_SEED=7 ... --render                           # one case
 * ```
 *
 * Without `--render` nothing is sent and nothing costs anything, which is the
 * house idiom: the wording is reviewable for free and only the pictures are paid.
 */

const SLUG = "qwen/qwen-image-2512";
const OUT_DEFAULT = "screenshots/entity-negative-ab";

/** The seed every cell holds, so the two arms differ only in the negative field. */
const DEFAULT_SEED = 20_260_819;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Six fixed rows, chosen for what each one asks the negative channel to decide
 * rather than for variety.
 *
 * `lettered_sign` and `shop_front` are the collision cases and the reason this
 * trial is worth running rather than reasoning about: both name lettering in
 * authored prose, and neither has a projection that turns that into a protected
 * claim, so today's compile sends the text exclusions anyway. Whether the model
 * then refuses to draw the words is the question the pictures answer.
 */
const ITEM_CASES: readonly { readonly id: string; readonly row: ItemProjectionInput }[] = [
  {
    id: "plain_object",
    row: {
      id: "trial_item_compass",
      name: "Brass pocket compass",
      kind: "object",
      description: "A scuffed brass pocket compass with a hinged lid and a worn leather lanyard.",
      appearance: "tarnished brass, warm and slightly pitted",
      colorShade: "antique brass",
      revision: "trial",
    },
  },
  {
    id: "garment",
    row: {
      id: "trial_item_coat",
      name: "Canvas work coat",
      kind: "clothing",
      description: "A heavy waxed-canvas work coat, scorched at both cuffs.",
      appearance: "dull olive canvas with a waxy sheen",
      colorShade: "olive drab",
      subtype: "outerwear",
      revision: "trial",
    },
  },
  {
    id: "sheer_garment",
    row: {
      id: "trial_item_scarf",
      name: "Silk gauze scarf",
      kind: "clothing",
      description: "A long scarf of loosely woven silk gauze.",
      colorShade: "pale rose",
      opacity: "sheer",
      revision: "trial",
    },
  },
  {
    id: "lettered_sign",
    row: {
      id: "trial_item_plate",
      name: "Enamel door plate",
      kind: "object",
      // The collision case. `EXIT` is authored truth the render must spell, and
      // no item field projects into `item.marking`, so nothing protects `text`.
      description: 'A white enamel door plate with the word "EXIT" in black capitals.',
      appearance: "chipped white enamel over pressed steel",
      revision: "trial",
    },
  },
];

const LOCATION_CASES: readonly { readonly id: string; readonly row: LocationProjectionInput }[] = [
  {
    id: "interior",
    row: {
      id: "trial_loc_glassworks",
      name: "The Glassworks",
      scale: "hall",
      description: "A working glasshouse: banked kilns, steel benches, racks of cooling stock, rain on the skylights.",
      light: "low orange kiln-glow under grey daylight",
      revision: "trial",
    },
  },
  {
    id: "outdoor",
    row: {
      id: "trial_loc_flats",
      name: "Tidal Flats",
      scale: "expanse",
      description: "Miles of wet sand under a low sun, channels braiding out to a distant grey sea.",
      light: "low raking sun",
      revision: "trial",
    },
  },
  {
    id: "shop_front",
    row: {
      id: "trial_loc_shop",
      name: "Aldwin's Apothecary",
      scale: "room",
      // The second collision case, reached from the location side:
      // `location.signage` has no producer either.
      description: 'A cramped apothecary, its front window painted with the words "ALDWIN & SON" in gold leaf.',
      light: "warm lamplight",
      revision: "trial",
    },
  },
];

interface Cell {
  readonly id: string;
  readonly kind: "item" | "location";
  /** What the lane ASKS for. What the row can offer is negotiated at render time. */
  readonly requestedAspect: `${number}:${number}`;
  readonly digest: ImageWorldDigest;
}

function cells(): readonly Cell[] {
  const items = ITEM_CASES.map((entry): Cell => {
    const revisions = [itemSourceRevision(entry.row)];
    return {
      id: entry.id,
      kind: "item",
      requestedAspect: "1:1",
      digest: buildImageWorldDigest({
        read: { kind: "transactional_projection", token: entityReadToken(revisions) },
        items: [projectItemDigest(entry.row)],
        operation: itemImageOperation(),
        sourceRevisions: revisions,
      }).digest,
    };
  });
  const locations = LOCATION_CASES.map((entry): Cell => {
    const revisions = [locationSourceRevision(entry.row)];
    return {
      id: entry.id,
      kind: "location",
      requestedAspect: "3:2",
      digest: buildImageWorldDigest({
        read: { kind: "transactional_projection", token: entityReadToken(revisions) },
        location: projectLocationDigest(entry.row),
        operation: locationImageOperation(entry.row.scale),
        sourceRevisions: revisions,
      }).digest,
    };
  });
  return [...items, ...locations];
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface Arm {
  readonly positive: string;
  readonly negative: string | null;
  readonly delivered: readonly string[];
  readonly dropped: readonly { readonly id: string; readonly reason: string }[];
}

function compile(cell: Cell, negativeFieldAvailable: boolean): Arm {
  const binding = activeImagePromptBinding({ modelSlug: SLUG, task: cell.kind });
  if (binding === null) throw new Error(`no active binding for ${SLUG} / ${cell.kind}`);
  const positivePack = imagePositivePack(binding.positivePackVersionId);
  const negativePack = imageNegativePack(binding.negativePackVersionId);
  if (positivePack === null || negativePack === null) throw new Error(`bound packs missing for ${binding.id}`);

  const result = compileImagePromptProgram({
    digest: cell.digest,
    binding,
    positivePack,
    negativePack,
    references: [],
    // The seeded 2512 row declares no measured prompt budget, so this is the
    // same empty budget the production lane compiles under.
    budget: imagePromptBudgetFromBinding(undefined),
    negativeFieldAvailable,
    refuseOnMissingRequired: false,
  });
  if (!result.ok) throw new Error(`${cell.id}: ${result.refusal.code} — ${result.refusal.message}`);
  return {
    positive: result.compiled.positiveText,
    negative: result.compiled.negativeText,
    delivered: result.compiled.program.deliveredNegativeIds,
    dropped: result.compiled.transports
      .filter((entry) => entry.transport.kind === "dropped")
      .map((entry) => ({
        id: entry.constraintId,
        reason: entry.transport.kind === "dropped" ? entry.transport.reason : "",
      })),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The 2512 row as the seed writes it, plus the ONE thing this trial adds: the
 * `negative_prompt` binding a probe would write.
 *
 * Stated locally rather than read from the database for the reason in the header —
 * the whole point is to get evidence before anything about production moves.
 */
function trialModel(negativeField: boolean): ImageModel {
  const capabilities = emptyImageModelAdvancedCapabilities();
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
    // Migration 0098's menu verbatim. Widening it here would let the trial render
    // shapes production cannot ask for.
    supportedAspects: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    outputFormat: "webp",
    extraInput: { output_quality: 95, go_fast: true, disable_safety_checker: true },
    probedVersionId: null,
    editKind: "img2img",
    identityPreservation: "weak",
    operatorWarning: null,
    advancedCapabilities: negativeField
      ? { ...capabilities, controls: { ...capabilities.controls, negativePrompt: { field: "negative_prompt", type: "string" } } }
      : capabilities,
    forPortrait: true,
    forVariant: false,
    forScene: false,
    builtin: true,
    sort: 0,
  } satisfies ImageModel;
}

async function render(cell: Cell, arm: Arm, seed: number): Promise<Buffer | null> {
  const model = trialModel(arm.negative !== null);
  const result = await replicateClient().runRegistryImageModel(model, {
    prompt: arm.positive,
    // Negotiated, not requested. The seeded row offers no 3:2, so a location
    // render lands on the nearest offered shape and the pipeline crops the
    // remainder — and evidence rendered at a shape production never sends would
    // be graded on the wrong picture.
    aspect: chooseAspect(model, parseAspectValue(cell.requestedAspect) ?? 1).value,
    // Already-mapped provider fields. The seed is what makes the two arms
    // comparable at all; the negative key rides here only when this arm has one,
    // so the "off" arm sends exactly what production sends today.
    controlInput: { seed, ...(arm.negative === null ? {} : { negative_prompt: arm.negative }) },
  });
  return result.ok && result.image ? result.image : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const shouldRender = process.argv.includes("--render");
  const only = process.env["AB_CASE"];
  const seed = Number(process.env["AB_SEED"] ?? DEFAULT_SEED);
  const out = process.env["AB_OUT"] ?? OUT_DEFAULT;
  const selected = cells().filter((cell) => only === undefined || cell.id === only);
  if (selected.length === 0) throw new Error(`no case named ${only ?? ""}`);

  const rows: string[] = [
    [
      "case",
      "kind",
      "negative_sent",
      "fact_adherence_1_5",
      "literal_text_1_5",
      "accidental_text_or_watermark_1_5",
      "composition_1_5",
      "style_1_5",
      "notes",
    ].join(","),
  ];

  for (const cell of selected) {
    const off = compile(cell, false);
    const on = compile(cell, true);
    // An A/B whose arms differ in two places measures neither. The positive text
    // is the constant; the negative field is the variable.
    if (off.positive !== on.positive) throw new Error(`${cell.id}: the arms disagree on the positive prompt`);
    if (off.delivered.length > 0) throw new Error(`${cell.id}: the off arm delivered exclusions it should have dropped`);

    const shape = chooseAspect(trialModel(true), parseAspectValue(cell.requestedAspect) ?? 1);
    console.log(
      `\n=== ${cell.id} (${cell.kind}, asks ${cell.requestedAspect}, renders ${shape.value ?? "model default"}${shape.needsCrop ? ", cropped" : ""}) ===`,
    );
    console.log(`POSITIVE  ${off.positive}`);
    console.log(`NEGATIVE  ${on.negative ?? "(none compiled)"}`);
    console.log(`DELIVERED ${on.delivered.join(", ") || "(none)"}`);
    for (const entry of on.dropped) console.log(`DROPPED   ${entry.id} — ${entry.reason}`);

    for (const arm of [
      { name: "off", program: off },
      { name: "on", program: on },
    ]) {
      rows.push(
        [cell.id, cell.kind, arm.name === "on" ? "yes" : "no", "", "", "", "", "", csvCell(arm.program.negative ?? "")].join(
          ",",
        ),
      );
    }

    if (!shouldRender) continue;
    if (!hasReplicate()) throw new Error("REPLICATE_API_TOKEN is not set — --render has nothing to send to");
    await fs.mkdir(out, { recursive: true });
    for (const arm of [
      { name: "off", program: off },
      { name: "on", program: on },
    ]) {
      const image = await render(cell, arm.program, seed);
      if (image === null) {
        console.log(`RENDER    ${cell.id}/${arm.name} — provider returned no image`);
        continue;
      }
      const file = path.join(out, `${cell.id}-${arm.name}.webp`);
      await fs.writeFile(file, image);
      console.log(`RENDER    ${file}`);
    }
  }

  await fs.mkdir(out, { recursive: true });
  const scores = path.join(out, "scores.csv");
  await fs.writeFile(scores, `${rows.join("\n")}\n`);
  console.log(`\nSCORES    ${scores}`);
  if (!shouldRender) console.log("Nothing was sent. Re-run with --render to spend.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
