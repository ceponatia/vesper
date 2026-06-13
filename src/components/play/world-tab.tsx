"use client";

import { useState } from "react";
import { DEFAULT_CALENDAR_START, formatElapsed, formatGameClock, resolveGameTime } from "@/lib/clock";
import { worldsApi } from "@/lib/client/api";
import type { StatusItem, UseSession } from "@/lib/client/use-session";
import { NARRATIVE_MODELS } from "@/lib/narrative-models";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/**
 * Narrator model dropdown over the curated list (lib/narrative-models.ts);
 * writes the world's narrativeModel override. The resolved current model is
 * always shown — an id outside the list (env override, legacy value) renders
 * as-is rather than vanishing.
 */
function NarratorSelect({ session }: { session: UseSession }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const status = session.status;
  const current = status?.narrativeModel ?? "";
  const known = NARRATIVE_MODELS.some((o) => o.id === current);

  const select = async (modelId: string) => {
    if (saving || modelId === current || !status?.worldId) return;
    setSaving(true);
    const result = await worldsApi.update(status.worldId, { narrativeModel: modelId });
    if (result.ok) {
      await session.refresh();
    } else {
      toast.push({ title: "Couldn't switch the narrator", description: result.error.message, tone: "error" });
    }
    setSaving(false);
  };

  return (
    <section className="flex flex-col gap-1.5">
      <SectionTitle>Narrator</SectionTitle>
      <Select
        aria-label="Narrator model"
        value={current}
        disabled={saving || !status?.worldId}
        onChange={(e) => void select(e.target.value)}
        className="text-xs"
      >
        {!known ? <option value={current}>{current || "—"}</option> : null}
        {NARRATIVE_MODELS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      {saving ? <p className="text-[11px] text-paper-500 italic">Switching…</p> : null}
    </section>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">{children}</h3>;
}

/** "+20m — Shower"; the generic "scene" cause renders as just "+20m". */
function formatClockDelta(delta: { minutes: number; cause: string }): string {
  const cause = delta.cause.trim();
  if (!cause || cause === "scene") return `+${delta.minutes}m`;
  return `+${delta.minutes}m — ${cause.charAt(0).toUpperCase()}${cause.slice(1)}`;
}

function ItemLine({ item, note }: { item: StatusItem; note?: string | null }) {
  return (
    <li className="flex items-baseline gap-2 text-xs text-paper-300">
      <span className="truncate">
        {item.name}
        {item.quantity > 1 ? ` ×${item.quantity}` : ""}
      </span>
      {note ? <span className="truncate text-paper-500 italic">{note}</span> : null}
    </li>
  );
}

/** World tab: clock, location, items, containers, open threads (docs/ui.md). */
export function WorldTab({ session }: { session: UseSession }) {
  if (session.statusLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-10 w-full rounded-card" />
        <Skeleton className="h-24 w-full rounded-card" />
      </div>
    );
  }

  const status = session.status;
  const clockMinutes = status?.clockMinutes ?? 0;
  const time = resolveGameTime(clockMinutes, status?.calendarStart ?? DEFAULT_CALENDAR_START);
  const location = status?.location ?? null;
  const items = status?.items ?? [];

  const containers = items.filter((item) => item.kind === "container");
  const contentsOf = (containerId: string) => items.filter((item) => item.containerInstanceId === containerId);
  // Loose items at the current location (containers and contained items render below).
  const looseHere = items.filter(
    (item) =>
      item.kind !== "container" &&
      !item.containerInstanceId &&
      !item.holderParticipantId &&
      (!location?.id || !item.locationId || item.locationId === location.id),
  );
  const openThreads = (status?.threads ?? []).filter((t) => t.status === "open" || t.status === "cooling");

  return (
    <div className="flex flex-col gap-4 p-4">
      <Card className="px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-serif text-sm text-paper-100">{formatGameClock(time)}</p>
          {status?.clockDelta ? (
            <p className="shrink-0 text-[11px] text-paper-500">{formatClockDelta(status.clockDelta)}</p>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] text-paper-500">{formatElapsed(clockMinutes)} into the story</p>
      </Card>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Location</SectionTitle>
        {location ? (
          <Card className="px-3 py-2.5">
            <p className="text-sm font-medium text-paper-50">{location.name}</p>
            {location.description ? (
              <p className="mt-1 line-clamp-4 text-xs leading-5 text-paper-400">{location.description}</p>
            ) : null}
          </Card>
        ) : (
          <p className="text-xs text-paper-500 italic">Nowhere in particular yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Items here</SectionTitle>
        {looseHere.length === 0 && containers.length === 0 ? (
          <p className="text-xs text-paper-500 italic">Nothing of note.</p>
        ) : (
          <>
            {looseHere.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {looseHere.map((item) => (
                  <ItemLine key={item.id} item={item} note={item.positionNote} />
                ))}
              </ul>
            ) : null}
            {containers.map((container) => {
              // Guard against degenerate data: a container "containing" itself.
              const contents = contentsOf(container.id).filter((c) => c.id !== container.id);
              return (
                <Card key={container.id} className="px-3 py-2">
                  <p className="text-xs font-medium text-paper-200">
                    {container.name}
                    {container.open === false ? " (closed)" : container.open === true ? " (open)" : ""}
                  </p>
                  {contents.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                      {contents.map((item) => (
                        <ItemLine key={item.id} item={item} note={item.positionNote} />
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 pl-3 text-[11px] text-paper-500 italic">empty</p>
                  )}
                </Card>
              );
            })}
          </>
        )}
      </section>

      <NarratorSelect session={session} />

      <section className="flex flex-col gap-1.5">
        <SectionTitle>Open threads</SectionTitle>
        {openThreads.length === 0 ? (
          <p className="text-xs text-paper-500 italic">No open threads.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {openThreads.map((thread, i) => (
              <li key={thread.id || i} className="rounded-md border border-ink-600 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-xs font-medium text-paper-100">{thread.title}</p>
                  {thread.status === "cooling" ? <Tag>cooling</Tag> : null}
                </div>
                {thread.summary ? (
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-paper-400">{thread.summary}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
