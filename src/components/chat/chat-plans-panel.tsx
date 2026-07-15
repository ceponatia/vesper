"use client";

import { useState, type ReactNode } from "react";
import {
  CHAT_PLANS_OPEN_MAX,
  describePlanWhen,
  derivePlanSalience,
  resolvePlanWhen,
  SCHEDULE_DAY_PARTS,
  type ChatPlan,
  type PlanStatus,
  type ScheduleDayPartId,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { chatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";

/** Glyph + tone per stored status (mirrors the relationship-panel milestone glyphs). */
const STATUS_GLYPH: Record<PlanStatus, { glyph: string; className: string }> = {
  upcoming: { glyph: "○", className: "text-accent-300" },
  kept: { glyph: "✓", className: "text-accent-300" },
  missed: { glyph: "✕", className: "text-rose-400" },
  canceled: { glyph: "⊘", className: "text-paper-500" },
};

const DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Today" },
  { value: 1, label: "Tomorrow" },
  { value: 2, label: "In 2 days" },
  { value: 3, label: "In 3 days" },
  { value: 7, label: "In a week" },
];

/**
 * The Plans panel (chat-plans-promises.plan.md, Slice 4): the conversation's tracked
 * commitments, listed below Supporting Cast. Plans accrete as the story strikes them and
 * come due on the story clock; this panel is the manual override — seed a plan the fiction
 * hasn't stated yet, fix a when, mark one kept/canceled, or remove a mis-minted entry.
 * Saves are whole-list replacements through the state PATCH (chat-wide field); a 409 means a
 * reply is streaming — try again after it settles.
 */
export function ChatPlansPanel({
  chatId,
  plans,
  clockMinutes,
  archived,
  onSaved,
}: {
  chatId: string;
  plans: ChatPlan[];
  /** The story clock, so an edited "when" resolves to an absolute target and salience derives. */
  clockMinutes: number;
  archived: boolean;
  /** Receives the fresh state snapshot after a successful save. */
  onSaved: (snapshot: ChatStateSnapshot) => void;
}) {
  const toast = useToast();
  /** The plan being viewed/edited, or "new" for the add flow; null = closed. */
  const [editing, setEditing] = useState<ChatPlan | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  const salience = new Map(derivePlanSalience(plans, clockMinutes).map((s) => [s.plan.id, s.salience]));
  const openCount = plans.filter((p) => p.status === "upcoming").length;

  const save = async (next: ChatPlan[]) => {
    setSaving(true);
    const result = await chatsApi.editState(chatId, { plans: next });
    setSaving(false);
    if (!result.ok) {
      toast.push({
        title: "Couldn't save the plans",
        description:
          result.error.code === "chat_busy" ? "A reply is still streaming — try again in a moment." : result.error.message,
        tone: "error",
      });
      return false;
    }
    onSaved(result.data);
    return true;
  };

  const upsert = async (original: ChatPlan | "new", plan: ChatPlan) => {
    const rest = original === "new" ? plans : plans.filter((p) => p.id !== original.id);
    if (await save([...rest, plan])) setEditing(null);
  };

  const remove = async (original: ChatPlan) => {
    if (await save(plans.filter((p) => p.id !== original.id))) setEditing(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Plans</span>
      {plans.length === 0 ? (
        <p className="text-xs text-paper-500">No plans yet — commitments appear here as the story makes them.</p>
      ) : (
        plans.map((plan) => {
          const badge = STATUS_GLYPH[plan.status];
          const near = salience.get(plan.id);
          const soon = near === "dueNow" || near === "imminent" || near === "justMissed";
          return (
            <button
              key={plan.id}
              type="button"
              onClick={() => setEditing(plan)}
              title={plan.participants.join(", ") || undefined}
              className="flex cursor-pointer items-start gap-1.5 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-left transition-colors hover:border-accent-500/50"
            >
              <span className={`mt-0.5 text-xs ${badge.className}`} aria-hidden>
                {badge.glyph}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={`truncate text-sm ${plan.status === "upcoming" ? "text-paper-200" : "text-paper-400 line-through"}`}>
                  {plan.what}
                </span>
                <span className={`truncate text-[10px] ${soon ? "text-accent-300" : "text-paper-500"}`}>
                  {describePlanWhen(plan.when)}
                  {plan.participants.length ? ` · ${plan.participants.join(", ")}` : ""}
                </span>
              </span>
            </button>
          );
        })
      )}
      {!archived && openCount < CHAT_PLANS_OPEN_MAX ? (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="cursor-pointer rounded-md border border-dashed border-ink-500 px-2 py-1.5 text-left text-xs text-paper-400 transition-colors hover:border-accent-500/50 hover:text-paper-200"
        >
          + Add plan
        </button>
      ) : null}
      {editing !== null ? (
        <PlanDialog
          plan={editing === "new" ? null : editing}
          clockMinutes={clockMinutes}
          readOnly={archived}
          saving={saving}
          onClose={() => {
            if (!saving) setEditing(null);
          }}
          onSave={(plan) => void upsert(editing, plan)}
          onRemove={editing === "new" ? undefined : () => void remove(editing)}
        />
      ) : null}
    </div>
  );
}

/** The lightbox editor for one plan — what / who / where / when / status. */
function PlanDialog({
  plan,
  clockMinutes,
  readOnly,
  saving,
  onClose,
  onSave,
  onRemove,
}: {
  /** null = the add-plan flow (empty form). */
  plan: ChatPlan | null;
  clockMinutes: number;
  readOnly: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (plan: ChatPlan) => void;
  onRemove?: () => void;
}) {
  const [what, setWhat] = useState(plan?.what ?? "");
  const [participants, setParticipants] = useState((plan?.participants ?? []).join(", "));
  const [where, setWhere] = useState(plan?.where ?? "");
  const [status, setStatus] = useState<PlanStatus>(plan?.status ?? "upcoming");
  // "keep" leaves an existing plan's when untouched; new plans default to unscheduled.
  const [whenMode, setWhenMode] = useState<"keep" | "unscheduled" | "scheduled">(plan ? "keep" : "unscheduled");
  const [dayOffset, setDayOffset] = useState(1);
  const [dayPart, setDayPart] = useState<ScheduleDayPartId>("evening");

  const submit = () => {
    if (!what.trim()) return;
    const when =
      whenMode === "keep" && plan
        ? plan.when
        : whenMode === "unscheduled"
          ? ({ kind: "unscheduled" } as const)
          : resolvePlanWhen({ dayOffset, dayPart }, clockMinutes);
    onSave({
      id: plan?.id || newId(),
      what: what.trim(),
      participants: participants
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      where: where.trim() || undefined,
      when,
      status,
      struckAtMinutes: plan?.struckAtMinutes ?? clockMinutes,
    });
  };

  const field = (label: string, node: ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-paper-400">
      {label}
      {node}
    </label>
  );

  const selectClass =
    "rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm text-paper-200 focus:border-accent-500 focus:outline-none disabled:opacity-60";

  return (
    <Dialog
      open
      onClose={onClose}
      title={plan ? plan.what : "Add a plan"}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {onRemove && !readOnly ? (
            <Button variant="danger" size="sm" disabled={saving} onClick={onRemove}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            {!readOnly ? (
              <Button variant="primary" busy={saving} disabled={!what.trim()} onClick={submit}>
                Save
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {field(
          "What",
          <Input value={what} onChange={(e) => setWhat(e.target.value)} disabled={readOnly} placeholder="dinner at the pier" />,
        )}
        {field(
          "Who (comma-separated)",
          <Input
            value={participants}
            onChange={(e) => setParticipants(e.target.value)}
            disabled={readOnly}
            placeholder="Mara, the player"
          />,
        )}
        {field("Where (optional)", <Input value={where} onChange={(e) => setWhere(e.target.value)} disabled={readOnly} placeholder="the pier" />)}
        {field(
          "When",
          <div className="flex flex-col gap-2">
            <select
              value={whenMode}
              onChange={(e) => setWhenMode(e.target.value as "keep" | "unscheduled" | "scheduled")}
              disabled={readOnly}
              className={selectClass}
            >
              {plan ? <option value="keep">Keep current ({describePlanWhen(plan.when)})</option> : null}
              <option value="unscheduled">No set time (soon)</option>
              <option value="scheduled">Scheduled…</option>
            </select>
            {whenMode === "scheduled" ? (
              <div className="flex gap-2">
                <select
                  value={dayOffset}
                  onChange={(e) => setDayOffset(Number(e.target.value))}
                  disabled={readOnly}
                  className={`${selectClass} flex-1`}
                >
                  {DAY_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <select
                  value={dayPart}
                  onChange={(e) => setDayPart(e.target.value as ScheduleDayPartId)}
                  disabled={readOnly}
                  className={`${selectClass} flex-1`}
                >
                  {SCHEDULE_DAY_PARTS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>,
        )}
        {field(
          "Status",
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as PlanStatus)}
            disabled={readOnly}
            className={selectClass}
          >
            <option value="upcoming">Upcoming</option>
            <option value="kept">Kept</option>
            <option value="missed">Missed</option>
            <option value="canceled">Canceled</option>
          </select>,
        )}
        <p className="text-[11px] text-paper-500">
          The character remembers this and it comes due on the story clock — a kept plan warms things, a missed one lands honestly.
        </p>
      </div>
    </Dialog>
  );
}
