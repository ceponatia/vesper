import { z } from "zod";
import type { CalendarStart } from "@/lib/clock";
import { scheduleDayPartById, type ScheduleDayPartId } from "../world/profile";
import { chatMomentLabel, dayStartClockMinutes } from "./chat-clock";

/**
 * Chat plans & promises (chat-plans-promises.plan.md / .spec.md): commitments the
 * fiction strikes — "come over Friday", "I'll text you after my shift", "dinner at the
 * pier at sunset" — become tracked state that comes DUE on the story clock. The chat
 * descendant of the retired scheduled-arrivals spec, without the location model.
 *
 * The frame: the story makes a commitment → the system records it deterministically →
 * the story clock makes it come due → the narration honors it.
 *
 * Plans belong to the CONVERSATION (like `scene_memory` and `supporting_cast`), so they
 * ride the chat-wide scenario on `character_chats` as a jsonb column — field additions
 * are never migrations, and a bad stored value parses to the empty list at the trust
 * boundary (docs/resilience.md §1). Maintained archivist-first (recognize / update /
 * cancel a plan) and then advanced DETERMINISTICALLY as the clock passes each due-time;
 * `status`'s `imminent`/`due now` are DERIVED pure at prompt-build time, never stored.
 *
 * Pure — no IO, no clock read. The current story-clock minute and the id generator are
 * injected (`nowMinutes`, `mintId`), mirroring the `now: Date` injection the rest of the
 * chat engine already uses, so the merge/advance are deterministically testable.
 */

/** Total plans stored (open + a short resolved history ring — ruling F). */
export const CHAT_PLANS_MAX = 16;
/** Open (`upcoming`) plans — a short working set stays a pull, not a backlog. */
export const CHAT_PLANS_OPEN_MAX = 8;
/** Plan moves the archivist may propose per exchange — a beat strikes/changes a couple, not a slate. */
export const PLAN_PROPOSAL_MAX = 4;
/** Length cap on the plan's "what". */
export const PLAN_WHAT_MAX_CHARS = 160;
/** Length cap on the optional "where". */
export const PLAN_WHERE_MAX_CHARS = 100;
/** Length cap on one participant name. */
export const PLAN_PARTICIPANT_MAX_CHARS = 60;
/** Participants per plan (player + a few roster / supporting-cast names). */
export const PLAN_MAX_PARTICIPANTS = 6;
/** Length cap on the human `when` label ("tomorrow evening"). */
export const PLAN_LABEL_MAX_CHARS = 60;

/** Story-clock minutes in a day (the chat clock's day length). */
export const MINUTES_PER_DAY = 1440;

// Due-ness windows (minutes on the story clock), keyed off `delta = target − now`:
/** Within a day ahead reads as imminent — "tomorrow" anticipates. */
export const PLAN_IMMINENT_WINDOW_MINUTES = MINUTES_PER_DAY;
/** One day-part at/after the target is "happening now" (grace before it's a miss). */
export const PLAN_DUE_WINDOW_MINUTES = 360;
/** A miss stays fresh fallout for a day, then ages out of salience (still stored). */
export const PLAN_JUST_MISSED_WINDOW_MINUTES = MINUTES_PER_DAY;

/** A plan's lifecycle status. `missed` is deterministic-only; the archivist never proposes it. */
export type PlanStatus = "upcoming" | "kept" | "missed" | "canceled";

/**
 * A plan's timing, keyed to the STORY clock (never the wall clock — D3/D8). A `scheduled`
 * plan carries a resolved absolute target (minutes) for pure due-ness plus a human label
 * for display + the narrator; an `unscheduled` plan ("soon"/"sometime") has no target and
 * never goes missed — it lingers as an intention and ages out.
 */
export type PlanWhen =
  | { kind: "scheduled"; targetMinutes: number; label: string }
  | { kind: "unscheduled"; label?: string };

const labelString = z
  .string()
  .catch("")
  .default("")
  .transform((s) => s.trim().slice(0, PLAN_LABEL_MAX_CHARS));

const planWhenSchema: z.ZodType<PlanWhen> = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("scheduled"),
      targetMinutes: z.number().int().catch(0).default(0),
      label: labelString,
    }),
    z.object({ kind: z.literal("unscheduled"), label: labelString.optional() }),
  ])
  .catch({ kind: "unscheduled" });

const participantsSchema = z
  .array(z.string().trim().min(1).max(PLAN_PARTICIPANT_MAX_CHARS))
  .catch([])
  .default([])
  .transform((p) => dedupeParticipants(p));

/** One tracked plan. `what` is required; a blank-`what` element sinks the whole (parseOr'd) list. */
export const chatPlanSchema = z.object({
  id: z.string().catch("").default(""),
  what: z
    .string()
    .trim()
    .min(1)
    .max(PLAN_WHAT_MAX_CHARS),
  participants: participantsSchema,
  where: z.string().trim().min(1).max(PLAN_WHERE_MAX_CHARS).optional().catch(undefined),
  when: planWhenSchema,
  status: z.enum(["upcoming", "kept", "missed", "canceled"]).catch("upcoming").default("upcoming"),
  struckAtMinutes: z.number().int().catch(0).default(0),
});
export type ChatPlan = z.infer<typeof chatPlanSchema>;

/**
 * The persisted plan list. The caps ride the schema (open-cap then total-cap, oldest-out)
 * as a safety net; the merge enforces them too. A bad row parses away to [].
 */
export const chatPlansSchema = z
  .array(chatPlanSchema)
  .catch([])
  .default([])
  .transform((plans) => capPlans(plans));
export type ChatPlans = z.infer<typeof chatPlansSchema>;

/** The empty plan list — the degraded default and the seed value. */
export function emptyChatPlans(): ChatPlan[] {
  return [];
}

/**
 * The archivist's optional post-turn `plans` proposal: plan MOVES the exchange struck or
 * changed. A move matching an existing plan (by normalized `what`) updates it; an unmatched
 * move with no resolved status mints a new upcoming plan. `when` is the LLM-friendly coarse
 * grammar (day-offset + day-part, or `unscheduled`) the fold resolves against the clock;
 * the archivist may set `kept`/`canceled`/`upcoming` but NEVER `missed` (deterministic).
 * Lenient — a bad proposal parses to [] and merges as a no-op, so it never fails the turn.
 */
export const chatPlanProposalSchema = z
  .array(
    z.object({
      what: z.string().trim().min(1).max(PLAN_WHAT_MAX_CHARS),
      participants: z.array(z.string().trim().min(1).max(PLAN_PARTICIPANT_MAX_CHARS)).catch([]).default([]),
      where: z.string().catch("").default(""),
      when: z
        .object({
          dayOffset: z.number().int().min(0).max(60).optional().catch(undefined),
          dayPart: z.string().optional().catch(undefined),
          unscheduled: z.boolean().optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
      status: z.enum(["upcoming", "kept", "canceled"]).optional().catch(undefined),
    }),
  )
  .catch([])
  .default([])
  .transform((moves) => moves.slice(0, PLAN_PROPOSAL_MAX));
export type ChatPlanProposal = z.infer<typeof chatPlanProposalSchema>;
type PlanMove = ChatPlanProposal[number];

const normalizeName = (name: string): string => name.trim().toLowerCase();

/** The plan's identity key for archivist matching: lowercased, whitespace-collapsed, punctuation-trimmed. */
export function normalizePlanKey(what: string): string {
  return what
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?'"]+$/g, "");
}

/** Dedupe participant names (case-insensitive, first casing wins), drop blanks, cap. Pure. */
function dedupeParticipants(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().slice(0, PLAN_PARTICIPANT_MAX_CHARS);
    const key = normalizeName(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, PLAN_MAX_PARTICIPANTS);
}

/** Player-name aliases a participant string may use in place of the persona's name. */
const PLAYER_ALIASES = new Set(["you", "the player", "player", "me"]);

/** True when the plan names the player among its participants (drives the miss-vs-assume-kept split). */
export function planInvolvesPlayer(plan: ChatPlan, playerName: string): boolean {
  const key = normalizeName(playerName);
  return plan.participants.some((p) => {
    const pk = normalizeName(p);
    return (key && pk === key) || PLAYER_ALIASES.has(pk);
  });
}

/**
 * Resolve the archivist's coarse `when` (day-offset + day-part, or unscheduled) into a
 * stored `PlanWhen` against the current clock. A day-only proposal targets midday; a
 * target that lands at/before the strike is bumped one day forward (a plan can't be born
 * in the past). Pure.
 */
export function resolvePlanWhen(when: PlanMove["when"], nowMinutes: number, calendarStart?: CalendarStart): PlanWhen {
  const part = when?.dayPart ? scheduleDayPartById(when.dayPart) : undefined;
  const hasDay = Boolean(when && (when.dayOffset !== undefined || part));
  if (!when || when.unscheduled || !hasDay) return { kind: "unscheduled" };
  // The day boundary is REAL midnight when the calendar anchor is known (the anchor rarely
  // starts a story at 00:00, so `floor(now / 1440)` would put "tomorrow morning" mid-day).
  const dayStart = calendarStart
    ? dayStartClockMinutes(nowMinutes, calendarStart)
    : Math.floor(nowMinutes / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  const dayOffset = Math.max(0, Math.trunc(when.dayOffset ?? 0));
  const partMinute = part ? part.startMinute : 720; // midday when only a day is named
  let targetMinutes = dayStart + dayOffset * MINUTES_PER_DAY + partMinute;
  if (targetMinutes <= nowMinutes) targetMinutes += MINUTES_PER_DAY;
  return { kind: "scheduled", targetMinutes, label: buildWhenLabel(dayOffset, part?.id) };
}

/** A short human label for a resolved when ("tonight", "tomorrow evening", "in 3 days, morning"). Pure. */
export function buildWhenLabel(dayOffset: number, dayPart?: ScheduleDayPartId): string {
  if (!dayPart) return dayOffset === 0 ? "today" : dayOffset === 1 ? "tomorrow" : `in ${dayOffset} days`;
  if (dayOffset === 0) {
    switch (dayPart) {
      case "morning":
        return "this morning";
      case "afternoon":
        return "this afternoon";
      case "evening":
        return "this evening";
      case "night":
        return "tonight";
    }
  }
  if (dayOffset === 1) return `tomorrow ${dayPart}`;
  return `in ${dayOffset} days, ${dayPart}`;
}

/** Render context for calendar-aware plan labels (chat-clock-calendar.plan.md). */
export interface PlanLabelContext {
  nowMinutes: number;
  calendarStart: CalendarStart;
}

/**
 * A one-line "when" phrase for prompts/UI. With `ctx`, a scheduled plan's label is
 * DERIVED against the story calendar at render time — real weekdays (owner ruling
 * 2026-07-15: "Friday evening"; the date past a week out), never stored, so editing
 * `calendarStart` rebases every label. Without ctx (or unscheduled), the stored
 * relative label ("tomorrow evening" / "sometime") is the fallback. Pure.
 */
export function describePlanWhen(when: PlanWhen, ctx?: PlanLabelContext): string {
  if (when.kind === "unscheduled") return when.label?.trim() || "sometime";
  if (ctx) return chatMomentLabel(when.targetMinutes, ctx.nowMinutes, ctx.calendarStart);
  return when.label.trim() || "soon";
}

/** "with Nyx and Mira" (participants other than the player), or "" when only the player. Pure. */
export function planOthersLabel(plan: ChatPlan, playerName: string): string {
  const key = normalizeName(playerName);
  const others = plan.participants.filter((p) => {
    const pk = normalizeName(p);
    return pk !== key && !PLAYER_ALIASES.has(pk);
  });
  if (!others.length) return "";
  if (others.length === 1) return `with ${others[0]}`;
  return `with ${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
}

/**
 * Enforce the plan caps (oldest-out): drop the oldest OPEN plans past the open cap first
 * (they are the working set), then cap the total (keeping the newest overall, so resolved
 * plans keep a short callback ring). Preserves array order (append order = chronological).
 * Pure.
 */
function capPlans(plans: readonly ChatPlan[]): ChatPlan[] {
  const openIdx = plans.map((p, i) => (p.status === "upcoming" ? i : -1)).filter((i) => i >= 0);
  const dropOpen = new Set(openIdx.slice(0, Math.max(0, openIdx.length - CHAT_PLANS_OPEN_MAX)));
  const kept = plans.filter((_, i) => !dropOpen.has(i));
  return kept.slice(-CHAT_PLANS_MAX);
}

/**
 * Merge the archivist's post-turn `plans` proposal into the accumulated plans (pure): each
 * move upserts by normalized `what` — a matched move refines participants/where/when and
 * applies its status (`kept`/`canceled`/reopen), an unmatched move with no resolved status
 * mints a fresh `upcoming` plan (new ids via `mintId`). A resolved-status move that matches
 * nothing is a no-op — a plan is never born already kept. Returns the capped list plus the
 * plans the ARCHIVIST marked kept this exchange (consequence material — the deterministic
 * transitions come from `advancePlans`). An empty proposal is a no-op.
 */
export function mergeChatPlans(
  plans: readonly ChatPlan[],
  proposal: ChatPlanProposal,
  ctx: { nowMinutes: number; mintId: () => string; calendarStart?: CalendarStart },
): { plans: ChatPlan[]; archivistKept: ChatPlan[] } {
  if (!proposal.length) return { plans: [...plans], archivistKept: [] };
  const out: ChatPlan[] = plans.map((p) => ({ ...p, participants: [...p.participants] }));
  const archivistKept: ChatPlan[] = [];
  for (const move of proposal) {
    const what = move.what.trim().slice(0, PLAN_WHAT_MAX_CHARS);
    if (!what) continue;
    const key = normalizePlanKey(what);
    let plan = out.find((p) => normalizePlanKey(p.what) === key);
    if (!plan) {
      // A status-only move ("kept"/"canceled") that matches nothing is a no-op — never
      // mint a plan already resolved (that would be an off-screen event, not a commitment).
      if (move.status && move.status !== "upcoming") continue;
      plan = {
        id: ctx.mintId(),
        what,
        participants: dedupeParticipants(move.participants),
        where: move.where.trim() ? move.where.trim().slice(0, PLAN_WHERE_MAX_CHARS) : undefined,
        when: resolvePlanWhen(move.when, ctx.nowMinutes, ctx.calendarStart),
        status: "upcoming",
        struckAtMinutes: ctx.nowMinutes,
      };
      out.push(plan);
    } else {
      if (move.participants.length) plan.participants = dedupeParticipants([...plan.participants, ...move.participants]);
      if (move.where.trim()) plan.where = move.where.trim().slice(0, PLAN_WHERE_MAX_CHARS);
      if (move.when && (move.when.dayOffset !== undefined || move.when.dayPart || move.when.unscheduled)) {
        plan.when = resolvePlanWhen(move.when, plan.struckAtMinutes || ctx.nowMinutes, ctx.calendarStart);
      }
    }
    if (move.status === "kept" && plan.status !== "kept") {
      plan.status = "kept";
      archivistKept.push(plan);
    } else if (move.status === "canceled") {
      plan.status = "canceled";
    } else if (move.status === "upcoming" && (plan.status === "missed" || plan.status === "canceled")) {
      // The fiction revived a plan the clock (or a cancellation) had closed.
      plan.status = "upcoming";
    }
  }
  return { plans: capPlans(out), archivistKept };
}

/**
 * Advance plans deterministically as the (already-ticked) clock passes their due-time
 * (pure). An `upcoming` scheduled plan whose due window has fully passed (`delta <
 * −DUE_WINDOW`) and which the archivist did not resolve this exchange transitions to:
 *
 * - **missed** — when the plan involves the PLAYER (skipping past Friday's dinner means
 *   something); this is the signal the pulse + milestone + "just missed" directive key on.
 * - **kept** — when the plan is NPC↔NPC (assume it happened off-screen — ruling E, the
 *   default until the meanwhile pass decides it).
 *
 * Returns the mutated list plus the fresh transitions (`justMissed` / `justKept`).
 */
export function advancePlans(
  plans: readonly ChatPlan[],
  nowMinutes: number,
  playerName: string,
): { plans: ChatPlan[]; justMissed: ChatPlan[]; justKept: ChatPlan[] } {
  const justMissed: ChatPlan[] = [];
  const justKept: ChatPlan[] = [];
  const out = plans.map((plan) => {
    if (plan.status !== "upcoming" || plan.when.kind !== "scheduled") return plan;
    const delta = plan.when.targetMinutes - nowMinutes;
    if (delta >= -PLAN_DUE_WINDOW_MINUTES) return plan; // still upcoming / due / within grace
    if (planInvolvesPlayer(plan, playerName)) {
      const missed = { ...plan, status: "missed" as const };
      justMissed.push(missed);
      return missed;
    }
    const kept = { ...plan, status: "kept" as const };
    justKept.push(kept);
    return kept;
  });
  return { plans: out, justMissed, justKept };
}

/** A plan's transient salience this turn (derived, never stored). */
export type PlanSalience = "dueNow" | "imminent" | "justMissed" | "upcoming";

/** One salient plan for the narrator/tail. `whenLabel` is the render-time calendar label. */
export interface SalientPlan {
  plan: ChatPlan;
  salience: PlanSalience;
  /** "Friday evening" with a calendar anchor; the stored relative label otherwise. */
  whenLabel: string;
}

const SALIENCE_RANK: Record<PlanSalience, number> = { dueNow: 0, justMissed: 1, imminent: 2, upcoming: 3 };

/**
 * Derive each plan's transient salience against the clock (pure, prompt-build-time): due
 * now, imminent, just-missed, or a far-upcoming one — sorted most-urgent-first. Canceled and
 * resolved-kept plans drop (kept plans reach the narrator through facts/callbacks, not the
 * near list). Unscheduled plans never surface as "near". The tail renderer decides how many
 * of the far-upcoming to keep.
 */
export function derivePlanSalience(
  plans: readonly ChatPlan[],
  nowMinutes: number,
  calendarStart?: CalendarStart,
): SalientPlan[] {
  const ctx = calendarStart ? { nowMinutes, calendarStart } : undefined;
  const salient = (plan: ChatPlan, salience: PlanSalience): SalientPlan => ({
    plan,
    salience,
    whenLabel: describePlanWhen(plan.when, ctx),
  });
  const out: SalientPlan[] = [];
  for (const plan of plans) {
    if (plan.status === "canceled" || plan.status === "kept") continue;
    if (plan.status === "missed") {
      if (plan.when.kind === "scheduled" && plan.when.targetMinutes - nowMinutes >= -PLAN_JUST_MISSED_WINDOW_MINUTES) {
        out.push(salient(plan, "justMissed"));
      }
      continue;
    }
    // upcoming
    if (plan.when.kind !== "scheduled") continue;
    const delta = plan.when.targetMinutes - nowMinutes;
    if (delta > PLAN_IMMINENT_WINDOW_MINUTES) out.push(salient(plan, "upcoming"));
    else if (delta > 0) out.push(salient(plan, "imminent"));
    else if (delta >= -PLAN_DUE_WINDOW_MINUTES) out.push(salient(plan, "dueNow"));
    else if (delta >= -PLAN_JUST_MISSED_WINDOW_MINUTES) out.push(salient(plan, "justMissed"));
  }
  return out.sort((a, b) => SALIENCE_RANK[a.salience] - SALIENCE_RANK[b.salience]);
}

/** True when any plan is near enough this turn to own the beat (due/imminent/just-missed). Pure. */
export function hasSalientPlan(salient: readonly SalientPlan[]): boolean {
  return salient.some((s) => s.salience !== "upcoming");
}

/**
 * A short "has something to say" reason for the hub marker (chat-plans-promises): the most
 * urgent NEAR plan phrased for the chat list, or null when nothing is near. Outranks open
 * loops in the marker (an imminent / just-missed commitment is a stronger pull). Pure.
 */
export function planHubReason(plans: readonly ChatPlan[], nowMinutes: number, calendarStart?: CalendarStart): string | null {
  const near = derivePlanSalience(plans, nowMinutes, calendarStart).find((s) => s.salience !== "upcoming");
  if (!near) return null;
  const what = near.plan.what.trim();
  switch (near.salience) {
    case "justMissed":
      return `you skipped past ${what}`;
    case "dueNow":
      return `${what} — right now`;
    case "imminent":
      return `${what} — ${near.whenLabel}`;
    case "upcoming":
      return null;
  }
}

/** Fill any missing ids (the UI author-edit path sends plans that may lack one). Pure. */
export function fillMissingPlanIds(plans: readonly ChatPlan[], mintId: () => string): ChatPlan[] {
  return plans.map((p) => (p.id ? p : { ...p, id: mintId() }));
}
