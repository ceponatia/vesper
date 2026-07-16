import { describe, expect, it } from "vitest";
import {
  EVAL_SCENARIOS,
  POST_SHOWER_GROUNDING,
  PRE_SHOWER_GROUNDING,
} from "./fixtures";

const buildPair = () => {
  const pair = EVAL_SCENARIOS.filter((scenario) => scenario.contrast?.group === "grounding");
  const flagged = pair.find((scenario) => scenario.contrast?.variant === "flagged");
  const control = pair.find((scenario) => scenario.contrast?.variant === "control");
  if (!flagged || !control) throw new Error("grounding contrast pair is incomplete");
  return { pair, flagged, control };
};

describe("Gate 0 grounded-context ablation", () => {
  it("has exactly one flagged/control pair with byte-identical player input", () => {
    const { pair, flagged, control } = buildPair();
    expect(pair).toHaveLength(2);
    expect(flagged.playerInput).toBe(control.playerInput);
  });

  it("changes only the deterministic redacted context value in the assembled prompt", () => {
    const { flagged, control } = buildPair();
    const before = flagged.build("concise_immersive", { focus: true });
    const after = control.build("concise_immersive", { focus: true });

    expect(before.messages).toEqual(after.messages);
    expect(before.system).toContain(PRE_SHOWER_GROUNDING);
    expect(before.system).not.toContain(POST_SHOWER_GROUNDING);
    expect(after.system).toContain(POST_SHOWER_GROUNDING);
    expect(after.system).not.toContain(PRE_SHOWER_GROUNDING);

    expect(before.system.replace(PRE_SHOWER_GROUNDING, "<grounded-context>")).toBe(
      after.system.replace(POST_SHOWER_GROUNDING, "<grounded-context>"),
    );
  });
});
