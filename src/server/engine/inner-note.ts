import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { diag, DiagnosticCollector, type DiagnosticSink } from "@/contracts/diagnostics";
import { emptyBrief, nextTurnBriefSchema } from "@/contracts/state/brief";
import {
  degradedInnerNoteExtraction,
  innerNoteExtractionSchema,
  type InnerNoteExtraction,
} from "@/contracts/turns/inner-note";
import { log } from "@/server/log";
import { parseOr, parseOrNull } from "@/lib/parse";
import { generateChecked } from "../ai";
import { db, sessionParticipants, sessions } from "../db";
import { logEvent } from "../events";
import { addFacts, sessionScope, type FactDraftInput } from "../memory";
import { enqueueJob, registerJobHandler } from "./jobs";
import { buildInnerNotePrompt, INNER_NOTE_SYSTEM } from "./prompts/inner-note";

/**
 * NPC inner note (docs/memory.md §Authored interior facts): the player writes
 * an authorial note — a memory, feeling, or belief, never dialogue — for one
 * NPC. Processing runs as an `inner_note` job on the same serialized
 * per-session queue as post_turn, so it can never interleave with a merge,
 * but it does NOT gate session readiness (play continues while it runs).
 *
 * One generateChecked call converts the note into 1–4 interior facts plus a
 * line of next-turn guidance. Facts insert through the standard addFacts path
 * (embedded, canon, witnessed only by the NPC — interiority is theirs alone);
 * guidance is appended to the brief's characterNotes so the very next turn
 * reflects it. The brief regenerates each merge, so the guidance self-expires
 * after one turn — the facts carry the long term.
 */

/** Interior facts per note — clamped here, never trusted to the schema. */
export const INNER_NOTE_MAX_FACTS = 4;
/**
 * Authored interiority must never be silently dropped by the addFacts
 * confidence gate (FACT_MIN_CONFIDENCE = 0.4), so extracted confidences are
 * floored here.
 */
export const INNER_NOTE_MIN_CONFIDENCE = 0.5;

export const innerNoteJobPayloadSchema = z.object({
  sessionId: z.string().min(1),
  participantId: z.string().min(1),
  text: z.string().min(1),
});

export type InnerNoteJobPayload = z.infer<typeof innerNoteJobPayloadSchema>;

/** Enqueue the background job; returns the job id immediately (never blocks on the LLM). */
export async function enqueueInnerNote(payload: InnerNoteJobPayload): Promise<string> {
  return enqueueJob({ sessionId: payload.sessionId, type: "inner_note", payload });
}

/**
 * Clamp the model's output to the feature's invariants (trust nothing,
 * docs/resilience.md §3): every fact is re-bound to the NPC (subjectName,
 * subjectKind, no foreign interiors), the count is capped, confidences are
 * floored, and an empty facts list or empty guidance degrades to the verbatim
 * note with a warn diagnostic.
 */
export function normalizeInnerNoteExtraction(
  npcName: string,
  note: string,
  raw: InnerNoteExtraction,
  sink?: DiagnosticSink,
): InnerNoteExtraction {
  const fallback = degradedInnerNoteExtraction(npcName, note);

  let facts: InnerNoteExtraction["facts"] = raw.facts
    .filter((fact) => fact.text.trim().length > 0)
    .slice(0, INNER_NOTE_MAX_FACTS)
    .map((fact) => ({
      ...fact,
      subjectName: npcName,
      subjectKind: "character" as const,
      text: fact.text.trim(),
      confidence: Math.min(1, Math.max(INNER_NOTE_MIN_CONFIDENCE, fact.confidence)),
    }));
  if (facts.length === 0) {
    sink?.push(
      diag("warn", "inner_note.extraction.no_facts", "extraction produced no usable facts; storing the note verbatim", {
        context: { npcName },
      }),
    );
    facts = fallback.facts;
  }

  let guidance = raw.guidance.trim();
  if (!guidance) {
    sink?.push(
      diag("warn", "inner_note.extraction.no_guidance", "extraction produced no guidance; using the note verbatim", {
        context: { npcName },
      }),
    );
    guidance = fallback.guidance;
  }

  return { facts, guidance };
}

export interface ExtractInnerNoteInput {
  npcName: string;
  note: string;
  sink?: DiagnosticSink;
}

export interface ExtractInnerNoteResult {
  extraction: InnerNoteExtraction;
  degraded: boolean;
}

/**
 * One generateChecked call (the state-model default, temperature 0). Demo mode and a
 * twice-failed validation both land on the degraded default — the verbatim
 * note as one knowledge fact plus guidance — with the diagnostics the
 * resilience ladder records (`inner_note.extraction.degraded` / `.parse_failed`).
 */
export async function extractInnerNote(input: ExtractInnerNoteInput): Promise<ExtractInnerNoteResult> {
  const { value, degraded } = await generateChecked<InnerNoteExtraction>({
    schema: innerNoteExtractionSchema,
    system: INNER_NOTE_SYSTEM,
    prompt: buildInnerNotePrompt({ npcName: input.npcName, note: input.note }),
    temperature: 0,
    code: "inner_note.extraction",
    sink: input.sink,
    fallback: () => degradedInnerNoteExtraction(input.npcName, input.note),
  });
  const raw = value ?? degradedInnerNoteExtraction(input.npcName, input.note);
  return { extraction: normalizeInnerNoteExtraction(input.npcName, input.note, raw, input.sink), degraded };
}

/**
 * Job body. Idempotence and resilience: a vanished session/participant (or a
 * player participant — the route already rejects those) is a logged no-op,
 * never a crash loop. Facts go through addFacts with `witnessed_by` set to
 * the NPC alone; guidance appends to (never clobbers) brief.characterNotes.
 */
export async function processInnerNote(payload: InnerNoteJobPayload, jobId?: string): Promise<void> {
  const sink = new DiagnosticCollector();

  const [participant] = await db()
    .select({
      id: sessionParticipants.id,
      displayName: sessionParticipants.displayName,
      isUser: sessionParticipants.isUser,
    })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.id, payload.participantId), eq(sessionParticipants.sessionId, payload.sessionId)))
    .limit(1);
  if (!participant || participant.isUser) {
    log.warn("inner_note", "participant missing or is the player; note dropped", {
      sessionId: payload.sessionId,
      participantId: payload.participantId,
    });
    await logEvent(payload.sessionId, "inner_note", {
      jobId,
      participantId: payload.participantId,
      dropped: true,
      diagnostics: [diag("warn", "inner_note.participant_unresolved", "participant missing or is the player")],
    });
    return;
  }

  const { extraction, degraded } = await extractInnerNote({
    npcName: participant.displayName,
    note: payload.text,
    sink,
  });

  const drafts: FactDraftInput[] = extraction.facts.map((fact) => ({
    ...fact,
    subjectId: participant.id,
    // Interiority is the NPC's alone — exactly what the knowledge ledger consumes.
    witnessedBy: [participant.id],
  }));
  const added = await addFacts(sessionScope(payload.sessionId), drafts, null, sink);

  // Append guidance to the session brief so the VERY NEXT turn reflects it
  // (facts alone retrieve probabilistically). Serialized with the merge by
  // the per-session job queue, so this read-modify-write cannot interleave
  // with a brief rebuild.
  const [sessionRow] = await db()
    .select({ brief: sessions.brief })
    .from(sessions)
    .where(eq(sessions.id, payload.sessionId))
    .limit(1);
  if (sessionRow) {
    const brief = parseOr(nextTurnBriefSchema, sessionRow.brief, emptyBrief(), sink);
    const guidanceLine = `Author's note — ${participant.displayName}: ${extraction.guidance}`;
    const next = { ...brief, characterNotes: [...brief.characterNotes, guidanceLine] };
    await db().update(sessions).set({ brief: next }).where(eq(sessions.id, payload.sessionId));
  }

  // Diagnostics persist on the observability stream (no turn row to carry
  // them); the Turn Inspector's event window picks them up.
  await logEvent(payload.sessionId, "inner_note", {
    jobId,
    participantId: participant.id,
    degraded,
    insertedFactIds: added.insertedIds,
    supersededFactIds: added.supersededIds,
    diagnostics: sink.items,
  });
}

registerJobHandler("inner_note", async (job) => {
  const payload = parseOrNull(innerNoteJobPayloadSchema, job.payload);
  if (!payload) throw new Error("inner_note job missing payload");
  await processInnerNote(payload, job.id);
});
