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
import { loadChatScenario, loadChatState } from "@/server/engine";
import { POST as chatsCreate } from "./route";
import { PATCH as legacyStatePatch } from "./[chatId]/state/route";
import { GET as scenarioGet, PATCH as scenarioPatch } from "./[chatId]/scenario/route";
import { GET as participantGet, PATCH as participantPatch } from "./[chatId]/participants/[characterId]/state/route";
import { PATCH as wardrobePatch } from "./[chatId]/participants/[characterId]/wardrobe/route";
import { PATCH as playerStatePatch } from "./[chatId]/player-state/route";
import { PATCH as inspectorPatch } from "../admin/chat-inspector/[chatId]/participants/[characterId]/state/route";

const ready = await probeIntegrationDb("chat-state-resources.int.test", "character_chat_state");

let ownerId = "";
let chatId = "";
let characterId = "";
let personaA = "";
let personaB = "";

const chatCtx = () => routeCtx({ chatId });
const participantCtx = () => routeCtx({ chatId, characterId });
const req = (path: string, body?: unknown): NextRequest =>
  apiRequest(path, body === undefined ? undefined : { method: "PATCH", body });

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("chat-state-resources-int", { name: "Chat State Resources Int", role: "admin" });
  bindAuthUser(authState, user);
  ownerId = user.id;

  const [character] = await db()
    .insert(characters)
    .values({ ownerId, name: "Resource Boundary", profile: {} })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to seed character");
  characterId = character.id;

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
  it("scenario-only PATCH does not seed a participant state row", async () => {
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

  it("participant PATCH creates only participant state and does not rewrite scenario", async () => {
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

    const get = await participantGet(req(`/api/chats/${chatId}/participants/${characterId}/state`), participantCtx());
    expect((await expectJson<{ characterId: string }>(get)).characterId).toBe(characterId);
  });

  it("participant wardrobe writes preserve scenario author fields and persist the participant projection", async () => {
    const before = await loadChatScenario(chatId);
    const result = await wardrobePatch(
      req(`/api/chats/${chatId}/participants/${characterId}/wardrobe`, {
        outfit: "a charcoal coat",
        outfitExposed: false,
      }),
      participantCtx(),
    );
    const view = await expectJson<{ outfit: string; garmentDiagnostics: unknown[] }>(result, 200);
    expect(view.outfit).toBe("a charcoal coat");
    expect(view.garmentDiagnostics).toEqual([]);
    const after = await loadChatScenario(chatId);
    expect(after?.premise).toBe(before?.premise);
    expect(after?.sceneAuto).toBe(before?.sceneAuto);
  });

  it("player persona changes reset wardrobe state on the server", async () => {
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

  it("ordinary owner PATCH rejects inspector/debug fields; admin inspector route owns them", async () => {
    const rejected = await legacyStatePatch(
      req(`/api/chats/${chatId}/state`, { openLoops: ["should not be public"] }),
      chatCtx(),
    );
    expect(rejected.status).toBe(400);

    const accepted = await inspectorPatch(
      req(`/api/admin/chat-inspector/${chatId}/participants/${characterId}/state`, {
        openLoops: ["inspector owned"],
        memoryQueries: ["what changed?"],
      }),
      participantCtx(),
    );
    const view = await expectJson<{ openLoops: string[]; memoryQueries: string[] }>(accepted, 200);
    expect(view.openLoops).toEqual(["inspector owned"]);
    expect(view.memoryQueries).toEqual(["what changed?"]);
  });

  it("focused resources remain chat-owner scoped", async () => {
    const [row] = await db()
      .select({ ownerId: characterChats.ownerId })
      .from(characterChats)
      .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)));
    expect(row?.ownerId).toBe(ownerId);
  });
});
