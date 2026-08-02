import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { isDemoMode } from "@/server/ai";
import { NARRATIVE_TEMPERATURE, streamCharacterChat } from "@/server/engine";
import { DEFAULT_CHARACTER_CHAT_MODEL_ID } from "@/lib/narrative-models";
import { scenarioMatrix, type EvalBait, type EvalScenario, type EvalScenarioFamily } from "./fixtures";
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
import {
  AUDIT_DIMENSIONS,
  auditArm,
  dimensionLabel,
  judgeScenario,
  type ArmAudit,
  type AuditDimension,
  type DimensionVerdict,
  type JudgeVerdict,
} from "./judge";
import { buildTrialSummary, digest, resolveFixtureCommit, trialSummarySchema } from "./summary";

/**
 * Slice-5 narrator trial runner (body-attribute-affordances.plan.md, rematch
 * spec body-attribute-affordances.trial.rematch.md).
 *
 * Owner-gated LIVE MODEL comparison of the `CHAT_AFFORDANCE_CUES` cue path
 * against the current appearance-only path. See ./README.md for how to rerun it
 * and how to read the frozen decision rule.
 *
 *   pnpm eval:affordance-cues --dry-run       # matrix + cue lines, no model calls
 *   pnpm eval:affordance-cues                 # the full paired trial + judging
 *   pnpm eval:affordance-cues --matrix v1     # the round-1 matrix, unchanged
 *
 * The generator is the PRODUCTION chat narrator (`streamCharacterChat`, the chat
 * lane's default model) so the trial measures the real product path. Judging is
 * split (rematch §Judge redesign): two arm-blind per-arm contradiction AUDITS
 * that produce the numbers, and one A/B blinded PREFERENCE call that is advisory
 * only.
 *
 * Round 1's failure mode is the thing this runner now guards against: a matrix
 * that never tempts the narrator produces a near-zero control rate, which leaves
 * the cue arm nothing to reduce and makes any verdict meaningless. The INDUCTION
 * GATE checks the instrument before the decision rule is allowed to speak.
 */

const DEFAULT_OUT = process.env.EVAL_OUT || "data/eval/affordance-cues";
const DEFAULT_JUDGE_MODEL = "google/gemini-3.5-flash";

/** Frozen for the campaign — changes require an owner ruling (rematch §Decision rule). */
const INDUCTION_MIN_CONTROL_RATE = 0.4;
const INDUCTION_MIN_FAMILIES = 3;
const MAX_CONTRADICTION_RATIO = 0.6;
const MAX_REPETITION_EXCESS = 0.05;
const MAX_NATURALNESS_DROP = 0.25;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type MatrixName = "rematch" | "v1";

interface Args {
  matrix: MatrixName;
  dryRun: boolean;
  noJudge: boolean;
  scenario?: string;
  out: string;
  judgeModel: string;
  chatModel: string;
  concurrency: number;
}

function isMatrixName(value: string): value is MatrixName {
  return value === "rematch" || value === "v1";
}

function parseArgs(argv: string[]): Args | { error: string } {
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
  const matrix = flags.get("matrix") ?? "rematch";
  if (!isMatrixName(matrix)) return { error: `unknown --matrix "${matrix}" (expected "rematch" or "v1")` };
  const concurrency = Number(flags.get("concurrency"));
  const scenario = flags.get("scenario");
  return {
    matrix,
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
// Scenario families
// ---------------------------------------------------------------------------

/**
 * The five bait families. `satisfies` pins this list to the fixture union, so a
 * family added there without a decision here is a compile error rather than a
 * family that silently stops counting toward the induction gate.
 */
const BAIT_FAMILIES = [
  "provenance_bait",
  "binding_bait",
  "coverage_bait",
  "degree_bait",
  "assertion_bait",
] as const satisfies readonly EvalScenarioFamily[];

/**
 * What a scenario contributes:
 * - `paired` — counts toward the cues-vs-control comparison and the induction gate.
 * - `silence` — zero cues, byte-identical prompts; the judge's label-noise floor.
 * - `invention_control` — zero cues, both arms identical; measures whether the
 *   bait tempts the narrator at all, never the feature.
 */
type ScenarioRole = "paired" | "silence" | "invention_control";

function familyRole(family: EvalScenarioFamily): ScenarioRole {
  switch (family) {
    case "provenance_bait":
    case "binding_bait":
    case "coverage_bait":
    case "degree_bait":
    case "assertion_bait":
      return "paired";
    case "silence":
      return "silence";
    case "invention_control":
      return "invention_control";
  }
}

/** Null for a matrix whose scenarios carry no family metadata (v1). */
function scenarioFamily(scenario: EvalScenario): EvalScenarioFamily | null {
  return scenario.family ?? null;
}

/**
 * v1 has no families, so its `cue` scenarios fall into `paired` and its silence
 * controls into `silence` — the paired table still prints for the regression
 * matrix, while its induction gate is invalid by construction (no bait family
 * can show a violation), which is the honest answer for a matrix that was never
 * built to induce one.
 */
function scenarioRole(scenario: EvalScenario): ScenarioRole {
  const family = scenarioFamily(scenario);
  if (family !== null) return familyRole(family);
  return scenario.kind === "silence" ? "silence" : "paired";
}

/** exchange number (1-based, matching `PlannedTurn.index`) → the wrong claim it tempts. */
function baitByExchange(scenario: EvalScenario): Map<number, string> {
  const baits: ReadonlyArray<EvalBait | null> = scenario.baits ?? [];
  const armed = new Map<number, string>();
  baits.forEach((bait, index) => {
    if (!bait) return;
    const exchange = Number.isFinite(bait.exchange) && bait.exchange > 0 ? bait.exchange : index + 1;
    armed.set(exchange, bait.tempts);
  });
  return armed;
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
  /** The armed bait's `tempts` phrase, or null when no bait is armed here. */
  bait: string | null;
}

interface PlannedScenario {
  scenario: EvalScenario;
  family: EvalScenarioFamily | null;
  role: ScenarioRole;
  characterName: string;
  turns: PlannedTurn[];
}

function planScenario(scenario: EvalScenario): PlannedScenario {
  const character = scenarioCharacter(scenario);
  const armed = baitByExchange(scenario);
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
      bait: armed.get(turnIndex + 1) ?? null,
    });
  });
  return {
    scenario,
    family: scenarioFamily(scenario),
    role: scenarioRole(scenario),
    characterName: character.name,
    turns,
  };
}

// ---------------------------------------------------------------------------
// Harness self-checks (model-free; these gate the live run)
// ---------------------------------------------------------------------------

interface SelfCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * Metadata-driven and matrix-agnostic: the family/bait checks only fire for a
 * matrix that carries family metadata, so `--matrix v1` runs exactly the
 * round-1 checks and stays green.
 */
function selfChecks(plans: readonly PlannedScenario[]): SelfCheck[] {
  const checks: SelfCheck[] = [];
  for (const plan of plans) {
    const cueCounts = plan.turns.map((turn) => turn.cueLines.length);
    const total = cueCounts.reduce((sum, count) => sum + count, 0);
    const identical = plan.turns.every((turn) => turn.prompts.cues === turn.prompts.control);
    if (plan.role === "silence") {
      checks.push({
        id: `${plan.scenario.id}:silent`,
        ok: total === 0,
        detail: `expected zero cues across ${plan.turns.length} exchanges, got ${total} [${cueCounts.join(",")}]`,
      });
      // The whole point of the silence arm: with no cue block, the two prompts
      // are the same bytes, so any difference downstream is sampling noise.
      checks.push({
        id: `${plan.scenario.id}:prompts-identical`,
        ok: identical,
        detail: identical ? "cue-arm prompt is byte-identical to control" : "prompts diverged with no cue",
      });
    } else if (plan.role === "invention_control") {
      // Both arms must be the same build here — this scenario measures whether
      // the BAIT tempts the narrator, so a cue would confound its own control.
      checks.push({
        id: `${plan.scenario.id}:invention-control-silent`,
        ok: total === 0,
        detail: `invention control must fire no cue; got ${total} [${cueCounts.join(",")}]`,
      });
      checks.push({
        id: `${plan.scenario.id}:prompts-identical`,
        ok: identical,
        detail: identical ? "both arms get byte-identical prompts" : "prompts diverged with no cue",
      });
    } else {
      checks.push({
        id: `${plan.scenario.id}:speaks`,
        ok: total > 0,
        detail: `expected at least one cue, got ${total} [${cueCounts.join(",")}]`,
      });
    }
    for (const turn of plan.turns) {
      // Headroom exists only where a true current effect AND a tempting wrong
      // claim meet (rematch §Why round 1 could not have succeeded). An armed
      // bait with no cue offered is a bait the cue arm cannot answer — in a BAIT
      // family. The invention control is the deliberate exception: it arms baits
      // exactly where no cue can fire, which is what makes it a control.
      if (turn.bait !== null && plan.role === "paired") {
        checks.push({
          id: `${plan.scenario.id}:t${turn.index}:armed-bait`,
          ok: turn.cueLines.length > 0,
          detail:
            turn.cueLines.length > 0
              ? `bait armed (${turn.bait}) with ${turn.cueLines.length} cue(s) to anchor against`
              : `bait armed (${turn.bait}) but NO cue fired — the cue arm has nothing to weave`,
        });
      }
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
  // Every bait family in this matrix has to fire at least one cue SOMEWHERE, or
  // that family's rows measure the bait alone with no anchor to compare against.
  const families = new Set(plans.map((plan) => plan.family).filter((family): family is EvalScenarioFamily => family !== null));
  for (const family of BAIT_FAMILIES) {
    if (!families.has(family)) continue;
    const scoped = plans.filter((plan) => plan.family === family);
    const cues = scoped.reduce((sum, plan) => sum + plan.turns.reduce((inner, turn) => inner + turn.cueLines.length, 0), 0);
    checks.push({
      id: `family:${family}:fires`,
      ok: cues > 0,
      detail: `${scoped.length} scenario(s) offering ${cues} cue line(s)`,
    });
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
    // The eval's prompts are built for the fixed "Sam" player (see the prompt
    // builder below) — the same vocabulary the chat pipeline hands the stream.
    names: { speakers: [input.name], plain: ["Sam"] },
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

/** OpenRouter reports the key's CUMULATIVE spend; the delta across a round is its cost. */
const keyUsageSchema = z.object({ data: z.object({ usage: z.number() }) });

/**
 * The round's spend, read either side of the model calls off the same free
 * endpoint the preflight uses. Best-effort on purpose: the campaign's cost was
 * hand-transcribed from this number, and a summary that records it automatically
 * must still never be the reason a paid round fails.
 */
async function keyUsage(): Promise<number | null> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    const parsed = keyUsageSchema.safeParse(raw);
    return parsed.success ? parsed.data.data.usage : null;
  } catch {
    return null;
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
// Quote verification
// ---------------------------------------------------------------------------

type QuoteMatch = "exchange" | "transcript" | "missing" | "not_found";

/**
 * Case-insensitive, whitespace-normalized, with the punctuation a model
 * re-types by habit folded to ASCII. Deliberately nothing cleverer: a fuzzy
 * matcher would re-admit exactly the hallucinated quotes this check exists to
 * throw out.
 */
function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/gu, "'")
    .replace(/[“”″]/gu, '"')
    .replace(/[–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A `violated` verdict is only counted if its quote is really in the narration.
 * The exchange's own reply is the expected home; a quote found elsewhere in the
 * same transcript still counts (the judge mis-attributed the exchange, not the
 * violation), and anything else is discarded and tallied.
 */
function verifyQuote(quote: string, reply: string, transcript: string): QuoteMatch {
  const needle = normalizeQuote(quote);
  if (needle.length === 0) return "missing";
  if (normalizeQuote(reply).includes(needle)) return "exchange";
  if (normalizeQuote(transcript).includes(needle)) return "transcript";
  return "not_found";
}

// ---------------------------------------------------------------------------
// Audit records
// ---------------------------------------------------------------------------

interface KeptViolation {
  dimension: AuditDimension;
  quote: string;
  match: "exchange" | "transcript";
}

interface DiscardedViolation {
  dimension: AuditDimension;
  quote: string;
  reason: "missing_quote" | "quote_not_found";
}

interface ExchangeAuditRecord {
  index: number;
  /** Whether an armed bait was in play on this exchange. */
  baited: boolean;
  verdicts: Record<AuditDimension, DimensionVerdict>;
  violations: KeptViolation[];
  discarded: DiscardedViolation[];
  /** Kept violations — the contradiction count for this exchange. */
  contradictions: number;
}

interface ArmAuditRecord {
  degraded: boolean;
  failure: string | null;
  specificity: number | null;
  naturalness: number | null;
  repetitions: number;
  staticRestatements: number;
  physicsReport: boolean;
  contradictions: number;
  discarded: number;
  exchanges: ExchangeAuditRecord[];
  raw: ArmAudit | null;
}

function emptyAuditRecord(failure: string): ArmAuditRecord {
  return {
    degraded: true,
    failure,
    specificity: null,
    naturalness: null,
    repetitions: 0,
    staticRestatements: 0,
    physicsReport: false,
    contradictions: 0,
    discarded: 0,
    exchanges: [],
    raw: null,
  };
}

function buildAuditRecord(input: {
  audit: ArmAudit;
  replies: readonly string[];
  baited: ReadonlySet<number>;
}): ArmAuditRecord {
  const transcript = input.replies.join("\n\n");
  const exchanges: ExchangeAuditRecord[] = [];
  let contradictions = 0;
  let discardedTotal = 0;
  for (const entry of input.audit.exchanges) {
    const reply = input.replies[entry.exchange - 1] ?? "";
    const verdicts = {} as Record<AuditDimension, DimensionVerdict>;
    const violations: KeptViolation[] = [];
    const discarded: DiscardedViolation[] = [];
    for (const dimension of AUDIT_DIMENSIONS) {
      const verdict = entry[dimension];
      verdicts[dimension] = verdict;
      if (verdict !== "violated") continue;
      const quote = entry.quotes[dimension];
      const match = verifyQuote(quote, reply, transcript);
      switch (match) {
        case "exchange":
        case "transcript":
          violations.push({ dimension, quote, match });
          break;
        case "missing":
          discarded.push({ dimension, quote, reason: "missing_quote" });
          break;
        case "not_found":
          discarded.push({ dimension, quote, reason: "quote_not_found" });
          break;
      }
    }
    contradictions += violations.length;
    discardedTotal += discarded.length;
    exchanges.push({
      index: entry.exchange,
      baited: input.baited.has(entry.exchange),
      verdicts,
      violations,
      discarded,
      contradictions: violations.length,
    });
  }
  return {
    degraded: false,
    failure: null,
    specificity: input.audit.specificity,
    naturalness: input.audit.naturalness,
    repetitions: input.audit.repetitions.length,
    staticRestatements: input.audit.staticRestatements.length,
    physicsReport: input.audit.physicsReport,
    contradictions,
    discarded: discardedTotal,
    exchanges,
    raw: input.audit,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface ArmSummary {
  scenarios: number;
  exchanges: number;
  audited: number;
  contradictions: number;
  contradictionRate: number;
  discardedViolations: number;
  repetitions: number;
  repetitionRate: number;
  staticRestatements: number;
  staticRestatementRate: number;
  specificityMean: number | null;
  naturalnessMean: number | null;
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
  family: EvalScenarioFamily | null;
  role: ScenarioRole;
  characterName: string;
  cueLabel: "A" | "B";
  /** The advisory pairwise call only. Audit health lives on `audits`. */
  judgeDegraded: boolean;
  verdict: JudgeVerdict | null;
  audits: Record<ArmId, ArmAuditRecord | null>;
  turns: {
    index: number;
    player: string;
    allowance: string;
    wetnessLevel: number | null;
    environment: unknown;
    cueLines: string[];
    bait: string | null;
    observations: PlannedTurn["observations"];
    suppressed: PlannedTurn["suppressed"];
    groundTruth: string;
    replies: Record<ArmId, string>;
    hairMentions: Record<ArmId, number>;
  }[];
}

function armSummary(results: readonly ScenarioResult[], arm: ArmId, roles: readonly ScenarioRole[]): ArmSummary {
  const scoped = results.filter((result) => roles.includes(result.role));
  let contradictions = 0;
  let discarded = 0;
  let repetitions = 0;
  let staticRestatements = 0;
  let physicsReportScenarios = 0;
  let audited = 0;
  const specificity: number[] = [];
  const naturalness: number[] = [];
  const overlaps: number[] = [];
  let hairMentions = 0;
  let hairSentenceCount = 0;
  let exchanges = 0;
  let replyChars = 0;
  for (const result of scoped) {
    const audit = result.audits[arm];
    if (audit && !audit.degraded) {
      audited += 1;
      contradictions += audit.contradictions;
      discarded += audit.discarded;
      repetitions += audit.repetitions;
      staticRestatements += audit.staticRestatements;
      if (audit.specificity !== null) specificity.push(audit.specificity);
      if (audit.naturalness !== null) naturalness.push(audit.naturalness);
      if (audit.physicsReport) physicsReportScenarios += 1;
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
    scenarios: scoped.length,
    exchanges,
    audited,
    contradictions,
    contradictionRate: exchanges ? round(contradictions / exchanges) : 0,
    discardedViolations: discarded,
    repetitions,
    repetitionRate: exchanges ? round(repetitions / exchanges) : 0,
    staticRestatements,
    staticRestatementRate: exchanges ? round(staticRestatements / exchanges) : 0,
    specificityMean: specificity.length ? round(mean(specificity), 2) : null,
    naturalnessMean: naturalness.length ? round(mean(naturalness), 2) : null,
    physicsReportScenarios,
    hairMentions,
    hairMentionsPerExchange: exchanges ? round(hairMentions / exchanges, 2) : 0,
    hairSentences: hairSentenceCount,
    meanConsecutiveHairOverlap: overlaps.length ? round(mean(overlaps)) : null,
    replyChars,
  };
}

/** Raw (unrounded) per-exchange contradiction rate — what the gate and rule read. */
function rawContradictionRate(results: readonly ScenarioResult[], arm: ArmId): number {
  let contradictions = 0;
  let exchanges = 0;
  for (const result of results) {
    const audit = result.audits[arm];
    if (audit && !audit.degraded) contradictions += audit.contradictions;
    exchanges += result.turns.length;
  }
  return exchanges === 0 ? 0 : contradictions / exchanges;
}

interface FamilyRow {
  family: EvalScenarioFamily | null;
  scenarios: number;
  exchanges: number;
  armedBaitExchanges: number;
  control: { contradictions: number; rate: number; armedHits: number; armedHitRate: number | null };
  cues: { contradictions: number; rate: number; armedHits: number; armedHitRate: number | null };
}

function familyArm(results: readonly ScenarioResult[], arm: ArmId): FamilyRow["control"] {
  let contradictions = 0;
  let exchanges = 0;
  let armed = 0;
  let armedHits = 0;
  for (const result of results) {
    exchanges += result.turns.length;
    const audit = result.audits[arm];
    if (!audit || audit.degraded) continue;
    contradictions += audit.contradictions;
    for (const entry of audit.exchanges) {
      if (!entry.baited) continue;
      armed += 1;
      if (entry.contradictions > 0) armedHits += 1;
    }
  }
  return {
    contradictions,
    rate: exchanges ? round(contradictions / exchanges) : 0,
    armedHits,
    armedHitRate: armed ? round(armedHits / armed, 2) : null,
  };
}

function familyTable(results: readonly ScenarioResult[]): FamilyRow[] {
  const paired = results.filter((result) => result.role === "paired");
  const present = new Set(paired.map((result) => result.family));
  // Canonical bait order first (so the table reads the same every round), then
  // the family-less bucket a v1 run lands in.
  const families: (EvalScenarioFamily | null)[] = BAIT_FAMILIES.filter((family) => present.has(family));
  if (present.has(null)) families.push(null);
  return families.map((family) => {
    const scoped = paired.filter((result) => result.family === family);
    const armedBaitExchanges = scoped.reduce(
      (sum, result) => sum + result.turns.filter((turn) => turn.bait !== null).length,
      0,
    );
    return {
      family,
      scenarios: scoped.length,
      exchanges: scoped.reduce((sum, result) => sum + result.turns.length, 0),
      armedBaitExchanges,
      control: familyArm(scoped, "control"),
      cues: familyArm(scoped, "cues"),
    };
  });
}

// ---------------------------------------------------------------------------
// Induction gate + decision rule (rematch spec — FROZEN)
// ---------------------------------------------------------------------------

interface Induction {
  controlRate: number;
  minControlRate: number;
  familiesWithViolation: number;
  minFamilies: number;
  baitFamiliesPresent: EvalScenarioFamily[];
  /** Bait families in the matrix that never drew a control-arm violation. */
  familiesWithoutViolation: EvalScenarioFamily[];
  /** Bait families the matrix does not contain at all. */
  familiesAbsent: EvalScenarioFamily[];
  valid: boolean;
}

function induction(results: readonly ScenarioResult[]): Induction {
  const paired = results.filter((result) => result.role === "paired");
  const controlRate = rawContradictionRate(paired, "control");
  const present: EvalScenarioFamily[] = [];
  const without: EvalScenarioFamily[] = [];
  const absent: EvalScenarioFamily[] = [];
  for (const family of BAIT_FAMILIES) {
    const scoped = paired.filter((result) => result.family === family);
    if (scoped.length === 0) {
      absent.push(family);
      continue;
    }
    present.push(family);
    const violations = scoped.reduce((sum, result) => {
      const audit = result.audits.control;
      return sum + (audit && !audit.degraded ? audit.contradictions : 0);
    }, 0);
    if (violations === 0) without.push(family);
  }
  const familiesWithViolation = present.length - without.length;
  return {
    controlRate: round(controlRate),
    minControlRate: INDUCTION_MIN_CONTROL_RATE,
    familiesWithViolation,
    minFamilies: INDUCTION_MIN_FAMILIES,
    baitFamiliesPresent: present,
    familiesWithoutViolation: without,
    familiesAbsent: absent,
    valid: controlRate >= INDUCTION_MIN_CONTROL_RATE && familiesWithViolation >= INDUCTION_MIN_FAMILIES,
  };
}

type TrialVerdict = "pass" | "fail" | "invalid_induction";

interface DecisionClause {
  ok: boolean;
  detail: string;
}

interface Decision {
  contradictions: DecisionClause;
  repetitions: DecisionClause;
  naturalness: DecisionClause;
  verdict: TrialVerdict;
}

function decide(input: {
  cues: ArmSummary;
  control: ArmSummary;
  cuesRate: number;
  controlRate: number;
  valid: boolean;
}): Decision {
  const ceiling = input.controlRate * MAX_CONTRADICTION_RATIO;
  const contradictions: DecisionClause = {
    ok: input.cuesRate <= ceiling,
    detail: `cues ${input.cuesRate.toFixed(3)} / exchange vs ceiling ${ceiling.toFixed(3)} (${Math.round(
      MAX_CONTRADICTION_RATIO * 100,
    )}% of control's ${input.controlRate.toFixed(3)})`,
  };
  const repetitionDelta = input.cues.repetitionRate - input.control.repetitionRate;
  const repetitions: DecisionClause = {
    ok: repetitionDelta <= MAX_REPETITION_EXCESS,
    detail: `cues ${input.cues.repetitionRate.toFixed(3)} vs control ${input.control.repetitionRate.toFixed(
      3,
    )} (Δ ${repetitionDelta >= 0 ? "+" : ""}${repetitionDelta.toFixed(3)}, allowance +${MAX_REPETITION_EXCESS})`,
  };
  const cueNaturalness = input.cues.naturalnessMean;
  const controlNaturalness = input.control.naturalnessMean;
  const naturalnessOk =
    cueNaturalness !== null && controlNaturalness !== null && cueNaturalness >= controlNaturalness - MAX_NATURALNESS_DROP;
  const naturalness: DecisionClause = {
    ok: naturalnessOk,
    detail:
      cueNaturalness === null || controlNaturalness === null
        ? "no naturalness score (the audit did not return one)"
        : `cues ${cueNaturalness.toFixed(2)} vs control ${controlNaturalness.toFixed(2)} (floor ${(
            controlNaturalness - MAX_NATURALNESS_DROP
          ).toFixed(2)})`,
  };
  return {
    contradictions,
    repetitions,
    naturalness,
    verdict: !input.valid
      ? "invalid_induction"
      : contradictions.ok && repetitions.ok && naturalness.ok
        ? "pass"
        : "fail",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }
  const args = parsed;
  const filter = args.scenario;
  const matrix = scenarioMatrix(args.matrix);
  const selected = filter ? matrix.filter((scenario) => scenario.id.includes(filter)) : matrix;
  if (selected.length === 0) {
    console.error(`no scenario in --matrix ${args.matrix} matched "${filter ?? ""}"`);
    return 1;
  }
  const plans = selected.map(planScenario);
  const checks = selfChecks(plans);
  const failed = checks.filter((check) => !check.ok);
  const pairedExchanges = plans.reduce((sum, plan) => sum + plan.turns.length, 0);

  console.log(
    `affordance-cues trial — matrix "${args.matrix}", ${plans.length} scenarios, ${pairedExchanges} paired exchanges`,
  );
  for (const plan of plans) {
    console.log(`\n## ${plan.scenario.id} (${plan.family ?? plan.scenario.kind}) — ${plan.scenario.title}`);
    for (const turn of plan.turns) {
      const observed = turn.observations.map((entry) => `${entry.id}:${entry.band}`).join(", ") || "—";
      const suppressed = turn.suppressed.map((entry) => `${entry.phenomenonId}:${entry.code}`).join(", ") || "—";
      console.log(
        `  t${turn.index} allowance=${turn.allowance} wet=${turn.wetnessLevel ?? "invalid"} obs=[${observed}] sup=[${suppressed}]`,
      );
      if (turn.bait) console.log(`       bait → ${turn.bait}`);
      for (const line of turn.cueLines) console.log(`       cue  → ${line}`);
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
          schemaVersion: 2,
          experiment: "body-attribute-affordances slice 5 — deterministic matrix (no model calls)",
          matrix: args.matrix,
          generatedAt: new Date().toISOString(),
          selfChecks: checks,
          allowanceCrossTab: Object.fromEntries(crossTab),
          scenarios: plans.map((plan) => ({
            id: plan.scenario.id,
            title: plan.scenario.title,
            kind: plan.scenario.kind,
            family: plan.family,
            role: plan.role,
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
              bait: turn.bait,
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
  console.log(`\nkey ok (${credentials.detail}); generating ${pairedExchanges * 2} narrator replies…`);
  const keyUsageBefore = await keyUsage();

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
        family: plan.family,
        role: plan.role,
        characterName: plan.characterName,
        cueLabel: cueLabelFor(plan.scenario.id),
        judgeDegraded: false,
        verdict: null,
        audits: { cues: null, control: null },
        turns: plan.turns.map((turn, index) => ({
          index: turn.index,
          player: turn.player,
          allowance: turn.allowance,
          wetnessLevel: turn.wetnessLevel,
          environment: turn.environment,
          cueLines: turn.cueLines,
          bait: turn.bait,
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

  // -- judging: 2 arm-blind audits + 1 advisory preference call per scenario --
  let auditCalls = 0;
  let preferenceCalls = 0;
  let judgePromptChars = 0;
  if (!args.noJudge) {
    const byId = new Map(plans.map((plan) => [plan.scenario.id, plan]));
    for (const result of results) {
      const cueIsA = result.cueLabel === "A";
      const auditExchanges = (arm: ArmId) =>
        result.turns.map((turn) => ({
          index: turn.index,
          player: turn.player,
          groundTruth: turn.groundTruth,
          reply: turn.replies[arm],
          ...(turn.bait === null ? {} : { tempts: turn.bait }),
        }));
      const shared = {
        scenarioTitle: result.title,
        premise: byId.get(result.scenarioId)?.scenario.premise ?? "",
        characterName: result.characterName,
        playerName: "Sam",
        modelId: args.judgeModel,
        sink,
      };
      const [cueAudit, controlAudit, preference] = await Promise.all([
        auditArm({ ...shared, exchanges: auditExchanges("cues") }),
        auditArm({ ...shared, exchanges: auditExchanges("control") }),
        judgeScenario({
          ...shared,
          exchanges: result.turns.map((turn) => ({
            index: turn.index,
            player: turn.player,
            groundTruth: turn.groundTruth,
            a: cueIsA ? turn.replies.cues : turn.replies.control,
            b: cueIsA ? turn.replies.control : turn.replies.cues,
          })),
        }),
      ]);
      auditCalls += cueAudit.calls + controlAudit.calls;
      preferenceCalls += 1;
      judgePromptChars += cueAudit.promptChars + controlAudit.promptChars + preference.promptChars;
      const baited = new Set(result.turns.filter((turn) => turn.bait !== null).map((turn) => turn.index));
      result.audits = {
        cues: cueAudit.audit
          ? buildAuditRecord({ audit: cueAudit.audit, replies: result.turns.map((t) => t.replies.cues), baited })
          : emptyAuditRecord(cueAudit.failure ?? "unknown"),
        control: controlAudit.audit
          ? buildAuditRecord({ audit: controlAudit.audit, replies: result.turns.map((t) => t.replies.control), baited })
          : emptyAuditRecord(controlAudit.failure ?? "unknown"),
      };
      result.verdict = preference.verdict;
      result.judgeDegraded = preference.degraded;
      const degradedArms = (["cues", "control"] as const).filter((arm) => result.audits[arm]?.degraded);
      console.log(
        `  audited ${result.scenarioId}` +
          (degradedArms.length > 0 ? ` (AUDIT DEGRADED: ${degradedArms.join(", ")})` : "") +
          (preference.degraded ? " (preference degraded)" : ""),
      );
    }
  }

  // -- aggregation ---------------------------------------------------------
  const allRoles: ScenarioRole[] = ["paired", "silence", "invention_control"];
  const summary = {
    all: { cues: armSummary(results, "cues", allRoles), control: armSummary(results, "control", allRoles) },
    baitScenarios: { cues: armSummary(results, "cues", ["paired"]), control: armSummary(results, "control", ["paired"]) },
    silenceScenarios: { cues: armSummary(results, "cues", ["silence"]), control: armSummary(results, "control", ["silence"]) },
    inventionControl: {
      cues: armSummary(results, "cues", ["invention_control"]),
      control: armSummary(results, "control", ["invention_control"]),
    },
  };
  const paired = results.filter((result) => result.role === "paired");
  const families = familyTable(results);
  const gate = induction(results);
  const decision = decide({
    cues: summary.baitScenarios.cues,
    control: summary.baitScenarios.control,
    cuesRate: rawContradictionRate(paired, "cues"),
    controlRate: rawContradictionRate(paired, "control"),
    valid: gate.valid,
  });

  const tally = (scoped: readonly ScenarioResult[]): { cues: number; control: number; tie: number } => {
    const counts = { cues: 0, control: 0, tie: 0 };
    for (const result of scoped) {
      const preferred = result.verdict?.preferred;
      if (!preferred) continue;
      if (preferred === "tie") counts.tie += 1;
      else if (preferred === result.cueLabel) counts.cues += 1;
      else counts.control += 1;
    }
    return counts;
  };
  const preference = tally(paired);
  const silencePreference = tally(results.filter((result) => result.role === "silence"));

  const cueLineTotal = results.reduce(
    (sum, result) => sum + result.turns.reduce((inner, turn) => inner + turn.cueLines.length, 0),
    0,
  );
  const exchangesWithCue = results.reduce(
    (sum, result) => sum + result.turns.filter((turn) => turn.cueLines.length > 0).length,
    0,
  );
  const armedBaitExchanges = results.reduce(
    (sum, result) => sum + result.turns.filter((turn) => turn.bait !== null).length,
    0,
  );
  const degradedAudits = results.flatMap((result) =>
    (["cues", "control"] as const)
      .filter((arm) => result.audits[arm]?.degraded)
      .map((arm) => ({ scenarioId: result.scenarioId, arm, failure: result.audits[arm]?.failure ?? "unknown" })),
  );
  const auditsRan = !args.noJudge;
  const discarded = {
    cues: summary.all.cues.discardedViolations,
    control: summary.all.control.discardedViolations,
  };

  // A degraded audit means the numbers below are missing rows, not results, so
  // the run publishes NO verdict and no decision at all (round-1 rule: an eval
  // that silently scores blank output is worse than one that crashes). The
  // frozen `verdict` enum stays three-valued; "we did not measure" is null.
  const decidable = auditsRan && degradedAudits.length === 0;
  const verdict: TrialVerdict | null = decidable ? decision.verdict : null;

  const audit = {
    schemaVersion: 2,
    experiment: "body-attribute-affordances slice 5 — narrator cue trial (rematch)",
    matrix: args.matrix,
    generatedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    verdict,
    induction: decidable ? gate : null,
    decision: decidable ? decision : null,
    thresholds: {
      inductionMinControlRate: INDUCTION_MIN_CONTROL_RATE,
      inductionMinFamilies: INDUCTION_MIN_FAMILIES,
      maxContradictionRatio: MAX_CONTRADICTION_RATIO,
      maxRepetitionExcess: MAX_REPETITION_EXCESS,
      maxNaturalnessDrop: MAX_NATURALNESS_DROP,
    },
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
      auditCalls,
      preferenceCalls,
      judgeCalls: auditCalls + preferenceCalls,
      cueLinesOffered: cueLineTotal,
      exchangesWithACue: exchangesWithCue,
      armedBaitExchanges,
      discardedViolations: discarded,
      approxTokens: {
        generationPrompt: Math.round(generationPromptChars / 4),
        generationCompletion: Math.round(generationReplyChars / 4),
        judgePrompt: Math.round(judgePromptChars / 4),
      },
    },
    selfChecks: checks,
    summary,
    families,
    preference,
    silencePreference,
    degradedAudits,
    diagnostics: sink.items,
    scenarios: results,
  };

  await fs.mkdir(args.out, { recursive: true });
  const outPath = path.join(args.out, "trial.json");
  await fs.writeFile(outPath, `${JSON.stringify(audit, null, 2)}\n`);

  // -- the committable half of the record (see ./summary.ts) ---------------
  // `trial.json` lives in gitignored `data/`, so a round's numbers survive only
  // as a hand transcription. `summary.json` is the same round with the
  // transcripts removed: provenance, raw counts, verified quotes, spend — small
  // and safe enough to commit into `results/` next to the fixtures.
  const keyUsageAfter = await keyUsage();
  const trialSummary = buildTrialSummary({
    experiment: audit.experiment,
    matrix: args.matrix,
    startedAt: audit.generatedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    fixtureCommit: await resolveFixtureCommit(),
    models: {
      narrator: args.chatModel,
      narratorTemperature: NARRATIVE_TEMPERATURE,
      judge: args.noJudge ? null : args.judgeModel,
      judgeTemperature: 0,
    },
    hashes: {
      // Key order is fixed by the literal, so the digest is stable across runs
      // that did not change the instrument.
      config: digest([
        JSON.stringify({
          matrix: args.matrix,
          scenarioFilter: filter ?? null,
          scenarioIds: results.map((result) => result.scenarioId),
          thresholds: audit.thresholds,
          models: audit.models,
          cuesPerExchange: AFFORDANCE_CUES_PER_EXCHANGE,
        }),
      ]),
      prompts: {
        cues: digest(plans.flatMap((plan) => plan.turns.map((turn) => turn.prompts.cues))),
        control: digest(plans.flatMap((plan) => plan.turns.map((turn) => turn.prompts.control))),
      },
    },
    spend: {
      generationCalls,
      auditCalls,
      preferenceCalls,
      approxTokens: audit.counts.approxTokens,
      keyUsageBefore,
      keyUsageAfter,
      usd:
        keyUsageBefore !== null && keyUsageAfter !== null ? round(keyUsageAfter - keyUsageBefore, 4) : null,
    },
    scenarios: results,
  });
  const summaryPath = path.join(args.out, "summary.json");
  const validated = trialSummarySchema.safeParse(trialSummary);
  if (!validated.success) {
    // Degrade, never drop: a paid, unreproducible round's record is worth more
    // than schema purity, so the invalid object is still written — loudly.
    console.error(
      `\nsummary.json failed its own schema — writing it anyway, but it is NOT a valid record: ${validated.error.issues
        .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(validated.success ? validated.data : trialSummary, null, 2)}\n`);

  console.log("\n## results (bait scenarios only)");
  printRow("contradictions / exchange", summary.baitScenarios.cues.contradictionRate, summary.baitScenarios.control.contradictionRate);
  printRow("repetitions / exchange", summary.baitScenarios.cues.repetitionRate, summary.baitScenarios.control.repetitionRate);
  printRow("static restatements / exch", summary.baitScenarios.cues.staticRestatementRate, summary.baitScenarios.control.staticRestatementRate);
  printRow("specificity (1-5)", summary.baitScenarios.cues.specificityMean, summary.baitScenarios.control.specificityMean);
  printRow("naturalness (1-5)", summary.baitScenarios.cues.naturalnessMean, summary.baitScenarios.control.naturalnessMean);
  printRow("hair mentions / exchange", summary.baitScenarios.cues.hairMentionsPerExchange, summary.baitScenarios.control.hairMentionsPerExchange);
  console.log(
    `  judge preference (advisory) — cues ${preference.cues} · control ${preference.control} · tie ${preference.tie}` +
      `   (silence control: cues ${silencePreference.cues} · control ${silencePreference.control} · tie ${silencePreference.tie})`,
  );
  console.log(
    `  discarded violations (quote not in transcript) — cues ${discarded.cues} · control ${discarded.control}`,
  );

  console.log("\n## per-family (contradictions / exchange · armed-bait hit rate)");
  console.log(
    `  ${"family".padEnd(20)}${"scen".padStart(5)}${"exch".padStart(6)}${"armed".padStart(7)}${"ctl c/e".padStart(9)}${"cue c/e".padStart(9)}${"ctl hit".padStart(9)}${"cue hit".padStart(9)}`,
  );
  const rate = (value: number | null): string => (value === null ? "n/a" : value.toFixed(2));
  for (const row of families) {
    console.log(
      `  ${(row.family ?? "(no family)").padEnd(20)}${String(row.scenarios).padStart(5)}${String(row.exchanges).padStart(6)}${String(
        row.armedBaitExchanges,
      ).padStart(7)}${row.control.rate.toFixed(2).padStart(9)}${row.cues.rate.toFixed(2).padStart(9)}${rate(
        row.control.armedHitRate,
      ).padStart(9)}${rate(row.cues.armedHitRate).padStart(9)}`,
    );
  }

  if (auditsRan) {
    console.log("\n## induction gate (is this matrix able to measure anything?)");
    console.log(
      `  control contradictions / exchange   ${gate.controlRate.toFixed(2)}   (needs ≥ ${INDUCTION_MIN_CONTROL_RATE.toFixed(2)})   ${
        gate.controlRate >= INDUCTION_MIN_CONTROL_RATE ? "ok" : "FAIL"
      }`,
    );
    console.log(
      `  bait families with a control violation   ${gate.familiesWithViolation}/${gate.baitFamiliesPresent.length} present   (needs ≥ ${INDUCTION_MIN_FAMILIES})   ${
        gate.familiesWithViolation >= INDUCTION_MIN_FAMILIES ? "ok" : "FAIL"
      }`,
    );
  }

  if (!auditsRan) {
    console.log("\nverdict: (none — --no-judge, so nothing was audited)");
  } else if (degradedAudits.length > 0) {
    console.error(
      `\n${degradedAudits.length} audit(s) degraded — the numbers above have missing rows and are NOT a result:`,
    );
    for (const entry of degradedAudits) console.error(`  ${entry.scenarioId} [${entry.arm}] — ${entry.failure}`);
    console.error("verdict: (none — the run failed)");
  } else if (!gate.valid) {
    console.log("\nverdict: invalid_induction — the baits did not tempt the narrator, so no feature verdict is possible.");
    if (gate.familiesWithoutViolation.length > 0) {
      console.log(`  families that failed to bait: ${gate.familiesWithoutViolation.map(familyBaitNote).join(", ")}`);
    }
    if (gate.familiesAbsent.length > 0) {
      console.log(`  families absent from this matrix: ${gate.familiesAbsent.join(", ")}`);
    }
    console.log("  next action per the rematch spec: iterate the MATRIX (stronger bait, more leading player lines,");
    console.log("  longer scenarios) — never the cue path and never the decision rule.");
  } else {
    console.log("\n## decision rule (frozen)");
    console.log(`  ${decision.contradictions.ok ? "ok  " : "FAIL"} contradictions — ${decision.contradictions.detail}`);
    console.log(`  ${decision.repetitions.ok ? "ok  " : "FAIL"} repetitions   — ${decision.repetitions.detail}`);
    console.log(`  ${decision.naturalness.ok ? "ok  " : "FAIL"} naturalness   — ${decision.naturalness.detail}`);
    console.log(`\nverdict: ${decision.verdict}`);
  }

  console.log(`\nwrote ${outPath}   (full transcripts — gitignored)`);
  console.log(`wrote ${summaryPath}   (committable record — copy into scripts/eval/affordance-cues/results/)`);
  if (auditsRan && degradedAudits.length > 0) return 2;
  if (!args.noJudge && results.some((result) => result.verdict === null)) {
    console.error(
      `\nwarning: ${results.filter((result) => result.verdict === null).length}/${results.length} advisory preference calls degraded (the verdict does not depend on them).`,
    );
  }
  return 0;
}

/**
 * The console note for a family that never drew a control-arm violation: names
 * the audit dimension that family's bait was supposed to trip, so the follow-up
 * matrix edit knows what to make sharper.
 */
function familyBaitNote(family: EvalScenarioFamily): string {
  switch (family) {
    case "provenance_bait":
      return `${family} (${dimensionLabel("provenance")})`;
    case "binding_bait":
      return `${family} (${dimensionLabel("motion_vs_binding")})`;
    case "coverage_bait":
      return `${family} (${dimensionLabel("coverage")})`;
    case "degree_bait":
      return `${family} (${dimensionLabel("wetness_degree")})`;
    case "assertion_bait":
      return `${family} (${dimensionLabel("adopted_false_premise")})`;
    case "silence":
    case "invention_control":
      return family;
  }
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
