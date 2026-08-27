import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import type {
  EnsureIdentityPackInput,
  EnsureIdentityPackResult,
  ImageIdentityPackFailureCode,
  ImageIdentityPackV1,
  SourceDimensions,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { characters, db, images } from "../db";
import { log } from "@/server/log";
// Direct module path, NOT the `@/server/engine` barrel: that barrel re-exports
// `chat-pipeline.ts`, which imports `@/server/images` — so importing it here
// would close a real import cycle and fail `pnpm lint:cycles`. `keyed-lock.ts`
// itself imports nothing at all, so naming it directly adds no edge to the graph.
// (Worth relocating the lock to a neutral server home if a second image lane
// ever needs it.)
import { acquireKeyedLockWithin } from "../engine/keyed-lock";
import { readImageBytes, SHARP_DECODE_LIMITS } from "./assets";
import { deriveRevision } from "./identity-pack-derive";
import {
  abandonRevision,
  finalizeRevision,
  mayFinalizeReservation,
  reservePendingRevision,
} from "./identity-pack-promotion";
import {
  coversSource,
  currentPackRow,
  errorMessage,
  identityPackLockKey,
  type IdentityPackRow,
  isLiveReservation,
  isRetryableIdentityPackFailure,
  MAX_RETRY_ATTEMPTS,
  packRowToContract,
  previousAttemptCount,
  projectIdentityPackPolicy,
  type ResolvedSource,
  retryBackoffMs,
  sourceContentHashOf,
} from "./identity-pack-store";

/**
 * `ensureIdentityPack`: the idempotent, authorization-aware entry every render,
 * status view and admin batch goes through.
 *
 * The service-wide invariants this flow rests on are documented in
 * `./identity-pack-store.ts`; the two compare-and-set halves it drives are in
 * `./identity-pack-promotion.ts` and the work between them in
 * `./identity-pack-derive.ts`.
 */

/* ------------------------------------------------------------------------ *
 * ensureIdentityPack                                                        *
 * ------------------------------------------------------------------------ */

/** How long a matching caller waits for the in-flight derivation to finish. */
export const LOCK_TIMEOUT_MS = 30_000;

/** Poll interval while queueing behind the holder; derivation is seconds, not minutes. */
export const LOCK_POLL_MS = 50;

/**
 * Poll interval while waiting on ANOTHER PROCESS's reservation.
 *
 * Five times the in-process figure on purpose: that one polls a `Map`, this one
 * polls Postgres. A join is expected to last as long as somebody else's detector
 * and two sharp passes — seconds — so a quarter-second granularity costs a
 * waiting render nothing perceptible and costs the database a couple of dozen
 * indexed single-row reads instead of six hundred.
 */
const RESERVATION_POLL_MS = 250;

/**
 * How long a joining caller waits for another process's reservation to settle.
 *
 * Deliberately its OWN budget, well under {@link LOCK_TIMEOUT_MS}: the join runs
 * inside the in-process keyed lock, so every second spent here is a second other
 * local callers of the same character queue behind. Derivation is bounded local
 * work of seconds — a detector pass and two sharp passes — so five covers a slow
 * machine with room to spare, and a reservation that outlives it is either
 * wedged or pathological, which the caller reports (or, for a forced
 * re-derivation, reclaims) rather than waits out.
 */
export const RESERVATION_JOIN_MS = 5_000;

type ResolveSourceResult = { ok: true; source: ResolvedSource } | { ok: false; code: ImageIdentityPackFailureCode };

/**
 * Idempotent, authorization-aware pack preparation.
 *
 * The flow, and why each step exists:
 *
 * 1–2. Resolve the character from the OWNER (never from a pack or image id — a
 *      client-supplied pack id is a concurrency guard, not authorization), then
 *      read and hash the canonical portrait's stored bytes.
 * 3–4. Serialize on the character key, then answer from the current revision
 *      when it already covers these bytes and versions: a ready pack is
 *      returned as-is, a terminal refusal is returned WITHOUT a new attempt, and
 *      a retryable one waits out its backoff. This is what stops an unusable
 *      portrait from re-deriving on every render.
 * 5.   Coalesce with another process's live reservation for the same bytes rather
 *      than opening a second one: a waiting caller polls it to completion and
 *      answers from its result, a background caller declines promptly. Neither
 *      retires it, and neither starts the same derivation twice.
 * 6–7. Otherwise reserve a new current `pending` revision in a compare-and-set
 *      transaction that retires the previous one, then derive OUTSIDE that
 *      transaction — a detector and two sharp passes have no business holding a
 *      row lock.
 * 8–9. Finalize only if the character still names the same source AND the bytes
 *      still hash the same AND this revision is still the current pending one.
 *      Losing that race marks the revision stale and hard-deletes its hidden
 *      crop, because a crop nothing can point at is not evidence, it is litter.
 */
export async function ensureIdentityPack(input: EnsureIdentityPackInput): Promise<EnsureIdentityPackResult> {
  return runDerivation(input, { forceNewRevision: false });
}

interface DerivationOptions {
  /**
   * Skip the "is there already an answer?" step and always open a new revision.
   *
   * Only two callers want this, and both are explicit human acts: reset-to-automatic
   * (the owner discarded their manual crop) and an admin batch's `regenerate`. Every
   * other caller must NOT set it — re-deriving an unchanged source on every request is
   * exactly what the current-revision check exists to prevent.
   */
  forceNewRevision: boolean;
  /**
   * Skip the in-process keyed lock. Set ONLY by
   * {@link deriveIdentityPackWithoutProcessLockForTesting}, whose comment explains
   * why a single test process cannot otherwise reach the cross-process paths at
   * all. It bypasses an optimization, never a correctness guard — everything below
   * it (the advisory lock, both compare-and-set halves, the partial unique index)
   * is exactly what production runs.
   */
  withoutProcessLock?: boolean;
}

export async function runDerivation(input: EnsureIdentityPackInput, opts: DerivationOptions): Promise<EnsureIdentityPackResult> {
  const { ownerId, characterId, sink } = input;
  try {
    const resolved = await resolveSource(ownerId, characterId, sink);
    if (!resolved.ok) {
      return { status: "blocked", pack: null, code: resolved.code, retryable: isRetryableIdentityPackFailure(resolved.code) };
    }

    if (opts.withoutProcessLock === true) return await derivePackUnderLock(input, resolved.source, opts);

    const acquired = await acquireKeyedLockWithin(
      identityPackLockKey(characterId),
      () => derivePackUnderLock(input, resolved.source, opts),
      { timeoutMs: LOCK_TIMEOUT_MS, pollMs: LOCK_POLL_MS, label: input.purpose },
    );
    if (!acquired) {
      sink?.push(
        diag("warn", "images.identity_pack.pending_conflict", "another derivation held this character past the wait window", {
          context: { characterId, purpose: input.purpose },
        }),
      );
      return { status: "blocked", pack: null, code: "derivation_failed", retryable: true };
    }
    return await acquired.held;
  } catch (err) {
    // Containment boundary: nothing about a face crop may throw into a render
    // route or a portrait save — a failure degrades to a diagnostic instead.
    log.warn("images", "identity pack preparation threw", {
      characterId,
      ownerId,
      error: errorMessage(err).slice(0, 300),
    });
    return { status: "blocked", pack: null, code: "derivation_failed", retryable: true };
  }
}

/**
 * Test-only: {@link ensureIdentityPack} with the in-process keyed lock skipped.
 * Production never calls it.
 *
 * The seam exists because the lock is what makes the cross-process guarantees
 * untestable from one process. Every concurrent `ensureIdentityPack` in a suite is
 * serialized on the character key before it reaches the database, so a
 * `Promise.all` over them proves the lock works and says exactly nothing about what
 * two Fly machines do to one character's current row. This entry is the second
 * machine.
 *
 * Deliberately the WHOLE per-character flow — answer-or-reserve, derive, finalize —
 * rather than a handle on the reservation transaction. A test that could reserve
 * without deriving could manufacture states the service itself can never reach, and
 * would then be pinning fiction; this one can only produce sequences a real second
 * process could produce. Nothing below it is weakened: the advisory lock inside
 * both promotion transactions, the re-hash before finalize, and the partial unique
 * index on `current` are the guards that actually hold the invariant, and all three
 * still run.
 */
export async function deriveIdentityPackWithoutProcessLockForTesting(
  input: EnsureIdentityPackInput,
): Promise<EnsureIdentityPackResult> {
  return runDerivation(input, { forceNewRevision: false, withoutProcessLock: true });
}

/**
 * The canonical source, verified end to end: the character is the caller's, the
 * image row is theirs AND belongs to this character, it is `ready`, its bytes
 * are readable, and it decodes to real dimensions.
 *
 * The entity check matters more than it looks. `entity_kind`/`entity_id` are the
 * only link between an image row and the character it depicts, and every writer
 * of `characters.avatar_image_id` maintains it — so a pointer that disagrees is
 * corruption, and deriving a face from it would attach one character's face to
 * another's pack. It fails closed as `source_missing`.
 */
export async function resolveSource(
  ownerId: string,
  characterId: string,
  sink: DiagnosticSink | undefined,
): Promise<ResolveSourceResult> {
  const [character] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  const avatarImageId = character?.avatarImageId ?? null;
  if (avatarImageId === null) {
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "no canonical portrait for this character", {
        context: { characterId },
      }),
    );
    return { ok: false, code: "source_missing" };
  }

  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, avatarImageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.entityKind !== "character" || row.entityId !== characterId) {
    sink?.push(
      diag("warn", "images.identity_pack.source_missing", "canonical portrait row is missing or not this character's", {
        context: { characterId, sourceImageId: avatarImageId },
      }),
    );
    return { ok: false, code: "source_missing" };
  }
  if (row.status !== "ready") return { ok: false, code: "source_not_ready" };

  const buffer = await readImageBytes(row);
  if (!buffer) return { ok: false, code: "source_unreadable" };
  const dimensions = await decodeDimensions(buffer);
  if (!dimensions) return { ok: false, code: "source_unreadable" };

  return { ok: true, source: { imageRow: row, buffer, contentHash: sourceContentHashOf(buffer), dimensions } };
}

async function decodeDimensions(buffer: Buffer): Promise<SourceDimensions | null> {
  try {
    const { width, height } = await sharp(buffer, SHARP_DECODE_LIMITS).metadata();
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Everything from "is there already an answer?" to "finalize", with the
 * character key held.
 *
 * In-process this is the single flight: matching callers queue on the key and
 * the second one finds the first's committed `ready` revision instead of
 * deriving the same crop again. Across processes the database is the authority —
 * the partial unique index on `current` and the compare-and-set inside both
 * transactions — because an in-process lock on one Fly machine proves nothing
 * about another.
 *
 * Which is why a pass can end in something that is neither an answer nor a
 * mandate to derive: ANOTHER machine's live reservation for these exact bytes.
 * Racing it means two detector runs, two crops, two revisions, and one of the two
 * losing its finalize compare-and-set and having its crop deleted — all to produce
 * a rectangle the other process was already producing. So the caller joins it
 * instead: it waits outside every transaction and answers from whatever that
 * reservation settles on.
 *
 * At most two passes. If the re-entry meets a live reservation AGAIN, this
 * character's current row is churning faster than a waiter can join it, and a
 * bounded refusal the caller can retry beats a loop that might not terminate.
 */
async function derivePackUnderLock(
  input: EnsureIdentityPackInput,
  source: ResolvedSource,
  opts: DerivationOptions,
): Promise<EnsureIdentityPackResult> {
  const first = await derivationPass(input, source, opts, null);
  if (first.kind === "result") return first.result;

  const joined = await joinInFlightReservation(first.row, input, source, opts);
  if (joined.kind === "result") return joined.result;

  const second = await derivationPass(input, source, opts, joined.reclaimPackId);
  if (second.kind === "result") return second.result;
  return pendingConflictResult(second.row, input, "a second reservation took this character while the first was joined");
}

type PassOutcome =
  | { kind: "result"; result: EnsureIdentityPackResult }
  /** Someone else's live reservation for these bytes — join it, do not derive. */
  | { kind: "in_flight"; row: IdentityPackRow };

/**
 * One trip through the flow: answer from the current revision if it settles this
 * caller, otherwise reserve, derive and finalize.
 *
 * The `in_flight` outcome is discovered in two places, and both matter. The
 * pre-reserve read of the current row is the cheap one, and it catches the common
 * case for free. The reserve transaction's own refusal to retire a live
 * reservation is the CORRECT one: it is the only read of the current row taken
 * under the advisory lock, so it is the only one that can see a reservation
 * inserted after the read above it — which is exactly the interleaving that used
 * to produce two derivations of one portrait.
 */
async function derivationPass(
  input: EnsureIdentityPackInput,
  source: ResolvedSource,
  opts: DerivationOptions,
  reclaimPackId: string | null,
): Promise<PassOutcome> {
  const { ownerId, characterId, sink } = input;
  const current = opts.forceNewRevision ? undefined : await currentPackRow(characterId);

  if (current && coversSource(current, source)) {
    const pack = packRowToContract(current, sink);
    // A row whose stored JSON did not parse reads as `unusable` regardless of its
    // column status. When those disagree the row is wreckage, not an answer:
    // fall through and derive a clean revision.
    if (pack.status === current.status) {
      const settled = await answerFromCurrent(current, pack, sink);
      if (settled.kind === "answer") return { kind: "result", result: settled.result };
      if (settled.kind === "in_flight") return { kind: "in_flight", row: settled.row };
    }
  }

  const reserved = await reservePendingRevision({ ownerId, characterId, source, sink, reclaimPackId });
  if (!reserved.ok) {
    if (reserved.kind === "in_flight") return { kind: "in_flight", row: reserved.row };
    return {
      kind: "result",
      result: {
        status: "blocked",
        pack: null,
        code: reserved.code,
        retryable: isRetryableIdentityPackFailure(reserved.code),
      },
    };
  }

  const patch = await deriveRevision({ ownerId, characterId, packId: reserved.row.id, source, sink });
  if (!mayFinalizeReservation(patch, { characterId, packId: reserved.row.id }, sink)) {
    return { kind: "result", result: { status: "blocked", pack: null, code: "derivation_failed", retryable: false } };
  }

  const finalized = await finalizeRevision({ packId: reserved.row.id, characterId, ownerId, source, patch });
  if (!finalized) {
    await abandonRevision(reserved.row.id, ownerId, patch.faceCropImageId);
    sink?.push(
      diag("warn", "images.identity_pack.finalize_race", "the canonical source moved while this revision was deriving", {
        context: { characterId, packId: reserved.row.id, sourceImageId: source.imageRow.id },
      }),
    );
    return { kind: "result", result: { status: "blocked", pack: null, code: "source_changed", retryable: true } };
  }

  const pack = packRowToContract(finalized, sink);
  if (patch.status === "ready") return { kind: "result", result: { status: "ready", pack, warnings: patch.warningCodes } };
  const code = patch.failureCode ?? "derivation_failed";
  return { kind: "result", result: { status: "blocked", pack, code, retryable: isRetryableIdentityPackFailure(code) } };
}

type JoinOutcome =
  | { kind: "result"; result: EnsureIdentityPackResult }
  /**
   * Take the flow again. `reclaimPackId` is leave to retire ONE named reservation
   * — the row this caller actually waited out — and `null` is no leave at all.
   */
  | { kind: "reenter"; reclaimPackId: string | null };

/**
 * Wait out another process's reservation for these exact bytes, then answer from
 * what it settled on.
 *
 * The ONE implementation of "join an in-flight reservation", reached from both
 * ways one is discovered — the pre-reserve read and the reservation transaction's
 * own decision. Two entrances, one behavior, because a waiting render and a
 * reservation refused inside the advisory lock are the same situation observed a
 * few milliseconds apart, and two copies of this policy would eventually disagree
 * about how long a caller waits or what it is told when it gives up.
 *
 * `background` does not wait, by ruling rather than by accident: its caller is a
 * queued job with nobody in front of it, and blocking a job slot for the length of
 * somebody else's derivation buys nothing that the next pass does not get for
 * free. It gets the refusal it always got — and, the part that is new, it does not
 * start a duplicate derivation on the way to it. (Making the background job
 * converge onto the reservation's result is separate work.)
 *
 * The wait holds no DATABASE transaction. It is a poll of the current row,
 * because a transaction held open across another machine's detector run would
 * trade a duplicate crop for a held row lock, which is the worse of the two
 * failures by a wide margin. It DOES hold the in-process character key for its
 * duration — local callers of the same character queue behind a join — which is
 * why the join budget is a fraction of the acquisition window rather than equal
 * to it.
 *
 * A join that times out means the reservation outlived a bound generous enough
 * for any real derivation. An ordinary caller reports it and retries later; a
 * caller that FORCED a new revision (reset-to-automatic, an admin regenerate)
 * re-enters with leave to reclaim the reservation instead. That is the one
 * deliberate exception to "never retire a live matching reservation": an
 * explicit human act to regenerate is the operator's escape hatch from a wedged
 * row, and without it a reservation orphaned by a deploy would dead-end the
 * reset button until the fifteen-minute staleness bound elapsed. A remote
 * derivation slower than the join budget can lose to it; its finalize
 * compare-and-set refuses the write and its crop is cleaned, exactly as when the
 * source moves on.
 *
 * That leave names the joined row and only it, never "whatever is current when I
 * get back". Two forced callers can wait out the SAME wedged reservation and time
 * out together; once the first has replaced it, the second is looking at a live
 * reservation a process opened seconds ago, not at the wedged row it waited for.
 * Retiring that one would be the exact clobber this whole wait exists to prevent,
 * so a replacement is joined or reported busy like any other.
 */
async function joinInFlightReservation(
  row: IdentityPackRow,
  input: EnsureIdentityPackInput,
  source: ResolvedSource,
  opts: DerivationOptions,
): Promise<JoinOutcome> {
  if (!waitsForReservation(input.purpose)) {
    const message = "another process holds a pending revision for this source";
    return { kind: "result", result: pendingConflictResult(row, input, message) };
  }

  const settled = await awaitReservationSettled(row, input.characterId);
  if (!settled.ok) {
    if (opts.forceNewRevision) return { kind: "reenter", reclaimPackId: row.id };
    const message = "the in-flight reservation did not settle within the wait window";
    return { kind: "result", result: pendingConflictResult(row, input, message) };
  }

  // A caller that demanded a NEW revision (reset-to-automatic, an admin
  // regenerate) still had to wait — clobbering a live derivation is the whole
  // thing this change exists to stop — but the revision that derivation produced
  // is precisely what it was asked to replace, so it re-enters rather than
  // answering from it.
  const observed = settled.row;
  if (!opts.forceNewRevision && observed && coversSource(observed, source)) {
    const pack = packRowToContract(observed, input.sink);
    if (pack.status === observed.status) {
      const answer = await answerFromCurrent(observed, pack, input.sink);
      // Anything other than a settled answer — including a row that settled into
      // yet another reservation — falls to the single re-entry below.
      if (answer.kind === "answer") return { kind: "result", result: answer.result };
    }
  }
  // A settled join carries no leave: the row it waited on is gone, and whatever
  // stands in its place is either an answer (above) or somebody else's live work.
  return { kind: "reenter", reclaimPackId: null };
}

/**
 * Whether this caller waits out another process's reservation or declines
 * promptly. A person is on the other end of the two waiting purposes; a job row is
 * on the other end of the third.
 */
function waitsForReservation(purpose: EnsureIdentityPackInput["purpose"]): boolean {
  switch (purpose) {
    case "identity_render":
    case "admin_trial":
      return true;
    case "background":
      return false;
  }
}

type ReservationSettlement = { ok: true; row: IdentityPackRow | undefined } | { ok: false };

/**
 * Poll until `row` is no longer this character's pending reservation — it
 * finalized in place (`pending` → ready/unusable/failed, the same row id), or
 * something retired and replaced it, or the character has no current revision at
 * all. `{ ok: false }` means the window elapsed first.
 *
 * The bound is {@link RESERVATION_JOIN_MS} — see that constant for why it must
 * stay well under the in-process acquisition window rather than sharing it.
 */
async function awaitReservationSettled(row: IdentityPackRow, characterId: string): Promise<ReservationSettlement> {
  const deadline = Date.now() + RESERVATION_JOIN_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, RESERVATION_POLL_MS));
    const observed = await currentPackRow(characterId);
    if (observed === undefined || observed.id !== row.id || observed.status !== "pending") {
      return { ok: true, row: observed };
    }
    if (Date.now() >= deadline) return { ok: false };
  }
}

/**
 * What a caller is told when it will not, or can no longer, wait out another
 * process's reservation.
 *
 * `derivation_failed` + retryable rather than a code about the source, because
 * nothing is wrong with the source: the answer exists or is about to, one commit
 * away, and the very next request reads it. The diagnostic is the stable
 * `pending_conflict` the spec names, and it carries the reservation's identity so
 * an operator can see WHICH revision the caller was queued behind.
 */
function pendingConflictResult(
  row: IdentityPackRow,
  input: EnsureIdentityPackInput,
  message: string,
): EnsureIdentityPackResult {
  input.sink?.push(
    diag("warn", "images.identity_pack.pending_conflict", message, {
      context: { characterId: row.characterId, packId: row.id, revision: row.revision, purpose: input.purpose },
    }),
  );
  return { status: "blocked", pack: packRowToContract(row, input.sink), code: "derivation_failed", retryable: true };
}

/**
 * What the current revision can tell this caller.
 *
 * Three outcomes rather than "an answer or null", because "another process is
 * deriving these exact bytes right now" is neither. It is not an answer — there is
 * nothing yet to return — and it is not grounds to derive, which would duplicate
 * the work and race for the same current row. Naming it makes the caller confront
 * it; folding it into either neighbour is how it got mishandled before.
 */
type CurrentAnswer =
  | { kind: "answer"; result: EnsureIdentityPackResult }
  /** A live reservation belonging to another process. Join it; never race it. */
  | { kind: "in_flight"; row: IdentityPackRow }
  /** Nothing on record settles this caller. Reserve and derive. */
  | { kind: "derive" };

/**
 * The answer already on record, someone else's live reservation, or a mandate to
 * derive.
 *
 * The `unusable`/`failed` arm is the no-retry-condition rule: nothing about the
 * input changed, so a terminal code is returned unchanged and a retryable one
 * only earns a new revision once its backoff has elapsed and the attempt cap is
 * not spent.
 */
async function answerFromCurrent(
  row: IdentityPackRow,
  pack: ImageIdentityPackV1,
  sink: DiagnosticSink | undefined,
): Promise<CurrentAnswer> {
  switch (row.status) {
    case "ready": {
      // The stored verdict is not the answer — the CURRENT policy's reading of
      // the stored measurements is. A revision judged under an older policy can
      // be refused here without its row being touched, and the refusal is
      // terminal: nothing about this source or this crop will change it.
      const projected = projectIdentityPackPolicy(pack, sink);
      if (projected.blockedBy === null) {
        return { kind: "answer", result: { status: "ready", pack: projected.pack, warnings: projected.pack.warningCodes } };
      }
      return {
        kind: "answer",
        result: {
          status: "blocked",
          pack: projected.pack,
          code: projected.blockedBy,
          retryable: isRetryableIdentityPackFailure(projected.blockedBy),
        },
      };
    }
    case "pending":
      // The caller holds the in-process key, so this reservation belongs to
      // another process. Only the database can arbitrate; do not race it — UNLESS
      // it is older than the job staleness bound, in which case its process is
      // gone (a deploy replaces the machine mid-derivation) and honouring it
      // forever would wedge this character's pack permanently.
      return isLiveReservation(row) ? { kind: "in_flight", row } : { kind: "derive" };
    case "unusable":
    case "failed": {
      const blocked = (retryable: boolean, code: ImageIdentityPackFailureCode): CurrentAnswer => ({
        kind: "answer",
        result: { status: "blocked", pack, code, retryable },
      });
      const code = pack.failureCode ?? "derivation_failed";
      if (!isRetryableIdentityPackFailure(code)) return blocked(false, code);
      const attempts = await previousAttemptCount(row.characterId, row.sourceContentHash);
      if (attempts >= MAX_RETRY_ATTEMPTS) return blocked(false, code);
      const waited = Date.now() - row.updatedAt.getTime();
      if (waited < retryBackoffMs(attempts)) return blocked(true, code);
      return { kind: "derive" };
    }
    case "stale":
    case "superseded":
      // Terminal statuses cannot legally be current; fall through so the reserve
      // step reports the inconsistency rather than papering over it.
      return { kind: "derive" };
  }
}
