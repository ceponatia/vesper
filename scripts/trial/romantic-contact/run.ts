import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { affordanceSubjectId, DiagnosticCollector, type RomanticPermissionEvent } from "@/contracts";
import { newId } from "@/lib/ids";
import { isDemoMode } from "@/server/ai";
import { characterChatMessages, characterChats, characters, chatParticipants, db } from "@/server/db";
import {
  appendChatPermissionEventsWithInvalidation,
  chatPermissionOverrideEventRef,
  CHAT_CONTACT_PLAYER_SUBJECT,
  foldChatPermissionProjection,
  listChatPermissionEvents,
  chatRomanticPermissionEnabled,
  loadChatScenario,
  submitChatMessage,
  type ChatContactTurnRecord,
} from "@/server/engine";
import { deriveCaseState, TRIAL_CASES, type ContactStateSnapshot, type TrialCase } from "./cases";
import { gradeContactCase, judgeContactReply, type ContactCaseGrade, type ContactProseVerdict } from "./oracle";

/**
 * The romantic contact rollout rerun
 * (`docs/developer-notes/romantic-contact-affordances.trial.romantic-proof.md`).
 *
 * The first proof was run by hand through the UI and written up from what the
 * screen showed. It found the thing that matters — a refusal is silent, so the
 * prose described the caress as landing — but it could not SETTLE it, because
 * the record it left is a summary somebody wrote, not the turns themselves.
 * This runner exists so the rerun leaves the turns.
 *
 * Per case it preserves four things, and each is one the first record lacked:
 *
 *   - the SANITIZED input, exactly as sent;
 *   - the ACTUAL reply, verbatim;
 *   - the GUIDANCE the narrator was handed, captured during the turn through
 *     `onContactTurn` rather than re-derived afterwards (re-deriving reads it
 *     against state the exchange has already changed);
 *   - the BEFORE and AFTER state, read from the projection either side.
 *
 * Then `gradeContactCase` decides, and the decision is reproducible from the
 * written record without rerunning anything.
 *
 *   pnpm trial:romantic-contact --dry-run    # the plan and the flag check, no turns
 *   pnpm trial:romantic-contact              # the full six-case run
 *
 * RUN IT ON FLY, over `fly ssh console`, with `CHAT_ROMANTIC_PERMISSION` and its
 * developer override enabled for the window only — the same conditions as the
 * first proof, and the same obligation to revert both afterwards. It refuses to
 * run in demo mode or with the flag off, because a run that silently graded a
 * lane that never executed would produce a clean report about nothing.
 */

const OUT_DIR = process.env.TRIAL_OUT_DIR ?? "evidence/romantic-contact-rerun";
const CHARACTER_NAME = process.env.TRIAL_CHARACTER ?? "Sabrina Vale";
const QA_USER_ID = process.env.TRIAL_USER_ID ?? "uxtestmaina1b2c3d4e5f6g7";
const SCOPE = "romantic_touch" as const;

interface CaseRecord {
  readonly caseId: string;
  readonly proves: string;
  readonly expectation: string;
  readonly setup: string;
  readonly input: string;
  readonly reply: string;
  readonly guidanceLines: readonly string[];
  readonly turn: ChatContactTurnRecord | null;
  readonly before: ContactStateSnapshot;
  readonly after: ContactStateSnapshot;
  readonly verdict: ContactProseVerdict | null;
  readonly grade: ContactCaseGrade | null;
  readonly judgeDegraded: boolean;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("Romantic contact rollout rerun — plan\n");
    for (const entry of TRIAL_CASES) {
      console.log(`  ${entry.id.padEnd(16)} setup=${entry.setup.padEnd(9)} ${JSON.stringify(entry.line)}`);
      console.log(`  ${" ".repeat(16)} proves: ${entry.proves}`);
    }
    console.log(`\n  flag CHAT_ROMANTIC_PERMISSION: ${chatRomanticPermissionEnabled() ? "on" : "OFF"}`);
    console.log(`  demo mode: ${isDemoMode() ? "YES — no model calls would happen" : "no"}`);
    return;
  }

  // Two refusals rather than a degraded run. A rerun that graded a lane which
  // never executed would report a clean sweep over nothing at all, and the
  // rollout ruling would be made against it.
  if (isDemoMode()) throw new Error("demo mode is on: this trial must run against the real narrator");
  if (!chatRomanticPermissionEnabled()) {
    throw new Error("CHAT_ROMANTIC_PERMISSION is off: the romantic producer would not run, so there is nothing to prove");
  }

  const character = await resolveCharacter();
  const chat = await resolveFixtureChat(character.id);
  console.log(`character ${character.name} (${character.id})`);
  console.log(`fixture chat ${chat.id}\n`);

  const characterSubject = affordanceSubjectId(character.id);
  const records: CaseRecord[] = [];
  let previousUserMessageId: string | null = null;

  try {
    for (const entry of TRIAL_CASES) {
      console.log(`— ${entry.id}`);
      await applySetup({ chatId: chat.id, setup: entry.setup, characterSubject });
      const before = await readContactState(chat.id);

      // A holder, not a bare `let`: the assignment happens inside a callback the
      // compiler cannot see run, so a plain local narrows to `null` at every use.
      const capture: { record: ChatContactTurnRecord | null } = { record: null };
      const submitted = await submitChatMessage({
        chatId: chat.id,
        memoryGroupId: chat.memoryGroupId,
        character: { id: character.id, name: character.name, profile: character.profile },
        onContactTurn: (record) => {
          capture.record = record;
        },
        ...(entry.rerunPrevious === true && previousUserMessageId !== null
          ? { kind: "rerun" as const, targetMessageId: previousUserMessageId }
          : { kind: "send" as const, content: entry.line }),
      });
      if (!submitted.ok) throw new Error(`${entry.id}: the exchange was refused (${submitted.code})`);

      let reply = "";
      for await (const chunk of submitted.stream) reply += chunk;

      // Fail fast, before the next case spends another turn. A case that must
      // build an act and did not has produced silence, and silence here reads
      // exactly like a correct refusal — carrying on would fill the report with
      // passes for turns that never asked the permission owner anything.
      if (entry.mustProduceAct && capture.record?.act === undefined) {
        throw new Error(
          `${entry.id}: the line produced no contact act, so this turn proves nothing. ` +
            `Check the sentence shape before reopening the flag window: ${JSON.stringify(entry.line)}`,
        );
      }

      const after = await readContactState(chat.id);
      if (entry.rerunPrevious !== true) previousUserMessageId = await newestUserMessageId(chat.id);

      const judged = await judgeContactReply({ reply, playerLine: entry.line });
      const turn = capture.record;
      const grade =
        turn === null || judged.verdict === null
          ? null
          : gradeContactCase(deriveCaseState({ record: turn, before, after }), judged.verdict);

      records.push({
        caseId: entry.id,
        proves: entry.proves,
        expectation: entry.expectation,
        setup: entry.setup,
        input: entry.line,
        reply,
        guidanceLines: turn?.guidanceLines ?? [],
        turn,
        before,
        after,
        verdict: judged.verdict,
        grade,
        judgeDegraded: judged.degraded,
      });
      console.log(`  ${grade === null ? "UNGRADED" : grade.pass ? "pass" : `FAIL — ${grade.failures.map((f) => f.kind).join(", ")}`}`);
    }
  } finally {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const jsonPath = path.join(OUT_DIR, `rerun-${stamp}.json`);
    await fs.writeFile(jsonPath, JSON.stringify({ character: character.name, chatId: chat.id, records }, null, 2), "utf8");
    await fs.writeFile(path.join(OUT_DIR, `rerun-${stamp}.md`), renderReport(records), "utf8");
    console.log(`\nwrote ${jsonPath}`);
  }

  const failed = records.filter((entry) => entry.grade === null || !entry.grade.pass);
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${records.length} cases did not pass: ${failed.map((e) => e.caseId).join(", ")}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The live player↔character contacts, read from the chat's own scene projection.
 *
 * Read either side of every exchange rather than inferred from the turn's commit
 * record, so "the withdrawal ended it" is an observed disappearance.
 */
async function readContactState(chatId: string): Promise<ContactStateSnapshot> {
  const scenario = await loadChatScenario(chatId);
  const contacts = scenario?.scene.contacts.contacts ?? [];
  return { liveContactIds: contacts.map((contact) => String(contact.contactId)) };
}

async function resolveCharacter(): Promise<{ id: string; name: string; profile: unknown }> {
  const [row] = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(eq(characters.name, CHARACTER_NAME))
    .limit(1);
  if (!row) throw new Error(`no character named ${CHARACTER_NAME}`);
  return row;
}

/**
 * The chat this runs in, named explicitly by `TRIAL_CHAT_ID`.
 *
 * It never CREATES one, and that is the repo's own rule for this kind of work
 * (CLAUDE.md: prefer an existing conversation) rather than a shortcut. Building
 * a chat correctly means a participant row, a resolved memory group, a seeded
 * scenario and a seeded relationship matrix; a script that reproduced that
 * sequence approximately would run the trial against a conversation subtly
 * unlike the ones players have, which is the kind of gap that makes a proof stop
 * proving anything.
 */
async function resolveFixtureChat(characterId: string): Promise<{ id: string; memoryGroupId: string }> {
  const chatId = process.env.TRIAL_CHAT_ID;
  if (!chatId) throw new Error("set TRIAL_CHAT_ID to an existing QA chat that includes this character");
  const [row] = await db()
    .select({ id: characterChats.id, ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row) throw new Error(`no chat ${chatId}`);
  if (row.ownerId !== QA_USER_ID) throw new Error(`chat ${chatId} is not the QA account's`);
  const [participant] = await db()
    .select({ memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.characterId, characterId)))
    .limit(1);
  if (!participant) throw new Error(`chat ${chatId} does not include ${characterId}`);
  return { id: row.id, memoryGroupId: participant.memoryGroupId };
}

async function newestAssistantMessageId(chatId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row?.id ?? null;
}

async function newestUserMessageId(chatId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Establish the permission state a case needs, through the SAME atomic entry
 * point the developer override route uses — so a withdrawal's dependent-contact
 * sweep runs exactly as it does in production rather than being simulated here.
 */
async function applySetup(input: {
  readonly chatId: string;
  readonly setup: TrialCase["setup"];
  readonly characterSubject: ReturnType<typeof affordanceSubjectId>;
}): Promise<void> {
  if (input.setup === "none") return;
  const sink = new DiagnosticCollector();
  const [chatRow] = await db()
    .select({ clockMinutes: characterChats.clockMinutes })
    .from(characterChats)
    .where(eq(characterChats.id, input.chatId))
    .limit(1);
  const storyMinute = Math.max(0, Math.trunc(chatRow?.clockMinutes ?? 0));
  const eventId = newId();
  // A DENIAL is not a developer override. The override vocabulary is
  // `grant | withdraw` by design — it moves a STANDING grant — while a denial is
  // the character refusing one attempt, which only the NPC decision leg authors.
  // Writing it as `attempt_denied` is what makes the denial case exercise the
  // event the product actually produces, rather than a synthetic standing that
  // would resolve down a different branch of the policy read.
  const denial = input.setup === "deny";
  const sourceMessageId = denial ? await newestAssistantMessageId(input.chatId) : null;
  if (denial && sourceMessageId === null) {
    throw new Error("the denial case needs an assistant message for the decision to be grounded in");
  }
  const event: RomanticPermissionEvent = {
    eventId,
    branchId: input.chatId,
    permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
    grantingTargetId: input.characterSubject,
    scope: SCOPE,
    storyTime: storyMinute,
    orderInSource: 0,
    ...(denial
      ? { kind: "attempt_denied" as const, sourceKind: "npc_decision" as const, sourceMessageId: sourceMessageId ?? "" }
      : {
          kind: "developer_overridden" as const,
          sourceKind: "developer_override" as const,
          operation: input.setup === "grant" ? ("grant" as const) : ("withdraw" as const),
        }),
  };
  await appendChatPermissionEventsWithInvalidation({
    chatId: input.chatId,
    guardMessageId: await newestUserMessageId(input.chatId),
    eventRef: chatPermissionOverrideEventRef(eventId),
    storyMinute,
    events: [event],
    sink,
  });
  const projection = foldChatPermissionProjection(await listChatPermissionEvents(input.chatId, sink), sink);
  console.log(`  setup ${input.setup}: standing now ${projection.entries[0]?.standing ?? "none"}`);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The human-readable half. It leads with the failures because the report exists
 * to inform a rollout ruling, and a ruling made from a document that opens with
 * six green ticks is a ruling made from the summary.
 */
function renderReport(records: readonly CaseRecord[]): string {
  const lines: string[] = ["# Romantic contact rollout rerun — captured evidence", ""];
  const failed = records.filter((entry) => entry.grade === null || !entry.grade.pass);
  lines.push(failed.length === 0 ? "All cases passed the oracle." : `**${failed.length} of ${records.length} cases did not pass.**`, "");

  for (const entry of records) {
    lines.push(`## ${entry.caseId}`, "");
    lines.push(`Proves: ${entry.proves}`, "");
    lines.push(`Expected: ${entry.expectation}`, "");
    lines.push(`Permission setup: \`${entry.setup}\``, "");
    lines.push("Input:", "", "```", entry.input, "```", "");
    lines.push("Guidance handed to the narrator:", "");
    lines.push(entry.guidanceLines.length === 0 ? "_(none)_" : ["```", ...entry.guidanceLines, "```"].join("\n"), "");
    lines.push("Reply:", "", "```", entry.reply.trim(), "```", "");
    lines.push(
      "| field | value |",
      "| --- | --- |",
      `| status | \`${entry.turn?.status ?? "none"}\` |`,
      `| reason | \`${entry.turn?.reason ?? "—"}\` |`,
      `| resultCodes | ${(entry.turn?.resultCodes ?? []).map((code) => `\`${code}\``).join(", ") || "—"} |`,
      `| committed | ${entry.turn?.committed === true ? "yes" : "no"} |`,
      `| direct skin contact | ${entry.turn?.directSkinContact === undefined ? "—" : entry.turn.directSkinContact ? "yes" : "no"} |`,
      `| live contacts before | ${entry.before.liveContactIds.length} |`,
      `| live contacts after | ${entry.after.liveContactIds.length} |`,
      "",
    );
    if (entry.judgeDegraded) lines.push("**The judge call degraded — this case is UNGRADED.**", "");
    else if (entry.grade !== null && !entry.grade.pass) {
      lines.push("Oracle failures:", "");
      for (const failure of entry.grade.failures) {
        lines.push(`- **${failure.kind}** — ${failure.detail}${failure.quote === undefined ? "" : `\n  > ${failure.quote}`}`);
      }
      lines.push("");
    } else lines.push("Oracle: passed.", "");
  }
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
