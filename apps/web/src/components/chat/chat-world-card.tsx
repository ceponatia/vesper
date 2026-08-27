"use client";

import { useId, useState } from "react";
import { placeAtPhrase } from "@vesper/simulation-core/solo-cut";
import {
  approxActivityMinutes,
  approxWalkMinutes,
  capitalizeFirst,
  goChipLabel,
  placeGoPhrase,
} from "@vesper/simulation-core/world-read";
import { chatsApi, type ChatWorld } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  displayWorldActionLabel,
  displayWorldAlternative,
  worldCastKey,
} from "./chat-world-card-format";

type Destination = ChatWorld["destinations"][number];
type HeldItem = ChatWorld["held"][number];
type WorldAction = ChatWorld["actions"][number];

/**
 * The world card: the player-facing surface of
 * the successor world, beside the clock card in the right "story time" aside
 * (and in the responsive World sheet). It draws where the player is (or is walking
 * to), who else is around, the open destinations as skip-style travel chips
 * (ruling 20), the player's pocket with a "Hand to {primary}" handoff
 * (`give_item`), and the zone-gated actions as skip-style chips (`do_activity`).
 * Every world command routes its refusal through ONE refusal surface (publicReason
 * + legalAlternatives). A landing / handoff / performed action refreshes the
 * transcript (the server-written world beat), the world envelope, and chat
 * state via `onWorldChanged`. Renders nothing for a degraded / legacy / shadow
 * chat (world === null). The host owns loading/degraded status so this component
 * can stay focused on an available projection.
 */

/** A human "time remaining" for the catch-up banner; "" below an hour (not worth a number). */
function catchUpRemaining(cu: { targetStorySecond: number; reachedStorySecond: number }): string {
  const seconds = Math.max(0, cu.targetStorySecond - cu.reachedStorySecond);
  if (seconds < 3_600) return "";
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.round(seconds / 3_600);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export function ChatWorldCard({
  chatId,
  world,
  archived,
  busy,
  onWorldChanged,
}: {
  chatId: string;
  world: ChatWorld | null;
  archived: boolean;
  /** True while a reply / skip is in flight — every chip disables (same discipline as skip chips). */
  busy: boolean;
  /** Host refreshes the transcript (the new world beat), world envelope, and chat state after a world change. */
  onWorldChanged: () => void;
}) {
  const toast = useToast();
  const [travelingZone, setTravelingZone] = useState<string | null>(null);
  const [travelingTogetherZone, setTravelingTogetherZone] = useState<string | null>(null);
  const [givingItem, setGivingItem] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ publicReason: string; legalAlternatives: string[] } | null>(null);
  const actionReasonId = useId();

  if (!world) return null;

  // One command in flight at a time — travel, walk-together, a handoff, and an
  // action are mutually exclusive (each moves the same world clock). While a durable
  // time job is catching the world up, every affordance is disabled — the server owns the clock
  // until it settles (a click would only bounce with world_catching_up).
  const anyBusy =
    busy ||
    archived ||
    world.catchingUp != null ||
    travelingZone !== null ||
    travelingTogetherZone !== null ||
    givingItem !== null ||
    actingId !== null;

  // The give-item target is always the primary; the card knows them (and their
  // presence) from the cast. Actions stay visible when unavailable so the
  // authored reason can explain the world rule instead of making the action
  // appear to vanish.
  const primary = world.cast.find((member) => member.isPrimary) ?? null;
  const refusalAlternatives =
    refusal?.legalAlternatives.map(displayWorldAlternative).filter((alternative) => alternative.length > 0) ?? [];

  const travel = async (dest: Destination) => {
    if (anyBusy) return;
    setTravelingZone(dest.zoneId);
    setRefusal(null);
    const result = await chatsApi.simTravel(chatId, dest.zoneId);
    setTravelingZone(null);
    if (!result.ok) {
      if (result.error.code === "chat_busy") {
        onWorldChanged();
        return;
      }
      toast.push({ title: "Travel failed", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.status === "rejected") {
      setRefusal({
        publicReason: result.data.publicReason || "You can't go there right now.",
        legalAlternatives: result.data.legalAlternatives,
      });
      return;
    }
    if (!result.data.arrived || result.data.drainShort) {
      toast.push({
        title: "Journey started",
        description: "The world is still catching up; your destination will appear when you arrive.",
      });
    }
    onWorldChanged();
  };

  const travelTogether = async (dest: Destination) => {
    if (anyBusy || !primary?.present) return;
    setTravelingTogetherZone(dest.zoneId);
    setRefusal(null);
    const result = await chatsApi.simMoveTogether(chatId, dest.zoneId);
    setTravelingTogetherZone(null);
    if (!result.ok) {
      if (result.error.code === "chat_busy") {
        onWorldChanged();
        return;
      }
      toast.push({ title: "Travel failed", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.status === "rejected") {
      setRefusal({
        publicReason: result.data.publicReason || "You can't go together right now.",
        legalAlternatives: result.data.legalAlternatives,
      });
      return;
    }
    if (!result.data.arrived || result.data.drainShort) {
      toast.push({
        title: "Walking together",
        description: "The journey is in progress; the world panel will update on arrival.",
      });
    }
    onWorldChanged();
  };

  const give = async (item: HeldItem) => {
    if (anyBusy || !primary?.present) return;
    setGivingItem(item.itemId);
    setRefusal(null);
    const result = await chatsApi.simGiveItem(chatId, item.itemId);
    setGivingItem(null);
    if (!result.ok) {
      if (result.error.code === "chat_busy") {
        onWorldChanged();
        return;
      }
      toast.push({ title: "That didn't work", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.status === "rejected") {
      setRefusal({
        publicReason: result.data.publicReason || "You can't hand that over right now.",
        legalAlternatives: result.data.legalAlternatives,
      });
      return;
    }
    onWorldChanged();
  };

  const doActivity = async (action: WorldAction) => {
    if (anyBusy) return;
    setActingId(action.id);
    setRefusal(null);
    const result = await chatsApi.simDoActivity(chatId, action.id);
    setActingId(null);
    if (!result.ok) {
      if (result.error.code === "chat_busy") {
        onWorldChanged();
        return;
      }
      toast.push({ title: "That didn't work", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.status === "rejected") {
      setRefusal({
        publicReason: result.data.publicReason || "You can't do that right now.",
        legalAlternatives: result.data.legalAlternatives,
      });
      return;
    }
    if (result.data.drainShort) {
      toast.push({
        title: "Activity started",
        description: "The world is still catching up; progress will settle here shortly.",
      });
    }
    onWorldChanged();
  };

  const placeLine = world.transit
    ? world.transit.toLabel === "home"
      ? `Walking home — there in ~${approxWalkMinutes(world.transit.arrivesInSeconds)} min`
      : `Walking to ${placeGoPhrase(world.transit.toLabel)} — there in ~${approxWalkMinutes(world.transit.arrivesInSeconds)} min`
    : world.place
      ? capitalizeFirst(placeAtPhrase(world.place.label))
      : "Whereabouts unknown";

  return (
    <div className="flex flex-col gap-1.5">
      {world.catchingUp ? (
        <div
          className="flex items-center gap-2 rounded-md border border-accent-600/40 bg-accent-950/30 px-2.5 py-2 text-xs text-accent-200"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent-400" aria-hidden="true" />
          <span>
            The world is catching up…
            {catchUpRemaining(world.catchingUp) ? ` about ${catchUpRemaining(world.catchingUp)} to go.` : ""}
          </span>
        </div>
      ) : null}
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Where you are</span>
      <div className="rounded-md border border-ink-600 bg-ink-850 px-2.5 py-2">
        <span className="block text-sm text-paper-200">{placeLine}</span>

        {world.cast.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-paper-400">
            {world.cast.map((member, index) => (
              <span key={worldCastKey(world.cast, index)}>
                {member.present ? `${member.name} — here with you` : `${member.name} — ${member.whereabouts}`}
              </span>
            ))}
          </div>
        ) : null}

        {world.destinations.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1.5" role="group" aria-label="Travel">
            {world.destinations.map((dest) => (
              <div key={dest.zoneId} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant="quiet"
                    busy={travelingZone === dest.zoneId}
                    disabled={anyBusy}
                    title={`~${approxWalkMinutes(dest.travelSeconds)} min walk`}
                    onClick={() => void travel(dest)}
                  >
                    {goChipLabel(dest.label)}
                  </Button>
                  {/* Walk-with-me: only when the primary is here to accept. */}
                  {primary?.present ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      busy={travelingTogetherZone === dest.zoneId}
                      disabled={anyBusy}
                      title={`Walk there with ${primary.name}`}
                      onClick={() => void travelTogether(dest)}
                    >
                      Walk together
                    </Button>
                  ) : null}
                </div>
                {/* Travel time visible without hover — the title tooltip is invisible on touch. */}
                <span className="text-[10px] text-paper-600">
                  {goChipLabel(dest.label)} · ~{approxWalkMinutes(dest.travelSeconds)} min walk
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {world.held.length > 0 ? (
          <div className="mt-2 border-t border-ink-700 pt-2">
            <span className="block text-[10px] font-medium tracking-wide text-paper-500 uppercase">In your pocket</span>
            <div className="mt-1 flex flex-col gap-1">
              {world.held.map((item) => (
                <div key={item.itemId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-paper-300">{item.name}</span>
                  {primary ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      busy={givingItem === item.itemId}
                      disabled={anyBusy || !primary.present}
                      title={primary.present ? undefined : `${primary.name} isn't here`}
                      onClick={() => void give(item)}
                    >
                      Hand to {primary.name}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            {primary && !primary.present ? (
              <span className="mt-1 block text-[10px] text-paper-600">{`${primary.name} isn't here to take it.`}</span>
            ) : null}
          </div>
        ) : null}

        {world.actions.length > 0 ? (
          <div className="mt-2 border-t border-ink-700 pt-2">
            <span className="block text-[10px] font-medium tracking-wide text-paper-500 uppercase">Things to do</span>
            <div className="mt-1 flex flex-col gap-1.5" role="group" aria-label="Actions">
              {world.actions.map((action, index) => {
                const label = displayWorldActionLabel(action.label, action.id);
                const reasonId = `${actionReasonId}-${index}`;
                const unavailableReason = action.unavailableReason || "This isn't available right now.";
                return (
                  <div key={action.id} className="flex flex-col items-start gap-0.5">
                    <Button
                      size="sm"
                      variant="quiet"
                      busy={actingId === action.id}
                      disabled={anyBusy || !action.available}
                      title={
                        action.available
                          ? `~${approxActivityMinutes(action.durationSeconds)} min`
                          : unavailableReason
                      }
                      aria-describedby={action.available ? undefined : reasonId}
                      onClick={() => void doActivity(action)}
                    >
                      {label} · ~{approxActivityMinutes(action.durationSeconds)} min
                    </Button>
                    {!action.available ? (
                      <span id={reasonId} className="pl-2.5 text-[10px] text-paper-600">
                        {unavailableReason}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {refusal ? (
          <div className="mt-2 border-t border-ink-700 pt-2 text-xs text-paper-300">
            <span className="block">{refusal.publicReason}</span>
            {refusalAlternatives.length > 0 ? (
              <span className="mt-0.5 block text-[10px] text-paper-600">
                You could instead: {refusalAlternatives.join(", ")}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
