import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stageMidpoint } from "@/contracts";
import { newId } from "@/lib/ids";
import { characterChats, characterChatState, characters, chatScenarioPresets, db, users } from "@/server/db";

// Scenario-presets integration suite (character-chat-standalone.spec.md §1.5):
// the /api/chat-presets CRUD handlers plus the create-a-chat-with-presetId
// seeding path (POST /api/chats writes the new conversation's state row from the
// preset exactly the way the scenario modal would). Invoked directly with mocked
// auth against DATABASE_URL; AI_FAKE keeps everything provider-free. Self-skips
// when the database is unreachable.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Preset Int", role: "admin" as const },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { GET as presetsList, POST as presetCreate } from "./route";
import { DELETE as presetDelete } from "./[presetId]/route";
import { POST as chatsCreate } from "../chats/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from chat_scenario_presets limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[presets.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const collectionCtx = { params: Promise.resolve({}) };
const presetCtx = (presetId: string) => ({ params: Promise.resolve({ presetId }) });

const listReq = () => new NextRequest("http://t/api/chat-presets");
function createReq(body: unknown): NextRequest {
  return new NextRequest("http://t/api/chat-presets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const delReq = (presetId: string) => new NextRequest(`http://t/api/chat-presets/${presetId}`, { method: "DELETE" });
function chatCreateReq(body: unknown): NextRequest {
  return new NextRequest("http://t/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface PresetRow {
  id: string;
  name: string;
  premise: string;
  outfit: string;
  outfitExposed: boolean;
  socialCards: { id: string; label: string }[];
  startingStage: string;
}

async function listPresets(): Promise<PresetRow[]> {
  const res = await presetsList(listReq(), collectionCtx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presets: PresetRow[] }).presets;
}

const ids = { otherUser: "", character: "" };

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `preset-int-${stamp}@test.local`, name: "Preset Int", role: "admin" })
    .returning();
  const [other] = await db().insert(users).values({ email: `preset-int-other-${stamp}@test.local`, name: "Other" }).returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.otherUser = other.id;

  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Sable", profile: {} }).returning();
  if (!character) throw new Error("failed to seed character");
  ids.character = character.id;
});

afterAll(async () => {
  if (!ready) return;
  // Presets and chats FK users without cascade — clear them before the users go.
  await db().delete(chatScenarioPresets).where(eq(chatScenarioPresets.ownerId, authState.user.id));
  await db().delete(chatScenarioPresets).where(eq(chatScenarioPresets.ownerId, ids.otherUser));
  await db().delete(characterChats).where(eq(characterChats.ownerId, authState.user.id));
  await db().delete(characters).where(eq(characters.ownerId, authState.user.id));
  await db().delete(users).where(eq(users.id, authState.user.id));
  await db().delete(users).where(eq(users.id, ids.otherUser));
  await globalThis.__vesperPool?.end();
});

describe("chat-presets CRUD (spec §1.5)", () => {
  it("creates, lists (round-tripping every field), and deletes a preset", async (t) => {
    if (!ready) return t.skip();
    const res = await presetCreate(
      createReq({
        name: "Rainy rooftop",
        premise: "Caught in the rain on the rooftop bar.",
        outfit: "a soaked sundress",
        outfitExposed: true,
        socialCards: [{ id: "card-tea", label: "Tea ritual", kind: "social_rule", severity: 40 }],
        startingStage: "friendly",
      }),
      collectionCtx,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const listed = await listPresets();
    const preset = listed.find((p) => p.id === id);
    expect(preset).toBeDefined();
    expect(preset?.name).toBe("Rainy rooftop");
    expect(preset?.premise).toBe("Caught in the rain on the rooftop bar.");
    expect(preset?.outfit).toBe("a soaked sundress");
    expect(preset?.outfitExposed).toBe(true);
    expect(preset?.startingStage).toBe("friendly");
    expect(preset?.socialCards.map((c) => c.id)).toEqual(["card-tea"]);

    const del = await presetDelete(delReq(id), presetCtx(id));
    expect(del.status).toBe(200);
    expect((await listPresets()).some((p) => p.id === id)).toBe(false);
  });

  it("applies the schema defaults on a minimal create (startingStage ⇒ stranger)", async (t) => {
    if (!ready) return t.skip();
    const res = await presetCreate(createReq({ name: "Bare minimum" }), collectionCtx);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const preset = (await listPresets()).find((p) => p.id === id);
    expect(preset).toMatchObject({
      premise: "",
      outfit: "",
      outfitExposed: false,
      socialCards: [],
      startingStage: "stranger",
    });
  });

  it("404s deleting another user's preset, leaving it untouched", async (t) => {
    if (!ready) return t.skip();
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

describe("POST /api/chats with presetId — scenario seeding (spec §1.5)", () => {
  it("seeds the new conversation's state row from the preset (regard via the stage bridge)", async (t) => {
    if (!ready) return t.skip();
    const created = await presetCreate(
      createReq({
        name: "Winter cabin",
        premise: "Snowed in together at the cabin.",
        outfit: "an oversized flannel shirt",
        outfitExposed: false,
        socialCards: [{ id: "card-quiet", label: "Keep voices low", kind: "social_rule", severity: 30 }],
        startingStage: "friendly",
      }),
      collectionCtx,
    );
    expect(created.status).toBe(201);
    const { id: presetId } = (await created.json()) as { id: string };

    const chatRes = await chatsCreate(
      chatCreateReq({ characterIds: [ids.character], memory: "fresh", presetId }),
      collectionCtx,
    );
    expect(chatRes.status).toBe(201);
    const { id: chatId } = (await chatRes.json()) as { id: string };

    const [state] = await db()
      .select({
        premise: characterChatState.premise,
        outfit: characterChatState.outfit,
        outfitExposed: characterChatState.outfitExposed,
        regard: characterChatState.regard,
        activeSocialCards: characterChatState.activeSocialCards,
      })
      .from(characterChatState)
      .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, ids.character)));
    expect(state).toBeDefined();
    expect(state?.premise).toBe("Snowed in together at the cabin.");
    expect(state?.outfit).toBe("an oversized flannel shirt");
    expect(state?.outfitExposed).toBe(false);
    expect(state?.regard).toBe(stageMidpoint("friendly")); // never the raw stage string
    const cards = state?.activeSocialCards as { id: string }[];
    expect(cards.map((c) => c.id)).toEqual(["card-quiet"]);
  });

  it("ignores a presetId the user does not own — the chat is created unseeded", async (t) => {
    if (!ready) return t.skip();
    const foreignId = newId();
    await db().insert(chatScenarioPresets).values({
      id: foreignId,
      ownerId: ids.otherUser,
      name: "Foreign",
      premise: "should never seed",
    });

    const chatRes = await chatsCreate(
      chatCreateReq({ characterIds: [ids.character], memory: "fresh", presetId: foreignId }),
      collectionCtx,
    );
    expect(chatRes.status).toBe(201); // a stale/foreign preset never fails the create
    const { id: chatId } = (await chatRes.json()) as { id: string };

    const [state] = await db()
      .select({ chatId: characterChatState.chatId })
      .from(characterChatState)
      .where(eq(characterChatState.chatId, chatId));
    expect(state).toBeUndefined(); // no state row was seeded
  });
});
