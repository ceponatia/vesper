import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { ViewerBodyPartId } from "@/contracts/images/viewer-body";
import { SCENE_COMPOSER_MODELS } from "@/lib/composer-models";
import { generateChecked, type GenerateCheckedOptions, isDemoMode } from "@/server/ai";
import {
  buildSceneComposerPrompt,
  type SceneComposerContext,
  sceneComposerSystem,
  type SceneSpec,
  sceneSpecSchema,
} from "@/server/images";
import { type Beat, BEATS } from "./orientation-ab";
import { type ComposerExpectation, gradeComposer, UNSCORED_CHECKS } from "./composer-model-score";

/**
 * Composer-model A/B (composer-model.plan.md, NOT a test gate).
 *
 * The scene composer — the text model that turns chat state into the structured spec every
 * scene render is built from — runs on Aion 3.0. It is the most permissive model in the
 * curated set and by a wide margin the slowest and priciest: $3/$6 per M against DeepSeek 4
 * Flash's $0.0675/$0.135, and the AionLabs endpoint MANDATES reasoning
 * (`reasoning:{enabled:false}` is rejected there), so every composition silently pays for a
 * reasoning trace nothing reads. Owner report 2026-08-15: it is "extremely slow".
 *
 * This probe answers the only question that matters before moving it: **does a fast, cheap
 * model compose the same shot, on the beats that carry intimate language?** The four
 * acceptance beats are the ones a cautious model fails — it reads the most explicit stretch
 * of a chat and answers with vague poses, which is a grounding failure before it is a
 * moderation one (owner ruling 2026-08-10).
 *
 * ## What is actually measured
 *
 * Every arm is asked the REAL question: `sceneComposerSystem(embodied)`, the real
 * `buildSceneComposerPrompt` output, the real `sceneSpecSchema`, through the real
 * `generateChecked` — so a difference here is a difference production would see. The answer
 * is graded by `composer-model-score.ts`, which resolves the spec through the production
 * `resolveScenePlan`: the camera ids, the staging id, the verbatim evidence gates, the
 * roster clamps and the skin-colour scrub are the app's own, never a paraphrase.
 *
 * Alongside the grade it records **measured** latency and **measured** dollars — OpenRouter's
 * usage accounting, not an estimate from a price table — because "fast and cheap" is the
 * entire motivation and an estimate would be the one number nobody could check.
 *
 * ## Beats
 *
 * Imported from `orientation-ab.ts`, never restated: two probes disagreeing about what
 * "doggy" is would make their gradings incomparable (the same rule `intimate-model-ab.ts`
 * follows). Three orientation beats — `behind`, `glance`, `kneel` — plus the four intimate
 * acceptance scenes: `doggy`, `oral`, `oral_guided`, `missionary`.
 *
 * The beat's own `spec` is NOT used as the answer key: for the intimate beats it is
 * deliberately written in the cautious register the composer really produces, because there
 * it plays the `old` arm of an image A/B. What IS the answer key is the beat's `camera` and
 * `staging` — the shot the story establishes — restated as {@link ComposerExpectation}s below
 * and derived from the imported beat wherever it can be.
 *
 * Text is cheap: the full matrix (8 arms × 7 beats × 2 runs) costs well under $2, dominated
 * almost entirely by the Aion 3.0 control.
 *
 * ```
 * pnpm tsx scripts/eval/scene-images/composer-model-ab.ts
 * AB_BEAT=doggy AB_RUNS=3 pnpm tsx scripts/eval/scene-images/composer-model-ab.ts
 * AB_ARMS=aion3,dsflash-off pnpm tsx scripts/eval/scene-images/composer-model-ab.ts
 * EVAL_OUT=/tmp/composer-ab pnpm tsx scripts/eval/scene-images/composer-model-ab.ts
 * ```
 */

const OUT = process.env.EVAL_OUT ?? "data/eval/composer-model-ab";
const RUNS_PER_ARM = Number(process.env.AB_RUNS ?? 2);
const BEAT_FILTER = process.env.AB_BEAT ?? "all";
const ARM_FILTER = process.env.AB_ARMS ?? "all";

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

/**
 * The OpenRouter knob bag, DERIVED from `generateChecked` rather than restated: this script
 * is a root-workspace file and cannot import the `ai` package's `JSONValue` (that dependency
 * belongs to `apps/web`), and a hand-written copy would silently drift from the call it feeds.
 */
type ComposerProviderOptions = NonNullable<GenerateCheckedOptions<unknown>["providerOptions"]>["openrouter"];

interface Arm {
  /** Short id for `AB_ARMS` and the result tables. */
  key: string;
  modelId: string;
  label: string;
  /** OpenRouter `reasoning:{enabled:false}`. */
  disableReasoning?: boolean;
  /** Any other per-call OpenRouter knob (the `low` reasoning arm's `effort`). */
  openrouter?: ComposerProviderOptions;
}

/**
 * The candidate set (owner selection 2026-08-15): the cheap flash tier plus the cheaper
 * models from the control's own lab, with Aion 3.0 as the control every row is read against.
 *
 * DeepSeek 4 Flash appears TWICE by owner ask — reasoning off and reasoning low. They are
 * genuinely different products here: the composer's job is a short structured extraction over
 * a transcript, so reasoning may buy nothing but latency, and the only way to know is to pay
 * for both. `~deepseek/…-latest` is the floating alias the repo already pins the agent lane to.
 *
 * Aion 2.0 advertises no structured-output support, and that is fine: `generateChecked` sends
 * the JSON Schema as TEXT and parses the reply locally (constrained decoding was rejected —
 * followups.phase2.md #20), so nothing in this call needs `tools` or `response_format`.
 */
const ARMS: readonly Arm[] = [
  { key: "aion3", modelId: "aion-labs/aion-3.0", label: "Aion 3.0 (control)" },
  { key: "aion3mini", modelId: "aion-labs/aion-3.0-mini", label: "Aion 3.0 Mini" },
  { key: "aion2", modelId: "aion-labs/aion-2.0", label: "Aion 2.0" },
  {
    key: "dsflash-off",
    modelId: "~deepseek/deepseek-v4-flash-latest",
    label: "DeepSeek 4 Flash (no reasoning)",
    disableReasoning: true,
  },
  {
    key: "dsflash-low",
    modelId: "~deepseek/deepseek-v4-flash-latest",
    label: "DeepSeek 4 Flash (low reasoning)",
    openrouter: { reasoning: { effort: "low" } },
  },
  { key: "qwen37flash", modelId: "qwen/qwen3.7-flash", label: "Qwen3.7 Flash" },
  { key: "glm47flash", modelId: "z-ai/glm-4.7-flash", label: "GLM 4.7 Flash" },
  { key: "ling3flash", modelId: "inclusionai/ling-3.0-flash", label: "Ling 3.0 Flash" },
] as const;

/** The arm whose numbers every other row is a ratio of. Absent ⇒ the run proves nothing. */
const CONTROL_ARM = "aion3";

// ---------------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------------

/**
 * The viewer parts each beat's narration actually grounds — the ONE part of the answer key
 * that cannot be derived from the imported beat, since `Beat` carries the render-side staging
 * rather than what the composer should have proposed.
 *
 * The oral beats are deliberately `[]` even though their narration says "your hand comes to
 * rest on the top of her head": `kneeling_before_viewer_guided` supplies that hand from the
 * registry, and the shipped fixture spec proposes no part. Requiring one would grade the arms
 * against an expectation the reference answer itself does not meet. Nothing is lost — a part
 * proposed WITHOUT a real quote still fails `groundedParts` on every beat.
 */
const EXPECTED_VIEWER_BODY: Readonly<Record<string, readonly ViewerBodyPartId[]>> = {
  behind: [],
  glance: [],
  kneel: [],
  // "your hands settle on her hips" — quoted verbatim in the beat's narration.
  doggy: ["hands"],
  oral: [],
  oral_guided: [],
  // "your hands close around her thighs".
  missionary: ["hands"],
};

/**
 * Derived from the beat wherever possible, so this probe and the render A/B cannot drift
 * about what a beat is. The camera is graded ONLY on unstaged beats: a surviving staging's
 * camera replaces the composer's in `resolveScenePlan`, so grading it elsewhere would grade
 * the registry.
 */
function expectationFor(beatId: string, beat: Beat): ComposerExpectation {
  const focalName = beat.context.present[0]?.name;
  if (!focalName) throw new Error(`beat "${beatId}" has an empty roster — nothing to compose`);
  const viewerBody = EXPECTED_VIEWER_BODY[beatId];
  if (!viewerBody) {
    throw new Error(
      `beat "${beatId}" has no EXPECTED_VIEWER_BODY entry — orientation-ab.ts added a beat this probe has no answer key for`,
    );
  }
  return {
    focalName,
    viewerBody,
    ...(beat.staging ? { stagingId: beat.staging.id } : { camera: beat.camera }),
  };
}

// ---------------------------------------------------------------------------
// Honesty checks
// ---------------------------------------------------------------------------

/**
 * Refuse to pay for a run whose grader cannot be satisfied.
 *
 * Builds the IDEAL answer for each beat — the beat's own evidence quotes, its camera and
 * staging, its grounded viewer parts, and concrete prose — and asserts it grades 1.0. If the
 * perfect spec cannot score perfectly, the answer key and the pipeline have drifted and every
 * arm would be marked down for the harness's mistake. That is a broken instrument, not a
 * model finding, and it costs nothing to catch before the first call.
 */
function assertGraderIsSatisfiable(beatId: string, beat: Beat, expectation: ComposerExpectation): void {
  const ideal = sceneSpecSchema.parse({
    ...beat.spec,
    focalCharacter: expectation.focalName,
    // The intimate beats' shipped pose/activity are the CAUTIOUS register on purpose (they
    // play the `old` arm of the render A/B), which the vagueness check is built to fail.
    // Substituting concrete prose is what makes this an ideal answer rather than the fixture.
    pose: "kneeling upright with her weight back on her heels, chin lifted toward the viewer",
    activity: "reaching out with her right hand, breath shallow",
    ...(expectation.viewerBody.length > 0
      ? {
          viewerBody: expectation.viewerBody,
          viewerBodyEvidence: beat.spec.viewerBodyEvidence,
        }
      : {}),
  });
  const grade = gradeComposer({
    spec: ideal,
    degraded: false,
    context: beat.context,
    expectation,
    sink: new DiagnosticCollector(),
  });
  if (grade.score < 1) {
    const failed = Object.entries(grade.checks)
      .filter(([, value]) => value === false)
      .map(([name]) => name);
    throw new Error(
      `the answer key for beat "${beatId}" is unsatisfiable — the IDEAL spec fails: ${failed.join(", ")}. ` +
        `Diagnostics: ${grade.diagnosticCodes.join(", ") || "none"}. Fix the expectation or the fixture before paying for a run.`,
    );
  }
}

/** Refuse an arm set that cannot answer the question this probe exists to ask. */
function assertArmsAreComparable(arms: readonly Arm[]): void {
  if (arms.length < 2) {
    throw new Error(`an A/B needs at least two arms — got ${arms.length}. Widen AB_ARMS.`);
  }
  if (!arms.some((arm) => arm.key === CONTROL_ARM)) {
    throw new Error(
      `the "${CONTROL_ARM}" control is not in this run — every result here is a comparison against the shipped default, so without it the numbers rank arms against nothing. Add it to AB_ARMS.`,
    );
  }
  const curated = new Set(SCENE_COMPOSER_MODELS.map((option) => option.id));
  const uncurated = arms.filter((arm) => !curated.has(arm.modelId));
  if (uncurated.length > 0) {
    // A warning, not a throw: probing a model BEFORE curating it is the whole point of a
    // probe, and the curated list's own doc comment says an id earns its place by being run
    // here. The noise exists so a permanent divergence gets noticed.
    console.warn(
      `note: ${uncurated.map((arm) => arm.modelId).join(", ")} ${uncurated.length === 1 ? "is" : "are"} not in SCENE_COMPOSER_MODELS — probing an uncurated candidate.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface RunResult {
  beat: string;
  arm: string;
  run: number;
  score: number;
  answered: boolean;
  checks: Record<string, boolean | null>;
  latencyMs: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  repaired: boolean;
  diagnosticCodes: string[];
  prose: string;
  spec: SceneSpec | null;
}

async function runOnce(beatId: string, beat: Beat, arm: Arm, run: number): Promise<RunResult> {
  const context: SceneComposerContext = beat.context;
  const sink = new DiagnosticCollector();
  const result = await generateChecked({
    schema: sceneSpecSchema,
    system: sceneComposerSystem(context.embodiedViewer === true),
    prompt: buildSceneComposerPrompt(context),
    code: "images.scene_composer",
    sink,
    modelId: arm.modelId,
    // The measured half of the motivation. Token counts come back either way; the dollar
    // figure only with this on, and an estimate is the one number nobody could check.
    usageAccounting: true,
    ...(arm.disableReasoning ? { disableReasoning: true } : {}),
    ...(arm.openrouter ? { providerOptions: { openrouter: arm.openrouter } } : {}),
  });

  // A FRESH sink for the grade: the call's own diagnostics (`.repaired`, `.api_error`) are a
  // different question from the resolver's clamps, and mixing them would let a repaired call
  // read as an ungrounded proposal.
  const gradeSink = new DiagnosticCollector();
  const grade = gradeComposer({
    spec: result.value,
    degraded: result.degraded,
    context,
    expectation: expectationFor(beatId, beat),
    sink: gradeSink,
  });

  return {
    beat: beatId,
    arm: arm.key,
    run,
    score: grade.score,
    answered: grade.checks.answered,
    checks: { ...grade.checks },
    latencyMs: result.latencyMs ?? null,
    costUsd: result.costUsd ?? null,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    repaired: sink.items.some((item) => item.code === "images.scene_composer.repaired"),
    // Both sinks: the call's failure codes AND the resolver's clamps are both evidence.
    diagnosticCodes: [...sink.items.map((item) => item.code), ...grade.diagnosticCodes],
    prose: grade.prose,
    spec: result.value,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Percentile over a sorted copy; null when nothing was measured (unknown is never zero). */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? null;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const ms = (n: number | null): string => (n === null ? "  —  " : `${(n / 1000).toFixed(1)}s`);

interface ArmSummary {
  arm: Arm;
  runs: number;
  answered: number;
  meanScore: number;
  perfect: number;
  repaired: number;
  p50: number | null;
  p95: number | null;
  costUsd: number | null;
  /** Dollars per 1000 compositions at this arm's measured average — the number a deploy is decided on. */
  costPerThousand: number | null;
}

function summarize(arm: Arm, rows: readonly RunResult[]): ArmSummary {
  const latencies = rows.map((row) => row.latencyMs).filter((value): value is number => value !== null);
  const costs = rows.map((row) => row.costUsd).filter((value): value is number => value !== null);
  const totalCost = costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null;
  return {
    arm,
    runs: rows.length,
    answered: rows.filter((row) => row.answered).length,
    meanScore: rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
    perfect: rows.filter((row) => row.score === 1).length,
    repaired: rows.filter((row) => row.repaired).length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    costUsd: totalCost,
    costPerThousand: totalCost === null || costs.length === 0 ? null : (totalCost / costs.length) * 1000,
  };
}

function printSummary(summaries: readonly ArmSummary[]): void {
  const control = summaries.find((summary) => summary.arm.key === CONTROL_ARM);
  console.log(`\n${"=".repeat(104)}`);
  console.log("SUMMARY — mean score, refusals, latency, measured cost. Ratios are against the control.");
  console.log("=".repeat(104));
  console.log(
    ["arm".padEnd(16), "score".padStart(6), "answered".padStart(9), "perfect".padStart(8), "repair".padStart(7), "p50".padStart(7), "p95".padStart(7), "$/1k".padStart(9), "vs ctl".padStart(8)].join(" "),
  );
  for (const summary of summaries) {
    const speedup =
      control?.p50 && summary.p50 ? `${(control.p50 / summary.p50).toFixed(1)}× fast` : "     —  ";
    console.log(
      [
        summary.arm.key.padEnd(16),
        pct(summary.meanScore).padStart(6),
        `${summary.answered}/${summary.runs}`.padStart(9),
        `${summary.perfect}/${summary.runs}`.padStart(8),
        `${summary.repaired}`.padStart(7),
        ms(summary.p50).padStart(7),
        ms(summary.p95).padStart(7),
        (summary.costPerThousand === null ? "—" : `$${summary.costPerThousand.toFixed(2)}`).padStart(9),
        speedup.padStart(8),
      ].join(" "),
    );
  }
  if (control?.costPerThousand) {
    console.log(`\nControl costs $${control.costPerThousand.toFixed(2)} per 1000 compositions.`);
    for (const summary of summaries) {
      if (summary.arm.key === CONTROL_ARM || !summary.costPerThousand) continue;
      console.log(
        `  ${summary.arm.key.padEnd(16)} ${(control.costPerThousand / summary.costPerThousand).toFixed(0)}× cheaper ($${summary.costPerThousand.toFixed(3)})`,
      );
    }
  }
}

/** Per-beat detail — which axis each arm actually lost, which is what a verdict is written from. */
function printBeatDetail(beatId: string, rows: readonly RunResult[]): void {
  console.log(`\n--- ${beatId} ---`);
  for (const row of rows) {
    // Split by whether the axis moves the score. A framing miss is worth seeing and is NOT a
    // failure — printing the two in one list is what made the 2026-08-15 run read as though
    // every model was broken at the camera, when the scored axes were largely right.
    const unscored: readonly string[] = UNSCORED_CHECKS;
    const missed = Object.entries(row.checks).filter(([, value]) => value === false);
    const failed = missed.filter(([name]) => !unscored.includes(name)).map(([name]) => name);
    const framing = missed.filter(([name]) => unscored.includes(name)).map(([name]) => name);
    const verdict = !row.answered ? "REFUSED/DEGRADED" : failed.length === 0 ? "pass" : `fail: ${failed.join(", ")}`;
    const framingNote = framing.length > 0 ? `  (framing: ${framing.join(", ")})` : "";
    console.log(
      `  ${row.arm.padEnd(16)} run ${row.run}  ${pct(row.score).padStart(4)}  ${ms(row.latencyMs)}  ${verdict}${framingNote}`,
    );
    if (row.prose) console.log(`      prose: ${row.prose}`);
    if (row.spec?.staging?.id) console.log(`      staging: ${row.spec.staging.id} ← "${row.spec.staging.evidence}"`);
    if (row.spec?.camera) {
      const cam = row.spec.camera;
      console.log(`      camera: ${cam.orientation}/${cam.distance}/${cam.height}${cam.evidence ? ` ← "${cam.evidence}"` : ""}`);
    }
    if (row.spec && row.spec.viewerBody.length > 0) console.log(`      viewerBody: ${row.spec.viewerBody.join(", ")}`);
    const notable = row.diagnosticCodes.filter((code) => !code.endsWith("present_character_added"));
    if (notable.length > 0) console.log(`      diagnostics: ${[...new Set(notable)].join(", ")}`);
  }
}

/** CSV for the results table a verdict gets written from; one row per (beat, arm, run). */
function toCsv(rows: readonly RunResult[]): string {
  const checkNames = Object.keys(rows[0]?.checks ?? {});
  const header = ["beat", "arm", "run", "score", "latency_ms", "cost_usd", "input_tokens", "output_tokens", "repaired", ...checkNames, "prose"];
  const lines = rows.map((row) =>
    [
      row.beat,
      row.arm,
      String(row.run),
      row.score.toFixed(3),
      row.latencyMs === null ? "" : String(row.latencyMs),
      row.costUsd === null ? "" : row.costUsd.toFixed(6),
      row.inputTokens === null ? "" : String(row.inputTokens),
      row.outputTokens === null ? "" : String(row.outputTokens),
      String(row.repaired),
      ...checkNames.map((name) => (row.checks[name] === null ? "" : String(row.checks[name]))),
      `"${row.prose.replaceAll('"', '""')}"`,
    ].join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

async function main(): Promise<void> {
  const beatIds = BEAT_FILTER === "all" ? [...BEATS.keys()] : BEAT_FILTER.split(",").map((id) => id.trim());
  const arms = ARM_FILTER === "all" ? ARMS : ARMS.filter((arm) => ARM_FILTER.split(",").map((k) => k.trim()).includes(arm.key));
  assertArmsAreComparable(arms);

  // Every beat built and every answer key checked BEFORE the first call: a broken fixture
  // should fail the run it belongs to, not halfway through a paid matrix.
  const beats = new Map<string, Beat>();
  for (const beatId of beatIds) {
    const build = BEATS.get(beatId);
    if (!build) throw new Error(`unknown beat "${beatId}" — have: ${[...BEATS.keys()].join(", ")}`);
    const beat = build();
    assertGraderIsSatisfiable(beatId, beat, expectationFor(beatId, beat));
    beats.set(beatId, beat);
  }

  console.log(`\nComposer-model A/B — ${arms.length} arms × ${beats.size} beats × ${RUNS_PER_ARM} runs = ${arms.length * beats.size * RUNS_PER_ARM} calls`);
  console.log(`Arms:  ${arms.map((arm) => `${arm.key} (${arm.modelId})`).join("\n       ")}`);
  console.log(`Beats: ${[...beats.keys()].join(", ")}`);
  console.log("Answer keys verified satisfiable against the production resolver.\n");

  if (isDemoMode()) {
    console.log(
      "OPENROUTER_API_KEY not set (or AI_FAKE=1) — every call would degrade by design, so nothing would be measured. Prompts below; no calls made.",
    );
    for (const [beatId, beat] of beats) {
      console.log(`\n=== ${beatId} — ${beat.summary} ===`);
      console.log(`--- system ---\n${sceneComposerSystem(beat.context.embodiedViewer === true)}`);
      console.log(`--- prompt ---\n${buildSceneComposerPrompt(beat.context)}`);
    }
    return;
  }

  const rows: RunResult[] = [];
  for (const [beatId, beat] of beats) {
    const beatRows: RunResult[] = [];
    for (const arm of arms) {
      for (let run = 1; run <= RUNS_PER_ARM; run += 1) {
        const row = await runOnce(beatId, beat, arm, run);
        beatRows.push(row);
        rows.push(row);
      }
    }
    printBeatDetail(beatId, beatRows);
  }

  printSummary(arms.map((arm) => summarize(arm, rows.filter((row) => row.arm === arm.key))));

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
  await fs.writeFile(path.join(OUT, "results.csv"), toCsv(rows));
  console.log(`\nWrote ${rows.length} rows → ${path.join(OUT, "results.csv")} (+ results.json with every spec)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
