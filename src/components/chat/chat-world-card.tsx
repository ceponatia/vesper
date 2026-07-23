"use client";

import { useState } from "react";
import { placeAtPhrase } from "@/lib/simulation/solo-cut";
import {
  approxActivityMinutes,
  approxWalkMinutes,
  capitalizeFirst,
  goChipLabel,
  placeGoPhrase,
} from "@/lib/simulation/world-read";
import { chatsApi, type ChatWorld } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

type Destination = ChatWorld["destinations"][number];
type HeldItem = ChatWorld["held"][number];
type WorldAction = ChatWorld["actions"][number];

/**
 * The world card (world-ui.plan.md slices 1 + 3): the player-facing surface of
 * the successor world, beside the clock card in the right "story time" aside
 * (and in the phone Roster sheet). It draws where the player is (or is walking
 * to), who else is around, the open destinations as skip-style travel chips
 * (ruling 20), the player's pocket with a "Hand to {primary}" handoff
 * (`give_item`), and the zone-gated actions as skip-style chips (`do_activity`).
 * Every world command routes its refusal through ONE §14.4 surface (publicReason
 * + legalAlternatives). A landing / handoff / performed action refreshes the
 * transcript (the server-written world beat), the world envelope, and chat
 * state via `onWorldChanged`. Renders nothing for a degraded / legacy / shadow
 * chat (world === null) — ruling-18-style affordance hiding.
 */
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
  const [givingItem, setGivingItem] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ publicReason: string; legalAlternatives: string[] } | null>(null);

  if (!world) return null;

  // One command in flight at a time — travel, a handoff, and an action are
  // mutually exclusive (each moves the same world clock).
  const anyBusy = busy || archived || travelingZone !== null || givingItem !== null || actingId !== null;

  // The give-item target is always the primary; the card knows them (and their
  // presence) from the cast. Available actions are the zone-gated ones only —
  // the card shows what you CAN do (ruling-18 affordance hiding).
  const primary = world.cast.find((member) => member.isPrimary) ?? null;
  const availableActions = world.actions.filter((action) => action.available);

  const travel = async (dest: Destination) => {
    if (anyBusy) return;
    setTravelingZone(dest.zoneId);
    setRefusal(null);
    const result = await chatsApi.simTravel(chatId, dest.zoneId);
    setTravelingZone(null);
    if (!result.ok) {
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
    onWorldChanged();
  };

  const give = async (item: HeldItem) => {
    if (anyBusy || !primary?.present) return;
    setGivingItem(item.itemId);
    setRefusal(null);
    const result = await chatsApi.simGiveItem(chatId, item.itemId);
    setGivingItem(null);
    if (!result.ok) {
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
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Where you are</span>
      <div className="rounded-md border border-ink-600 bg-ink-850 px-2.5 py-2">
        <span className="block text-sm text-paper-200">{placeLine}</span>

        {world.cast.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-paper-400">
            {world.cast.map((member) => (
              <span key={member.name}>
                {member.present ? `${member.name} — here with you` : `${member.name} — ${member.whereabouts}`}
              </span>
            ))}
          </div>
        ) : null}

        {world.destinations.length > 0 ? (
          <>
            <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Travel">
              {world.destinations.map((dest) => (
                <Button
                  key={dest.zoneId}
                  size="sm"
                  variant="quiet"
                  busy={travelingZone === dest.zoneId}
                  disabled={anyBusy}
                  title={`~${approxWalkMinutes(dest.travelSeconds)} min walk`}
                  onClick={() => void travel(dest)}
                >
                  {goChipLabel(dest.label)}
                </Button>
              ))}
            </div>
            {/* Travel times visible without hover — the title tooltip is invisible on touch. */}
            <div className="mt-1.5 flex flex-col gap-0.5 text-[10px] text-paper-600">
              {world.destinations.map((dest) => (
                <span key={dest.zoneId}>
                  {goChipLabel(dest.label)} · ~{approxWalkMinutes(dest.travelSeconds)} min walk
                </span>
              ))}
            </div>
          </>
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

        {availableActions.length > 0 ? (
          <div className="mt-2 border-t border-ink-700 pt-2">
            <span className="block text-[10px] font-medium tracking-wide text-paper-500 uppercase">Things to do</span>
            <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Actions">
              {availableActions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant="quiet"
                  busy={actingId === action.id}
                  disabled={anyBusy}
                  title={`~${approxActivityMinutes(action.durationSeconds)} min`}
                  onClick={() => void doActivity(action)}
                >
                  {action.label} · ~{approxActivityMinutes(action.durationSeconds)} min
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {refusal ? (
          <div className="mt-2 border-t border-ink-700 pt-2 text-xs text-paper-300">
            <span className="block">{refusal.publicReason}</span>
            {refusal.legalAlternatives.length > 0 ? (
              <span className="mt-0.5 block text-[10px] text-paper-600">
                You could instead: {refusal.legalAlternatives.join(", ")}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
