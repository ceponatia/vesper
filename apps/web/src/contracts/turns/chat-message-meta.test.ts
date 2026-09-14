import { describe, expect, it } from "vitest";

import { DiagnosticCollector } from "../diagnostics";
import {
  CHAT_MESSAGE_META_BAG_INVALID,
  CHAT_MESSAGE_META_KEYS,
  CHAT_MESSAGE_META_FIELD_INVALID,
  CHAT_MESSAGE_META_VERSION,
  assistantReplyMeta,
  emptyChatMessageMeta,
  isEmptyChatMessageMeta,
  isNarratorInput,
  isWorldBeat,
  mergeChatMessageMeta,
  parseChatMessageMeta,
  serializeChatMessageMeta,
  successorReplyMeta,
  userLineMeta,
  worldBeatMeta,
} from "./chat-message-meta";

/**
 * A narrator-run provenance record, structurally valid for
 * `narratorRunProvenanceSchema`. Only its survival across a parse/merge matters
 * here — the Prompt Lab owns what the fields mean.
 */
const provenance = {
  lane: "legacy_chat" as const,
  modelId: "model/test",
  promptSource: "production" as const,
  instructionHash: "abc123",
  assembledSystemHash: "def456",
  authorityWeights: {},
  mode: "instruction_override_v1" as const,
};

/**
 * Every key the column carries today, with the role that writes it — the
 * inventory this contract exists to hold. A key added to the module without a row
 * here is a key nothing proves survives a round trip.
 */
const INVENTORY: ReadonlyArray<{ role: "user" | "assistant"; key: string; value: unknown }> = [
  { role: "assistant", key: "v", value: 2 },
  { role: "user", key: "attachments", value: { ids: ["img_1", "img_2"], descriptions: ["a cat", "a hat"] } },
  { role: "user", key: "inputMode", value: "narrator" },
  { role: "user", key: "simTurn", value: true },
  { role: "assistant", key: "actionBeat", value: "drink" },
  { role: "assistant", key: "stopped", value: true },
  { role: "assistant", key: "narratorRun", value: provenance },
  { role: "assistant", key: "simTurn", value: true },
  { role: "assistant", key: "simOpening", value: true },
  { role: "assistant", key: "solo", value: true },
  { role: "assistant", key: "cutId", value: "cut_42" },
  { role: "assistant", key: "modelId", value: "model/test" },
  { role: "assistant", key: "attempts", value: 2 },
  { role: "assistant", key: "confirmStatus", value: "confirmed" },
  { role: "assistant", key: "worldBeat", value: { kind: "traveled" } },
  { role: "assistant", key: "compositionFallbacks", value: ["traveled_alone"] },
  {
    role: "assistant",
    key: "renderDiagnostics",
    value: [{ severity: "warn", code: "sim.solo.degraded", message: "fell back" }],
  },
];

describe("parseChatMessageMeta — the inventory", () => {
  it("covers every key the contract models", () => {
    // Derived from the schema table, not hand-copied: a field added to the module
    // without a row above fails here rather than shipping unproven.
    expect([...CHAT_MESSAGE_META_KEYS].sort()).toEqual([...new Set(INVENTORY.map((e) => e.key))].sort());
  });

  it.each(INVENTORY)("round-trips $key on a $role row", ({ key, value }) => {
    const parsed = parseChatMessageMeta({ [key]: value });
    expect(parsed[key as keyof typeof parsed]).toEqual(value);
    // Serializing the parse reproduces the stored bag exactly — no key invented,
    // none dropped, and nothing moved into `extra`.
    expect(serializeChatMessageMeta(parsed)).toEqual({ [key]: value });
    expect(parsed.extra).toEqual({});
  });

  it("parses a whole bag with every inventoried key at once", () => {
    const bag = Object.fromEntries(INVENTORY.map((entry) => [entry.key, entry.value]));
    const sink = new DiagnosticCollector();
    expect(serializeChatMessageMeta(parseChatMessageMeta(bag, sink))).toEqual(bag);
    expect(sink.items).toEqual([]);
  });
});

describe("parseChatMessageMeta — per-field degradation", () => {
  it("drops ONLY the malformed field and names it in the diagnostic", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseChatMessageMeta(
      { attachments: "not-an-object", inputMode: "narrator", simTurn: true, narratorRun: provenance },
      sink,
    );

    expect(parsed.attachments).toBeUndefined();
    // The siblings survive — this is the whole point. A corrupt attachment bag
    // must never turn a saved narrator line back into player speech.
    expect(parsed.inputMode).toBe("narrator");
    expect(parsed.simTurn).toBe(true);
    expect(parsed.narratorRun).toEqual(provenance);

    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]?.severity).toBe("warn");
    expect(sink.items[0]?.code).toBe(CHAT_MESSAGE_META_FIELD_INVALID);
    expect(sink.items[0]?.context).toEqual({ field: "attachments" });
  });

  it("degrades a malformed inputMode to unknown — which reads as player input — and says so", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseChatMessageMeta({ inputMode: "storyteller", attachments: { ids: ["img_1"] } }, sink);

    // The fallback is never a positive claim: unknown is not "the player said it",
    // it is "we could not tell" — and the diagnostic is what makes that countable.
    expect(parsed.inputMode).toBeUndefined();
    expect(isNarratorInput(parsed)).toBe(false);
    expect(parsed.attachments).toEqual({ ids: ["img_1"] });
    expect(sink.items.map((d) => d.code)).toEqual([CHAT_MESSAGE_META_FIELD_INVALID]);
    expect(sink.items[0]?.context).toEqual({ field: "inputMode" });
  });

  it("reports one diagnostic per malformed field", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseChatMessageMeta({ attempts: "two", cutId: "", stopped: true }, sink);

    expect(parsed.attempts).toBeUndefined();
    expect(parsed.cutId).toBeUndefined();
    expect(parsed.stopped).toBe(true);
    expect(sink.items.map((d) => d.context?.field).sort()).toEqual(["attempts", "cutId"]);
  });

  it("degrades a non-object bag to the empty meta with a diagnostic", () => {
    for (const raw of ["nonsense", 7, true, ["a"]]) {
      const sink = new DiagnosticCollector();
      expect(parseChatMessageMeta(raw, sink)).toEqual(emptyChatMessageMeta());
      expect(sink.items.map((d) => d.code)).toEqual([CHAT_MESSAGE_META_BAG_INVALID]);
    }
  });

  it("never throws on any schema-legal stored value", () => {
    for (const raw of [undefined, null, {}, [], "", "{", '{"a":', 0, { attachments: null }, { worldBeat: 3 }]) {
      expect(() => parseChatMessageMeta(raw, new DiagnosticCollector())).not.toThrow();
    }
  });

  it("parses a jsonb value handed back as raw JSON text", () => {
    const parsed = parseChatMessageMeta('{"inputMode":"narrator","stopped":true}');
    expect(parsed.inputMode).toBe("narrator");
    expect(parsed.stopped).toBe(true);
  });
});

describe("parseChatMessageMeta — legacy rows", () => {
  it("reads a versionless row as version 1 without stamping one", () => {
    const parsed = parseChatMessageMeta({ stopped: true });
    expect(parsed.v).toBeUndefined();
    expect(CHAT_MESSAGE_META_VERSION).toBe(1);
    // Absent MEANS 1, so a rewrite must not start writing it.
    expect(serializeChatMessageMeta(parsed)).toEqual({ stopped: true });
  });

  it("carries a HIGHER stored version forward rather than downgrading the row", () => {
    const parsed = parseChatMessageMeta({ v: 2, stopped: true });
    expect(parsed.v).toBe(2);
    expect(serializeChatMessageMeta(parsed)).toEqual({ v: 2, stopped: true });
  });

  it("writes back a stored v: 1 exactly as read, so parse -> serialize is byte-stable", () => {
    // The `jsonb ||` write path leaves a stored `v` alone; dropping it here would
    // make the two write paths disagree about the same row.
    expect(serializeChatMessageMeta(parseChatMessageMeta({ v: 1, stopped: true }))).toEqual({
      v: 1,
      stopped: true,
    });
  });

  const legacy: ReadonlyArray<[string, unknown]> = [
    ["an empty bag", {}],
    ["a null bag", null],
    ["an absent bag", undefined],
  ];
  it.each(legacy)("parses %s to the documented defaults, silently", (_label, raw) => {
    const sink = new DiagnosticCollector();
    const parsed = parseChatMessageMeta(raw, sink);
    expect(parsed).toEqual(emptyChatMessageMeta());
    expect(isEmptyChatMessageMeta(parsed)).toBe(true);
    expect(isNarratorInput(parsed)).toBe(false);
    expect(isWorldBeat(parsed)).toBe(false);
    // Absent is legal, never an error — an empty row must not spam the inspector.
    expect(sink.items).toEqual([]);
  });

  it("treats an explicit JSON null on a modelled key as absent, silently", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseChatMessageMeta({ worldBeat: null, inputMode: null, stopped: true }, sink);
    expect(parsed.worldBeat).toBeUndefined();
    expect(parsed.inputMode).toBeUndefined();
    expect(parsed.stopped).toBe(true);
    expect(sink.items).toEqual([]);
  });
});

describe("unknown keys", () => {
  it("survives parse -> merge -> serialize untouched", () => {
    const sink = new DiagnosticCollector();
    const stored = { inputMode: "narrator", futureField: { deep: [1, 2] }, anotherOne: "keep me" };

    const parsed = parseChatMessageMeta(stored, sink);
    expect(parsed.extra).toEqual({ futureField: { deep: [1, 2] }, anotherOne: "keep me" });
    // An unmodelled key is carried, never inspected — so it never degrades.
    expect(sink.items).toEqual([]);

    const merged = mergeChatMessageMeta(parsed, { stopped: true });
    expect(serializeChatMessageMeta(merged)).toEqual({ ...stored, stopped: true });
  });

  it("survives a writer that rewrites the whole bag from its own fields", () => {
    // The older-reader-meets-newer-deploy case: this writer models none of the
    // stored keys and must still not destroy them.
    const parsed = parseChatMessageMeta({ v: 2, unseenByThisDeploy: "value", cutId: "cut_1" });
    const rewritten = mergeChatMessageMeta(parsed, { cutId: "cut_2", modelId: "model/test" });
    expect(serializeChatMessageMeta(rewritten)).toEqual({
      v: 2,
      unseenByThisDeploy: "value",
      cutId: "cut_2",
      modelId: "model/test",
    });
  });

  it("carries an unknown key NESTED in an owned object through parse -> merge -> serialize", () => {
    // `attachments` and `worldBeat` are this module's own shapes, so a field a newer
    // deploy adds inside one survives an older reader's write-through.
    const stored = {
      attachments: { ids: ["img_1"], altText: ["a cat on a mat"] },
      worldBeat: { kind: "traveled", distanceM: 400 },
    };
    const merged = mergeChatMessageMeta(parseChatMessageMeta(stored), { stopped: true });
    expect(serializeChatMessageMeta(merged)).toEqual({ ...stored, stopped: true });
  });

  it("round-trips an unknown key that happens to be named `extra`", () => {
    const parsed = parseChatMessageMeta({ extra: { nested: true }, stopped: true });
    expect(parsed.extra).toEqual({ extra: { nested: true } });
    expect(serializeChatMessageMeta(parsed)).toEqual({ extra: { nested: true }, stopped: true });
  });
});

describe("unreadable fields are quarantined, never deleted", () => {
  it("keeps an unparseable value on the row while hiding it from the typed view", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseChatMessageMeta({ attempts: "two", stopped: true }, sink);

    // The consumer sees the absent-field default...
    expect(parsed.attempts).toBeUndefined();
    expect(sink.items.map((d) => d.code)).toEqual([CHAT_MESSAGE_META_FIELD_INVALID]);
    // ...and the row keeps the bytes.
    expect(serializeChatMessageMeta(parsed)).toEqual({ attempts: "two", stopped: true });
  });

  it("survives a display-only rewrite — the take-switch data-loss regression", () => {
    // `switchReplyTake` parses, merges one key and writes the whole bag back. If an
    // unreadable field were dropped rather than quarantined, that read-only-looking
    // operation would permanently delete durable data written by a newer deploy.
    const stored = { inputMode: "a-register-this-build-does-not-know", narratorRun: provenance };
    const rewritten = mergeChatMessageMeta(parseChatMessageMeta(stored), { narratorRun: undefined });
    expect(serializeChatMessageMeta(rewritten)).toEqual({
      inputMode: "a-register-this-build-does-not-know",
    });
  });

  it("lets a patch that names the key replace its quarantined value", () => {
    const parsed = parseChatMessageMeta({ inputMode: "storyteller" });
    const merged = mergeChatMessageMeta(parsed, { inputMode: "narrator" });
    // One value for one key — never the fresh one beside the unreadable one.
    expect(serializeChatMessageMeta(merged)).toEqual({ inputMode: "narrator" });
  });
});

describe("mergeChatMessageMeta", () => {
  it("keeps unrelated keys when one key is updated — the attachments-overwrite regression", () => {
    // The live defect: persisting the vision read REPLACED the whole bag, dropping
    // `inputMode`, so a rerun of a saved narrator line came back as player speech.
    const existing = parseChatMessageMeta({ inputMode: "narrator", attachments: { ids: ["img_1"] }, simTurn: true });
    const merged = mergeChatMessageMeta(existing, {
      attachments: { ids: ["img_1"], descriptions: ["a cat"] },
    });

    expect(merged.inputMode).toBe("narrator");
    expect(merged.simTurn).toBe(true);
    expect(merged.attachments).toEqual({ ids: ["img_1"], descriptions: ["a cat"] });
  });

  it("removes a field when the patch names it with undefined", () => {
    const existing = parseChatMessageMeta({ narratorRun: provenance, stopped: true, cutId: "cut_1" });
    const merged = mergeChatMessageMeta(existing, { narratorRun: undefined });

    // A take switch onto an unlabelled take must CLEAR the displayed run rather
    // than leave it describing prose that is no longer on the row.
    expect(merged.narratorRun).toBeUndefined();
    expect(merged.stopped).toBe(true);
    expect(merged.cutId).toBe("cut_1");
  });

  it("leaves a field alone when the patch does not name it", () => {
    const existing = parseChatMessageMeta({ narratorRun: provenance, stopped: true });
    const merged = mergeChatMessageMeta(existing, { cutId: "cut_9" });
    expect(merged.narratorRun).toEqual(provenance);
    expect(merged.stopped).toBe(true);
    expect(merged.cutId).toBe("cut_9");
  });

  it("merges the carried unknown keys key by key", () => {
    const existing = parseChatMessageMeta({ keepMe: 1, replaceMe: "old", dropMe: true });
    const merged = mergeChatMessageMeta(existing, { extra: { replaceMe: "new", dropMe: undefined } });
    expect(serializeChatMessageMeta(merged)).toEqual({ keepMe: 1, replaceMe: "new" });
  });

  it("clears the row-TYPE markers a retake patch names — the sticky-beat regression", () => {
    // A successor retake targets the newest assistant row, and a world beat IS one.
    // Merging preserved the marker, so the row carried fresh prose and still rendered
    // as a muted system line; the patch has to contradict it explicitly.
    const beatRow = parseChatMessageMeta({ simTurn: true, worldBeat: { kind: "traveled" }, stopped: true });
    const retaken = mergeChatMessageMeta(beatRow, {
      simTurn: true,
      cutId: "cut_1",
      modelId: "model/test",
      worldBeat: undefined,
      stopped: undefined,
    });
    expect(serializeChatMessageMeta(retaken)).toEqual({ simTurn: true, cutId: "cut_1", modelId: "model/test" });
  });

  it("clears the successor markers a legacy regenerate patch names", () => {
    const simRow = parseChatMessageMeta({ simTurn: true, worldBeat: { kind: "scene_ended" }, cutId: "cut_1" });
    const regenerated = mergeChatMessageMeta(simRow, {
      actionBeat: undefined,
      narratorRun: provenance,
      stopped: undefined,
      worldBeat: undefined,
      simTurn: undefined,
    });
    // `cutId` is deliberately NOT named: the legacy patch does not re-derive it.
    expect(serializeChatMessageMeta(regenerated)).toEqual({ cutId: "cut_1", narratorRun: provenance });
  });

  it("does not mutate either input", () => {
    const existing = parseChatMessageMeta({ inputMode: "narrator", futureField: 1 });
    const patch = { stopped: true };
    mergeChatMessageMeta(existing, patch);
    expect(serializeChatMessageMeta(existing)).toEqual({ inputMode: "narrator", futureField: 1 });
    expect(patch).toEqual({ stopped: true });
  });
});

describe("write constructors", () => {
  it("userLineMeta writes only the keys that carry information", () => {
    expect(serializeChatMessageMeta(userLineMeta({}))).toEqual({});
    // "player" is every reader's default — only the narrator register is durable.
    expect(serializeChatMessageMeta(userLineMeta({ inputMode: "player" }))).toEqual({});
    expect(serializeChatMessageMeta(userLineMeta({ attachmentIds: [] }))).toEqual({});
    expect(serializeChatMessageMeta(userLineMeta({ inputMode: "narrator", simTurn: true }))).toEqual({
      inputMode: "narrator",
      simTurn: true,
    });
    expect(
      serializeChatMessageMeta(userLineMeta({ attachmentIds: ["img_1"], attachmentDescriptions: ["a cat"] })),
    ).toEqual({ attachments: { ids: ["img_1"], descriptions: ["a cat"] } });
  });

  it("assistantReplyMeta omits an absent beat and an unstopped reply", () => {
    expect(serializeChatMessageMeta(assistantReplyMeta({ narratorRun: provenance }))).toEqual({
      narratorRun: provenance,
    });
    expect(
      serializeChatMessageMeta(assistantReplyMeta({ actionBeat: "drink", narratorRun: provenance, stopped: true })),
    ).toEqual({ actionBeat: "drink", narratorRun: provenance, stopped: true });
  });

  it("successorReplyMeta always marks the lane and omits empty breadcrumbs", () => {
    expect(serializeChatMessageMeta(successorReplyMeta({ modelId: "model/test", attempts: 1 }))).toEqual({
      simTurn: true,
      modelId: "model/test",
      attempts: 1,
    });
    expect(
      serializeChatMessageMeta(successorReplyMeta({ compositionFallbacks: [], renderDiagnostics: [] })),
    ).toEqual({ simTurn: true });
  });

  it("worldBeatMeta marks the row as a beat for any kind", () => {
    const beat = worldBeatMeta({ kind: "a_kind_from_a_newer_deploy" });
    expect(isWorldBeat(beat)).toBe(true);
    // The marker survives a full round trip, so the narrator's dialogue tail keeps
    // skipping the row and the transcript keeps rendering it muted.
    expect(isWorldBeat(parseChatMessageMeta(serializeChatMessageMeta(beat)))).toBe(true);
  });

  it("every constructor produces a bag that survives its own round trip", () => {
    const bags = [
      userLineMeta({ attachmentIds: ["img_1"], inputMode: "narrator" }),
      assistantReplyMeta({ actionBeat: "rest", narratorRun: provenance, stopped: true }),
      successorReplyMeta({ cutId: "cut_1", modelId: "m", attempts: 1, solo: true, simOpening: true }),
      worldBeatMeta({ kind: "traveled", compositionFallbacks: ["traveled_alone"] }),
    ];
    for (const bag of bags) {
      const sink = new DiagnosticCollector();
      const serialized = serializeChatMessageMeta(bag);
      expect(serializeChatMessageMeta(parseChatMessageMeta(serialized, sink))).toEqual(serialized);
      expect(sink.items).toEqual([]);
    }
  });
});
