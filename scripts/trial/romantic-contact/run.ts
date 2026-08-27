import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { isDemoMode } from "@/server/ai";
import {
  chatContactActionsEnabled,
  chatPhysicalConstraintsEnabled,
  chatRomanticPermissionDevOverrideEnabled,
  chatRomanticPermissionEnabled,
  submitChatMessage,
  type ChatContactTurnRecord,
} from "@/server/engine";
import {
  assertRequiredState,
  deriveCaseState,
  TRIAL_CASES,
  type ObservedCase,
  type PairContactSnapshot,
  type StateFailure,
  type TrialCase,
} from "./cases";
import {
  applyPermissionSetup,
  bindAttemptDenial,
  newestAssistantMessageId,
  newestUserMessage,
  readPairContacts,
  readPermissionState,
  resolveTrialTarget,
  type TrialTarget,
} from "./driver";
import { gradeContactCase, judgeContactReply, type ContactCaseGrade, type ContactProseVerdict } from "./oracle";

/**
 * The romantic contact rollout rerun.
 *
 * The first proof was run by hand through the UI and written up from what the
 * screen showed. It found the thing that matters — a refusal renders no narrator
 * line, so the prose described the caress as landing — but it could not SETTLE
 * it, because the record it left is a summary rather than the turns. This runner
 * exists so the rerun leaves the turns.
 *
 * Per case it preserves the sanitized input, the actual reply, the guidance the
 * narrator was handed (captured DURING the turn through `onContactTurn`, not
 * re-derived afterwards against state the exchange has already folded), and the
 * pair's contact state before setup, after setup and after the exchange.
 *
 * Then it grades TWICE, and both have to pass:
 *
 * 1. `assertRequiredState` — did the case do what it required of the world?
 * 2. `gradeContactCase` — does the prose contradict what actually happened?
 *
 * The order matters. Prose consistency alone cannot pass a case: it only ever
 * asks whether the narration contradicts the state, so on its own it would pass
 * a withdrawal that ended nothing and a retake that left two contacts.
 *
 *   pnpm trial:romantic-contact --dry-run    # the plan and the flag check, no turns
 *   pnpm trial:romantic-contact              # the full six-case run
 *
 * RUN IT ON FLY, over `fly ssh console`, with the proof flags enabled for the
 * window only — the same conditions as the first proof, and the same obligation
 * to revert them afterwards.
 */

const OUT_DIR = process.env.TRIAL_OUT_DIR ?? "evidence/romantic-contact-rerun";
const CHARACTER_NAME = process.env.TRIAL_CHARACTER ?? "Sabrina Vale";
const QA_USER_ID = process.env.TRIAL_USER_ID ?? "uxtestmaina1b2c3d4e5f6g7";

/**
 * Every flag the lane needs, and what its absence would silently do to the run.
 *
 * All four are checked because each fails QUIETLY and plausibly. Without
 * `CHAT_CONTACT_ACTIONS` nothing in the lane runs and every case records an
 * empty turn; without `CHAT_ROMANTIC_PERMISSION` the romantic producer never
 * fires, so a romantic line detects nothing and reads exactly like a refusal;
 * without the developer override the setup cannot establish a grant, so the
 * committing cases refuse and look like correct denials; and without
 * `CHAT_PHYSICAL_CONSTRAINTS` the premise this rerun exists to observe is
 * computed and then dropped before it reaches the prompt. Any one of them alone
 * would produce a plausible and entirely wrong report.
 */
const REQUIRED_FLAGS: readonly { readonly name: string; readonly effective: () => boolean; readonly cost: string }[] = [
  {
    name: "CHAT_CONTACT_ACTIONS",
    effective: chatContactActionsEnabled,
    cost: "the contact lane never runs, and every case records an empty turn",
  },
  {
    name: "CHAT_ROMANTIC_PERMISSION",
    effective: chatRomanticPermissionEnabled,
    cost: "the romantic producer never fires, so a romantic line reads exactly like a refusal",
  },
  {
    name: "CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE",
    effective: chatRomanticPermissionDevOverrideEnabled,
    cost: "the setup cannot grant, so the committing cases refuse and look like correct denials",
  },
  {
    name: "CHAT_PHYSICAL_CONSTRAINTS",
    effective: chatPhysicalConstraintsEnabled,
    cost: "the unresolved premise is computed and then dropped before it reaches the prompt",
  },
];

interface CaseRecord {
  readonly caseId: string;
  readonly proves: string;
  readonly setup: string;
  readonly input: string;
  /** For a rerun, the persisted message actually re-run, read back from the transcript. */
  readonly rerunOf?: { readonly messageId: string; readonly content: string };
  readonly reply: string;
  readonly guidanceLines: readonly string[];
  readonly turn: ChatContactTurnRecord | null;
  readonly beforeSetup: PairContactSnapshot;
  readonly afterSetup: PairContactSnapshot;
  readonly afterExchange: PairContactSnapshot;
  readonly permissionStanding: string;
  readonly attemptDeniedBound: boolean;
  readonly stateFailures: readonly StateFailure[];
  readonly verdict: ContactProseVerdict | null;
  readonly prose: ContactCaseGrade | null;
  readonly judgeDegraded: boolean;
  readonly pass: boolean;
}

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    printPlan();
    return;
  }

  // Refusals rather than a degraded run: a rerun that graded a lane which never
  // executed would produce a clean report about nothing, and the rollout ruling
  // would be made against it.
  if (isDemoMode()) throw new Error("demo mode is on: this trial must run against the real narrator");
  const missing = REQUIRED_FLAGS.filter((flag) => !flag.effective());
  if (missing.length > 0) {
    throw new Error(
      `these flags are not effective, so the run would prove nothing:\n${missing
        .map((flag) => `  ${flag.name} — without it, ${flag.cost}`)
        .join("\n")}`,
    );
  }

  const chatId = process.env.TRIAL_CHAT_ID;
  if (!chatId) throw new Error("set TRIAL_CHAT_ID to an existing one-on-one QA chat with this character");
  const target = await resolveTrialTarget({ chatId, ownerId: QA_USER_ID, characterName: CHARACTER_NAME });
  console.log(`character ${target.characterName} (${target.characterId})`);
  console.log(`fixture chat ${target.chatId}\n`);
  await requireCleanBaseline(target);

  const records: CaseRecord[] = [];
  let priorPairContactIds: readonly string[] = [];
  let previousUserMessage: { id: string; content: string } | null = null;

  try {
    for (const entry of TRIAL_CASES) {
      console.log(`— ${entry.id}`);
      const beforeSetup = await readPairContacts(target.chatId, target.subjectId);
      if (entry.setup !== "none") {
        await applyPermissionSetup({ chatId: target.chatId, target: target.subjectId, setup: entry.setup });
      }
      const afterSetup = await readPairContacts(target.chatId, target.subjectId);
      if (entry.setup !== "none") {
        console.log(
          `  setup ${entry.setup}: pair contacts ${beforeSetup.contactIds.length} → ${afterSetup.contactIds.length}`,
        );
      }

      let exchange = await runExchange({ target, entry, previousUserMessage });

      // The denial case's second half: bind a denial to the attempt the first
      // send actually produced, then rerun THAT exchange. The rerun reuses the
      // same guard message, so the event ref — and therefore the action id — is
      // reproduced rather than guessed.
      if (entry.bindDenial === true) {
        exchange = await denyAndRerun({ target, entry, exchange, previousUserMessage });
      }

      const afterExchange = await readPairContacts(target.chatId, target.subjectId);
      const permission = await readPermissionState(target.chatId, target.subjectId);
      const attemptActionId = exchange.turn?.act?.actionId;
      const observed: ObservedCase = {
        turn: exchange.turn,
        beforeSetup,
        afterSetup,
        afterExchange,
        permissionStanding: permission.standing,
        attemptDeniedBound:
          attemptActionId !== undefined && permission.deniedAttemptActionIds.includes(attemptActionId),
        priorPairContactIds,
      };

      const stateFailures = assertRequiredState(observed, entry.expect);
      const judged = await judgeContactReply({ reply: exchange.reply, playerLine: entry.line });
      const prose = judged.verdict === null ? null : gradeContactCase(deriveCaseState(observed), judged.verdict);
      const pass = stateFailures.length === 0 && prose !== null && prose.pass;

      records.push({
        caseId: entry.id,
        proves: entry.proves,
        setup: entry.setup,
        input: entry.line,
        ...(exchange.rerunOf === undefined ? {} : { rerunOf: exchange.rerunOf }),
        reply: exchange.reply,
        guidanceLines: exchange.turn?.guidanceLines ?? [],
        turn: exchange.turn,
        beforeSetup,
        afterSetup,
        afterExchange,
        permissionStanding: permission.standing,
        attemptDeniedBound: observed.attemptDeniedBound,
        stateFailures,
        verdict: judged.verdict,
        prose,
        judgeDegraded: judged.degraded,
        pass,
      });

      console.log(
        `  ${pass ? "pass" : "FAIL"}` +
          (stateFailures.length > 0 ? ` — state: ${stateFailures.map((f) => f.field).join(", ")}` : "") +
          (prose !== null && !prose.pass ? ` — prose: ${prose.failures.map((f) => f.kind).join(", ")}` : "") +
          (judged.degraded ? " — the judge call degraded" : ""),
      );

      priorPairContactIds = afterExchange.contactIds;
      previousUserMessage = await newestUserMessage(target.chatId);
    }
  } finally {
    await writeEvidence(records);
  }

  const failed = records.filter((entry) => !entry.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${records.length} cases did not pass: ${failed.map((e) => e.caseId).join(", ")}`);
    process.exitCode = 1;
  }
}

/**
 * The clean baseline the no-grant case depends on.
 *
 * A prior standing grant, or a prior denial, would make its refusal mean
 * something else entirely — and the prose oracle would pass the turn either way,
 * yielding a clean report for a case that never tested unanswered permission. A
 * permission ledger cannot be edited back to "nobody has answered", so this is a
 * refusal rather than a repair.
 */
async function requireCleanBaseline(target: TrialTarget): Promise<void> {
  const baseline = await readPermissionState(target.chatId, target.subjectId);
  if (baseline.eventCount > 0) {
    throw new Error(
      // The count is the WHOLE chat's ledger, not this pair's — deliberately
      // stricter than the case needs, so say so rather than sending whoever runs
      // this to inspect a pair that is already clean.
      `chat ${target.chatId} already holds ${baseline.eventCount} romantic-permission entries. ` +
        "The no-grant case needs a ledger nobody has answered on, and a ledger cannot be edited back to that. " +
        "Use a fresh QA chat.",
    );
  }
  const contacts = await readPairContacts(target.chatId, target.subjectId);
  if (contacts.contactIds.length > 0) {
    throw new Error(`chat ${target.chatId} already has ${contacts.contactIds.length} live contacts on this pair`);
  }
}

// ---------------------------------------------------------------------------
// One exchange
// ---------------------------------------------------------------------------

interface ExchangeResult {
  readonly turn: ChatContactTurnRecord | null;
  readonly reply: string;
  readonly rerunOf?: { readonly messageId: string; readonly content: string };
}

async function denyAndRerun(input: {
  readonly target: TrialTarget;
  readonly entry: TrialCase;
  readonly exchange: ExchangeResult;
  readonly previousUserMessage: { id: string; content: string } | null;
}): Promise<ExchangeResult> {
  const { target, entry } = input;
  const attemptActionId = input.exchange.turn?.act?.actionId;
  if (attemptActionId === undefined) {
    throw new Error(`${entry.id}: the first send produced no attempt, so there is nothing to deny`);
  }
  const sourceMessageId = await newestAssistantMessageId(target.chatId);
  if (sourceMessageId === null) throw new Error(`${entry.id}: no assistant reply to ground the denial on`);
  await bindAttemptDenial({ chatId: target.chatId, target: target.subjectId, attemptActionId, sourceMessageId });
  console.log(`  bound a denial to ${attemptActionId}`);
  return runExchange({ target, entry, previousUserMessage: input.previousUserMessage, rerunSelf: true });
}

async function runExchange(input: {
  readonly target: TrialTarget;
  readonly entry: TrialCase;
  readonly previousUserMessage: { id: string; content: string } | null;
  readonly rerunSelf?: boolean;
}): Promise<ExchangeResult> {
  const { target, entry } = input;
  const rerunning = input.rerunSelf === true || entry.rerun === "previous";

  // Which persisted line the rerun targets, READ BACK from the transcript rather
  // than assumed, and checked against the line the case names. The retake means
  // something only if it re-runs the committing line; a run that silently re-ran
  // a later line would report a clean retake of the wrong turn.
  let rerunOf: { messageId: string; content: string } | undefined;
  if (rerunning) {
    const targetMessage =
      input.rerunSelf === true ? await newestUserMessage(target.chatId) : input.previousUserMessage;
    if (targetMessage === null) throw new Error(`${entry.id}: no persisted user message to rerun`);
    if (targetMessage.content.trim() !== entry.line.trim()) {
      throw new Error(
        `${entry.id}: the message this would rerun is not the line the case names.\n` +
          `  expected: ${JSON.stringify(entry.line)}\n  found:    ${JSON.stringify(targetMessage.content)}`,
      );
    }
    rerunOf = { messageId: targetMessage.id, content: targetMessage.content };
  }

  // A holder, not a bare `let`: the assignment happens inside a callback the
  // compiler cannot see run, so a plain local narrows to `null` at every use.
  const capture: { record: ChatContactTurnRecord | null } = { record: null };
  const submitted = await submitChatMessage({
    chatId: target.chatId,
    memoryGroupId: target.memoryGroupId,
    character: { id: target.characterId, name: target.characterName, profile: target.characterProfile },
    onContactTurn: (record) => {
      capture.record = record;
    },
    ...(rerunOf === undefined
      ? { kind: "send" as const, content: entry.line }
      : { kind: "rerun" as const, targetMessageId: rerunOf.messageId }),
  });
  if (!submitted.ok) throw new Error(`${entry.id}: the exchange was refused (${submitted.code})`);

  let reply = "";
  for await (const chunk of submitted.stream) reply += chunk;
  return { turn: capture.record, reply, ...(rerunOf === undefined ? {} : { rerunOf }) };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function printPlan(): void {
  console.log("Romantic contact rollout rerun — plan\n");
  for (const entry of TRIAL_CASES) {
    // Both rerun shapes, named the way the runner actually decides them: the
    // retake reruns the previous case's line, and the denial case reruns its own
    // after binding a denial to the attempt its first send produced.
    const how = entry.rerun === "previous" ? "rerun:previous" : entry.bindDenial === true ? "deny+rerun" : "send";
    console.log(`  ${entry.id.padEnd(16)} setup=${entry.setup.padEnd(9)} ${how.padEnd(14)} ${JSON.stringify(entry.line)}`);
    console.log(`  ${" ".repeat(16)} requires: ${describeExpectation(entry)}`);
  }
  console.log("\n  flags:");
  for (const flag of REQUIRED_FLAGS) {
    console.log(`    ${flag.effective() ? "on " : "OFF"}  ${flag.name}`);
    if (!flag.effective()) console.log(`         without it: ${flag.cost}`);
  }
  console.log(`\n  demo mode: ${isDemoMode() ? "YES — no model calls would happen" : "no"}`);
  console.log(`  TRIAL_CHAT_ID: ${process.env.TRIAL_CHAT_ID ?? "(unset — required for a real run)"}`);
}

function describeExpectation(entry: TrialCase): string {
  const expected = entry.expect;
  const act =
    expected.act === "none" ? "no act" : `${expected.act.kind} ${expected.act.gesture} on ${expected.act.targetLocationId}`;
  const reason = expected.reason === undefined ? "" : `/${expected.reason}`;
  return (
    `${act}; ${expected.status}${reason}; ${expected.durableCommits} commit(s); ` +
    `${expected.pairContactsAfter} live after; guidance ${expected.guidanceKind}`
  );
}

async function writeEvidence(records: readonly CaseRecord[]): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const jsonPath = path.join(OUT_DIR, `rerun-${stamp}.json`);
  await fs.writeFile(
    jsonPath,
    JSON.stringify({ character: CHARACTER_NAME, chatId: process.env.TRIAL_CHAT_ID, records }, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(OUT_DIR, `rerun-${stamp}.md`), renderReport(records), "utf8");
  console.log(`\nwrote ${jsonPath}`);
}

/**
 * The human-readable half. It leads with the failures because the report exists
 * to inform a rollout ruling, and a ruling made from a document that opens with
 * six green ticks is a ruling made from the summary.
 */
function renderReport(records: readonly CaseRecord[]): string {
  const lines: string[] = ["# Romantic contact rollout rerun — captured evidence", ""];
  const failed = records.filter((entry) => !entry.pass);
  lines.push(
    failed.length === 0
      ? "All cases passed both the required-state check and the prose oracle."
      : `**${failed.length} of ${records.length} cases did not pass.**`,
    "",
  );

  for (const entry of records) {
    lines.push(`## ${entry.caseId}`, "");
    lines.push(`Proves: ${entry.proves}`, "");
    lines.push(`Permission setup: \`${entry.setup}\``, "");
    lines.push("Input:", "", "```", entry.input, "```", "");
    if (entry.rerunOf !== undefined) {
      lines.push(`Re-ran persisted message \`${entry.rerunOf.messageId}\`:`, "", "```", entry.rerunOf.content, "```", "");
    }
    lines.push("Guidance handed to the narrator:", "");
    lines.push(entry.guidanceLines.length === 0 ? "_(none)_" : ["```", ...entry.guidanceLines, "```"].join("\n"), "");
    lines.push("Reply:", "", "```", entry.reply.trim(), "```", "");
    lines.push(
      "| field | value |",
      "| --- | --- |",
      `| status | \`${entry.turn?.status ?? "none"}\` |`,
      `| reason | \`${entry.turn?.reason ?? "—"}\` |`,
      `| resultCodes | ${(entry.turn?.resultCodes ?? []).map((code) => `\`${code}\``).join(", ") || "—"} |`,
      `| durably committed | ${entry.turn?.committed === true ? "yes" : "no"} |`,
      `| direct skin contact | ${entry.turn?.directSkinContact === undefined ? "—" : entry.turn.directSkinContact ? "yes" : "no"} |`,
      `| permission standing | \`${entry.permissionStanding}\` |`,
      `| denial bound to attempt | ${entry.attemptDeniedBound ? "yes" : "no"} |`,
      `| pair contacts before setup | ${entry.beforeSetup.contactIds.length} |`,
      `| pair contacts after setup | ${entry.afterSetup.contactIds.length} |`,
      `| pair contacts after exchange | ${entry.afterExchange.contactIds.length} |`,
      "",
    );
    if (entry.stateFailures.length > 0) {
      lines.push("Required-state failures:", "");
      for (const failure of entry.stateFailures) {
        lines.push(`- **${failure.field}** — expected \`${failure.expected}\`, observed \`${failure.observed}\``);
      }
      lines.push("");
    }
    if (entry.judgeDegraded) lines.push("**The judge call degraded — the prose is UNGRADED.**", "");
    else if (entry.prose !== null && !entry.prose.pass) {
      lines.push("Prose oracle failures:", "");
      for (const failure of entry.prose.failures) {
        lines.push(`- **${failure.kind}** — ${failure.detail}${failure.quote === undefined ? "" : `\n  > ${failure.quote}`}`);
      }
      lines.push("");
    }
    if (entry.pass) lines.push("Passed both checks.", "");
  }
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
