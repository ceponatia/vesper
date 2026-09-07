import { and, eq } from "drizzle-orm";
import {
  type EnsureIdentityPackResult,
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackWarningCode,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { runInBatches } from "@/lib/batches";
import { characters, db, hasLiveCharacterJob, jobs } from "../db";
import { log } from "@/server/log";
import { ensureIdentityPack, runDerivation } from "./identity-pack-ensure";
import { invalidateIdentityPackForSource } from "./identity-pack-maintenance";
import { currentPackRow, errorMessage, isLiveReservation } from "./identity-pack-store";

/**
 * Preparation ahead of demand: the fire-and-forget job portrait ACCEPTANCE
 * triggers, and the bounded admin batch.
 *
 * Both are wrappers around {@link ensureIdentityPack} — they add a job row, a
 * convergence loop and a report, and no derivation logic of their own.
 */

/* ------------------------------------------------------------------------ *
 * Background preparation                                                    *
 * ------------------------------------------------------------------------ */

/**
 * Fire-and-forget pack preparation after a portrait is ACCEPTED — the one
 * production trigger, called by `portrait-acceptance.ts` and nothing else.
 * Generating, uploading, promoting or cloning a portrait moves the candidate
 * pointer and derives nothing.
 *
 * Returns void immediately and swallows everything: preparation does NOT
 * participate in the transaction that recorded the acceptance, so no detector,
 * crop, measurement or file-write failure can roll back a perfectly good
 * acceptance. The ordering it completes is `source row ready → accepted pointer
 * committed → preparation requested`.
 *
 * It also owns the invalidation half of the acceptance: the previous current pack
 * is marked stale before the dedupe runs, so a character never keeps a `ready`
 * pack for a portrait it no longer accepts (see {@link prepareIdentityPackJob}).
 *
 * Being deduped away is not being dropped. A trigger suppressed by the live job
 * is answered by that job, which re-reads the accepted pointer once its
 * derivation settles and derives again if the pointer moved (see
 * {@link convergeIdentityPackPreparation}) — so the caller's contract is "the
 * character will have a pack for whatever portrait it ends up pointing at", not
 * "this particular click got a derivation".
 *
 * The job row is inserted here rather than through `startJob` for an
 * architectural reason, not a preference: `@/server/api` re-exports `clone.ts`,
 * which imports `@/server/images`, so calling into that barrel from this module
 * would close an import cycle. The shape is the same as the image sweep's own
 * job row (`asset-maintenance.ts`), which is likewise local, provider-free work — hence
 * `providerLaneFor("identity_pack") === null`, since a failure here says
 * something about this app, not about an upstream.
 */
export function queueIdentityPackPreparation(characterId: string, ownerId: string): void {
  void prepareIdentityPackJob(characterId, ownerId).catch((err: unknown) => {
    log.warn("images", "identity_pack enqueue failed", {
      characterId,
      ownerId,
      error: errorMessage(err).slice(0, 300),
    });
  });
}

async function prepareIdentityPackJob(characterId: string, ownerId: string): Promise<void> {
  // Invalidate BEFORE the dedupe, always: the assignment path marks any previous
  // current pack stale before or while
  // requesting the new derivation. Order is the whole point: promoting portrait B
  // while portrait A's job is still live gets this call deduped away, and without
  // the invalidation A's `ready` pack would stay current forever — pointing at a
  // portrait the character no longer has, with nothing in the UI offering to
  // re-prepare it and no later `ensureIdentityPack` re-deriving it.
  try {
    await invalidateIdentityPackForSource({ characterIds: [characterId] });
  } catch (err) {
    // Contained: a failed invalidation must not stop the derivation being queued.
    // Read-time hash verification still refuses a crop whose bytes moved.
    log.warn("images", "identity pack invalidation before enqueue failed", {
      characterId,
      error: errorMessage(err).slice(0, 300),
    });
  }

  // One live derivation per character: clicking through three portraits in a row
  // must not start three. The staleness bound inside the helper keeps a job
  // orphaned by a deploy from wedging this character forever. Suppression is only
  // safe because the live job CONVERGES — it re-reads the pointer after its own
  // derivation settles — so a click swallowed here is still served by it.
  if (await hasLiveCharacterJob("identity_pack", characterId)) return;

  const [job] = await db()
    .insert(jobs)
    .values({
      type: "identity_pack",
      ownerId,
      status: "running",
      payload: { characterId },
      attempts: 1,
      startedAt: new Date(),
    })
    .returning({ id: jobs.id });
  if (!job) return;

  const passes: PreparationPass[] = [];
  try {
    const convergence = await convergeIdentityPackPreparation(characterId, ownerId, passes);
    await db()
      .update(jobs)
      .set({
        status: "done",
        payload: preparationPayload(characterId, passes, convergence),
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  } catch (err) {
    // NO recheck from here, deliberately. `ensureIdentityPack` contains its own
    // failures and returns `blocked` rather than throwing, so reaching this catch
    // means a database round trip failed — and every read the recheck would make
    // is another one of those. Converging on top of a sick database turns a
    // contained best-effort job into a hot loop against it. The row is marked
    // `failed`, which is the honest record, and the character is covered by the
    // next canonical-portrait trigger or the first identity render's lazy ensure.
    const message = errorMessage(err).slice(0, 500);
    log.warn("images", "identity_pack job failed", { characterId, error: message });
    await db()
      .update(jobs)
      .set({
        status: "failed",
        error: message,
        payload: preparationPayload(characterId, passes, "threw"),
        finishedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
  }
}

/**
 * Test-only: the job {@link queueIdentityPackPreparation} fires, as an awaitable
 * promise. Production never calls it.
 *
 * The seam exists because the production entry is `void`-and-swallow by contract —
 * that is the containment guarantee, and it must not change — which leaves a test
 * with nothing to await. Polling the jobs table for a terminal status instead would
 * make every assertion about the settled state a race against the job's own last
 * write. This is the same function the production entry calls, with only the
 * `void`/`catch` wrapper removed, so nothing about the behavior under test is
 * test-shaped: the invalidation, the dedupe, the job row and the convergence loop
 * are all exactly what a portrait promotion runs.
 */
export function runIdentityPackPreparationForTesting(characterId: string, ownerId: string): Promise<void> {
  return prepareIdentityPackJob(characterId, ownerId);
}

/**
 * Passes one preparation job will make before it stops chasing the pointer.
 *
 * Three, and the number counts "times the canonical pointer moved out from under
 * a settling derivation", not clicks: every pass re-reads the LATEST pointer, so
 * a burst of portrait changes collapses into one pass against the final one
 * rather than queueing a pass each. Converging on the latest source is the goal;
 * deriving every intermediate portrait somebody scrolled past is not, and would
 * be a worse use of the same detector runs.
 *
 * Two is the ordinary worst case — derive A, lose the finalize to B's promotion,
 * derive B — and the third is slack for one more change landing inside the second
 * pass. Past that the character is being repointed faster than a derivation
 * completes, and a job that keeps chasing is an unbounded background loop nobody
 * asked for. It stops with a diagnostic; the next trigger's job, or the first
 * identity render's lazy ensure, picks the character up.
 *
 * Exported because it is part of what the job row reports: `passes` is bounded by
 * it, so a reader of the payload — an operator or the test that pins the bound —
 * needs the number rather than a copy of it that can drift.
 */
export const MAX_IDENTITY_PACK_PREPARATION_PASSES = 3;

/** What one pass aimed at and what came back — the job payload's audit trail. */
interface PreparationPass {
  /** The canonical pointer as of the top of this pass; null if the character had none. */
  sourceImageId: string | null;
  outcome: EnsureIdentityPackResult["status"];
  code?: ImageIdentityPackFailureCode;
  retryable?: boolean;
}

/**
 * Why the job stopped passing.
 *
 * `stalled` and `unconverged` are different failures and an operator needs to tell
 * them apart: `stalled` means one source refused to yield a pack (the `code` field
 * says which way), `unconverged` means the character was being repointed faster
 * than it could be derived. The first is about a portrait, the second about a user.
 */
type PreparationConvergence = "converged" | "in_flight" | "stalled" | "unconverged" | "threw";

/**
 * Derive until the current revision describes the character's CURRENT canonical
 * portrait, bounded by {@link MAX_IDENTITY_PACK_PREPARATION_PASSES}.
 *
 * The race this exists for: portrait A's job is deriving when portrait B is
 * promoted. B's trigger invalidates A's pack (correctly) and is then deduped away
 * by A's live job (also correctly — one derivation per character is the whole
 * point of the dedupe). A's derivation then loses its finalize compare-and-set,
 * because the character no longer names A. Without this loop nothing would ever
 * prepare B: the job that COULD have is the one that just suppressed B's trigger,
 * and it was about to exit. The character sat with no ready pack until somebody
 * pressed Ensure or an identity render backfilled it lazily.
 *
 * So the settle-and-recheck belongs here rather than in a second job. A job per
 * click is exactly what the dedupe refuses, and re-queueing from inside a job is
 * that with extra steps.
 *
 * `passes` is filled in place so the caller's catch can still report how far the
 * job got when a database call throws mid-flight.
 */
async function convergeIdentityPackPreparation(
  characterId: string,
  ownerId: string,
  passes: PreparationPass[],
): Promise<PreparationConvergence> {
  let target = await canonicalSourceId(characterId, ownerId);
  for (let pass = 1; ; pass += 1) {
    const result = await ensureIdentityPack({ ownerId, characterId, purpose: "background" });
    passes.push({
      sourceImageId: target,
      outcome: result.status,
      ...(result.status === "blocked" ? { code: result.code, retryable: result.retryable } : {}),
    });

    const check = await preparationConvergence(characterId, ownerId);
    if (check.kind !== "unconverged") return check.kind;

    // A pass is only ever repeated because the POINTER MOVED. If it still names
    // what this pass just targeted, the pass ran against exactly these inputs and
    // left no revision covering them — an unreadable or not-yet-ready source, most
    // often — and running it again is the same call with the same arguments.
    // Retrying THAT is the retry policy's job, on a backoff clock, from the next
    // trigger; it is not a tight loop's job.
    if (check.sourceImageId === target) return "stalled";

    if (pass >= MAX_IDENTITY_PACK_PREPARATION_PASSES) {
      log.warn("images", "identity pack preparation stopped short of the latest portrait", {
        characterId,
        passes: pass,
        sourceImageId: check.sourceImageId,
      });
      return "unconverged";
    }
    target = check.sourceImageId;
  }
}

type ConvergenceCheck =
  /** The current revision answers for the canonical pointer, or there is no pointer. */
  | { kind: "converged" }
  /** Another process is deriving the canonical pointer right now. Not ours to chase. */
  | { kind: "in_flight" }
  /** Nothing on record covers the canonical pointer; another pass is warranted. */
  | { kind: "unconverged"; sourceImageId: string };

/**
 * Whether the current revision covers the character's accepted pointer AS OF NOW
 * — re-read, never carried over from the top of the pass, because the pointer
 * moving is the entire condition being tested.
 *
 * `in_flight` is a stop, not a retry. A live `pending` revision for the right
 * source cannot be this job's own — its ensure already settled — so another
 * process owns that derivation, and a `background` ensure declines those promptly
 * by ruling — cross-process coalescing. Passing again would earn the same
 * refusal on a timer, which is polling another machine's work from a job slot: the
 * one thing the background purpose exists not to do. That process's own
 * settle-and-recheck, or the next trigger, converges.
 *
 * A pointer of null is `converged` rather than a failure: a character with no
 * accepted portrait has nothing to converge ON, and another pass would only
 * re-earn `source_missing`.
 */
async function preparationConvergence(characterId: string, ownerId: string): Promise<ConvergenceCheck> {
  const sourceImageId = await canonicalSourceId(characterId, ownerId);
  if (sourceImageId === null) return { kind: "converged" };

  const current = await currentPackRow(characterId);
  if (current === undefined || current.sourceImageId !== sourceImageId) return { kind: "unconverged", sourceImageId };
  if (current.status === "pending") {
    // Past the staleness bound the reservation's process is gone, so the row
    // carries no answer and nobody is producing one — the same reading
    // `answerFromCurrent` takes of it.
    return isLiveReservation(current) ? { kind: "in_flight" } : { kind: "unconverged", sourceImageId };
  }
  return { kind: "converged" };
}

/**
 * The character's ACCEPTED pointer — the pack's source — read through the OWNER
 * like every other pack operation: the authorization root. A character that
 * vanished or changed hands mid-job reads as no pointer, which ends the loop
 * rather than letting a detached job keep working on somebody else's row. So
 * does one whose acceptance was cleared while the job ran.
 */
async function canonicalSourceId(characterId: string, ownerId: string): Promise<string | null> {
  const [character] = await db()
    .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return character?.acceptedAvatarImageId ?? null;
}

/**
 * What the finished job row says it did.
 *
 * `outcome`/`code`/`retryable` describe the LAST pass and keep the shape earlier
 * rows had, so an operator reading the table does not have to know which build
 * wrote a row. Everything the convergence loop added is additive: `passes` names
 * the source image each pass targeted — the only way to see that a job derived B
 * after A was promoted away from under it — and `convergence` says why it stopped.
 *
 * This IS the diagnostic surface for background preparation. The job takes no
 * `DiagnosticSink`, because a sink belongs to a request and nobody is making one
 * here; the row is what an operator reads instead, so the stable code goes in it
 * beside the log line — which is why the verdict-to-code mapping lives in exactly
 * this one place rather than at each `return`.
 */
function preparationPayload(
  characterId: string,
  passes: PreparationPass[],
  convergence: PreparationConvergence,
): Record<string, unknown> {
  const last = passes.at(-1);
  const diagnostic = preparationDiagnostic(convergence);
  return {
    characterId,
    ...(last ? { outcome: last.outcome, ...(last.code ? { code: last.code, retryable: last.retryable } : {}) } : {}),
    passes,
    convergence,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/**
 * The stable diagnostic code for a verdict that needs one.
 *
 * `threw` gets none: the job row's `error` column already carries what happened,
 * and inventing a pack-shaped code for a database failure would file it under the
 * wrong thing entirely. `stalled` gets none either, for the opposite reason — the
 * pass's own `code` is already the actionable answer, and a second code beside it
 * would only compete with it.
 */
function preparationDiagnostic(convergence: PreparationConvergence): string | null {
  switch (convergence) {
    case "converged":
    case "stalled":
    case "threw":
      return null;
    case "in_flight":
      return "images.identity_pack.pending_conflict";
    case "unconverged":
      // The pointer kept moving; that IS the reason, and it is the code the
      // lifecycle spec already names for a source that changed underneath a pack.
      return "images.identity_pack.source_changed";
  }
}

/* ------------------------------------------------------------------------ *
 * Bounded batch preparation                                                 *
 * ------------------------------------------------------------------------ */

/**
 * The named trial corpora an admin batch may address by id.
 *
 * Empty at v1, and that is the deliverable: the seam exists, resolution is typed,
 * and an unknown id fails loudly instead of running an empty batch that reports
 * success. The corpus itself is a set of CHARACTER ids, and character ids are
 * per-environment cuid2s — so the entries arrive with the trial slice's fixture
 * characters (which must cover contrast, framing, a
 * stylized subject, glasses, occlusion, a multi-person source, a low-resolution
 * source), not as literals invented here.
 */
export const IDENTITY_PACK_TRIAL_CORPORA: ReadonlyMap<string, readonly string[]> = new Map();

/** Hard ceiling for one batch, whatever `maxCount` asks for. There is no "rebuild everything". */
const IDENTITY_PACK_BATCH_MAX = 200;

/** Bounded parallelism: local sharp work, on the machine serving renders. */
const IDENTITY_PACK_BATCH_MAX_CONCURRENCY = 4;
const IDENTITY_PACK_BATCH_DEFAULT_CONCURRENCY = 2;

export interface PrepareIdentityPacksBatchInput {
  ownerId: string;
  characterIds?: readonly string[];
  corpusId?: string;
  dryRun: boolean;
  maxCount?: number;
  concurrency?: number;
  /** Re-derive even a current ready pack (a derivation change under the same version). */
  regenerate?: boolean;
  sink?: DiagnosticSink;
}

export type IdentityPackBatchOutcome =
  | { characterId: string; outcome: "ready"; revision: number; warnings: ImageIdentityPackWarningCode[] }
  | { characterId: string; outcome: "blocked"; code: ImageIdentityPackFailureCode; retryable: boolean }
  /** Not this owner's, or gone. The two are deliberately indistinguishable. */
  | { characterId: string; outcome: "not_found" }
  | { characterId: string; outcome: "would_prepare" }
  | { characterId: string; outcome: "up_to_date" };

export interface IdentityPackBatchCounts {
  ready: number;
  blocked: number;
  notFound: number;
  wouldPrepare: number;
  upToDate: number;
}

export type PrepareIdentityPacksBatchResult =
  | {
      ok: true;
      dryRun: boolean;
      requested: number;
      counts: IdentityPackBatchCounts;
      results: IdentityPackBatchOutcome[];
    }
  | { ok: false; code: "unknown_corpus" | "empty_selection" | "too_many"; message: string };

/**
 * Prepare a bounded set of characters' packs ahead of demand.
 *
 * Existing characters are NOT migrated by eagerly processing every portrait —
 * the first identity-critical request derives what it needs. This exists for the
 * one case that cannot wait for demand: preparing a fixed trial corpus so the
 * comparison cells run against packs that already exist.
 *
 * The refusals are the feature. An oversized request fails rather than being
 * silently truncated (an admin who asked for 500 and got 200 would read the
 * report as complete), an unknown corpus id fails rather than running empty, and
 * concurrency is clamped whatever the caller sends. `dryRun` answers "what would
 * this do?" from ids and versions alone — it never hashes bytes, so it is cheap
 * enough to run before every real batch.
 *
 * Per-character outcomes are stable codes, never image bytes: this response can
 * be logged, pasted into a trial note, and diffed against the next run.
 */
export async function prepareIdentityPacksBatch(
  input: PrepareIdentityPacksBatchInput,
): Promise<PrepareIdentityPacksBatchResult> {
  const selection = resolveBatchSelection(input);
  if (!selection.ok) return selection;

  const characterIds = selection.characterIds;
  const concurrency = Math.min(
    Math.max(1, Math.floor(input.concurrency ?? IDENTITY_PACK_BATCH_DEFAULT_CONCURRENCY)),
    IDENTITY_PACK_BATCH_MAX_CONCURRENCY,
  );
  const outcomes = new Map<string, IdentityPackBatchOutcome>();
  await runInBatches(characterIds, concurrency, async (characterId) => {
    outcomes.set(characterId, await prepareOneForBatch(input, characterId));
  });

  // `runInBatches` swallows a rejection, so an id missing from the map means its
  // work threw. Nothing below it should — every helper contains its own failures —
  // but the report must still account for every requested character.
  const results = characterIds.map(
    (characterId): IdentityPackBatchOutcome =>
      outcomes.get(characterId) ?? { characterId, outcome: "blocked", code: "derivation_failed", retryable: true },
  );
  return {
    ok: true,
    dryRun: input.dryRun,
    requested: characterIds.length,
    counts: countBatchOutcomes(results),
    results,
  };
}

function resolveBatchSelection(
  input: PrepareIdentityPacksBatchInput,
): { ok: true; characterIds: string[] } | Extract<PrepareIdentityPacksBatchResult, { ok: false }> {
  const corpus = input.corpusId === undefined ? undefined : IDENTITY_PACK_TRIAL_CORPORA.get(input.corpusId);
  if (input.corpusId !== undefined && corpus === undefined) {
    return { ok: false, code: "unknown_corpus", message: `no checked-in trial corpus named "${input.corpusId}"` };
  }
  const characterIds = [...new Set([...(input.characterIds ?? []), ...(corpus ?? [])])];
  if (characterIds.length === 0) {
    return { ok: false, code: "empty_selection", message: "the batch named no characters" };
  }
  const cap = Math.min(Math.max(1, Math.floor(input.maxCount ?? IDENTITY_PACK_BATCH_MAX)), IDENTITY_PACK_BATCH_MAX);
  if (characterIds.length > cap) {
    return {
      ok: false,
      code: "too_many",
      message: `${characterIds.length} characters exceeds the ${cap} allowed in one batch`,
    };
  }
  return { ok: true, characterIds };
}

async function prepareOneForBatch(
  input: PrepareIdentityPacksBatchInput,
  characterId: string,
): Promise<IdentityPackBatchOutcome> {
  const [character] = await db()
    .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, input.ownerId)))
    .limit(1);
  if (!character) return { characterId, outcome: "not_found" };

  if (input.dryRun) {
    const current = await currentPackRow(characterId);
    const upToDate =
      input.regenerate !== true &&
      current !== undefined &&
      current.status === "ready" &&
      current.sourceImageId === character.acceptedAvatarImageId &&
      current.schemaVersion === IDENTITY_PACK_SCHEMA_VERSION &&
      current.derivationVersion === IDENTITY_PACK_DERIVATION_VERSION;
    return { characterId, outcome: upToDate ? "up_to_date" : "would_prepare" };
  }

  const result = await runDerivation(
    { ownerId: input.ownerId, characterId, purpose: "admin_trial", sink: input.sink },
    { forceNewRevision: input.regenerate === true },
  );
  return result.status === "ready"
    ? { characterId, outcome: "ready", revision: result.pack.revision, warnings: result.warnings }
    : { characterId, outcome: "blocked", code: result.code, retryable: result.retryable };
}

function countBatchOutcomes(results: readonly IdentityPackBatchOutcome[]): IdentityPackBatchCounts {
  const counts: IdentityPackBatchCounts = { ready: 0, blocked: 0, notFound: 0, wouldPrepare: 0, upToDate: 0 };
  for (const result of results) {
    switch (result.outcome) {
      case "ready":
        counts.ready += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "not_found":
        counts.notFound += 1;
        break;
      case "would_prepare":
        counts.wouldPrepare += 1;
        break;
      case "up_to_date":
        counts.upToDate += 1;
        break;
    }
  }
  return counts;
}
