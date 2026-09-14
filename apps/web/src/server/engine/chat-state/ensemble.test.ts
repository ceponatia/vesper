import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { ChatPersonalNotes } from "@/contracts/turns/chat-archivist";
import { makeProfile } from "@/server/test-support";
import { seedChatState } from "./seed";
import type { ChatState } from "./types";
import type { EnsembleWardrobeReport } from "./finalize-types";
import { applyEnsembleWardrobeProjection, ensembleMemberPersonalNotes } from "./ensemble";
import { presentEnsembleMembers } from "./ensemble-roster";

/**
 * Design #298 — threading the shared continuity leg's grounded garment lane
 * through the ensemble roster. Three small, PURE decisions (no database, no
 * LLM): which present members join the handle enumeration + materialization
 * pass (`presentEnsembleMembers`, shared by `finalize-agents.ts` and
 * `wardrobe-fold.ts`), what worn list a member's settle starts from
 * (`applyEnsembleWardrobeProjection`), and whether their personal pass's own
 * free-text outfit fold must sit out the exchange because a typed operation
 * already moved that wardrobe (`ensembleMemberPersonalNotes`).
 *
 * `chat-garment-ops.int.test.ts` proves the database-backed end-to-end path
 * (the store, the projections, rollback); this file proves these three
 * decisions in isolation.
 *
 * **The defects this file kills**, one per function — each of which a
 * database-backed suite would report only as a confusing final worn list:
 *
 * 1. A member settled from their PRE-exchange worn list while the shared leg
 *    had already moved that wardrobe through the typed dispatcher — the write
 *    then silently reverts the operation the model just proposed
 *    (`applyEnsembleWardrobeProjection`; the guard is that an ABSENT entry
 *    passes the state through untouched rather than blanking it).
 * 2. The same member mutated TWICE in one exchange, once by the typed
 *    operation and again by their personal pass's free-text restatement of it
 *    (`ensembleMemberPersonalNotes`) — and the mirror defect, neutralizing the
 *    free-text fold for a member the lane never enumerated, which would strip
 *    the only wardrobe path they have.
 * 3. The two callers that must share one membership set —
 *    `finalize-agents.ts`'s handle enumeration and `wardrobe-fold.ts`'s
 *    materialization — disagreeing about who is present, so a member gets a
 *    handle they are never materialized for or the reverse
 *    (`presentEnsembleMembers`).
 */

const state = (overrides: Partial<ChatState> = {}): ChatState => ({ ...seedChatState(makeProfile()), ...overrides });

const report = (overrides: Partial<EnsembleWardrobeReport> = {}): EnsembleWardrobeReport => ({
  lane: "none",
  enumeratedCharacterIds: [],
  wornItemIds: {},
  ...overrides,
});

describe("presentEnsembleMembers", () => {
  const roster = [
    { characterId: "primary", name: "Wren", presence: "present" as const, wornItemIds: ["a"] },
    { characterId: "mara", name: "Mara", presence: "present" as const, wornItemIds: ["b"] },
    { characterId: "kira", name: "Kira", presence: "away" as const, wornItemIds: ["c"] },
  ];

  it("keeps present members other than the primary, in roster order", () => {
    expect(presentEnsembleMembers(roster, "primary").map((m) => m.characterId)).toEqual(["mara"]);
  });

  it("drops an away member even though they are in the roster", () => {
    expect(presentEnsembleMembers(roster, "primary").some((m) => m.characterId === "kira")).toBe(false);
  });

  it("never returns the primary, even if a stale roster entry marks them present", () => {
    expect(presentEnsembleMembers(roster, "primary").some((m) => m.characterId === "primary")).toBe(false);
  });

  it("an absent roster (1-on-1) has no present members", () => {
    expect(presentEnsembleMembers(undefined, "primary")).toEqual([]);
  });
});

describe("applyEnsembleWardrobeProjection", () => {
  it("swaps wornItemIds for the exchange's enumerated projection", () => {
    const before = state({ wornItemIds: ["old"] });
    const next = applyEnsembleWardrobeProjection(before, "mara", report({ wornItemIds: { mara: ["new"] } }));
    expect(next.wornItemIds).toEqual(["new"]);
    expect(next).not.toBe(before);
  });

  it("passes the state through untouched when this exchange never modelled the member", () => {
    const before = state({ wornItemIds: ["old"] });
    const next = applyEnsembleWardrobeProjection(before, "mara", report({ wornItemIds: {} }));
    expect(next).toBe(before);
    expect(next.wornItemIds).toEqual(["old"]);
  });
});

describe("ensembleMemberPersonalNotes", () => {
  const notes = (outfit: Partial<ChatPersonalNotes["outfit"]> = {}): ChatPersonalNotes => ({
    openLoops: ["a loop"],
    attributeChanges: [],
    outfit: {
      description: "a red dress",
      changeEvidence: "she puts on a red dress",
      exposed: false,
      removed: [],
      added: [],
      ...outfit,
    },
    driveUpdates: [],
  });

  it("passes a degraded (null) personal pass through untouched", () => {
    const sink = new DiagnosticCollector();
    const out = ensembleMemberPersonalNotes({
      personal: null,
      characterId: "mara",
      characterName: "Mara",
      ensembleWardrobe: report({ lane: "operations", enumeratedCharacterIds: ["mara"] }),
      sink,
    });
    expect(out).toBeNull();
    expect(sink.items).toEqual([]);
  });

  it("leaves the outfit proposal alone under the legacy lane — that IS the free-text bridge", () => {
    const sink = new DiagnosticCollector();
    const personal = notes();
    const out = ensembleMemberPersonalNotes({
      personal,
      characterId: "mara",
      characterName: "Mara",
      ensembleWardrobe: report({ lane: "legacy", enumeratedCharacterIds: ["mara"] }),
      sink,
    });
    expect(out).toBe(personal);
    expect(sink.items).toEqual([]);
  });

  it("leaves it alone under the operations lane when this member was never enumerated", () => {
    const sink = new DiagnosticCollector();
    const personal = notes();
    const out = ensembleMemberPersonalNotes({
      personal,
      characterId: "mara",
      characterName: "Mara",
      ensembleWardrobe: report({ lane: "operations", enumeratedCharacterIds: ["someone-else"] }),
      sink,
    });
    expect(out).toBe(personal);
    expect(sink.items).toEqual([]);
  });

  it("neutralizes the outfit proposal and files the one info diagnostic when the lane enumerated this member", () => {
    const sink = new DiagnosticCollector();
    const personal = notes();
    const out = ensembleMemberPersonalNotes({
      personal,
      characterId: "mara",
      characterName: "Mara",
      ensembleWardrobe: report({ lane: "operations", enumeratedCharacterIds: ["mara"] }),
      sink,
    });
    expect(out).toEqual({
      ...personal,
      outfit: { description: "", changeEvidence: "", exposed: false, removed: [], added: [] },
    });
    // Everything else about the personal pass still folds — only the outfit rung sits out.
    expect(out?.openLoops).toEqual(["a loop"]);
    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]?.code).toBe("chat_garments.ensemble_outfit_typed_lane");
    expect(sink.items[0]?.message).toContain("Mara");
  });
});
