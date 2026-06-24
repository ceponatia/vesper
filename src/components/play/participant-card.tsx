"use client";

import { useState } from "react";
import { INNER_NOTE_MAX_CHARS, meterDefinitions, stageById } from "@/contracts";
import { formatElapsed } from "@/lib/clock";
import { sessionsApi } from "@/lib/client/api";
import type { StatusParticipant } from "@/lib/client/use-session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { EntityImage } from "@/components/ui/entity-image";
import { Select } from "@/components/ui/select";
import { Tag, type TagTone } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { PlayerRelationship } from "./cast-relationship";

const meterLabels = new Map(meterDefinitions.map((m) => [m.id, m.label]));

/** Glanceable glyph per emotion label (mood.spec §2) for the cast-card mood chip. */
const emotionGlyph: Record<string, string> = {
  neutral: "😐",
  happy: "🙂",
  affectionate: "🥰",
  playful: "😏",
  flustered: "😳",
  concerned: "😟",
  sad: "😢",
  angry: "😠",
  afraid: "😨",
  surprised: "😲",
  aroused: "🥵",
};

/** Registry label for a stage id; unknown ids degrade to a capitalized raw id. */
function stageLabel(stageId: string): string {
  const known = stageById(stageId)?.label;
  if (known) return known;
  return stageId ? stageId.charAt(0).toUpperCase() + stageId.slice(1) : "Stranger";
}

function MeterBar({ id, value }: { id: string; value: number }) {
  const clamped = Math.min(1, Math.max(0, value));
  const label = meterLabels.get(id) ?? id;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-14 shrink-0 truncate text-paper-400">{label}</span>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700"
      >
        <div className="h-full rounded-full bg-accent-500/80" style={{ width: `${clamped * 100}%` }} />
      </div>
      <span className="w-7 shrink-0 text-right text-paper-500">{Math.round(clamped * 100)}</span>
    </div>
  );
}

const severityTone: Record<string, TagTone> = {
  minor: "default",
  moderate: "accent",
  severe: "danger",
};

function SectionTitle({ children }: { children: string }) {
  return <h4 className="text-[10px] font-medium tracking-wide text-paper-500 uppercase">{children}</h4>;
}

/**
 * Inner note (docs/ui.md §Cast): the player injects a memory, feeling, or
 * belief for an NPC — never dialogue. Submission enqueues a non-blocking
 * background job; the NPC carries the note from the next turn.
 */
function InnerNoteSection({ sessionId, participant }: { sessionId: string; participant: StatusParticipant }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const note = text.trim();
    if (!note || submitting) return;
    setSubmitting(true);
    const result = await sessionsApi.submitInnerNote(sessionId, participant.id, note);
    setSubmitting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't add the inner note", description: result.error.message, tone: "error" });
      return;
    }
    setText("");
    toast.push({
      title: `${participant.displayName} will carry this from the next turn`,
      tone: "success",
    });
  };

  return (
    <section>
      <SectionTitle>Inner note</SectionTitle>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={INNER_NOTE_MAX_CHARS}
        disabled={submitting}
        placeholder="Inject a memory, feeling, or belief for this character — never dialogue or actions"
        aria-label={`Inner note for ${participant.displayName}`}
        className="mt-1 text-xs"
      />
      <Button
        size="sm"
        variant="primary"
        className="mt-1.5"
        busy={submitting}
        disabled={text.trim().length === 0}
        onClick={() => void submit()}
      >
        Add note
      </Button>
    </section>
  );
}

/**
 * One cast member's accordion card (docs/ui.md §Play screen): portrait,
 * activity, tier, relationship-to-player, meters, conditions, and the visible
 * outfit when collapsed; full inventory, location, and inner-note controls when
 * expanded. Shared by the Cast tab (whole roster) and the Scene tab (present
 * NPCs) — a pure presentational component; all data flows in via props.
 */
export function ParticipantCard({
  sessionId,
  participant,
  relationship,
  playerLocationId,
  expanded,
  onToggle,
  onTeleported,
  onClothingChanged,
}: {
  sessionId: string;
  participant: StatusParticipant;
  relationship: PlayerRelationship | null;
  playerLocationId: string | null;
  expanded: boolean;
  onToggle: () => void;
  /** Dev-only: provided by the Cast tab to enable "teleport to player"; the
   *  parent refreshes the session after a successful snap. */
  onTeleported?: () => void;
  /** Dev-only: provided by the Cast tab for wardrobe/inventory test toggles. */
  onClothingChanged?: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [teleporting, setTeleporting] = useState(false);
  const [selectedHeldId, setSelectedHeldId] = useState("");
  const [clothingAction, setClothingAction] = useState<{
    itemInstanceId: string;
    action: "wear" | "remove";
  } | null>(null);
  const meters = Object.entries(participant.meters);
  // The visible outfit list: hidden layers stay out of the collapsed card (docs/ui.md).
  const outfit = participant.wardrobe.filter((w) => w.visibility !== "hidden");
  // Expanded inventory: every layer when the payload ships it; old payloads
  // lack wornFull and degrade to the visible outfit.
  const wornAll = participant.wornFull.length > 0 ? participant.wornFull : outfit;
  // Their location only matters when they're somewhere the player isn't.
  const elsewhere =
    !participant.isUser && participant.locationName && participant.locationId !== playerLocationId
      ? participant.locationName
      : null;
  const detailsId = `cast-card-details-${participant.id}`;

  // Dev-only debug affordance: snap an off-location NPC to the player. Hidden in
  // production, and only when the Cast tab wired the refresh callback.
  const canTeleport =
    process.env.NODE_ENV !== "production" &&
    !!onTeleported &&
    !participant.isUser &&
    !!playerLocationId &&
    participant.locationId !== playerLocationId;
  const canEditClothing = process.env.NODE_ENV !== "production" && !!onClothingChanged;
  const heldClothing = participant.held.filter((item) => item.kind === "clothing" && item.id.length > 0);
  const selectedWearId = heldClothing.some((item) => item.id === selectedHeldId)
    ? selectedHeldId
    : (heldClothing[0]?.id ?? "");
  const selectedWearName = heldClothing.find((item) => item.id === selectedWearId)?.name ?? "clothing";

  const teleport = async () => {
    if (teleporting) return;
    setTeleporting(true);
    const result = await sessionsApi.teleportToPlayer(sessionId, participant.id);
    setTeleporting(false);
    if (!result.ok) {
      toast.push({ title: "Teleport failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: `${participant.displayName} pulled to your location`, tone: "success" });
    onTeleported?.();
  };

  const updateClothing = async (action: "wear" | "remove", itemInstanceId: string, itemName: string) => {
    if (!onClothingChanged || process.env.NODE_ENV === "production" || clothingAction) return;
    setClothingAction({ action, itemInstanceId });
    const result = await sessionsApi.updateParticipantClothing(sessionId, participant.id, { action, itemInstanceId });
    setClothingAction(null);
    if (!result.ok) {
      toast.push({ title: "Clothing update failed", description: result.error.message, tone: "error" });
      return;
    }
    if (action === "wear") setSelectedHeldId("");
    toast.push({
      title:
        action === "wear"
          ? `${participant.displayName} is wearing ${itemName}`
          : `${itemName} moved to ${participant.displayName}'s inventory`,
      tone: "success",
    });
    await onClothingChanged();
  };

  return (
    <Card className="p-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        className="flex w-full cursor-pointer items-start gap-3 text-left"
      >
        <EntityImage
          imageId={participant.avatarImageId}
          name={participant.displayName}
          className="size-12 shrink-0 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium text-paper-50">{participant.displayName}</p>
            <span className="flex shrink-0 items-baseline gap-1.5">
              <span className="text-[10px] tracking-wide text-paper-500 uppercase">
                {participant.isUser ? "you" : participant.role}
              </span>
              <Tag className="px-1.5 text-[10px]" title="Simulation depth">
                {participant.tier}
              </Tag>
              <span
                aria-hidden
                className={cx(
                  "inline-block text-[10px] text-paper-500 transition-transform duration-100",
                  expanded && "rotate-180",
                )}
              >
                ▾
              </span>
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-paper-400 italic">
            {participant.activity}
            {participant.posture ? ` · ${participant.posture}` : ""}
          </p>
          {participant.emotion ? (
            <p
              className="mt-1 flex items-center gap-1 text-[11px] text-paper-400"
              title={`Mood — intensity ${Math.round(participant.emotion.intensity * 100)}%`}
            >
              <span aria-hidden>{emotionGlyph[participant.emotion.label] ?? "·"}</span>
              <span className="capitalize">{participant.emotion.label}</span>
            </p>
          ) : null}
        </div>
      </button>

      {relationship ? (
        <div className="mt-2 text-[11px]">
          <p className="text-paper-400">
            {stageLabel(relationship.stage)} <span className="text-paper-500">toward you</span>
          </p>
          {relationship.perceivedStage ? (
            <p className="text-paper-500 italic">
              thinks you&apos;re {stageLabel(relationship.perceivedStage).toLowerCase()} toward them
            </p>
          ) : null}
        </div>
      ) : null}

      {meters.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1">
          {meters.map(([id, value]) => (
            <MeterBar key={id} id={id} value={value} />
          ))}
        </div>
      ) : null}

      {participant.conditions.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {participant.conditions.map((condition, i) => (
            <Tag key={condition.id || i} tone={severityTone[condition.severity ?? "minor"] ?? "default"}>
              {condition.label}
              {expanded && condition.remainingMinutes !== null
                ? ` · ${formatElapsed(condition.remainingMinutes)}`
                : ""}
            </Tag>
          ))}
        </div>
      ) : null}

      {!expanded && outfit.length > 0 ? (
        <ul className="mt-2.5 flex flex-col gap-0.5 border-t border-ink-700 pt-2 text-xs">
          {outfit.map((item, i) => (
            <li
              key={`${item.name}-${i}`}
              className={cx("truncate", item.visibility === "hinted" ? "text-paper-500 italic" : "text-paper-300")}
            >
              {item.name}
              {item.visibility === "hinted" ? " (hinted)" : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {expanded ? (
        <div id={detailsId} className="mt-2.5 flex flex-col gap-2.5 border-t border-ink-700 pt-2">
          {elsewhere ? (
            <p className="text-[11px] text-paper-400">
              <span className="text-paper-500">Currently at</span> {elsewhere}
            </p>
          ) : null}

          {canTeleport ? (
            <Button
              size="sm"
              variant="ghost"
              busy={teleporting}
              onClick={() => void teleport()}
              className="self-start"
              title="Dev-only: snap this character to your location, bypassing movement"
            >
              ⚡ Teleport to me (dev)
            </Button>
          ) : null}

          {wornAll.length > 0 ? (
            <section>
              <SectionTitle>Wearing</SectionTitle>
              {/* DEV-ONLY DISPLAY: hidden layers render (italic, marked) for
                  debugging wardrobe state. For production this list must
                  filter `visibility === "hidden"` — players should not see
                  under-layers the fiction hides (docs/ui.md, followups.phase2.md
                  #7). UI-only change; state/visibility resolution is shared
                  and stays as is. */}
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {wornAll.map((item, i) => (
                  <li
                    key={item.instanceId ?? `${item.name}-${i}`}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <span
                      className={cx(
                        "min-w-0 flex-1 truncate",
                        item.visibility === "visible" ? "text-paper-300" : "text-paper-500 italic",
                      )}
                    >
                      {item.name}
                      {item.visibility === "hinted" ? " (hinted)" : ""}
                      {item.visibility === "hidden" ? " (hidden under other layers)" : ""}
                    </span>
                    {canEditClothing && item.instanceId ? (
                      <Button
                        size="sm"
                        variant="quiet"
                        busy={clothingAction?.action === "remove" && clothingAction.itemInstanceId === item.instanceId}
                        disabled={clothingAction !== null}
                        onClick={() => void updateClothing("remove", item.instanceId ?? "", item.name)}
                        className="h-6 px-2 text-[11px]"
                        title="Move this worn clothing item into held inventory"
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {participant.held.length > 0 ? (
            <section>
              <SectionTitle>Holding</SectionTitle>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {participant.held.map((item, i) => (
                  <li key={item.id || `${item.name}-${i}`} className="truncate text-paper-300">
                    {item.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {canEditClothing ? (
            <section>
              <SectionTitle>Wear held clothing</SectionTitle>
              {heldClothing.length > 0 ? (
                <div className="mt-1 flex items-center gap-1.5">
                  <Select
                    value={selectedWearId}
                    disabled={clothingAction !== null}
                    onChange={(e) => setSelectedHeldId(e.target.value)}
                    aria-label={`Held clothing for ${participant.displayName}`}
                    className="h-7 min-w-0 flex-1 text-xs"
                  >
                    {heldClothing.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={clothingAction?.action === "wear" && clothingAction.itemInstanceId === selectedWearId}
                    disabled={clothingAction !== null || selectedWearId.length === 0}
                    onClick={() => void updateClothing("wear", selectedWearId, selectedWearName)}
                    className="h-7"
                    title="Move this held clothing item onto the character"
                  >
                    Wear
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-paper-500">No held clothing.</p>
              )}
            </section>
          ) : null}

          {!participant.isUser ? <InnerNoteSection sessionId={sessionId} participant={participant} /> : null}
        </div>
      ) : null}
    </Card>
  );
}
