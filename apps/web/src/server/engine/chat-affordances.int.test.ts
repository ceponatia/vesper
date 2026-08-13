import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { chatContinuitySchema, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import { CHAT_SURFACE_LOCATION_UNKNOWN, CHAT_SURFACE_PROPOSAL_INVALID } from "@/contracts/turns/chat-surface-ops";
import { AFFORDANCE_INPUT_INVALID } from "@/contracts/affordances/core";
import {
  bodySurfaceWetnessAt,
  bodySurfaceWetnessEntry,
  BODY_SURFACE_INVALID_ENTRY,
  emptyBodySurfaceState,
  type BodySurfaceState,
} from "@/contracts/state/body-surface";
import { hairAttributeFixture } from "@/contracts/affordances/domains/hair/fixtures";
import { characterChatState, characterChats, db } from "@/server/db";

/**
 * The chat-lane environment + body-surface owners, end to end
 * (body-attribute-affordances slice 4).
 *
 * What only a database can prove:
 *
 * - a continuity leg's typed weather/wetness proposals actually LAND in the two
 *   new columns, through the same guarded write as everything else;
 * - a malformed proposal degrades with its stable code and the exchange still
 *   settles (docs/resilience.md's prime directive);
 * - the affordance read is CAPTURED by the rollback anchors: rolling the scenario
 *   and the state row back and rebuilding produces a byte-identical read and
 *   byte-identical next cues (architecture spec §"Recompute and capture", modelled
 *   on the garment cue-memory fixture F13);
 * - a corrupt `body_surface` blob degrades to dry with the boundary diagnostic
 *   rather than costing the turn (fixture F17's shape).
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import {
  loadChatScenario,
  loadChatState,
  loadPreExchangeScenario,
  loadPreExchangeState,
  rollbackScenario,
  saveChatScenario,
  savePreExchangeScenario,
  savePreExchangeSnapshot,
  seedChatScenario,
  type ChatScenario,
  type ChatState,
} from "./chat-state";
import { buildChatAffordanceRead } from "./chat-affordances";
import {
  chatArchivist,
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  settleChatExchange,
  type ChatFixture,
} from "@/server/test-support";

const ready = await probeIntegrationDb("chat-affordances.int.test", "character_chats");

let fixture: ChatFixture = emptyChatFixture();

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-affordances-int", userName: "Affordances Int" });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

/** The continuity leg's output, parsed exactly as production parses it. */
function continuity(raw: unknown): ChatArchivist {
  return chatArchivist(chatContinuitySchema.parse(raw));
}

/** The wetness read, collapsed for assertions: a level, or the literal "invalid". */
function level(surface: BodySurfaceState, locationId: string, atMinutes: number) {
  const read = bodySurfaceWetnessAt(surface, locationId, atMinutes);
  return read.status === "known" ? read.level : "invalid";
}

/** Hair with something to say once it is wet — the domain's own attribute fixture. */
const HAIR_ATTRIBUTES = hairAttributeFixture({
  length: "shoulder_length",
  density: "dense",
  strandThickness: "thick",
  texture: "wavy",
  condition: "healthy",
  arrangement: "loose",
});

/** The read as slice 5 will take it: committed scenario + committed state row. */
function readFor(scenario: ChatScenario, state: ChatState) {
  return buildChatAffordanceRead({
    subjectId: fixture.characterId,
    attributes: HAIR_ATTRIBUTES,
    attributeOverlays: state.attributeOverlays,
    conditions: state.conditions,
    // The wardrobe was READ and covers nothing — a bare head, not an unknown one.
    wardrobe: { worn: [] },
    bodySurface: state.bodySurface,
    environment: scenario.environment,
    clockMinutes: scenario.clockMinutes,
    previousCues: scenario.affordanceCues,
  });
}

describe.runIf(ready)("the extraction commits weather and wetness", () => {
  it("lands typed proposals in character_chats.environment and character_chat_state.body_surface", async () => {
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({
        environment: { wind: "gusting", precipitation: "downpour", indoors: false },
        surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "rain" }],
      }),
      degraded: false,
    };
    const { scenario, state } = await settleChatExchange(fixture, { chat });

    expect(scenario?.environment).toMatchObject({ wind: "gusting", precipitation: "downpour", indoors: false });
    expect(state && level(state.bodySurface, "hair", scenario?.clockMinutes ?? 0)).toBe(10_000);
    expect(state && bodySurfaceWetnessEntry(state.bodySurface, "hair")).toMatchObject({ cause: "rain" });
  });

  it("a patch changes only the keys it names, and a quiet exchange changes nothing", async () => {
    const chat = await newChat(fixture);
    mock.archivist = { value: continuity({ environment: { wind: "breeze", indoors: false } }), degraded: false };
    const first = await settleChatExchange(fixture, { chat });
    expect(first.scenario?.environment).toMatchObject({ wind: "breeze", precipitation: "none", indoors: false });

    // Rain arrives; the wind reading is not restated and must not reset.
    mock.archivist = { value: continuity({ environment: { precipitation: "rain" } }), degraded: false };
    const second = await settleChatExchange(fixture, {
      chat,
      ...(first.scenario ? { scenario: first.scenario } : {}),
    });
    expect(second.scenario?.environment).toMatchObject({ wind: "breeze", precipitation: "rain", indoors: false });

    // A degraded leg proposes nothing at all — the weather still stands.
    mock.archivist = { value: null, degraded: true };
    const third = await settleChatExchange(fixture, {
      chat,
      ...(second.scenario ? { scenario: second.scenario } : {}),
    });
    expect(third.scenario?.environment).toMatchObject({ wind: "breeze", precipitation: "rain", indoors: false });
  });

  it("malformed proposals degrade with their codes and the exchange still settles", async () => {
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({
        // An out-of-vocabulary band drops that ONE key; the good key survives.
        environment: { wind: "typhoon", indoors: false },
        surfaceWetness: [
          { location: "left_elbow", direction: "increase", degree: 2 },
          "soaked",
          // A hallucinated magnitude fails the ITEM — it must not become a real
          // 50% wetness change, which is what `.catch(2)` used to make it.
          { location: "hair", direction: "increase", degree: 999, cause: "rain" },
          { location: "hair", direction: "increase", degree: 2, cause: "splash" },
        ],
      }),
      degraded: false,
    };
    const { scenario, state, sink, outcome } = await settleChatExchange(fixture, { chat });

    expect(outcome.presenceChanges).toEqual([]);
    expect(scenario?.environment).toMatchObject({ wind: "none", indoors: false });
    expect(state?.bodySurface.wetness.left_elbow).toBeUndefined();
    // Only the ONE good hair item landed: 5_000, not 5_000 + a repaired 5_000.
    expect(state && level(state.bodySurface, "hair", scenario?.clockMinutes ?? 0)).toBe(5_000);
    expect(state && bodySurfaceWetnessEntry(state.bodySurface, "hair")).toMatchObject({ cause: "splash" });
    const codes = sink.items.map((d) => d.code);
    expect(codes).toContain(CHAT_SURFACE_LOCATION_UNKNOWN);
    expect(codes).toContain(CHAT_SURFACE_PROPOSAL_INVALID);
  });

  it("standing outdoor rain HOLDS the soaking across quiet exchanges", async () => {
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({
        environment: { precipitation: "downpour", indoors: false },
        surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "rain" }],
      }),
      degraded: false,
    };
    const first = await settleChatExchange(fixture, { chat });
    expect(first.state && level(first.state.bodySurface, "hair", first.scenario?.clockMinutes ?? 0)).toBe(10_000);
    if (!first.scenario || !first.state) return;

    // Four story hours later — enough to dry a saturated head right out — with the
    // rain still falling and no proposal at all. She is still soaked.
    const laterClock = first.scenario.clockMinutes + 4 * 60;
    mock.archivist = { value: continuity({}), degraded: false };
    const held = await settleChatExchange(fixture, {
      chat,
      scenario: { ...first.scenario, clockMinutes: laterClock },
      driftedState: first.state,
    });
    expect(held.scenario?.environment).toMatchObject({ precipitation: "downpour", indoors: false });
    // The committed entry is untouched — not dried down, not pruned away — and the
    // adapter's read (which applies the same suspension) still sees a soaked head.
    expect(held.state && bodySurfaceWetnessEntry(held.state.bodySurface, "hair")).toEqual({
      level: 10_000,
      updatedAtMinutes: first.scenario.clockMinutes,
      cause: "rain",
    });
    expect(held.scenario && held.state && readFor(held.scenario, held.state).read.observations.map((o) => o.id)).toContain(
      "hair.wet_clumping",
    );

    // She steps inside on the SAME exchange the clock advances: the environment
    // patch lands first, so the integration uses the sky she ends under and dries.
    if (!held.scenario || !held.state) return;
    const dryClock = laterClock + 4 * 60;
    mock.archivist = { value: continuity({ environment: { precipitation: "none", indoors: true } }), degraded: false };
    const dried = await settleChatExchange(fixture, {
      chat,
      scenario: { ...held.scenario, clockMinutes: dryClock },
      driftedState: held.state,
    });
    expect(dried.state?.bodySurface.wetness.hair).toBeUndefined();
  });
});

describe.runIf(ready)("the retake reproduces the identical read (capture)", () => {
  it("restores environment, wetness AND cue memory from the anchors, byte for byte", async () => {
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({
        environment: { wind: "gusting", indoors: false },
        surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "rain" }],
      }),
      degraded: false,
    };
    const settled = await settleChatExchange(fixture, { chat });
    const anchorState = settled.state;
    const firstScenario = settled.scenario;
    expect(anchorState).not.toBeNull();
    expect(firstScenario).not.toBeNull();
    if (!anchorState || !firstScenario) return;

    // Exchange 1, as slice 5 will run it: take the read, then persist its cue
    // memory beside the state it describes. That memory is now non-empty, which
    // is what makes rolling it back worth proving.
    const opening = readFor(firstScenario, anchorState);
    expect(opening.read.cues.length).toBeGreaterThan(0);
    const anchorScenario: ChatScenario = { ...firstScenario, affordanceCues: opening.nextCues };
    await saveChatScenario(chat.chatId, anchorScenario);

    // Exchange 2 starts HERE, so this pair is the rollback anchor — and the read
    // it produces is the one a retake has to reproduce.
    await savePreExchangeScenario(chat.chatId, anchorScenario);
    await savePreExchangeSnapshot(chat.chatId, fixture.characterId, anchorState);
    const anchorJson = JSON.stringify({ environment: anchorScenario.environment, cues: anchorScenario.affordanceCues });
    const expected = readFor(anchorScenario, anchorState);
    // Guard against a vacuous equality later: this read really does say something.
    expect(expected.read.observations.length).toBeGreaterThan(0);
    expect(Object.keys(expected.nextCues.bands).length).toBeGreaterThan(0);

    // A take that clears the sky and towels her off — a genuinely different read,
    // and a different cue memory written over the live row.
    mock.archivist = {
      value: continuity({
        environment: { wind: "none", indoors: true },
        surfaceWetness: [{ location: "hair", direction: "decrease", degree: 3 }],
      }),
      degraded: false,
    };
    const diverged = await settleChatExchange(fixture, {
      chat,
      scenario: anchorScenario,
      preExchangeScenario: anchorScenario,
      driftedState: anchorState,
      preExchangeState: anchorState,
    });
    expect(diverged.scenario?.environment.wind).toBe("none");
    expect(diverged.state?.bodySurface.wetness.hair).toBeUndefined();
    if (!diverged.scenario || !diverged.state) return;
    const divergedRead = readFor(diverged.scenario, diverged.state);
    expect(JSON.stringify(divergedRead.read)).not.toBe(JSON.stringify(expected.read));
    await saveChatScenario(chat.chatId, { ...diverged.scenario, affordanceCues: divergedRead.nextCues });

    // "Another take": restore both anchors and rebuild from them alone.
    const scenarioAnchor = await loadPreExchangeScenario(chat.chatId);
    const stateAnchor = await loadPreExchangeState(chat.chatId, fixture.characterId);
    expect(scenarioAnchor).not.toBeNull();
    expect(stateAnchor.state).not.toBeNull();
    if (!scenarioAnchor || !stateAnchor.state) return;
    const rolledBack = rollbackScenario(scenarioAnchor, diverged.scenario);
    // Weather AND mention history come back together, byte for byte, off one anchor.
    expect(JSON.stringify({ environment: rolledBack.environment, cues: rolledBack.affordanceCues })).toBe(anchorJson);

    const rebuilt = readFor(rolledBack, stateAnchor.state);
    expect(JSON.stringify(rebuilt.read)).toBe(JSON.stringify(expected.read));
    expect(rebuilt.nextCues).toEqual(expected.nextCues);
  });
});

describe.runIf(ready)("corrupt jsonb degrades without costing the turn", () => {
  it("a bad body_surface blob reads dry with parse.boundary_failed on the column", async () => {
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({ surfaceWetness: [{ location: "hair", direction: "increase", degree: 2, cause: "rain" }] }),
      degraded: false,
    };
    await settleChatExchange(fixture, { chat });
    await db().execute(
      sql`update ${characterChatState} set body_surface = '"drenched"'::jsonb where chat_id = ${chat.chatId}`,
    );

    const sink = new DiagnosticCollector();
    const corrupt = await loadChatState(chat.chatId, fixture.characterId, sink);
    expect(corrupt?.bodySurface).toEqual(emptyBodySurfaceState());
    expect(sink.items.find((d) => d.code === "parse.boundary_failed")?.path).toBe(
      "character_chat_state.body_surface",
    );

    // The next exchange settles and re-materializes the column.
    mock.archivist = {
      value: continuity({ surfaceWetness: [{ location: "hair", direction: "increase", degree: 1, cause: "splash" }] }),
      degraded: false,
    };
    const healed = await settleChatExchange(fixture, { chat, ...(corrupt ? { driftedState: corrupt } : {}) });
    expect(healed.state && bodySurfaceWetnessEntry(healed.state.bodySurface, "hair")).toMatchObject({ cause: "splash" });
  });

  it("a corrupt ENTRY is quarantined, not healed to dry — the domain falls silent", async () => {
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({
        environment: { wind: "gusting", indoors: false },
        surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "rain" }],
      }),
      degraded: false,
    };
    await settleChatExchange(fixture, { chat });
    // One location's level goes bad; a sibling location stays perfectly good.
    await db().execute(
      sql`update ${characterChatState} set body_surface = '{"wetness":{"hair":{"level":"soaked","updatedAtMinutes":3},"chest":{"level":4000,"updatedAtMinutes":1}}}'::jsonb where chat_id = ${chat.chatId}`,
    );

    const loadSink = new DiagnosticCollector();
    const scenario = await loadChatScenario(chat.chatId, loadSink);
    const corrupt = await loadChatState(chat.chatId, fixture.characterId, loadSink);
    expect(scenario).not.toBeNull();
    expect(corrupt).not.toBeNull();
    if (!scenario || !corrupt) return;
    // The COLUMN parsed fine — this is per-entry damage, so there is no boundary
    // failure to report. The read is where it has to become visible.
    expect(loadSink.items.filter((d) => d.code === "parse.boundary_failed")).toEqual([]);
    expect(corrupt.bodySurface.wetness.hair).toEqual(BODY_SURFACE_INVALID_ENTRY);
    expect(level(corrupt.bodySurface, "hair", scenario.clockMinutes)).toBe("invalid");
    // The good sibling survived its neighbour's corruption.
    expect(level(corrupt.bodySurface, "chest", 1)).toBe(4_000);
    // …and an unrecorded location is still honestly DRY, which is the distinction.
    expect(level(corrupt.bodySurface, "left_hand", 1)).toBe(0);

    const readSink = new DiagnosticCollector();
    const read = buildChatAffordanceRead({
      subjectId: fixture.characterId,
      attributes: HAIR_ATTRIBUTES,
      wardrobe: { worn: [] },
      bodySurface: corrupt.bodySurface,
      environment: { ...scenario.environment, wind: "gusting", indoors: false },
      clockMinutes: scenario.clockMinutes,
      sink: readSink,
    });
    // Silence, not a wind cue off a level that "healed" to dry.
    expect(read.read.observations).toEqual([]);
    expect(read.read.suppressed.every((entry) => entry.code === AFFORDANCE_INPUT_INVALID)).toBe(true);
    expect(
      readSink.items.find(
        (d) => d.code === AFFORDANCE_INPUT_INVALID && d.path === "character_chat_state.body_surface",
      )?.severity,
    ).toBe("warn");

    // The next authoritative write HEALS it, and the exchange settles as normal.
    mock.archivist = {
      value: continuity({ surfaceWetness: [{ location: "hair", direction: "increase", degree: 2, cause: "splash" }] }),
      degraded: false,
    };
    const healed = await settleChatExchange(fixture, { chat, scenario, driftedState: corrupt });
    expect(healed.state && bodySurfaceWetnessEntry(healed.state.bodySurface, "hair")).toMatchObject({ cause: "splash" });
    expect(healed.state && level(healed.state.bodySurface, "hair", scenario.clockMinutes)).toBe(5_000);
  });

  it("a bad environment blob reads indoors/still/dry with the diagnostic", async () => {
    const chat = await newChat(fixture);
    await settleChatExchange(fixture, { chat, scenario: seedChatScenario(fixture.profile) });
    await db().execute(sql`update ${characterChats} set environment = '"a storm"'::jsonb where id = ${chat.chatId}`);

    const sink = new DiagnosticCollector();
    const corrupt = await loadChatScenario(chat.chatId, sink);
    expect(corrupt?.environment).toMatchObject({ wind: "none", precipitation: "none", indoors: true });
    expect(sink.items.find((d) => d.code === "parse.boundary_failed")?.path).toBe("character_chats.environment");
  });

  it("a pre-feature NULL column is silent — it is 'nothing recorded', not corruption", async () => {
    const chat = await newChat(fixture);
    await settleChatExchange(fixture, { chat });
    await db().execute(
      sql`update ${characterChats} set environment = null, affordance_cues = null where id = ${chat.chatId}`,
    );
    await db().execute(sql`update ${characterChatState} set body_surface = null where chat_id = ${chat.chatId}`);

    const sink = new DiagnosticCollector();
    const scenario = await loadChatScenario(chat.chatId, sink);
    const state = await loadChatState(chat.chatId, fixture.characterId, sink);
    expect(scenario?.environment.indoors).toBe(true);
    expect(scenario?.affordanceCues).toEqual({ bands: {}, cues: [], changedAt: {} });
    expect(state?.bodySurface).toEqual(emptyBodySurfaceState());
    expect(sink.items.filter((d) => d.code === "parse.boundary_failed")).toEqual([]);
  });
});
