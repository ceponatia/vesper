import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import {
  checkLinkAccess,
  defaultLinkAccess,
  linkAccessSchema,
  withinMinuteWindow,
  type LinkAccess,
} from "./access";

describe("linkAccessSchema", () => {
  it("parses every access kind", () => {
    expect(linkAccessSchema.parse({ kind: "public" })).toEqual({ kind: "public" });
    expect(linkAccessSchema.parse({ kind: "private" })).toEqual({ kind: "private", ownerParticipantIds: [] });
    expect(linkAccessSchema.parse({ kind: "locked", keyItemId: "key-1" })).toEqual({ kind: "locked", keyItemId: "key-1" });
    expect(linkAccessSchema.parse({ kind: "timeWindow", start: 540, end: 1020 })).toEqual({
      kind: "timeWindow",
      start: 540,
      end: 1020,
    });
  });

  it("degrades malformed jsonb to public with a diagnostic (trust boundary)", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseOr(linkAccessSchema, { kind: "vault", combination: 1234 }, defaultLinkAccess(), sink, "session_links.access");
    expect(parsed).toEqual({ kind: "public" });
    expect(sink.items.some((d) => d.code === "parse.boundary_failed")).toBe(true);
  });
});

describe("withinMinuteWindow", () => {
  it("plain windows are [start, end)", () => {
    expect(withinMinuteWindow(540, 540, 1020)).toBe(true);
    expect(withinMinuteWindow(1019, 540, 1020)).toBe(true);
    expect(withinMinuteWindow(1020, 540, 1020)).toBe(false);
    expect(withinMinuteWindow(120, 540, 1020)).toBe(false);
  });

  it("wraps past midnight when start > end", () => {
    expect(withinMinuteWindow(1380, 1320, 360)).toBe(true); // 23:00 in a 22:00–06:00 window
    expect(withinMinuteWindow(120, 1320, 360)).toBe(true); // 02:00
    expect(withinMinuteWindow(720, 1320, 360)).toBe(false); // noon
  });

  it("a zero-length window degrades to no restriction", () => {
    expect(withinMinuteWindow(0, 0, 0)).toBe(true);
    expect(withinMinuteWindow(720, 300, 300)).toBe(true);
  });
});

describe("checkLinkAccess", () => {
  const at = (access: LinkAccess, minuteOfDay = 600) => checkLinkAccess({ access, minuteOfDay });

  it("public passes", () => {
    expect(at({ kind: "public" })).toEqual({ passable: true });
  });

  it("private has no player effect in v1 (discourages future NPC pathing only)", () => {
    expect(at({ kind: "private", ownerParticipantIds: ["p-1"] })).toEqual({ passable: true });
  });

  it("locked blocks — even a key-holder (keyItemId reserved)", () => {
    const verdict = at({ kind: "locked", keyItemId: "key-1" });
    expect(verdict.passable).toBe(false);
    if (!verdict.passable) expect(verdict.kind).toBe("locked");
  });

  it("timeWindow passes inside and blocks outside, wrapping past midnight", () => {
    const tavernHours: LinkAccess = { kind: "timeWindow", start: 1080, end: 120 }; // 18:00–02:00
    expect(checkLinkAccess({ access: tavernHours, minuteOfDay: 1200 }).passable).toBe(true); // 20:00
    expect(checkLinkAccess({ access: tavernHours, minuteOfDay: 60 }).passable).toBe(true); // 01:00
    const blocked = checkLinkAccess({ access: tavernHours, minuteOfDay: 600 }); // 10:00
    expect(blocked.passable).toBe(false);
    if (!blocked.passable) expect(blocked.kind).toBe("time_window");
  });

  it("a bound door that is closed and locked seals even a public link", () => {
    const verdict = checkLinkAccess({ access: { kind: "public" }, minuteOfDay: 600, door: { open: false, locked: true } });
    expect(verdict.passable).toBe(false);
    if (!verdict.passable) expect(verdict.kind).toBe("door_locked");
  });

  it("a door that is open, or closed but unlocked, does not block", () => {
    expect(checkLinkAccess({ access: { kind: "public" }, minuteOfDay: 600, door: { open: true, locked: true } }).passable).toBe(true);
    expect(checkLinkAccess({ access: { kind: "public" }, minuteOfDay: 600, door: { open: false } }).passable).toBe(true);
    expect(checkLinkAccess({ access: { kind: "public" }, minuteOfDay: 600, door: {} }).passable).toBe(true);
  });
});
