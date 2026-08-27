import type { SimulationBranchEvent } from "../contracts/branching";
import type { DeliberationCandidate } from "../contracts/deliberation";
import { composeSimulationId } from "../contracts/identity";
import type { SpeechActType } from "../contracts/narrative";
import {
  RELATIONSHIP_AXIS_HALF_LIFE_SECONDS,
  attractionBandKeys,
  relationshipChangeRecordedEventSchema,
  relationshipEntryAuthoredEventSchema,
  relationshipLedgerEntrySchema,
  relationshipLedgerKindPayloadKind,
  relationshipLedgerWeightRegistryV1,
  relationshipReadSchema,
  resentmentBandKeys,
  socialDerivationVersion,
  trustBandKeys,
  type ConsentScopeKey,
  type RecordRelationshipChangeCommand,
  type RecordRelationshipChangeRejectionCode,
  type RecordRelationshipEntryCommand,
  type RecordRelationshipEntryRejectionCode,
  type RelationshipChangeRecordedEvent,
  type RelationshipEntryAuthoredEvent,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
  type RelationshipLedgerPayload,
  type RelationshipLedgerWeight,
  type RelationshipRead,
} from "../contracts/social";
import { EXP2_SCALE, exp2NegativeFixedPoint } from "./bodies";
import { sortedUnique } from "./hash";

/**
 * E5.5 — the pure social-ledger kernel: the derived-and-authored ledger
 * fold, the trust/attraction/resentment read, and the consent-coverage gate.
 * No IO, no clock, no ambient randomness.
 *
 * Slice 1 folded `speech_act_delivered`, `disclosure_made`, `engagement_ended`,
 * `relationship_entry_authored`, and `relationship_change_recorded`. Slice 2
 * (§4.2, §10) added the `activity_started`/`consentGrant` arm and the
 * `commitment_kept`/`commitment_missed`/`commitment_created` arms — all three
 * real, `commitmentById` genuinely wired by every caller (`social-recorder.ts`'s
 * incremental recorder and `branch-store.ts`'s fork replay both resolve it
 * from a real commitments load, never a stub). Slice 3 (§4.7, §5.6) closes
 * the loop: `deriveConsentEscalationCandidates` scores the bounded
 * grant/decline pair the §19.3 deliberator seam chooses between, and the
 * `consent_escalation_resolved` fold arm below lands the outcome back in the
 * ledger either way (ruling 16).
 */

// ---------------------------------------------------------------------------
// Ledger entry id (§4.2) — length-prefixed composition, deterministic, replay-stable
// ---------------------------------------------------------------------------

/**
 * Deterministic ledger-entry id: `(sourceEventId, kind, fromActorId,
 * toActorId)` uniquely names one derived/authored fact.
 *
 * Deviation from the blueprint's literal 3-part `(sourceEventId, kind,
 * toActorId)` formula: that formula collides for `engagement_ended`'s
 * pairwise fan-out whenever 3+ actors share a scene. Participants A, B, C fan
 * out to pairs (A,B)/(A,C)/(B,C) — (A,C) and (B,C) both name `toActorId = C`
 * under the same causing event and the same `shared_scene` kind, so the
 * 3-part id would mint the SAME id for two distinct entries, violating the
 * `(branch_id, entry_id)` primary key (and the fork-parity hash test's
 * "byte-identical by id" assertion).
 *
 * NOT hash-compacted — `composeSimulationId` is raw length-prefixed
 * concatenation, so this id nests `sourceEventId` (itself composed from
 * `branchId`/`commandId`/a suffix, up to 1024 chars) plus `kind` and two
 * actor ids. `relationshipLedgerEntryIdSchema` is therefore declared at the
 * `observationIdentitySchema` (2048-char) tier, not the 256-char compact
 * tier — the same choice `assertionIdSchema`/`beliefIdSchema`/
 * `softCanonEntryIdSchema` make for the identical sourceEventId-composing
 * shape (identity.ts).
 */
export function deriveRelationshipLedgerEntryId(
  sourceEventId: string,
  kind: RelationshipLedgerKind,
  fromActorId: string,
  toActorId: string,
): string {
  return composeSimulationId("relationship-entry", [sourceEventId, kind, fromActorId, toActorId]);
}

// ---------------------------------------------------------------------------
// Ledger fold (§4.2) — one entry per causing fact, pure, total
// ---------------------------------------------------------------------------

export interface DeriveLedgerEntriesInput {
  /** Events to fold — a slice (this command's new events), or the whole
   * branch (fork replay, §6) — the fold is total and stateless either way. */
  events: readonly SimulationBranchEvent[];
  /** Commitment rows resolved for `commitment_kept`/`commitment_missed`/
   * `commitment_created` events — narrowly loaded by the store (§5.7), never
   * the whole projection. */
  commitmentById: (commitmentId: string) => { kind: string; promisedToActorId?: string } | undefined;
}

/** Exhaustive speech-act → ledger-kind mapping; `null` marks acts that carry
 * no relationship evidence (§4.2's widened 10-member table). */
function speechActLedgerKind(effectType: SpeechActType): RelationshipLedgerKind | null {
  switch (effectType) {
    case "promise_offered":
      return "promise_made";
    case "promise_accepted":
      return "promise_accepted";
    case "boundary_expressed":
      return "boundary_stated";
    case "warning_communicated":
      return "warning_given";
    case "invitation_spoken":
      return "invitation_extended";
    case "apology_delivered":
      return "apology_offered";
    case "disclosure_made":
      return "confidence_shared";
    case "permission_granted":
      return "permission_granted";
    case "permission_withdrawn":
      return "permission_withdrawn";
    case "question_asked":
      return null;
  }
}

function pushEntry(
  entries: RelationshipLedgerEntry[],
  event: SimulationBranchEvent,
  kind: RelationshipLedgerKind,
  fromActorId: string,
  toActorId: string,
  payload: RelationshipLedgerPayload,
  options?: { storySecond?: number; detail?: string; provenance?: "derived" | "authored" },
): void {
  if (fromActorId === toActorId) return;
  entries.push(
    relationshipLedgerEntrySchema.parse({
      id: deriveRelationshipLedgerEntryId(event.id, kind, fromActorId, toActorId),
      branchId: event.branchId,
      kind,
      fromActorId,
      toActorId,
      provenance: options?.provenance ?? "derived",
      payload,
      ...(options?.detail === undefined ? {} : { detail: options.detail }),
      sourceEventId: event.id,
      sequence: event.sequence,
      storySecond: options?.storySecond ?? event.storySecond,
      derivationVersion: socialDerivationVersion,
    }),
  );
}

/**
 * The §21.3 ledger fold: derives typed, directional, causally-provenanced
 * entries from events already in the branch's history, plus a verbatim mirror
 * of every `relationship_entry_authored`/`relationship_change_recorded`
 * event. An if-chain, not an exhaustive switch (mirrors the deleted
 * `deriveRelationshipEvidence`'s shape) — most event families carry no
 * relationship evidence, and a new family should default to "none" without a
 * ruling here.
 */
export function deriveRelationshipLedgerEntries(input: DeriveLedgerEntriesInput): RelationshipLedgerEntry[] {
  const entries: RelationshipLedgerEntry[] = [];
  const ordered = [...input.events].sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) {
    if (event.type === "speech_act_delivered") {
      const kind = speechActLedgerKind(event.payload.effectType);
      if (kind === null) continue;
      const requiresScope = relationshipLedgerKindPayloadKind[kind] === "consent";
      if (requiresScope && event.payload.consentScopeKey === undefined) {
        // narrative.ts's own refine already guarantees this never fires for a
        // validated event — defense in depth, never fabricate a scope
        // (resilience.md: degraded default over a failed turn, not a lie).
        continue;
      }
      const payload: RelationshipLedgerPayload =
        requiresScope && event.payload.consentScopeKey !== undefined
          ? { kind: "consent", scopeKey: event.payload.consentScopeKey }
          : { kind: "none" };
      for (const targetId of event.payload.targetActorIds) {
        pushEntry(entries, event, kind, event.payload.actorId, targetId, payload);
      }
    } else if (event.type === "disclosure_made") {
      if (event.payload.content.kind === "retraction") continue;
      for (const targetId of event.payload.targetActorIds) {
        pushEntry(entries, event, "confidence_shared", event.payload.speakerActorId, targetId, { kind: "none" });
      }
    } else if (event.type === "engagement_ended") {
      // A completed shared scene is evidence for every participant pair —
      // one entry per unordered pair (not bidirectional), the sorted-pair
      // double-loop the deleted deriveRelationshipEvidence used.
      const participants = sortedUnique(event.actorIds);
      for (let i = 0; i < participants.length; i += 1) {
        for (let j = i + 1; j < participants.length; j += 1) {
          const left = participants[i];
          const right = participants[j];
          if (left !== undefined && right !== undefined) {
            pushEntry(entries, event, "shared_scene", left, right, { kind: "none" });
          }
        }
      }
    } else if (event.type === "commitment_kept" || event.type === "commitment_missed") {
      // E5.5 slice 2 (§15.1 amendment): only a `promise` naming a
      // `promisedToActorId` produces evidence — a shift/appointment/routine
      // has no interpersonal stake, and the ledger records evidence between
      // actors, never a fact about one actor alone.
      const commitment = input.commitmentById(event.payload.commitmentId);
      if (commitment && commitment.kind === "promise" && commitment.promisedToActorId !== undefined) {
        const kind = event.type === "commitment_kept" ? "promise_kept" : "promise_missed";
        pushEntry(entries, event, kind, event.payload.actorId, commitment.promisedToActorId, {
          kind: "commitment",
          commitmentId: event.payload.commitmentId,
        });
      }
    } else if (event.type === "commitment_created") {
      // §15.4: a repair is new evidence, not a correction — only fires when
      // this NEW commitment both repairs a prior one AND itself names a
      // `promisedToActorId` (the same interpersonal-stake gate as above).
      if (event.payload.repairsCommitmentId !== undefined && event.payload.promisedToActorId !== undefined) {
        pushEntry(entries, event, "promise_repaired", event.payload.actorId, event.payload.promisedToActorId, {
          kind: "commitment",
          commitmentId: event.payload.commitmentId,
        });
      }
    } else if (event.type === "activity_started") {
      // §21.4: a `consent_covered` precondition that passed is itself
      // evidence the target respected their own prior boundary/permission.
      if (event.payload.consentGrant) {
        const { granterActorId, granteeActorId, scopeKey } = event.payload.consentGrant;
        pushEntry(entries, event, "boundary_respected", granterActorId, granteeActorId, {
          kind: "consent",
          scopeKey,
        });
      }
    } else if (event.type === "relationship_entry_authored") {
      const { kind: entryKind, scopeKey } = event.payload;
      const payload: RelationshipLedgerPayload =
        entryKind === "boundary_violated" && scopeKey !== undefined ? { kind: "consent", scopeKey } : { kind: "none" };
      pushEntry(entries, event, entryKind, event.payload.fromActorId, event.payload.toActorId, payload, {
        storySecond: event.payload.entryStorySecond,
        detail: event.payload.detail,
        provenance: "authored",
      });
    } else if (event.type === "relationship_change_recorded") {
      pushEntry(
        entries,
        event,
        "relationship_change_recorded",
        event.payload.fromActorId,
        event.payload.toActorId,
        { kind: "change", changeKey: event.payload.changeKey },
        { detail: event.payload.detail },
      );
    } else if (event.type === "consent_escalation_resolved") {
      // §4.2/ruling 16: the outcome lands as ledger evidence either way — a
      // grant folds as `permission_granted`, a decline as `consent_declined`.
      // Directional per every other consent-scoped entry: `fromActorId` is
      // the party whose consent was decided (the target), `toActorId` is the
      // one who asked (the actor) — matching `boundary_stated`/
      // `permission_granted`'s own "who granted/denied" direction.
      const kind = event.payload.granted ? "permission_granted" : "consent_declined";
      pushEntry(entries, event, kind, event.payload.targetActorId, event.payload.actorId, {
        kind: "consent",
        scopeKey: event.payload.scopeKey,
      });
    }
    // Every other event family (movement, materials, bodies, commitments,
    // access, pressure_acknowledged, ...) carries no relationship evidence
    // and defaults to "none" without a ruling — see this file's header doc
    // for the commitment/activity/escalation arms specifically.
    // `pressure_acknowledged` in particular is deliberately excluded (§1.7):
    // acknowledgment is a pure engagement/commitment cross-domain fact, never
    // ledger evidence.
  }
  return entries;
}

/**
 * Fork/replay parity (§6): the relationship ledger is a derived-and-persisted
 * projection with no incremental state machine to replay — a full rebuild
 * re-derives from scratch, so "replay the whole branch" and "fold this
 * command's new events" are literally the same function at different input
 * sizes. `commitmentById` MUST be resolved from a real commitments load by
 * every caller (`branch-store.ts`'s fork replay resolves it from the
 * already-rebuilt child commitments projection, §6) — never a stub, now that
 * the commitment-sourced arms are real (§4.2).
 */
export function replaySocialLedgerHistory(input: DeriveLedgerEntriesInput): RelationshipLedgerEntry[] {
  return deriveRelationshipLedgerEntries(input);
}

// ---------------------------------------------------------------------------
// Read: trust/attraction/resentment (§21.3, decay law) — derived, never persisted
// ---------------------------------------------------------------------------

export interface RelationshipReadWeightOverride {
  /** Which `authored_prior` entry this override applies to. */
  entryId: string;
  weight: RelationshipLedgerWeight;
}

const RELATIONSHIP_READ_CLAMP_FIXED_POINT = 1_000_000;

function clampReadAxis(value: number): number {
  return Math.max(-RELATIONSHIP_READ_CLAMP_FIXED_POINT, Math.min(RELATIONSHIP_READ_CLAMP_FIXED_POINT, value));
}

/** n-1 ascending cut points for n band keys; value <= thresholds[i] → band i;
 * value > every threshold → the last band. Fixed-point, versioned, tunable. */
export const TRUST_BAND_THRESHOLDS = [-3_000, -500, 500, 3_000] as const;
export const ATTRACTION_BAND_THRESHOLDS = [-3_000, -500, 500, 3_000] as const;
/**
 * Resentment is NOT symmetric like trust/attraction — its band labels
 * (none/mild/simmering/seething/hostile) read as a one-directional "how much
 * offense has accumulated" scale, not a zero-centered one, even though the
 * weight table allows individual entries with negative resentment
 * contributions (`apology_offered`: -500, `promise_repaired`: -300 — credit
 * that offsets FUTURE resentment-causing entries, not a distinct negative
 * feeling). Ruling: resentment bands are floor/clamp bands — every raw sum
 * <= the first threshold (including any negative sum a surplus of apologies
 * produces) reads as "none." There is no negative-side band.
 */
export const RESENTMENT_BAND_THRESHOLDS = [500, 1_500, 3_000, 5_000] as const;

function bandFor<K extends string>(value: number, thresholds: readonly number[], keys: readonly K[]): K {
  const index = thresholds.findIndex((threshold) => value <= threshold);
  const key = keys[index === -1 ? keys.length - 1 : index];
  if (key === undefined) throw new Error("Relationship band threshold/key arrays are misaligned");
  return key;
}

/**
 * The §21.3 derived read: sums each relevant ledger entry's per-axis weight
 * under a per-axis analytic decay, directional ("how much X trusts Y" sums
 * only entries where `fromActorId = Y, toActorId = X` — evidence of Y's
 * conduct toward X), fixed-point, story-clock-keyed, never wall-clock or
 * floating point (§6.4).
 */
export function deriveRelationshipRead(input: {
  /** All entries for the branch, or a pre-filtered dyad slice — either way
   * this function re-applies the directional filter itself. */
  entries: readonly RelationshipLedgerEntry[];
  subjectActorId: string;
  aboutActorId: string;
  atStorySecond: number;
  weightRegistry?: Readonly<
    Record<Exclude<RelationshipLedgerKind, "authored_prior" | "relationship_change_recorded">, RelationshipLedgerWeight>
  >;
  /** `authored_prior` entries needing their own weight, loaded alongside the
   * entry's own `weightOverride` (§5.6's `loadAuthoredPriorWeights`, a later
   * slice). Every real caller of this function MUST load and pass this. */
  authoredPriorWeights?: readonly RelationshipReadWeightOverride[];
}): RelationshipRead {
  const registry = input.weightRegistry ?? relationshipLedgerWeightRegistryV1;
  const directional = input.entries.filter(
    (entry) => entry.fromActorId === input.aboutActorId && entry.toActorId === input.subjectActorId,
  );

  const diagnostics: string[] = [];
  let trustSum = 0;
  let attractionSum = 0;
  let resentmentSum = 0;

  for (const entry of directional) {
    if (entry.kind === "relationship_change_recorded") continue; // a state marker, not axis evidence

    let weight: RelationshipLedgerWeight;
    if (entry.kind === "authored_prior") {
      const override = input.authoredPriorWeights?.find((candidate) => candidate.entryId === entry.id);
      if (override) {
        weight = override.weight;
      } else {
        // Degraded default, not a thrown error (resilience.md) — a missing
        // override is a data-integrity gap worth surfacing, not a silent
        // no-op or a fabricated contribution.
        weight = { trustFixedPoint: 0, attractionFixedPoint: 0, resentmentFixedPoint: 0 };
        diagnostics.push(`authored_prior_missing_weight:${entry.id}`);
      }
    } else {
      weight = registry[entry.kind];
    }

    if (entry.storySecond > input.atStorySecond) continue; // a read never looks into the future
    const elapsed = input.atStorySecond - entry.storySecond;
    const trustScaled = exp2NegativeFixedPoint(elapsed, RELATIONSHIP_AXIS_HALF_LIFE_SECONDS.trust);
    const attractionScaled = exp2NegativeFixedPoint(elapsed, RELATIONSHIP_AXIS_HALF_LIFE_SECONDS.attraction);
    const resentmentScaled = exp2NegativeFixedPoint(elapsed, RELATIONSHIP_AXIS_HALF_LIFE_SECONDS.resentment);
    trustSum += Math.floor((weight.trustFixedPoint * trustScaled) / EXP2_SCALE);
    attractionSum += Math.floor((weight.attractionFixedPoint * attractionScaled) / EXP2_SCALE);
    resentmentSum += Math.floor((weight.resentmentFixedPoint * resentmentScaled) / EXP2_SCALE);
  }

  trustSum = clampReadAxis(trustSum);
  attractionSum = clampReadAxis(attractionSum);
  resentmentSum = clampReadAxis(resentmentSum);

  return relationshipReadSchema.parse({
    subjectActorId: input.subjectActorId,
    aboutActorId: input.aboutActorId,
    evaluatedAtStorySecond: input.atStorySecond,
    trustFixedPoint: trustSum,
    attractionFixedPoint: attractionSum,
    resentmentFixedPoint: resentmentSum,
    trustBand: bandFor(trustSum, TRUST_BAND_THRESHOLDS, trustBandKeys),
    attractionBand: bandFor(attractionSum, ATTRACTION_BAND_THRESHOLDS, attractionBandKeys),
    resentmentBand: bandFor(resentmentSum, RESENTMENT_BAND_THRESHOLDS, resentmentBandKeys),
    entryCount: directional.length,
    diagnostics,
  });
}

// ---------------------------------------------------------------------------
// Consent coverage (§21.4) — the fail-closed gate. Pure and small; nothing
// calls it yet in Slice 1 (the `consent_covered` precondition wiring is
// Slice 2).
// ---------------------------------------------------------------------------

/**
 * Coverage. For an actor A attempting a `consent_covered`-gated action toward
 * actor B under scope S, the gate reads the ledger for the MOST RECENT entry
 * (by sequence) among `{boundary_stated, permission_granted,
 * permission_withdrawn}` where `fromActorId = B, toActorId = A, payload.scopeKey
 * = S`. Coverage exists — the action is permitted — if and only if that
 * most-recent entry's kind is `permission_granted`. No covering entry, a
 * `boundary_stated` or `permission_withdrawn` as the most recent entry, or a
 * malformed/unparseable entry (which never enters the ledger in the first
 * place — defense in depth, not a live failure mode) all resolve to NO
 * coverage. This check is fail-closed by construction: absence of evidence is
 * absence of permission. A later entry always supersedes an earlier one —
 * permission is revocable at any time by a `permission_withdrawn` entry, and
 * a withdrawal takes effect for every scope-matching attempt from that
 * entry's sequence forward.
 */
export function resolveConsentCoverage(input: {
  /** Pre-filtered to the (granter, grantee) dyad — see §5.5. */
  entries: readonly RelationshipLedgerEntry[];
  granterActorId: string;
  granteeActorId: string;
  scopeKey: ConsentScopeKey;
}): boolean {
  const relevant = input.entries
    .filter((entry) => entry.fromActorId === input.granterActorId && entry.toActorId === input.granteeActorId)
    .filter(
      (entry) =>
        entry.kind === "boundary_stated" || entry.kind === "permission_granted" || entry.kind === "permission_withdrawn",
    )
    .filter((entry) => entry.payload.kind === "consent" && entry.payload.scopeKey === input.scopeKey)
    .sort((left, right) => right.sequence - left.sequence); // most recent first
  return relevant[0]?.kind === "permission_granted";
}

// ---------------------------------------------------------------------------
// Consent-escalation utility (§4.7, §19.2) — the bounded legal candidate set
// the §19.3 deliberator seam chooses between. Scoped ONLY to this call site
// — a general §19.2 routine-policy scorer is explicitly deferred (§11 open
// decision 6).
// ---------------------------------------------------------------------------

/** Versioned, tunable — net-neutral evidence still leans decline. */
const BASE_CONSENT_RELUCTANCE_FIXED_POINT = 500;

/**
 * The two-candidate `[grant, decline]` pair `attempt_consent_escalation`
 * admits into the deliberator seam (§5.6). `grant`'s score is the target's
 * read of the actor — trust plus attraction, minus resentment, minus the
 * base reluctance constant — clamped to the same safe-integer band every
 * `deterministicScoreFixedPoint` uses; `decline` is a fixed zero. A
 * net-neutral read (zero trust/attraction/resentment) therefore always
 * scores `grant` below `decline`, by exactly the reluctance constant —
 * consent defaults to reluctant, not indifferent.
 */
export function deriveConsentEscalationCandidates(
  read: Pick<RelationshipRead, "trustFixedPoint" | "attractionFixedPoint" | "resentmentFixedPoint">,
): [DeliberationCandidate, DeliberationCandidate] {
  const grantScore = Math.max(
    -1_000_000,
    Math.min(
      1_000_000,
      read.trustFixedPoint + read.attractionFixedPoint - read.resentmentFixedPoint - BASE_CONSENT_RELUCTANCE_FIXED_POINT,
    ),
  );
  return [
    { id: "grant", deterministicScoreFixedPoint: grantScore },
    { id: "decline", deterministicScoreFixedPoint: 0 },
  ];
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing (mirrors households.ts / bodies.ts / commitments.ts)
// ---------------------------------------------------------------------------

interface RelationshipsBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

interface RelationshipRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

function relationshipRejection<TCode extends string>(
  code: TCode,
  publicReason: string,
): RelationshipRejection<TCode> {
  return { ok: false, code, publicReason };
}

function isPrivilegedRelationshipPrincipal(kind: string): boolean {
  return kind === "storyteller" || kind === "system";
}

interface RelationshipEventCommandContext {
  id: string;
  correlationId: string;
  submittedAtWallClock: string;
}

function relationshipEventEnvelope(
  view: RelationshipsBranchMeta,
  command: RelationshipEventCommandContext,
  sequence: number,
  suffix: string,
) {
  return {
    id: composeSimulationId("event", [view.branchId, command.id, suffix]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: socialDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
  };
}

// ---------------------------------------------------------------------------
// record_relationship_entry (§5.2) — storyteller/system-privileged authoring
// ---------------------------------------------------------------------------

export interface RecordRelationshipEntryResolutionView extends RelationshipsBranchMeta {
  actorExists(actorId: string): boolean;
}

export type RecordRelationshipEntryResolution =
  | RelationshipRejection<RecordRelationshipEntryRejectionCode>
  | { ok: true; event: RelationshipEntryAuthoredEvent };

export function resolveRecordRelationshipEntryFromView(
  view: RecordRelationshipEntryResolutionView,
  command: RecordRelationshipEntryCommand,
): RecordRelationshipEntryResolution {
  if (command.branchId !== view.branchId) {
    return relationshipRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedRelationshipPrincipal(command.principal.kind)) {
    return relationshipRejection("unauthorized_principal", "Only the storyteller can author relationship evidence.");
  }
  if (!view.actorExists(command.payload.fromActorId) || !view.actorExists(command.payload.toActorId)) {
    return relationshipRejection("actor_not_found", "That actor is unavailable.");
  }

  const entryStorySecond = command.payload.storySecond ?? view.storySecond;
  const event = relationshipEntryAuthoredEventSchema.parse({
    ...relationshipEventEnvelope(view, command, view.headSequence + 1, "relationship-entry-authored"),
    type: "relationship_entry_authored",
    actorIds: sortedUnique([command.payload.fromActorId, command.payload.toActorId]),
    entityIds: sortedUnique([command.payload.fromActorId, command.payload.toActorId]),
    payload: {
      fromActorId: command.payload.fromActorId,
      toActorId: command.payload.toActorId,
      kind: command.payload.kind,
      detail: command.payload.detail,
      entryStorySecond,
      ...(command.payload.weightOverride === undefined ? {} : { weightOverride: command.payload.weightOverride }),
      ...(command.payload.scopeKey === undefined ? {} : { scopeKey: command.payload.scopeKey }),
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// record_relationship_change (§5.3) — storyteller/system-privileged, v1
// ---------------------------------------------------------------------------

export interface RecordRelationshipChangeResolutionView extends RelationshipsBranchMeta {
  actorExists(actorId: string): boolean;
}

export type RecordRelationshipChangeResolution =
  | RelationshipRejection<RecordRelationshipChangeRejectionCode>
  | { ok: true; event: RelationshipChangeRecordedEvent };

export function resolveRecordRelationshipChangeFromView(
  view: RecordRelationshipChangeResolutionView,
  command: RecordRelationshipChangeCommand,
): RecordRelationshipChangeResolution {
  if (command.branchId !== view.branchId) {
    return relationshipRejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedRelationshipPrincipal(command.principal.kind)) {
    return relationshipRejection("unauthorized_principal", "Only the storyteller can record a relationship change.");
  }
  if (!view.actorExists(command.payload.fromActorId) || !view.actorExists(command.payload.toActorId)) {
    return relationshipRejection("actor_not_found", "That actor is unavailable.");
  }

  const event = relationshipChangeRecordedEventSchema.parse({
    ...relationshipEventEnvelope(view, command, view.headSequence + 1, "relationship-change-recorded"),
    type: "relationship_change_recorded",
    actorIds: sortedUnique([command.payload.fromActorId, command.payload.toActorId]),
    entityIds: sortedUnique([command.payload.fromActorId, command.payload.toActorId]),
    payload: {
      fromActorId: command.payload.fromActorId,
      toActorId: command.payload.toActorId,
      changeKey: command.payload.changeKey,
      detail: command.payload.detail,
    },
  });
  return { ok: true, event };
}
