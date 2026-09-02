import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  applyDriveUpdates,
  applyMeanwhilePlanOutcomes,
  armMeanwhilePass,
  characterProfileSchema,
  chatMeanwhileSchema,
  degradedChatMeanwhile,
  emptyCharacterProfile,
  formatChatMoment,
  formatScheduleRhythm,
  mergeSupportingCast,
  planInvolvesPlayer,
  planOthersLabel,
  WHEREABOUTS_MAX_CHARS,
  type ChatMeanwhile,
  type ChatPlan,
  type FactDraft,
  type MeanwhileDevelopment,
} from "@/contracts";
import { agentReasoningPlan } from "@/lib/agent-reasoning";
import { formatElapsed } from "@/lib/clock";
import { parseOr, parseOrNull } from "@/lib/parse";
import { agentModelId, generateChecked, isDemoMode, loadChatAgentReasoningProfile, withGenerateTimeout, type AgentTelemetry } from "../ai";
import { characterChats, characterChatState, characters, chatParticipants, db, hasLiveChatJob } from "../db";
import { addFacts, chatScope, type FactDraftInput } from "../memory";
import { resolveChatPersona } from "../players";
import { log } from "../log";
import { CHAT_MEANWHILE_MAX_OUTPUT_TOKENS, CHAT_MEANWHILE_TIMEOUT_MS } from "./constants";
import { loadChatRelationships } from "./chat-relationships";
import { loadChatScenario, loadChatState } from "./chat-state";
import { enqueueJob, registerJobHandler } from "./jobs";
import { buildChatMeanwhilePrompt, CHAT_MEANWHILE_SYSTEM } from "./prompts/chat-meanwhile";

/**
 * The meanwhile pass: the chat lane's "world
 * tick", wall-clock-free by construction — armed ONLY by a player time skip whose
 * cumulative skipped time since the last pass crosses the gate, run as a
 * DETACHED job (the `chat_scene_sketch` pattern: nothing waits on it, it can
 * never 409 a send), keyed entirely to the story clock.
 *
 * One archivist-class call proposes 1–3 concrete off-screen developments for
 * the whole ensemble; everything folds deterministically into existing sinks:
 *
 * - each development files as a FACT to every involved member's own memory
 *   group (two names = an NPC↔NPC relationship fact to both — the shipped v2
 *   pattern: lived shifts reach the narrator through facts, never matrix edits);
 * - a named drive gets its progress notch (`applyDriveUpdates` — the fold
 *   STRIPS reveal/resolve proposals: the drives law owns reveals);
 * - supporting-cast beats accrete details/whereabouts (`mergeSupportingCast`);
 * - an open NPC↔NPC plan resolves kept/missed (replacing ruling E's blind
 *   assume-kept default);
 * - away members' whereabouts refresh, and ONE compact meanwhile note lands
 *   beside the pending skip note for the next exchange's tail.
 *
 * Idempotency + race safety: the scenario write is guarded on
 * `meanwhile_pass_at_minutes` still being the pre-pass value AND the skip note
 * still standing — if an exchange consumed the skip first, the scenario-side
 * folds are dropped whole (its own folds already advanced plans; the note
 * would be stale) and only the pass marker advances. Facts and member rows
 * land either way. A generation failure degrades to an ordinary skip and the
 * gate re-arms on the next qualifying skip.
 */

export interface EnqueueChatMeanwhileArgs {
  chatId: string;
  ownerId: string;
  /** The gate origin — `meanwhile_pass_at_minutes` BEFORE this pass (the CAS token). */
  prevPassAtMinutes: number;
  /** The clock after the skip (the pass's new marker + the gap's end). */
  clockMinutes: number;
  /** The skip note stamped by this skip — the note-write guard. */
  skipNote: string;
}

/** True when this skip should run the pass (the route's gate). Pure re-export sugar. */
export { armMeanwhilePass };

/** Enqueue one meanwhile pass (detached). Deduped: at most one live pass per chat. Never throws. */
export async function enqueueChatMeanwhile(args: EnqueueChatMeanwhileArgs): Promise<void> {
  try {
    if (await hasLiveChatJob("chat_meanwhile", args.chatId)) return;
    await enqueueJob({ type: "chat_meanwhile", payload: { ...args }, chatId: args.chatId });
  } catch (err) {
    log.warn("chat_meanwhile", "failed to enqueue meanwhile pass", {
      chatId: args.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const meanwhilePayloadSchema = z.object({
  chatId: z.string().min(1),
  ownerId: z.string().min(1),
  prevPassAtMinutes: z.number().catch(0),
  clockMinutes: z.number(),
  skipNote: z.string().catch(""),
});

const normalize = (name: string): string => name.trim().toLowerCase();

/** Run one pass: dossier → one call → deterministic folds. Exported for tests. */
export async function runChatMeanwhile(input: z.infer<typeof meanwhilePayloadSchema>): Promise<void> {
  if (isDemoMode()) return;

  const scenario = await loadChatScenario(input.chatId);
  if (!scenario) return;
  // Another pass already ran (or the marker moved) — this job is stale.
  if (scenario.meanwhilePassAtMinutes !== input.prevPassAtMinutes) return;

  // The roster with profiles + memory groups (sort 0 = primary).
  const roster = await db()
    .select({
      characterId: chatParticipants.characterId,
      memoryGroupId: chatParticipants.memoryGroupId,
      sort: chatParticipants.sort,
      name: characters.name,
      profile: characters.profile,
    })
    .from(chatParticipants)
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(eq(chatParticipants.chatId, input.chatId))
    .orderBy(chatParticipants.sort);
  if (!roster.length) return;

  const player = await resolveChatPersona({ ownerId: input.ownerId, chatId: input.chatId });
  const members = await Promise.all(
    roster.map(async (m) => {
      const profile = parseOr(characterProfileSchema, m.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
      const state = await loadChatState(input.chatId, m.characterId);
      return { ...m, profile, state };
    }),
  );

  // The dossier: rhythm/drives/whereabouts per member, matrix pairs, cast, eligible plans.
  const nameById = new Map(members.map((m) => [m.characterId, m.name]));
  const matrix = await loadChatRelationships(input.chatId);
  const pairs = matrix.flatMap((edge) => {
    const from = nameById.get(edge.fromCharacterId);
    const to = nameById.get(edge.toCharacterId);
    if (!from || !to || (!edge.record.kind && !edge.record.history)) return [];
    return [`${from} → ${to}: ${edge.record.kind}${edge.record.history ? ` — ${edge.record.history}` : ""}`];
  });
  const castLines = scenario.supportingCast.map(
    (c) =>
      `${c.name}${c.relation ? ` (${c.relation})` : ""}${c.details.length ? ` — ${c.details.join("; ")}` : ""}${c.whereabouts ? ` — usually: ${c.whereabouts}` : ""}`,
  );
  // Open plans NOT involving the player whose time fell inside/behind the gap — the
  // pass decides how they went (the fold only ever touches non-player plans anyway).
  const eligiblePlans = scenario.plans.filter(
    (p) =>
      p.status === "upcoming" &&
      !planInvolvesPlayer(p, player.name) &&
      p.when.kind === "scheduled" &&
      p.when.targetMinutes <= scenario.clockMinutes,
  );
  const gapLabel = `${formatChatMoment(input.prevPassAtMinutes, scenario.calendarStart)} → ${formatChatMoment(
    input.clockMinutes,
    scenario.calendarStart,
  )} (${formatElapsed(Math.max(1, input.clockMinutes - input.prevPassAtMinutes))})`;

  const controller = new AbortController();
  const modelId = agentModelId();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.chatId);
  const reasoning = agentReasoningPlan({
    profileId: reasoningProfile,
    leg: "meanwhile",
    maxOutputTokens: CHAT_MEANWHILE_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_MEANWHILE_TIMEOUT_MS,
  });
  const telemetry: Partial<AgentTelemetry> = {
    legId: "chat_meanwhile",
    chatId: input.chatId,
    modelId,
    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work = generateChecked<ChatMeanwhile>({
    schema: chatMeanwhileSchema,
    system: CHAT_MEANWHILE_SYSTEM,
    prompt: buildChatMeanwhilePrompt({
      playerName: player.name,
      gapLabel,
      members: members.map((m) => ({
        name: m.name,
        presence: m.state?.presence ?? "present",
        whereabouts: m.state?.whereabouts ?? "",
        rhythm: formatScheduleRhythm(m.profile.schedule),
        drives: (m.state?.drives ?? [])
          .filter((d) => !d.resolved)
          .map(
            (d) =>
              `"${d.want}" (${d.secrecy === "secret" && !d.revealed ? "SECRET — never expose it" : d.secrecy})${d.progress ? ` — so far: ${d.progress}` : ""}`,
          ),
      })),
      pairs,
      cast: castLines,
      openPlans: eligiblePlans.map((p) => `"${p.what}" — ${planOthersLabel(p, player.name) || p.participants.join(", ")}`),
    }),
    modelId,
    temperature: 0,
    maxOutputTokens: reasoning.maxOutputTokens,
    code: "chat_meanwhile.generate",
    fallback: degradedChatMeanwhile,
    signal: controller.signal,
    disableReasoning: !reasoning.enabled,
    providerOptions: reasoning.providerOptions,
    repair: false,
    degradeSeverity: "warn",
    telemetry,
  });
  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    reasoning.timeoutMs,
    "chat_meanwhile.timeout",
    undefined,
    telemetry,
  );
  const result = degraded || !value ? degradedChatMeanwhile() : value;

  // ---- Deterministic folds ----------------------------------------------------

  const byName = new Map(members.map((m) => [normalize(m.name), m]));
  const primary = members[0];
  if (!primary) return;

  // Facts: each development files to every involved ROSTER member's own group (the
  // "knows different things" routing); cast-only developments go to the primary.
  for (const dev of result.developments) {
    const involved = dev.about.map((n) => byName.get(normalize(n))).filter((m): m is NonNullable<typeof m> => Boolean(m));
    const targets = involved.length ? involved : [primary];
    const draft: FactDraft = {
      kind: dev.about.length === 2 ? "relationship" : "event",
      subjectName: (involved[0] ?? primary).name,
      subjectKind: "character",
      text: `While apart (off-screen): ${dev.event}`,
      tags: ["offscreen"],
      confidence: 0.85,
    };
    for (const target of targets) {
      const witnessed: FactDraftInput = { ...draft, witnessedBy: [target.characterId] };
      await addFacts(chatScope(target.memoryGroupId), [witnessed], null);
    }
  }

  // Member rows: drive notches (reveal/resolve STRIPPED — the drives law owns those)
  // and away-whereabouts refreshes, as targeted column updates (never whole-row —
  // a concurrent exchange's own save must not be clobbered).
  const whereByName = new Map(result.whereabouts.map((w) => [normalize(w.name), w.where]));
  for (const member of members) {
    if (!member.state) continue;
    const updates = result.developments
      .filter((dev) => dev.driveWant && dev.about.some((n) => normalize(n) === normalize(member.name)))
      .map((dev) => ({ want: dev.driveWant ?? "", progress: (dev.driveProgress || dev.event).slice(0, 200), revealed: false, resolved: false }));
    const drives = updates.length ? applyDriveUpdates(member.state.drives, updates).drives : null;
    const where = member.state.presence === "away" ? whereByName.get(normalize(member.name)) : undefined;
    if (!drives && !where) continue;
    await db().execute(sql`
      update ${characterChatState} set
        drives = coalesce(${drives ? JSON.stringify(drives) : null}::jsonb, drives),
        whereabouts = coalesce(${where ? where.slice(0, WHEREABOUTS_MAX_CHARS) : null}, whereabouts),
        updated_at = now()
      where chat_id = ${input.chatId} and character_id = ${member.characterId}
    `);
  }

  // Scenario folds (cast accretion, plan outcomes, the one-shot note), guarded: only
  // while the pass marker is untouched AND the skip note still stands (no exchange
  // consumed the gap yet). A lost guard drops these whole — the exchange's own folds
  // already ran (overdue NPC plans took ruling E's assume-kept default) and a late
  // note would be stale — and the marker still advances below.
  const castProposal = result.developments.flatMap((dev: MeanwhileDevelopment) => {
    const castNames = dev.about.filter((n) => !byName.has(normalize(n)));
    if (!castNames.length || !dev.castDetail) return [];
    return castNames.map((name) => ({ name, relation: "", details: [dev.castDetail ?? ""], whereabouts: undefined }));
  });
  const supportingCast = mergeSupportingCast(scenario.supportingCast, castProposal, [
    player.name,
    ...members.map((m) => m.name),
  ]);
  const planFold = applyMeanwhilePlanOutcomes(scenario.plans, result.developments, player.name);
  await db().execute(sql`
    update ${characterChats} set
      supporting_cast = ${JSON.stringify(supportingCast)}::jsonb,
      plans = ${JSON.stringify(planFold.plans)}::jsonb,
      pending_meanwhile_note = ${result.note},
      meanwhile_pass_at_minutes = ${input.clockMinutes}
    where id = ${input.chatId}
      and meanwhile_pass_at_minutes = ${input.prevPassAtMinutes}
      and pending_skip_note = ${input.skipNote}
  `);
  // Mark the pass done even when the guarded fold lost the race (idempotency: the
  // facts + member rows above already landed; a re-run would double-file them).
  await db().execute(sql`
    update ${characterChats} set meanwhile_pass_at_minutes = ${input.clockMinutes}
    where id = ${input.chatId} and meanwhile_pass_at_minutes = ${input.prevPassAtMinutes}
  `);
}

registerJobHandler("chat_meanwhile", async (job) => {
  const payload = parseOrNull(meanwhilePayloadSchema, job.payload, undefined, "jobs.chat_meanwhile.payload");
  if (!payload) return;
  await runChatMeanwhile(payload);
});
