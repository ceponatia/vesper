import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { isDemoMode } from "@/server/ai";
import { NARRATIVE_TEMPERATURE, streamCharacterChat } from "@/server/engine";
import { DEFAULT_CHARACTER_CHAT_MODEL_ID } from "@/lib/narrative-models";
import { EVAL_SCENARIOS, type EvalScenario } from "./fixtures";
import {
  AFFORDANCE_CUES_PER_EXCHANGE,
  armHistory,
  buildArmPrompt,
  cueDuplicatesPrompt,
  emptyAffordanceCueState,
  groundTruth,
  hairMentionCount,
  hairOverlap,
  hairSentences,
  readTurn,
  scenarioCharacter,
  stripCueBlock,
  stripCueCarveOut,
  turnAllowance,
  type ArmId,
} from "./harness";
import { judgeScenario, type JudgeVerdict } from "./judge";

/**
 * Slice-5 narrator trial runner (body-attribute-affordances.plan.md).
 *
 * Owner-gated LIVE MODEL comparison of the `CHAT_AFFORDANCE_CUES` cue path
 * against the current appearance-only path. See ./README.md for how to rerun it
 * and how to read the decision rule.
 *
 *   pnpm eval:affordance-cues --dry-run     # matrix + cue lines, no model calls
 *   pnpm eval:affordance-cues               # the full paired trial + judging
 *
 * The generator is the PRODUCTION chat narrator (`streamCharacterChat`, the chat
 * lane's default model) so the trial measures the real product path. The judge is
 * a cheaper strong model, blinded to which transcript came from which arm.
 */

const DEFAULT_OUT = process.env.EVAL_OUT || "data/eval/affordance-cues";
const DEFAULT_JUDGE_MODEL = "google/gemini-3.5-flash";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean;
  noJudge: boolean;
  scenario?: string;
  out: string;
  judgeModel: string;
  chatModel: string;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      flags.set(key, value);
      index += 1;
    } else {
      bools.add(key);
    }
  }
  const concurrency = Number(flags.get("concurrency"));
  const scenario = flags.get("scenario");
  return {
    dryRun: bools.has("dry-run"),
    noJudge: bools.has("no-judge"),
    ...(scenario ? { scenario } : {}),
    out: flags.get("out") ?? DEFAULT_OUT,
    judgeModel: flags.get("judge-model") ?? DEFAULT_JUDGE_MODEL,
    chatModel: flags.get("chat-model") ?? DEFAULT_CHARACTER_CHAT_MODEL_ID,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 3,
  };
}

// ---------------------------------------------------------------------------
// Plan (deterministic — no model calls)
// ---------------------------------------------------------------------------

interface PlannedTurn {
  index: number;
  player: string;
  allowance: string;
  clockMinutes: number;
  environment: EvalScenario["turns"][number]["environment"];
  wetnessLevel: number | null;
  cueLines: string[];
  observations: { id: string; band: string; tags: string[] }[];
  suppressed: { phenomenonId: string; code: string }[];
  groundTruth: string;
  prompts: Record<ArmId, string>;
  /** Cue lines whose leading clause already appears elsewhere in the prompt. */
  duplicateCues: string[];
}

interface PlannedScenario {
  scenario: EvalScenario;
  characterName: string;
  turns: PlannedTurn[];
}

function planScenario(scenario: EvalScenario): PlannedScenario {
  const character = scenarioCharacter(scenario);
  let cueMemory = emptyAffordanceCueState();
  const turns: PlannedTurn[] = [];
  scenario.turns.forEach((turn, turnIndex) => {
    const read = readTurn({ character, scenario, turn, previousCues: cueMemory });
    cueMemory = read.nextCues;
    const cuePrompt = buildArmPrompt({ character, scenario, turn, turnIndex, cueLines: read.cueLines });
    const controlPrompt = buildArmPrompt({ character, scenario, turn, turnIndex, cueLines: [] });
    turns.push({
      index: turnIndex + 1,
      player: turn.player,
      allowance: turnAllowance(turn.player),
      clockMinutes: turn.clockMinutes,
      environment: turn.environment,
      wetnessLevel: read.wetnessLevel,
      cueLines: [...read.cueLines],
      observations: read.read.observations.map((entry) => ({
        id: entry.id,
        band: entry.intensityBand,
        tags: [...entry.semanticTags],
      })),
      suppressed: read.read.suppressed.map((entry) => ({ phenomenonId: entry.phenomenonId, code: entry.code })),
      groundTruth: groundTruth({ character, scenario, turn, wetnessLevel: read.wetnessLevel }),
      prompts: { cues: cuePrompt, control: controlPrompt },
      duplicateCues: cueDuplicatesPrompt(cuePrompt, read.cueLines),
    });
  });
  return { scenario, characterName: character.name, turns };
}

// ---------------------------------------------------------------------------
// Harness self-checks (model-free; these gate the live run)
// ---------------------------------------------------------------------------

interface SelfCheck {
  id: string;
  ok: boolean;
  detail: string;
}

function selfChecks(plans: readonly PlannedScenario[]): SelfCheck[] {
  const checks: SelfCheck[] = [];
  for (const plan of plans) {
    const cueCounts = plan.turns.map((turn) => turn.cueLines.length);
    const total = cueCounts.reduce((sum, count) => sum + count, 0);
    if (plan.scenario.kind === "silence") {
      checks.push({
        id: `${plan.scenario.id}:silent`,
        ok: total === 0,
        detail: `expected zero cues across ${plan.turns.length} exchanges, got ${total} [${cueCounts.join(",")}]`,
      });
      // The whole point of the silence arm: with no cue block, the two prompts
      // are the same bytes, so any difference downstream is sampling noise.
      const identical = plan.turns.every((turn) => turn.prompts.cues === turn.prompts.control);
      checks.push({
        id: `${plan.scenario.id}:prompts-identical`,
        ok: identical,
        detail: identical ? "cue-arm prompt is byte-identical to control" : "prompts diverged with no cue",
      });
    } else {
      checks.push({
        id: `${plan.scenario.id}:speaks`,
        ok: total > 0,
        detail: `expected at least one cue, got ${total} [${cueCounts.join(",")}]`,
      });
    }
    for (const turn of plan.turns) {
      if (turn.cueLines.length > AFFORDANCE_CUES_PER_EXCHANGE) {
        checks.push({
          id: `${plan.scenario.id}:t${turn.index}:cap`,
          ok: false,
          detail: `${turn.cueLines.length} cues exceeds the cap of ${AFFORDANCE_CUES_PER_EXCHANGE}`,
        });
      }
      if (turn.duplicateCues.length > 0) {
        checks.push({
          id: `${plan.scenario.id}:t${turn.index}:duplicate`,
          ok: false,
          detail: `cue restates the prompt: ${turn.duplicateCues.join(" | ")}`,
        });
      }
      if (turn.cueLines.length > 0) {
        const delta = turn.prompts.cues.length - turn.prompts.control.length;
        // The cue arm is the control arm plus the block plus (on a `none`
        // allowance) the "cues win" carve-out — owner ruling 2026-07-28.
        const spliced =
          stripCueCarveOut(stripCueBlock(turn.prompts.cues), plan.characterName) === turn.prompts.control;
        if (!spliced) {
          checks.push({
            id: `${plan.scenario.id}:t${turn.index}:splice`,
            ok: false,
            detail: `cue prompt is not the control prompt plus the cue block and carve-out (Δ${delta} chars)`,
          });
        }
      }
    }
  }
  // Cap + duplicate + splice checks only push on FAILURE above; add the passes.
  const capOk = plans.every((plan) => plan.turns.every((turn) => turn.cueLines.length <= AFFORDANCE_CUES_PER_EXCHANGE));
  checks.push({
    id: "global:cue-cap",
    ok: capOk,
    detail: `every exchange offers at most ${AFFORDANCE_CUES_PER_EXCHANGE} cues`,
  });
  const dupOk = plans.every((plan) => plan.turns.every((turn) => turn.duplicateCues.length === 0));
  checks.push({
    id: "global:no-duplication",
    ok: dupOk,
    detail: "no cue line restates a clause the prompt already carries (stable appearance vs affordance cue)",
  });
  return checks;
}

// ---------------------------------------------------------------------------
// Live generation
// ---------------------------------------------------------------------------

/**
 * One narrator reply through the production stream.
 *
 * An EMPTY reply is fatal, not a datum. `streamText` surfaces a provider failure
 * (a dead key, a 402, a pulled model) by ending the stream, and an eval that
 * quietly scores blank transcripts as "zero contradictions, zero repetition" is
 * worse than one that crashes — it produces a confident, wrong recommendation.
 */
async function generateReply(input: {
  system: string;
  history: ReturnType<typeof armHistory>;
  name: string;
  model: string;
}): Promise<string> {
  let text = "";
  for await (const delta of streamCharacterChat({
    system: input.system,
    history: input.history,
    name: input.name,
    model: input.model,
  })) {
    text += delta;
  }
  const reply = text.trim();
  if (reply.length === 0) {
    throw new Error(
      `empty narration from ${input.model} — the provider call failed (check OPENROUTER_API_KEY and the model slug). Look above for the AI_APICallError.`,
    );
  }
  return reply;
}

interface ArmRun {
  replies: string[];
  promptChars: number;
  replyChars: number;
}

async function runArm(plan: PlannedScenario, arm: ArmId, model: string): Promise<ArmRun> {
  const replies: string[] = [];
  let promptChars = 0;
  let replyChars = 0;
  for (let index = 0; index < plan.turns.length; index += 1) {
    const turn = plan.turns[index];
    if (!turn) continue;
    const system = turn.prompts[arm];
    const history = armHistory(plan.scenario, replies, index);
    promptChars += system.length + history.reduce((sum, entry) => sum + entry.content.length, 0);
    const reply = await generateReply({ system, history, name: plan.characterName, model });
    replyChars += reply.length;
    replies.push(reply);
  }
  return { replies, promptChars, replyChars };
}

/**
 * Free, instant credential preflight. This script's cheapest possible failure is
 * "the key is dead"; its most expensive is discovering that after 60 billable
 * calls, or — worse — not discovering it at all. `/api/v1/key` costs nothing and
 * answers definitively.
 */
async function checkCredentials(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    });
    const body = await response.text();
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} ${body.slice(0, 200)}` };
    return { ok: true, detail: body.slice(0, 200) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Blinding
// ---------------------------------------------------------------------------

/** Deterministic per-scenario A/B assignment — the same run twice blinds identically. */
function cueLabelFor(scenarioId: string): "A" | "B" {
  let hash = 0;
  for (const char of scenarioId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 2 === 0 ? "A" : "B";
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface ArmMetrics {
  exchanges: number;
  contradictions: number;
  contradictionRate: number;
  repetitions: number;
  repetitionRate: number;
  staticRestatements: number;
  staticRestatementRate: number;
  specificityMean: number;
  naturalnessMean: number;
  physicsReportScenarios: number;
  hairMentions: number;
  hairMentionsPerExchange: number;
  hairSentences: number;
  meanConsecutiveHairOverlap: number | null;
  replyChars: number;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, places = 3): number {
  return Number(value.toFixed(places));
}

interface ScenarioResult {
  scenarioId: string;
  title: string;
  kind: EvalScenario["kind"];
  characterName: string;
  cueLabel: "A" | "B";
  judgeDegraded: boolean;
  verdict: JudgeVerdict | null;
  turns: {
    index: number;
    player: string;
    allowance: string;
    wetnessLevel: number | null;
    environment: unknown;
    cueLines: string[];
    observations: PlannedTurn["observations"];
    suppressed: PlannedTurn["suppressed"];
    groundTruth: string;
    replies: Record<ArmId, string>;
    hairMentions: Record<ArmId, number>;
  }[];
}

function armMetrics(results: readonly ScenarioResult[], arm: ArmId, kinds: readonly EvalScenario["kind"][]): ArmMetrics {
  const scoped = results.filter((result) => kinds.includes(result.kind));
  let contradictions = 0;
  let repetitions = 0;
  let staticRestatements = 0;
  let physicsReportScenarios = 0;
  const specificity: number[] = [];
  const naturalness: number[] = [];
  const overlaps: number[] = [];
  let hairMentions = 0;
  let hairSentenceCount = 0;
  let exchanges = 0;
  let replyChars = 0;
  for (const result of scoped) {
    const label = result.cueLabel === "A" ? (arm === "cues" ? "A" : "B") : arm === "cues" ? "B" : "A";
    const verdict = result.verdict?.[label];
    if (verdict) {
      contradictions += verdict.contradictions.length;
      repetitions += verdict.repetitions.length;
      staticRestatements += verdict.staticRestatements.length;
      specificity.push(verdict.specificity);
      naturalness.push(verdict.naturalness);
      if (verdict.physicsReport) physicsReportScenarios += 1;
    }
    let previous = "";
    for (const turn of result.turns) {
      const reply = turn.replies[arm];
      exchanges += 1;
      replyChars += reply.length;
      hairMentions += hairMentionCount(reply);
      hairSentenceCount += hairSentences(reply).length;
      if (previous) {
        const overlap = hairOverlap(previous, reply);
        if (overlap !== null) overlaps.push(overlap);
      }
      previous = reply;
    }
  }
  return {
    exchanges,
    contradictions,
    contradictionRate: exchanges ? round(contradictions / exchanges) : 0,
    repetitions,
    repetitionRate: exchanges ? round(repetitions / exchanges) : 0,
    staticRestatements,
    staticRestatementRate: exchanges ? round(staticRestatements / exchanges) : 0,
    specificityMean: round(mean(specificity), 2),
    naturalnessMean: round(mean(naturalness), 2),
    physicsReportScenarios,
    hairMentions,
    hairMentionsPerExchange: exchanges ? round(hairMentions / exchanges, 2) : 0,
    hairSentences: hairSentenceCount,
    meanConsecutiveHairOverlap: overlaps.length ? round(mean(overlaps)) : null,
    replyChars,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const filter = args.scenario;
  const selected = filter ? EVAL_SCENARIOS.filter((scenario) => scenario.id.includes(filter)) : EVAL_SCENARIOS;
  if (selected.length === 0) {
    console.error(`no scenario matched "${filter ?? ""}"`);
    return 1;
  }
  const plans = selected.map(planScenario);
  const checks = selfChecks(plans);
  const failed = checks.filter((check) => !check.ok);

  console.log(`affordance-cues trial — ${plans.length} scenarios, ${plans.reduce((n, p) => n + p.turns.length, 0)} paired exchanges`);
  for (const plan of plans) {
    console.log(`\n## ${plan.scenario.id} (${plan.scenario.kind}) — ${plan.scenario.title}`);
    for (const turn of plan.turns) {
      const observed = turn.observations.map((entry) => `${entry.id}:${entry.band}`).join(", ") || "—";
      const suppressed = turn.suppressed.map((entry) => `${entry.phenomenonId}:${entry.code}`).join(", ") || "—";
      console.log(
        `  t${turn.index} allowance=${turn.allowance} wet=${turn.wetnessLevel ?? "invalid"} obs=[${observed}] sup=[${suppressed}]`,
      );
      for (const line of turn.cueLines) console.log(`       cue → ${line}`);
    }
  }
  console.log("\n## self-checks");
  for (const check of checks) console.log(`  ${check.ok ? "ok  " : "FAIL"} ${check.id} — ${check.detail}`);

  // The allowance × cue cross-tab. `sensoryAllowance` is derived from the PLAYER'S
  // WORDING and the cue block from BODY STATE — two entirely independent inputs — so
  // the prompt can (and mostly does) offer a physical detail on the same turn its
  // allowance line says "no appearance description". Worth counting explicitly:
  // it is the most likely reason for a cue to be offered and ignored.
  const crossTab = new Map<string, { withCue: number; withoutCue: number }>();
  for (const plan of plans) {
    for (const turn of plan.turns) {
      const row = crossTab.get(turn.allowance) ?? { withCue: 0, withoutCue: 0 };
      if (turn.cueLines.length > 0) row.withCue += 1;
      else row.withoutCue += 1;
      crossTab.set(turn.allowance, row);
    }
  }
  console.log("\n## sensory allowance × cue offered");
  for (const [allowance, row] of [...crossTab.entries()].sort()) {
    console.log(`  ${allowance.padEnd(20)} cue offered ${String(row.withCue).padStart(2)}   no cue ${String(row.withoutCue).padStart(2)}`);
  }

  if (args.dryRun) {
    await fs.mkdir(args.out, { recursive: true });
    const matrixPath = path.join(args.out, "matrix.json");
    await fs.writeFile(
      matrixPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          experiment: "body-attribute-affordances slice 5 — deterministic matrix (no model calls)",
          generatedAt: new Date().toISOString(),
          selfChecks: checks,
          allowanceCrossTab: Object.fromEntries(crossTab),
          scenarios: plans.map((plan) => ({
            id: plan.scenario.id,
            title: plan.scenario.title,
            kind: plan.scenario.kind,
            character: plan.characterName,
            turns: plan.turns.map((turn) => ({
              index: turn.index,
              player: turn.player,
              allowance: turn.allowance,
              clockMinutes: turn.clockMinutes,
              environment: turn.environment,
              wetnessLevel: turn.wetnessLevel,
              observations: turn.observations,
              suppressed: turn.suppressed,
              cueLines: turn.cueLines,
              duplicateCues: turn.duplicateCues,
              groundTruth: turn.groundTruth,
              promptChars: { cues: turn.prompts.cues.length, control: turn.prompts.control.length },
            })),
          })),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\n--dry-run: no model calls made. wrote ${matrixPath}`);
    return failed.length === 0 ? 0 : 2;
  }
  if (failed.length > 0) {
    console.error("\nself-checks failed — refusing to spend live calls on a broken matrix.");
    return 2;
  }
  if (isDemoMode()) {
    console.error("\nno OPENROUTER_API_KEY (or AI_FAKE=1): this trial is live-only. Aborting.");
    return 1;
  }
  const credentials = await checkCredentials();
  if (!credentials.ok) {
    console.error(`\nOPENROUTER_API_KEY rejected by OpenRouter: ${credentials.detail}`);
    console.error("Aborting BEFORE any billable call — a trial run on a dead key scores blank transcripts.");
    return 1;
  }
  console.log(`\nkey ok (${credentials.detail}); generating ${plans.reduce((n, p) => n + p.turns.length, 0) * 2} narrator replies…`);

  // -- generation ----------------------------------------------------------
  const sink = new DiagnosticCollector();
  const started = new Date();
  const results: ScenarioResult[] = [];
  let generationCalls = 0;
  let generationPromptChars = 0;
  let generationReplyChars = 0;

  const queue = [...plans];
  const workers = Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    for (;;) {
      const plan = queue.shift();
      if (!plan) return;
      const [cues, control] = await Promise.all([
        runArm(plan, "cues", args.chatModel),
        runArm(plan, "control", args.chatModel),
      ]);
      generationCalls += plan.turns.length * 2;
      generationPromptChars += cues.promptChars + control.promptChars;
      generationReplyChars += cues.replyChars + control.replyChars;
      results.push({
        scenarioId: plan.scenario.id,
        title: plan.scenario.title,
        kind: plan.scenario.kind,
        characterName: plan.characterName,
        cueLabel: cueLabelFor(plan.scenario.id),
        judgeDegraded: false,
        verdict: null,
        turns: plan.turns.map((turn, index) => ({
          index: turn.index,
          player: turn.player,
          allowance: turn.allowance,
          wetnessLevel: turn.wetnessLevel,
          environment: turn.environment,
          cueLines: turn.cueLines,
          observations: turn.observations,
          suppressed: turn.suppressed,
          groundTruth: turn.groundTruth,
          replies: { cues: cues.replies[index] ?? "", control: control.replies[index] ?? "" },
          hairMentions: {
            cues: hairMentionCount(cues.replies[index] ?? ""),
            control: hairMentionCount(control.replies[index] ?? ""),
          },
        })),
      });
      console.log(`  generated ${plan.scenario.id} (${plan.turns.length} exchanges × 2 arms)`);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => selected.findIndex((s) => s.id === a.scenarioId) - selected.findIndex((s) => s.id === b.scenarioId));

  // -- judging -------------------------------------------------------------
  let judgeCalls = 0;
  let judgePromptChars = 0;
  if (!args.noJudge) {
    for (const result of results) {
      const plan = plans.find((entry) => entry.scenario.id === result.scenarioId);
      if (!plan) continue;
      const cueIsA = result.cueLabel === "A";
      const judged = await judgeScenario({
        scenarioTitle: result.title,
        premise: plan.scenario.premise,
        characterName: result.characterName,
        playerName: "Sam",
        modelId: args.judgeModel,
        sink,
        exchanges: result.turns.map((turn) => ({
          index: turn.index,
          player: turn.player,
          groundTruth: turn.groundTruth,
          a: cueIsA ? turn.replies.cues : turn.replies.control,
          b: cueIsA ? turn.replies.control : turn.replies.cues,
        })),
      });
      judgeCalls += 1;
      judgePromptChars += judged.promptChars;
      result.verdict = judged.verdict;
      result.judgeDegraded = judged.degraded;
      console.log(`  judged ${result.scenarioId}${judged.degraded ? " (DEGRADED)" : ""}`);
    }
  }

  // -- aggregation ---------------------------------------------------------
  const allKinds: EvalScenario["kind"][] = ["cue", "silence"];
  const summary = {
    all: { cues: armMetrics(results, "cues", allKinds), control: armMetrics(results, "control", allKinds) },
    cueScenarios: { cues: armMetrics(results, "cues", ["cue"]), control: armMetrics(results, "control", ["cue"]) },
    silenceScenarios: {
      cues: armMetrics(results, "cues", ["silence"]),
      control: armMetrics(results, "control", ["silence"]),
    },
  };
  const preference = { cues: 0, control: 0, tie: 0 };
  for (const result of results) {
    const preferred = result.verdict?.preferred;
    if (!preferred) continue;
    if (preferred === "tie") preference.tie += 1;
    else if (preferred === result.cueLabel) preference.cues += 1;
    else preference.control += 1;
  }
  const silencePreference = { cues: 0, control: 0, tie: 0 };
  for (const result of results.filter((entry) => entry.kind === "silence")) {
    const preferred = result.verdict?.preferred;
    if (!preferred) continue;
    if (preferred === "tie") silencePreference.tie += 1;
    else if (preferred === result.cueLabel) silencePreference.cues += 1;
    else silencePreference.control += 1;
  }

  const cueLineTotal = results.reduce(
    (sum, result) => sum + result.turns.reduce((inner, turn) => inner + turn.cueLines.length, 0),
    0,
  );
  const exchangesWithCue = results.reduce(
    (sum, result) => sum + result.turns.filter((turn) => turn.cueLines.length > 0).length,
    0,
  );

  const audit = {
    schemaVersion: 1,
    experiment: "body-attribute-affordances slice 5 — narrator cue trial",
    generatedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    models: {
      generator: args.chatModel,
      generatorTemperature: NARRATIVE_TEMPERATURE,
      judge: args.noJudge ? null : args.judgeModel,
      judgeTemperature: 0,
    },
    counts: {
      scenarios: results.length,
      pairedExchanges: results.reduce((sum, result) => sum + result.turns.length, 0),
      generationCalls,
      judgeCalls,
      cueLinesOffered: cueLineTotal,
      exchangesWithACue: exchangesWithCue,
      approxTokens: {
        generationPrompt: Math.round(generationPromptChars / 4),
        generationCompletion: Math.round(generationReplyChars / 4),
        judgePrompt: Math.round(judgePromptChars / 4),
      },
    },
    selfChecks: checks,
    summary,
    preference,
    silencePreference,
    diagnostics: sink.items,
    scenarios: results,
  };

  await fs.mkdir(args.out, { recursive: true });
  const outPath = path.join(args.out, "trial.json");
  await fs.writeFile(outPath, `${JSON.stringify(audit, null, 2)}\n`);

  console.log("\n## results (cue scenarios only)");
  printRow("contradictions / exchange", summary.cueScenarios.cues.contradictionRate, summary.cueScenarios.control.contradictionRate);
  printRow("repetitions / exchange", summary.cueScenarios.cues.repetitionRate, summary.cueScenarios.control.repetitionRate);
  printRow("static restatements / exch", summary.cueScenarios.cues.staticRestatementRate, summary.cueScenarios.control.staticRestatementRate);
  printRow("specificity (1-5)", summary.cueScenarios.cues.specificityMean, summary.cueScenarios.control.specificityMean);
  printRow("naturalness (1-5)", summary.cueScenarios.cues.naturalnessMean, summary.cueScenarios.control.naturalnessMean);
  printRow("hair mentions / exchange", summary.cueScenarios.cues.hairMentionsPerExchange, summary.cueScenarios.control.hairMentionsPerExchange);
  console.log(
    `  judge preference — cues ${preference.cues} · control ${preference.control} · tie ${preference.tie}` +
      `   (silence control: cues ${silencePreference.cues} · control ${silencePreference.control} · tie ${silencePreference.tie})`,
  );
  console.log(`\nwrote ${outPath}`);
  // Every judgment degrading means the summary above is all-zero placeholders, not
  // a result. Exit non-zero so nobody quotes it as a finding.
  const judged = results.filter((result) => result.verdict !== null).length;
  if (!args.noJudge && judged === 0) {
    console.error("\nEVERY judge call degraded — the per-criterion numbers above are placeholders, not results.");
    return 2;
  }
  if (!args.noJudge && judged < results.length) {
    console.error(`\nwarning: ${results.length - judged}/${results.length} scenarios went unjudged (degraded).`);
  }
  return 0;
}

function printRow(label: string, cues: number | null, control: number | null): void {
  const pad = (value: number | null): string => (value === null ? "  n/a" : value.toFixed(2).padStart(5));
  console.log(`  ${label.padEnd(28)} cues ${pad(cues)}   control ${pad(control)}`);
}

// `process.exitCode` rather than `process.exit()`: the pool teardown and an
// in-flight fetch keep libuv handles alive for a tick, and forcing the exit on
// top of them trips a Windows libuv assertion that masks the real exit code.
main()
  .then(async (code) => {
    process.exitCode = code;
    await globalThis.__vesperPool?.end();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    await globalThis.__vesperPool?.end();
  });
