import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  characters,
  db,
  images,
  itemInstances,
  items,
  jobs,
  locations,
  sessions,
  users,
  worldCast,
  worldItems,
  worldLinks,
  worldLocations,
  worlds,
} from "@/server/db";

// Demo-mode session route suite (docs/testing.md §api): handlers invoked
// directly with mocked auth against DATABASE_URL. Self-skips when the
// database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Brian", role: "admin" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { createSessionFromWorld, HEARTBEAT_STALE_MS } from "@/server/engine";
import { GET as listSessionsRoute } from "./route";
import { DELETE as deleteSessionRoute, GET as getSessionRoute } from "./[id]/route";
import { POST as restartRoute } from "./[id]/restart/route";
import { GET as feedRoute } from "./[id]/feed/route";
import { GET as statusRoute } from "./[id]/status/route";
import { GET as jobRoute } from "./[id]/job/route";
import { POST as turnsRoute } from "./[id]/turns/route";
import { GET as inspectRoute } from "./[id]/turns/[turnId]/inspect/route";
import { PATCH as patchMessageRoute } from "./[id]/messages/[messageId]/route";
import { POST as rerunRoute } from "./[id]/messages/[messageId]/rerun/route";
import { GET as relationshipsRoute } from "./[id]/relationships/route";
import { POST as sceneRoute } from "./[id]/scene/route";
import { POST as clothingRoute } from "./[id]/participants/[participantId]/clothing/route";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sessions limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sessions-routes.int.test] skipping: database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
let ownerId = "";
let worldId = "";
let tmpDataRoot = "";

function get(url: string): NextRequest {
  return new NextRequest(url);
}
function send(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
function ctx<P>(params: P): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}
async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data: dataLine ? (JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>) : {},
      };
    });
}

async function pollUntilReady(sessionId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await jobRoute(get(`http://test/api/sessions/${sessionId}/job`), ctx({ id: sessionId }));
    const body = await json(res);
    if (body["status"] === "ready") return;
    if (Date.now() > deadline) throw new Error(`session never returned to ready: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function playTurn(sessionId: string, input: string): Promise<SseEvent[]> {
  const res = await turnsRoute(
    send(`http://test/api/sessions/${sessionId}/turns`, "POST", { input, author: "player" }),
    ctx({ id: sessionId }),
  );
  expect(res.status).toBe(200);
  const events = await readSse(res);
  await pollUntilReady(sessionId);
  return events;
}

async function spawn(title: string): Promise<string> {
  const created = await createSessionFromWorld({ worldId, userId: ownerId, title, embodied: true });
  if (!created) throw new Error("session spawn failed");
  return created.sessionId;
}

interface FeedMessage {
  messageId: string;
  turnId: string;
  turnNumber: number;
  seq: number;
  role: string;
  speaker: string | null;
  content: string;
}

async function loadFeed(sessionId: string, query = ""): Promise<{
  messages: FeedMessage[];
  hasMore: boolean;
  nextBefore: number | null;
  tailTurn: { id: string; number: number; status: string } | null;
}> {
  const res = await feedRoute(get(`http://test/api/sessions/${sessionId}/feed${query}`), ctx({ id: sessionId }));
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof loadFeed>>;
}

beforeAll(async () => {
  if (!ready) return;
  tmpDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vesper-sessions-int-"));
  process.env.DATA_ROOT = tmpDataRoot;

  const [user] = await db()
    .insert(users)
    .values({ email: `sessions-int-${Date.now()}@test.local`, name: "Brian", role: "admin" })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  ownerId = user.id;
  authState.user.id = ownerId;

  const [kitchen] = await db()
    .insert(locations)
    .values({ ownerId, name: "Kitchen", description: "A warm farmhouse kitchen.", ambient: { scent: "bread" } })
    .returning({ id: locations.id });
  const [garden] = await db()
    .insert(locations)
    .values({ ownerId, name: "Garden", description: "An overgrown herb garden." })
    .returning({ id: locations.id });
  if (!kitchen || !garden) throw new Error("location insert failed");

  const [sundress] = await db()
    .insert(items)
    .values({
      ownerId,
      kind: "clothing",
      name: "sundress",
      description: "A pale yellow sundress.",
      definition: { coverage: ["torso"], layer: 1, opacity: "opaque" },
    })
    .returning({ id: items.id });
  const [lantern] = await db()
    .insert(items)
    .values({ ownerId, kind: "object", name: "lantern", description: "A brass lantern." })
    .returning({ id: items.id });
  if (!sundress || !lantern) throw new Error("item insert failed");

  const [maya] = await db()
    .insert(characters)
    .values({ ownerId, name: "Maya", profile: { bio: "Maya grew up coastal.", defaultOutfit: [sundress.id] } })
    .returning({ id: characters.id });
  if (!maya) throw new Error("character insert failed");

  const [world] = await db()
    .insert(worlds)
    .values({
      ownerId,
      name: "Session Routes World",
      lore: { synopsis: "A quiet inn.", plotAnchors: [{ id: "anchor-1", title: "The missing brother", priority: "active" }] },
    })
    .returning({ id: worlds.id });
  if (!world) throw new Error("world insert failed");
  worldId = world.id;

  const [wlKitchen] = await db()
    .insert(worldLocations)
    .values({ worldId, sourceLocationId: kitchen.id, snapshot: { name: "Kitchen", description: "A warm farmhouse kitchen.", ambient: { scent: "bread" } } })
    .returning({ id: worldLocations.id });
  const [wlGarden] = await db()
    .insert(worldLocations)
    .values({ worldId, sourceLocationId: garden.id, snapshot: { name: "Garden", description: "An overgrown herb garden." } })
    .returning({ id: worldLocations.id });
  if (!wlKitchen || !wlGarden) throw new Error("world location insert failed");
  await db()
    .insert(worldLinks)
    .values({ worldId, fromWorldLocationId: wlKitchen.id, toWorldLocationId: wlGarden.id, label: "back door" });
  await db().insert(worldCast).values({
    worldId,
    sourceCharacterId: maya.id,
    name: "Maya",
    snapshot: { bio: "Maya grew up coastal.", defaultOutfit: [sundress.id] },
    role: "companion",
    startWorldLocationId: wlKitchen.id,
    // Maya's bio names no bond kind (indeterminate) ⇒ perceived mirrors the midpoint.
    relationships: [{ toward: "player", stage: "friendly" }],
  });
  await db().insert(worldItems).values({ worldId, sourceItemId: lantern.id, name: "lantern", snapshot: { kind: "object", name: "lantern", description: "A brass lantern." }, worldLocationId: wlKitchen.id });
});

afterAll(async () => {
  if (ready && ownerId) {
    await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
    await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
    await db().delete(characters).where(eq(characters.ownerId, ownerId));
    await db().delete(locations).where(eq(locations.ownerId, ownerId));
    await db().delete(items).where(eq(items.ownerId, ownerId));
    await db().delete(images).where(eq(images.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  if (tmpDataRoot) await fs.rm(tmpDataRoot, { recursive: true, force: true });
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("session routes (demo mode)", () => {
  it("lists owned sessions with the world name", async () => {
    const sessionId = await spawn("List me");
    const res = await listSessionsRoute(get("http://test/api/sessions?recent=1"), ctx({}));
    expect(res.status).toBe(200);
    const body = await json(res);
    const rows = body["sessions"] as Array<Record<string, unknown>>;
    const mine = rows.find((r) => r["id"] === sessionId);
    expect(mine).toBeDefined();
    expect(mine?.["worldName"]).toBe("Session Routes World");
    expect(mine?.["status"]).toBe("ready");

    const detail = await getSessionRoute(get(`http://test/api/sessions/${sessionId}`), ctx({ id: sessionId }));
    expect(detail.status).toBe(200);
    const detailBody = (await json(detail))["session"] as Record<string, unknown>;
    expect(detailBody["title"]).toBe("List me");
    expect(detailBody["worldName"]).toBe("Session Routes World");
  });

  it("surfaces authored relationship edges at turn 0 (stages only, no raw values)", async () => {
    const sessionId = await spawn("Relationships turn 0");
    const res = await relationshipsRoute(get(`http://test/api/sessions/${sessionId}/relationships`), ctx({ id: sessionId }));
    expect(res.status).toBe(200);
    const body = await json(res);
    const rows = body["relationships"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2); // Maya's seeded feeling + perceived edges toward the player
    expect(new Set(rows.map((r) => r["kind"]))).toEqual(new Set(["feeling", "perceived"]));
    for (const row of rows) {
      expect(row["stage"]).toBe("friendly");
      expect(row).not.toHaveProperty("value"); // affinity values never leave the server
    }
  });

  it("rejects an invalid turn body with the 400 envelope", async () => {
    const sessionId = await spawn("Bad body");
    const res = await turnsRoute(send(`http://test/api/sessions/${sessionId}/turns`, "POST", {}), ctx({ id: sessionId }));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("invalid_body");
  });

  it("returns 409 JSON (not a stream) when the session is busy", async () => {
    const sessionId = await spawn("Busy");
    // "narrating" = an active turn → the busy guard fails fast. (A "processing"
    // session instead waits out the post-turn window before 409 — UX-audit M3 —
    // which is correct product behavior but too slow to assert here.)
    await db().update(sessions).set({ status: "narrating" }).where(eq(sessions.id, sessionId));
    const res = await turnsRoute(
      send(`http://test/api/sessions/${sessionId}/turns`, "POST", { input: "I wave.", author: "player" }),
      ctx({ id: sessionId }),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await json(res);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("session_busy");
    await db().update(sessions).set({ status: "ready" }).where(eq(sessions.id, sessionId));
  });

  it("plays a turn over SSE and exposes the feed and status payloads", async () => {
    const sessionId = await spawn("Full turn");
    const events = await playTurn(sessionId, "I look around the kitchen and greet Maya.");

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("start");
    expect(kinds).toContain("chunk");
    expect(kinds).toContain("status");
    expect(kinds.at(-1)).toBe("done");
    expect(kinds).not.toContain("error");
    expect(typeof events[0]?.data["turnId"]).toBe("string");
    expect(events[0]?.data["turnNumber"]).toBe(1);
    const statusEvent = events.find((e) => e.event === "status");
    expect(statusEvent?.data["phase"]).toBe("processing");

    // feed: input first, then narration segments, tail turn ready
    const feed = await loadFeed(sessionId);
    expect(feed.hasMore).toBe(false);
    expect(feed.messages.length).toBeGreaterThan(1);
    expect(feed.messages[0]?.role).toBe("player");
    expect(feed.messages[0]?.seq).toBe(0);
    expect(feed.messages.some((m) => m.role === "narrator" || m.role === "character")).toBe(true);
    expect(feed.tailTurn?.status).toBe("ready");
    expect(feed.tailTurn?.number).toBe(1);

    // an exhausted cursor page is empty, not an error
    const older = await loadFeed(sessionId, "?before=1");
    expect(older.messages).toEqual([]);
    expect(older.hasMore).toBe(false);

    const badCursor = await feedRoute(get(`http://test/api/sessions/${sessionId}/feed?before=zero`), ctx({ id: sessionId }));
    expect(badCursor.status).toBe(400);

    // status: sidebar payload
    const statusRes = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    expect(statusRes.status).toBe(200);
    const status = await json(statusRes);
    const participants = status["participants"] as Array<Record<string, unknown>>;
    expect(participants).toHaveLength(2);
    const maya = participants.find((p) => p["displayName"] === "Maya");
    expect(maya?.["role"]).toBe("companion");
    expect(maya?.["wardrobe"]).toEqual([{ instanceId: expect.any(String), name: "sundress", visibility: "visible" }]);
    expect(typeof maya?.["meters"]).toBe("object");

    const clock = status["clock"] as Record<string, unknown>;
    expect(typeof clock["minutes"]).toBe("number");
    expect(clock["minutes"]).toBeGreaterThan(0); // the merge advanced the clock
    expect(String(clock["display"])).toMatch(/\d{1,2}:\d{2}(am|pm)/);

    const location = status["location"] as Record<string, unknown>;
    expect(location["name"]).toBe("Kitchen");
    expect((location["items"] as Array<Record<string, unknown>>).map((i) => i["name"])).toContain("lantern");

    expect(status["exposure"]).toMatchObject({ appearance: expect.any(String) });
    const sceneGen = status["sceneGen"] as Record<string, unknown>;
    expect(sceneGen["status"]).toBe("idle");
    expect(sceneGen["latestImageId"]).toBeNull();

    const threads = status["threads"] as Array<Record<string, unknown>>;
    expect(threads.map((t) => t["title"])).toContain("The missing brother");
  });

  it("admin dev clothing route removes worn clothing to held inventory and wears it again", async () => {
    const sessionId = await spawn("Clothing debug");
    const statusRes = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    expect(statusRes.status).toBe(200);
    const status = await json(statusRes);
    const participants = status["participants"] as Array<Record<string, unknown>>;
    const maya = participants.find((p) => p["displayName"] === "Maya");
    expect(maya).toBeDefined();
    if (!maya) return;
    const participantId = String(maya["id"]);
    const worn = (maya["wornFull"] as Array<Record<string, unknown>>).find((item) => item["name"] === "sundress");
    const itemInstanceId = String(worn?.["instanceId"] ?? "");
    expect(itemInstanceId.length).toBeGreaterThan(0);

    let denied: Response | null = null;
    try {
      authState.user.role = "user";
      denied = await clothingRoute(
        send(`http://test/api/sessions/${sessionId}/participants/${participantId}/clothing`, "POST", {
          action: "remove",
          itemInstanceId,
        }),
        ctx({ id: sessionId, participantId }),
      );
    } finally {
      authState.user.role = "admin";
    }
    expect(denied?.status).toBe(403);

    const removeRes = await clothingRoute(
      send(`http://test/api/sessions/${sessionId}/participants/${participantId}/clothing`, "POST", {
        action: "remove",
        itemInstanceId,
      }),
      ctx({ id: sessionId, participantId }),
    );
    expect(removeRes.status).toBe(200);
    expect((await json(removeRes))["worn"]).toBe(false);

    const [removed] = await db()
      .select({
        holderParticipantId: itemInstances.holderParticipantId,
        worn: itemInstances.worn,
        locationId: itemInstances.locationId,
        containerInstanceId: itemInstances.containerInstanceId,
      })
      .from(itemInstances)
      .where(eq(itemInstances.id, itemInstanceId))
      .limit(1);
    expect(removed).toEqual({
      holderParticipantId: participantId,
      worn: false,
      locationId: null,
      containerInstanceId: null,
    });

    const afterRemove = await json(
      await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId })),
    );
    const mayaAfterRemove = (afterRemove["participants"] as Array<Record<string, unknown>>).find(
      (p) => p["id"] === participantId,
    );
    expect(mayaAfterRemove?.["wardrobe"]).toEqual([]);
    expect(mayaAfterRemove?.["held"]).toContainEqual({ id: itemInstanceId, name: "sundress", kind: "clothing" });

    await db().update(sessions).set({ status: "processing" }).where(eq(sessions.id, sessionId));
    const busy = await clothingRoute(
      send(`http://test/api/sessions/${sessionId}/participants/${participantId}/clothing`, "POST", {
        action: "wear",
        itemInstanceId,
      }),
      ctx({ id: sessionId, participantId }),
    );
    expect(busy.status).toBe(409);
    await db().update(sessions).set({ status: "ready" }).where(eq(sessions.id, sessionId));

    const wearRes = await clothingRoute(
      send(`http://test/api/sessions/${sessionId}/participants/${participantId}/clothing`, "POST", {
        action: "wear",
        itemInstanceId,
      }),
      ctx({ id: sessionId, participantId }),
    );
    expect(wearRes.status).toBe(200);
    expect((await json(wearRes))["worn"]).toBe(true);

    const [wornAgain] = await db()
      .select({ holderParticipantId: itemInstances.holderParticipantId, worn: itemInstances.worn })
      .from(itemInstances)
      .where(eq(itemInstances.id, itemInstanceId))
      .limit(1);
    expect(wornAgain).toEqual({ holderParticipantId: participantId, worn: true });
  });

  it("edits a narration message and reconciles", async () => {
    const sessionId = await spawn("Edit");
    await playTurn(sessionId, "I pick up the lantern.");
    const feed = await loadFeed(sessionId);
    const narration = feed.messages.find((m) => m.seq > 0 && (m.role === "narrator" || m.role === "character"));
    expect(narration).toBeDefined();
    if (!narration) return;

    const res = await patchMessageRoute(
      send(`http://test/api/sessions/${sessionId}/messages/${narration.messageId}`, "PATCH", {
        content: "The lantern flickers, edited.",
      }),
      ctx({ id: sessionId, messageId: narration.messageId }),
    );
    expect(res.status).toBe(200);
    await pollUntilReady(sessionId); // reconcile job drains

    const after = await loadFeed(sessionId);
    const edited = after.messages.find((m) => m.messageId === narration.messageId);
    expect(edited?.content).toBe("The lantern flickers, edited.");
  });

  it("reruns the latest turn over SSE and refuses older turns", async () => {
    const sessionId = await spawn("Rerun");
    await playTurn(sessionId, "I say hello to Maya.");
    await playTurn(sessionId, "I sit down at the table.");

    const feed = await loadFeed(sessionId);
    const oldMessage = feed.messages.find((m) => m.turnNumber === 1);
    const latestInput = feed.messages.find((m) => m.turnNumber === 2 && m.seq === 0);
    expect(oldMessage && latestInput).toBeTruthy();
    if (!oldMessage || !latestInput) return;

    const refused = await rerunRoute(
      send(`http://test/api/sessions/${sessionId}/messages/${oldMessage.messageId}/rerun`, "POST"),
      ctx({ id: sessionId, messageId: oldMessage.messageId }),
    );
    expect(refused.status).toBe(409);
    expect(((await json(refused))["error"] as Record<string, unknown>)["code"]).toBe("not_latest");

    const res = await rerunRoute(
      send(`http://test/api/sessions/${sessionId}/messages/${latestInput.messageId}/rerun`, "POST"),
      ctx({ id: sessionId, messageId: latestInput.messageId }),
    );
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events[0]?.event).toBe("start");
    expect(events.at(-1)?.event).toBe("done");
    await pollUntilReady(sessionId);

    const after = await loadFeed(sessionId);
    expect(after.tailTurn?.number).toBe(2);
    expect(after.tailTurn?.status).toBe("ready");
    expect(after.messages.find((m) => m.turnNumber === 2 && m.seq === 0)?.content).toBe("I sit down at the table.");
  });

  it("admin-gates the turn inspector and returns agent results + diagnostics", async () => {
    const sessionId = await spawn("Inspect");
    const events = await playTurn(sessionId, "I check the cupboards.");
    const turnId = String(events[0]?.data["turnId"]);

    authState.user.role = "user";
    const denied = await inspectRoute(
      get(`http://test/api/sessions/${sessionId}/turns/${turnId}/inspect`),
      ctx({ id: sessionId, turnId }),
    );
    expect(denied.status).toBe(403);
    authState.user.role = "admin";

    const res = await inspectRoute(
      get(`http://test/api/sessions/${sessionId}/turns/${turnId}/inspect`),
      ctx({ id: sessionId, turnId }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body["turn"] as Record<string, unknown>)["input"]).toBe("I check the cupboards.");
    expect((body["turn"] as Record<string, unknown>)["status"]).toBe("ready");
    expect(typeof body["agentResults"]).toBe("object");
    expect(Array.isArray(body["diagnostics"])).toBe(true);
    expect(Array.isArray(body["retrievalEvents"])).toBe(true);
  });

  it("scene actions: setInterval persists, generate queues a scene_image job", async () => {
    const sessionId = await spawn("Scene");
    await playTurn(sessionId, "I light the lantern.");

    const intervalRes = await sceneRoute(
      send(`http://test/api/sessions/${sessionId}/scene`, "POST", { action: "setInterval", interval: 5 }),
      ctx({ id: sessionId }),
    );
    expect(intervalRes.status).toBe(200);
    const intervalBody = await json(intervalRes);
    expect((intervalBody["scene"] as Record<string, unknown>)["interval"]).toBe(5);

    const genRes = await sceneRoute(
      send(`http://test/api/sessions/${sessionId}/scene`, "POST", { action: "generate" }),
      ctx({ id: sessionId }),
    );
    expect([200, 202]).toContain(genRes.status);
    const genBody = await json(genRes);
    const jobId = String(genBody["jobId"]);

    const deadline = Date.now() + 20_000;
    for (;;) {
      const [row] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (row && row.status !== "queued" && row.status !== "running") {
        expect(row.status).toBe("done");
        break;
      }
      if (Date.now() > deadline) throw new Error("scene job never settled");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // demo-mode monogram lands in the session gallery and surfaces in status
    const [imageRow] = await db()
      .select({ id: images.id, status: images.status })
      .from(images)
      .where(and(eq(images.sessionId, sessionId), eq(images.kind, "scene")))
      .limit(1);
    expect(imageRow?.status).toBe("ready");

    const statusRes = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    const status = await json(statusRes);
    expect((status["sceneGen"] as Record<string, unknown>)["latestImageId"]).toBe(imageRow?.id);
  });

  it("status self-heals an orphaned generating scene state to failed (no live job)", async () => {
    const sessionId = await spawn("Scene reconcile orphan");
    await db()
      .update(sessions)
      .set({ scene: { interval: 0, status: "generating" } })
      .where(eq(sessions.id, sessionId));

    const res = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    expect(res.status).toBe(200);
    const status = await json(res);
    expect((status["sceneGen"] as Record<string, unknown>)["status"]).toBe("failed");

    // The flip persisted — the next poll doesn't re-reconcile a spinner.
    const [row] = await db().select({ scene: sessions.scene }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect((row?.scene as Record<string, unknown>)["status"]).toBe("failed");
  });

  it("status treats a stale-heartbeat scene job as dead and fails the scene state", async () => {
    const sessionId = await spawn("Scene reconcile stale");
    await db()
      .update(sessions)
      .set({ scene: { interval: 0, status: "generating" } })
      .where(eq(sessions.id, sessionId));
    await db().insert(jobs).values({
      sessionId,
      type: "scene_image",
      status: "running",
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 5_000),
    });

    const res = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    const status = await json(res);
    expect((status["sceneGen"] as Record<string, unknown>)["status"]).toBe("failed");
  });

  it("status leaves a generating scene state alone while a live job exists", async () => {
    const sessionId = await spawn("Scene reconcile live");
    await db()
      .update(sessions)
      .set({ scene: { interval: 0, status: "generating" } })
      .where(eq(sessions.id, sessionId));
    const [job] = await db()
      .insert(jobs)
      .values({ sessionId, type: "scene_image", status: "queued" })
      .returning({ id: jobs.id });

    const res = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    const status = await json(res);
    expect((status["sceneGen"] as Record<string, unknown>)["status"]).toBe("generating");

    const [row] = await db().select({ scene: sessions.scene }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    expect((row?.scene as Record<string, unknown>)["status"]).toBe("generating");

    // cleanup: don't leave a queued job for recovery sweeps to chew on
    if (job) await db().delete(jobs).where(eq(jobs.id, job.id));
    await db().update(sessions).set({ scene: { interval: 0, status: "idle" } }).where(eq(sessions.id, sessionId));
  });

  it("restart wipes the feed and resets the clock; delete removes the session", async () => {
    const sessionId = await spawn("Restart-delete");
    await playTurn(sessionId, "I head to the Garden.");
    expect((await loadFeed(sessionId)).messages.length).toBeGreaterThan(0);

    const restartRes = await restartRoute(send(`http://test/api/sessions/${sessionId}/restart`, "POST"), ctx({ id: sessionId }));
    expect(restartRes.status).toBe(200);
    expect((await json(restartRes))["ok"]).toBe(true);

    const feed = await loadFeed(sessionId);
    expect(feed.messages).toEqual([]);
    expect(feed.tailTurn).toBeNull();

    const statusRes = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    const status = await json(statusRes);
    expect((status["clock"] as Record<string, unknown>)["minutes"]).toBe(0);

    const deleteRes = await deleteSessionRoute(get(`http://test/api/sessions/${sessionId}`), ctx({ id: sessionId }));
    expect(deleteRes.status).toBe(200);
    const goneRes = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
    expect(goneRes.status).toBe(404);
  });

  it("never leaks another user's session", async () => {
    const sessionId = await spawn("Private");
    const original = authState.user.id;
    authState.user = { ...authState.user, id: "someone-else" };
    try {
      const statusRes = await statusRoute(get(`http://test/api/sessions/${sessionId}/status`), ctx({ id: sessionId }));
      expect(statusRes.status).toBe(404);
      const turnRes = await turnsRoute(
        send(`http://test/api/sessions/${sessionId}/turns`, "POST", { input: "I snoop.", author: "player" }),
        ctx({ id: sessionId }),
      );
      expect(turnRes.status).toBe(404);
    } finally {
      authState.user = { ...authState.user, id: original };
    }
  });
});
