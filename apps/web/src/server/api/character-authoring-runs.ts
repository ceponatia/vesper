import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  boundCharacterCreationBrief,
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
import { blankCreatedCharacterContent } from "./character-create";
import { reserveCharacterAuthoringAction, type CharacterAuthoringActionSource } from "./character-save";
import { isJobAdmissionPending, startJobAfterAdmission, waitForJobAdmission } from "./jobs";

const MAX_RUNS_PER_SURFACE = 25;

/**
 * Saved characters are the only authoring target. Runs stored for the removed
 * browser creation draft (`kind: "creation"`) no longer parse: listings never
 * select them, and decisions and retries refuse them before any provider work.
 * Nothing re-drives a stored job, so one left running at deploy is reclaimed
 * by the orphaned-job sweep.
 */
export const authoringTargetSchema = z.object({
  kind: z.literal("character"),
  id: z.string().min(1).max(128),
});
export const authoringSourceSchema = z.object({
  authoringRevision: z.number().int().positive().max(2_147_483_647),
  imageId: z.string().min(1).nullable().default(null),
  imageContentHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  authoringFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
const creationStartSchema = z.object({ draft: characterDraftSchema, prompt: z.string(), initialPreview: z.boolean() });
/**
 * The stored create snapshot. `origin: "reserved_row"` marks one the server
 * derived from the reserved character row. Only that snapshot's
 * `initialPreview` is projected: runs bound from the removed creation draft
 * carry a browser-computed flag that meant an untouched browser draft, not an
 * untouched saved character.
 */
const storedCreationStartSchema = creationStartSchema.extend({ origin: z.literal("reserved_row").optional() });
const resultSchema = z.object({
  proposed: characterDraftSchema,
  diagnostics: z.array(diagnosticSchema),
  portrait: portraitExtractionEvidenceSchema.nullable().optional(),
});
const undoSchema = z.object({
  id: z.string(), label: z.string(), base: characterDraftSchema, proposed: characterDraftSchema,
  undo: z.literal(true), sourceRunId: z.string(), proposalRevision: z.number().int().positive(),
  decidedAt: z.string().datetime().nullable().default(null),
  portraitEvidence: portraitExtractionEvidenceSchema.optional(),
});
const proposalStateSchema = z.object({
  revision: z.number().int().positive().default(1),
  status: z.enum(["unresolved", "accepted", "rejected", "undone", "dismissed"]).default("unresolved"),
  decidedAt: z.string().datetime().nullable().default(null),
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
  creationStart: storedCreationStartSchema.nullable(),
  source: authoringSourceSchema.nullable(),
  retryOf: z.string().nullable(),
  rootRunId: z.string(),
  /** `requestDigest` of the start request itself; absent on older rows. */
  requestHash: z.string().optional(),
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
  if (value.operation === "create" && !value.creationStart) ctx.addIssue({ code: "custom", message: "create runs require their creation snapshot" });
  if (value.operation === "portrait" && !value.source?.imageId) ctx.addIssue({ code: "custom", message: "portrait runs require a saved character and displayed image" });
  if (!value.source) ctx.addIssue({ code: "custom", message: "saved-character runs require an authoring revision" });
  if (value.operation === "redraft" && !value.scope) ctx.addIssue({ code: "custom", message: "redraft runs require a scope" });
});

export const retryAuthoringRunSchema = z.object({ requestId: z.string().min(8).max(128) });
export const decideAuthoringRunSchema = z.object({
  action: z.enum(["accept", "reject", "undo", "dismiss"]),
  expectedProposalRevision: z.number().int().positive(),
  expectedAuthoringRevision: z.number().int().positive().optional(),
  choices: z.record(z.string(), z.enum(["current", "proposed"])).default({}),
});

type StoredPayload = z.infer<typeof payloadSchema>;
type StoredIntent = z.infer<typeof intentSchema>;
type StartInput = z.infer<typeof startAuthoringRunSchema>;
type DecideInput = z.infer<typeof decideAuthoringRunSchema>;
/** A start whose content fields all come from the reserved server row. */
type CanonicalStart = Omit<StoredIntent, "retryOf" | "rootRunId" | "requestHash" | "intentHash">;
type StartConflict = {
  conflict: "not_found" | "authoring_revision_changed" | "portrait_changed" | "portrait_source_changed" | "invalid_source" | "brief_required";
  currentRevision?: number;
  currentImageId?: string | null;
};
type DigestInput = Pick<StartInput, "requestId" | "target" | "operation" | "scope" | "label" | "creationStart" | "source">;
export type AuthoringRunDto = ReturnType<typeof projectRun>;

function intentDigest(value: Omit<StoredIntent, "intentHash">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The idempotency identity of a start request. Content is reconstructed from
 * the reserved server row, so the untrusted browser base and the browser's
 * create snapshot are absent; only the snapshot's prompt, the author's intent,
 * takes part.
 */
function requestDigest(input: DigestInput, retryOf: string | null, rootRunId: string): string {
  return createHash("sha256").update(JSON.stringify({
    requestId: input.requestId,
    target: input.target,
    operation: input.operation,
    scope: input.scope,
    label: input.label,
    creationStart: input.creationStart ? { prompt: input.creationStart.prompt } : null,
    source: input.source ? { authoringRevision: input.source.authoringRevision, imageId: input.source.imageId } : null,
    retryOf,
    rootRunId,
  })).digest("hex");
}

/**
 * A stored create snapshot holds the server-derived brief rather than the
 * prompt the browser sent, so runs record the digest of the request itself.
 * Rows written before that recompute it from their stored intent.
 */
function matchesStoredRequest(payload: StoredPayload, input: StartInput, retryOf: string | null, rootRunId: string): boolean {
  const stored = payload.intent.requestHash ?? requestDigest(payload.intent, payload.intent.retryOf, payload.intent.rootRunId);
  return stored === requestDigest(input, retryOf, rootRunId);
}

function projectCreationStart(start: StoredIntent["creationStart"]) {
  if (!start) return null;
  return { draft: start.draft, prompt: start.prompt, initialPreview: start.initialPreview && start.origin === "reserved_row" };
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
    creationStart: projectCreationStart(payload.intent.creationStart),
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

function rowDraft(character: { name: string; profile: unknown; tags: unknown }): CharacterDraft | null {
  const parsed = characterDraftSchema.safeParse({
    name: character.name,
    profile: character.profile,
    tags: character.tags,
    suggestedItems: [],
  });
  return parsed.success ? parsed.data : null;
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
    if (isJobAdmissionPending(row.payload)) continue;
    const run = parseRun(row);
    if (run) runs.push(run);
    else diagnostics.push(diag("warn", "authoring.run.malformed", "One saved authoring run could not be read and was omitted.", { context: { runId: row.id } }));
  }
  return { runs: runs.filter((run) => run.proposal.status !== "dismissed"), diagnostics };
}

/** What jsonb storage keeps of a value: members that are undefined disappear. */
function asStoredJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Whether the reserved row is still exactly as `createOwnedCharacter` made it
 * for a blank `{ name }` body. The database advances the authoring revision
 * only when name, profile or tags change. Profile and tags are compared
 * structurally because jsonb rewrites object key order; the name is not
 * compared, since a never-edited character keeps its creation placeholder.
 */
function isUntouchedBlankCharacter(row: Pick<CharacterAuthoringActionSource, "authoringRevision" | "profile" | "tags">): boolean {
  if (row.authoringRevision !== 1) return false;
  const blank = blankCreatedCharacterContent();
  return isDeepStrictEqual(row.profile, asStoredJson(blank.profile)) && isDeepStrictEqual(row.tags, asStoredJson(blank.tags));
}

/**
 * The create snapshot comes from the reserved row, never from the browser. A
 * character's saved original brief outranks a typed one; with neither there is
 * nothing to forge from. The first Forge may apply without review only while
 * the character has no brief and is still an untouched blank.
 */
function deriveCreationStart(row: CharacterAuthoringActionSource, base: CharacterDraft, requestedPrompt: string): NonNullable<CanonicalStart["creationStart"]> | null {
  const savedBrief = base.profile.creationBrief;
  const prompt = savedBrief || boundCharacterCreationBrief(requestedPrompt);
  if (!prompt) return null;
  return { draft: base, prompt, initialPreview: !savedBrief && isUntouchedBlankCharacter(row), origin: "reserved_row" };
}

async function canonicalizeStart(ownerId: string, input: StartInput): Promise<CanonicalStart | StartConflict> {
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
  const base = rowDraft(reserved.source);
  if (!base) {
    return {
      conflict: "invalid_source",
      currentRevision: reserved.source.authoringRevision,
      currentImageId: reserved.source.avatarImageId,
    };
  }
  const request = {
    requestId: input.requestId,
    target: input.target,
    operation: input.operation,
    scope: input.scope,
    label: input.label,
    base,
  };
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
      ...request,
      creationStart: null,
      source: {
        authoringRevision: reserved.source.authoringRevision,
        imageId: source.imageId,
        imageContentHash: portrait.contentHash,
        authoringFingerprint: portraitAuthoringFingerprint(base),
      },
    };
  }
  let creationStart: CanonicalStart["creationStart"] = null;
  if (input.operation === "create") {
    creationStart = deriveCreationStart(reserved.source, base, input.creationStart?.prompt ?? "");
    // A refusal before admission: no job row, no budget charge, no provider call.
    if (!creationStart) return { conflict: "brief_required" };
  }
  return {
    ...request,
    creationStart,
    source: { authoringRevision: reserved.source.authoringRevision, imageId: source.imageId },
  };
}

async function executeRun(ownerId: string, intent: StoredIntent): Promise<Pick<StoredPayload, "result">> {
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
    const currentDraft = current ? rowDraft(current) : null;
    const sourceChanged = !current || !currentDraft || current.avatarImageId !== imageId
      || portraitAuthoringFingerprint(currentDraft) !== authoringFingerprint;
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
    // The snapshot's prompt is the effective brief. It reaches the character
    // only through an accepted result (see `withAcceptedCreationBrief`).
    const brief = boundCharacterCreationBrief(intent.creationStart?.prompt ?? "") || base.profile.creationBrief;
    const forged = await forgeCharacter({ prompt: brief, userId: ownerId, sink });
    // A forge that names no one keeps the saved name; a saved character is never
    // proposed a blank one.
    proposed = { ...forged, name: forged.name.trim() ? forged.name : base.name, profile: { ...forged.profile, creationBrief: brief } };
  }
  const result = { proposed, diagnostics: sink.items, ...(portrait ? { portrait } : {}) };
  return { result };
}

export type StartAuthoringRunOutcome =
  | { status: "accepted"; run: AuthoringRunDto }
  | { status: "capacity"; active: number; limit: number }
  | { status: "admission"; response: Response }
  | { status: "not_found" }
  | { status: "authoring_revision_changed" | "portrait_changed" | "portrait_source_changed" | "invalid_source"; currentRevision?: number; currentImageId?: string | null }
  | { status: "brief_required" }
  | { status: "admission_pending" }
  | { status: "idempotency_conflict" };

export function isCoalescedAuthoringRetry(
  started: { readonly jobId: string; readonly inserted: boolean },
  requestId: string,
  retryOf: string | null,
  rootRunId: string,
  storedRootRunId: string,
): boolean {
  return retryOf !== null
    && !started.inserted
    && started.jobId !== requestId
    && storedRootRunId === rootRunId;
}

/** `reserved` is a retry's already-accepted source, which skips reservation. */
async function launch(ownerId: string, input: StartInput, retryOf: string | null, rootRunId: string, admit: () => Promise<Response | null>, reserved: CanonicalStart | null = null): Promise<StartAuthoringRunOutcome> {
  const existing = await ownedRunRow(ownerId, input.requestId);
  if (existing) {
    const admission = await waitForJobAdmission(existing.id);
    if (admission === "pending") return { status: "admission_pending" };
    if (admission === "admitted") {
      const admitted = await ownedRunRow(ownerId, existing.id);
      const parsed = admitted ? payloadSchema.safeParse(admitted.payload) : null;
      if (!admitted || !parsed?.success) return { status: "idempotency_conflict" };
      return matchesStoredRequest(parsed.data, input, retryOf, rootRunId)
        ? { status: "accepted", run: projectRun(admitted, parsed.data) }
        : { status: "idempotency_conflict" };
    }
  }
  const canonical = reserved ?? await canonicalizeStart(ownerId, input);
  if ("conflict" in canonical) {
    const raced = await ownedRunRow(ownerId, input.requestId);
    const admission = raced ? await waitForJobAdmission(raced.id) : "missing";
    if (admission === "pending") return { status: "admission_pending" };
    const admitted = admission === "admitted" ? await ownedRunRow(ownerId, input.requestId) : null;
    const parsed = admitted ? payloadSchema.safeParse(admitted.payload) : null;
    if (admitted && parsed?.success && matchesStoredRequest(parsed.data, input, retryOf, rootRunId)) {
      return { status: "accepted", run: projectRun(admitted, parsed.data) };
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
    requestHash: requestDigest(input, retryOf, rootRunId),
  };
  const intent = { ...unsigned, intentHash: intentDigest(unsigned) };
  const payload: StoredPayload = {
    kind: "character_authoring_run",
    intent,
    proposal: { revision: 1, status: "unresolved", decidedAt: null, choices: {}, appliedDraft: null, undo: null },
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
    if ("admissionPending" in started) return { status: "admission_pending" };
    return { status: "capacity", active: started.active, limit: started.limit };
  }
  const row = await ownedRunRow(ownerId, started.jobId);
  if (!row) return { status: "idempotency_conflict" };
  const parsed = payloadSchema.safeParse(row.payload);
  if (!parsed.success) return { status: "idempotency_conflict" };
  if (parsed.data.intent.intentHash !== intent.intentHash) {
    const coalescedSibling = isCoalescedAuthoringRetry(
      started,
      canonical.requestId,
      retryOf,
      rootRunId,
      parsed.data.intent.rootRunId,
    );
    if (!coalescedSibling) return { status: "idempotency_conflict" };
  }
  return { status: "accepted", run: projectRun(row, parsed.data) };
}

export function startCharacterAuthoringRun(ownerId: string, input: StartInput, admit: () => Promise<Response | null>) {
  return launch(ownerId, input, null, input.requestId, admit);
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
    if (!imageId || !contentHash || !fingerprint) return { status: "portrait_source_changed" };
    const [character] = await db().select().from(characters).where(and(eq(characters.id, old.target.id), eq(characters.ownerId, ownerId))).limit(1);
    const loaded = await ownedPortraitBytes(ownerId, old.target.id, imageId);
    const currentDraft = character ? rowDraft(character) : null;
    if (character && !currentDraft) {
      return { status: "invalid_source", currentRevision: character.authoringRevision, currentImageId: character.avatarImageId };
    }
    if (!character || character.avatarImageId !== imageId || !loaded || loaded.contentHash !== contentHash || !currentDraft || portraitAuthoringFingerprint(currentDraft) !== fingerprint) {
      return { status: "portrait_source_changed", currentRevision: character?.authoringRevision, currentImageId: character?.avatarImageId };
    }
  }
  const reserved: CanonicalStart = {
    requestId,
    target: old.target,
    operation: old.operation,
    scope: old.scope,
    label: old.label,
    base: old.base,
    creationStart: old.creationStart,
    source: old.source,
  };
  // Retry reuses the immutable accepted source only while the portrait and the
  // appearance facts relevant to the read still match it. A create retry keeps
  // its original snapshot, so a first Forge still applies without review only
  // while the character remains at the revision that snapshot was taken from.
  return launch(ownerId, reserved, runId, old.rootRunId, admit, reserved);
}

export type DecideAuthoringRunOutcome =
  | { status: "accepted"; run: AuthoringRunDto; character?: typeof characters.$inferSelect }
  | { status: "not_found" | "invalid_run" | "proposal_changed" | "authoring_conflict" | "portrait_source_changed" | "invalid_source"; conflicts?: ReturnType<typeof proposalConflicts>; currentRevision?: number };

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

/**
 * Proposal review never diffs `profile.creationBrief` (lib/character-proposals.ts),
 * so an accepted create run writes its brief here. The brief is the character's
 * original concept: it is written once, onto a character that has none, and only
 * when the acceptance applied part of the result. Rejection, failure and undo
 * leave the stored brief as it was.
 */
function withAcceptedCreationBrief(current: CharacterDraft, applied: ReturnType<typeof applyCharacterProposal>, brief: string): CharacterDraft {
  if (!brief || current.profile.creationBrief || !applied.undo) return applied.draft;
  return { ...applied.draft, profile: { ...applied.draft.profile, creationBrief: brief } };
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
      const decidedAt = new Date().toISOString();
      const next = {
        ...payload,
        proposal: {
          ...payload.proposal,
          revision: payload.proposal.revision + 1,
          status: payload.proposal.status === "accepted" ? "accepted" as const : "dismissed" as const,
          decidedAt,
          undo: null,
        },
      };
      const [saved] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
      if (!saved) return tx.rollback();
      return { status: "accepted", run: projectRun(saved, next) };
    }
    if (job.status !== "done" || !payload.result) return { status: "invalid_run" };

    const proposal = input.action === "undo" ? payload.proposal.undo : {
      id: runId, label: payload.intent.label, base: payload.intent.base, proposed: payload.result.proposed,
      undo: false as const, sourceRunId: runId, proposalRevision: payload.proposal.revision,
      ...(payload.result.portrait ? { portraitEvidence: payload.result.portrait } : {}),
    };
    if (!proposal || (input.action === "accept" && payload.proposal.status !== "unresolved") || (input.action === "undo" && payload.proposal.status !== "accepted")) return { status: "proposal_changed" };

    const [character] = await tx.select().from(characters).where(and(
      eq(characters.id, payload.intent.target.id), eq(characters.ownerId, ownerId),
    )).for("update");
    if (!character) return { status: "not_found" };
    if (input.expectedAuthoringRevision === undefined) return { status: "invalid_run" };
    if (input.expectedAuthoringRevision !== character.authoringRevision) {
      return { status: "authoring_conflict", currentRevision: character.authoringRevision };
    }
    const current = rowDraft(character);
    if (!current) return { status: "invalid_source", currentRevision: character.authoringRevision };
    if (payload.intent.operation === "portrait" && input.action !== "reject") {
      const source = payload.result.portrait?.source;
      if (!source || character.avatarImageId !== source.imageId || portraitAuthoringFingerprint(current) !== source.authoringFingerprint) {
        return { status: "portrait_source_changed", currentRevision: character.authoringRevision };
      }
    }
    if (input.action === "reject") {
      if (payload.proposal.status !== "unresolved") return { status: "proposal_changed" };
      const decidedAt = new Date().toISOString();
      const revision = payload.proposal.revision + 1;
      const next = settlePortraitDecision({ ...payload, proposal: { ...payload.proposal, revision, status: "rejected" as const, decidedAt, choices: input.choices, appliedDraft: null, undo: null } }, proposal, "reject", input.choices, revision);
      const [saved] = await tx.update(jobs).set({ payload: next }).where(eq(jobs.id, runId)).returning();
      if (!saved) return tx.rollback();
      return { status: "accepted", run: projectRun(saved, next) };
    }
    const applied = applyCharacterProposal(current, proposal, input.choices as ProposalChoices);
    if (applied.unresolved.length) return { status: "authoring_conflict", conflicts: applied.unresolved, currentRevision: character.authoringRevision };
    const acceptedDraft = input.action === "accept" && payload.intent.operation === "create"
      ? withAcceptedCreationBrief(current, applied, payload.result.proposed.profile.creationBrief)
      : applied.draft;

    const materialized = await materializeSuggestedItems(ownerId, acceptedDraft.suggestedItems, sink, {
      executor: tx,
      preparedEmbeddings: suggestionEmbeddings,
      onCreated: (id) => newItems.push(id),
    });
    const currentProfile = parseOr(characterProfileSchema, acceptedDraft.profile, emptyCharacterProfile(), sink, "characters.profile");
    const mergedProfile = withItemsInDefaultOutfit(currentProfile, materialized.ids);
    const savedDraft = { ...acceptedDraft, suggestedItems: [], profile: { ...mergedProfile, attributes: materializeBodyDefaults(mergedProfile.attributes, mergedProfile) } };
    const [savedCharacter] = await tx.update(characters).set({
      name: savedDraft.name,
      profile: savedDraft.profile,
      tags: savedDraft.tags,
      updatedAt: new Date(Math.max(Date.now(), character.updatedAt.getTime() + 1)),
    }).where(and(eq(characters.id, character.id), eq(characters.ownerId, ownerId))).returning();
    if (!savedCharacter) return { status: "not_found" };

    const decidedAt = new Date().toISOString();
    const revision = payload.proposal.revision + 1;
    const review = reconcileMaterializedUndo({ pending: [], undo: applied.undo }, acceptedDraft, savedDraft.profile);
    const undo = input.action === "accept" && review.undo ? { ...review.undo, undo: true as const, sourceRunId: runId, proposalRevision: revision, decidedAt } : null;
    const next = settlePortraitDecision(
      { ...payload, proposal: { revision, status: input.action === "undo" ? "undone" as const : "accepted" as const, decidedAt, choices: input.choices, appliedDraft: savedDraft, undo } },
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
