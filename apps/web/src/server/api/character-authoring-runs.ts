import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  characterProfileSchema,
  diag,
  type Diagnostic,
  diagnosticSchema,
  DiagnosticCollector,
  emptyCharacterProfile,
  materializeBodyDefaults,
  withItemsInDefaultOutfit,
} from "@/contracts";
import { mergeFillDraft } from "@/lib/character-fill";
import { characterSheetScopeSchema, mergeFillScope, mergeRedraftScope } from "@/lib/character-scopes";
import { applyCharacterProposal, proposalChanges, reconcileMaterializedUndo, type ProposalChoices, type proposalConflicts } from "@/lib/character-proposals";
import { portraitExtractionEvidenceSchema, type PortraitDecision } from "@/lib/portrait-extraction";
import { parseOr } from "@/lib/parse";
import { characters, db, images, jobs } from "@/server/db";
import {
  characterDraftSchema,
  derivePortraitAttributes,
  failedPortraitAttributes,
  forgeCharacter,
  forgeCharacterFill,
  portraitAuthoringFingerprint,
  redraftCharacterScope,
  type CharacterDraft,
} from "@/server/authoring";
import { absoluteImagePath, sourceContentHashOf } from "@/server/images";
import { materializeSuggestedItems, prepareSuggestedItemEmbeddings, queueEmbedRefresh } from "./library";
import { reserveCharacterAuthoringAction } from "./character-save";
import { startJobAfterAdmission } from "./jobs";

const MAX_RUNS_PER_SURFACE = 25;

export const authoringTargetSchema = z.object({
  kind: z.enum(["creation", "character"]),
  id: z.string().min(1).max(128),
});
export const authoringSourceSchema = z.object({
  authoringRevision: z.number().int().positive().max(2_147_483_647),
  imageId: z.string().min(1).nullable().default(null),
  imageContentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  authoringFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
const creationStartSchema = z.object({ draft: characterDraftSchema, prompt: z.string(), initialPreview: z.boolean() });
const resultSchema = z.object({
  proposed: characterDraftSchema,
  diagnostics: z.array(diagnosticSchema),
  portrait: portraitExtractionEvidenceSchema.nullable().optional(),
});
const undoSchema = z.object({
  id: z.string(), label: z.string(), base: characterDraftSchema, proposed: characterDraftSchema,
  undo: z.literal(true), sourceRunId: z.string(), proposalRevision: z.number().int().positive(),
  portraitEvidence: portraitExtractionEvidenceSchema.optional(),
});
const proposalStateSchema = z.object({
  revision: z.number().int().positive().default(1),
  status: z.enum(["unresolved", "accepted", "rejected", "undone", "dismissed"]).default("unresolved"),
  choices: z.record(z.string(), z.enum(["current", "proposed"])).default({}),
  appliedDraft: characterDraftSchema.nullable().default(null),
  undo: undoSchema.nullable().default(null),
});
const intentSchema = z.object({
  requestId: z.string().min(8).max(128),
  target: authoringTargetSchema,
  operation: z.enum(["create", "fill", "redraft", "portrait"]),
  scope: characterSheetScopeSchema.nullable(),
  label: z.string().min(1).max(160),
  base: characterDraftSchema,
  creationStart: creationStartSchema.nullable(),
  source: authoringSourceSchema.nullable(),
  retryOf: z.string().nullable(),
  rootRunId: z.string(),
  intentHash: z.string(),
});
const payloadSchema = z.object({
  kind: z.literal("character_authoring_run"),
  intent: intentSchema,
  proposal: proposalStateSchema,
  result: resultSchema.nullable().default(null),
});

export const startAuthoringRunSchema = z.object({
  requestId: z.string().min(8).max(128),
  target: authoringTargetSchema,
  operation: z.enum(["create", "fill", "redraft", "portrait"]),
  scope: characterSheetScopeSchema.nullable(),
  label: z.string().trim().min(1).max(160),
  base: characterDraftSchema,
  creationStart: creationStartSchema.nullable(),
  source: authoringSourceSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.operation === "create" && value.target.kind !== "creation") ctx.addIssue({ code: "custom", message: "create runs require a creation target" });
  if (value.operation === "create" && !value.creationStart) ctx.addIssue({ code: "custom", message: "create runs require their creation snapshot" });
  if (value.operation === "portrait" && (value.target.kind !== "character" || !value.source?.imageId)) ctx.addIssue({ code: "custom", message: "portrait runs require a saved character and displayed image" });
  if (value.target.kind === "character" && !value.source) ctx.addIssue({ code: "custom", message: "saved-character runs require an authoring revision" });
  if (value.operation === "redraft" && !value.scope) ctx.addIssue({ code: "custom", message: "redraft runs require a scope" });
});

export const retryAuthoringRunSchema = z.object({ requestId: z.string().min(8).max(128) });
export const decideAuthoringRunSchema = z.object({
  action: z.enum(["accept", "reject", "undo", "dismiss"]),
  expectedProposalRevision: z.number().int().positive(),
  expectedAuthoringRevision: z.number().int().positive().optional(),
  choices: z.record(z.string(), z.enum(["current", "proposed"])).default({}),
  currentDraft: characterDraftSchema.optional(),
});

type StoredPayload = z.infer<typeof payloadSchema>;
type StartInput = z.infer<typeof startAuthoringRunSchema>;
type DecideInput = z.infer<typeof decideAuthoringRunSchema>;
export type AuthoringRunDto = ReturnType<typeof projectRun>;

function intentDigest(value: Omit<z.infer<typeof intentSchema>, "intentHash">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Saved-character input is reconstructed from the reserved server row, so its
 * untrusted browser base is deliberately absent from idempotency comparison. */
function requestDigest(input: StartInput, retryOf: string | null, rootRunId: string): string {
  return createHash("sha256").update(JSON.stringify({
    requestId: input.requestId,
    target: input.target,
    operation: input.operation,
    scope: input.scope,
    label: input.label,
    ...(input.target.kind === "creation" ? { base: input.base } : {}),
    creationStart: input.creationStart,
    source: input.source ? { authoringRevision: input.source.authoringRevision, imageId: input.source.imageId } : null,
    retryOf,
    rootRunId,
  })).digest("hex");
}

function matchesStoredRequest(payload: StoredPayload, input: StartInput, retryOf: string | null, rootRunId: string): boolean {
  const stored = {
    requestId: payload.intent.requestId,
    target: payload.intent.target,
    operation: payload.intent.operation,
    scope: payload.intent.scope,
    label: payload.intent.label,
    base: payload.intent.base,
    creationStart: payload.intent.creationStart,
    source: payload.intent.source,
  };
  return requestDigest(stored, payload.intent.retryOf, payload.intent.rootRunId) === requestDigest(input, retryOf, rootRunId);
}

function projectRun(row: typeof jobs.$inferSelect, payload: StoredPayload) {
  const portraitReadFailed = payload.result?.portrait?.outcome === "read_failed";
  const readFailure = portraitReadFailed ? payload.result?.portrait?.readFailure ?? "provider_or_parse" : null;
  const failed = row.status === "failed" || portraitReadFailed;
  const safeError = readFailure === "source_changed"
    ? "The saved portrait changed before it could be inspected. Retry from the current portrait."
    : readFailure === "source_unavailable"
      ? "The saved portrait could not be read. Check the portrait and retry."
      : readFailure === "insufficient_visible_evidence"
        ? "The portrait did not show enough evidence to compare these details. Try another portrait."
        : readFailure === "provider_or_parse"
          ? "Portrait reading failed. Retry the run."
          : row.status === "failed" ? "Generation failed. Retry the run." : null;
  return {
    id: row.id,
    ownerId: row.ownerId ?? "",
    target: payload.intent.target,
    operation: payload.intent.operation,
    scope: payload.intent.scope,
    label: payload.intent.label,
    base: payload.intent.base,
    creationStart: payload.intent.creationStart,
    source: payload.intent.source,
    status: failed ? "failed" as const : row.status === "done" ? "completed" as const : "pending" as const,
    result: payload.result,
    error: safeError,
    errorCode: readFailure ? `portrait_${readFailure}` : row.status === "failed" ? "generation_failed" : null,
    retryOf: payload.intent.retryOf,
    rootRunId: payload.intent.rootRunId,
    persisted: true,
    proposal: payload.proposal,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function parseRun(row: typeof jobs.$inferSelect): AuthoringRunDto | null {
  const payload = payloadSchema.safeParse(row.payload);
  return payload.success ? projectRun(row, payload.data) : null;
}

export async function resolveOwnedCharacterAuthoringRun(ownerId: string, runId: string) {
  const [row] = await db().select().from(jobs).where(and(
    eq(jobs.id, runId), eq(jobs.ownerId, ownerId), eq(jobs.type, "character_authoring"),
  )).limit(1);
  return row ?? null;
}

const ownedRunRow = resolveOwnedCharacterAuthoringRun;

async function ownedPortraitBytes(ownerId: string, characterId: string, imageId: string) {
  const [image] = await db().select().from(images).where(and(
    eq(images.id, imageId),
    eq(images.ownerId, ownerId),
    eq(images.entityKind, "character"),
    eq(images.entityId, characterId),
  )).limit(1);
  if (!image || image.status !== "ready") return null;
  try {
    const data = await fs.readFile(absoluteImagePath(image));
    return { image, data, contentHash: sourceContentHashOf(data) };
  } catch {
    return null;
  }
}

export async function listCharacterAuthoringRuns(ownerId: string, target: z.infer<typeof authoringTargetSchema>) {
  const predicates = [
    eq(jobs.ownerId, ownerId),
    eq(jobs.type, "character_authoring"),
    sql`${jobs.payload} -> 'intent' -> 'target' ->> 'kind' = ${target.kind}`,
  ];
  predicates.push(sql`${jobs.payload} -> 'intent' -> 'target' ->> 'id' = ${target.id}`);
  const rows = await db().select().from(jobs).where(and(...predicates)).orderBy(desc(jobs.createdAt)).limit(MAX_RUNS_PER_SURFACE);
  const diagnostics: Diagnostic[] = [];
  const runs: AuthoringRunDto[] = [];
  for (const row of rows) {
    const run = parseRun(row);
    if (run) runs.push(run);
    else diagnostics.push(diag("warn", "authoring.run.malformed", "One saved authoring run could not be read and was omitted.", { context: { runId: row.id } }));
  }
  return { runs: runs.filter((run) => run.proposal.status !== "dismissed"), diagnostics };
}

async function canonicalizeStart(ownerId: string, input: StartInput): Promise<StartInput | { conflict: "not_found" | "authoring_revision_changed" | "portrait_changed" | "portrait_source_changed"; currentRevision?: number; currentImageId?: string | null }> {
  if (input.target.kind === "creation") return input;
  const source = input.source;
  if (!source) return { conflict: "not_found" };
  const reserved = await reserveCharacterAuthoringAction({
    characterId: input.target.id,
    ownerId,
    expectedAuthoringRevision: source.authoringRevision,
    ...(input.operation === "portrait" && source.imageId ? { expectedPortraitImageId: source.imageId } : {}),
  });
  if (reserved.status !== "reserved") {
    return {
      conflict: reserved.status,
      ...(reserved.status === "not_found" ? {} : { currentRevision: reserved.currentRevision, currentImageId: reserved.currentImageId }),
    };
  }
  const base = characterDraftSchema.parse({
    name: reserved.source.name,
    profile: reserved.source.profile,
    tags: reserved.source.tags,
    suggestedItems: [],
  });
  if (input.operation === "portrait" && source.imageId) {
    const portrait = await ownedPortraitBytes(ownerId, input.target.id, source.imageId);
    if (!portrait) {
      return { conflict: "portrait_source_changed", currentRevision: reserved.source.authoringRevision, currentImageId: reserved.source.avatarImageId };
    }
    // Re-check the character after the file read. Admission and provider work
    // happen only after both the row identity and exact stored bytes are fixed.
    const confirmed = await reserveCharacterAuthoringAction({
      characterId: input.target.id,
      ownerId,
      expectedAuthoringRevision: reserved.source.authoringRevision,
      expectedPortraitImageId: source.imageId,
    });
    if (confirmed.status !== "reserved") {
      return {
        conflict: confirmed.status,
        ...(confirmed.status === "not_found" ? {} : { currentRevision: confirmed.currentRevision, currentImageId: confirmed.currentImageId }),
      };
    }
    return {
      ...input,
      base,
      source: {
        authoringRevision: reserved.source.authoringRevision,
        imageId: source.imageId,
        imageContentHash: portrait.contentHash,
        authoringFingerprint: portraitAuthoringFingerprint(base),
      },
    };
  }
  return {
    ...input,
    base,
    source: { authoringRevision: reserved.source.authoringRevision, imageId: source.imageId },
  };
}

async function executeRun(ownerId: string, intent: z.infer<typeof intentSchema>): Promise<Pick<StoredPayload, "result">> {
  const sink = new DiagnosticCollector();
  const base = intent.base;
  let proposed: CharacterDraft;
  let portrait: z.infer<typeof portraitExtractionEvidenceSchema> | null = null;
  if (intent.operation === "portrait") {
    const imageId = intent.source?.imageId;
    const contentHash = intent.source?.imageContentHash;
    const authoringFingerprint = intent.source?.authoringFingerprint;
    if (!imageId || !contentHash || !authoringFingerprint || !intent.source) throw new Error("portrait source is incomplete");
    const source = { imageId, contentHash, authoringRevision: intent.source.authoringRevision, authoringFingerprint };
    const [loaded, characterRows] = await Promise.all([
      ownedPortraitBytes(ownerId, intent.target.id, imageId),
      db().select().from(characters).where(and(
        eq(characters.id, intent.target.id), eq(characters.ownerId, ownerId),
      )).limit(1),
    ]);
    const current = characterRows[0];
    const sourceChanged = !current || current.avatarImageId !== imageId
      || portraitAuthoringFingerprint(rowDraft(current)) !== authoringFingerprint;
    const extracted = !loaded
      ? failedPortraitAttributes({ draft: base, source, failure: "source_unavailable", sink })
      : loaded.contentHash !== contentHash || sourceChanged
        ? failedPortraitAttributes({ draft: base, source, failure: "source_changed", sink })
        : await derivePortraitAttributes({ draft: base, image: { data: loaded.data, mediaType: "image/webp" }, source, sink });
    proposed = mergeFillDraft(base, extracted.draft);
    const conflicts = new Map(extracted.conflicts.map((item) => [item.id, item.proposed]));
    proposed.profile.attributes = proposed.profile.attributes.map((row) => conflicts.has(row.id)
      ? { ...row, value: conflicts.get(row.id) ?? row.value, source: "creation" as const }
      : row);
    portrait = extracted.evidence;
  } else if (intent.operation === "fill") {
    const generated = await forgeCharacterFill({ draft: base, scope: intent.scope ?? undefined, userId: ownerId, sink });
    proposed = intent.scope ? mergeFillScope(base, generated, intent.scope) : mergeFillDraft(base, generated);
  } else if (intent.operation === "redraft") {
    if (!intent.scope) throw new Error("redraft scope is missing");
    proposed = mergeRedraftScope(base, await redraftCharacterScope({ draft: base, scope: intent.scope, userId: ownerId, sink }), intent.scope);
  } else {
    proposed = await forgeCharacter({ prompt: base.profile.creationBrief, userId: ownerId, sink });
    proposed = { ...proposed, profile: { ...proposed.profile, creationBrief: base.profile.creationBrief } };
  }
  const result = { proposed, diagnostics: sink.items, ...(portrait ? { portrait } : {}) };
  return { result };
}

export type StartAuthoringRunOutcome =
  | { status: "accepted"; run: AuthoringRunDto }
  | { status: "capacity"; active: number; limit: number }
  | { status: "admission"; response: Response }
  | { status: "not_found" }
  | { status: "authoring_revision_changed" | "portrait_changed" | "portrait_source_changed"; currentRevision?: number; currentImageId?: string | null }
  | { status: "idempotency_conflict" };

async function launch(ownerId: string, input: StartInput, retryOf: string | null, rootRunId: string, admit: () => Promise<Response | null>, sourceAlreadyReserved = false): Promise<StartAuthoringRunOutcome> {
  const existing = await ownedRunRow(ownerId, input.requestId);
  if (existing) {
    const parsed = payloadSchema.safeParse(existing.payload);
    if (!parsed.success) return { status: "idempotency_conflict" };
    return matchesStoredRequest(parsed.data, input, retryOf, rootRunId)
      ? { status: "accepted", run: projectRun(existing, parsed.data) }
      : { status: "idempotency_conflict" };
  }
  const canonical = sourceAlreadyReserved ? input : await canonicalizeStart(ownerId, input);
  if ("conflict" in canonical) {
    const raced = await ownedRunRow(ownerId, input.requestId);
    const parsed = raced ? payloadSchema.safeParse(raced.payload) : null;
    if (raced && parsed?.success && matchesStoredRequest(parsed.data, input, retryOf, rootRunId)) {
      return { status: "accepted", run: projectRun(raced, parsed.data) };
    }
    return { status: canonical.conflict, currentRevision: canonical.currentRevision, currentImageId: canonical.currentImageId };
  }
  const unsigned = {
    requestId: canonical.requestId,
    target: canonical.target,
    operation: canonical.operation,
    scope: canonical.scope,
    label: canonical.label,
    base: canonical.base,
    creationStart: canonical.creationStart,
    source: canonical.source,
    retryOf,
    rootRunId,
  };
  const intent = { ...unsigned, intentHash: intentDigest(unsigned) };
  const payload: StoredPayload = {
    kind: "character_authoring_run",
    intent,
    proposal: { revision: 1, status: "unresolved", choices: {}, appliedDraft: null, undo: null },
    result: null,
  };
  const started = await startJobAfterAdmission({
    type: "character_authoring",
    ownerId,
    requestedJobId: canonical.requestId,
    ...(retryOf ? { activeDedupeKey: `character-authoring:${rootRunId}` } : {}),
    payload,
    run: async () => executeRun(ownerId, intent),
  }, admit);
  if (!started.ok) {
    if ("admission" in started) return { status: "admission", response: started.admission };
    return { status: "capacity", active: started.active, limit: started.limit };
  }
  const row = await ownedRunRow(ownerId, started.jobId);
  if (!row) return { status: "idempotency_conflict" };
  const parsed = payloadSchema.safeParse(row.payload);
  if (!parsed.success) return { status: "idempotency_conflict" };
  if (parsed.data.intent.intentHash !== intent.intentHash) {
    const activeSibling = retryOf !== null
      && parsed.data.intent.rootRunId === rootRunId
      && (row.status === "queued" || row.status === "running");
    if (!activeSibling) return { status: "idempotency_conflict" };
  }
  return { status: "accepted", run: projectRun(row, parsed.data) };
}

export function startCharacterAuthoringRun(ownerId: string, input: StartInput, admit: () => Promise<Response | null>) {
  return launch(ownerId, input, null, input.requestId, admit);
}

/** Move creation-draft runs onto the character minted from that same request. */
export async function bindCreationAuthoringRuns(ownerId: string, creationId: string, characterId: string, authoringRevision: number): Promise<void> {
  await db().transaction(async (tx) => {
    // Binding can race both detached completion (which merges `result`) and an
    // owner decision (which advances `proposal`). Lock and transform the current
    // row so this narrow target rewrite cannot restore an earlier payload.
    const rows = await tx.select().from(jobs).where(and(
      eq(jobs.ownerId, ownerId),
      eq(jobs.type, "character_authoring"),
      sql`${jobs.payload} -> 'intent' -> 'target' ->> 'kind' = 'creation'`,
      sql`${jobs.payload} -> 'intent' -> 'target' ->> 'id' = ${creationId}`,
    )).for("update");
    for (const row of rows) {
      const parsed = payloadSchema.safeParse(row.payload);
      if (!parsed.success) continue;
      const prior = parsed.data;
      const unsigned = {
        requestId: prior.intent.requestId,
        target: { kind: "character" as const, id: characterId },
        operation: prior.intent.operation,
        scope: prior.intent.scope,
        label: prior.intent.label,
        base: prior.intent.base,
        creationStart: prior.intent.creationStart,
        source: { authoringRevision, imageId: null },
        retryOf: prior.intent.retryOf,
        rootRunId: prior.intent.rootRunId,
      };
      const payload: StoredPayload = { ...prior, intent: { ...unsigned, intentHash: intentDigest(unsigned) } };
      await tx.update(jobs).set({ payload }).where(and(
        eq(jobs.id, row.id),
        eq(jobs.ownerId, ownerId),
        eq(jobs.type, "character_authoring"),
      ));
    }
  });
}

export async function retryCharacterAuthoringRun(ownerId: string, runId: string, requestId: string, admit: () => Promise<Response | null>): Promise<StartAuthoringRunOutcome> {
  const prior = await ownedRunRow(ownerId, runId);
  if (!prior) return { status: "not_found" };
  const parsed = payloadSchema.safeParse(prior.payload);
  if (!parsed.success) return { status: "idempotency_conflict" };
  const old = parsed.data.intent;
  if (old.operation === "portrait") {
    const imageId = old.source?.imageId;
    const contentHash = old.source?.imageContentHash;
    const fingerprint = old.source?.authoringFingerprint;
    if (!imageId || !contentHash || !fingerprint || old.target.kind !== "character") return { status: "portrait_source_changed" };
    const [character] = await db().select().from(characters).where(and(eq(characters.id, old.target.id), eq(characters.ownerId, ownerId))).limit(1);
    const loaded = await ownedPortraitBytes(ownerId, old.target.id, imageId);
    if (!character || character.avatarImageId !== imageId || !loaded || loaded.contentHash !== contentHash || portraitAuthoringFingerprint(rowDraft(character)) !== fingerprint) {
      return { status: "portrait_source_changed", currentRevision: character?.authoringRevision, currentImageId: character?.avatarImageId };
    }
  }
  const input = {
    requestId,
    target: old.target,
    operation: old.operation,
    scope: old.scope,
    label: old.label,
    base: old.base,
    creationStart: old.creationStart,
    source: old.source,
  } as StartInput;
  // Retry reuses the immutable accepted source only while the portrait and the
  // appearance facts relevant to the read still match it.
  return launch(ownerId, input, runId, old.rootRunId, admit, true);
}

export type DecideAuthoringRunOutcome =
  | { status: "accepted"; run: AuthoringRunDto; character?: typeof characters.$inferSelect }
  | { status: "not_found" | "invalid_run" | "proposal_changed" | "authoring_conflict" | "portrait_source_changed"; conflicts?: ReturnType<typeof proposalConflicts>; currentRevision?: number };

function rowDraft(character: typeof characters.$inferSelect): CharacterDraft {
  return characterDraftSchema.parse({ name: character.name, profile: character.profile, tags: character.tags, suggestedItems: [] });
}

function settlePortraitDecision(
  payload: StoredPayload,
  proposal: NonNullable<ReturnType<typeof applyCharacterProposal>["undo"]> | {
    id: string; label: string; base: CharacterDraft; proposed: CharacterDraft; undo: false;
  },
  action: "accept" | "reject" | "undo",
  choices: ProposalChoices,
  proposalRevision: number,
): StoredPayload {
  if (!payload.result?.portrait) return payload;
  const changes = proposalChanges(proposal);
  const fields: PortraitDecision["fields"] = [];
  for (const field of payload.result.portrait.fields) {
    const change = changes.find((candidate) => candidate.path.some((part) => typeof part === "object" && part.id === field.id));
    if (!change) continue;
    const decision = action === "reject" ? "rejected" as const
      : action === "undo" ? "undone" as const
        : choices[change.key] === "current" ? "kept" as const : "accepted" as const;
    fields.push({ id: field.id, decision });
  }
  const decision: PortraitDecision = {
    proposalRevision,
    action: action === "accept" ? "accepted" : action === "reject" ? "rejected" : "undone",
    fields,
  };
  const diagnostics = payload.result.diagnostics
    .filter((item) => item.code !== "forge.character.portrait.portrait_conflict" && !item.code.startsWith("forge.character.portrait.review_"));
  diagnostics.push(...fields.map((field) => diag(
    "info",
    `forge.character.portrait.review_${field.decision}`,
    `${field.id}: ${field.decision} at portrait proposal revision ${proposalRevision}.`,
    { context: { id: field.id, decision: field.decision, proposalRevision } },
  )));
  return {
    ...payload,
    result: {
      ...payload.result,
      diagnostics,
      portrait: { ...payload.result.portrait, decision },
    },
  };
}

export async function decideCharacterAuthoringRun(ownerId: string, runId: string, input: DecideInput): Promise<DecideAuthoringRunOutcome> {
  const before = await ownedRunRow(ownerId, runId);
  if (!before) return { status: "not_found" };
  const beforePayload = payloadSchema.safeParse(before.payload);
  if (!beforePayload.success) return { status: "invalid_run" };
  if (beforePayload.data.intent.operation === "portrait" && input.action !== "dismiss" && input.action !== "reject") {
    const source = beforePayload.data.result?.portrait?.source;
    if (!source || beforePayload.data.result?.portrait?.outcome === "read_failed") return { status: "invalid_run" };
    const loaded = await ownedPortraitBytes(ownerId, beforePayload.data.intent.target.id, source.imageId);
    if (!loaded || loaded.contentHash !== source.contentHash) return { status: "portrait_source_changed" };
  }
  const suggestionEmbeddings = input.action === "accept" || input.action === "undo"
    ? await prepareSuggestedItemEmbeddings((input.action === "undo" ? beforePayload.data.proposal.undo?.proposed : beforePayload.data.result?.proposed)?.suggestedItems ?? [])
    : [];
  const newItems: string[] = [];
  const sink = new DiagnosticCollector();
  const outcome = await db().transaction(async (tx): Promise<DecideAuthoringRunOutcome> => {
    const [job] = await tx.select().from(jobs).where(and(
      eq(jobs.id, runId), eq(jobs.ownerId, ownerId), eq(jobs.type, "character_authoring"),
    )).for("update");
    if (!job) return { status: "not_found" };
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) return { status: "invalid_run" };
    const payload = parsed.data;
    if (payload.proposal.revision !== input.expectedProposalRevision) return { status: "proposal_changed" };
    if (input.action === "dismiss") {
      const next = {
        ...payload,
        proposal: {
          ...payload.proposal,
          revision: payload.proposal.revision + 1,
          status: payload.proposal.status === "accepted" ? "accepted" as const : "dismissed" as const,
          undo: null,
        },
      };
      const [saved] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
      if (!saved) return tx.rollback();
      return { status: "accepted", run: projectRun(saved, next) };
    }
    if (job.status !== "done" || !payload.result) return { status: "invalid_run" };
    if (input.action === "reject" && payload.intent.target.kind === "creation") {
      if (payload.proposal.status !== "unresolved") return { status: "proposal_changed" };
      const revision = payload.proposal.revision + 1;
      const proposal = { id: runId, label: payload.intent.label, base: payload.intent.base, proposed: payload.result.proposed, undo: false as const };
      const next = settlePortraitDecision({ ...payload, proposal: { ...payload.proposal, revision, status: "rejected" as const, choices: input.choices, appliedDraft: null, undo: null } }, proposal, "reject", input.choices, revision);
      const [saved] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
      if (!saved) return tx.rollback();
      return { status: "accepted", run: projectRun(saved, next) };
    }

    const proposal = input.action === "undo" ? payload.proposal.undo : {
      id: runId, label: payload.intent.label, base: payload.intent.base, proposed: payload.result.proposed,
      undo: false as const, sourceRunId: runId, proposalRevision: payload.proposal.revision,
      ...(payload.result.portrait ? { portraitEvidence: payload.result.portrait } : {}),
    };
    if (!proposal || (input.action === "accept" && payload.proposal.status !== "unresolved") || (input.action === "undo" && payload.proposal.status !== "accepted")) return { status: "proposal_changed" };

    if (payload.intent.target.kind === "creation") {
      if (!input.currentDraft) return { status: "invalid_run" };
      const applied = applyCharacterProposal(input.currentDraft, proposal, input.choices as ProposalChoices);
      if (applied.unresolved.length) return { status: "authoring_conflict", conflicts: applied.unresolved };
      const revision = payload.proposal.revision + 1;
      const undo = input.action === "accept" && applied.undo ? { ...applied.undo, sourceRunId: runId, proposalRevision: revision } : null;
      const next = { ...payload, proposal: { revision, status: input.action === "undo" ? "undone" as const : "accepted" as const, choices: input.choices, appliedDraft: applied.draft, undo } };
      const [saved] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
      if (!saved) return tx.rollback();
      return { status: "accepted", run: projectRun(saved, next) };
    }

    const [character] = await tx.select().from(characters).where(and(
      eq(characters.id, payload.intent.target.id), eq(characters.ownerId, ownerId),
    )).for("update");
    if (!character) return { status: "not_found" };
    if (input.expectedAuthoringRevision === undefined) return { status: "invalid_run" };
    if (input.expectedAuthoringRevision !== character.authoringRevision) {
      return { status: "authoring_conflict", currentRevision: character.authoringRevision };
    }
    if (payload.intent.operation === "portrait" && input.action !== "reject") {
      const source = payload.result.portrait?.source;
      if (!source || character.avatarImageId !== source.imageId || portraitAuthoringFingerprint(rowDraft(character)) !== source.authoringFingerprint) {
        return { status: "portrait_source_changed", currentRevision: character.authoringRevision };
      }
    }
    if (input.action === "reject") {
      if (payload.proposal.status !== "unresolved") return { status: "proposal_changed" };
      const revision = payload.proposal.revision + 1;
      const next = settlePortraitDecision({ ...payload, proposal: { ...payload.proposal, revision, status: "rejected" as const, choices: input.choices, appliedDraft: null, undo: null } }, proposal, "reject", input.choices, revision);
      const [saved] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
      if (!saved) return tx.rollback();
      return { status: "accepted", run: projectRun(saved, next) };
    }
    const current = rowDraft(character);
    const applied = applyCharacterProposal(current, proposal, input.choices as ProposalChoices);
    if (applied.unresolved.length) return { status: "authoring_conflict", conflicts: applied.unresolved, currentRevision: character.authoringRevision };

    const materialized = await materializeSuggestedItems(ownerId, applied.draft.suggestedItems, sink, {
      executor: tx,
      preparedEmbeddings: suggestionEmbeddings,
      onCreated: (id) => newItems.push(id),
    });
    const currentProfile = parseOr(characterProfileSchema, applied.draft.profile, emptyCharacterProfile(), sink, "characters.profile");
    const mergedProfile = withItemsInDefaultOutfit(currentProfile, materialized.ids);
    const savedDraft = { ...applied.draft, suggestedItems: [], profile: { ...mergedProfile, attributes: materializeBodyDefaults(mergedProfile.attributes, mergedProfile) } };
    const [savedCharacter] = await tx.update(characters).set({
      name: savedDraft.name,
      profile: savedDraft.profile,
      tags: savedDraft.tags,
      updatedAt: new Date(Math.max(Date.now(), character.updatedAt.getTime() + 1)),
    }).where(and(eq(characters.id, character.id), eq(characters.ownerId, ownerId))).returning();
    if (!savedCharacter) return { status: "not_found" };

    const revision = payload.proposal.revision + 1;
    const review = reconcileMaterializedUndo({ pending: [], undo: applied.undo }, applied.draft, savedDraft.profile);
    const undo = input.action === "accept" && review.undo ? { ...review.undo, undo: true as const, sourceRunId: runId, proposalRevision: revision } : null;
    const next = settlePortraitDecision(
      { ...payload, proposal: { revision, status: input.action === "undo" ? "undone" as const : "accepted" as const, choices: input.choices, appliedDraft: savedDraft, undo } },
      proposal,
      input.action,
      input.choices,
      revision,
    );
    const [savedJob] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
    if (!savedJob) return tx.rollback();
    return { status: "accepted", run: projectRun(savedJob, next), character: savedCharacter };
  });
  if (outcome.status === "accepted" && outcome.character) {
    for (const id of newItems) queueEmbedRefresh("item", id);
    queueEmbedRefresh("character", outcome.character.id);
  }
  return outcome;
}
