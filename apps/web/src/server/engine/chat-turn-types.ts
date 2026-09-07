import type {
  CharacterProfile,
  ChatActionId,
  ContactRejectionReason,
  ContactResolutionStatus,
  ContactUnresolvedReason,
  DiagnosticSink,
} from "@/contracts";
import type { ChatContactPremiseKind } from "./chat-contact/presentation";
import type { ChatContactAct } from "./chat-contact/identity";
import type { ChatState } from "./chat-state/types";

export type ChatExchangeKind = "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";

export type { ChatContactPremiseKind } from "./chat-contact/presentation";

/**
 * One exchange's physical act, as the narrator was told about it.
 *
 * Deliberately a projection rather than the internals: the resolved outcome, the
 * premise the seam chose, and the rendered guidance lines — never the permission
 * ledger, the evidence chain, or the policy read. A consumer grading whether the
 * prose honoured the state needs what the state SAID; giving it the record
 * behind that would let a trial grade itself against facts the prompt never
 * carried.
 */
export interface ChatContactTurnRecord {
  /** Absent when the message produced no contact act at all. */
  readonly act?: {
    readonly kind: ChatContactAct["actionKind"];
    readonly gesture: string;
    readonly targetLocationId: string;
    readonly actionId: string;
  };
  /**
   * The resolver's own status, and its typed reason when it has one.
   *
   * Both carry their closed unions rather than `string`. This record is the
   * whole input to an instrument that gates a rollout ruling, and against a bare
   * `string` a misspelled expectation compiles, never matches, and reports a
   * lane defect that does not exist.
   *
   * `reason` spans BOTH reason vocabularies, because two different statuses
   * carry one: `rejected` names a rejection reason and `unresolved` names an
   * unresolved one. Narrowing this to the unresolved half would have made the
   * explicit-denial case — `rejected` / `permission_denied`, one of the six the
   * rerun must cover — untypeable.
   */
  readonly status?: ContactResolutionStatus;
  readonly reason?: ContactRejectionReason | ContactUnresolvedReason;
  /** The outcome's stable result codes — the same list the fingerprint folds. */
  readonly resultCodes: readonly string[];
  /** True only when the exchange durably recorded the contact. */
  readonly committed: boolean;
  /** The committed contact's id, when there is one. */
  readonly contactId?: string;
  /** Skin or through a layer, as RECORDED — absent unless the contact committed. */
  readonly directSkinContact?: boolean;
  /** Contacts this exchange ended, with the reason each ended for. */
  readonly ended: readonly { readonly contactId: string; readonly reason: string }[];
  /** Which unresolved gap earned a narrator line, when one did. */
  readonly premiseKind?: ChatContactPremiseKind;
  /** The exact physical-guidance lines handed to the narrator this turn. */
  readonly guidanceLines: readonly string[];
}

export interface SubmitChatMessageInput {
  /** The conversation (already authorized + not archived — the route owns both checks). */
  chatId: string;
  /** The participant's memory group — the RAG scope for recall + writes. */
  memoryGroupId: string;
  /** The (v1 single) participant character row slice. */
  character: { id: string; name: string; profile: unknown };
  /**
   * The full sort-ordered roster — the first entry
   * describes the same primary as `character`/`memoryGroupId`. Absent or length 1
   * ⇒ the 1-on-1 path, byte-identical prompts. Length > 1 ⇒ the ensemble frame:
   * per-member state (present members drift, away freeze), tier-1
   * memory legs, and per-member activity-recency stamping post-turn.
   */
  roster?: readonly { characterId: string; memoryGroupId: string; name: string; profile: unknown }[];
  kind: ChatExchangeKind;
  /** The player's line — required for `send`, ignored for the other kinds. */
  content?: string;
  /**
   * Composer register — `send` only:
   * "narrator" marks `content` as story narration authored by the player as
   * storyteller, never their own POV. Persisted on the user line's meta (the stored
   * text stays byte-verbatim); regenerate/rerun recover it from the stored line.
   */
  inputMode?: "player" | "narrator";
  /**
   * The target user-message id — required for `kind: "rerun"`, ignored otherwise. The
   * rerun snips this line's successors and re-runs from it (the line itself is reused,
   * never deleted or re-inserted).
   */
  targetMessageId?: string;
  /**
   * Bounded-wait budget (ms) for re-acquiring the lock on a `kind: "rerun"`, after
   * stopping any in-flight reply. Defaults to CHAT_RERUN_LOCK_WAIT_MS; overridable so a
   * caller (or a test of the contended path) can tune how long a rerun waits before
   * giving up with `chat_busy`.
   */
  rerunLockWaitMs?: number;
  /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
  model?: string;
  /**
   * "Has something to say" opener: the open loop the player tapped,
   * threaded as the continue beat's cue line so the character opens about exactly
   * that. Only read for `kind: "continue"`.
   */
  cue?: string;
  /**
   * Reopen-opener initiative — `continue` only: the
   * character reaches out first with a server-built cue (open loops + wants +
   * the "a life meanwhile" license, comms register when apart). Player-tapped;
   * generation is never background.
   */
  initiative?: boolean;
  /**
   * Action-beat chip — `action_beat` only: the tapped
   * chip id. The server builds a register-aware synthetic cue for it and applies the
   * chip's deterministic state effect to the primary's drifted state pre-narration —
   * so the reply reflects the shift — rollback-safe via the pre-exchange snapshot. No
   * player line is persisted; the id rides the reply's `meta.actionBeat`.
   */
  action?: ChatActionId;
  /**
   * Player-attached photo ids — `send` only. Validated +
   * claimed against this chat's ready `chat_upload` rows (foreign ids dropped), then
   * described by ONE batched vision call whose output rides the user line's meta.
   */
  attachmentIds?: readonly string[];
  /**
   * "Auto at big moments" hook: fired fire-and-forget after the finalizer
   * when the exchange landed a stage crossing / strong reaction AND the chat's
   * `sceneAuto` mode is "milestones". The route owns what happens (queue a scene
   * render anchored to this reply) — the engine only signals.
   */
  onBigMoment?: (info: { assistantMessageId: string }) => void;
  /**
   * Selfie hook: fired fire-and-forget after the finalizer
   * when the reply actually sent a photo (pulse-read + gate-armed). The route
   * queues the selfie render anchored to this reply. `characterId` names the
   * SENDER: in a group the addressed member sends it, so
   * the render must use that character, not always the primary.
   */
  onSelfie?: (info: { assistantMessageId: string; characterId: string }) => void;
  /**
   * Post-settle hook (the successor shadow leg): fired fire-and-forget
   * after the finalizer on EVERY successfully settled exchange. The route owns
   * what happens (the shadow comparison leg for `successor_shadow` chats); the
   * engine only signals. `content` is the player's line ("" for synthetic-cue
   * kinds) so the consumer never re-reads the transcript for it.
   */
  onSettled?: (info: { assistantMessageId: string; content: string }) => void;
  /**
   * Contact-turn observer: fired once, AFTER the physical-guidance block for this
   * exchange is rendered and BEFORE the reply streams, with what the narrator was
   * actually told about the player's physical act.
   *
   * It exists because the turn's guidance is deliberately not persisted — it is
   * recomputable from the same cut and the same message, which is what makes a
   * retake reproduce it. That equivalence holds only BEFORE the exchange folds
   * its commits, so a trial that re-derived the guidance afterwards would be
   * reading it against state the turn had already changed. Anything grading a
   * live romantic turn has to see the bytes the model saw, at the moment it saw
   * them.
   *
   * Read-only and fire-and-forget, like the other hooks here: a throwing observer
   * is logged and swallowed, never allowed to cost the exchange.
   */
  onContactTurn?: (record: ChatContactTurnRecord) => void;
  /**
   * Diagnostics observer: every diagnostic this exchange files is teed here as it
   * is pushed, alongside the pipeline's own collector (which still drives the
   * summary log line). The turn's degradation record is otherwise write-only —
   * the engine logs the codes and drops the sink — so this is the first-class
   * seam for the admin inspector and for integration tests that must assert a
   * live turn's codes rather than scraping the log.
   *
   * Diagnostics accrue through the settle step, which runs when the reply stream
   * completes: a caller reading this sink must drain `result.stream` first, or it
   * sees only the pre-stream half of the turn.
   */
  sink?: DiagnosticSink;
}

export type SubmitChatMessageResult =
  | {
      ok: false;
      code: "chat_busy" | "nothing_to_regenerate" | "invalid_rerun_target" | "rerun_requires_branch";
      message: string;
    }
  | { ok: true; stream: AsyncGenerator<string, void, unknown> };

/** A non-primary member at the restored, drifted turn cut. */
export interface ChatTurnMember {
  characterId: string;
  memoryGroupId: string;
  name: string;
  profile: CharacterProfile;
  preExchangeState: ChatState | null;
  state: ChatState;
}
