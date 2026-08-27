import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  DeliberationOutcome,
  DeliberatorAdmission,
  DeliberatorAdmissionInput,
  DeliberatorRequest,
} from "@vesper/simulation-core/contracts/deliberation";
import {
  CONSENT_ESCALATION_SCORE_GAP_THRESHOLD_FIXED_POINT,
  attemptConsentEscalationCommandResultSchema,
  attemptConsentEscalationCommandSchema,
  consentEscalationResolvedEventSchema,
  recordRelationshipChangeCommandResultSchema,
  recordRelationshipChangeCommandSchema,
  recordRelationshipEntryCommandResultSchema,
  recordRelationshipEntryCommandSchema,
  relationshipEntryAuthoredPayloadSchema,
  type AttemptConsentEscalationCommand,
  type AttemptConsentEscalationCommandResult,
  type RecordRelationshipChangeCommand,
  type RecordRelationshipChangeCommandResult,
  type RecordRelationshipEntryCommand,
  type RecordRelationshipEntryCommandResult,
  type RelationshipLedgerEntry,
} from "@vesper/simulation-core/contracts/social";
import { composeSimulationId } from "@vesper/simulation-core/contracts/identity";
import {
  admitDeliberator,
  buildDeliberatorRequest,
  resolveDeliberationOutcome,
} from "@vesper/simulation-core/deliberation";
import { sortedUnique } from "@vesper/simulation-core/hash";
import {
  deriveConsentEscalationCandidates,
  deriveRelationshipRead,
  resolveRecordRelationshipChangeFromView,
  resolveRecordRelationshipEntryFromView,
  type RelationshipReadWeightOverride,
} from "@vesper/simulation-core/social";
import {
  db,
  simBranches,
  simCharacters,
  simCommands,
  simEvents,
  simRelationshipLedger,
  type Db,
} from "@/server/db";
import { loadCoLocatedActorIds } from "./body-rows";
import { readEffectiveActorLod } from "./lod-store";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { InjectedSimulationCrash } from "./material-store";
import { relationshipLedgerEntryFromRow } from "./social-recorder";
import type { SimTx } from "./trigger-projector";

/** Read helpers below run BOTH unlocked (pre-transaction, for the
 * deliberator seam — see `submitDurableAttemptConsentEscalation`) and locked
 * (inside a command's `execute`) — same pattern as `body-store.ts`/
 * `space-store.ts`'s `DbExecutor`. */
type DbExecutor = Db | SimTx;

/**
 * E5.5 slice 1 durable relationship-ledger authority:
 * `record_relationship_entry` and `record_relationship_change`, the two
 * privileged authoring commands. Modeled on `household-store.ts`'s
 * `create_household`/`set_household_membership` shape — both commands are
 * event-append-only, no lazy-init, no triggers, so this store's choreography
 * is the simplest of the E5.x durable stores.
 *
 * The ledger row itself is written by `social-recorder.ts`'s
 * `recordCommandRelationshipLedger`, invoked by `command-runner.ts`'s shell
 * right after this command's event commits — NOT by this file, mirroring how
 * `knowledge-store.ts`'s `make_disclosure` never writes an assertion/belief
 * row itself. The row INSERT mapping (`relationshipLedgerEntryRowInsert`)
 * stays in `social-recorder.ts`, since only the recorder ever writes a
 * ledger row.
 *
 * Correction (Slice 3, checked against the actual import graph — the
 * original Slice 1 comment here overstated the risk): this file DOES import
 * `relationshipLedgerEntryFromRow` (the READ-side row mapper) from
 * `social-recorder.ts` below, for `attempt_consent_escalation`'s dyad-ledger
 * load. This is NOT a cycle: `social-recorder.ts` never imports this
 * file or `command-runner.ts`, so `social-store.ts → social-recorder.ts` and
 * `command-runner.ts → social-recorder.ts` are two independent one-directional
 * edges, not a cycle — verified by `pnpm lint:cycles`. `knowledge-store.ts`
 * already does exactly this (imports `assertionFromRow`/`beliefFromRow` from
 * `knowledge-recorder.ts`), confirming the pattern is safe.
 */

export type DurableRelationshipCrashPoint = "after_event_append" | "after_branch_advance" | "after_commit";

export interface RelationshipSubmitOptions {
  database?: Db;
  crashAt?: DurableRelationshipCrashPoint;
  admitAtLockedVersion?: boolean;
}

function injectCrash(
  configured: DurableRelationshipCrashPoint | undefined,
  point: Exclude<DurableRelationshipCrashPoint, "after_commit">,
): void {
  if (configured === point) throw new InjectedSimulationCrash(point);
}

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

// ---------------------------------------------------------------------------
// Authority context — just actor existence; neither slice-1 command touches
// households, means, or the ledger itself.
// ---------------------------------------------------------------------------

async function loadRelationshipActorIds(tx: DbExecutor, branchId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ characterId: simCharacters.characterId })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branchId));
  return new Set(rows.map((row) => row.characterId));
}

// ---------------------------------------------------------------------------
// record_relationship_entry
// ---------------------------------------------------------------------------

export async function submitDurableRecordRelationshipEntry(
  rawCommand: unknown,
  options: RelationshipSubmitOptions = {},
): Promise<RecordRelationshipEntryCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: recordRelationshipEntryCommandSchema,
    resultSchema: recordRelationshipEntryCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That relationship entry is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That relationship entry has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      recordRelationshipEntryCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RecordRelationshipEntryCommand) => {
      const actorIds = await loadRelationshipActorIds(tx, branch.id);
      const resolution = resolveRecordRelationshipEntryFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: (actorId) => actorIds.has(actorId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// record_relationship_change
// ---------------------------------------------------------------------------

export async function submitDurableRecordRelationshipChange(
  rawCommand: unknown,
  options: RelationshipSubmitOptions = {},
): Promise<RecordRelationshipChangeCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: recordRelationshipChangeCommandSchema,
    resultSchema: recordRelationshipChangeCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That relationship change is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That relationship change has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      recordRelationshipChangeCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RecordRelationshipChangeCommand) => {
      const actorIds = await loadRelationshipActorIds(tx, branch.id);
      const resolution = resolveRecordRelationshipChangeFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: (actorId) => actorIds.has(actorId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// attempt_consent_escalation (ruling 16) — the fail-closed deliberator
// seam. Unlike the two authoring commands above, this resolution is
// inherently ASYNC (it may await a live model call), so it has no separate
// pure `resolveXFromView` in `lib/simulation/social.ts` — the pure pieces it
// calls (`deriveRelationshipRead`, `deriveConsentEscalationCandidates`, and
// the deliberation-seam functions) stay pure; only the orchestration
// around them lives here.
// ---------------------------------------------------------------------------

/** Narrow dyad load: every ledger entry directed `fromActorId → toActorId`,
 * any kind — the utility score needs the full trust/attraction/
 * resentment read, not just consent-scoped entries. */
export async function loadDyadLedgerEntries(
  tx: DbExecutor,
  branchId: string,
  fromActorId: string,
  toActorId: string,
): Promise<RelationshipLedgerEntry[]> {
  const rows = await tx
    .select()
    .from(simRelationshipLedger)
    .where(
      and(
        eq(simRelationshipLedger.branchId, branchId),
        eq(simRelationshipLedger.fromActorId, fromActorId),
        eq(simRelationshipLedger.toActorId, toActorId),
      ),
    )
    .orderBy(asc(simRelationshipLedger.entryId));
  return rows.map(relationshipLedgerEntryFromRow);
}

/**
 * The authored-prior wiring: an `authored_prior` entry's `weightOverride` is
 * captured on its sourcing `relationship_entry_authored` event, never
 * persisted on the ledger row itself — load it back for every
 * `authored_prior` entry the dyad load surfaced. A source event with no
 * matching row (a data-integrity gap, not a live failure mode) is simply
 * omitted here; `deriveRelationshipRead` is what notices the gap and pushes
 * the `authored_prior_missing_weight` diagnostic.
 */
export async function loadAuthoredPriorWeights(
  tx: DbExecutor,
  branchId: string,
  entries: readonly RelationshipLedgerEntry[],
): Promise<RelationshipReadWeightOverride[]> {
  const authoredPriorEntries = entries.filter((entry) => entry.kind === "authored_prior");
  if (authoredPriorEntries.length === 0) return [];
  const sourceEventIds = sortedUnique(authoredPriorEntries.map((entry) => entry.sourceEventId));
  const eventRows = await tx
    .select({ id: simEvents.id, payload: simEvents.payload })
    .from(simEvents)
    .where(
      and(
        eq(simEvents.branchId, branchId),
        inArray(simEvents.id, sourceEventIds),
        eq(simEvents.type, "relationship_entry_authored"),
      ),
    );
  const weightByEventId = new Map(
    eventRows.map((row) => [row.id, relationshipEntryAuthoredPayloadSchema.parse(row.payload).weightOverride]),
  );
  return authoredPriorEntries.flatMap((entry) => {
    const weight = weightByEventId.get(entry.sourceEventId);
    return weight ? [{ entryId: entry.id, weight }] : [];
  });
}

/**
 * The ruling-16 fallback-pinning wrapper. `admitDeliberator`'s own
 * `fallbackCandidateId` is the GENERIC highest-deterministic-score
 * candidate — correct for departures, wrong here: a well-liked NPC can
 * legitimately score `grant` above `decline`, so the generic fallback
 * would resolve a model timeout/refusal/garbled response as a GRANT against
 * exactly the NPC ruling 16 says must never be silently granted. Overriding
 * `fallbackCandidateId` to `"decline"` UNCONDITIONALLY, before calling
 * `resolveDeliberationOutcome`, closes every one of that function's fallback
 * paths at once (not admitted, timeout, unparseable response, unknown
 * candidate id) — `resolveDeliberationOutcome` always prefers
 * `admission.fallbackCandidateId` when present. No change to
 * `deliberation.ts` itself: ruling 16 is a consent-specific override of its
 * generic "highest score wins" default, which stays correct everywhere else.
 */
async function resolveConsentEscalation(input: {
  candidates: [DeliberationCandidateForEscalation, DeliberationCandidateForEscalation];
  admissionInput: DeliberatorAdmissionInput;
  evidence: readonly string[];
  deliberate: (request: DeliberatorRequest) => Promise<unknown>;
  timeout?: Promise<unknown>;
}): Promise<{ granted: boolean; outcome: DeliberationOutcome }> {
  const rawAdmission = admitDeliberator(input.admissionInput);
  const admission: DeliberatorAdmission = { ...rawAdmission, fallbackCandidateId: "decline" };
  if (!admission.admitted) {
    const resolved = resolveDeliberationOutcome(admission, input.candidates, undefined);
    return { granted: false, outcome: resolved };
  }
  const request = buildDeliberatorRequest(input.candidates, input.evidence);
  let raw: unknown;
  try {
    raw =
      input.timeout === undefined
        ? await input.deliberate(request)
        : await Promise.race([input.deliberate(request), input.timeout.then(() => "timeout" as const)]);
  } catch {
    // A thrown/rejected deliberate() call is a technical failure like any
    // other — it must land on the pinned "decline" fallback, never propagate
    // (resilience.md: never fail a turn on the model boundary).
    raw = "timeout";
  }
  const resolved = resolveDeliberationOutcome(admission, input.candidates, raw);
  return { granted: resolved.chosenCandidateId === "grant", outcome: resolved };
}

/** Local alias — `deriveConsentEscalationCandidates` returns the contracts
 * `DeliberationCandidate` type; named here only to keep this file's
 * signatures readable without importing the type twice under two names. */
type DeliberationCandidateForEscalation = ReturnType<typeof deriveConsentEscalationCandidates>[number];

export interface AttemptConsentEscalationSubmitOptions {
  database?: Db;
  crashAt?: DurableRelationshipCrashPoint;
  /**
   * Caution unique to THIS command (not a general `admitAtLockedVersion`
   * concern): the relationship read and model decision below are
   * computed pre-lock, from an unlocked snapshot, and are only safe to
   * persist because the locked phase's ordinary optimistic-version check
   * (`command.expectedVersion !== branch.version`) forces a `conflict` —
   * discarding the pre-computed decision — whenever ANY command commits on
   * this branch between the pre-lock read and lock acquisition. Passing
   * `true` here defeats that backstop (the locked phase admits at whatever
   * version it finds, unconditionally), so a decision computed against a
   * stale ledger snapshot CAN commit even though the ledger changed
   * underneath it. Every other store's `admitAtLockedVersion` is safe
   * because its whole resolution runs inside the same locked transaction it
   * writes to; this one is not that shape. Reserve `true` for deterministic
   * test setup that has no concurrent writers, never for a production caller
   * that cares whether the escalation reflects the ledger as of commit time.
   */
  admitAtLockedVersion?: boolean;
  /**
   * Required, no default (decision 3, revised): the caller's own
   * player-controlled-actor set, mirroring `prepareEngagementTurn`'s
   * `playerActorIds`. A player's consent is never policy-decided —
   * making this field non-optional in TypeScript enforces "no silent
   * default" at the strongest available level: a caller literally cannot
   * omit it, closing the gap the blueprint's runtime-rejection fallback was
   * only a weaker approximation of.
   */
  playerControlledActorIds: readonly string[];
  /**
   * Required, no default: the caller's own live per-turn/session
   * model-call budget tracker (the engine owns no such tracker itself, same
   * as `prepareEngagementTurn`'s `PrepareTurnDeliberation.modelBudgetRemaining`).
   * A caller with no budget tracking yet should pass `0`, which fails
   * admission closed (`no_model_budget`) — never omit this.
   */
  modelBudgetRemaining: number;
  /** The injected model seam — a stub in every test, zero live calls shipped. */
  deliberate: (request: DeliberatorRequest) => Promise<unknown>;
  /** Settles when the caller's deadline passes; absent means no deadline. */
  timeout?: Promise<unknown>;
  /** Bounded, caller-redacted evidence lines shown to the model. */
  evidence?: readonly string[];
  /** Admission-gap policy override — defaults to the versioned
   * `CONSENT_ESCALATION_SCORE_GAP_THRESHOLD_FIXED_POINT`. */
  scoreGapThresholdFixedPoint?: number;
}

/**
 * Ruling 16: an uncovered `consent_covered` attempt routes through the
 * deliberator seam with a deterministic fallback of decline, and the
 * outcome lands back in the ledger either way — this command is that
 * escalation. Admission failing is NOT a rejection (only structural
 * problems — actor/target not found, unauthorized, player-controlled
 * target, not co-located — reject); a refused/timed-out/garbled admission
 * still ACCEPTS and records the decline outcome.
 *
 * Critical fix (Slice 3 review): the model call is resolved HERE,
 * before `runSimulationCommand` ever opens the locked branch transaction —
 * `command-runner.ts`'s own invariant for its `execute` callback is "Never
 * call a model or network under this lock," and every other model-call site
 * (`prepareEngagementTurn`'s departure deliberation, `arbiter-store.ts`)
 * resolves off-lock the same way, feeding only the already-decided outcome
 * into the locked write. The original shape awaited `deliberate()` from
 * inside `execute`, which — absent a caller-supplied `timeout` (optional) —
 * could hang the branch row lock indefinitely, blocking every other command
 * against the same branch.
 *
 * Every structural admission check (actor/target existence, authorization,
 * player-controlled target, co-location) still runs a SECOND time, under the
 * lock, inside `execute` below — unchanged from before — as the authoritative
 * check at commit time; the pre-pass below never substitutes for it. The
 * pre-pass also skips its work entirely for a command whose idempotency key
 * already has a cached result (mirrors `command-runner.ts`'s own
 * `preLockCached` fast path) — a retried command must not re-spend model
 * budget on an outcome that is already durably decided and will short-circuit
 * before `execute` ever runs again.
 */
export async function submitDurableAttemptConsentEscalation(
  rawCommand: unknown,
  options: AttemptConsentEscalationSubmitOptions,
): Promise<AttemptConsentEscalationCommandResult> {
  const parsedCommand = attemptConsentEscalationCommandSchema.safeParse(rawCommand);
  let escalation: { granted: boolean; outcome: DeliberationOutcome } | undefined;
  if (parsedCommand.success && !options.playerControlledActorIds.includes(parsedCommand.data.payload.targetActorId)) {
    const database = options.database ?? db();
    const { branchId, idempotencyKey } = parsedCommand.data;
    const { actorId, targetActorId } = parsedCommand.data.payload;
    const [cached] = await database
      .select({ result: simCommands.result })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, branchId), eq(simCommands.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (!cached) {
      const [branchRow] = await database
        .select({ storySecond: simBranches.storySecond })
        .from(simBranches)
        .where(eq(simBranches.id, branchId))
        .limit(1);
      const atStorySecond = branchRow?.storySecond ?? 0;

      // The score must reflect how much the TARGET trusts/is-
      // attracted-to/resents the ACTOR — the target is the one deciding.
      // `deriveRelationshipRead`'s own directional filter keeps only
      // entries where `fromActorId === aboutActorId(actorId) && toActorId
      // === subjectActorId(targetActorId)` — i.e. entries directed ACTOR →
      // TARGET (evidence of the actor's conduct toward the target). The load
      // below must supply exactly that direction, not the reverse — loading
      // the reverse direction silently starves the read to zero entries
      // (caught by an integration test exercising a real `authored_prior`
      // override; the read's own re-applied filter would otherwise mask a
      // direction mistake here as "no evidence" rather than a loud failure).
      const entries = await loadDyadLedgerEntries(database, branchId, actorId, targetActorId);
      const authoredPriorWeights = await loadAuthoredPriorWeights(database, branchId, entries);
      const read = deriveRelationshipRead({
        entries,
        subjectActorId: targetActorId,
        aboutActorId: actorId,
        atStorySecond,
        authoredPriorWeights,
      });
      const candidates = deriveConsentEscalationCandidates(read);

      // E6.1: the deciding TARGET's real per-actor inference LOD —
      // unassigned actors read the registry default (deliberator), which is
      // exactly what this call site hardcoded before the ledger existed. An
      // unlocked read, like everything else in this pre-lock pass.
      const targetLod = await readEffectiveActorLod(database, branchId, targetActorId);

      const resolved = await resolveConsentEscalation({
        candidates,
        admissionInput: {
          actorId: targetActorId,
          inferenceLod: targetLod.inferenceLod,
          candidates,
          scoreGapThresholdFixedPoint:
            options.scoreGapThresholdFixedPoint ?? CONSENT_ESCALATION_SCORE_GAP_THRESHOLD_FIXED_POINT,
          consequential: true,
          modelBudgetRemaining: options.modelBudgetRemaining,
          hasDeterministicFallback: true,
        },
        evidence: options.evidence ?? [],
        deliberate: options.deliberate,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      });
      // `read.diagnostics` (e.g. `authored_prior_missing_weight:<id>`)
      // is a data-integrity gap worth surfacing, not a silent no-op — merge it
      // into the persisted outcome so a missing authored_prior weight is
      // visible on the very event whose decision it degraded, not dropped on
      // the floor between `deriveRelationshipRead` and the ledger.
      escalation =
        read.diagnostics.length === 0
          ? resolved
          : {
              ...resolved,
              outcome: {
                ...resolved.outcome,
                diagnostics: [...resolved.outcome.diagnostics, ...read.diagnostics],
              },
            };
    }
  }

  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: attemptConsentEscalationCommandSchema,
    resultSchema: attemptConsentEscalationCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That escalation attempt is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That escalation attempt has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      attemptConsentEscalationCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: AttemptConsentEscalationCommand) => {
      const { actorId, targetActorId, scopeKey } = command.payload;

      const actorIds = await loadRelationshipActorIds(tx, branch.id);
      if (!actorIds.has(actorId)) {
        return rejectedResult(command.id, "actor_not_found", "That actor is unavailable.");
      }
      const principal = command.principal;
      const controlsActor =
        (principal.kind === "player" || principal.kind === "npc_policy" || principal.kind === "npc_deliberator") &&
        principal.controlledActorIds.includes(actorId);
      if (!controlsActor) {
        return rejectedResult(command.id, "unauthorized_actor", "You cannot attempt that.");
      }
      if (!actorIds.has(targetActorId)) {
        return rejectedResult(command.id, "target_not_found", "That person is unavailable.");
      }
      if (options.playerControlledActorIds.includes(targetActorId)) {
        return rejectedResult(
          command.id,
          "target_is_player_controlled",
          "That is not something you can decide for them.",
        );
      }
      const coLocatedActorIds = await loadCoLocatedActorIds(tx, branch.id, actorId);
      if (!coLocatedActorIds.includes(targetActorId)) {
        return rejectedResult(command.id, "actors_not_co_located", "They are not here for that.");
      }

      // Every structural check above passed, and `target_is_player_controlled`
      // is the exact same static check the pre-lock pass above used to decide
      // whether to compute `escalation` — so `escalation` is guaranteed
      // defined here (the only way to reach this line with it undefined would
      // require the two checks to disagree, which they structurally cannot:
      // both read the same caller-supplied `options.playerControlledActorIds`
      // array against the same `targetActorId`). This never awaits a model
      // call — it is either the precomputed outcome, or, for the
      // structurally-unreachable case TypeScript's narrowing still requires a
      // guard for, a defensive throw (same shape as the `resolution.ok`
      // narrowing guard in `engagement-store.ts`'s
      // `submitDurableAcknowledgePressure`).
      if (!escalation) {
        throw new Error("attempt_consent_escalation resolved accepted without a pre-computed outcome");
      }
      const { granted, outcome } = escalation;

      const event = consentEscalationResolvedEventSchema.parse({
        id: composeSimulationId("event", [branch.id, command.id, "consent-escalation-resolved"]),
        worldId: branch.worldId,
        branchId: branch.id,
        sequence: branch.headSequence + 1,
        storySecond: branch.storySecond,
        type: "consent_escalation_resolved",
        schemaVersion: 1,
        rulesetVersion: branch.rulesetVersion,
        commandId: command.id,
        correlationId: command.correlationId,
        actorIds: sortedUnique([actorId, targetActorId]),
        entityIds: sortedUnique([actorId, targetActorId]),
        recordedAtWallClock: command.submittedAtWallClock,
        payload: { actorId, targetActorId, scopeKey, granted, outcome },
      });

      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}
