import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyCharacterProfile } from "@/contracts";
import { emptyCharacterDraft } from "@/lib/client/api";
import { characters, db, jobs } from "@/server/db";
import { resetRateLimits } from "@/server/api";

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Authoring runs", role: "admin" as const } }));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { apiRequest, bindAuthUser, endTestPool, expectJson, probeIntegrationDb, purgeOwnerRows, routeCtx, seedTestUser, withAuthUser } from "@/server/test-support";
import { GET as listRuns, POST as startRun } from "./route";
import { PATCH as decideRun } from "./[runId]/decision/route";

const ready = await probeIntegrationDb("character-authoring-runs.int.test", "jobs");
let foreignId = "";
beforeAll(async () => {
  if (!ready) return;
  bindAuthUser(authState, await seedTestUser("character-authoring-runs", { role: "admin" }));
  foreignId = (await seedTestUser("character-authoring-runs-foreign", { role: "admin" })).id;
  resetRateLimits();
});
afterAll(async () => {
  if (ready) await purgeOwnerRows([authState.user.id, foreignId]);
  await endTestPool();
});

async function subject(name: string) {
  const [row] = await db().insert(characters).values({ ownerId: authState.user.id, name, profile: emptyCharacterProfile() }).returning();
  return row!;
}
async function waitForJob(id: string, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [row] = await db().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).limit(1);
    if (row && row.status !== "running" && row.status !== "queued") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${id} did not settle`);
}
const list = (kind: "creation" | "character", id?: string) => listRuns(
  apiRequest(`/api/characters/authoring-runs?targetKind=${kind}${id ? `&targetId=${id}` : ""}`),
  routeCtx({}),
);

function storedRun(input: { id: string; characterId: string; revision: number; before: string; after: string }) {
  const base = { ...emptyCharacterDraft(), name: input.before };
  const proposed = { ...base, name: input.after };
  return {
    id: input.id,
    ownerId: authState.user.id,
    type: "character_authoring" as const,
    status: "done" as const,
    attempts: 1,
    startedAt: new Date(),
    finishedAt: new Date(),
    payload: {
      kind: "character_authoring_run",
      intent: {
        requestId: input.id,
        target: { kind: "character", id: input.characterId },
        operation: "redraft",
        scope: "profile",
        label: "profile rewrite",
        base,
        creationStart: null,
        source: { authoringRevision: input.revision, imageId: null },
        retryOf: null,
        rootRunId: input.id,
        intentHash: "fixture",
      },
      proposal: { revision: 1, status: "unresolved", choices: {}, appliedDraft: null, undo: null },
      result: { proposed, diagnostics: [] },
    },
  };
}

describe.skipIf(!ready)("server-authoritative character authoring runs", () => {
  it("converges duplicate starts, resumes by owner, and does not spend on reload", async () => {
    const row = await subject("Idempotent source");
    const requestId = crypto.randomUUID();
    const base = { ...emptyCharacterDraft(), name: row.name, profile: row.profile };
    const body = {
      requestId,
      target: { kind: "character", id: row.id },
      operation: "fill",
      scope: "profile",
      label: "missing Profile details",
      base,
      creationStart: null,
      source: { authoringRevision: row.authoringRevision, imageId: null },
    };
    const responses = await Promise.all([
      startRun(apiRequest("/api/characters/authoring-runs", { method: "POST", body }), routeCtx({})),
      startRun(apiRequest("/api/characters/authoring-runs", { method: "POST", body }), routeCtx({})),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect((await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, requestId)))).toHaveLength(1);
    await waitForJob(requestId);

    const beforeReload = await db().select({ id: jobs.id }).from(jobs).where(and(eq(jobs.ownerId, authState.user.id), eq(jobs.type, "character_authoring")));
    const resumed = await expectJson<{ runs: { id: string; status: string }[] }>(await list("character", row.id));
    expect(resumed.runs).toEqual(expect.arrayContaining([expect.objectContaining({ id: requestId, status: "completed" })]));
    const afterReload = await db().select({ id: jobs.id }).from(jobs).where(and(eq(jobs.ownerId, authState.user.id), eq(jobs.type, "character_authoring")));
    expect(afterReload).toHaveLength(beforeReload.length);
    await withAuthUser(authState, { id: foreignId }, async () => {
      expect((await expectJson<{ runs: unknown[] }>(await list("character", row.id))).runs).toEqual([]);
    });
  });

  it("persists accept and undo while preserving independent edits", async () => {
    const row = await subject("Original name");
    await db().insert(jobs).values(storedRun({ id: "authoring-accept-run", characterId: row.id, revision: row.authoringRevision, before: row.name, after: "Proposed name" }));
    const [edited] = await db().update(characters).set({ tags: ["independent"] }).where(eq(characters.id, row.id)).returning();

    const accepted = await decideRun(apiRequest("/api/characters/authoring-runs/authoring-accept-run/decision", {
      method: "PATCH",
      body: { action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: edited!.authoringRevision, choices: {} },
    }), routeCtx({ runId: "authoring-accept-run" }));
    const acceptedBody = await expectJson<{ run: { proposal: { revision: number; status: string; undo: unknown } } }>(accepted);
    expect(acceptedBody.run.proposal).toMatchObject({ revision: 2, status: "accepted" });
    expect(acceptedBody.run.proposal.undo).not.toBeNull();
    const [afterAccept] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(afterAccept).toMatchObject({ name: "Proposed name", tags: ["independent"] });

    const undone = await decideRun(apiRequest("/api/characters/authoring-runs/authoring-accept-run/decision", {
      method: "PATCH",
      body: { action: "undo", expectedProposalRevision: 2, expectedAuthoringRevision: afterAccept!.authoringRevision, choices: {} },
    }), routeCtx({ runId: "authoring-accept-run" }));
    expect((await expectJson<{ run: { proposal: { status: string } } }>(undone)).run.proposal.status).toBe("undone");
    const [afterUndo] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(afterUndo).toMatchObject({ name: "Original name", tags: ["independent"] });
  });

  it("conditions rejection on both proposal and authoring revisions", async () => {
    const row = await subject("Reject revision source");
    await db().insert(jobs).values(storedRun({ id: "authoring-reject-run", characterId: row.id, revision: row.authoringRevision, before: row.name, after: "Unused proposal" }));
    const [edited] = await db().update(characters).set({ tags: ["newer"] }).where(eq(characters.id, row.id)).returning();

    const stale = await decideRun(apiRequest("/api/characters/authoring-runs/authoring-reject-run/decision", {
      method: "PATCH",
      body: { action: "reject", expectedProposalRevision: 1, expectedAuthoringRevision: row.authoringRevision, choices: {} },
    }), routeCtx({ runId: "authoring-reject-run" }));
    expect((await expectJson<{ error: { code: string } }>(stale, 409)).error.code).toBe("authoring_conflict");

    const rejected = await decideRun(apiRequest("/api/characters/authoring-runs/authoring-reject-run/decision", {
      method: "PATCH",
      body: { action: "reject", expectedProposalRevision: 1, expectedAuthoringRevision: edited!.authoringRevision, choices: {} },
    }), routeCtx({ runId: "authoring-reject-run" }));
    expect((await expectJson<{ run: { proposal: { status: string } } }>(rejected)).run.proposal.status).toBe("rejected");
  });

  it("keeps overlapping edits unresolved and degrades malformed stored rows", async () => {
    const row = await subject("Conflict base");
    await db().insert(jobs).values(storedRun({ id: "authoring-conflict-run", characterId: row.id, revision: row.authoringRevision, before: row.name, after: "Proposal" }));
    const [edited] = await db().update(characters).set({ name: "Independent overlap" }).where(eq(characters.id, row.id)).returning();
    const conflict = await decideRun(apiRequest("/api/characters/authoring-runs/authoring-conflict-run/decision", {
      method: "PATCH",
      body: { action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: edited!.authoringRevision, choices: {} },
    }), routeCtx({ runId: "authoring-conflict-run" }));
    expect((await expectJson<{ error: { code: string }; conflicts: unknown[] }>(conflict, 409))).toMatchObject({ error: { code: "authoring_conflict" }, conflicts: expect.any(Array) });
    const [unchanged] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(unchanged?.name).toBe("Independent overlap");

    await db().insert(jobs).values({ id: "authoring-malformed-run", ownerId: authState.user.id, type: "character_authoring", status: "done", payload: { broken: true }, attempts: 1, startedAt: new Date(), finishedAt: new Date() });
    const listed = await expectJson<{ runs: { id: string }[]; diagnostics: { code: string }[] }>(await list("character", row.id));
    expect(listed.runs.some((run) => run.id === "authoring-malformed-run")).toBe(false);
    // Malformed rows without a target cannot satisfy the target query; direct
    // malformed target rows exercise the parser diagnostic.
    await db().update(jobs).set({ payload: { intent: { target: { kind: "character", id: row.id } } } }).where(eq(jobs.id, "authoring-malformed-run"));
    const degraded = await expectJson<{ diagnostics: { code: string }[] }>(await list("character", row.id));
    expect(degraded.diagnostics.map((item) => item.code)).toContain("authoring.run.malformed");
  });
});
