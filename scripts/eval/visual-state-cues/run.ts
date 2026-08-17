import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { isDemoMode } from "@/server/ai";
import { NARRATIVE_TEMPERATURE, streamCharacterChat } from "@/server/engine";
import { DEFAULT_CHARACTER_CHAT_MODEL_ID } from "@/lib/narrative-models";
import {
  evalBaitFamilies,
  scenarioMatrix,
  EVAL_CHARACTER_NAME,
  EVAL_PLAYER_NAME,
  type EvalBaitFamily,
  type EvalScenario,
} from "./fixtures";
import {
  armHistory,
  buildArmPrompt,
  emptyCues,
  emptyMemory,
  groundTruth,
  readTurn,
  stripVisualBlocks,
  stripVisualCarveOut,
  type ArmId,
} from "./harness";
import {
  AUDIT_DIMENSIONS,
  auditArm,
  dimensionLabel,
  judgeScenario,
  type ArmAudit,
  type AuditDimension,
  type JudgeVerdict,
} from "./judge";

/**
 * Slice-7 narrator trial runner (visual-state.plan.md §Slice 7).
 *
 * Owner-gated LIVE comparison of the `CHAT_VISUAL_STATE_NARRATION` path — a
 * must-not-contradict fence plus at most two change-gated cues — against the
 * current build, which carries neither.
 *
 *   pnpm eval:visual-state-cues --dry-run   # matrix, blocks, self-checks. Free.
 *   pnpm eval:visual-state-cues             # the full paired trial + judging
 *
 * The generator is the PRODUCTION chat narrator (`streamCharacterChat`, the chat
 * lane's default model, production temperature) so the trial measures the real
 * product path. Judging is split: two arm-blind per-arm AUDITS produce the
 * numbers, one A/B blinded PREFERENCE call is advisory.
 *
 * The affordance-cue trial's round-1 failure is what the induction gate exists
 * to prevent: a matrix that never tempts produces a near-zero control rate,
 * which leaves the treated arm nothing to reduce and makes any verdict
 * meaningless.
 */

const DEFAULT_OUT = process.env.EVAL_OUT || "data/eval/visual-state-cues";
const DEFAULT_JUDGE_MODEL = "google/gemini-3.5-flash";

/** Frozen before the first billable call. Changing any of these needs an owner ruling. */
const INDUCTION_MIN_CONTROL_RATE = 0.4;
const INDUCTION_MIN_FAMILIES = 3;
const MAX_CONTRADICTION_RATIO = 0.6;
const MAX_REPETITION_EXCESS = 0.05;
const MAX_NATURALNESS_DROP = 0.25;
/** The specificity track's bar, used only when contradictions did not regress. */
const MIN_SPECIFICITY_GAIN = 0.5;

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

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else bare.add(name);
  }
  const concurrency = Number(flags.get("concurrency") ?? "3");
  return {
    dryRun: bare.has("dry-run"),
    noJudge: bare.has("no-judge"),
    ...(flags.get("scenario") === undefined ? {} : { scenario: String(flags.get("scenario")) }),
    out: flags.get("out") ?? DEFAULT_OUT,
    judgeModel: flags.get("judge-model") ?? DEFAULT_JUDGE_MODEL,
    chatModel: flags.get("chat-model") ?? DEFAULT_CHARACTER_CHAT_MODEL_ID,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? Math.trunc(concurrency) : 3,
  };
}

// ---------------------------------------------------------------------------
// Planning — the deterministic half
// ---------------------------------------------------------------------------

interface PlannedTurn {
  readonly index: number;
  readonly player: string;
  readonly groundTruth: string;
  readonly prompts: Readonly<Record<ArmId, string>>;
  readonly constraints: readonly string[];
  readonly cues: readonly string[];
  readonly cueReasons: readonly string[];
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly tempts?: string;
  readonly reveals?: string;
}

interface PlannedScenario {
  readonly scenario: EvalScenario;
  readonly turns: readonly PlannedTurn[];
}

function planScenario(scenario: EvalScenario): PlannedScenario {
  let cues = emptyCues();
  let memory = emptyMemory();
  const turns: PlannedTurn[] = scenario.turns.map((turn, index) => {
    const read = readTurn({ scenario, turn, previousCues: cues, previousMemory: memory });
    cues = read.nextCues;
    memory = read.nextMemory;
    const visual = buildArmPrompt({ scenario, turn, turnIndex: index, lines: read.lines });
    const control = buildArmPrompt({ scenario, turn, turnIndex: index, lines: { constraints: [], cues: [] } });
    return {
      index: index + 1,
      player: turn.player,
      groundTruth: groundTruth({ scenario, turn }),
      prompts: { visual, control },
      constraints: read.lines.constraints,
      cues: read.lines.cues,
      cueReasons: read.cueReasons,
      featureCount: read.featureCount,
      candidateCount: read.candidateCount,
      ...(turn.tempts === undefined ? {} : { tempts: turn.tempts }),
      ...(turn.reveals === undefined ? {} : { reveals: turn.reveals }),
    };
  });
  return { scenario, turns };
}

// ---------------------------------------------------------------------------
// Self-checks — run before any billable call
// ---------------------------------------------------------------------------

interface SelfCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function selfChecks(plans: readonly PlannedScenario[], whole: boolean): SelfCheck[] {
  const checks: SelfCheck[] = [];
  const allTurns = plans.flatMap((plan) => plan.turns);

  // 1. The arms differ by the two blocks and the carve-out, and by nothing else.
  const spliceFailures = allTurns.filter(
    (turn) => stripVisualCarveOut(stripVisualBlocks(turn.prompts.visual)) !== turn.prompts.control,
  );
  checks.push({
    name: "splice: visual prompt = control + the two blocks (+ carve-out)",
    ok: spliceFailures.length === 0,
    detail: `${String(allTurns.length - spliceFailures.length)}/${String(allTurns.length)} exchanges`,
  });

  // 2. The projection actually speaks. A silent matrix measures nothing.
  const withFence = allTurns.filter((turn) => turn.constraints.length > 0).length;
  checks.push({
    name: "the fence fires",
    ok: withFence >= allTurns.length * 0.8,
    detail: `${String(withFence)}/${String(allTurns.length)} exchanges carry a must-preserve block`,
  });

  // 3. The cue budget is never exceeded — the plan's strict "one or two".
  const overBudget = allTurns.filter((turn) => turn.cues.length > 2);
  checks.push({
    name: "cue budget ≤ 2 per exchange",
    ok: overBudget.length === 0,
    detail: `max ${String(Math.max(0, ...allTurns.map((turn) => turn.cues.length)))} cues in any exchange`,
  });

  // 4. The change gate holds ACROSS turns: a steady scene must go quiet. Every
  //    scenario's third exchange changes nothing, so it must offer fewer cues
  //    than its first.
  const quieted = plans.filter((plan) => {
    const first = plan.turns[0]?.cues.length ?? 0;
    const last = plan.turns.at(-1)?.cues.length ?? 0;
    return last < first || first === 0;
  });
  checks.push({
    name: "the repeat gate quiets an unchanged scene",
    ok: quieted.length === plans.length,
    detail: `${String(quieted.length)}/${String(plans.length)} scenarios offer fewer cues by the last exchange`,
  });

  // 5. Hidden loci never reach either block. The visibility read is upstream of
  //    the renderer, so this is a check on selection, not on prose.
  const leaks = plans.flatMap((plan) => {
    const hidden = Object.entries(plan.scenario.exposure)
      .filter(([, reading]) => reading === "hidden")
      .map(([location]) => location);
    return plan.turns.flatMap((turn) =>
      [...turn.constraints, ...turn.cues].filter((line) =>
        hidden.some((location) => line.toLowerCase().includes(location.toLowerCase())),
      ),
    );
  });
  checks.push({
    name: "no covered body location reaches a block",
    ok: leaks.length === 0,
    detail: leaks.length === 0 ? "none" : leaks.join(" | "),
  });

  // 6. Every bait family is represented and every scenario arms at least one.
  //    The coverage half applies to a WHOLE run only: a `--scenario` smoke test
  //    is deliberately one family, and failing it there would make the cheap
  //    single-scenario check impossible to run.
  const families = new Set(plans.map((plan) => plan.scenario.family));
  if (whole) {
    checks.push({
      name: "all five bait families present",
      ok: evalBaitFamilies.every((family) => families.has(family)),
      detail: [...families].join(", "),
    });
  }
  const unarmed = plans.filter((plan) => plan.turns.every((turn) => turn.tempts === undefined));
  checks.push({
    name: "every scenario arms a bait",
    ok: unarmed.length === 0,
    detail: unarmed.length === 0 ? "all armed" : unarmed.map((plan) => plan.scenario.id).join(", "),
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Live generation
// ---------------------------------------------------------------------------

/**
 * One narrator reply through the production stream.
 *
 * An EMPTY reply is fatal, not a datum: an eval that scores blank transcripts as
 * "zero contradictions" produces a confident, wrong recommendation.
 */
async function generateReply(input: {
  system: string;
  history: ReturnType<typeof armHistory>;
  model: string;
}): Promise<string> {
  let text = "";
  for await (const delta of streamCharacterChat({
    system: input.system,
    history: input.history,
    name: EVAL_CHARACTER_NAME,
    names: { speakers: [EVAL_CHARACTER_NAME], plain: [EVAL_PLAYER_NAME] },
    model: input.model,
  })) {
    text += delta;
  }
  const reply = text.trim();
  if (reply.length === 0) {
    throw new Error(
      `empty narration from ${input.model} — the provider call failed (check OPENROUTER_API_KEY and the model slug).`,
    );
  }
  return reply;
}

async function runArm(plan: PlannedScenario, arm: ArmId, model: string): Promise<string[]> {
  const replies: string[] = [];
  for (let index = 0; index < plan.turns.length; index += 1) {
    const turn = plan.turns[index];
    if (!turn) continue;
    replies.push(
      await generateReply({ system: turn.prompts[arm], history: armHistory(plan.scenario, replies, index), model }),
    );
  }
  return replies;
}

/** Free credential preflight — the cheapest possible failure, found before spending. */
async function checkCredentials(): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    });
    const body = await response.text();
    return response.ok ? { ok: true, detail: body.slice(0, 200) } : { ok: false, detail: `HTTP ${String(response.status)} ${body.slice(0, 200)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const keyUsageSchema = z.object({ data: z.object({ usage: z.number() }) });

async function keyUsage(): Promise<number | null> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    });
    if (!response.ok) return null;
    const parsed = keyUsageSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.data.usage : null;
  } catch {
    return null;
  }
}

/** Deterministic per-scenario A/B assignment, so the preference call cannot be positionally biased. */
function visualIsA(scenarioId: string): boolean {
  let hash = 0;
  for (const character of scenarioId) hash = (hash * 31 + character.charCodeAt(0)) % 1_000_003;
  return hash % 2 === 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ArmScore {
  exchanges: number;
  verifiedViolations: number;
  discardedViolations: number;
  byDimension: Record<AuditDimension, number>;
  repetitions: number;
  staticRestatements: number;
  specificitySum: number;
  naturalnessSum: number;
  scenarios: number;
  revealedSurfaced: number;
  revealedNamed: number;
  degraded: number;
}

function emptyScore(): ArmScore {
  return {
    exchanges: 0,
    verifiedViolations: 0,
    discardedViolations: 0,
    byDimension: {
      garment_presence: 0,
      garment_arrangement: 0,
      wetness_degree: 0,
      body_language: 0,
      hidden_detail: 0,
    },
    repetitions: 0,
    staticRestatements: 0,
    specificitySum: 0,
    naturalnessSum: 0,
    scenarios: 0,
    revealedSurfaced: 0,
    revealedNamed: 0,
    degraded: 0,
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s‘’“”"'.,;:!?—–-]+/gu, " ").trim();
}

interface KeptViolation {
  readonly scenarioId: string;
  readonly family: EvalBaitFamily;
  readonly arm: ArmId;
  readonly exchange: number;
  readonly dimension: AuditDimension;
  readonly quote: string;
}

/**
 * Fold one arm's audit into the running score, discarding every violation whose
 * quote cannot be found in that arm's own transcript. A hallucinated violation
 * must not be able to inflate a rate.
 */
function foldAudit(
  score: ArmScore,
  audit: ArmAudit,
  input: { scenario: EvalScenario; arm: ArmId; replies: readonly string[] },
): KeptViolation[] {
  const kept: KeptViolation[] = [];
  score.scenarios += 1;
  score.specificitySum += audit.specificity;
  score.naturalnessSum += audit.naturalness;
  score.repetitions += audit.repetitions.length;
  score.staticRestatements += audit.staticRestatements.length;
  for (const exchange of audit.exchanges) {
    score.exchanges += 1;
    const reply = normalize(input.replies[exchange.exchange - 1] ?? "");
    for (const dimension of AUDIT_DIMENSIONS) {
      if (exchange[dimension] !== "violated") continue;
      const quote = exchange.quotes[dimension];
      if (quote.length === 0 || !reply.includes(normalize(quote))) {
        score.discardedViolations += 1;
        continue;
      }
      score.verifiedViolations += 1;
      score.byDimension[dimension] += 1;
      kept.push({
        scenarioId: input.scenario.id,
        family: input.scenario.family,
        arm: input.arm,
        exchange: exchange.exchange,
        dimension,
        quote,
      });
    }
    if (exchange.revealed_detail === "surfaced") {
      score.revealedNamed += 1;
      score.revealedSurfaced += 1;
    } else if (exchange.revealed_detail === "absent") {
      score.revealedNamed += 1;
    }
  }
  return kept;
}

function rate(count: number, exchanges: number): number {
  return exchanges === 0 ? 0 : Number((count / exchanges).toFixed(3));
}

function mean(sum: number, count: number): number {
  return count === 0 ? 0 : Number((sum / count).toFixed(2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.scenario === undefined ? scenarioMatrix : scenarioMatrix.filter((scenario) => scenario.id.includes(String(args.scenario)));
  if (selected.length === 0) {
    console.error(`no scenario matches "${String(args.scenario)}"`);
    process.exit(1);
  }

  const plans = selected.map(planScenario);
  const checks = selfChecks(plans, args.scenario === undefined);

  console.log(`\nvisual-state narrator trial — ${String(plans.length)} scenarios, ${String(plans.flatMap((plan) => plan.turns).length)} paired exchanges\n`);
  for (const plan of plans) {
    console.log(`### ${plan.scenario.id}  [${plan.scenario.family}]`);
    for (const turn of plan.turns) {
      console.log(
        `  t${String(turn.index)}  features ${String(turn.featureCount)} · candidates ${String(turn.candidateCount)} · fence ${String(turn.constraints.length)} · cues ${String(turn.cues.length)}${turn.cueReasons.length > 0 ? ` [${turn.cueReasons.join(", ")}]` : ""}`,
      );
      for (const line of turn.constraints) console.log(`      fence | ${line}`);
      for (const line of turn.cues) console.log(`      cue   | ${line}`);
    }
  }

  console.log("\nself-checks");
  for (const check of checks) console.log(`  ${check.ok ? "ok  " : "FAIL"} ${check.name} — ${check.detail}`);
  const failedChecks = checks.filter((check) => !check.ok);

  await fs.mkdir(args.out, { recursive: true });
  if (args.dryRun) {
    await fs.writeFile(
      path.join(args.out, "matrix.json"),
      JSON.stringify({ checks, plans: plans.map((plan) => ({ id: plan.scenario.id, family: plan.scenario.family, turns: plan.turns })) }, null, 2),
    );
    console.log(`\ndry run — no model calls. matrix.json written to ${args.out}`);
    process.exit(failedChecks.length === 0 ? 0 : 2);
  }

  if (failedChecks.length > 0) {
    console.error("\nself-checks failed; refusing to spend. Fix the matrix or the projection first.");
    process.exit(2);
  }
  if (isDemoMode() || !process.env.OPENROUTER_API_KEY) {
    console.error("\nno OPENROUTER_API_KEY (or AI_FAKE=1): this trial is live-only. Aborting.");
    process.exit(1);
  }
  const credentials = await checkCredentials();
  if (!credentials.ok) {
    console.error(`\nOPENROUTER_API_KEY rejected by OpenRouter: ${credentials.detail}`);
    process.exit(1);
  }
  const usageBefore = await keyUsage();

  console.log(`\nrunning live — narrator ${args.chatModel} @ ${String(NARRATIVE_TEMPERATURE)}, judge ${args.judgeModel}\n`);
  const sink = new DiagnosticCollector();
  const scores: Record<ArmId, ArmScore> = { visual: emptyScore(), control: emptyScore() };
  const kept: KeptViolation[] = [];
  const preferences: { scenarioId: string; preferred: "visual" | "control" | "tie"; why: string }[] = [];
  const transcripts: Record<string, Record<ArmId, string[]>> = {};
  /**
   * The raw audits, kept whole. Round 1 folded them straight into counts and
   * left the repetition and static-restatement QUOTES unrecoverable — so the
   * one number that regressed could only be explained by re-reading transcripts
   * by hand. An audit is cheap to store and expensive to re-buy.
   */
  const audits: Record<string, Partial<Record<ArmId, ArmAudit>>> = {};
  let auditCalls = 0;
  let generationCalls = 0;
  let degraded = false;

  const queue = [...plans];
  const workers = Array.from({ length: Math.min(args.concurrency, queue.length) }, async () => {
    for (;;) {
      const plan = queue.shift();
      if (plan === undefined) return;
      const [visual, control] = await Promise.all([
        runArm(plan, "visual", args.chatModel),
        runArm(plan, "control", args.chatModel),
      ]);
      generationCalls += visual.length + control.length;
      transcripts[plan.scenario.id] = { visual, control };

      const auditExchanges = (replies: readonly string[]) =>
        plan.turns.map((turn) => ({
          index: turn.index,
          player: turn.player,
          groundTruth: turn.groundTruth,
          reply: replies[turn.index - 1] ?? "",
          ...(turn.tempts === undefined ? {} : { tempts: turn.tempts }),
          ...(turn.reveals === undefined ? {} : { reveals: turn.reveals }),
        }));

      const shared = {
        scenarioTitle: plan.scenario.title,
        premise: plan.scenario.premise,
        characterName: EVAL_CHARACTER_NAME,
        playerName: EVAL_PLAYER_NAME,
        modelId: args.judgeModel,
        sink,
      };
      const [visualAudit, controlAudit] = await Promise.all([
        auditArm({ ...shared, exchanges: auditExchanges(visual) }),
        auditArm({ ...shared, exchanges: auditExchanges(control) }),
      ]);
      auditCalls += visualAudit.calls + controlAudit.calls;
      for (const [arm, result, replies] of [
        ["visual", visualAudit, visual],
        ["control", controlAudit, control],
      ] as const) {
        if (result.audit === null) {
          scores[arm].degraded += 1;
          degraded = true;
          console.error(`  ! ${plan.scenario.id} ${arm} audit unusable: ${String(result.failure)}`);
          continue;
        }
        audits[plan.scenario.id] = { ...audits[plan.scenario.id], [arm]: result.audit };
        kept.push(...foldAudit(scores[arm], result.audit, { scenario: plan.scenario, arm, replies }));
      }

      if (!args.noJudge) {
        const aIsVisual = visualIsA(plan.scenario.id);
        const preference = await judgeScenario({
          ...shared,
          exchanges: plan.turns.map((turn) => ({
            index: turn.index,
            player: turn.player,
            groundTruth: turn.groundTruth,
            a: (aIsVisual ? visual : control)[turn.index - 1] ?? "",
            b: (aIsVisual ? control : visual)[turn.index - 1] ?? "",
          })),
        });
        const verdict: JudgeVerdict | null = preference.verdict;
        if (verdict !== null) {
          preferences.push({
            scenarioId: plan.scenario.id,
            preferred:
              verdict.preferred === "tie" ? "tie" : (verdict.preferred === "A") === aIsVisual ? "visual" : "control",
            why: verdict.preferredWhy,
          });
        }
      }
      console.log(`  done ${plan.scenario.id}`);
    }
  });
  await Promise.all(workers);

  const usageAfter = await keyUsage();

  // --- the report --------------------------------------------------------
  const controlRate = rate(scores.control.verifiedViolations, scores.control.exchanges);
  const visualRate = rate(scores.visual.verifiedViolations, scores.visual.exchanges);
  const familiesWithControlViolation = new Set(kept.filter((entry) => entry.arm === "control").map((entry) => entry.family));
  const inductionValid =
    controlRate >= INDUCTION_MIN_CONTROL_RATE && familiesWithControlViolation.size >= INDUCTION_MIN_FAMILIES;

  const repetitionExcess = Number(
    (rate(scores.visual.repetitions, scores.visual.exchanges) - rate(scores.control.repetitions, scores.control.exchanges)).toFixed(3),
  );
  const naturalnessDrop = Number(
    (mean(scores.control.naturalnessSum, scores.control.scenarios) - mean(scores.visual.naturalnessSum, scores.visual.scenarios)).toFixed(2),
  );
  const specificityGain = Number(
    (mean(scores.visual.specificitySum, scores.visual.scenarios) - mean(scores.control.specificitySum, scores.control.scenarios)).toFixed(2),
  );
  const leakageOk = scores.visual.byDimension.hidden_detail <= scores.control.byDimension.hidden_detail;
  const contradictionOk = controlRate > 0 && visualRate <= controlRate * MAX_CONTRADICTION_RATIO;
  const repetitionOk = repetitionExcess <= MAX_REPETITION_EXCESS;
  const naturalnessOk = naturalnessDrop <= MAX_NATURALNESS_DROP;
  const specificityTrackOk = specificityGain >= MIN_SPECIFICITY_GAIN && visualRate <= controlRate;
  const guardsOk = repetitionOk && naturalnessOk && leakageOk;
  const verdict = degraded
    ? null
    : !inductionValid
      ? "invalid_induction"
      : guardsOk && (contradictionOk || specificityTrackOk)
        ? "pass"
        : "fail";

  console.log("\n=== results (all scenarios) ===\n");
  console.log(`                            visual    control`);
  console.log(`contradictions / exchange   ${visualRate.toFixed(3)}     ${controlRate.toFixed(3)}`);
  console.log(`repetitions / exchange      ${rate(scores.visual.repetitions, scores.visual.exchanges).toFixed(3)}     ${rate(scores.control.repetitions, scores.control.exchanges).toFixed(3)}`);
  console.log(`static restatements / ex.   ${rate(scores.visual.staticRestatements, scores.visual.exchanges).toFixed(3)}     ${rate(scores.control.staticRestatements, scores.control.exchanges).toFixed(3)}`);
  console.log(`specificity (1-5)           ${mean(scores.visual.specificitySum, scores.visual.scenarios).toFixed(2)}      ${mean(scores.control.specificitySum, scores.control.scenarios).toFixed(2)}`);
  console.log(`naturalness (1-5)           ${mean(scores.visual.naturalnessSum, scores.visual.scenarios).toFixed(2)}      ${mean(scores.control.naturalnessSum, scores.control.scenarios).toFixed(2)}`);
  console.log(`newly-revealed surfaced     ${String(scores.visual.revealedSurfaced)}/${String(scores.visual.revealedNamed)}       ${String(scores.control.revealedSurfaced)}/${String(scores.control.revealedNamed)}`);
  console.log("\nviolations by dimension (verified):");
  for (const dimension of AUDIT_DIMENSIONS) {
    console.log(`  ${dimensionLabel(dimension).padEnd(24)} visual ${String(scores.visual.byDimension[dimension])}   control ${String(scores.control.byDimension[dimension])}`);
  }
  console.log(`\ndiscarded (unquotable) violations: visual ${String(scores.visual.discardedViolations)}, control ${String(scores.control.discardedViolations)}`);
  console.log("\nper-family control violations (the induction read):");
  for (const family of evalBaitFamilies) {
    const controlHits = kept.filter((entry) => entry.arm === "control" && entry.family === family).length;
    const visualHits = kept.filter((entry) => entry.arm === "visual" && entry.family === family).length;
    console.log(`  ${family.padEnd(20)} control ${String(controlHits)}   visual ${String(visualHits)}`);
  }
  if (preferences.length > 0) {
    const tally = { visual: 0, control: 0, tie: 0 };
    for (const entry of preferences) tally[entry.preferred] += 1;
    console.log(`\npreference (advisory): visual ${String(tally.visual)} · control ${String(tally.control)} · tie ${String(tally.tie)}`);
  }
  console.log(`\ninduction gate: control ${controlRate.toFixed(3)}/exchange (need ≥ ${String(INDUCTION_MIN_CONTROL_RATE)}), ${String(familiesWithControlViolation.size)}/5 families baited (need ≥ ${String(INDUCTION_MIN_FAMILIES)}) — ${inductionValid ? "VALID" : "INVALID"}`);
  console.log(`decision rule: contradictions ${contradictionOk ? "pass" : "fail"} · repetition ${repetitionOk ? "pass" : "fail"} (${repetitionExcess.toFixed(3)}) · naturalness ${naturalnessOk ? "pass" : "fail"} (−${naturalnessDrop.toFixed(2)}) · leakage ${leakageOk ? "pass" : "fail"} · specificity track ${specificityTrackOk ? "pass" : "fail"} (+${specificityGain.toFixed(2)})`);
  console.log(`\nverdict: ${verdict ?? "null (degraded — the numbers are not a result)"}`);
  const spend = usageBefore !== null && usageAfter !== null ? Number((usageAfter - usageBefore).toFixed(4)) : null;
  console.log(`calls: ${String(generationCalls)} generations, ${String(auditCalls)} audits, ${String(preferences.length)} preference · spend ${spend === null ? "unknown" : `$${spend.toFixed(4)}`}\n`);

  const summary = {
    version: 1 as const,
    ranAtStoryless: true,
    verdict,
    inductionValid,
    models: { narrator: args.chatModel, judge: args.judgeModel, temperature: NARRATIVE_TEMPERATURE },
    rule: {
      MAX_CONTRADICTION_RATIO,
      MAX_REPETITION_EXCESS,
      MAX_NATURALNESS_DROP,
      MIN_SPECIFICITY_GAIN,
      INDUCTION_MIN_CONTROL_RATE,
      INDUCTION_MIN_FAMILIES,
    },
    scores,
    rates: { visualRate, controlRate, repetitionExcess, naturalnessDrop, specificityGain },
    byFamily: evalBaitFamilies.map((family) => ({
      family,
      control: kept.filter((entry) => entry.arm === "control" && entry.family === family).length,
      visual: kept.filter((entry) => entry.arm === "visual" && entry.family === family).length,
    })),
    violations: kept,
    /** Repetition and static-restatement quotes — the numbers that need explaining. */
    quality: Object.entries(audits).flatMap(([scenarioId, byArm]) =>
      (["visual", "control"] as const).flatMap((arm) => {
        const audit = byArm[arm];
        if (audit === undefined) return [];
        return [
          ...audit.repetitions.map((entry) => ({ scenarioId, arm, kind: "repetition" as const, ...entry })),
          ...audit.staticRestatements.map((entry) => ({ scenarioId, arm, kind: "static_restatement" as const, ...entry })),
        ];
      }),
    ),
    preferences,
    checks,
    spend: { generationCalls, auditCalls, preferenceCalls: preferences.length, usageBefore, usageAfter, spend },
    diagnostics: sink.items.map((entry) => ({ severity: entry.severity, code: entry.code, message: entry.message })),
  };
  await fs.writeFile(path.join(args.out, "summary.json"), JSON.stringify(summary, null, 2));
  await fs.writeFile(
    path.join(args.out, "trial.json"),
    JSON.stringify(
      { summary, plans: plans.map((plan) => ({ id: plan.scenario.id, turns: plan.turns })), transcripts, audits },
      null,
      2,
    ),
  );
  console.log(`summary.json + trial.json written to ${args.out}`);
  process.exit(degraded ? 2 : 0);
}

void main();
