import { describe, expect, it } from "vitest";
import type { ChatDrive } from "@/contracts/personality/drives";
import { buildInitiativeCue } from "./chat-initiative";

const drive = (over: Partial<ChatDrive> = {}): ChatDrive => ({
  want: "to reopen the gallery",
  why: "",
  secrecy: "open",
  progress: "",
  revealed: false,
  resolved: false,
  ...over,
});

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
});
