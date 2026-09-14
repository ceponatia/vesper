import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector, type CharacterProfile } from "@/contracts";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import type { ChatScenario, ChatState } from "./chat-state/types";
import type { ResolvedChatWardrobe } from "./chat-wardrobe";
import type { PlayerPersona } from "../players";
import type { buildChatAffordanceRead } from "./chat-affordances";

/**
 * #209 claim 4 — the pending permission stop reaches the narrator even when
 * `CHAT_PHYSICAL_CONSTRAINTS` is off.
 *
 * `prepareChatTurnGuidance` (`chat-turn-guidance.ts`) has exactly one caller
 * and zero test importers before this file. Its physical-guidance branch is a
 * two-arm choice: `physicalConstraintsEnabled && affordanceRead` takes the
 * full adapter (`buildChatPhysicalGuidance`); everything else — including the
 * flag OFF — takes the transition-only arm
 * (`compileNarratorPhysicalGuidance({ transitions: permissionStopTransitions })`)
 * whenever a pending revocation stop exists. That second arm is the
 * `romantic_touch` permission owner's "next narrator cut gets the stop" law
 * (`docs/character-chat/physical-legs.md` §The `romantic_touch` permission
 * owner, item 4) and it has no other pure coverage, because every existing
 * suite that exercises it is an `*.int.test.ts` file the `app` Vitest project
 * never selects.
 *
 * Only the IO is mocked: `loadChatPermissionStopTransitions` (a bounded
 * ledger read) and `chatVisualStateNarrationOn` (a per-chat DB flag read) —
 * both mocks spread their module's real exports so the pure functions each
 * module also exports (`chatPermissionStopTransitions`,
 * `CHAT_CONTACT_DOMAIN_ID`, `CHAT_CONTACT_ENDED_CODE`) stay the production
 * ones. `CHAT_VISUAL_STATE_SHADOW` is left unset and the narration switch
 * mock resolves `false`, so the visual-state lane
 * (`loadChatVisualMemory`/`loadChatVisualCues`/`safeBuildVisualStateShadow`)
 * never runs — confirmed by reading `chat-turn-guidance.ts`, not by mocking
 * those modules too. Importing the module under test pulls in `../db`
 * (`chat-permission-guidance.ts`, `visual-memory-store.ts`, …), but `db()` is
 * a lazy accessor (`server/db/client.ts`) and every other module in the
 * import graph is either pure or IO-on-call, so no module executes IO merely
 * by being imported — the same property `chat-permission-guidance.test.ts`
 * already relies on.
 */

vi.mock("./chat-permission-guidance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-permission-guidance")>();
  return { ...actual, loadChatPermissionStopTransitions: vi.fn() };
});

vi.mock("./chat-visual-state-flag", () => ({
  chatVisualStateNarrationOn: vi.fn().mockResolvedValue(false),
}));

// Wrapped rather than replaced, so every test but the one that opts in with
// `mockImplementationOnce` calls straight through to the real renderer.
vi.mock("./chat-physical-guidance-render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-physical-guidance-render")>();
  return { ...actual, renderChatPhysicalGuidance: vi.fn(actual.renderChatPhysicalGuidance) };
});

// Same wrapping, so a test can prove the full-adapter arm was never taken by
// asserting on a spy that is otherwise inert (delegates to the real adapter).
vi.mock("./chat-physical-guidance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-physical-guidance")>();
  return { ...actual, buildChatPhysicalGuidance: vi.fn(actual.buildChatPhysicalGuidance) };
});

import {
  chatPermissionStopTransitions,
  loadChatPermissionStopTransitions,
  type ChatPermissionStopLedgerRow,
} from "./chat-permission-guidance";
import { renderChatPhysicalGuidance } from "./chat-physical-guidance-render";
import { buildChatPhysicalGuidance } from "./chat-physical-guidance";
import { prepareChatTurnGuidance } from "./chat-turn-guidance";

const CHARACTER_ID = "char_wren";
const CHARACTER_NAME = "Wren";
const PLAYER_SUBJECT = String(CHAT_CONTACT_PLAYER_SUBJECT);

/** One `policy_withdrawn` ending on the player→character pair, ready to end. */
function pendingStopRow(): ChatPermissionStopLedgerRow {
  return {
    eventRef: "permission-reply:msg_reply_1",
    contactId: "contact_1",
    guardMessageId: "msg_reply_1",
    createdAt: new Date("2026-08-04T10:00:00.000Z"),
    payload: {
      kind: "contact_ended",
      contactId: "contact_1",
      eventRef: "permission-reply:msg_reply_1",
      reason: "policy_withdrawn",
      storyTime: 120,
      contact: {
        phase: "ended",
        actorId: PLAYER_SUBJECT,
        source: { kind: "body", subjectId: PLAYER_SUBJECT, locationId: "hands" },
        target: { kind: "body", subjectId: CHARACTER_ID, locationId: "shoulders" },
      },
    },
  };
}

/** The real pure emission rule over one pending row — a fixture, not a re-test of it. */
function onePendingStop() {
  return chatPermissionStopTransitions({ rows: [pendingStopRow()], newestAssistantReply: null });
}

type PrepareArgs = Parameters<typeof prepareChatTurnGuidance>[0];

/**
 * The full argument surface, with the flag-off arm's untouched parameters
 * stubbed to the smallest typed value. Verified by reading
 * `chat-turn-guidance.ts`: with `physicalConstraintsEnabled: false`,
 * `affordanceRead: null`, `contactActionOutcomes: []`,
 * `contactUnresolvedPremise: null`, `contactTurnFacts: null`, and the
 * visual-state lane held off by the two mocks above, none of `profile`,
 * `owner`, `driftedState`, `scenario`, `wardrobe`, `affordanceReadInput`,
 * `recognitionPerception`, `player`, `playerContent`, `narratorInput`, or
 * `exchangeGuardMessageId` is ever dereferenced — so an `as unknown as T`
 * cast on those is a cast on a value the arm provably never reads, not a
 * type-safety hole.
 */
function baseArgs(overrides: Partial<PrepareArgs> = {}): PrepareArgs {
  return {
    chatId: "chat_1",
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    sink: new DiagnosticCollector(),
    profile: {} as unknown as CharacterProfile,
    owner: "owner_1",
    driftedState: {} as unknown as ChatState,
    scenario: {} as unknown as ChatScenario,
    others: [],
    memoryGroupId: "memory_1",
    input: {},
    playerContent: "",
    assistantMessageId: "msg_assistant_1",
    narratorInput: false,
    exchangeGuardMessageId: "msg_assistant_1",
    player: {} as unknown as PlayerPersona,
    primarySensoryFocus: undefined,
    wardrobe: {} as unknown as ResolvedChatWardrobe,
    affordanceReadInput: {} as unknown as Parameters<typeof buildChatAffordanceRead>[0],
    physicalConstraintsEnabled: false,
    affordanceRead: null,
    recognitionPerception: null,
    contactActionOutcomes: [],
    contactUnresolvedPremise: null,
    contactTurnFacts: null,
    ...overrides,
  };
}

describe("prepareChatTurnGuidance — #209 claim 4: the pending permission stop with CHAT_PHYSICAL_CONSTRAINTS off", () => {
  let priorRomantic: string | undefined;
  let priorContact: string | undefined;
  let priorShadow: string | undefined;

  beforeEach(() => {
    priorRomantic = process.env.CHAT_ROMANTIC_PERMISSION;
    priorContact = process.env.CHAT_CONTACT_ACTIONS;
    priorShadow = process.env.CHAT_VISUAL_STATE_SHADOW;
    // The visual-state SHADOW arm must never run for this claim — only the
    // narration-switch mock (resolving `false`) should decide that branch.
    delete process.env.CHAT_VISUAL_STATE_SHADOW;
    vi.mocked(loadChatPermissionStopTransitions).mockClear();
    vi.mocked(renderChatPhysicalGuidance).mockClear();
    vi.mocked(buildChatPhysicalGuidance).mockClear();
  });

  afterEach(() => {
    for (const [key, value] of [
      ["CHAT_ROMANTIC_PERMISSION", priorRomantic],
      ["CHAT_CONTACT_ACTIONS", priorContact],
      ["CHAT_VISUAL_STATE_SHADOW", priorShadow],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("(a) with one pending stop, renders exactly one leading 'Ended contact' line naming the pair and ending on the stop's closing sentence", async () => {
    process.env.CHAT_ROMANTIC_PERMISSION = "on";
    process.env.CHAT_CONTACT_ACTIONS = "on";
    vi.mocked(loadChatPermissionStopTransitions).mockResolvedValueOnce(onePendingStop());

    const result = await prepareChatTurnGuidance(baseArgs());

    expect(result.physicalGuidanceLines).toHaveLength(1);
    expect(result.physicalGuidanceLines[0]).toBe(
      "- Ended contact: the player is no longer touching Wren's shoulder. " +
        "That contact is over now — do not write it as continuing, resuming, or still in progress. " +
        "If the stop has not already been shown, portray it naturally (an in-character reaction is fine); " +
        "do not decide how the player responds.",
    );
    // The transition-only arm was taken, not the full adapter — flag-off means
    // it never could be, and the line above is that arm's own compiled output.
    expect(buildChatPhysicalGuidance).not.toHaveBeenCalled();
    expect(loadChatPermissionStopTransitions).toHaveBeenCalledTimes(1);
    // The visual-state lane really did resolve off, not merely "untested".
    expect(result.visualStateNarrationOn).toBe(false);
    expect(result.visualStateBuild).toBeNull();
    expect(result.visualStateLines).toBeNull();
  });

  it("(b) with no pending stop, renders nothing even though the romantic-permission flag is on", async () => {
    process.env.CHAT_ROMANTIC_PERMISSION = "on";
    process.env.CHAT_CONTACT_ACTIONS = "on";
    vi.mocked(loadChatPermissionStopTransitions).mockResolvedValueOnce([]);

    const result = await prepareChatTurnGuidance(baseArgs());

    expect(result.physicalGuidanceLines).toEqual([]);
  });

  it("(c) with CHAT_ROMANTIC_PERMISSION unset, never calls the permission-stop loader and renders nothing", async () => {
    delete process.env.CHAT_ROMANTIC_PERMISSION;
    delete process.env.CHAT_CONTACT_ACTIONS;

    const result = await prepareChatTurnGuidance(baseArgs());

    expect(loadChatPermissionStopTransitions).not.toHaveBeenCalled();
    expect(result.physicalGuidanceLines).toEqual([]);
  });

  it("(d) a stop-build failure aborts the turn instead of consuming the delivery window", async () => {
    process.env.CHAT_ROMANTIC_PERMISSION = "on";
    process.env.CHAT_CONTACT_ACTIONS = "on";
    vi.mocked(loadChatPermissionStopTransitions).mockResolvedValueOnce(onePendingStop());
    const renderFailure = new Error("render boom");
    vi.mocked(renderChatPhysicalGuidance).mockImplementationOnce(() => {
      throw renderFailure;
    });

    await expect(prepareChatTurnGuidance(baseArgs())).rejects.toThrow(renderFailure);
  });
});
