import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db } from "@/server/db";
import { blankCreatedCharacterContent, resetRateLimits } from "@/server/api";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Character create", role: "admin" as const },
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
import { POST } from "./route";

const ready = await probeIntegrationDb("character-create.int.test", "characters");

beforeAll(async () => {
  if (!ready) return;
  bindAuthUser(authState, await seedTestUser("character-create-route", { role: "admin" }));
  resetRateLimits();
});

afterAll(async () => {
  if (ready) await purgeOwnerRows([authState.user.id]);
  await endTestPool();
});

describe.skipIf(!ready)("character POST creation", () => {
  it("stores exactly the shared blank content for a blank create, at authoring revision 1", async () => {
    // A first Forge applies without review only while a character still equals
    // this content, so the create path and that check must agree through jsonb.
    const created = await expectJson<{ character: { id: string } }>(
      await POST(apiRequest("/api/characters", { method: "POST", body: { name: "New character" } }), routeCtx()),
      201,
    );
    const [row] = await db()
      .select({ profile: characters.profile, tags: characters.tags, authoringRevision: characters.authoringRevision })
      .from(characters)
      .where(eq(characters.id, created.character.id));
    const blank = blankCreatedCharacterContent();
    expect(row?.authoringRevision).toBe(1);
    expect(row?.profile).toEqual(blank.profile);
    expect(row?.tags).toEqual(blank.tags);
  });
});
