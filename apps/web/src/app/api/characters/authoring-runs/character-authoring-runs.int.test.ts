import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCharacterProfile } from "@/contracts";
import { emptyCharacterDraft } from "@/lib/client/api";
import { characters, db, jobs } from "@/server/db";
import { blankCreatedCharacterContent, characterCreateSchema, claimJobSlot, createOwnedCharacter, isCoalescedAuthoringRetry, resetRateLimits, startAuthoringRunSchema, startCharacterAuthoringRun, startJobAfterAdmission } from "@/server/api";

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Authoring runs", role: "admin" as const } }));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { characterDraftSchema, portraitAuthoringFingerprint } from "@/server/authoring";
import { absoluteImagePath, createImageAsset, saveOwnedImageBuffer, sourceContentHashOf } from "@/server/images";
import { apiRequest, bindAuthUser, endTestPool, expectApiError, expectJson, probeIntegrationDb, purgeOwnerRows, routeCtx, seedTestUser, testPngBuffer, withAuthUser, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
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
});
beforeEach(() => resetRateLimits());
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

type CreateRun = {
  id: string;
  base: { name: string };
  creationStart: { draft: unknown; prompt: string; initialPreview: boolean } | null;
  source: { authoringRevision: number };
  status: string;
  proposal: { revision: number; status: string };
  result: { proposed: { name: string; profile: { creationBrief: string } }; diagnostics: { code: string }[] } | null;
};

/** A character exactly as the library's New button creates it, placeholder name included. */
async function blankCharacter(name = "Untitled character q7x2") {
  const outcome = await createOwnedCharacter(authState.user.id, characterCreateSchema.parse({ name }));
  if (outcome.status !== "created") throw new Error("failed to create blank character fixture");
  return outcome.response.character;
}

/** The body the character page sends: the browser draft and flag are ignored. */
function createRunBody(character: { id: string; authoringRevision: number }, prompt: string, requestId: string) {
  return {
    requestId,
    target: { kind: "character", id: character.id },
    operation: "create",
    scope: null,
    label: "forged character",
    base: emptyCharacterDraft(),
    creationStart: { draft: emptyCharacterDraft(), prompt, initialPreview: false },
    source: { authoringRevision: character.authoringRevision, imageId: null },
  };
}

const startCreate = (character: { id: string; authoringRevision: number }, prompt: string, requestId: string = crypto.randomUUID()) => startRun(
  apiRequest("/api/characters/authoring-runs", { method: "POST", body: createRunBody(character, prompt, requestId) }),
  routeCtx({}),
);
const decide = (runId: string, body: Record<string, unknown>) => decideRun(
  apiRequest(`/api/characters/authoring-runs/${runId}/decision`, { method: "PATCH", body }),
  routeCtx({ runId }),
);
/** The start-time snapshot as stored; the projected flag also depends on the result. */
async function storedCreationStart(runId: string) {
  const [row] = await db().select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, runId));
  return (row?.payload as { intent?: { creationStart?: unknown } } | undefined)?.intent?.creationStart;
}
async function storedBrief(characterId: string) {
  const [row] = await db().select({ profile: characters.profile }).from(characters).where(eq(characters.id, characterId));
  return (row?.profile as { creationBrief?: unknown } | undefined)?.creationBrief;
}

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

/** A completed first Forge started on an untouched blank, with the given result diagnostics. */
function storedFirstForge(input: { id: string; characterId: string; diagnostics: { severity: "info" | "warn" | "error"; code: string; message: string }[] }) {
  const stored = storedRun({ id: input.id, characterId: input.characterId, revision: 1, before: "New character", after: "Forged name" });
  return {
    ...stored,
    payload: {
      ...stored.payload,
      intent: {
        ...stored.payload.intent,
        operation: "create",
        scope: null,
        label: "forged character",
        creationStart: { draft: stored.payload.intent.base, prompt: "A patient harbor master", initialPreview: true, origin: "reserved_row" },
      },
      result: { ...stored.payload.result, diagnostics: input.diagnostics },
    },
  };
}

function storedCreationRun(input: { id: string; creationId: string; before: string; after: string }) {
  const stored = storedRun({
    id: input.id,
    characterId: input.creationId,
    revision: 1,
    before: input.before,
    after: input.after,
  });
  return {
    ...stored,
    payload: {
      ...stored.payload,
      intent: {
        ...stored.payload.intent,
        target: { kind: "creation" as const, id: input.creationId },
        source: null,
      },
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
  const base = characterDraftSchema.parse({ name: saved.name, profile: saved.profile, tags: saved.tags });
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
  it("marks a first Forge on an untouched blank for direct apply until its forge degrades, and stores the brief on a manual accept", async () => {
    const row = await blankCharacter();
    const started = await expectJson<{ run: CreateRun }>(await startCreate(row, "A patient harbor master"), 202);
    // The snapshot comes from the reserved row, never the browser's empty draft.
    expect(started.run.base.name).toBe(row.name);
    expect(started.run.creationStart).toEqual({ draft: expect.any(Object), prompt: "A patient harbor master", initialPreview: expect.any(Boolean) });
    expect(started.run.source.authoringRevision).toBe(1);
    expect(await storedCreationStart(started.run.id)).toMatchObject({ initialPreview: true, origin: "reserved_row" });
    await waitForJob(started.run.id);

    const listed = await expectJson<{ runs: CreateRun[] }>(await list("character", row.id));
    const completed = listed.runs.find((run) => run.id === started.run.id);
    expect(completed).toMatchObject({ status: "completed", proposal: { status: "unresolved" } });
    expect(completed?.result?.proposed.profile.creationBrief).toBe("A patient harbor master");
    // The test provider's forge falls back to demo content, which is never
    // applied without review: the completed run is an ordinary proposal.
    expect(completed?.result?.diagnostics.map((item) => item.code)).toContain("forge.character.profile.degraded");
    expect(completed?.creationStart?.initialPreview).toBe(false);
    expect(await storedBrief(row.id)).toBe("");

    const accepted = await decide(started.run.id, {
      action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: started.run.source.authoringRevision, choices: {},
    });
    expect((await expectJson<{ run: CreateRun }>(accepted)).run.proposal.status).toBe("accepted");
    const [saved] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(saved?.authoringRevision).toBeGreaterThan(1);
    expect(await storedBrief(row.id)).toBe("A patient harbor master");
  });

  it("projects direct apply for a clean completed first Forge and withholds it for a degraded one", async () => {
    const row = await blankCharacter();
    const clean = storedFirstForge({ id: crypto.randomUUID(), characterId: row.id, diagnostics: [
      { severity: "info", code: "forge.character.profile.repaired", message: "structured output needed one repair round-trip" },
    ] });
    const timedOut = storedFirstForge({ id: crypto.randomUUID(), characterId: row.id, diagnostics: [
      { severity: "warn", code: "forge.character.outfit.timeout", message: "generation exceeded the leg budget; degrading to the fallback" },
    ] });
    await db().insert(jobs).values([clean, timedOut]);
    const listed = await expectJson<{ runs: CreateRun[] }>(await list("character", row.id));
    expect(listed.runs.find((run) => run.id === clean.id)?.creationStart?.initialPreview).toBe(true);
    expect(listed.runs.find((run) => run.id === timedOut.id)?.creationStart?.initialPreview).toBe(false);
  });

  it("turns an edit made during the first Forge into an ordinary proposal, and rejection keeps the brief unsaved", async () => {
    const row = await blankCharacter();
    const started = await expectJson<{ run: CreateRun }>(await startCreate(row, "A retired lighthouse keeper"), 202);
    expect(await storedCreationStart(started.run.id)).toMatchObject({ initialPreview: true, origin: "reserved_row" });
    const [edited] = await db().update(characters).set({ tags: ["edited meanwhile"] }).where(eq(characters.id, row.id)).returning();
    await waitForJob(started.run.id);

    await expectApiError(await decide(started.run.id, {
      action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: started.run.source.authoringRevision, choices: {},
    }), 409, "authoring_conflict");
    expect(await storedBrief(row.id)).toBe("");

    const rejected = await decide(started.run.id, {
      action: "reject", expectedProposalRevision: 1, expectedAuthoringRevision: edited!.authoringRevision, choices: {},
    });
    expect((await expectJson<{ run: CreateRun }>(rejected)).run.proposal.status).toBe("rejected");
    const [after] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(after).toMatchObject({ name: row.name, tags: ["edited meanwhile"] });
    expect(await storedBrief(row.id)).toBe("");
  });

  it("reviews every create on a character that is not an untouched blank, forging from its saved brief", async () => {
    // Revision 1 alone is not enough: this row was stored with content other
    // than what a blank create seeds.
    const authored = await subject("Authored at creation");
    expect(authored.authoringRevision).toBe(1);
    const reviewed = await expectJson<{ run: CreateRun }>(await startCreate(authored, "A quiet cartographer"), 202);
    expect(reviewed.run.creationStart).toMatchObject({ prompt: "A quiet cartographer", initialPreview: false });

    const blank = blankCreatedCharacterContent();
    const [briefed] = await db().insert(characters).values({
      ownerId: authState.user.id,
      name: "Briefed blank",
      profile: { ...blank.profile, creationBrief: "Original harbor concept" },
      tags: blank.tags,
    }).returning();
    const regenerated = await expectJson<{ run: CreateRun }>(await startCreate(briefed!, "A different typed concept"), 202);
    expect(regenerated.run.creationStart).toMatchObject({ prompt: "Original harbor concept", initialPreview: false });
    await waitForJob(reviewed.run.id);
    await waitForJob(regenerated.run.id);
    const listed = await expectJson<{ runs: CreateRun[] }>(await list("character", briefed!.id));
    expect(listed.runs.find((run) => run.id === regenerated.run.id)?.result?.proposed.profile.creationBrief).toBe("Original harbor concept");
  });

  it("never marks a blank that carries a chosen name or clone provenance for direct apply", async () => {
    // Revision 1 and blank content are not enough: an API create with a real
    // name, or a clone of a blank, still carries something the owner chose.
    const named = await blankCharacter("Alice");
    const namedRun = await expectJson<{ run: CreateRun }>(await startCreate(named, "A patient harbor master"), 202);
    expect(await storedCreationStart(namedRun.run.id)).toMatchObject({ initialPreview: false });
    await waitForJob(namedRun.run.id);
    expect(named.authoringRevision).toBe(1);

    const source = await blankCharacter();
    const blank = blankCreatedCharacterContent();
    const [clone] = await db().insert(characters).values({
      ownerId: authState.user.id, name: source.name, profile: blank.profile, tags: blank.tags, clonedFromId: source.id,
    }).returning();
    const cloneRun = await expectJson<{ run: CreateRun }>(await startCreate(clone!, "A patient harbor master"), 202);
    expect(await storedCreationStart(cloneRun.run.id)).toMatchObject({ initialPreview: false });
    await waitForJob(cloneRun.run.id);

    // The same content under the create-on-new placeholder still qualifies.
    const placeholder = await blankCharacter("Untitled character");
    const placeholderRun = await expectJson<{ run: CreateRun }>(await startCreate(placeholder, "A patient harbor master"), 202);
    expect(await storedCreationStart(placeholderRun.run.id)).toMatchObject({ initialPreview: true });
    await waitForJob(placeholderRun.run.id);
  });

  it("refuses a create with no brief on the character or in the request before admission", async () => {
    const row = await blankCharacter();
    const requestId = crypto.randomUUID();
    let admissions = 0;
    const outcome = await startCharacterAuthoringRun(
      authState.user.id,
      startAuthoringRunSchema.parse(createRunBody(row, "   ", requestId)),
      async () => { admissions += 1; return null; },
    );
    expect(outcome.status).toBe("brief_required");
    expect(admissions).toBe(0);
    expect(await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, requestId))).toEqual([]);
    await expectApiError(await startCreate(row, ""), 400, "invalid_body");
  });

  it("replays a repeated create after acceptance and refuses a changed prompt under the same id", async () => {
    const row = await blankCharacter();
    const requestId = crypto.randomUUID();
    const first = await expectJson<{ run: CreateRun }>(await startCreate(row, "A patient harbor master", requestId), 202);
    await waitForJob(requestId);
    await expectJson(await decide(requestId, {
      action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: first.run.source.authoringRevision, choices: {},
    }), 200);

    // A lost response retried after the character moved on replays the stored run.
    const replay = await expectJson<{ run: CreateRun }>(await startCreate(row, "A patient harbor master", requestId), 202);
    expect(replay.run).toMatchObject({ id: requestId, proposal: { status: "accepted" } });
    await expectApiError(await startCreate(row, "A different concept", requestId), 409, "idempotency_conflict");
    expect(await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, requestId))).toHaveLength(1);
  });

  it("keeps stored creation-draft runs inert and never trusts a bound run's browser preview flag", async () => {
    // A creation-draft run orphaned by the deploy: never listed, decided or re-run.
    const creationId = crypto.randomUUID();
    const legacy = storedCreationRun({ id: crypto.randomUUID(), creationId, before: "Legacy draft", after: "Legacy result" });
    const legacyPayload = { ...legacy.payload, result: null };
    await db().insert(jobs).values({ ...legacy, status: "running", finishedAt: null, heartbeatAt: new Date(0), payload: legacyPayload });
    // A page open from before the deploy polls its creation draft: it gets an
    // empty listing and stops, while a malformed query is still refused.
    const retired = await expectJson<{ runs: unknown[]; diagnostics: { code: string }[] }>(await list("creation", creationId), 200);
    expect(retired.runs).toEqual([]);
    expect(retired.diagnostics.map((item) => item.code)).toEqual(["authoring.run.unsupported_target"]);
    await expectApiError(await listRuns(apiRequest(`/api/characters/authoring-runs?targetKind=draft&targetId=${creationId}`), routeCtx({})), 400, "invalid_query");
    await expectApiError(await decide(legacy.id, { action: "dismiss", expectedProposalRevision: 1, choices: {} }), 409, "invalid_run");
    const ownedJobs = () => db().select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, authState.user.id));
    const before = await ownedJobs();
    await expectApiError(await retryRun(apiRequest(`/api/characters/authoring-runs/${legacy.id}/retry`, {
      method: "POST", body: { requestId: crypto.randomUUID() },
    }), routeCtx({ runId: legacy.id })), 409, "idempotency_conflict");
    expect(await ownedJobs()).toHaveLength(before.length);
    const [untouched] = await db().select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, legacy.id));
    expect(untouched?.payload).toEqual(legacyPayload);

    // A run bound onto a character by the old save carries a browser-computed flag.
    const destination = await subject("Bound legacy destination");
    const bound = storedRun({ id: crypto.randomUUID(), characterId: destination.id, revision: destination.authoringRevision, before: destination.name, after: "Bound result" });
    await db().insert(jobs).values({ ...bound, payload: { ...bound.payload, intent: {
      ...bound.payload.intent, operation: "create", scope: null,
      creationStart: { draft: bound.payload.intent.base, prompt: "Legacy prompt", initialPreview: true },
    } } });
    const listed = await expectJson<{ runs: CreateRun[] }>(await list("character", destination.id));
    expect(listed.runs.find((run) => run.id === bound.id)?.creationStart).toMatchObject({ prompt: "Legacy prompt", initialPreview: false });
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

  it("keeps a coalesced retry valid after its selected sibling settles", () => {
    expect(isCoalescedAuthoringRetry(
      { jobId: "settled-sibling", inserted: false },
      "new-request",
      "failed-parent",
      "logical-root",
      "logical-root",
    )).toBe(true);
    expect(isCoalescedAuthoringRetry(
      { jobId: "new-request", inserted: false },
      "new-request",
      "failed-parent",
      "logical-root",
      "logical-root",
    )).toBe(false);
  });

  it("waits for duplicate admission and never acknowledges a refused provisional row", async () => {
    const row = await subject("Admission source");
    const requestId = crypto.randomUUID();
    const input = startAuthoringRunSchema.parse({
      requestId,
      target: { kind: "character", id: row.id },
      operation: "fill",
      scope: "profile",
      label: "missing Profile details",
      base: { ...emptyCharacterDraft(), name: row.name, profile: row.profile },
      creationStart: null,
      source: { authoringRevision: row.authoringRevision, imageId: null },
    });
    let releaseAdmission!: () => void;
    let admissionStarted!: () => void;
    const release = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const started = new Promise<void>((resolve) => { admissionStarted = resolve; });
    const refusal = () => new Response("refused", { status: 429 });
    const first = startCharacterAuthoringRun(authState.user.id, input, async () => {
      admissionStarted();
      await release;
      return refusal();
    });
    await started;
    let duplicateSettled = false;
    const duplicate = startCharacterAuthoringRun(authState.user.id, input, async () => refusal())
      .finally(() => { duplicateSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(duplicateSettled).toBe(false);
    expect((await expectJson<{ runs: unknown[] }>(await list("character", row.id))).runs).toEqual([]);

    releaseAdmission();
    const outcomes = await Promise.all([first, duplicate]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["admission", "admission"]);
    expect(await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, requestId))).toEqual([]);
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

  it("returns a controlled conflict for malformed persisted character details", async () => {
    const row = await subject("Malformed character source");
    const [malformed] = await db().update(characters)
      .set({ profile: { attributes: "not-an-array" } as never })
      .where(eq(characters.id, row.id))
      .returning();
    if (!malformed) throw new Error("failed to seed malformed character source");
    let admissionCalls = 0;
    const outcome = await startCharacterAuthoringRun(authState.user.id, startAuthoringRunSchema.parse({
      requestId: crypto.randomUUID(),
      target: { kind: "character", id: row.id },
      operation: "fill",
      scope: "profile",
      label: "missing Profile details",
      base: emptyCharacterDraft(),
      creationStart: null,
      source: { authoringRevision: malformed.authoringRevision, imageId: null },
    }), async () => { admissionCalls += 1; return null; });
    expect(outcome.status).toBe("invalid_source");
    expect(admissionCalls).toBe(0);

    await db().insert(jobs).values(storedRun({
      id: "authoring-malformed-character-decision",
      characterId: row.id,
      revision: malformed.authoringRevision,
      before: row.name,
      after: "Unsafe overwrite",
    }));
    const decision = await decideRun(apiRequest("/api/characters/authoring-runs/authoring-malformed-character-decision/decision", {
      method: "PATCH",
      body: { action: "accept", expectedProposalRevision: 1, expectedAuthoringRevision: malformed.authoringRevision, choices: {} },
    }), routeCtx({ runId: "authoring-malformed-character-decision" }));
    expect((await expectJson<{ error: { code: string } }>(decision, 409)).error.code).toBe("invalid_source");
  });
});
