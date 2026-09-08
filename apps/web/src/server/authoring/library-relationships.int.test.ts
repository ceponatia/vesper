import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyRelationshipTexture, type AuthoredRelationshipRecord } from "@/contracts";
import { characters, db } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import { getLibraryRelationships, saveLibraryRelationships } from "./library-relationships";

/** Real Postgres owns the transaction lock, compare-and-swap and rollback claims. */
const ready = await probeIntegrationDb("library-relationships.int.test", "character_relationship_versions");
const ids = { owner: "", otherOwner: "", source: "", targetA: "", targetB: "", foreignTarget: "" };
const record = (kind: string): AuthoredRelationshipRecord => ({
  ...emptyRelationshipTexture(),
  familiarity: "acquaintances",
  regard: "warm",
  kind,
});

beforeAll(async () => {
  if (!ready) return;
  ids.owner = (await seedTestUser("relationship-set-owner")).id;
  ids.otherOwner = (await seedTestUser("relationship-set-other")).id;
  const seeded = await db().insert(characters).values([
    { ownerId: ids.owner, name: "Source" },
    { ownerId: ids.owner, name: "Target A" },
    { ownerId: ids.owner, name: "Target B" },
    { ownerId: ids.otherOwner, name: "Foreign target" },
  ]).returning({ id: characters.id, name: characters.name });
  ids.source = seeded.find((row) => row.name === "Source")?.id ?? "";
  ids.targetA = seeded.find((row) => row.name === "Target A")?.id ?? "";
  ids.targetB = seeded.find((row) => row.name === "Target B")?.id ?? "";
  ids.foreignTarget = seeded.find((row) => row.name === "Foreign target")?.id ?? "";
  if (Object.values(ids).some((id) => id === "")) throw new Error("relationship fixtures were not seeded");
});

afterAll(async () => {
  if (ready) await purgeOwnerRows([ids.owner, ids.otherOwner]);
  await endTestPool();
});

describe.skipIf(!ready)("library relationship replace-set revisions", () => {
  it("lets exactly one same-version writer replace the set and returns the winner to the loser", async () => {
    expect(await getLibraryRelationships(ids.owner, ids.source)).toEqual({ revision: 0, edges: [] });
    const outcomes = await Promise.all([
      saveLibraryRelationships(ids.owner, ids.source, 0, [
        { toCharacterId: ids.targetA, record: record("old friends") },
      ]),
      saveLibraryRelationships(ids.owner, ids.source, 0, [
        { toCharacterId: ids.targetB, record: record("rivals") },
      ]),
    ]);
    const winners = outcomes.filter((outcome) => outcome.ok);
    const conflicts = outcomes.filter((outcome) => !outcome.ok && outcome.code === "relationship_conflict");
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const current = await getLibraryRelationships(ids.owner, ids.source);
    expect(current?.revision).toBe(1);
    expect(conflicts[0]).toMatchObject({ code: "relationship_conflict", current });
  });

  it("rolls back the entire replacement and revision when any target is invalid", async () => {
    const before = await getLibraryRelationships(ids.owner, ids.source);
    if (!before) throw new Error("source fixture missing");
    const outcome = await saveLibraryRelationships(ids.owner, ids.source, before.revision, [
      { toCharacterId: ids.targetA, record: record("trusted") },
      { toCharacterId: ids.foreignTarget, record: record("should not save") },
    ]);
    expect(outcome).toEqual({ ok: false, code: "target_not_found" });
    expect(await getLibraryRelationships(ids.owner, ids.source)).toEqual(before);
  });

  it("versions an empty replacement and refuses reuse of its previous revision", async () => {
    const before = await getLibraryRelationships(ids.owner, ids.source);
    if (!before) throw new Error("source fixture missing");
    const cleared = await saveLibraryRelationships(ids.owner, ids.source, before.revision, []);
    expect(cleared).toEqual({ ok: true, value: { revision: before.revision + 1, edges: [] } });
    const stale = await saveLibraryRelationships(ids.owner, ids.source, before.revision, []);
    expect(stale).toMatchObject({ ok: false, code: "relationship_conflict", current: { revision: before.revision + 1, edges: [] } });
  });

  it("keeps source ownership indistinguishable from absence", async () => {
    expect(await getLibraryRelationships(ids.otherOwner, ids.source)).toBeNull();
    expect(await saveLibraryRelationships(ids.otherOwner, ids.source, 0, [])).toEqual({ ok: false, code: "not_found" });
  });
});
