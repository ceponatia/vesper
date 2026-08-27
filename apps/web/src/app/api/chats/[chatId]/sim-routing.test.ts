import { describe, expect, it } from "vitest";
import { decideSimOperation, SIM_UNSUPPORTED_CODE, type ChatPostKind } from "./sim-routing";

/**
 * Routing parity decision (ruling 18): every POST kind on a sim-routed chat maps to
 * a successor mode or a refusal — the legacy narrator is never a fallback.
 * Falsified against the old fork, where only a plain send reached the successor
 * engine.
 */
describe("decideSimOperation", () => {
  const plain = { hasAttachments: false, hasAction: false };

  it("maps send to a send turn", () => {
    expect(decideSimOperation({ kind: "send", ...plain })).toEqual({ action: "run", mode: "send" });
  });

  it("maps continue and open to utterance-free turns (ruling 19)", () => {
    expect(decideSimOperation({ kind: "continue", ...plain })).toEqual({ action: "run", mode: "continue" });
    expect(decideSimOperation({ kind: "open", ...plain })).toEqual({ action: "run", mode: "open" });
  });

  it("refuses retakes and message-targeted reruns until the route can prove a committed cut", () => {
    for (const kind of ["regenerate", "rerun"] as ChatPostKind[]) {
      expect(decideSimOperation({ kind, ...plain })).toMatchObject({
        action: "refuse",
        code: SIM_UNSUPPORTED_CODE,
      });
    }
  });

  it("refuses attachments on ANY kind (never the legacy narrator)", () => {
    for (const kind of ["send", "continue", "open", "regenerate", "rerun"] as ChatPostKind[]) {
      const decision = decideSimOperation({ kind, hasAttachments: true, hasAction: false });
      expect(decision).toMatchObject({ action: "refuse", code: SIM_UNSUPPORTED_CODE });
    }
  });

  it("refuses a legacy action chip (action_beat kind or an action payload)", () => {
    expect(decideSimOperation({ kind: "action_beat", hasAttachments: false, hasAction: true })).toMatchObject({
      action: "refuse",
      code: SIM_UNSUPPORTED_CODE,
    });
    // An `action` payload on any other kind is refused too.
    expect(decideSimOperation({ kind: "send", hasAttachments: false, hasAction: true })).toMatchObject({
      action: "refuse",
      code: SIM_UNSUPPORTED_CODE,
    });
  });

  it("prefers the attachment refusal when both are present (deterministic)", () => {
    const decision = decideSimOperation({ kind: "action_beat", hasAttachments: true, hasAction: true });
    expect(decision).toMatchObject({ action: "refuse", code: SIM_UNSUPPORTED_CODE });
  });
});
