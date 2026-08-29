import "dotenv/config";
import { emptyImageModelAdvancedCapabilities, type ImageModel } from "@vesper/image-core";
import { hasReplicate } from "@/server/ai";
import { type NegativeBlockTrial, type NegativeTrialProgram, reportTrials, runTrial } from "./negative-trial-harness";

/**
 * Per-block negative-prompt induction trials for Qwen Image 2512, for the
 * negative transport promotion.
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
 * The 2026-08-19 verdict: A and A2 failed 16/16 — this endpoint ignores its
 * negative field on both sampling paths, so trials C–I are VOID here. They stay
 * defined because their fixtures and metrics are endpoint-neutral: the day an
 * endpoint passes its canary (`negative-field-canary.ts`), its block trials are
 * these definitions with per-endpoint arms.
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
const OUT_ROOT = process.env["AB_OUT"] ?? "eval-images/qwen-negative-blocks";
const SEED_BASE = Number(process.env["AB_SEED_BASE"] ?? 101);

// ---------------------------------------------------------------------------
// Trial definitions
// ---------------------------------------------------------------------------

const ANTI_SUPPORT = "mannequin, dress form, torso, bust, human body, visible support structure, hanger";

/**
 * The two ways an exclusion can reach an endpoint that ignores its negative
 * field, per the plan's transport vocabulary.
 *
 * `AFFIRMATIVE` is the plan's default: say what the picture SHOULD contain and
 * let the unwanted thing have no room, never naming it. `INLINE` names it inside
 * an instruction, which the plan permits only after a fixed A/B wins — so these
 * two are arms of that A/B, not settled wordings.
 */
const SUPPORT_AFFIRMATIVE =
  "The garment floats freely in empty space, held in its own shape by nothing at all, with clear empty background visible all around and through it.";
/**
 * What the item lane compiles TODAY for these two rows, verbatim.
 *
 * The control arm, and now FROZEN HISTORY: its "invisible ghost mannequin" clause
 * was the defect, naming the mannequin is what put one in the picture, and the
 * item lane was reworded on this trial's evidence. The text stays verbatim so the
 * measured before/after remains reproducible — do not update it to match the
 * current lane, or the comparison it exists for stops meaning anything.
 */
const PRODUCTION_SCARF =
  "No people are present anywhere in the frame. A product photograph of Silk gauze scarf. Presented on an invisible ghost mannequin, holding the garment's own shape. A long scarf of loosely woven silk gauze. Coloured pale rose. Made of sheer, semi-transparent fabric. Rendered as a photograph, with real optics and natural surface detail. Studio lighting with soft shadows. A seamless light-grey background. Centred composition. Sharp focus and high detail. E-commerce catalogue product photography.";
const PRODUCTION_COAT =
  "No people are present anywhere in the frame. A product photograph of Canvas work coat. Presented on an invisible ghost mannequin, holding the garment's own shape. A heavy waxed-canvas work coat, scorched at both cuffs. Made of dull olive canvas with a waxy sheen. Coloured olive drab. Outerwear. Rendered as a photograph, with real optics and natural surface detail. Studio lighting with soft shadows. A seamless light-grey background. Centred composition. Sharp focus and high detail. E-commerce catalogue product photography.";

const SUPPORT_INLINE =
  "Do not include a mannequin, dress form, torso, bust, hanger, stand, or any other visible means of support.";

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
    id: "A2",
    title: "Transport canary — go_fast off",
    block: "none — instrumentation",
    failure: "is the negative field applied only on the non-accelerated sampling path",
    // Accelerated/distilled sampling classically skips negative conditioning.
    // Production sends go_fast: true, so if the field works ONLY here, it is
    // inert in production configuration — which is the actual Stage 6 answer.
    providerControls: { go_fast: false },
    seeds: 6,
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
    id: "A3",
    title: "Transport canary — go_fast off, high guidance",
    block: "none — instrumentation",
    failure: "does negative conditioning appear only at high guidance",
    providerControls: { go_fast: false, guidance: 9 },
    seeds: 6,
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
    title: "Garment support — sheer scarf, positive-side transports",
    block: "support suppression, as positive replacement vs inline exclusion",
    failure: "a mannequin/dress form/support appears in a garment-only product shot",
    seeds: 6,
    // Three POSITIVE prompts, no negative field anywhere: this endpoint ignores
    // it (trials A/A2), so the only channels left are the two the plan's
    // transport vocabulary offers for such an endpoint. `neutral` is the
    // baseline that measures how often the failure happens unprompted, and it
    // doubles as the candidate rewording for the shipped ghost-mannequin defect.
    fixtures: [
      {
        id: "scarf",
        positive:
          "A pale rose sheer silk gauze scarf, isolated studio product photograph against a light neutral background. The scarf is softly draped as if suspended naturally, with its translucency and loosely woven texture clearly visible. Garment only.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "production", negative: null, positiveOverride: PRODUCTION_SCARF },
      { id: "neutral", negative: null },
      { id: "affirmative", negative: null, positiveSuffix: SUPPORT_AFFIRMATIVE },
      { id: "inline", negative: null, positiveSuffix: SUPPORT_INLINE },
    ],
    metrics: ["support_visible", "hanger_visible", "garment_alone"],
    collateral: ["translucency_preserved", "too_opaque", "drape_1_5"],
  },
  {
    id: "B2",
    title: "Garment support — work coat, positive-side transports",
    block: "support suppression, as positive replacement vs inline exclusion",
    failure: "a mannequin/dress form/support appears; or removing it collapses the garment's shape",
    seeds: 6,
    fixtures: [
      {
        id: "coat",
        positive:
          "A heavy olive waxed-canvas work coat with visibly scorched cuffs, isolated studio product photograph against a plain light background. Front view, sleeves hanging naturally, garment only.",
        aspect: "1:1",
      },
    ],
    arms: [
      { id: "production", negative: null, positiveOverride: PRODUCTION_COAT },
      { id: "neutral", negative: null },
      { id: "affirmative", negative: null, positiveSuffix: SUPPORT_AFFIRMATIVE },
      { id: "inline", negative: null, positiveSuffix: SUPPORT_INLINE },
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

// ---------------------------------------------------------------------------
// Endpoint
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

const PROGRAM: NegativeTrialProgram = {
  endpoint: {
    key: "qwen-2512",
    model: trialModel,
    negativeField: "negative_prompt",
    sendAspect: true,
    fileExt: "webp",
  },
  outRoot: OUT_ROOT,
  seedBase: SEED_BASE,
  trials: TRIALS,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("--report")) {
    await reportTrials(PROGRAM);
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
  for (const trial of selected) await runTrial(PROGRAM, trial, shouldRender);
  if (!shouldRender) console.log("\nNothing was sent. Re-run with AB_TRIAL=<id> --render to spend.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
