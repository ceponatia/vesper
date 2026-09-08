import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { itemDefinitionSchema } from "@/contracts";
import { characterSaveConflictSchema, characterSaveSchema } from "@/lib/client/api/library";
import { pseudoEmbed } from "@/server/ai";
import { characters, db, items, jobs } from "@/server/db";
import { readDailyUsage, resetRateLimits } from "@/server/api";
import { createImageAsset, saveOwnedImageBuffer } from "@/server/images";

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Character save", role: "admin" as const } }));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { apiRequest, bindAuthUser, endTestPool, expectApiError, expectJson, probeIntegrationDb, purgeOwnerRows, routeCtx, seedTestUser, testPngBuffer, withAuthUser, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { PATCH } from "./route";
import { POST as queueAvatar } from "./avatar/route";
import { POST as completeFromPortrait } from "./attributes/from-portrait/route";
import { POST as acceptPortrait } from "./portrait/accept/route";

const ready = await probeIntegrationDb("character-save.int.test", "characters");
let foreignId = "";
let dataRoot: TempDataRoot | null = null;
beforeAll(async () => {
  if (!ready) return;
  dataRoot = await withTempDataRoot("character-authoring-actions");
  bindAuthUser(authState, await seedTestUser("character-save-route", { role: "admin" }));
  foreignId = (await seedTestUser("character-save-foreign", { role: "admin" })).id;
  resetRateLimits();
});
afterAll(async () => {
  if (ready) await purgeOwnerRows([authState.user.id, foreignId]);
  await dataRoot?.cleanup();
  await endTestPool();
});
const patch = (id: string, body: unknown) => PATCH(apiRequest(`/api/characters/${id}`, { method: "PATCH", body }), routeCtx({ id }));
async function subject(name: string) {
  const [row] = await db().insert(characters).values({ ownerId: authState.user.id, name, profile: { creationBrief: "Original human concept", bio: "Before editing" } }).returning();
  return row!;
}
async function waitForJob(jobId: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [row] = await db().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (row && row.status !== "running" && row.status !== "queued") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms`);
}

describe.skipIf(!ready)("character PATCH optimistic recovery", () => {
  it("returns one save and one typed conflict for competing versions without materializing the loser", async () => {
    const row = await subject("Iris");
    const names = ["Harbor copper mantle 719", "Mountain violet boots 824"];
    const responses = await Promise.all(names.map((name) => patch(row.id, { name, expectedAuthoringRevision: row.authoringRevision, suggestedItems: [itemDefinitionSchema.parse({ name, kind: "clothing" })] })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerResponse = characterSaveSchema.parse(await expectJson(responses.find((response) => response.status === 200)!));
    const winner = winnerResponse.character;
    const conflict = characterSaveConflictSchema.parse(await expectJson(responses.find((response) => response.status === 409)!, 409));
    expect(conflict.character).toEqual(winner);
    const created = await db().select({ name: items.name }).from(items).where(eq(items.ownerId, authState.user.id));
    expect(created.filter((item) => names.includes(item.name))).toEqual([{ name: winner.name }]);
    expect(winnerResponse.materializedSuggestions).toHaveLength(1);
    expect(winner.profile.outfits[0]?.items).toContain(winnerResponse.materializedSuggestions[0]?.itemId);
  });

  it("returns monotonic authoring revisions for content saves and keeps metadata/no-op writes unchanged", async () => {
    const row = await subject("Token subject");
    const first = characterSaveSchema.parse(await expectJson(await patch(row.id, { name: "First", expectedAuthoringRevision: row.authoringRevision }))).character;
    const second = characterSaveSchema.parse(await expectJson(await patch(row.id, { name: "Second", expectedAuthoringRevision: first.authoringRevision }))).character;
    expect(first.authoringRevision).toBe(row.authoringRevision + 1);
    expect(second.authoringRevision).toBe(first.authoringRevision + 1);
    expect(Date.parse(first.updatedAt!)).toBeGreaterThan(row.updatedAt.getTime());
    expect(Date.parse(second.updatedAt!)).toBeGreaterThan(Date.parse(first.updatedAt!));
    const metadata = characterSaveSchema.parse(await expectJson(await patch(row.id, { visibility: "public", chatModel: "narrator-model", expectedAuthoringRevision: second.authoringRevision }))).character;
    expect(metadata.authoringRevision).toBe(second.authoringRevision);
    const noOp = characterSaveSchema.parse(await expectJson(await patch(row.id, { expectedAuthoringRevision: metadata.authoringRevision }))).character;
    expect(noOp.updatedAt).toBe(metadata.updatedAt);
    expect(noOp.authoringRevision).toBe(second.authoringRevision);
  });

  it("rechecks fuzzy item candidates in the save transaction using the prepared embedding", async () => {
    const row = await subject("Fuzzy save subject");
    const [existing] = await db().insert(items).values({
      ownerId: authState.user.id,
      kind: "clothing",
      name: "Faded Sky Route Shirt",
      searchEmbedding: pseudoEmbed("Route blue tee 883"),
      embedder: "pseudo",
    }).returning({ id: items.id });
    const saved = characterSaveSchema.parse(await expectJson(await patch(row.id, {
      expectedAuthoringRevision: row.authoringRevision,
      suggestedItems: [itemDefinitionSchema.parse({ kind: "clothing", name: "Route blue tee 883" })],
    })));
    expect(saved.materializedSuggestions).toEqual([{ index: 0, itemId: existing!.id }]);
    expect(saved.character.profile.outfits[0]?.items).toContain(existing!.id);
    const duplicates = await db().select({ id: items.id }).from(items)
      .where(and(eq(items.ownerId, authState.user.id), eq(items.name, "Route blue tee 883")));
    expect(duplicates).toEqual([]);
  });

  it("preserves partial merges for callers without a token and owner-only writes", async () => {
    const row = await subject("Legacy subject");
    const saved = characterSaveSchema.parse(await expectJson(await patch(row.id, { profile: { bio: "After editing" } }))).character;
    expect(saved.profile.creationBrief).toBe("Original human concept");
    expect(saved.profile.bio).toBe("After editing");
    await withAuthUser(authState, { id: foreignId }, async () => {
      await expectApiError(await patch(row.id, { name: "Foreign edit", expectedAuthoringRevision: saved.authoringRevision }), 404, "not_found");
    });
    const [unchanged] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(unchanged?.name).toBe(row.name);
  });
});

describe.skipIf(!ready)("revision-bound portrait actions", () => {
  it("accepts a portrait without silently starting paid reference-view renders", async () => {
    const row = await subject("Explicit reference build");
    const portrait = await createImageAsset({
      ownerId: authState.user.id,
      kind: "avatar",
      entityKind: "character",
      entityId: row.id,
      prompt: "portrait",
    });
    const saved = await saveOwnedImageBuffer(portrait.id, authState.user.id, await testPngBuffer(384, 512));
    await db().update(characters).set({ avatarImageId: saved?.id ?? portrait.id }).where(eq(characters.id, row.id));

    const accepted = await acceptPortrait(
      apiRequest(`/api/characters/${row.id}/portrait/accept`, { body: { imageId: saved?.id ?? portrait.id } }),
      routeCtx({ id: row.id }),
    );
    const body = await expectJson<{ acceptance: { acceptedImageId: string } }>(accepted);
    expect(body.acceptance.acceptedImageId).toBe(saved?.id ?? portrait.id);
    expect(body).not.toHaveProperty("views");
    const viewJobs = await db().select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.ownerId, authState.user.id),
      eq(jobs.type, "reference_views"),
      sql`${jobs.payload} ->> 'characterId' = ${row.id}`,
    ));
    expect(viewJobs).toEqual([]);
  });

  it("refuses a saturated avatar queue before consuming image budget", async () => {
    const row = await subject("Saturated portrait source");
    const blockers = await db().insert(jobs).values(Array.from({ length: 4 }, () => ({
      ownerId: authState.user.id,
      type: "avatar" as const,
      status: "running" as const,
      payload: { blocker: row.id },
      startedAt: new Date(),
      heartbeatAt: new Date(),
    }))).returning({ id: jobs.id });
    const before = await readDailyUsage(authState.user.id, "provider_image_day");
    const refused = await queueAvatar(
      apiRequest(`/api/characters/${row.id}/avatar`, { body: { authoringRevision: row.authoringRevision } }),
      routeCtx({ id: row.id }),
    );
    await expectApiError(refused, 429, "too_many_active_jobs");
    const after = await readDailyUsage(authState.user.id, "provider_image_day");
    expect(after.used).toBe(before.used);
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(inArray(jobs.id, blockers.map((job) => job.id)));
  });

  it("refuses a stale avatar source before queueing spend and records an accepted revision on the job", async () => {
    const row = await subject("Portrait source");
    const stale = await queueAvatar(
      apiRequest(`/api/characters/${row.id}/avatar`, { body: { authoringRevision: row.authoringRevision + 1 } }),
      routeCtx({ id: row.id }),
    );
    const conflict = await expectJson<{ error: { code: string } }>(stale, 409);
    expect(conflict.error.code).toBe("authoring_revision_changed");
    const refusedJobs = await db().select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.ownerId, authState.user.id), eq(jobs.type, "avatar"), sql`${jobs.payload} ->> 'characterId' = ${row.id}`));
    expect(refusedJobs).toEqual([]);

    const queued = await queueAvatar(
      apiRequest(`/api/characters/${row.id}/avatar`, { body: { authoringRevision: row.authoringRevision } }),
      routeCtx({ id: row.id }),
    );
    const accepted = await expectJson<{ jobId: string }>(queued, 202);
    const [job] = await db().select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, accepted.jobId));
    expect(job?.payload).toMatchObject({
      characterId: row.id,
      authoringRevision: row.authoringRevision,
      source: { name: row.name, profile: row.profile },
    });
    await waitForJob(accepted.jobId);
  });

  it("binds portrait completion to both the displayed image and saved content revision", async () => {
    const row = await subject("Extraction source");
    await db().update(characters).set({ avatarImageId: "portrait-current" }).where(eq(characters.id, row.id));

    const changedPortrait = await completeFromPortrait(
      apiRequest(`/api/characters/${row.id}/attributes/from-portrait`, {
        body: { authoringRevision: row.authoringRevision, imageId: "portrait-displayed" },
      }),
      routeCtx({ id: row.id }),
    );
    expect((await expectJson<{ error: { code: string } }>(changedPortrait, 409)).error.code).toBe("portrait_changed");

    await db().update(characters).set({ name: "Changed after display" }).where(eq(characters.id, row.id));
    const changedRevision = await completeFromPortrait(
      apiRequest(`/api/characters/${row.id}/attributes/from-portrait`, {
        body: { authoringRevision: row.authoringRevision, imageId: "portrait-current" },
      }),
      routeCtx({ id: row.id }),
    );
    expect((await expectJson<{ error: { code: string } }>(changedRevision, 409)).error.code).toBe("authoring_revision_changed");
  });
});
