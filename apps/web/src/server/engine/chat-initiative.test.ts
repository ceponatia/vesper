import { describe, expect, it } from "vitest";
import { drive } from "@/server/test-support";
import { buildInitiativeCue } from "./chat-initiative";

describe("buildInitiativeCue (chat-initiative.plan.md)", () => {
  const base = { characterName: "Mara", playerName: "Theo", openLoops: [], drives: [], skipPending: false };

  it("hands her the opening move with her own material (loops + non-secret wants)", () => {
    const cue = buildInitiativeCue({
      ...base,
      openLoops: ["hear how the wedding toast went", "the borrowed book"],
      drives: [drive(), drive({ want: "a hidden debt", secrecy: "secret" })],
    });
    expect(cue).toContain("reach out FIRST");
    expect(cue).toContain('unfinished business: "hear how the wedding toast went"');
    expect(cue).toContain('something you want: "to reopen the gallery"');
    // Withheld secrets never leak into the opener cue — the tail law owns them.
    expect(cue).not.toContain("a hidden debt");
  });

  it("licenses ONE life-meanwhile beat, skip-aware, and sets the comms-when-apart register", () => {
    const skipped = buildInitiativeCue({ ...base, skipPending: true });
    expect(skipped).toContain("Time has passed");
    expect(skipped).toContain("ONE small, concrete thing from your life meanwhile");
    const fresh = buildInitiativeCue(base);
    expect(fresh).toContain("from your own day");
    expect(fresh).toContain("*Mara: your words*");
    expect(fresh).toContain("Do not narrate Theo");
  });

  it("a revealed secret becomes usable material; empty state still opens", () => {
    const cue = buildInitiativeCue({ ...base, drives: [drive({ secrecy: "secret", revealed: true, want: "to leave town" })] });
    expect(cue).toContain('something you want: "to leave town"');
    expect(buildInitiativeCue(base)).toContain("open with what YOU are doing");
  });

  it("an unseen shift (§8.4 v2) joins her material; absent ⇒ the pre-slice-2 cue byte-identical", () => {
    const shifted = buildInitiativeCue({ ...base, recentShift: "Warm → close" });
    expect(shifted).toContain('what just shifted between you: "Warm → close"');
    expect(buildInitiativeCue({ ...base, recentShift: null })).toBe(buildInitiativeCue(base));
    expect(buildInitiativeCue({ ...base, recentShift: "  " })).toBe(buildInitiativeCue(base));
  });

  it("the authored rhythm grounds the life-meanwhile license; empty rhythm adds nothing", () => {
    const cue = buildInitiativeCue({ ...base, rhythm: "mornings: waiting tables at the Dockside Café" });
    expect(cue).toContain("Your usual rhythm");
    expect(cue).toContain("mornings: waiting tables at the Dockside Café");
    expect(buildInitiativeCue({ ...base, rhythm: "" })).toBe(buildInitiativeCue(base));
  });

  it("extraversion colors the opener cadence (slice 5); mid/absent adds nothing", () => {
    expect(buildInitiativeCue({ ...base, extraversion: 70 })).toContain("comes easily to you");
    expect(buildInitiativeCue({ ...base, extraversion: -70 })).toContain("doesn't come naturally to you");
    expect(buildInitiativeCue({ ...base, extraversion: 0 })).toBe(buildInitiativeCue(base));
  });
});
