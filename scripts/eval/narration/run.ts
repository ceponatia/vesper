import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { streamText, type JSONValue, type ModelMessage } from "ai";
import { isDemoMode, narrativeProviderOptions, openrouter, routedProvider } from "../../../src/server/ai";
import { replyEndsInQuestion } from "../../../src/server/engine/chat-intent";
import type { NarrationShapeId } from "../../../src/server/engine/prompts/constants";
import { parseSegments } from "../../../src/lib/segmenter";
import { CONTRAST_AXES, EVAL_SCENARIOS, type EvalScenario } from "./fixtures";
import { judgeAbsolute, judgeAvg, type Judgement } from "./judge";

/**
 * Behavioral eval harness for narration (narrator-prompt-focus.plan.md §Behavioral
 * eval harness). LIVE OpenRouter spend — **never** wired into `pnpm verify` / CI.
 * For each cell of (scenario × model × shape profile × reasoning × seed) it assembles
 * the real prompt (fixtures.ts), streams the narrator, computes deterministic metrics
 * (paragraphs / segments / distinct speakers / tokens / TTFT / latency / routed
 * provider via segmenter.parseSegments), and — unless --no-judge — scores it 1–5 on
 * the rubric with an LLM judge. Prints a table and writes results JSON.
 *
 *   pnpm eval:narration                       # default: aion narrator, both profiles, judge on
 *   pnpm eval:narration --models aion,glm --reasoning default,off,low
 *   pnpm eval:narration --scenarios hi,compliment --profiles concise --no-judge
 *   pnpm eval:narration --no-focus            # strip the §Phase-3 planner (Phase-2 A/B)
 *   pnpm eval:narration --scenarios chat-contrast --seeds 5 --no-judge   # the §5 contrast pairs (blind-judge via compare.ts)
 *   pnpm eval:narration --dry-run             # assemble + print prompts, no model calls, no spend
 *
 * `--seeds N` repeats every cell N times (temperature 0.8 makes each a fresh sample) —
 * the replicate axis the paired-contrast bar ("≥80% of seeds per axis",
 * character-chat-standalone.spec.md §5) is scored over via
 * `pnpm eval:narration:compare --axis contrast`.
 *
 * The harness MEASURES; a low score is a signal to iterate prompt wording, never a
 * build failure. It automates the interim manual eval + probes P1–P3.
 */

const OUT = process.env.EVAL_OUT || "data/eval/narration";
const NARRATIVE_TEMPERATURE = 0.8;

/**
 * Opt-in deterministic check for a single sensory hook — reported ONLY for scenarios
 * flagged `sensoryRelevant` (character-chat-sensory.plan.md §7). Most chat turns should
 * mention nothing of the kind, so this is never a universal score: a non-flagged
 * scenario that happens to mention scent is not a failure and isn't measured.
 */
const SENSORY_CUE_RE =
  /\b(scent|smell|smells|smelling|smelled|perfume|cologne|fragrance|aroma|musk|soap|cedar|lavender|vanilla|jasmine|floral|warmth|warm skin|breath|softness)\b/i;

/**
 * Opt-in deterministic check that narration lands in the PLAYER's senses
 * (chat-narrator-pov.plan.md §3) — reported ONLY for scenarios flagged `povRelevant`.
 * Second-person perception grammar: "you see/notice/catch…", "your eyes/nose/skin…",
 * "…reaches/tickles/brushes your…". Expected to match on flagged scenarios.
 */
const POV_CUE_RE =
  /\b(?:you (?:see|notice|catch|watch|glimpse|take in|feel|smell|taste|hear|can see|can smell|can feel|can't help but notice)|your (?:eyes?|gaze|attention|view|nose|nostrils|lips|mouth|skin|palms?|fingers|fingertips|hands?)|meets? your|(?:reach(?:es|ing)?|fill(?:s|ing)?|tickl(?:es|ing)|brush(?:es|ing)|graz(?:es|ing)|warm(?:s|ing)|drift(?:s|ing) (?:to|toward|into)) your)\b/i;

const MODEL_ALIASES: Record<string, string> = {
  aion: "aion-labs/aion-2.0",
  glm: "z-ai/glm-5.2",
  deepseek: "deepseek/deepseek-v4-flash",
  gemini: "google/gemini-3.5-flash",
};
const PROFILE_ALIASES: Record<string, NarrationShapeId> = {
  concise: "concise_immersive",
  concise_immersive: "concise_immersive",
  aggressive: "aggressive_concise",
  aggressive_concise: "aggressive_concise",
};
type Reasoning = "default" | "off" | "low";

const resolveModel = (m: string): string => MODEL_ALIASES[m] ?? m;
const shortModel = (id: string): string => Object.entries(MODEL_ALIASES).find(([, v]) => v === id)?.[0] ?? id;
const shortProfile = (p: NarrationShapeId): string => (p === "concise_immersive" ? "concise" : "aggressive");

interface Args {
  models: string[];
  profiles: NarrationShapeId[];
  reasoning: Reasoning[];
  scenarios: EvalScenario[];
  /** Repeats per cell — the replicate axis for the contrast pairs' per-seed bar. */
  seeds: number;
  focus: boolean;
  judge: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok?.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      bools.add(key);
    }
  }
  const list = (key: string): string[] | undefined => flags.get(key)?.split(",").map((s) => s.trim()).filter(Boolean);

  const models = (list("models") ?? ["aion"]).map(resolveModel);
  const profiles = (list("profiles") ?? ["concise", "aggressive"]).map((p) => PROFILE_ALIASES[p] ?? "concise_immersive");
  const reasoning = (list("reasoning") ?? ["default"]).map((r) => (r === "off" || r === "low" ? r : "default")) as Reasoning[];
  const wanted = list("scenarios");
  const scenarios = wanted ? EVAL_SCENARIOS.filter((s) => wanted.some((w) => s.id.includes(w))) : EVAL_SCENARIOS;
  const seedsRaw = Number(flags.get("seeds") ?? "1");
  const seeds = Number.isFinite(seedsRaw) && seedsRaw >= 1 ? Math.floor(seedsRaw) : 1;

  return { models, profiles, reasoning, scenarios, seeds, focus: !bools.has("no-focus"), judge: !bools.has("no-judge"), dryRun: bools.has("dry-run") };
}

/** Narrator provider options with an optional per-cell reasoning override (probes P1–P3). */
function narratorOptions(modelId: string, reasoning: Reasoning): Record<string, Record<string, JSONValue>> | undefined {
  const base = narrativeProviderOptions(modelId, { sortLatency: true });
  if (reasoning === "default") return base;
  const openrouterOpts: Record<string, JSONValue> = { ...(base?.openrouter ?? {}) };
  openrouterOpts.reasoning = reasoning === "off" ? { enabled: false } : { effort: "low" };
  return { openrouter: openrouterOpts };
}

interface CellMetrics {
  paragraphs: number;
  segments: number;
  distinctSpeakers: number;
  outputTokens: number;
  ttftMs: number;
  totalMs: number;
  provider: string | null;
}

async function streamNarration(
  modelId: string,
  reasoning: Reasoning,
  prompt: { system: string; messages: ModelMessage[] },
  knownNames: string[],
): Promise<{ text: string; metrics: CellMetrics }> {
  const startedAt = Date.now();
  let ttftMs = 0;
  let text = "";
  const result = streamText({
    model: openrouter().chat(modelId),
    system: prompt.system,
    messages: prompt.messages,
    temperature: NARRATIVE_TEMPERATURE,
    providerOptions: narratorOptions(modelId, reasoning),
  });
  for await (const chunk of result.textStream) {
    if (!ttftMs) ttftMs = Date.now() - startedAt;
    text += chunk;
  }
  const totalMs = Date.now() - startedAt;
  const usage = await Promise.resolve(result.usage).catch(() => undefined);
  const meta = await Promise.resolve(result.providerMetadata).catch(() => undefined);
  const segments = parseSegments(text, knownNames);
  const distinctSpeakers = new Set(segments.filter((s) => s.speaker).map((s) => s.speaker)).size;
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).length;
  const outputTokens = usage?.outputTokens ?? Math.round(text.split(/\s+/).filter(Boolean).length / 0.75);
  return { text, metrics: { paragraphs, segments: segments.length, distinctSpeakers, outputTokens, ttftMs, totalMs, provider: routedProvider(meta) } };
}

/**
 * Longitudinal metrics over a multi-turn transcript's reply sequence
 * (narrator-prompt-consolidation.plan.md slice 6) — the failure modes single turns
 * can't show. All deterministic; indicators to read, never a build gate.
 */
interface MultiTurnMetrics {
  turns: number;
  /** Fraction of replies ending on a dialogue question — interview-mode cadence. */
  questionEndRate: number;
  /**
   * Mean fraction of a reply's word 5-grams already seen in EARLIER replies —
   * signature-phrase reuse and re-description creep. First reply seeds; measured
   * from the second on. Noise floor is nonzero (natural connective tissue repeats);
   * read it comparatively across runs, not as an absolute bar.
   */
  repeatedGramRate: number;
  /** Fraction of replies with a person-level sensory reference (SENSORY_CUE_RE). */
  sensoryTurnRate: number;
  avgParagraphs: number;
  maxParagraphs: number;
}

/** Normalized word 5-grams of a reply — the cross-reply repetition vocabulary. */
function wordGrams(text: string, n = 5): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i += 1) grams.add(words.slice(i, i + n).join(" "));
  return grams;
}

function longitudinalMetrics(replies: readonly string[]): MultiTurnMetrics {
  const seen = new Set<string>();
  let repeatedSum = 0;
  let measuredTurns = 0;
  let questionEnds = 0;
  let sensoryTurns = 0;
  const paragraphCounts: number[] = [];
  for (const reply of replies) {
    const grams = wordGrams(reply);
    if (seen.size && grams.size) {
      repeatedSum += [...grams].filter((g) => seen.has(g)).length / grams.size;
      measuredTurns += 1;
    }
    for (const g of grams) seen.add(g);
    if (replyEndsInQuestion(reply)) questionEnds += 1;
    if (SENSORY_CUE_RE.test(reply)) sensoryTurns += 1;
    paragraphCounts.push(reply.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).length);
  }
  const turns = replies.length;
  return {
    turns,
    questionEndRate: turns ? questionEnds / turns : 0,
    repeatedGramRate: measuredTurns ? repeatedSum / measuredTurns : 0,
    sensoryTurnRate: turns ? sensoryTurns / turns : 0,
    avgParagraphs: paragraphCounts.length ? paragraphCounts.reduce((a, b) => a + b, 0) / paragraphCounts.length : 0,
    maxParagraphs: paragraphCounts.length ? Math.max(...paragraphCounts) : 0,
  };
}

interface ResultRow {
  scenario: string;
  lane: string;
  model: string;
  profile: string;
  reasoning: Reasoning;
  /** Replicate index (0-based) — pairs seed-to-seed in compare.ts's contrast axis. */
  seed: number;
  metrics: CellMetrics;
  judgement: Judgement | null;
  narration: string;
  /** Did a `sensoryRelevant` scenario weave in a sensory hook? undefined ⇒ not flagged (not measured). */
  sensoryCue?: boolean;
  /** Did a `povRelevant` scenario narrate in the player's senses (POV_CUE_RE)? Expected Y. undefined ⇒ not flagged. */
  povCue?: boolean;
  /**
   * Did the reply match the scenario's `plantedThoughtRe` — i.e. answer a thought the
   * character couldn't perceive (player-input-perception.plan.md §2)? Expected N; Y is a
   * mind-read. undefined ⇒ no planted token (not measured).
   */
  thoughtLeak?: boolean;
  /**
   * Did the reply come back as a text in the comms output grammar (`commsReplyRe` —
   * `*Character: …*`) for a `*Name: …*` player text (player-input-perception.plan.md
   * slice 4)? Expected Y. undefined ⇒ not a comms scenario (not measured).
   */
  commsReply?: boolean;
  /**
   * Did the reply hit its contrast axis's lexical cue list (CONTRAST_AXES[group].cueRe —
   * the sensoryRelevant pattern)? Expected on the flagged variant, NOT the control.
   * undefined ⇒ not a contrast scenario, or its axis has no cue list (not measured).
   */
  contrastCue?: boolean;
  /**
   * Did the reply reference the planted memory-callback token (the scenario's
   * `callbackRe` — memory-callbacks.plan.md)? Expected Y as a natural aside; the
   * judge expectation guards against a recap. undefined ⇒ no callback planted.
   */
  callbackCue?: boolean;
  /** Longitudinal metrics for a multi-turn (`script`) scenario. undefined ⇒ single-turn. */
  multiTurn?: MultiTurnMetrics;
  error?: string;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

/** Dedicated section for multi-turn rows — longitudinal columns the single-turn table lacks. */
function printMultiTurnTable(rows: ResultRow[]): void {
  const multi = rows.filter((r) => r.multiTurn);
  if (!multi.length) return;
  const header = [
    pad("scenario (multi-turn)", 24),
    pad("model", 9),
    pad("prof", 10),
    pad("turns", 6),
    pad("q-end%", 7),
    pad("repeat%", 8),
    pad("sens%", 6),
    pad("par avg/max", 12),
    pad("tok", 6),
    pad("total", 8),
    "judge",
  ].join(" ");
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const r of multi) {
    const mt = r.multiTurn;
    if (!mt) continue;
    console.log(
      [
        pad(r.scenario, 24),
        pad(shortModel(r.model), 9),
        pad(r.profile, 10),
        pad(mt.turns, 6),
        pad(`${(mt.questionEndRate * 100).toFixed(0)}%`, 7),
        pad(`${(mt.repeatedGramRate * 100).toFixed(1)}%`, 8),
        pad(`${(mt.sensoryTurnRate * 100).toFixed(0)}%`, 6),
        pad(`${mt.avgParagraphs.toFixed(1)}/${mt.maxParagraphs}`, 12),
        pad(r.metrics.outputTokens, 6),
        pad(`${r.metrics.totalMs}ms`, 8),
        r.judgement ? judgeAvg(r.judgement).toFixed(1) : "-",
      ].join(" "),
    );
  }
}

function printTable(rows: ResultRow[]): void {
  const header = [
    pad("scenario", 22),
    pad("model", 9),
    pad("prof", 10),
    pad("rsn", 8),
    pad("par", 4),
    pad("seg", 4),
    pad("spk", 4),
    pad("tok", 5),
    pad("ttft", 6),
    pad("total", 7),
    pad("judge", 6),
    pad("sens", 5),
    pad("pov", 4),
    pad("leak", 5),
    pad("txt", 4),
    pad("cue", 4),
    pad("cbk", 4),
    "provider",
  ].join(" ");
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    if (r.multiTurn) continue; // printed in the dedicated multi-turn section
    if (r.error) {
      console.log(`${pad(r.scenario, 22)} ${pad(shortModel(r.model), 9)} ${pad(r.profile, 10)} ${pad(r.reasoning, 8)} ERROR: ${r.error}`);
      continue;
    }
    const m = r.metrics;
    console.log(
      [
        pad(r.scenario, 22),
        pad(shortModel(r.model), 9),
        pad(r.profile, 10),
        pad(r.reasoning, 8),
        pad(m.paragraphs, 4),
        pad(m.segments, 4),
        pad(m.distinctSpeakers, 4),
        pad(m.outputTokens, 5),
        pad(`${m.ttftMs}ms`, 6),
        pad(`${m.totalMs}ms`, 7),
        pad(r.judgement ? judgeAvg(r.judgement).toFixed(1) : "-", 6),
        pad(r.sensoryCue === undefined ? "-" : r.sensoryCue ? "Y" : "N", 5),
        pad(r.povCue === undefined ? "-" : r.povCue ? "Y" : "N", 4),
        pad(r.thoughtLeak === undefined ? "-" : r.thoughtLeak ? "Y" : "N", 5),
        pad(r.commsReply === undefined ? "-" : r.commsReply ? "Y" : "N", 4),
        pad(r.contrastCue === undefined ? "-" : r.contrastCue ? "Y" : "N", 4),
        pad(r.callbackCue === undefined ? "-" : r.callbackCue ? "Y" : "N", 4),
        m.provider ?? "?",
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cells = args.scenarios.flatMap((scenario) =>
    args.models.flatMap((model) =>
      args.profiles.flatMap((profile) =>
        args.reasoning.flatMap((reasoning) =>
          Array.from({ length: args.seeds }, (_, seed) => ({ scenario, model, profile, reasoning, seed })),
        ),
      ),
    ),
  );

  console.log(
    `narration eval — ${cells.length} cells (${args.scenarios.length} scenarios × ${args.models.length} models × ${args.profiles.length} profiles × ${args.reasoning.length} reasoning × ${args.seeds} seeds)` +
      `${args.focus ? "" : " [no-focus]"}${args.judge ? "" : " [no-judge]"}${args.dryRun ? " [dry-run]" : ""}`,
  );

  if (args.dryRun) {
    for (const { scenario, profile } of args.scenarios.flatMap((s) => args.profiles.map((p) => ({ scenario: s, profile: p })))) {
      console.log(`\n${"=".repeat(80)}\n### ${scenario.id} [${shortProfile(profile)}] (${scenario.lane})\n${"=".repeat(80)}`);
      if (scenario.script?.length) {
        // Multi-turn: show turn 1's system (per-turn volatiles derive from its input) + the script.
        const system = scenario.buildTurnSystem
          ? scenario.buildTurnSystem(profile, scenario.playerInput, [])
          : scenario.build(profile, { focus: args.focus }).system;
        console.log(`\n--- SYSTEM (turn 1${scenario.buildTurnSystem ? "; volatile tail re-derives per turn" : ""}) ---\n${system}`);
        console.log(`\n--- SCRIPT (${1 + scenario.script.length} player turns) ---`);
        for (const [i, input] of [scenario.playerInput, ...scenario.script].entries()) console.log(`${i + 1}. ${input}`);
        continue;
      }
      const { system, messages } = scenario.build(profile, { focus: args.focus });
      console.log(`\n--- SYSTEM ---\n${system}`);
      console.log(`\n--- USER ---\n${messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")}`);
    }
    console.log("\n[dry-run] no model calls made, no spend.");
    return;
  }

  if (isDemoMode()) {
    console.error("OPENROUTER_API_KEY is not set (demo mode). Set it to run live, or use --dry-run to inspect prompts.");
    process.exit(1);
  }

  const rows: ResultRow[] = [];
  for (const { scenario, model, profile, reasoning, seed } of cells) {
    const label = `${scenario.id}${args.seeds > 1 ? `#${seed}` : ""} ${shortModel(model)} ${shortProfile(profile)}/${reasoning}`;
    process.stdout.write(`running ${label} …`);
    try {
      // Multi-turn transcript scenario (narrator-prompt-consolidation slice 6): generate a
      // reply per scripted input, feeding the accumulated exchange back as history — the
      // system prompt is rebuilt per turn when the scenario derives volatile tail lines
      // (sensory allowance, reply gates) from the current input, mirroring the live route.
      if (scenario.script?.length) {
        const inputs = [scenario.playerInput, ...scenario.script];
        const buildTurn = scenario.buildTurnSystem;
        const staticSystem = buildTurn ? "" : scenario.build(profile, { focus: args.focus }).system;
        const messages: ModelMessage[] = [];
        const replies: string[] = [];
        let outputTokens = 0;
        let totalMs = 0;
        let ttftMs = 0;
        for (const input of inputs) {
          const system = buildTurn ? buildTurn(profile, input, replies) : staticSystem;
          messages.push({ role: "user", content: input });
          const turn = await streamNarration(model, reasoning, { system, messages }, scenario.knownNames);
          messages.push({ role: "assistant", content: turn.text });
          replies.push(turn.text);
          outputTokens += turn.metrics.outputTokens;
          totalMs += turn.metrics.totalMs;
          if (!ttftMs) ttftMs = turn.metrics.ttftMs;
        }
        const multiTurn = longitudinalMetrics(replies);
        const transcript = inputs.map((input, i) => `Player: ${input}\n\n${replies[i] ?? ""}`).join("\n\n---\n\n");
        const segments = parseSegments(transcript, scenario.knownNames);
        const judgement = args.judge ? await judgeAbsolute(scenario, transcript) : null;
        rows.push({
          scenario: scenario.id,
          lane: scenario.lane,
          model,
          profile: shortProfile(profile),
          reasoning,
          seed,
          metrics: {
            paragraphs: Math.round(multiTurn.avgParagraphs * 10) / 10,
            segments: segments.length,
            distinctSpeakers: new Set(segments.filter((s) => s.speaker).map((s) => s.speaker)).size,
            outputTokens,
            ttftMs,
            totalMs,
            provider: null,
          },
          judgement,
          narration: transcript,
          multiTurn,
        });
        process.stdout.write(
          ` ${totalMs}ms over ${multiTurn.turns} turns — q-end ${(multiTurn.questionEndRate * 100).toFixed(0)}%, repeat ${(multiTurn.repeatedGramRate * 100).toFixed(1)}%, sensory ${(multiTurn.sensoryTurnRate * 100).toFixed(0)}%${judgement ? `, judge ${judgeAvg(judgement).toFixed(1)}` : ""}\n`,
        );
        continue;
      }

      const prompt = scenario.build(profile, { focus: args.focus });
      const { text, metrics } = await streamNarration(model, reasoning, prompt, scenario.knownNames);
      const judgement = args.judge ? await judgeAbsolute(scenario, text) : null;
      const sensoryCue = scenario.sensoryRelevant ? SENSORY_CUE_RE.test(text) : undefined;
      const povCue = scenario.povRelevant ? POV_CUE_RE.test(text) : undefined;
      const thoughtLeak = scenario.plantedThoughtRe ? scenario.plantedThoughtRe.test(text) : undefined;
      const commsReply = scenario.commsReplyRe ? scenario.commsReplyRe.test(text) : undefined;
      const cueRe = scenario.contrast ? CONTRAST_AXES[scenario.contrast.group].cueRe : undefined;
      const contrastCue = cueRe ? cueRe.test(text) : undefined;
      const callbackCue = scenario.callbackRe ? scenario.callbackRe.test(text) : undefined;
      rows.push({ scenario: scenario.id, lane: scenario.lane, model, profile: shortProfile(profile), reasoning, seed, metrics, judgement, narration: text, sensoryCue, povCue, thoughtLeak, commsReply, contrastCue, callbackCue });
      process.stdout.write(
        ` ${metrics.totalMs}ms${judgement ? ` judge ${judgeAvg(judgement).toFixed(1)}` : ""}${sensoryCue === undefined ? "" : ` sensory ${sensoryCue ? "Y" : "N"}`}${povCue === undefined ? "" : ` pov ${povCue ? "Y" : "N"}`}${thoughtLeak === undefined ? "" : ` leak ${thoughtLeak ? "Y" : "N"}`}${commsReply === undefined ? "" : ` txt ${commsReply ? "Y" : "N"}`}${contrastCue === undefined ? "" : ` cue ${contrastCue ? "Y" : "N"}`}${callbackCue === undefined ? "" : ` cbk ${callbackCue ? "Y" : "N"}`}\n`,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      rows.push({
        scenario: scenario.id,
        lane: scenario.lane,
        model,
        profile: shortProfile(profile),
        reasoning,
        seed,
        metrics: { paragraphs: 0, segments: 0, distinctSpeakers: 0, outputTokens: 0, ttftMs: 0, totalMs: 0, provider: null },
        judgement: null,
        narration: "",
        error,
      });
      process.stdout.write(` ERROR\n`);
    }
  }

  printTable(rows);
  printMultiTurnTable(rows);

  await fs.mkdir(OUT, { recursive: true });
  const outPath = path.join(OUT, "results.json");
  await fs.writeFile(outPath, `${JSON.stringify({ focus: args.focus, judged: args.judge, rows }, null, 2)}\n`);
  console.log(`\nwrote ${rows.length} rows → ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
