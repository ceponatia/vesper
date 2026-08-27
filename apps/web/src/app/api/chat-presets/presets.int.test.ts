import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { regardBandMidpoint } from "@/contracts";
import { newId } from "@/lib/ids";
import { characterChats, characterChatState, characters, chatScenarioPresets, db } from "@/server/db";

// Scenario-presets integration suite: the /api/chat-presets CRUD handlers plus
// the create-a-chat-with-presetId seeding path (POST /api/chats writes the new
// conversation's state row from the preset exactly the way the scenario modal
// would). Invoked directly with mocked auth against DATABASE_URL; AI_FAKE keeps
// everything provider-free. Self-skips when the database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Preset Int", role: "admin" as const },
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
import { GET as presetsList, POST as presetCreate } from "./route";
import { DELETE as presetDelete } from "./[presetId]/route";
import { POST as chatsCreate } from "../chats/route";

const ready = await probeIntegrationDb("presets.int.test", "chat_scenario_presets");

const presetCtx = (presetId: string) => routeCtx({ presetId });

const listReq = (): NextRequest => apiRequest("/api/chat-presets");
const createReq = (body: unknown): NextRequest => apiRequest("/api/chat-presets", { body });
const delReq = (presetId: string): NextRequest => apiRequest(`/api/chat-presets/${presetId}`, { method: "DELETE" });
const chatCreateReq = (body: unknown): NextRequest => apiRequest("/api/chats", { body });

interface PresetRow {
  id: string;
  name: string;
  premise: string;
  outfit: string;
  outfitExposed: boolean;
  socialCards: { id: string; label: string }[];
  startingRelationship: { familiarity: string; regard: string; kind: string; history: string; looming: boolean };
}

async function listPresets(): Promise<PresetRow[]> {
  const res = await presetsList(listReq(), routeCtx());
  return (await expectJson<{ presets: PresetRow[] }>(res, 200)).presets;
}

const ids = { otherUser: "", character: "" };

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("preset-int", { name: "Preset Int", role: "admin" });
  const other = await seedTestUser("preset-int-other", { name: "Other" });
  bindAuthUser(authState, user);
  ids.otherUser = other.id;

  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Sable", profile: {} }).returning();
  if (!character) throw new Error("failed to seed character");
  ids.character = character.id;
});

afterAll(async () => {
  if (!ready) return;
  // Presets, chats and characters FK users without cascade — `purgeOwnerRows` owns that order.
  await purgeOwnerRows([authState.user.id, ids.otherUser]);
  await endTestPool();
});

describe.runIf(ready)("chat-presets CRUD", () => {
  it("creates, lists (round-tripping every field), and deletes a preset", async () => {
    const res = await presetCreate(
      createReq({
        name: "Rainy rooftop",
        premise: "Caught in the rain on the rooftop bar.",
        outfit: "a soaked sundress",
        outfitExposed: true,
        socialCards: [{ id: "card-tea", label: "Tea ritual", kind: "social_rule", severity: 40 }],
        startingRelationship: {
          familiarity: "familiar",
          regard: "cool",
          kind: "estranged childhood friends",
          history: "he left town without a word",
          looming: true,
        },
      }),
      routeCtx(),
    );
    const { id } = await expectJson<{ id: string }>(res, 201);

    const listed = await listPresets();
    const preset = listed.find((p) => p.id === id);
    expect(preset).toBeDefined();
    expect(preset?.name).toBe("Rainy rooftop");
    expect(preset?.premise).toBe("Caught in the rain on the rooftop bar.");
    expect(preset?.outfit).toBe("a soaked sundress");
    expect(preset?.outfitExposed).toBe(true);
    expect(preset?.startingRelationship).toMatchObject({
      familiarity: "familiar",
      regard: "cool",
      kind: "estranged childhood friends",
      looming: true,
    });
    expect(preset?.socialCards.map((c) => c.id)).toEqual(["card-tea"]);

    const del = await presetDelete(delReq(id), presetCtx(id));
    expect(del.status).toBe(200);
    expect((await listPresets()).some((p) => p.id === id)).toBe(false);
  });

  it("applies the schema defaults on a minimal create (strangers/neutral record)", async () => {
    const res = await presetCreate(createReq({ name: "Bare minimum" }), routeCtx());
    const { id } = await expectJson<{ id: string }>(res, 201);

    const preset = (await listPresets()).find((p) => p.id === id);
    expect(preset).toMatchObject({
      premise: "",
      outfit: "",
      outfitExposed: false,
      socialCards: [],
      startingRelationship: { familiarity: "strangers", regard: "neutral" },
    });
  });

  it("404s deleting another user's preset, leaving it untouched", async () => {
    const foreignId = newId();
    await db().insert(chatScenarioPresets).values({ id: foreignId, ownerId: ids.otherUser, name: "Not yours" });

    const res = await presetDelete(delReq(foreignId), presetCtx(foreignId));
    expect(res.status).toBe(404);

    const [still] = await db()
      .select({ id: chatScenarioPresets.id })
      .from(chatScenarioPresets)
      .where(eq(chatScenarioPresets.id, foreignId));
    expect(still).toBeDefined();
  });
});

describe.runIf(ready)("POST /api/chats with presetId — scenario seeding", () => {
  it("seeds the new conversation's state row from the preset's full record (bands + texture)", async () => {
    const created = await presetCreate(
      createReq({
        name: "Winter cabin",
        premise: "Snowed in together at the cabin.",
        outfit: "an oversized flannel shirt",
        outfitExposed: false,
        socialCards: [{ id: "card-quiet", label: "Keep voices low", kind: "social_rule", severity: 30 }],
        startingRelationship: {
          familiarity: "acquainted",
          regard: "friendly",
          kind: "ski-trip acquaintances",
          history: "they shared a lift chair through a storm",
          looming: false,
        },
      }),
      routeCtx(),
    );
    const { id: presetId } = await expectJson<{ id: string }>(created, 201);

    const chatRes = await chatsCreate(
      chatCreateReq({ characterIds: [ids.character], memory: "fresh", presetId }),
      routeCtx(),
    );
    const { id: chatId } = await expectJson<{ id: string }>(chatRes, 201);

    // The chat-wide half seeds the SCENARIO on the chat row…
    const [scenario] = await db()
      .select({ premise: characterChats.premise, activeSocialCards: characterChats.activeSocialCards })
      .from(characterChats)
      .where(eq(characterChats.id, chatId));
    expect(scenario).toBeDefined();
    expect(scenario?.premise).toBe("Snowed in together at the cabin.");
    const cards = scenario?.activeSocialCards as { id: string }[];
    expect(cards.map((c) => c.id)).toEqual(["card-quiet"]);
    // …and the character-specific half seeds the primary's state row.
    const [state] = await db()
      .select({
        outfit: characterChatState.outfit,
        outfitExposed: characterChatState.outfitExposed,
        regard: characterChatState.regard,
        relationshipRecord: characterChatState.relationshipRecord,
      })
      .from(characterChatState)
      .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, ids.character)));
    expect(state).toBeDefined();
    expect(state?.outfit).toBe("an oversized flannel shirt");
    expect(state?.outfitExposed).toBe(false);
    expect(state?.regard).toBe(regardBandMidpoint("friendly")); // never the raw band string
    // The texture rides too.
    expect(state?.relationshipRecord).toMatchObject({ kind: "ski-trip acquaintances" });
  });

  it("ignores a presetId the user does not own — the chat is created unseeded", async () => {
    const foreignId = newId();
    await db().insert(chatScenarioPresets).values({
      id: foreignId,
      ownerId: ids.otherUser,
      name: "Foreign",
      premise: "should never seed",
    });

    const chatRes = await chatsCreate(
      chatCreateReq({ characterIds: [ids.character], memory: "fresh", presetId: foreignId }),
      routeCtx(),
    );
    // A stale/foreign preset never fails the create.
    const { id: chatId } = await expectJson<{ id: string }>(chatRes, 201);

    const [state] = await db()
      .select({ chatId: characterChatState.chatId })
      .from(characterChatState)
      .where(eq(characterChatState.chatId, chatId));
    expect(state).toBeUndefined(); // no state row was seeded
  });
});
