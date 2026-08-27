import type { SimulationBranchEvent } from "../contracts/branching";
import {
  deriveSoftCanonEntryId,
  SOFT_CANON_DERIVATION_VERSION,
  softCanonEntrySchema,
  softCanonStatusTransitions,
  type SoftCanonEntry,
  type SoftCanonProposal,
  type SoftCanonRejectionCode,
  type SoftCanonRules,
  type SoftCanonScope,
} from "../contracts/soft-canon";
import { canonicalValueKey } from "./knowledge";

/**
 * E4.3 — the pure soft-canon kernel. Proposals
 * pass conflict, privacy, scope, duplication, and world-type checks against a
 * lock-consistent entry view; every accepted proposal yields the full
 * post-fold entry snapshot (§6.4 capture), so the durable fold is a trivial
 * upsert and fork replay mints identical rows.
 *
 * Rejection never fails a turn: a refused proposal is a diagnostic, the prose
 * stands (§23.4 — "may be rejected without regenerating prose").
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Whether an entry currently counts: promoted entries are canon regardless of
 * their original TTL, demoted entries never count, active entries expire
 * lazily — expiry is a read-time comparison, never a status write.
 */
export function isSoftCanonEntryLive(entry: SoftCanonEntry, storySecond: number): boolean {
  if (entry.status === "demoted") return false;
  if (entry.status === "promoted") return true;
  return entry.validUntil === undefined || entry.validUntil >= storySecond;
}

function subjectsInScope(
  scope: SoftCanonScope,
  subjectIds: readonly string[],
  surface: { actorIds: Set<string>; zoneIds: Set<string> },
): boolean {
  switch (scope) {
    case "world":
      return subjectIds.length === 0;
    case "location":
      return subjectIds.length >= 1 && subjectIds.every((id) => surface.zoneIds.has(id));
    case "character":
      return subjectIds.length === 1 && subjectIds.every((id) => surface.actorIds.has(id));
    case "relationship":
      return subjectIds.length >= 2 && subjectIds.every((id) => surface.actorIds.has(id));
    case "scene":
      return subjectIds.length >= 1 && subjectIds.every((id) => surface.actorIds.has(id));
  }
}

export interface AcceptedSoftCanonProposal {
  proposal: SoftCanonProposal;
  /** Post-fold snapshot at ACTIVE status; promotion overlays it separately. */
  entry: SoftCanonEntry;
  /** True when a new distinct committed cut refreshed an existing entry. */
  reused: boolean;
  /** Ruling 14: the thresholds fired — an audited promotion event must follow. */
  promoted: boolean;
  reuseCutCount: number;
}

export interface RejectedSoftCanonProposal {
  proposal: SoftCanonProposal;
  code: SoftCanonRejectionCode;
  detail: string;
}

export interface SoftCanonResolution {
  accepted: AcceptedSoftCanonProposal[];
  rejected: RejectedSoftCanonProposal[];
}

export interface SoftCanonResolutionInput {
  branchId: string;
  /** The persisted cut this render came from — the proposal's only authority. */
  cutId: string;
  /**
   * The cut's visible surface — the only entities soft canon may reference.
   * Scene participants (co-present or remote) plus the zones the cut showed.
   */
  participantActorIds: readonly string[];
  zoneIds: readonly string[];
  proposals: readonly SoftCanonProposal[];
  /** Every soft-canon entry on the branch (any status), lock-consistent. */
  entries: readonly SoftCanonEntry[];
  rules: SoftCanonRules;
  storySecond: number;
}

/**
 * Validate a batch of proposals in payload order. Deterministic: same input,
 * same accepted snapshots — the store turns each accepted item into a
 * `soft_canon_recorded` event (plus `soft_canon_promoted` when flagged).
 */
export function resolveSoftCanonProposals(input: SoftCanonResolutionInput): SoftCanonResolution {
  const surface = {
    actorIds: new Set(input.participantActorIds),
    zoneIds: new Set(input.zoneIds),
  };
  const byId = new Map<string, SoftCanonEntry>(input.entries.map((entry) => [entry.id, entry]));
  const accepted: AcceptedSoftCanonProposal[] = [];
  const rejected: RejectedSoftCanonProposal[] = [];
  const seenInBatch = new Set<string>();

  const liveCountByScope = new Map<SoftCanonScope, number>();
  for (const entry of input.entries) {
    if (!isSoftCanonEntryLive(entry, input.storySecond)) continue;
    liveCountByScope.set(entry.scope, (liveCountByScope.get(entry.scope) ?? 0) + 1);
  }

  for (const proposal of input.proposals) {
    const reject = (code: SoftCanonRejectionCode, detail: string): void => {
      rejected.push({ proposal, code, detail });
    };
    if (proposal.sourceCutId !== input.cutId) {
      reject("wrong_source_cut", "A proposal may only cite the cut it rendered from.");
      continue;
    }
    if (proposal.confidenceFixedPoint < input.rules.recordMinimumConfidenceFixedPoint) {
      reject("confidence_below_minimum", "The narrator hedged this detail too much to keep.");
      continue;
    }
    const valueKey = canonicalValueKey(proposal.value);
    if (valueKey.length > input.rules.maxValueBytes) {
      reject("value_too_large", "Soft canon is a detail, not a document.");
      continue;
    }
    if (proposal.subjectIds.length > input.rules.maxSubjectIds) {
      reject("too_many_subjects", "Too many subjects for one detail.");
      continue;
    }
    if (!subjectsInScope(proposal.scope, proposal.subjectIds, surface)) {
      reject("subjects_outside_cut", "Soft canon cannot reach entities this render never saw.");
      continue;
    }

    const entryId = deriveSoftCanonEntryId(
      input.branchId,
      proposal.scope,
      proposal.key,
      proposal.subjectIds,
    );
    if (seenInBatch.has(entryId)) {
      reject("duplicate_proposal", "This render already proposed that key.");
      continue;
    }
    const existing = byId.get(entryId);
    const live =
      existing !== undefined && isSoftCanonEntryLive(existing, input.storySecond) ? existing : undefined;

    if (existing && existing.status === "demoted") {
      reject("conflicts_with_active_entry", "That detail was explicitly retracted.");
      continue;
    }
    if (live && canonicalValueKey(live.value) !== valueKey) {
      reject("conflicts_with_active_entry", "A different value already holds for that key.");
      continue;
    }
    if (live && live.status === "promoted") {
      reject("duplicate_proposal", "That detail is already promoted canon.");
      continue;
    }

    const defaultValidUntil = input.storySecond + input.rules.ttlStorySecondsByScope[proposal.scope];
    let entry: SoftCanonEntry;
    let reused = false;
    if (live) {
      // Reuse: a distinct committed cut reached for the same detail again.
      reused = !live.sourceCutIds.includes(proposal.sourceCutId);
      const sourceCutIds = reused
        ? [...live.sourceCutIds, proposal.sourceCutId].slice(-input.rules.maxSourceCutIds)
        : [...live.sourceCutIds];
      entry = softCanonEntrySchema.parse({
        ...live,
        confidenceFixedPoint: Math.max(live.confidenceFixedPoint, proposal.confidenceFixedPoint),
        lastRecordedAt: input.storySecond,
        validUntil: Math.max(live.validUntil ?? 0, proposal.validUntil ?? defaultValidUntil),
        sourceCutIds,
        rulesVersion: input.rules.version,
      });
    } else {
      // Fresh mint — or revival of an expired key, which starts provenance over.
      const scopeCount = liveCountByScope.get(proposal.scope) ?? 0;
      if (scopeCount >= input.rules.maxEntriesPerScope) {
        reject("scope_full", "The bounded store for that scope is full.");
        continue;
      }
      liveCountByScope.set(proposal.scope, scopeCount + 1);
      entry = softCanonEntrySchema.parse({
        id: entryId,
        branchId: input.branchId,
        key: proposal.key,
        scope: proposal.scope,
        subjectIds: proposal.subjectIds,
        value: proposal.value,
        confidenceFixedPoint: proposal.confidenceFixedPoint,
        firstRecordedAt: input.storySecond,
        lastRecordedAt: input.storySecond,
        validUntil: proposal.validUntil ?? defaultValidUntil,
        sourceCutIds: [proposal.sourceCutId],
        status: "active",
        rulesVersion: input.rules.version,
        derivationVersion: SOFT_CANON_DERIVATION_VERSION,
      });
    }

    const promoted =
      entry.status === "active" &&
      input.rules.autoPromotionEnabled &&
      input.rules.promotableScopes.includes(entry.scope) &&
      entry.sourceCutIds.length >= input.rules.promotionReuseCutCount &&
      entry.confidenceFixedPoint >= input.rules.promotionMinimumConfidenceFixedPoint;

    seenInBatch.add(entryId);
    byId.set(entryId, entry);
    accepted.push({ proposal, entry, reused, promoted, reuseCutCount: entry.sourceCutIds.length });
  }

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Demotion (ruling 14's explicit retraction path)
// ---------------------------------------------------------------------------

export type DemoteSoftCanonResolution =
  | { ok: true; entry: SoftCanonEntry }
  | { ok: false; code: "entry_not_found" | "entry_not_demotable"; publicReason: string };

/** Demote without touching event history: a status move, nothing erased. */
export function resolveDemoteSoftCanon(
  existing: SoftCanonEntry | undefined,
  storySecond: number,
): DemoteSoftCanonResolution {
  if (!existing) {
    return { ok: false, code: "entry_not_found", publicReason: "No such established detail." };
  }
  if (!softCanonStatusTransitions[existing.status].includes("demoted")) {
    return { ok: false, code: "entry_not_demotable", publicReason: "That detail is already retracted." };
  }
  return {
    ok: true,
    entry: softCanonEntrySchema.parse({
      ...existing,
      status: "demoted",
      statusChangedAt: storySecond,
    }),
  };
}

// ---------------------------------------------------------------------------
// The fold and replay (fork rebuild, parity audit)
// ---------------------------------------------------------------------------

export type SoftCanonState = Map<string, SoftCanonEntry>;

/**
 * Apply one committed soft-canon event. Trivial by design: every event
 * carries its full post-fold snapshot (§6.4), so live upsert and replay
 * cannot diverge. Copy-on-write; the input map is never mutated.
 */
export function applySoftCanonEvent(state: SoftCanonState, event: SimulationBranchEvent): SoftCanonState {
  const entry =
    event.type === "soft_canon_recorded"
      ? event.payload.derived.entry
      : event.type === "soft_canon_promoted" || event.type === "soft_canon_demoted"
        ? event.payload.entry
        : undefined;
  if (entry === undefined) return state;
  const next = new Map(state);
  next.set(entry.id, softCanonEntrySchema.parse(entry));
  return next;
}

/**
 * Deterministic rebuild of the soft-canon ledger for one event stream.
 * Output ordering is stable (by id) so bulk inserts and parity checks
 * compare bit-for-bit.
 */
export function replaySoftCanonHistory(events: readonly SimulationBranchEvent[]): SoftCanonEntry[] {
  let state: SoftCanonState = new Map();
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) state = applySoftCanonEvent(state, event);
  return [...state.values()].sort((left, right) => compareStableText(left.id, right.id));
}

// ---------------------------------------------------------------------------
// Cut selection (the compiler's established_detail licenses)
// ---------------------------------------------------------------------------

export interface SelectCutSoftCanonInput {
  entries: readonly SoftCanonEntry[];
  participantActorIds: readonly string[];
  zoneIds: readonly string[];
  storySecond: number;
  limit: number;
}

/**
 * The live entries one cut may license for reuse — scope-contained in the
 * cut's visible surface, promoted first, then freshest; final order is by id
 * so the compiled cut hashes stably.
 */
export function selectCutSoftCanon(input: SelectCutSoftCanonInput): SoftCanonEntry[] {
  const actorIds = new Set(input.participantActorIds);
  const zoneIds = new Set(input.zoneIds);
  const surface = { actorIds, zoneIds };
  const eligible = input.entries
    .filter((entry) => isSoftCanonEntryLive(entry, input.storySecond))
    .filter((entry) => subjectsInScope(entry.scope, entry.subjectIds, surface));
  eligible.sort((left, right) => {
    if ((left.status === "promoted") !== (right.status === "promoted")) {
      return left.status === "promoted" ? -1 : 1;
    }
    if (left.lastRecordedAt !== right.lastRecordedAt) return right.lastRecordedAt - left.lastRecordedAt;
    return compareStableText(left.id, right.id);
  });
  return eligible.slice(0, input.limit).sort((left, right) => compareStableText(left.id, right.id));
}
