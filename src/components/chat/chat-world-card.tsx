"use client";

import { useState } from "react";
import { formatSimLanding, type SimCalendarStart } from "@/lib/simulation";
import { placeAtPhrase } from "@/lib/simulation/solo-cut";
import { approxWalkMinutes, capitalizeFirst, goChipLabel, placeGoPhrase } from "@/lib/simulation/world-read";
import { chatsApi, type ChatWorld } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

type Destination = ChatWorld["destinations"][number];

/**
 * The world card (world-ui.plan.md slice 1): the player-facing surface of the
 * successor world, beside the clock card in the right "story time" aside (and in
 * the phone Roster sheet). It draws where the player is (or is walking to), who
 * else is around, and the open destinations as skip-style travel chips (ruling
 * 20). A tap composes move + a drain to arrival server-side, toasts the landing
 * in skip-parity, and refreshes the world + chat state. A refused move renders
 * the §14.4 public face (publicReason + legalAlternatives) — the first real UI
 * consumer of that shape. Renders nothing for a degraded / legacy / shadow chat
 * (world === null) — ruling-18-style affordance hiding.
 */
export function ChatWorldCard({
  chatId,
  world,
  calendarStart,
  archived,
  busy,
  onTraveled,
}: {
  chatId: string;
  world: ChatWorld | null;
  /** The world's calendar anchor (chatState.simClock.calendarStart) — labels the landing toast. */
  calendarStart: SimCalendarStart | null;
  archived: boolean;
  /** True while a reply / skip is in flight — travel chips disable (same discipline as skip chips). */
  busy: boolean;
  /** Host refreshes the world envelope + chat state after a landing. */
  onTraveled: () => void;
}) {
  const toast = useToast();
  const [travelingZone, setTravelingZone] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ publicReason: string; legalAlternatives: string[] } | null>(null);

  if (!world) return null;

  const travel = async (dest: Destination) => {
    if (busy || archived || travelingZone !== null) return;
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
    const landing = result.data.toStorySecond;
    const landingLabel = landing === null ? "later" : formatSimLanding(landing, calendarStart);
    toast.push({ title: "You set out", description: `You walk to ${placeGoPhrase(dest.label)}. It's now ${landingLabel}.` });
    onTraveled();
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
                  disabled={busy || archived || travelingZone !== null}
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
