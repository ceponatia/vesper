import { describe, expect, it } from "vitest";
import {
  applyDriveUpdates,
  chatDrivesSchema,
  driveWithheld,
  drivesSchema,
  seedChatDrives,
  type ChatDrive,
} from "./drives";

const secret = (over: Partial<ChatDrive> = {}): ChatDrive => ({
  want: "to reopen the gallery under her own name",
  why: "",
  secrecy: "secret",
  progress: "",
  revealed: false,
  resolved: false,
  ...over,
});

describe("drive schemas", () => {
  it("caps at 3, defaults secrecy open, and parses empty clean", () => {
    expect(drivesSchema.parse(undefined)).toEqual([]);
    const parsed = drivesSchema.parse([
      { want: "a" }, { want: "b" }, { want: "c" }, { want: "d" },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.secrecy).toBe("open");
    expect(chatDrivesSchema.parse("garbage")).toEqual([]);
  });

  it("seeds runtime drives with fresh progress/revealed/resolved", () => {
    const seeded = seedChatDrives([{ want: "a", why: "b", secrecy: "secret", revealBand: undefined }]);
    expect(seeded[0]).toEqual({ want: "a", why: "b", secrecy: "secret", revealBand: undefined, progress: "", revealed: false, resolved: false });
  });

  it("drops a bad entry alone — one empty want never wipes the authored list", () => {
    const parsed = drivesSchema.parse([{ want: "a real want" }, { want: "" }]);
    expect(parsed).toEqual([{ want: "a real want", why: "", secrecy: "open" }]);
    const chat = chatDrivesSchema.parse([secret(), { want: "" }]);
    expect(chat).toEqual([secret()]);
  });

  it("truncates over-length text at the caps instead of dropping or wiping (forge-gaps gap 5)", () => {
    const parsed = drivesSchema.parse([{ want: "w".repeat(500), why: "y".repeat(500) }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.want).toBe("w".repeat(120));
    expect(parsed[0]?.why).toBe("y".repeat(200));
    const chat = chatDrivesSchema.parse([{ ...secret(), progress: "p".repeat(500) }]);
    expect(chat[0]?.progress).toBe("p".repeat(200));
  });

  it("still heals a non-string why to empty without failing the row", () => {
    const parsed = drivesSchema.parse([{ want: "a want", why: 42 }]);
    expect(parsed).toEqual([{ want: "a want", why: "", secrecy: "open" }]);
  });
});

describe("driveWithheld (the reveal gate)", () => {
  it("defaults a secret to familiarity ≥ familiar (ruled) and clears at the band", () => {
    expect(driveWithheld(secret(), { regard: 100, familiarity: 54 })).toBe(true);
    expect(driveWithheld(secret(), { regard: -50, familiarity: 55 })).toBe(false);
  });

  it("honors an authored regard gate, degrades an unknown band to the default", () => {
    const regardGated = secret({ revealBand: { axis: "regard", band: "close" } });
    expect(driveWithheld(regardGated, { regard: 64, familiarity: 100 })).toBe(true);
    expect(driveWithheld(regardGated, { regard: 65, familiarity: 0 })).toBe(false);
    const bogus = secret({ revealBand: { axis: "familiarity", band: "not-a-band" } });
    expect(driveWithheld(bogus, { regard: 0, familiarity: 55 })).toBe(false);
  });

  it("never withholds open/guarded/revealed drives", () => {
    expect(driveWithheld(secret({ secrecy: "open" }), { regard: -100, familiarity: 0 })).toBe(false);
    expect(driveWithheld(secret({ secrecy: "guarded" }), { regard: -100, familiarity: 0 })).toBe(false);
    expect(driveWithheld(secret({ revealed: true }), { regard: -100, familiarity: 0 })).toBe(false);
  });
});

describe("applyDriveUpdates", () => {
  it("matches by normalized want, folds progress/reveal/resolve, reports new reveals", () => {
    const drives = [secret(), secret({ want: "to leave town", secrecy: "open" })];
    const { drives: next, revealed } = applyDriveUpdates(drives, [
      { want: "To Reopen The Gallery Under Her Own Name", progress: "told the landlord", revealed: true, resolved: false },
      { want: "unknown drive", progress: "x", revealed: true, resolved: false },
    ]);
    expect(next[0]?.progress).toBe("told the landlord");
    expect(next[0]?.revealed).toBe(true);
    expect(revealed).toHaveLength(1); // only the matched secret; unknown wants drop
    // A second identical reveal is not "newly revealed" again.
    expect(applyDriveUpdates(next, [{ want: drives[0]!.want, progress: "", revealed: true, resolved: false }]).revealed).toHaveLength(0);
  });

  it("empty updates keep the drives untouched", () => {
    const drives = [secret()];
    const out = applyDriveUpdates(drives, []);
    expect(out.drives).toEqual(drives);
    expect(out.revealed).toEqual([]);
  });
});
