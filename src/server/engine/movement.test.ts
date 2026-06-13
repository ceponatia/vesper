import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { stagedIntentSchema, type StagedIntent } from "@/contracts/state/session-runtime";
import { applyStagedIntents, nextHopToward } from "./movement";
import type { SceneLinkInput } from "./scene";

function link(fromId: string, toId: string, extra: Partial<SceneLinkInput> = {}): SceneLinkInput {
  return { fromId, toId, ...extra };
}
const noDoors = () => null;
const codes = (sink: DiagnosticCollector) => sink.items.map((d) => d.code);

function intent(over: Partial<StagedIntent> = {}): StagedIntent {
  return stagedIntentSchema.parse({
    id: "si1",
    participantId: "p1",
    destinationLocationId: "D",
    onArrival: { comms: { kind: "text", gist: "here" } },
    openedAtTurn: 0,
    expiresInTurns: 6,
    ...over,
  });
}

describe("nextHopToward", () => {
  const chain = [link("A", "B"), link("B", "C"), link("C", "D")];

  it("returns the first hop toward the destination, one node at a time", () => {
    const base = { links: chain, doorStateForLink: noDoors, minuteOfDay: 540, moverParticipantId: "p1" };
    expect(nextHopToward({ ...base, fromId: "A", toId: "D" })).toEqual({ kind: "hop", nextId: "B", travelMinutes: 1 });
    expect(nextHopToward({ ...base, fromId: "B", toId: "D" })).toEqual({ kind: "hop", nextId: "C", travelMinutes: 1 });
    expect(nextHopToward({ ...base, fromId: "C", toId: "D" })).toEqual({ kind: "hop", nextId: "D", travelMinutes: 1 });
  });

  it("is already there when from === to", () => {
    expect(nextHopToward({ fromId: "A", toId: "A", links: chain, doorStateForLink: noDoors, minuteOfDay: 0, moverParticipantId: "p1" })).toEqual({
      kind: "arrived",
    });
  });

  it("takes the shortest branch", () => {
    // A-B (dead end) and A-C-D — the hop toward D is C, not B.
    const branch = [link("A", "B"), link("A", "C"), link("C", "D")];
    expect(nextHopToward({ fromId: "A", toId: "D", links: branch, doorStateForLink: noDoors, minuteOfDay: 0, moverParticipantId: "p1" })).toEqual({
      kind: "hop",
      nextId: "C",
      travelMinutes: 1,
    });
  });

  it("carries the link's travelMinutes", () => {
    const weighted = [link("A", "B", { travelMinutes: 7 })];
    expect(nextHopToward({ fromId: "A", toId: "B", links: weighted, doorStateForLink: noDoors, minuteOfDay: 0, moverParticipantId: "p1" })).toEqual({
      kind: "hop",
      nextId: "B",
      travelMinutes: 7,
    });
  });

  it("never walks a locked-only route (no_path)", () => {
    const locked = [link("A", "B", { access: { kind: "locked" } })];
    expect(nextHopToward({ fromId: "A", toId: "B", links: locked, doorStateForLink: noDoors, minuteOfDay: 0, moverParticipantId: "p1" })).toEqual({
      kind: "no_path",
    });
  });

  it("respects a closed time window", () => {
    const window = [link("A", "B", { access: { kind: "timeWindow", start: 600, end: 700 } })];
    const at = (minuteOfDay: number) =>
      nextHopToward({ fromId: "A", toId: "B", links: window, doorStateForLink: noDoors, minuteOfDay, moverParticipantId: "p1" });
    expect(at(800)).toEqual({ kind: "no_path" }); // closed
    expect(at(650)).toEqual({ kind: "hop", nextId: "B", travelMinutes: 1 }); // open
  });

  it("a closed+locked bound door seals the link", () => {
    const doored = [link("A", "B", { doorItemId: "door1" })];
    expect(
      nextHopToward({ fromId: "A", toId: "B", links: doored, doorStateForLink: () => ({ locked: true, open: false }), minuteOfDay: 0, moverParticipantId: "p1" }),
    ).toEqual({ kind: "no_path" });
  });

  it("returns no_path for a disconnected destination", () => {
    expect(nextHopToward({ fromId: "A", toId: "Z", links: chain, doorStateForLink: noDoors, minuteOfDay: 0, moverParticipantId: "p1" })).toEqual({
      kind: "no_path",
    });
  });
});

describe("applyStagedIntents", () => {
  const chain = [link("A", "B"), link("B", "C"), link("C", "D")];

  /** Drive ticks, applying returned moves so the next tick sees the new location (what the merge does). */
  function driver(intents: StagedIntent[], start: string | null, links = chain) {
    let current = intents;
    let loc: string | null = start;
    const tick = (turnNumber: number, sink?: DiagnosticCollector) => {
      const r = applyStagedIntents({
        intents: current,
        locationByParticipant: new Map([["p1", loc]]),
        knownParticipantIds: new Set(["p1"]),
        links,
        doorStateForLink: noDoors,
        minuteOfDay: 540,
        turnNumber,
        sink,
      });
      current = r.intents;
      for (const m of r.moves) if (m.participantId === "p1") loc = m.toLocationId;
      return r;
    };
    return { tick, location: () => loc, intents: () => current };
  }

  it("advances exactly one hop per tick, fires once on arrival, then resolves", () => {
    const d = driver([intent()], "A");

    const t1 = d.tick(1);
    expect(t1.moves).toEqual([{ participantId: "p1", fromLocationId: "A", toLocationId: "B", destinationLocationId: "D", reachedDestination: false }]);
    expect(t1.fired).toEqual([]);
    expect(d.intents()).toHaveLength(1); // still travelling

    const t2 = d.tick(2);
    expect(t2.moves[0]?.toLocationId).toBe("C");
    expect(t2.fired).toEqual([]);

    const t3 = d.tick(3);
    expect(t3.moves[0]).toMatchObject({ toLocationId: "D", reachedDestination: true });
    expect(t3.fired).toEqual([{ participantId: "p1", comms: { kind: "text", gist: "here", urgency: "normal" }, directive: undefined }]);
    expect(d.intents()).toHaveLength(0); // resolved → pruned

    const t4 = d.tick(4);
    expect(t4.moves).toEqual([]);
    expect(t4.fired).toEqual([]); // never fires twice
  });

  it("commitment: stable inputs always advance toward the destination, never oscillate", () => {
    const d = driver([intent()], "A");
    const visited: string[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      const r = d.tick(turn);
      if (r.moves[0]) visited.push(r.moves[0].toLocationId);
    }
    expect(visited).toEqual(["B", "C", "D"]);
  });

  it("fires immediately and resolves when already at the destination", () => {
    const d = driver([intent()], "D");
    const r = d.tick(1);
    expect(r.moves).toEqual([]);
    expect(r.fired).toHaveLength(1);
    expect(d.intents()).toHaveLength(0);
  });

  it("cancels an unreachable destination with merge.movement.unreachable", () => {
    const locked = [link("A", "B", { access: { kind: "locked" } })];
    const sink = new DiagnosticCollector();
    const d = driver([intent({ destinationLocationId: "B" })], "A", locked);
    const r = d.tick(1, sink);
    expect(r.moves).toEqual([]);
    expect(r.fired).toEqual([]);
    expect(d.intents()).toHaveLength(0); // cancelled → pruned
    expect(codes(sink)).toContain("merge.movement.unreachable");
  });

  it("gives up after the budget with merge.movement.intent_expired", () => {
    const sink = new DiagnosticCollector();
    const d = driver([intent({ openedAtTurn: 0, expiresInTurns: 2 })], "A");
    const r = d.tick(2, sink); // turn 2 - opened 0 >= budget 2
    expect(r.moves).toEqual([]);
    expect(d.intents()).toHaveLength(0);
    expect(codes(sink)).toContain("merge.movement.intent_expired");
  });

  it("drops an orphaned intent (participant gone) with merge.movement.intent_orphaned", () => {
    const sink = new DiagnosticCollector();
    const r = applyStagedIntents({
      intents: [intent()],
      locationByParticipant: new Map(),
      knownParticipantIds: new Set(), // p1 is gone
      links: chain,
      doorStateForLink: noDoors,
      minuteOfDay: 0,
      turnNumber: 1,
      sink,
    });
    expect(r.intents).toEqual([]);
    expect(r.moves).toEqual([]);
    expect(codes(sink)).toContain("merge.movement.intent_orphaned");
  });

  it("fires the directive payload alongside (or instead of) comms", () => {
    const d = driver([intent({ destinationLocationId: "B", onArrival: { directive: "Maya is at her door, locked out." } })], "A");
    const r = d.tick(1);
    expect(r.fired).toEqual([{ participantId: "p1", comms: undefined, directive: "Maya is at her door, locked out." }]);
  });
});
