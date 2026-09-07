import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  activeRomanticPermissionGrants,
  affordanceSubjectId,
  diag,
  type DiagnosticSink,
  type RomanticPermissionEvent,
} from "@/contracts";
import type { AgentRunDescription } from "@/contracts/turns/agent-failure";
import {
  buildRomanticPermissionDigest,
  parseRomanticPermissionDecisionOutput,
  romanticPermissionDecisionTriggered,
  validateRomanticPermissionDecisions,
  type RomanticPermissionDecisionCandidate,
  type RomanticPermissionDigestBuild,
} from "@/contracts/turns/romantic-permission-decision";
import { agentModelId, generateChecked, withGenerateTimeout, type AgentTelemetry } from "../ai";
import { characterChatMessages, characterChats, db } from "../db";
import { log } from "../log";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import {
  appendChatPermissionEventsWithInvalidation,
  chatPermissionReplyEventRef,
  foldChatPermissionProjection,
  listChatPermissionEvents,
} from "./chat-permission-events";
import {
  CHAT_ROMANTIC_PERMISSION_DECISION_MAX_OUTPUT_TOKENS,
  CHAT_ROMANTIC_PERMISSION_DECISION_TIMEOUT_MS,
} from "./constants";
import {
  buildChatRomanticPermissionDecisionPrompt,
  CHAT_ROMANTIC_PERMISSION_DECISION_SYSTEM,
} from "./prompts/chat-romantic-permission-decision";
import { chatRomanticPermissionEnabled } from "./prompts/constants";

/**
 * THE NPC ROMANTIC-PERMISSION DECISION LEG — grant, denial, absence and
 * withdrawal, under chronology and non-retroactivity: how an NPC's own
 * dialogue or conduct creates
 * or removes `romantic_touch` permission in production.
 *
 * A SINGLE-PHASE leg at the settle tail, strictly AFTER the exchange's last
 * scene writer on each completing path (the common reply-scene leg XOR the
 * legacy ending block, and the opening early-return): when the flag is on and
 * the cheap pure trigger fires, it reloads the committed state FRESH (the
 * assistant bytes, the permission ledger, the story clock — never the
 * pipeline's stale variables), makes AT MOST ONE classifier call over the
 * committed reply plus a compact digest, validates the output with the
 * deterministic contract validator, and appends the surviving events through
 * `appendChatPermissionEventsWithInvalidation` — the ONE atomic entry point,
 * whose withdrawal sweep ends dependent contacts in the same transaction (this
 * module writes no sweep code and never touches the scene column itself, which
 * is why running after the last scene writer keeps it clear of the scene CAS).
 *
 * The classifier's input is ONLY the committed assistant reply plus the digest
 * (roster refs + current standing grants). Player-authored text is
 * structurally excluded — nothing of the player's message enters the call —
 * and the validator's authorship gate additionally refuses evidence the reply
 * merely quotes or echoes from the player (ruling 5).
 *
 * CONSERVATIVE BY CONSTRUCTION: every failure — stale bytes, timeout,
 * provider error, malformed output, validator drop, append conflict — is a
 * diagnostic and ZERO events, never a thrown error and never a blocked reply
 * (docs/resilience.md; the degraded direction for a permission owner is always
 * "less is granted"). There is deliberately no durable envelope/tombstone for
 * this leg in the MVP; the permission ledger rows ARE the durable product, and
 * a possible future optimization is the scene leg's two-half begin/finish
 * split (launch beside settlement) — noted, not built.
 */

/** The one leg id every diagnostic/telemetry row of the classifier call files under. */
const CLASSIFY_LEG_ID = "romantic_permission_decision.classify";

/** The leg-level degradation code (timeout, provider failure, malformed envelope). */
export const ROMANTIC_PERMISSION_DECISION_DEGRADED = "romantic_permission_decision.degraded";
/** The committed bytes changed or vanished before the leg could read them. */
export const ROMANTIC_PERMISSION_DECISION_STALE_REPLY = "romantic_permission_decision.stale_reply";
/** A malformed decision item (its valid siblings still proceed). */
export const ROMANTIC_PERMISSION_DECISION_SLOT_MALFORMED = "romantic_permission_decision.slot_malformed";
/** The success record: how many events were appended, and what the sweep ended. */
export const ROMANTIC_PERMISSION_DECISION_RECORDED = "romantic_permission_decision.recorded";
/** A denial-shaped decision had no player attempt in this exchange to bind to. */
export const ROMANTIC_PERMISSION_DECISION_NO_CURRENT_ATTEMPT =
  "romantic_permission_decision.no_current_attempt";

const DIAG_PATH = "romantic_permission_decision";

// ---------------------------------------------------------------------------
// The classifier call
// ---------------------------------------------------------------------------

interface PermissionClassifierResult {
  /** The raw model value — judged ONLY by `parseRomanticPermissionDecisionOutput`. */
  readonly raw: unknown;
  readonly degraded: boolean;
  readonly timedOut: boolean;
}

/**
 * The transport schema `generateChecked` parses with: any JSON object. LOOSE
 * ON PURPOSE (the scene-decision precedent): the per-digest ref schemas are
 * `z.custom` closures a rendered JSON Schema cannot express, and the contract
 * parser is the sole judge of shape — a strict schema here would launder
 * "malformed" into "degraded". The closed schema reaches the model through the
 * system prompt instead.
 */
const classifierTransportSchema = z.record(z.string(), z.unknown());

/** Inspector activity line for a clean run. */
function describePermissionDecision(value: Record<string, unknown>): AgentRunDescription {
  const decisions = Array.isArray(value.decisions) ? value.decisions.length : 0;
  return { summary: decisions === 0 ? "no permission decisions" : `${decisions} permission decision(s)`, details: [] };
}

/**
 * The ONE classifier call — the reply-scene leg's recipe verbatim (reasoning
 * off, latency-sorted routing, no repair, temperature 0) under the leg's own
 * hard timeout. The returned promise NEVER rejects: every failure shape
 * resolves as `degraded`, and the aborted controller IS the timed-out flag.
 */
function runPermissionClassifier(input: {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly build: RomanticPermissionDigestBuild;
  readonly reply: string;
  readonly sink?: DiagnosticSink;
}): Promise<PermissionClassifierResult> {
  const controller = new AbortController();
  const modelId = agentModelId();
  const prompt = buildChatRomanticPermissionDecisionPrompt({ digest: input.build.digest, reply: input.reply });
  const telemetry: Partial<AgentTelemetry> = {
    legId: CLASSIFY_LEG_ID,
    chatId: input.chatId,
    messageId: input.assistantMessageId,
    modelId,
    promptChars: CHAT_ROMANTIC_PERMISSION_DECISION_SYSTEM.length + prompt.length,
    maxOutputTokens: CHAT_ROMANTIC_PERMISSION_DECISION_MAX_OUTPUT_TOKENS,
  };
  const work = generateChecked<Record<string, unknown>>({
    schema: classifierTransportSchema,
    system: CHAT_ROMANTIC_PERMISSION_DECISION_SYSTEM,
    prompt,
    modelId,
    temperature: 0,
    maxOutputTokens: CHAT_ROMANTIC_PERMISSION_DECISION_MAX_OUTPUT_TOKENS,
    code: CLASSIFY_LEG_ID,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
    telemetry,
  });
  return withGenerateTimeout(
    work,
    controller,
    CHAT_ROMANTIC_PERMISSION_DECISION_TIMEOUT_MS,
    `${CLASSIFY_LEG_ID}.timeout`,
    input.sink,
    telemetry,
    describePermissionDecision,
  ).then((result) => ({
    raw: result.value,
    degraded: result.degraded || result.value === null,
    timedOut: controller.signal.aborted,
  }));
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

/** One roster member as the pipeline hands it in — stable roster order (the ref assignment). */
export interface ChatRomanticPermissionRosterMember {
  readonly characterId: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface ChatRomanticPermissionDecisionInput {
  readonly chatId: string;
  readonly assistantMessageId: string;
  /** The persisted reply bytes — settle's `full`, exactly as inserted/updated. */
  readonly reply: string;
  readonly roster: readonly ChatRomanticPermissionRosterMember[];
  /** The one player-side contact attempt this reply answers, when one existed. */
  readonly currentAttemptActionId?: string;
  /** The active contact produced by that attempt, when it committed. */
  readonly currentAttemptContactId?: string;
  readonly sink?: DiagnosticSink;
}

/**
 * Run the leg for one committed reply. Fenced whole: any throw degrades to
 * "no permission events this exchange" with a log line, never a failed reply.
 */
export async function runChatRomanticPermissionDecision(input: ChatRomanticPermissionDecisionInput): Promise<void> {
  try {
    await runLive(input);
  } catch (error) {
    log.error("engine.chat", "romantic permission decision leg failed", {
      chatId: input.chatId,
      assistantMessageId: input.assistantMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
    // The sink too, not just the log: an unexpected throw here is
    // indistinguishable from "the reply said nothing about permission" to the
    // inspector and to a degradation test, which is how a persistently failing
    // leg stays invisible. Same code the expected degradations file, so one
    // query answers "did this leg produce nothing on purpose?".
    input.sink?.push(
      diag("warn", ROMANTIC_PERMISSION_DECISION_DEGRADED, "permission decision leg failed; no events this exchange", {
        path: DIAG_PATH,
        context: { chatId: input.chatId, assistantMessageId: input.assistantMessageId, unexpected: true },
      }),
    );
  }
}

async function runLive(input: ChatRomanticPermissionDecisionInput): Promise<void> {
  const { sink } = input;
  if (!chatRomanticPermissionEnabled()) return;
  // The cost gate, before ANY IO: no permission-shaped language near touch
  // context ⇒ no spend. A miss is fail-closed — permission stays absent.
  if (!romanticPermissionDecisionTriggered(input.reply)) return;

  // --- Fresh committed state, never the pipeline's stale variables ----------
  const [assistantRow] = await db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, input.assistantMessageId), eq(characterChatMessages.chatId, input.chatId)))
    .limit(1);
  if (assistantRow === undefined || assistantRow.role !== "assistant" || assistantRow.content !== input.reply) {
    // The bytes the trigger read are gone (deleted or rewritten mid-settle) —
    // a permission event grounded in them would be grounded in nothing.
    sink?.push(
      diag("warn", ROMANTIC_PERMISSION_DECISION_STALE_REPLY, "assistant reply missing or changed; no permission decision", {
        path: DIAG_PATH,
        context: { chatId: input.chatId, assistantMessageId: input.assistantMessageId },
      }),
    );
    return;
  }

  // The ledger, listed and folded FRESH — the digest's standing grants are what
  // a `withdrawn` may lawfully apply to (the validator's `no_standing_grant`).
  const ledgerRows = await listChatPermissionEvents(input.chatId, sink);
  const projection = foldChatPermissionProjection(ledgerRows, sink);

  const roster = input.roster.map((member) => ({
    subjectId: affordanceSubjectId(member.characterId),
    name: member.name,
    aliases: member.aliases,
  }));
  const build = buildRomanticPermissionDigest({
    playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
    roster,
    standingGrants: activeRomanticPermissionGrants(projection).map((entry) => ({
      permittedActorId: entry.permittedActorId,
      grantingTargetId: entry.grantingTargetId,
    })),
  });
  if (build.digest.npcs.length === 0) return; // nobody who could grant

  // --- The one classifier call ----------------------------------------------
  const result = await runPermissionClassifier({
    chatId: input.chatId,
    assistantMessageId: input.assistantMessageId,
    build,
    reply: input.reply,
    ...(sink === undefined ? {} : { sink }),
  });
  if (result.degraded) {
    sink?.push(
      diag(
        "warn",
        ROMANTIC_PERMISSION_DECISION_DEGRADED,
        result.timedOut
          ? "permission classifier timed out; no permission events this exchange"
          : "permission classifier degraded; no permission events this exchange",
        { path: DIAG_PATH, context: { timedOut: result.timedOut } },
      ),
    );
    return;
  }

  // --- Parse (absent vs malformed DISTINCT) ---------------------------------
  const parse = parseRomanticPermissionDecisionOutput(build.digest, result.raw);
  if (parse.status === "malformed_envelope") {
    sink?.push(
      diag("warn", ROMANTIC_PERMISSION_DECISION_DEGRADED, "permission classifier output envelope malformed; zero events", {
        path: DIAG_PATH,
        context: { issues: [...parse.issues] },
      }),
    );
    return;
  }
  const candidates: RomanticPermissionDecisionCandidate[] = [];
  for (const slot of parse.decisions) {
    if (slot.status === "malformed") {
      sink?.push(
        diag("warn", ROMANTIC_PERMISSION_DECISION_SLOT_MALFORMED, "a permission decision item was malformed and dropped", {
          path: DIAG_PATH,
          context: { issues: [...slot.issues] },
        }),
      );
      continue;
    }
    candidates.push(slot.candidate);
  }
  if (candidates.length === 0) return; // the expected common answer: nothing decided

  // --- Deterministic validation ---------------------------------------------
  const validation = validateRomanticPermissionDecisions({
    reply: input.reply,
    digest: build.digest,
    candidates,
  });
  for (const drop of validation.drops) {
    sink?.push(
      diag("info", `romantic_permission_decision.${drop.reason}`, `permission decision dropped: ${drop.reason}`, {
        path: DIAG_PATH,
        context: { index: drop.index, detail: drop.detail },
      }),
    );
  }
  if (validation.accepted.length === 0) return;

  // --- Fresh story clock, then the atomic append ----------------------------
  const [chatRow] = await db()
    .select({ clockMinutes: characterChats.clockMinutes })
    .from(characterChats)
    .where(eq(characterChats.id, input.chatId))
    .limit(1);
  if (chatRow === undefined) return; // the chat vanished mid-settle — nothing to record against
  const storyMinute = Math.max(0, Math.trunc(chatRow.clockMinutes));

  const eventRef = chatPermissionReplyEventRef(input.assistantMessageId);
  const events: RomanticPermissionEvent[] = [];
  for (const [index, decision] of validation.accepted.entries()) {
    const permittedActorId = build.handles.subjectIdByRef.get(decision.permittedActorRef);
    const grantingTargetId = build.handles.subjectIdByRef.get(decision.grantingTargetRef);
    if (permittedActorId === undefined || grantingTargetId === undefined) continue; // structurally impossible; defensive
    const attemptActionId = decision.kind === "attempt_denied" ? input.currentAttemptActionId : undefined;
    const attemptContactId = decision.kind === "attempt_denied" ? input.currentAttemptContactId : undefined;
    if (decision.kind === "attempt_denied" && attemptActionId === undefined) {
      sink?.push(
        diag(
          "info",
          ROMANTIC_PERMISSION_DECISION_NO_CURRENT_ATTEMPT,
          "attempt denial had no current contact attempt to bind; event dropped",
          { path: DIAG_PATH, context: { index } },
        ),
      );
      continue;
    }
    events.push({
      // Deterministic identity: a retried settle re-derives the identical
      // event ids and conflicts harmlessly (the ledger's idempotency law).
      eventId: `${eventRef}:${index}`,
      branchId: input.chatId,
      permittedActorId,
      grantingTargetId,
      scope: "romantic_touch",
      // This leg can only ever author NPC decisions — `developer_override` is
      // structurally impossible from here, because chat content is never an
      // override command.
      kind: decision.kind,
      sourceKind: "npc_decision",
      sourceMessageId: input.assistantMessageId,
      storyTime: storyMinute,
      orderInSource: index,
      ...(attemptActionId === undefined ? {} : { attemptActionId }),
      ...(attemptContactId === undefined ? {} : { attemptContactId }),
      evidenceOffset: decision.evidenceOffset,
    });
  }
  if (events.length === 0) return;

  const appended = await appendChatPermissionEventsWithInvalidation({
    chatId: input.chatId,
    // The assistant row is the guard: retaking or deleting the reply prunes
    // these rows (the wired `deleteChatPermissionEventsForGuard` twin).
    guardMessageId: input.assistantMessageId,
    eventRef,
    storyMinute,
    events,
    ...(sink === undefined ? {} : { sink }),
  });
  if (appended.status === "recorded") {
    sink?.push(
      diag("info", ROMANTIC_PERMISSION_DECISION_RECORDED, `recorded ${events.length} permission event(s)`, {
        path: DIAG_PATH,
        context: {
          events: events.map((event) => `${event.kind} ${event.permittedActorId} ← ${event.grantingTargetId}`),
          endedContactIds: [...appended.endedContactIds],
        },
      }),
    );
  }
  // `mismatched` and `refused` already filed their own error diagnostics
  // inside the append — nothing further to add, and nothing was written.
}
