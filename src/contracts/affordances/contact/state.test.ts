import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { CONTACT_LIFECYCLE_INVALID } from "./diagnostics";
import { commitContactResolution, emptyContactLifecycleState, type ContactLifecycleState } from "./lifecycle";
import { resolveContactAttempt } from "./resolve";
import { parseContactLifecycleState } from "./state";
import { PROBE_EVENT, probeAttempt } from "./test-support";

function seededState(): ContactLifecycleState {
  const resolution = resolveContactAttempt(probeAttempt({ intent: { requestedPressure: "light" } }));
  if (resolution.status !== "committable") throw new Error("fixture did not commit");
  return commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef: PROBE_EVENT }).state;
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

describe("stored contact state", () => {
  it("round-trips a committed contact through JSON", () => {
    const state = seededState();
    const parsed = parseContactLifecycleState(JSON.parse(JSON.stringify(state)));
    expect(parsed).toEqual(state);
  });

  it("degrades a blob it cannot read at all to nothing touching", () => {
    const sink = new DiagnosticCollector();
    expect(parseContactLifecycleState("not a state", sink)).toEqual(emptyContactLifecycleState());
    expect(parseContactLifecycleState(null)).toEqual(emptyContactLifecycleState());
    expect(parseContactLifecycleState(undefined)).toEqual(emptyContactLifecycleState());
  });

  it("drops an unreadable contact and says so, rather than voiding the whole blob", () => {
    const sink = new DiagnosticCollector();
    const state = seededState();
    const raw = { ...JSON.parse(JSON.stringify(state)) } as { contacts: unknown[] };
    raw.contacts = [...raw.contacts, { phase: "active", contactId: "" }];
    const parsed = parseContactLifecycleState(raw, sink);
    expect(parsed.contacts).toHaveLength(1);
    expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
    expect(sink.hasErrors).toBe(true);
  });

  it("never repairs a corrupt magnitude into a physical claim", () => {
    const state = seededState();
    const raw = JSON.parse(JSON.stringify(state)) as { contacts: { pressure: string }[] };
    const contact = raw.contacts[0];
    if (contact === undefined) throw new Error("fixture is empty");
    contact.pressure = "crushing";
    expect(parseContactLifecycleState(raw).contacts).toEqual([]);
  });

  it("refuses to read a version it was not written for", () => {
    const sink = new DiagnosticCollector();
    const raw = { ...JSON.parse(JSON.stringify(seededState())), version: 99 };
    expect(parseContactLifecycleState(raw, sink)).toEqual(emptyContactLifecycleState());
    expect(codes(sink)).toEqual([CONTACT_LIFECYCLE_INVALID]);
  });

  it("keeps one contact per surface pair", () => {
    const state = seededState();
    const raw = JSON.parse(JSON.stringify(state)) as { contacts: unknown[] };
    raw.contacts = [...raw.contacts, ...raw.contacts];
    const parsed = parseContactLifecycleState(raw);
    expect(parsed.contacts).toHaveLength(1);
  });

  it("files no diagnostic for an empty projection", () => {
    const sink = new DiagnosticCollector();
    parseContactLifecycleState(emptyContactLifecycleState(), sink);
    expect(sink.items).toEqual([]);
  });
});
