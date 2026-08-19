import type { ChatContactPremiseKind, ChatContactTurnRecord } from "@/server/engine";
import type { ContactCaseState } from "./oracle";

/**
 * The six live cases the rollout rerun must cover, what each one must do to the
 * WORLD, and the pure derivations that turn a captured exchange into something
 * checkable.
 *
 * Nothing here talks to a database or a model, which is the point: the parts of
 * the rerun that decide anything are testable without a proof window open, and
 * only the thin driver in `run.ts` needs Fly.
 *
 * The central rule is that a case passes on STATE first and prose second. The
 * prose oracle only ever asks whether the narration contradicts what happened;
 * it cannot tell whether the right thing happened, so on its own it would pass a
 * withdrawal that ended nothing and a retake that left two contacts. Every case
 * therefore carries an explicit required-state expectation, and both have to
 * hold.
 */

// ---------------------------------------------------------------------------
// What a case requires of the world
// ---------------------------------------------------------------------------

export interface ExpectedAct {
  readonly kind: "affectionate" | "romantic";
  readonly gesture: string;
  readonly targetLocationId: string;
}

export interface CaseExpectation {
  /** The act the line must build, or `"none"` for a line that writes no touch. */
  readonly act: ExpectedAct | "none";
  /** The resolver's status, and its typed reason where it has one. */
  readonly status: string | "none";
  readonly reason?: string;
  /** Contacts this exchange must DURABLY commit — acknowledged, not merely planned. */
  readonly durableCommits: number;
  /** Live player↔target contacts once the exchange has settled. */
  readonly pairContactsAfter: number;
  /** Player↔target contacts that were live before the case and are gone after it. */
  readonly endedPairContacts: number;
  /** The premise the narrator must have been handed, if any. */
  readonly guidanceKind: ChatContactPremiseKind | "none";
  /** The standing the permission ledger must hold for this pair when the line is sent. */
  readonly permissionStanding: "granted" | "withdrawn" | "none";
  /** Whether a denial bound to THIS attempt's action id must be on the ledger. */
  readonly attemptDeniedBound?: boolean;
  /**
   * Retake only: the surviving pair contacts must be exactly the set the
   * committing exchange left — same count AND same ids. A retake that duplicated
   * a contact, or replaced it with a fresh one, fails here; a count alone would
   * miss the second.
   */
  readonly pairContactIdsUnchanged?: boolean;
}

export type PermissionSetup = "none" | "grant" | "withdraw";

export interface TrialCase {
  readonly id: string;
  /** What this case is here to settle, in one plain sentence. */
  readonly proves: string;
  /** Permission state to establish BEFORE the line is sent. */
  readonly setup: PermissionSetup;
  /** The player's line, verbatim. */
  readonly line: string;
  /**
   * Re-run an exchange instead of sending a fresh line. `"self"` sends the line,
   * binds a denial to the attempt it produced, and reruns it; `"previous"`
   * reruns the previous case's persisted user message.
   */
  readonly rerun?: "self" | "previous";
  /** Bind an `attempt_denied` to the first send's action id before the rerun. */
  readonly bindDenial?: boolean;
  readonly expect: CaseExpectation;
}

/**
 * Order is load-bearing, and every adjacency below is deliberate.
 *
 * - `no_grant` runs FIRST, against a verified clean ledger. It is the pronoun
 *   form of the committing line with the grant removed, so the two cases differ
 *   in exactly one thing and the refusal cannot be attributed to anything else.
 *   It closes its own distance, so an unestablished reach cannot masquerade as
 *   the permission answer this case exists to observe.
 * - `explicit_denial` follows while the ledger still holds no grant, so the
 *   denial it binds is unambiguously what refused the attempt.
 * - `retake` comes IMMEDIATELY after `commit`, because it reruns that
 *   exchange's persisted user line. Anything between them would move the
 *   message the rerun targets.
 * - `withdrawal` needs a live contact, which the retake leaves.
 * - `natural_named` runs last, on the clean slate the withdrawal produced, so
 *   the written name is the only thing under test.
 */
export const TRIAL_CASES: readonly TrialCase[] = [
  {
    id: "no_grant",
    proves: "a romantic touch nobody authorised does not become part of the world, and the prose does not invent it",
    setup: "none",
    line: "I step closer to you. I caress your arm.",
    expect: {
      act: { kind: "romantic", gesture: "caress", targetLocationId: "arms" },
      status: "unresolved",
      reason: "permission_unresolved",
      durableCommits: 0,
      pairContactsAfter: 0,
      endedPairContacts: 0,
      guidanceKind: "permission",
      permissionStanding: "none",
    },
  },
  {
    id: "explicit_denial",
    proves: "a denial bound to the attempt refuses it, and the narration may say so",
    setup: "none",
    line: "I step closer to you. I caress your arm.",
    rerun: "self",
    bindDenial: true,
    expect: {
      act: { kind: "romantic", gesture: "caress", targetLocationId: "arms" },
      status: "rejected",
      reason: "permission_denied",
      durableCommits: 0,
      pairContactsAfter: 0,
      endedPairContacts: 0,
      guidanceKind: "none",
      permissionStanding: "none",
      attemptDeniedBound: true,
    },
  },
  {
    id: "commit",
    proves: "an authorised, physically possible touch commits and the narration honours it",
    setup: "grant",
    line: "I step closer to you. I caress your arm.",
    expect: {
      act: { kind: "romantic", gesture: "caress", targetLocationId: "arms" },
      status: "committable",
      durableCommits: 1,
      pairContactsAfter: 1,
      endedPairContacts: 0,
      guidanceKind: "none",
      permissionStanding: "granted",
    },
  },
  {
    id: "retake",
    proves: "regenerating the committing turn leaves one contact rather than two",
    setup: "none",
    line: "I step closer to you. I caress your arm.",
    rerun: "previous",
    expect: {
      act: { kind: "romantic", gesture: "caress", targetLocationId: "arms" },
      status: "committable",
      durableCommits: 1,
      pairContactsAfter: 1,
      endedPairContacts: 0,
      guidanceKind: "none",
      permissionStanding: "granted",
      pairContactIdsUnchanged: true,
    },
  },
  {
    id: "withdrawal",
    proves: "withdrawing permission ends a touch already in progress and the next reply does not continue it",
    setup: "withdraw",
    line: "I stay where I am and watch her.",
    expect: {
      act: "none",
      status: "none",
      durableCommits: 0,
      pairContactsAfter: 0,
      endedPairContacts: 1,
      guidanceKind: "none",
      permissionStanding: "withdrawn",
    },
  },
  {
    id: "natural_named",
    proves: "a player writing the character's name the way players write it produces a real attempt",
    setup: "grant",
    line: "I walk over to Sabrina. I caress Sabrina's arm.",
    expect: {
      act: { kind: "romantic", gesture: "caress", targetLocationId: "arms" },
      status: "committable",
      durableCommits: 1,
      pairContactsAfter: 1,
      endedPairContacts: 0,
      guidanceKind: "none",
      permissionStanding: "granted",
    },
  },
];

// ---------------------------------------------------------------------------
// What the runner observes
// ---------------------------------------------------------------------------

/**
 * Live contacts between the player and the SELECTED character, and nobody else.
 *
 * The pair filter is not tidiness. An unrelated surviving contact elsewhere in
 * the scene would keep "something is still live" true and silently suppress the
 * withdrawal verdict; an unrelated one disappearing would manufacture one. Every
 * count this trial reasons about is a count of this pair.
 */
export interface PairContactSnapshot {
  readonly contactIds: readonly string[];
}

/**
 * One captured case, as observed rather than as intended.
 *
 * THREE contact snapshots, not two, because a withdrawal's sweep ends dependent
 * contacts in the SAME transaction that records the withdrawal — before the next
 * exchange runs at all. A trial that only looked either side of the exchange
 * would see nothing end and conclude the sweep never ran.
 */
export interface ObservedCase {
  readonly turn: ChatContactTurnRecord | null;
  /** Before any permission setup for this case. */
  readonly beforeSetup: PairContactSnapshot;
  /** After the setup, before the line is sent — where a withdrawal's sweep shows up. */
  readonly afterSetup: PairContactSnapshot;
  /** After the exchange has settled. */
  readonly afterExchange: PairContactSnapshot;
  /** The pair's standing on the permission ledger when the line was sent. */
  readonly permissionStanding: "granted" | "withdrawn" | "none";
  /** Whether the ledger holds a denial bound to this attempt's action id. */
  readonly attemptDeniedBound: boolean;
  /** The pair contacts the PREVIOUS case left, for the retake's identity check. */
  readonly priorPairContactIds?: readonly string[];
}

export interface StateFailure {
  readonly field: string;
  readonly expected: string;
  readonly observed: string;
}

/**
 * Check one case against what it required of the world. PURE and total.
 *
 * Returns every mismatch rather than the first, because a case that fails in
 * three ways at once is telling three things about the lane, and a report
 * showing one would send the next run round in circles.
 */
export function assertRequiredState(observed: ObservedCase, expect: CaseExpectation): readonly StateFailure[] {
  const failures: StateFailure[] = [];
  const push = (field: string, expected: unknown, actual: unknown): void => {
    failures.push({ field, expected: String(expected), observed: String(actual) });
  };
  const turn = observed.turn;

  // --- The act the line had to build ---------------------------------------
  if (expect.act === "none") {
    if (turn?.act !== undefined) push("act", "none", `${turn.act.kind}/${turn.act.gesture}`);
  } else if (turn?.act === undefined) {
    push("act", `${expect.act.kind}/${expect.act.gesture}/${expect.act.targetLocationId}`, "none");
  } else {
    if (turn.act.kind !== expect.act.kind) push("act.kind", expect.act.kind, turn.act.kind);
    if (turn.act.gesture !== expect.act.gesture) push("act.gesture", expect.act.gesture, turn.act.gesture);
    if (turn.act.targetLocationId !== expect.act.targetLocationId) {
      push("act.targetLocationId", expect.act.targetLocationId, turn.act.targetLocationId);
    }
  }

  // --- What the resolver answered ------------------------------------------
  const status = turn?.status ?? "none";
  if (status !== expect.status) push("resolver.status", expect.status, status);
  if (expect.reason !== undefined && (turn?.reason ?? "none") !== expect.reason) {
    push("resolver.reason", expect.reason, turn?.reason ?? "none");
  }

  // --- What became durably true --------------------------------------------
  const durable = turn?.committed === true ? 1 : 0;
  if (durable !== expect.durableCommits) push("durableCommits", expect.durableCommits, durable);
  if (observed.afterExchange.contactIds.length !== expect.pairContactsAfter) {
    push("pairContactsAfter", expect.pairContactsAfter, observed.afterExchange.contactIds.length);
  }

  // Ends are measured from BEFORE the setup, so a withdrawal's in-transaction
  // sweep counts as this case having ended the contact.
  const ended = observed.beforeSetup.contactIds.filter((id) => !observed.afterExchange.contactIds.includes(id));
  if (ended.length !== expect.endedPairContacts) push("endedPairContacts", expect.endedPairContacts, ended.length);

  // --- What the narrator was told ------------------------------------------
  const guidance = turn?.premiseKind ?? "none";
  if (guidance !== expect.guidanceKind) push("guidanceKind", expect.guidanceKind, guidance);

  // --- What the permission ledger held --------------------------------------
  if (observed.permissionStanding !== expect.permissionStanding) {
    push("permissionStanding", expect.permissionStanding, observed.permissionStanding);
  }
  if (expect.attemptDeniedBound !== undefined && observed.attemptDeniedBound !== expect.attemptDeniedBound) {
    push("attemptDeniedBound", expect.attemptDeniedBound, observed.attemptDeniedBound);
  }

  // --- Retake identity ------------------------------------------------------
  if (expect.pairContactIdsUnchanged === true) {
    const before = [...(observed.priorPairContactIds ?? [])].sort();
    const after = [...observed.afterExchange.contactIds].sort();
    if (before.length === 0) push("pairContactIdsUnchanged", "a contact to compare against", "none recorded");
    else if (before.join(",") !== after.join(",")) push("pairContactIds", before.join(","), after.join(","));
  }

  return failures;
}

// ---------------------------------------------------------------------------
// What the prose oracle grades against
// ---------------------------------------------------------------------------

/**
 * One captured exchange as the PROSE oracle receives it.
 *
 * Derived entirely from what was observed — never from the case's expectation.
 * A case that commits when it was supposed to refuse is graded against the
 * commit it actually made, so the narration verdict stays honest even when the
 * state verdict has already failed.
 */
export function deriveCaseState(observed: ObservedCase): ContactCaseState {
  const { turn, beforeSetup, afterExchange } = observed;
  const endedLiveContact = beforeSetup.contactIds.some((id) => !afterExchange.contactIds.includes(id));
  return {
    committed: turn?.committed === true,
    ...(turn?.committed === true && turn.directSkinContact !== undefined
      ? { layer: turn.directSkinContact ? ("skin" as const) : ("through_layer" as const) }
      : {}),
    endedLiveContact,
    contactLiveAfter: afterExchange.contactIds.length > 0,
  };
}
