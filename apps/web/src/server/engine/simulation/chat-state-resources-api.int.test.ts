import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, characters, db, personas } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Chat State Resources Int", role: "admin" as const },
}));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import {
  CHAT_LOCK_LABEL_REPLY,
  chatExchangeLockKey,
  loadChatScenario,
  loadChatState,
  loadPreExchangeScenario,
  rollbackScenario,
  savePreExchangeScenario,
  withKeyedLock,
} from "@/server/engine";
import { POST as chatsCreate } from "@/app/api/chats/route";
import { PATCH as legacyStatePatch } from "@/app/api/chats/[chatId]/state/route";
import { GET as scenarioGet, PATCH as scenarioPatch } from "@/app/api/chats/[chatId]/scenario/route";
import {
  GET as participantGet,
  PATCH as participantPatch,
} from "@/app/api/chats/[chatId]/participants/[characterId]/state/route";
import {
  GET as wardrobeGet,
  PATCH as wardrobePatch,
} from "@/app/api/chats/[chatId]/participants/[characterId]/wardrobe/route";
import { PATCH as playerStatePatch } from "@/app/api/chats/[chatId]/player-state/route";
import { PATCH as inspectorPatch } from "@/app/api/admin/self/chat-inspector/[chatId]/participants/[characterId]/state/route";

const ready = await probeIntegrationDb("chat-state-resources-api.int.test", "character_chat_state");

let ownerId = "";
let chatId = "";
let characterId = "";
let offRosterCharacterId = "";
let personaA = "";
let personaB = "";

const chatCtx = () => routeCtx({ chatId });
const participantCtx = (targetCharacterId = characterId) => routeCtx({ chatId, characterId: targetCharacterId });
const req = (path: string, body?: unknown): NextRequest =>
  apiRequest(path, body === undefined ? undefined : { method: "PATCH", body });

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("chat-state-resources-int", { name: "Chat State Resources Int", role: "admin" });
  bindAuthUser(authState, user);
  ownerId = user.id;

  const [primary, offRoster] = await db()
    .insert(characters)
    .values([
      { ownerId, name: "Resource Boundary", profile: {} },
      { ownerId, name: "Not In This Chat", profile: {} },
    ])
    .returning({ id: characters.id });
  if (!primary || !offRoster) throw new Error("failed to seed characters");
  characterId = primary.id;
  offRosterCharacterId = offRoster.id;

  const created = await chatsCreate(
    apiRequest("/api/chats", { body: { characterIds: [characterId], memory: "fresh" } }),
    routeCtx(),
  );
  chatId = (await expectJson<{ id: string }>(created, 201)).id;

  const [first, second] = await db()
    .insert(personas)
    .values([
      { ownerId, title: "First persona", name: "First" },
      { ownerId, title: "Second persona", name: "Second" },
    ])
    .returning({ id: personas.id });
  if (!first || !second) throw new Error("failed to seed personas");
  personaA = first.id;
  personaB = second.id;
});

afterAll(async () => {
  if (!ready) return;
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

describe.runIf(ready)("focused chat-state resources", () => {
  it("scenario-only PATCH leaves a rowless participant row absent", async () => {
    expect(await loadChatState(chatId, characterId)).toBeNull();

    const result = await scenarioPatch(
      req(`/api/chats/${chatId}/scenario`, { premise: "Scenario-only write", sceneAuto: "milestones" }),
      chatCtx(),
    );
    const view = await expectJson<{ premise: string; sceneAuto: string }>(result, 200);
    expect(view.premise).toBe("Scenario-only write");
    expect(view.sceneAuto).toBe("milestones");
    expect(await loadChatState(chatId, characterId)).toBeNull();

    const get = await scenarioGet(req(`/api/chats/${chatId}/scenario`), chatCtx());
    expect((await expectJson<{ premise: string }>(get)).premise).toBe("Scenario-only write");
  });

  it("participant PATCH seeds only the target row and does not rewrite scenario", async () => {
    const before = await loadChatScenario(chatId);
    const result = await participantPatch(
      req(`/api/chats/${chatId}/participants/${characterId}/state`, {
        regard: 42,
        familiarity: 37,
        mindNote: "participant-only write",
      }),
      participantCtx(),
    );
    const view = await expectJson<{ regard: number; familiarity: number; mindNote: string }>(result, 200);
    expect(view).toMatchObject({ regard: 42, familiarity: 37, mindNote: "participant-only write" });
    expect(await loadChatState(chatId, characterId)).not.toBeNull();
    expect(await loadChatScenario(chatId)).toEqual(before);
  });

  it("rejects character ids that are not in the owned chat roster", async () => {
    const stateResponse = await participantGet(
      req(`/api/chats/${chatId}/participants/${offRosterCharacterId}/state`),
      participantCtx(offRosterCharacterId),
    );
    expect(stateResponse.status).toBe(404);

    const wardrobeResponse = await wardrobeGet(
      req(`/api/chats/${chatId}/participants/${offRosterCharacterId}/wardrobe`),
      participantCtx(offRosterCharacterId),
    );
    expect(wardrobeResponse.status).toBe(404);
  });

  it("focused PATCH resources preserve chat_busy protection", async () => {
    let release!: () => void;
    const held = withKeyedLock(
      chatExchangeLockKey(chatId),
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
      CHAT_LOCK_LABEL_REPLY,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = await scenarioPatch(
      req(`/api/chats/${chatId}/scenario`, { premise: "must not land while busy" }),
      chatCtx(),
    );
    const body = await expectJson<{ error: { code: string } }>(response, 409);
    expect(body.error.code).toBe("chat_busy");

    release();
    await held;
    expect((await loadChatScenario(chatId))?.premise).toBe("Scenario-only write");
  });

  it("participant wardrobe keeps one material store and surfaces rejected-operation diagnostics", async () => {
    const before = await loadChatScenario(chatId);
    const result = await wardrobePatch(
      req(`/api/chats/${chatId}/participants/${characterId}/wardrobe`, {
        outfit: "a charcoal coat",
        outfitExposed: false,
        garmentOperations: [
          {
            kind: "transfer",
            garmentId: "missing-garment",
            to: { kind: "scene", placeName: "the study", anchor: "over the chair" },
          },
        ],
      }),
      participantCtx(),
    );
    const view = await expectJson<{ outfit: string; garmentDiagnostics: { code: string }[] }>(result, 200);
    expect(view.outfit).toBe("a charcoal coat");
    expect(view.garmentDiagnostics.some((diagnostic) => diagnostic.code.startsWith("garment_op."))).toBe(true);
    const after = await loadChatScenario(chatId);
    expect(after?.premise).toBe(before?.premise);
    expect(after?.sceneAuto).toBe(before?.sceneAuto);
  });

  it("focused scenario edits do not corrupt the pre-exchange rollback anchor", async () => {
    const anchor = await loadChatScenario(chatId);
    if (!anchor) throw new Error("scenario missing");
    await savePreExchangeScenario(chatId, anchor);

    const edited = await scenarioPatch(
      req(`/api/chats/${chatId}/scenario`, { premise: "post-anchor focused edit" }),
      chatCtx(),
    );
    expect(edited.status).toBe(200);

    const savedAnchor = await loadPreExchangeScenario(chatId);
    const live = await loadChatScenario(chatId);
    if (!savedAnchor || !live) throw new Error("rollback fixture missing");
    expect(savedAnchor.premise).toBe(anchor.premise);
    expect(rollbackScenario(savedAnchor, live).premise).toBe(anchor.premise);
  });

  it("player persona changes own the wardrobe reset atomically on the server", async () => {
    expect(
      (
        await playerStatePatch(
          req(`/api/chats/${chatId}/player-state`, { personaId: personaA }),
          chatCtx(),
        )
      ).status,
    ).toBe(200);

    await db()
      .update(characterChats)
      .set({
        playerState: {
          personaId: personaA,
          wornItemIds: ["old-shirt"],
          seeded: true,
          outfitPresetId: "old-preset",
          overlay: "old overlay",
        },
      })
      .where(eq(characterChats.id, chatId));

    const switched = await playerStatePatch(
      req(`/api/chats/${chatId}/player-state`, { personaId: personaB }),
      chatCtx(),
    );
    expect((await expectJson<{ personaId: string }>(switched, 200)).personaId).toBe(personaB);
    const scenario = await loadChatScenario(chatId);
    expect(scenario?.playerState).toEqual({
      personaId: personaB,
      wornItemIds: [],
      seeded: false,
      outfitPresetId: "",
      overlay: "",
    });
  });

  it("ordinary owner PATCH rejects inspector fields while admin self-inspector state accepts them", async () => {
    const rejected = await legacyStatePatch(
      req(`/api/chats/${chatId}/state`, { openLoops: ["should not be public"] }),
      chatCtx(),
    );
    const rejectedBody = await expectJson<{ error: { code: string } }>(rejected, 410);
    expect(rejectedBody.error.code).toBe("inspector_state_moved");

    const accepted = await inspectorPatch(
      req(`/api/admin/self/chat-inspector/${chatId}/participants/${characterId}/state`, {
        openLoops: ["inspector owned"],
        memoryQueries: ["what changed?"],
      }),
      participantCtx(),
    );
    const view = await expectJson<{ openLoops: string[]; memoryQueries: string[] }>(accepted, 200);
    expect(view.openLoops).toEqual(["inspector owned"]);
    expect(view.memoryQueries).toEqual(["what changed?"]);
  });

  it("successor authority rejects incompatible calendar, relationship, and wardrobe shadow writes", async () => {
    await db()
      .update(characterChats)
      .set({ engineAuthority: "successor_narrative_view" })
      .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)));

    const calendar = await scenarioPatch(
      req(`/api/chats/${chatId}/scenario`, {
        calendarStart: { year: 2030, month: 3, day: 4, hour: 9, minute: 0 },
      }),
      chatCtx(),
    );
    expect((await expectJson<{ error: { code: string } }>(calendar, 409)).error.code).toBe(
      "sim_calendar_managed_by_world",
    );

    const current = await participantGet(
      req(`/api/chats/${chatId}/participants/${characterId}/state`),
      participantCtx(),
    );
    const currentState = await expectJson<{ regard: number }>(current, 200);
    const relationship = await participantPatch(
      req(`/api/chats/${chatId}/participants/${characterId}/state`, { regard: currentState.regard + 1 }),
      participantCtx(),
    );
    expect((await expectJson<{ error: { code: string } }>(relationship, 409)).error.code).toBe(
      "sim_participant_state_managed_by_world",
    );

    const wardrobe = await wardrobePatch(
      req(`/api/chats/${chatId}/participants/${characterId}/wardrobe`, { outfit: "shadow write" }),
      participantCtx(),
    );
    expect((await expectJson<{ error: { code: string } }>(wardrobe, 409)).error.code).toBe(
      "sim_wardrobe_managed_by_world",
    );

    await db()
      .update(characterChats)
      .set({ engineAuthority: "legacy_chat" })
      .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)));
  });
});
