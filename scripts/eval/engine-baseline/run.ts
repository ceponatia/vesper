import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { streamText, type ModelMessage } from "ai";
import { isDemoMode, narrativeProviderOptions, openrouter, routedProvider } from "../../../src/server/ai";
import type { NarrationShapeId } from "../../../src/server/engine/prompts/constants";
import {
  GATE0_CORPUS_VERSION,
  gate0Cases,
  serializableGate0Corpus,
  type Gate0Case,
} from "./cases";
import {
  evaluateGate0Quality,
  summarizeGate0Rows,
  type Gate0LegEvidence,
  type Gate0ResultRow,
} from "./report";

const DEFAULT_OUT = process.env.EVAL_OUT || "data/eval/engine-baseline";
const DEFAULT_MODEL = process.env.EVAL_NARRATOR_MODEL || "aion-labs/aion-2.0";
const PROFILE: NarrationShapeId = "concise_immersive";
const TEMPERATURE = 0.2;

interface Args {
  caseIds?: string[];
  dryRun: boolean;
  model: string;
  out: string;
  replay?: string;
  seeds: number;
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
  const seedsRaw = Number(flags.get("seeds") ?? "3");
  const seeds = Number.isFinite(seedsRaw) && seedsRaw >= 1 ? Math.floor(seedsRaw) : 3;
  const selected = flags.get("case")?.split(",").map((id) => id.trim()).filter(Boolean);
  return {
    ...(selected?.length ? { caseIds: selected } : {}),
    dryRun: bools.has("dry-run"),
    model: flags.get("model") ?? DEFAULT_MODEL,
    out: flags.get("out") ?? DEFAULT_OUT,
    ...(flags.get("replay") ? { replay: flags.get("replay") } : {}),
    seeds,
  };
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const estimatedTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function narratorLeg(
  model: string,
  prompt: { system: string; messages: ModelMessage[] },
  knownNames: readonly string[],
): Promise<{ transcript: string; leg: Gate0LegEvidence }> {
  const startedAt = Date.now();
  let ttftMs = 0;
  let transcript = "";
  try {
    const result = streamText({
      model: openrouter().chat(model),
      system: prompt.system,
      messages: prompt.messages,
      temperature: TEMPERATURE,
      providerOptions: narrativeProviderOptions(model, { sortLatency: true }),
    });
    for await (const chunk of result.textStream) {
      if (!ttftMs) ttftMs = Date.now() - startedAt;
      transcript += chunk;
    }

    const totalMs = Date.now() - startedAt;
    const usage = await Promise.resolve(result.usage).catch(() => undefined);
    const metadata = await Promise.resolve(result.providerMetadata).catch(() => undefined);
    const promptText = `${prompt.system}\n${JSON.stringify(prompt.messages)}`;
    const providerTokens =
      typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number";
    const promptTokens = usage?.inputTokens ?? estimatedTokens(promptText);
    const completionTokens = usage?.outputTokens ?? estimatedTokens(transcript);
    const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;

    return {
      transcript,
      leg: {
        id: "narrator",
        model,
        attemptedCalls: 1,
        promptTokens,
        completionTokens,
        totalTokens,
        tokenSource: providerTokens ? "provider" : "estimated",
        ttftMs,
        totalMs,
        provider: routedProvider(metadata),
        degraded: transcript.trim().length === 0,
        ...(transcript.trim().length === 0 ? { error: "provider returned an empty narration" } : {}),
      },
    };
  } catch (error) {
    return {
      transcript,
      leg: {
        id: "narrator",
        model,
        attemptedCalls: 1,
        promptTokens: estimatedTokens(`${prompt.system}\n${JSON.stringify(prompt.messages)}`),
        completionTokens: estimatedTokens(transcript),
        totalTokens: 0,
        tokenSource: "estimated",
        ttftMs,
        totalMs: Date.now() - startedAt,
        provider: null,
        degraded: true,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    void knownNames;
  }
}

function buildPrompt(caseDef: Gate0Case): { system: string; messages: ModelMessage[]; sha256: string } {
  const prompt = caseDef.scenario.build(PROFILE, { focus: true });
  return {
    ...prompt,
    sha256: sha256(`${prompt.system}\n${JSON.stringify(prompt.messages)}`),
  };
}

async function runCase(caseDef: Gate0Case, model: string, seed: number): Promise<Gate0ResultRow> {
  const prompt = buildPrompt(caseDef);
  const { transcript, leg } = await narratorLeg(model, prompt, caseDef.scenario.knownNames);
  return {
    caseId: caseDef.definition.id,
    title: caseDef.scenario.title,
    lane: caseDef.scenario.lane,
    seed,
    authoredSetup: {
      expectation: caseDef.scenario.expectation,
      knownNames: [...caseDef.scenario.knownNames],
      authoredReaction: caseDef.scenario.authoredReaction ?? null,
    },
    inputMessages: [...prompt.messages],
    deterministicStateBefore: caseDef.definition.deterministicStateBefore,
    deterministicStateAfter: caseDef.definition.deterministicStateAfter,
    prompt: { system: prompt.system, messages: [...prompt.messages], sha256: prompt.sha256 },
    transcript,
    legs: [leg],
    automatedQuality: evaluateGate0Quality(caseDef.definition, transcript),
    manualReview: {
      contradiction: null,
      perspectiveLeak: null,
      hardEffectRepair: null,
      note: "",
    },
  };
}

function corpusEnvelope(cases: readonly Gate0Case[]): {
  corpus: unknown;
  corpusHash: string;
} {
  const corpus = serializableGate0Corpus(cases);
  return { corpus, corpusHash: sha256(JSON.stringify(corpus)) };
}

function printSummary(rows: readonly Gate0ResultRow[]): void {
  const summary = summarizeGate0Rows(rows);
  console.log("\nGate 0 baseline summary");
  console.log(
    [
      `rows ${summary.successfulRows}/${summary.rows}`,
      `calls ${summary.attemptedModelCalls}`,
      `degraded legs ${summary.degradedLegs}`,
      `latency p50/p95 ${summary.latencyMs.p50}ms/${summary.latencyMs.p95}ms`,
      `tokens prompt/completion ${summary.promptTokens}/${summary.completionTokens}`,
    ].join(" · "),
  );
  console.log(
    [
      `contradictions ${summary.automatedQuality.contradiction.hits}/${summary.automatedQuality.contradiction.checked}`,
      `perspective leaks ${summary.automatedQuality.perspectiveLeak.hits}/${summary.automatedQuality.perspectiveLeak.checked}`,
      `hard-effect repairs ${summary.automatedQuality.hardEffectRepair.hits}/${summary.automatedQuality.hardEffectRepair.checked}`,
      `required-cue misses ${summary.automatedQuality.requiredCueMiss.hits}/${summary.automatedQuality.requiredCueMiss.checked}`,
      `manual fields pending ${summary.manualReview.pending}`,
    ].join(" · "),
  );
}

async function replay(filePath: string, out: string): Promise<void> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { rows?: unknown };
  if (!Array.isArray(parsed.rows)) throw new Error("replay file has no rows array");
  const cases = gate0Cases();
  const byId = new Map(cases.map((item) => [item.definition.id, item.definition]));
  const rows = (parsed.rows as Gate0ResultRow[]).map((row) => {
    const definition = byId.get(row.caseId);
    if (!definition) throw new Error(`replay row names unknown case: ${row.caseId}`);
    return { ...row, automatedQuality: evaluateGate0Quality(definition, row.transcript) };
  });
  const result = {
    ...parsed,
    replayedAt: new Date().toISOString(),
    rows,
    summary: summarizeGate0Rows(rows),
  };
  const outPath = path.join(out, "replayed-results.json");
  await writeJson(outPath, result);
  printSummary(rows);
  console.log(`wrote replay → ${outPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.replay) {
    await replay(args.replay, args.out);
    return;
  }

  const cases = gate0Cases(args.caseIds);
  const envelope = corpusEnvelope(cases);
  const prompts = cases.map((item) => {
    const prompt = buildPrompt(item);
    return {
      caseId: item.definition.id,
      title: item.scenario.title,
      lane: item.scenario.lane,
      inputMessages: prompt.messages,
      deterministicStateBefore: item.definition.deterministicStateBefore,
      deterministicStateAfter: item.definition.deterministicStateAfter,
      prompt,
    };
  });

  if (args.dryRun) {
    const outPath = path.join(args.out, "manifest.json");
    await writeJson(outPath, {
      schemaVersion: 1,
      corpusVersion: GATE0_CORPUS_VERSION,
      ...envelope,
      configuration: { model: args.model, profile: PROFILE, temperature: TEMPERATURE, seeds: args.seeds },
      prompts,
    });
    console.log(`[dry-run] wrote ${prompts.length} pinned cases → ${outPath}; no model calls made`);
    return;
  }

  if (isDemoMode()) {
    throw new Error("OPENROUTER_API_KEY is not set; use --dry-run to inspect the pinned corpus without spend");
  }

  const rows: Gate0ResultRow[] = [];
  for (const item of cases) {
    for (let seed = 0; seed < args.seeds; seed += 1) {
      process.stdout.write(`running ${item.definition.id}#${seed} … `);
      const row = await runCase(item, args.model, seed);
      rows.push(row);
      const leg = row.legs[0];
      console.log(leg?.degraded ? `DEGRADED ${leg.error ?? ""}` : `${leg?.totalMs ?? 0}ms`);
    }
  }

  const summary = summarizeGate0Rows(rows);
  const result = {
    schemaVersion: 1,
    corpusVersion: GATE0_CORPUS_VERSION,
    ...envelope,
    generatedAt: new Date().toISOString(),
    configuration: { model: args.model, profile: PROFILE, temperature: TEMPERATURE, seeds: args.seeds },
    rows,
    summary,
  };
  const outPath = path.join(args.out, "results.json");
  await writeJson(outPath, result);
  printSummary(rows);
  console.log(`wrote ${rows.length} evidence rows → ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
