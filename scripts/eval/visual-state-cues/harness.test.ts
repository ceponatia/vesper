import { describe, expect, it } from "vitest";
import { evalBaitFamilies, scenarioMatrix } from "./fixtures";
import { emptyCues, emptyMemory, groundTruth, readTurn, stripVisualBlocks, stripVisualCarveOut, buildArmPrompt } from "./harness";

/**
 * The fixture guard for the slice-7 trial (`scripts/eval/visual-state-cues/`).
 *
 * PURE, and it runs in `pnpm test` — the trial itself never does, because it
 * spends money. Its job is to prove the instrument still works before anyone
 * buys a round with it: a projection change that silences the matrix, breaks the
 * splice, or lets a covered body part into a prompt should fail here rather than
 * $1.21 later.
 *
 * These are the same checks `run.ts` runs before its first billable call. They
 * live in both places on purpose: the runner needs them to refuse to spend, and
 * this file needs them so a change lands red in the ordinary gate.
 */

interface Planned {
  readonly scenarioId: string;
  readonly constraints: readonly string[];
  readonly cues: readonly string[];
  readonly visual: string;
  readonly control: string;
}

function plan(): Planned[] {
  return scenarioMatrix.flatMap((scenario) => {
    let cues = emptyCues();
    let memory = emptyMemory();
    return scenario.turns.map((turn, index) => {
      const read = readTurn({ scenario, turn, previousCues: cues, previousMemory: memory });
      cues = read.nextCues;
      memory = read.nextMemory;
      return {
        scenarioId: scenario.id,
        constraints: read.lines.constraints,
        cues: read.lines.cues,
        visual: buildArmPrompt({ scenario, turn, turnIndex: index, lines: read.lines }),
        control: buildArmPrompt({ scenario, turn, turnIndex: index, lines: { constraints: [], cues: [] } }),
      };
    });
  });
}

const planned = plan();

describe("the instrument", () => {
  it("differs between the arms by the two blocks and the carve-out, and nothing else", () => {
    for (const entry of planned) {
      expect(stripVisualCarveOut(stripVisualBlocks(entry.visual))).toBe(entry.control);
    }
  });

  it("puts a must-preserve block on every exchange", () => {
    expect(planned.every((entry) => entry.constraints.length > 0)).toBe(true);
  });

  it("never exceeds the strict cue budget", () => {
    expect(Math.max(...planned.map((entry) => entry.cues.length))).toBeLessThanOrEqual(2);
  });

  it("quiets an unchanged scene by the last exchange", () => {
    for (const scenario of scenarioMatrix) {
      const turns = planned.filter((entry) => entry.scenarioId === scenario.id);
      const first = turns[0]?.cues.length ?? 0;
      const last = turns.at(-1)?.cues.length ?? 0;
      expect(last, scenario.id).toBeLessThanOrEqual(first);
    }
  });

  it("never lets a covered body location into either block", () => {
    for (const scenario of scenarioMatrix) {
      const hidden = Object.entries(scenario.exposure)
        .filter(([, reading]) => reading === "hidden")
        .map(([location]) => location.toLowerCase());
      if (hidden.length === 0) continue;
      for (const entry of planned.filter((row) => row.scenarioId === scenario.id)) {
        for (const line of [...entry.constraints, ...entry.cues]) {
          expect(hidden.some((location) => line.toLowerCase().includes(location)), line).toBe(false);
        }
      }
    }
  });

  it("covers every bait family and arms a bait in every scenario", () => {
    const families = new Set(scenarioMatrix.map((scenario) => scenario.family));
    for (const family of evalBaitFamilies) expect(families.has(family), family).toBe(true);
    for (const scenario of scenarioMatrix) {
      expect(scenario.turns.some((turn) => turn.tempts !== undefined), scenario.id).toBe(true);
    }
  });

  it("keeps the rendered blocks out of the judge's ground truth", () => {
    // The blinding depends on this: a ground-truth block carrying the rendered
    // lines would tell the audit which arm it was grading on sight.
    for (const scenario of scenarioMatrix) {
      const turns = planned.filter((entry) => entry.scenarioId === scenario.id);
      scenario.turns.forEach((turn, index) => {
        const truth = groundTruth({ scenario, turn });
        for (const line of turns[index]?.cues ?? []) expect(truth).not.toContain(line);
      });
    }
  });

  it("is deterministic over one matrix", () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(planned));
  });
});
