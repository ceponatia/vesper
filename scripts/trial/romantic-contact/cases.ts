import type { ChatContactTurnRecord } from "@/server/engine";
import type { ContactCaseState } from "./oracle";

/**
 * The six live cases the rollout rerun must cover, and the pure derivation that
 * turns a captured turn into something the oracle can grade.
 *
 * Nothing here talks to a database or a model, which is the point: the parts of
 * the rerun that decide anything are testable without a proof window open, and
 * only the thin driver in `run.ts` needs Fly.
 */

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export type PermissionSetup = "none" | "grant" | "deny" | "withdraw";

export interface TrialCase {
  readonly id: string;
  /** What this case is here to settle, in one plain sentence. */
  readonly proves: string;
  /** Permission state to establish BEFORE the line is sent. */
  readonly setup: PermissionSetup;
  /** The player's line, verbatim. */
  readonly line: string;
  /**
   * Re-run the previous exchange instead of sending a new line — the retake
   * case. `line` is then the line being re-run, for the record only.
   */
  readonly rerunPrevious?: boolean;
  /**
   * What the case is EXPECTED to do, recorded for the report and deliberately
   * never fed to the oracle. A case that does something else is a finding; an
   * oracle told the expected answer would hide it.
   */
  readonly expectation: string;
}

/**
 * `natural_named` is the case the first proof could not run at all. It writes
 * the character's name the way a player does, which before the name-resolution
 * fix produced no act — so the permission owner was never asked, and the turn
 * looked identical to a refusal. It is deliberately placed AFTER a grant so a
 * silent non-detection cannot be mistaken for a correct refusal.
 */
export const TRIAL_CASES: readonly TrialCase[] = [
  {
    id: "no_grant",
    proves: "a romantic touch nobody authorised does not become part of the world, and the prose does not invent it",
    setup: "none",
    line: "I caress your arm.",
    expectation: "no commit, no ledger row, and a reply that neither depicts the touch landing nor invents a refusal",
  },
  {
    id: "explicit_denial",
    proves: "a recorded denial refuses the touch, and the narration may say so",
    setup: "deny",
    line: "I caress your arm.",
    expectation: "no commit; a refusal IS on the record, so a reply that portrays one is correct",
  },
  {
    id: "natural_named",
    proves: "a player writing the character's name the way players write it produces a real attempt",
    setup: "grant",
    line: "I walk over to Sabrina. I caress Sabrina's arm.",
    expectation: "the name resolves, the act is produced, and the touch commits",
  },
  {
    id: "commit",
    proves: "an authorised, physically possible touch commits and the narration honours it",
    setup: "grant",
    line: "I step closer to you. I caress your arm.",
    expectation: "committed, with the recorded material fact matching what the reply describes",
  },
  {
    id: "withdrawal",
    proves: "withdrawing permission ends a touch already in progress and the next reply does not continue it",
    setup: "withdraw",
    line: "I stay where I am.",
    expectation: "the live contact ends, nothing is live afterwards, and the reply does not write it as continuing",
  },
  {
    id: "retake",
    proves: "regenerating the committing turn leaves one contact rather than two",
    setup: "grant",
    line: "I step closer to you. I caress your arm.",
    rerunPrevious: true,
    expectation: "one active contact after the retake, and no duplicate start in the ledger",
  },
];

// ---------------------------------------------------------------------------
// Deriving what the oracle grades
// ---------------------------------------------------------------------------

/**
 * The scene facts the runner reads either side of the exchange.
 *
 * Only the count of live player↔character contacts is needed, and reading it
 * from the projection either side is what makes "the withdrawal ended it" an
 * observed fact rather than an inference from the commit record.
 */
export interface ContactStateSnapshot {
  readonly liveContactIds: readonly string[];
}

/**
 * Which resolver outcomes record a refusal the prose is entitled to portray.
 *
 * ONLY a `rejected` status. This is the strict reading, and it is strict on
 * purpose: `unresolved` means nothing was decided, and the contact system's
 * standing law is that something unknown is not something denied. An
 * `explicit_transition_required` is not a refusal either — it says the scene
 * would have to do something first, which the guidance already words for the
 * narrator without anybody declining anything.
 *
 * This is stricter than the first proof's by-eye grading, which accepted a reply
 * where the character drew her arm back on an `unresolved` reach outcome. Under
 * this oracle that reply is an invented refusal, and the rerun will say so.
 */
export function refusalRecorded(record: ChatContactTurnRecord): boolean {
  return record.status === "rejected";
}

/**
 * One captured exchange as the oracle receives it.
 *
 * Derived ENTIRELY from what the turn recorded and what the projection says
 * either side — never from the case's `expectation`. A case that commits when it
 * was supposed to refuse is graded against the commit it actually made.
 */
export function deriveCaseState(input: {
  readonly record: ChatContactTurnRecord;
  readonly before: ContactStateSnapshot;
  readonly after: ContactStateSnapshot;
}): ContactCaseState {
  const { record, before, after } = input;
  const endedLiveContact = before.liveContactIds.some((contactId) => !after.liveContactIds.includes(contactId));
  return {
    committed: record.committed,
    ...(record.committed && record.directSkinContact !== undefined
      ? { layer: record.directSkinContact ? ("skin" as const) : ("through_layer" as const) }
      : {}),
    refusalRecorded: refusalRecorded(record),
    endedLiveContact,
    contactLiveAfter: after.liveContactIds.length > 0,
  };
}
