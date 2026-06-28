import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { streamText, type JSONValue, type ModelMessage } from "ai";
import { z } from "zod";
import { generateChecked, isDemoMode, narrativeProviderOptions, openrouter, routedProvider } from "../../../src/server/ai";
import type { NarrationShapeId } from "../../../src/server/engine/prompts/constants";
import { parseSegments } from "../../../src/server/engine/segmenter";
import { EVAL_SCENARIOS, type EvalScenario } from "./fixtures";

/**
 * Behavioral eval harness for narration (narrator-prompt-focus.plan.md §Behavioral
 * eval harness). LIVE OpenRouter spend — **never** wired into `pnpm verify` / CI.
 * For each cell of (scenario × model × shape profile × reasoning) it assembles the
 * real prompt (fixtures.ts), streams the narrator, computes deterministic metrics
 * (paragraphs / segments / distinct speakers / tokens / TTFT / latency / routed
 * provider via segmenter.parseSegments), and — unless --no-judge — scores it 1–5 on
 * the rubric with an LLM judge. Prints a table and writes results JSON.
 *
 *   pnpm eval:narration                       # default: aion narrator, both profiles, judge on
 *   pnpm eval:narration --models aion,glm,owl --reasoning default,off,low
 *   pnpm eval:narration --scenarios hi,compliment --profiles concise --no-judge
 *   pnpm eval:narration --no-focus            # strip the §Phase-3 planner (Phase-2 A/B)
 *   pnpm eval:narration --dry-run             # assemble + print prompts, no model calls, no spend
 *
 * The harness MEASURES; a low score is a signal to iterate prompt wording, never a
 * build failure. It automates the interim manual eval + probes P1–P3.
 */

const OUT = process.env.EVAL_OUT || "data/eval/narration";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || "z-ai/glm-5.2";
const NARRATIVE_TEMPERATURE = 0.8;

const MODEL_ALIASES: Record<string, string> = {
  aion: "aion-labs/aion-2.0",
  glm: "z-ai/glm-5.2",
  owl: "openrouter/owl-alpha",
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

  return { models, profiles, reasoning, scenarios, focus: !bools.has("no-focus"), judge: !bools.has("no-judge"), dryRun: bools.has("dry-run") };
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

const judgeSchema = z.object({
  answeredFirst: z.number().int().min(1).max(5).catch(3),
  proportionate: z.number().int().min(1).max(5).catch(3),
  onBeat: z.number().int().min(1).max(5).catch(3),
  noUnrequestedLogistics: z.number().int().min(1).max(5).catch(3),
  voice: z.number().int().min(1).max(5).catch(3),
  note: z.string().catch(""),
});
type Judgement = z.infer<typeof judgeSchema>;

const JUDGE_SYSTEM =
  "You are a strict evaluator of interactive-fiction narration. Score the narration 1–5 on each rubric dimension (1 = fails badly, 5 = excellent). " +
  "Be harsh about over-rewarding/doting and topic sprawl. Output only the structured scores and a one-line note.";

function judgePrompt(scenario: EvalScenario, narration: string): string {
  return [
    `Scenario: ${scenario.title}`,
    `Player input: ${scenario.playerInput}`,
    `What a good response does: ${scenario.expectation}`,
    scenario.authoredReaction ? `Authored reaction verdict (proportionality must match this, not exceed it):\n${scenario.authoredReaction}` : "",
    "",
    "Rubric (1–5 each):",
    "- answeredFirst: does the opening directly address the player's input before any new business?",
    "- proportionate: is the emotional reaction proportionate (not doting/over-rewarding ordinary input)?",
    "- onBeat: does it stay on the player's beat without unrelated topic sprawl?",
    "- noUnrequestedLogistics: free of unrequested errands/logistics/thread-reminder dumps?",
    "- voice: distinct, in-character, vivid prose?",
    "",
    "Narration to score:",
    narration,
  ]
    .filter(Boolean)
    .join("\n");
}

async function judge(scenario: EvalScenario, narration: string): Promise<Judgement | null> {
  const r = await generateChecked<Judgement>({
    schema: judgeSchema,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(scenario, narration),
    modelId: JUDGE_MODEL,
    temperature: 0,
    maxOutputTokens: 500,
    code: "eval.judge",
  });
  return r.value;
}

interface ResultRow {
  scenario: string;
  lane: string;
  model: string;
  profile: string;
  reasoning: Reasoning;
  metrics: CellMetrics;
  judgement: Judgement | null;
  narration: string;
  error?: string;
}

const judgeAvg = (j: Judgement): number =>
  (j.answeredFirst + j.proportionate + j.onBeat + j.noUnrequestedLogistics + j.voice) / 5;

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
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
    "provider",
  ].join(" ");
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const r of rows) {
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
        m.provider ?? "?",
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cells = args.scenarios.flatMap((scenario) =>
    args.models.flatMap((model) =>
      args.profiles.flatMap((profile) => args.reasoning.map((reasoning) => ({ scenario, model, profile, reasoning }))),
    ),
  );

  console.log(
    `narration eval — ${cells.length} cells (${args.scenarios.length} scenarios × ${args.models.length} models × ${args.profiles.length} profiles × ${args.reasoning.length} reasoning)` +
      `${args.focus ? "" : " [no-focus]"}${args.judge ? "" : " [no-judge]"}${args.dryRun ? " [dry-run]" : ""}`,
  );

  if (args.dryRun) {
    for (const { scenario, profile } of args.scenarios.flatMap((s) => args.profiles.map((p) => ({ scenario: s, profile: p })))) {
      const { system, messages } = scenario.build(profile, { focus: args.focus });
      console.log(`\n${"=".repeat(80)}\n### ${scenario.id} [${shortProfile(profile)}] (${scenario.lane})\n${"=".repeat(80)}`);
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
  for (const { scenario, model, profile, reasoning } of cells) {
    const label = `${scenario.id} ${shortModel(model)} ${shortProfile(profile)}/${reasoning}`;
    process.stdout.write(`running ${label} …`);
    try {
      const prompt = scenario.build(profile, { focus: args.focus });
      const { text, metrics } = await streamNarration(model, reasoning, prompt, scenario.knownNames);
      const judgement = args.judge ? await judge(scenario, text) : null;
      rows.push({ scenario: scenario.id, lane: scenario.lane, model, profile: shortProfile(profile), reasoning, metrics, judgement, narration: text });
      process.stdout.write(` ${metrics.totalMs}ms${judgement ? ` judge ${judgeAvg(judgement).toFixed(1)}` : ""}\n`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      rows.push({
        scenario: scenario.id,
        lane: scenario.lane,
        model,
        profile: shortProfile(profile),
        reasoning,
        metrics: { paragraphs: 0, segments: 0, distinctSpeakers: 0, outputTokens: 0, ttftMs: 0, totalMs: 0, provider: null },
        judgement: null,
        narration: "",
        error,
      });
      process.stdout.write(` ERROR\n`);
    }
  }

  printTable(rows);

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
