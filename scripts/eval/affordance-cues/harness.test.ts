import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  EVAL_BAIT_FAMILIES,
  EVAL_SCENARIOS,
  REMATCH_SCENARIOS,
  scenarioMatrix,
  type EvalScenario,
  type EvalScenarioFamily,
} from "./fixtures";
import { armAuditSchema, AUDIT_DIMENSIONS, judgePrompt, judgeVerdictSchema } from "./judge";
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

function plan(scenario: EvalScenario): Planned {
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

/** Plan a scenario by id within one matrix — the shape `it.each` test names want. */
function planById(scenarios: readonly EvalScenario[], scenarioId: string): Planned {
  const scenario = scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  return plan(scenario);
}

const idsOf = (scenarios: readonly EvalScenario[]): string[] => scenarios.map((scenario) => scenario.id);

const rematchFamily = (family: EvalScenarioFamily): EvalScenario[] =>
  REMATCH_SCENARIOS.filter((scenario) => scenario.family === family);

describe("affordance-cues trial matrix", () => {
  it("covers both arms of the wet/dry × bound/loose × wind/still lattice", () => {
    expect(EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(8);
    expect(EVAL_SCENARIOS.filter((scenario) => scenario.kind === "silence").length).toBeGreaterThanOrEqual(2);
    // Repetition is only measurable across turns.
    for (const scenario of EVAL_SCENARIOS) expect(scenario.turns.length).toBeGreaterThanOrEqual(3);
  });

  it.each(idsOf(EVAL_SCENARIOS.filter((scenario) => scenario.kind === "cue")))(
    "%s offers at least one cue, capped, spliced as one block",
    (scenarioId) => {
      const planned = planById(EVAL_SCENARIOS, scenarioId);
      expect(planned.cueLinesPerTurn.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
      for (const count of planned.cueLinesPerTurn) expect(count).toBeLessThanOrEqual(AFFORDANCE_CUES_PER_EXCHANGE);
      expect(planned.splicedPrompts).toBe(true);
      expect(planned.duplicates).toEqual([]);
    },
  );

  it.each(idsOf(EVAL_SCENARIOS.filter((scenario) => scenario.kind === "silence")))(
    "%s stays silent, and its two arms get byte-identical prompts",
    (scenarioId) => {
      const planned = planById(EVAL_SCENARIOS, scenarioId);
      expect(planned.cueLinesPerTurn).toEqual(planned.cueLinesPerTurn.map(() => 0));
      expect(planned.identicalPrompts).toBe(true);
    },
  );

  it("silences a repeated cue on the very next exchange (the repeat gate, across turns)", () => {
    // Every cue scenario's second exchange leaves the physical state alone, so the
    // gate — not the physics — is what has to produce the silence.
    const repeated = EVAL_SCENARIOS.filter((scenario) => scenario.kind === "cue").filter(
      (scenario) => plan(scenario).cueLinesPerTurn[1] === 0,
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

describe("the rematch matrix — bait + anchor", () => {
  /**
   * The rematch's own self-checks
   * (`docs/developer-notes/body-attribute-affordances.trial.rematch.md`
   * §"Scenario contract"). They are written self-contained here rather than
   * borrowed from `run.ts`, so the fixture half stays provable in `pnpm test`
   * whatever the runner is doing.
   */

  it("is 10–12 scenarios of 3–4 exchanges, with the spec's family spread", () => {
    expect(REMATCH_SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(REMATCH_SCENARIOS.length).toBeLessThanOrEqual(12);
    for (const scenario of REMATCH_SCENARIOS) {
      expect(scenario.turns.length).toBeGreaterThanOrEqual(3);
      expect(scenario.turns.length).toBeLessThanOrEqual(4);
    }
    // State has to be tested across change, not only at rest.
    expect(REMATCH_SCENARIOS.filter((scenario) => scenario.turns.length === 4).length).toBeGreaterThanOrEqual(2);
    for (const family of EVAL_BAIT_FAMILIES) expect(rematchFamily(family).length).toBeGreaterThanOrEqual(1);
    expect(rematchFamily("silence").length).toBeGreaterThanOrEqual(2);
    expect(rematchFamily("invention_control")).toHaveLength(1);
  });

  it.each([
    ["v1", EVAL_SCENARIOS] as const,
    ["rematch", REMATCH_SCENARIOS] as const,
  ])("%s: ids are unique and every exchange has a bait slot", (_name, scenarios) => {
    expect(new Set(idsOf(scenarios)).size).toBe(scenarios.length);
    for (const scenario of scenarios) {
      // One slot per exchange, positional — the runner and the judge both index
      // baits by exchange, so a short array would silently disarm the tail.
      expect(scenario.baits).toHaveLength(scenario.turns.length);
      scenario.baits.forEach((armed, index) => {
        if (armed === null) return;
        expect(armed.exchange).toBe(index + 1);
        expect(armed.tempts.trim().length).toBeGreaterThan(0);
      });
    }
  });

  it("selects the round-1 set for --matrix v1 and the rematch set for --matrix rematch", () => {
    expect(scenarioMatrix("v1")).toBe(EVAL_SCENARIOS);
    expect(scenarioMatrix("rematch")).toBe(REMATCH_SCENARIOS);
    // The silence controls are shared BY IDENTITY, which is what makes their
    // "byte-identical prompts" property survive a matrix change.
    for (const scenario of EVAL_SCENARIOS.filter((entry) => entry.family === "silence")) {
      expect(REMATCH_SCENARIOS).toContain(scenario);
    }
  });

  it("fires at least one cue in every bait family, and clears the round's cue-bearing target", () => {
    let cueBearing = 0;
    for (const family of EVAL_BAIT_FAMILIES) {
      const fired = rematchFamily(family).flatMap((scenario) => plan(scenario).cueLinesPerTurn);
      expect(fired.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    }
    for (const scenario of REMATCH_SCENARIOS) {
      cueBearing += plan(scenario).cueLinesPerTurn.filter((count) => count > 0).length;
    }
    // The rematch spec's target: ≥16 cue-bearing exchanges per round, or the
    // paired comparison has nothing to compare.
    expect(cueBearing).toBeGreaterThanOrEqual(16);
  });

  it.each(idsOf(REMATCH_SCENARIOS.filter((scenario) => scenario.family !== "invention_control")))(
    "%s arms every bait on an exchange that genuinely fires a cue",
    (scenarioId) => {
      // THE core design rule. A bait with no anchor measures the narrator's
      // imagination; only bait ∧ anchor can show the cue arm doing anything.
      const scenario = REMATCH_SCENARIOS.find((entry) => entry.id === scenarioId);
      if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
      const planned = plan(scenario);
      scenario.baits.forEach((armed, index) => {
        if (armed === null) return;
        expect(planned.cueLinesPerTurn[index]).toBeGreaterThan(0);
      });
    },
  );

  it.each(idsOf(REMATCH_SCENARIOS.filter((scenario) => scenario.kind === "cue")))(
    "%s keeps the cap and never restates the prompt's own appearance text",
    (scenarioId) => {
      const planned = planById(REMATCH_SCENARIOS, scenarioId);
      expect(planned.cueLinesPerTurn.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
      for (const count of planned.cueLinesPerTurn) expect(count).toBeLessThanOrEqual(AFFORDANCE_CUES_PER_EXCHANGE);
      expect(planned.splicedPrompts).toBe(true);
      expect(planned.duplicates).toEqual([]);
    },
  );

  it.each(idsOf(rematchFamily("silence")))("%s emits nothing and both arms read identically", (scenarioId) => {
    const planned = planById(REMATCH_SCENARIOS, scenarioId);
    expect(planned.cueLinesPerTurn).toEqual(planned.cueLinesPerTurn.map(() => 0));
    expect(planned.identicalPrompts).toBe(true);
  });

  it("keeps the invention control cue-free, armed on every exchange, and identical in both arms", () => {
    const control = rematchFamily("invention_control")[0];
    if (!control) throw new Error("no invention control");
    const planned = plan(control);
    // Dry under shelter: nothing true to say, so the arms cannot differ. Its
    // baits are armed anyway — unanchored ON PURPOSE, because what it measures
    // is whether the bait tempts the narrator at all.
    expect(planned.cueLinesPerTurn).toEqual(planned.cueLinesPerTurn.map(() => 0));
    expect(planned.identicalPrompts).toBe(true);
    expect(control.baits.filter((armed) => armed !== null).length).toBeGreaterThan(0);
  });

  it("never lets a bath, a standpipe or a wave read as weather", () => {
    // Provenance discipline, mechanically: the rain clause may appear only where
    // a rain cause (or standing precipitation) is genuinely committed.
    for (const scenario of REMATCH_SCENARIOS) {
      const character = scenarioCharacter(scenario);
      let cueMemory = emptyAffordanceCueState();
      scenario.turns.forEach((turn) => {
        const read = readTurn({ character, scenario, turn, previousCues: cueMemory });
        cueMemory = read.nextCues;
        const rainy = read.cueLines.some((line) => line.includes("wet from the rain"));
        if (!rainy) return;
        const rainCause = turn.wetness?.cause === "rain";
        const rainFalling = !turn.environment.indoors && turn.environment.precipitation !== "none";
        expect(rainCause || rainFalling).toBe(true);
      });
    }
  });
});

describe("the judge contract", () => {
  it("serializes both schemas the prompts have to carry", () => {
    // `generateChecked` renders the schema into the system prompt via
    // `z.toJSONSchema`, and swallows a failure as "" — which would silently ship a
    // judge with no output contract at all. Assert both survive the round trip:
    // the per-arm audit (the measurement) and the pairwise preference (advisory).
    const audit = JSON.stringify(z.toJSONSchema(armAuditSchema, { io: "input" }));
    for (const dimension of AUDIT_DIMENSIONS) expect(audit).toContain(dimension);
    expect(audit).toContain("naturalness");
    expect(JSON.stringify(z.toJSONSchema(judgeVerdictSchema, { io: "input" }))).toContain("preferred");
  });

  it("accepts a well-formed audit and rejects an out-of-range score", () => {
    const exchange = {
      exchange: 1,
      wetness_degree: "violated",
      provenance: "clean",
      motion_vs_binding: "not_applicable",
      coverage: "not_applicable",
      adopted_false_premise: "clean",
      quotes: {
        wetness_degree: "her dry hair",
        provenance: "",
        motion_vs_binding: "",
        coverage: "",
        adopted_false_premise: "",
      },
    };
    const arm = {
      exchanges: [exchange],
      repetitions: [],
      staticRestatements: [],
      specificity: 4,
      naturalness: 3,
      physicsReport: false,
      physicsReportWhy: "",
    };
    const parsed = armAuditSchema.parse(arm);
    expect(parsed.exchanges[0]?.wetness_degree).toBe("violated");
    expect(armAuditSchema.safeParse({ ...arm, specificity: 9 }).success).toBe(false);
    // A verdict outside the closed vocabulary is not silently coerced to clean.
    expect(
      armAuditSchema.safeParse({ ...arm, exchanges: [{ ...exchange, coverage: "probably_fine" }] }).success,
    ).toBe(false);
    expect(judgeVerdictSchema.safeParse({ preferred: "A", preferredWhy: "grounded" }).success).toBe(true);
    expect(judgeVerdictSchema.safeParse({ preferred: "neither" }).success).toBe(false);
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
