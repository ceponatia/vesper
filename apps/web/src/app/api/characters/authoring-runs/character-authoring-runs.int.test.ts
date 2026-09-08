import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyCharacterProfile } from "@/contracts";
import { emptyCharacterDraft } from "@/lib/client/api";
import { characters, db, jobs } from "@/server/db";
import { claimJobSlot, resetRateLimits, startJobAfterAdmission } from "@/server/api";

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Authoring runs", role: "admin" as const } }));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { portraitAuthoringFingerprint } from "@/server/authoring";
import { absoluteImagePath, createImageAsset, saveOwnedImageBuffer, sourceContentHashOf } from "@/server/images";
import { apiRequest, bindAuthUser, endTestPool, expectJson, probeIntegrationDb, purgeOwnerRows, routeCtx, seedTestUser, testPngBuffer, withAuthUser, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { GET as listRuns, POST as startRun } from "./route";
import { PATCH as decideRun } from "./[runId]/decision/route";
import { POST as retryRun } from "./[runId]/retry/route";

const ready = await probeIntegrationDb("character-authoring-runs.int.test", "jobs");
let foreignId = "";
let temp: TempDataRoot | undefined;
beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-character-authoring-runs-int");
  bindAuthUser(authState, await seedTestUser("character-authoring-runs", { role: "admin" }));
  foreignId = (await seedTestUser("character-authoring-runs-foreign", { role: "admin" })).id;
  resetRateLimits();
});
afterAll(async () => {
  await temp?.cleanup();
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

async function portraitSubject(name: string) {
  const character = await subject(name);
  const asset = await createImageAsset({
    ownerId: authState.user.id,
    kind: "avatar",
    entityKind: "character",
    entityId: character.id,
    prompt: "portrait evidence fixture",
  });
  const portrait = await saveOwnedImageBuffer(asset.id, authState.user.id, await testPngBuffer(96, 128));
  if (!portrait || portrait.status !== "ready") throw new Error("failed to seed portrait evidence fixture");
  const [saved] = await db().update(characters).set({ avatarImageId: portrait.id }).where(eq(characters.id, character.id)).returning();
  if (!saved) throw new Error("failed to attach portrait evidence fixture");
  const bytes = await fs.readFile(absoluteImagePath(portrait));
  const base = { ...emptyCharacterDraft(), name: saved.name, profile: saved.profile, tags: saved.tags };
  return { character: saved, portrait, base, contentHash: sourceContentHashOf(bytes), fingerprint: portraitAuthoringFingerprint(base) };
}

function storedPortraitRun(input: Awaited<ReturnType<typeof portraitSubject>> & { id: string }) {
  const proposed = {
    ...input.base,
    profile: { ...input.base.profile, attributes: [...input.base.profile.attributes, { id: "eyes.color" as const, value: "green", source: "creation" as const }] },
  };
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
        target: { kind: "character", id: input.character.id },
        operation: "portrait",
        scope: null,
        label: "portrait changes",
        base: input.base,
        creationStart: null,
        source: {
          authoringRevision: input.character.authoringRevision,
          imageId: input.portrait.id,
          imageContentHash: input.contentHash,
          authoringFingerprint: input.fingerprint,
        },
        retryOf: null,
        rootRunId: input.id,
        intentHash: "fixture",
      },
      proposal: { revision: 1, status: "unresolved", choices: {}, appliedDraft: null, undo: null },
      result: {
        proposed,
        diagnostics: [{ severity: "info", code: "forge.character.portrait.portrait_conflict", message: "requires review" }],
        portrait: {
          outcome: "proposals",
          readFailure: null,
          source: { imageId: input.portrait.id, contentHash: input.contentHash, authoringRevision: input.character.authoringRevision, authoringFingerprint: input.fingerprint },
          model: { id: "test/vision", promptVersion: "portrait-attributes/v2", provider: "test" },
          timing: { startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), durationMs: 1, providerLatencyMs: 1 },
          fields: [{ id: "eyes.color", value: "green", confidence: 9_000, visibility: "clear", evidence: "Both irises are visible.", evidenceRegion: { left: 1_000, top: 1_000, width: 4_000, height: 4_000 }, defaultSelected: true }],
          decision: null,
        },
      },
    },
  };
}

describe.skipIf(!ready)("server-authoritative character authoring runs", () => {
  it("keeps the first Forge decidable until the client accepts its unchanged preview", async () => {
    const requestId = crypto.randomUUID();
    const creationId = crypto.randomUUID();
    const blank = emptyCharacterDraft();
    const base = { ...blank, profile: { ...blank.profile, creationBrief: "A patient harbor master" } };
    const response = await startRun(apiRequest("/api/characters/authoring-runs", { method: "POST", body: {
      requestId,
      target: { kind: "creation", id: creationId },
      operation: "create",
      scope: null,
      label: "forged character",
      base,
      creationStart: { draft: blank, prompt: "A patient harbor master", initialPreview: true },
      source: null,
    } }), routeCtx({}));
    expect(response.status).toBe(202);
    await waitForJob(requestId);
    const listed = await expectJson<{ runs: { id: string; proposal: { status: string } }[] }>(await list("creation", creationId));
    expect(listed.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requestId, proposal: expect.objectContaining({ status: "unresolved" }) }),
    ]));
    expect((await expectJson<{ runs: unknown[] }>(await list("creation", crypto.randomUUID()))).runs).toEqual([]);
  });

  it("preserves a running dismissal when detached work settles", async () => {
    const row = await subject("Dismiss while running");
    const fixture = storedRun({ id: crypto.randomUUID(), characterId: row.id, revision: row.authoringRevision, before: row.name, after: "Late proposal" });
    let finishDetachedRun!: () => void;
    const waiting = new Promise<void>((resolve) => { finishDetachedRun = resolve; });
    const payload = { ...fixture.payload, result: null };
    const started = await startJobAfterAdmission({
      type: "character_authoring",
      ownerId: authState.user.id,
      requestedJobId: fixture.id,
      payload,
      run: async () => { await waiting; return { result: fixture.payload.result }; },
    }, async () => null);
    expect(started.ok).toBe(true);
    const dismissed = await decideRun(apiRequest(`/api/characters/authoring-runs/${fixture.id}/decision`, {
      method: "PATCH", body: { action: "dismiss", expectedProposalRevision: 1, choices: {} },
    }), routeCtx({ runId: fixture.id }));
    expect((await expectJson<{ run: { proposal: { status: string } } }>(dismissed)).run.proposal.status).toBe("dismissed");
    finishDetachedRun();
    await waitForJob(fixture.id);
    const [settled] = await db().select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, fixture.id));
    expect(settled?.payload).toEqual(expect.objectContaining({
      proposal: expect.objectContaining({ status: "dismissed" }),
      result: fixture.payload.result,
    }));
  });

  it("coalesces simultaneous active retry children by logical root", async () => {
    const rootRunId = crypto.randomUUID();
    const key = `character-authoring:${rootRunId}`;
    const claims = await Promise.all([
      claimJobSlot({ ownerId: authState.user.id, type: "character_authoring", requestedJobId: crypto.randomUUID(), activeDedupeKey: key, payload: { rootRunId } }),
      claimJobSlot({ ownerId: authState.user.id, type: "character_authoring", requestedJobId: crypto.randomUUID(), activeDedupeKey: key, payload: { rootRunId } }),
    ]);
    expect(claims.every((claim) => claim.ok)).toBe(true);
    expect(claims[0]?.ok && claims[1]?.ok ? claims[0].jobId : null).toBe(claims[1]?.ok ? claims[1].jobId : null);
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, claims[0]!.ok ? claims[0]!.jobId : ""));
  });

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

  it("persists evidence decisions and hides run actions from another owner", async () => {
    const state = await portraitSubject("Portrait evidence decision");
    await db().insert(jobs).values(storedPortraitRun({ ...state, id: "portrait-evidence-decision" }));

    await withAuthUser(authState, { id: foreignId }, async () => {
      const decision = await decideRun(apiRequest("/api/characters/authoring-runs/portrait-evidence-decision/decision", {
        method: "PATCH",
        body: { action: "reject", expectedProposalRevision: 1, expectedAuthoringRevision: state.character.authoringRevision, choices: {} },
      }), routeCtx({ runId: "portrait-evidence-decision" }));
      expect(decision.status).toBe(404);
      const retry = await retryRun(apiRequest("/api/characters/authoring-runs/portrait-evidence-decision/retry", {
        method: "POST", body: { requestId: crypto.randomUUID() },
      }), routeCtx({ runId: "portrait-evidence-decision" }));
      expect(retry.status).toBe(404);
    });

    const rejected = await decideRun(apiRequest("/api/characters/authoring-runs/portrait-evidence-decision/decision", {
      method: "PATCH",
      body: { action: "reject", expectedProposalRevision: 1, expectedAuthoringRevision: state.character.authoringRevision, choices: {} },
    }), routeCtx({ runId: "portrait-evidence-decision" }));
    const body = await expectJson<{ run: { result: { diagnostics: { code: string }[]; portrait: { decision: { proposalRevision: number; action: string } } } } }>(rejected);
    expect(body.run.result.portrait.decision).toEqual(expect.objectContaining({ proposalRevision: 2, action: "rejected" }));
    expect(body.run.result.diagnostics.map((item) => item.code)).toContain("forge.character.portrait.review_rejected");
    expect(body.run.result.diagnostics.map((item) => item.code)).not.toContain("forge.character.portrait.portrait_conflict");
  });

  it("refuses decisions when portrait bytes or relevant appearance inputs change", async () => {
    const appearance = await portraitSubject("Portrait appearance stale");
    await db().insert(jobs).values(storedPortraitRun({ ...appearance, id: "portrait-appearance-stale" }));
    const [changed] = await db().update(characters).set({
      profile: { ...appearance.base.profile, attributes: [{ id: "hair.color", value: "black", source: "manual" }] },
    }).where(eq(characters.id, appearance.character.id)).returning();
    const staleAppearance = await decideRun(apiRequest("/api/characters/authoring-runs/portrait-appearance-stale/decision", {
      method: "PATCH",
      body: { action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: changed!.authoringRevision, choices: {} },
    }), routeCtx({ runId: "portrait-appearance-stale" }));
    expect((await expectJson<{ error: { code: string } }>(staleAppearance, 409)).error.code).toBe("portrait_source_changed");

    const bytes = await portraitSubject("Portrait bytes stale");
    await db().insert(jobs).values(storedPortraitRun({ ...bytes, id: "portrait-bytes-stale" }));
    await fs.writeFile(absoluteImagePath(bytes.portrait), Buffer.from("changed portrait bytes"));
    const staleBytes = await decideRun(apiRequest("/api/characters/authoring-runs/portrait-bytes-stale/decision", {
      method: "PATCH",
      body: { action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: bytes.character.authoringRevision, choices: {} },
    }), routeCtx({ runId: "portrait-bytes-stale" }));
    expect((await expectJson<{ error: { code: string } }>(staleBytes, 409)).error.code).toBe("portrait_source_changed");

    const rejectedStale = await decideRun(apiRequest("/api/characters/authoring-runs/portrait-bytes-stale/decision", {
      method: "PATCH",
      body: { action: "reject", expectedProposalRevision: 1, expectedAuthoringRevision: bytes.character.authoringRevision, choices: {} },
    }), routeCtx({ runId: "portrait-bytes-stale" }));
    expect((await expectJson<{ run: { proposal: { status: string } } }>(rejectedStale)).run.proposal.status).toBe("rejected");
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
