import { z } from "zod";
import { describe, expect, it } from "vitest";
import { EVAL_SCENARIOS } from "./fixtures";
import { judgePrompt, judgeVerdictSchema } from "./judge";
import {
  AFFORDANCE_CUES_PER_EXCHANGE,
  buildArmPrompt,
  CUE_HEADING,
  cueDuplicatesPrompt,
  emptyAffordanceCueState,
  hairOverlap,
  hairSentences,
  readTurn,
  scenarioCharacter,
  stripCueBlock,
  stripCueCarveOut,
} from "./harness";

/**
 * The trial's fixture guard: everything about the matrix that must hold BEFORE
 * any money is spent, proved without a single model call.
 *
 * The live run (`run.ts`) re-runs these same assertions as `selfChecks` and
 * refuses to generate if any fails — this file is the version that runs in
 * `pnpm test`, so a calibration change that silently stops the matrix firing
 * (or starts it firing in the silence controls) shows up as a red test rather
 * than as a confusing trial result months later.
 */

interface Planned {
  cueLinesPerTurn: number[];
  identicalPrompts: boolean;
  splicedPrompts: boolean;
  duplicates: string[];
}

function plan(scenarioId: string): Planned {
  const scenario = EVAL_SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  const character = scenarioCharacter(scenario);
  let cueMemory = emptyAffordanceCueState();
  const cueLinesPerTurn: number[] = [];
  const duplicates: string[] = [];
  let identicalPrompts = true;
  let splicedPrompts = true;
  scenario.turns.forEach((turn, turnIndex) => {
    const read = readTurn({ character, scenario, turn, previousCues: cueMemory });
    cueMemory = read.nextCues;
    const cues = buildArmPrompt({ character, scenario, turn, turnIndex, cueLines: read.cueLines });
    const control = buildArmPrompt({ character, scenario, turn, turnIndex, cueLines: [] });
    cueLinesPerTurn.push(read.cueLines.length);
    duplicates.push(...cueDuplicatesPrompt(cues, read.cueLines));
    if (read.cueLines.length === 0) {
      if (cues !== control) identicalPrompts = false;
    } else {
      // The cue arm differs from control by exactly the block plus (on a
      // `none`-allowance turn) the allowance line's "cues win" carve-out.
      if (stripCueCarveOut(stripCueBlock(cues), character.name) !== control) splicedPrompts = false;
    }
  });
  return { cueLinesPerTurn, identicalPrompts, splicedPrompts, duplicates };
}

describe("affordance-cues trial matrix", () => {
  it("covers both arms of the wet/dry × bound/loose × wind/still lattice", () => {
    expect(EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(8);
    expect(EVAL_SCENARIOS.filter((scenario) => scenario.kind === "silence").length).toBeGreaterThanOrEqual(2);
    // Repetition is only measurable across turns.
    for (const scenario of EVAL_SCENARIOS) expect(scenario.turns.length).toBeGreaterThanOrEqual(3);
  });

  it.each(EVAL_SCENARIOS.filter((scenario) => scenario.kind === "cue").map((scenario) => scenario.id))(
    "%s offers at least one cue, capped, spliced as one block",
    (scenarioId) => {
      const planned = plan(scenarioId);
      expect(planned.cueLinesPerTurn.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
      for (const count of planned.cueLinesPerTurn) expect(count).toBeLessThanOrEqual(AFFORDANCE_CUES_PER_EXCHANGE);
      expect(planned.splicedPrompts).toBe(true);
      expect(planned.duplicates).toEqual([]);
    },
  );

  it.each(EVAL_SCENARIOS.filter((scenario) => scenario.kind === "silence").map((scenario) => scenario.id))(
    "%s stays silent, and its two arms get byte-identical prompts",
    (scenarioId) => {
      const planned = plan(scenarioId);
      expect(planned.cueLinesPerTurn).toEqual(planned.cueLinesPerTurn.map(() => 0));
      expect(planned.identicalPrompts).toBe(true);
    },
  );

  it("silences a repeated cue on the very next exchange (the repeat gate, across turns)", () => {
    // Every cue scenario's second exchange leaves the physical state alone, so the
    // gate — not the physics — is what has to produce the silence.
    const repeated = EVAL_SCENARIOS.filter((scenario) => scenario.kind === "cue").filter(
      (scenario) => plan(scenario.id).cueLinesPerTurn[1] === 0,
    );
    expect(repeated.length).toBeGreaterThanOrEqual(6);
  });

  it("renders the cue block under the heading the prompt builder owns", () => {
    const scenario = EVAL_SCENARIOS[0];
    if (!scenario) throw new Error("no scenarios");
    const character = scenarioCharacter(scenario);
    const turn = scenario.turns[0];
    if (!turn) throw new Error("no turns");
    const read = readTurn({ character, scenario, turn, previousCues: emptyAffordanceCueState() });
    const prompt = buildArmPrompt({ character, scenario, turn, turnIndex: 0, cueLines: read.cueLines });
    expect(prompt).toContain(CUE_HEADING);
    // After removing the block AND the allowance carve-out that names it
    // (owner ruling 2026-07-28: "cues win"), the heading is gone entirely.
    expect(stripCueCarveOut(stripCueBlock(prompt), character.name)).not.toContain(CUE_HEADING);
  });
});

describe("the judge contract", () => {
  it("serializes to a JSON Schema the prompt can carry", () => {
    // `generateChecked` renders the schema into the system prompt via
    // `z.toJSONSchema`, and swallows a failure as "" — which would silently ship a
    // judge with no output contract at all. Assert it survives the round trip.
    const schema = z.toJSONSchema(judgeVerdictSchema, { io: "input" });
    expect(JSON.stringify(schema)).toContain("contradictions");
    expect(JSON.stringify(schema)).toContain("naturalness");
  });

  it("accepts a well-formed verdict and rejects an out-of-range score", () => {
    const arm = {
      contradictions: [{ turn: 1, quote: "her dry hair", why: "the state says soaked" }],
      repetitions: [],
      staticRestatements: [],
      specificity: 4,
      naturalness: 3,
      physicsReport: false,
      physicsReportWhy: "",
    };
    const parsed = judgeVerdictSchema.parse({ A: arm, B: arm, preferred: "A", preferredWhy: "grounded" });
    expect(parsed.A.contradictions).toHaveLength(1);
    expect(judgeVerdictSchema.safeParse({ A: { ...arm, specificity: 9 }, B: arm, preferred: "tie" }).success).toBe(false);
  });

  it("renders both arms and the ground truth, and never leaks the cue lines", () => {
    const prompt = judgePrompt({
      scenarioTitle: "t",
      premise: "p",
      characterName: "Wren",
      playerName: "Sam",
      modelId: "x",
      exchanges: [{ index: 1, player: "hello", groundTruth: "Hair: soaked.", a: "reply-a", b: "reply-b" }],
    });
    expect(prompt).toContain("TRANSCRIPT A");
    expect(prompt).toContain("TRANSCRIPT B");
    expect(prompt).toContain("Hair: soaked.");
    // The blinding depends on the cue block never reaching the judge.
    expect(prompt).not.toContain("Physical detail worth noticing");
  });
});

describe("model-free repetition proxy", () => {
  it("finds the hair sentences and ignores the rest", () => {
    const reply = "She laughed at that. Damp strands stuck to her collar. The kettle went off.";
    expect(hairSentences(reply)).toEqual(["Damp strands stuck to her collar."]);
  });

  it("scores a verbatim hair repeat high and an unrelated pair at zero", () => {
    const first = "Damp strands clung to her collar.";
    const repeat = "Damp strands clung to her collar again.";
    const different = "She shoved her braid back over one shoulder, dry as paper.";
    expect(hairOverlap(first, repeat) ?? 0).toBeGreaterThan(0.6);
    expect(hairOverlap(first, different) ?? 1).toBeLessThan(0.2);
  });

  it("returns null when either exchange said nothing about hair", () => {
    expect(hairOverlap("She laughed.", "Damp strands clung to her collar.")).toBeNull();
  });
});
